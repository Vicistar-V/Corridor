import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { Api, Server } from '@stellar/stellar-sdk/rpc'
import { signTx } from './freighter'
import { CFG } from './fmt'

const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

export const NETWORK_PASSPHRASE = CFG.networkPassphrase
export const server = new Server(CFG.rpcUrl)

export const STATUS_STEPS = [
  'Locked',
  'Funded',
  'AgentAssigned',
  'Delivered',
] as const

export type TransferStatus = (typeof STATUS_STEPS)[number] | 'Refunded' | 'Disputed'

// ---- scVal builders ---------------------------------------------------------

const u64 = (v: bigint | number | string) => nativeToScVal(v, { type: 'u64' })
const i128 = (v: bigint | number | string) => nativeToScVal(v, { type: 'i128' })
const symbol = (s: string) => nativeToScVal(s, { type: 'symbol' })
const address = (pk: string) => new Address(pk).toScVal()
const bytes = (data: Uint8Array) => xdr.ScVal.scvBytes(data)

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(normalized.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// ---- transaction plumbing ---------------------------------------------------

function buildBaseTx(contractId: string, fn: string, args: xdr.ScVal[], source: Account) {
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(Date.now() / 1000) + 300,
    },
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .build()
}

/** Read-only call: simulate with a null account and return the decoded retval. */
export async function read<T = unknown>(contractId: string, fn: string, args: xdr.ScVal[]): Promise<T> {
  const tx = buildBaseTx(contractId, fn, args, new Account(NULL_ACCOUNT, '0'))
  const sim = await server.simulateTransaction(tx)
  if (!Api.isSimulationSuccess(sim)) {
    const err = Api.isSimulationError(sim) ? sim.error : 'unknown'
    throw new Error(`simulation failed (${fn}): ${err}`)
  }
  if (!sim.result) throw new Error(`${fn}: no simulation result`)
  return scValToNative(sim.result.retval) as T
}

export interface WriteOutcome {
  hash: string
  value: unknown
}

/**
 * Authorized contract call: simulate, let the RPC assemble the authorized
 * transaction, hand it to the connected Freighter wallet for signing, submit,
 * and poll until finalized.
 */
export async function write(
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  opts: { source: string; signer?: string },
): Promise<WriteOutcome> {
  const account = await server.getAccount(opts.source)
  const tx = buildBaseTx(contractId, fn, args, account)

  const sim = await server.simulateTransaction(tx)
  if (!Api.isSimulationSuccess(sim)) {
    const err = Api.isSimulationError(sim) ? sim.error : 'unknown'
    throw new Error(`tx rejected in simulation (${fn}): ${err}`)
  }

  const prepared = await server.prepareTransaction(tx)
  const preparedXdr = prepared.toXDR()

  const { signedXdr, error } = await signTx(preparedXdr, NETWORK_PASSPHRASE, opts.source)
  if (error) throw new Error(`wallet signing failed: ${error}`)

  const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  const sent = await server.sendTransaction(signed)

  if (sent.status === 'ERROR') {
    throw new Error(`transaction ${sent.hash} rejected by the network (${fn})`)
  }
  if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
    throw new Error(`unexpected send status: ${sent.status}`)
  }

  const finalised = await server.pollTransaction(sent.hash, {
    attempts: 40,
    sleepStrategy: (iter) => Math.min(1000 * iter, 8000),
  })
  if (finalised.status !== Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} did not succeed`)
  }
  return {
    hash: sent.hash,
    value: finalised.returnValue !== undefined ? scValToNative(finalised.returnValue) : undefined,
  }
}

/** Current testnet ledger sequence, for SAC approval deadlines. */
export async function latestLedger(): Promise<bigint> {
  const res = await server.getLatestLedger()
  return BigInt(res.sequence)
}

// ---- corridor read helpers ----------------------------------------------------

export interface AgentInfo {
  address: string
  corridorIds: string[]
  metadataUri: string
  verified: boolean
  active: boolean
}

export function getRate(): Promise<bigint> {
  return read<{ rate: bigint; timestamp: bigint }>(rpc.ORACLE, 'get_rate', [
    symbol(CFG.corridor.base),
    symbol(CFG.corridor.quote),
  ]).then((value) => value.rate)
}

export function isRateStale(e: unknown): boolean {
  return e instanceof Error && /#2\]/.test(e.message)
}

/** Mock publisher: the demo oracle's set_rate needs no auth on testnet. */
export function publishRate(rate: bigint, source: string): Promise<WriteOutcome> {
  return write(rpc.ORACLE, 'set_rate', [
    symbol(CFG.corridor.base),
    symbol(CFG.corridor.quote),
    i128(rate),
  ], { source })
}

export async function getAgents(): Promise<AgentInfo[]> {
  const agents = await read<AgentInfo[]>(rpc.REGISTRY, 'get_agents_for_corridor', [symbol(CFG.corridor.id)])
  return agents ?? []
}

export async function getStatus(transferId: bigint): Promise<TransferStatus> {
  const raw = await read<unknown>(rpc.ESCROW, 'status', [u64(transferId)])
  return normalizeStatus(raw)
}

/**
 * soroban-sdk encodes field-less enum variants on the wire as `scvVec([Symbol])`
 * (a one-element vector whose first element is the variant symbol); the CLI
 * renders the same data as a bare string.
 */
export function normalizeStatus(raw: unknown): TransferStatus {
  if (typeof raw === 'string') return raw as TransferStatus
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0] as TransferStatus
  throw new Error(`unexpected status encoding: ${JSON.stringify(raw)}`)
}

export function getBalance(pk: string): Promise<bigint> {
  return read<bigint>(rpc.TOKEN, 'balance', [address(pk)])
}

export function getAllowance(owner: string, spender: string): Promise<bigint> {
  return read<bigint>(rpc.TOKEN, 'allowance', [address(owner), address(spender)])
}

export function getTokenDecimals(): Promise<number> {
  return read<number>(rpc.TOKEN, 'decimals', [])
}

export function getTokenSymbol(): Promise<string> {
  return read<string>(rpc.TOKEN, 'symbol', [])
}

// ---- corridor write helpers ----------------------------------------------------

export const rpc = {
  ESCROW: CFG.escrow,
  REGISTRY: CFG.registry,
  ORACLE: CFG.oracle,
  TOKEN: CFG.token,
}

export interface CorridorConfigRead {
  escrow: string
  registry: string
  oracle: string
  token: string
}

export interface EscrowInit {
  admin: string
  treasury: string
}

export function initiateTransfer(args: {
  sender: string
  recipient: string
  amountUnits: bigint
}): Promise<WriteOutcome> {
  return write(rpc.ESCROW, 'initiate_transfer', [
    address(args.sender),
    address(args.recipient),
    symbol(CFG.corridor.id),
    i128(args.amountUnits),
    address(rpc.TOKEN),
  ], { source: args.sender })
}

export function approveToken(args: {
  from: string
  spender: string
  amountUnits: bigint
  liveUntilLedger: bigint
}): Promise<WriteOutcome> {
  return write(rpc.TOKEN, 'approve', [
    address(args.from),
    address(args.spender),
    i128(args.amountUnits),
    u64(args.liveUntilLedger),
  ], { source: args.from })
}

export function fundTransfer(args: { transferId: bigint; source: string }): Promise<WriteOutcome> {
  return write(rpc.ESCROW, 'fund', [u64(args.transferId)], { source: args.source })
}

export function lockRate(args: { transferId: bigint; source: string }): Promise<WriteOutcome> {
  return write(rpc.ESCROW, 'lock_rate', [u64(args.transferId)], { source: args.source })
}

export function assignAgent(args: {
  transferId: bigint
  agentId: string
  source: string
}): Promise<WriteOutcome> {
  return write(rpc.ESCROW, 'assign_agent', [u64(args.transferId), address(args.agentId)], {
    source: args.source,
  })
}

export function confirmDelivery(args: {
  transferId: bigint
  attestationSigHex: string
  source: string
}): Promise<WriteOutcome> {
  return write(rpc.ESCROW, 'confirm_delivery', [
    u64(args.transferId),
    bytes(hexToBytes(args.attestationSigHex)),
  ], { source: args.source })
}