import { CONTRACTS } from '../contracts'

export const CFG = CONTRACTS.testnet

/** Format a whole-token decimal string with up to `decimals` places. */
export function formatTokens(units: bigint, decimals = CFG.tokenDecimals): string {
  const sign = units < 0n ? '-' : ''
  const abs = units < 0n ? -units : units
  const divisor = 10n ** BigInt(decimals)
  const whole = abs / divisor
  const frac = (abs % divisor).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${sign}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`
}

/** Expected payout after the corridor's protocol + agent fees are deducted. */
export function payoutAfterFees(
  amountUnits: bigint,
  protocolFeeBps: number,
  agentFeeBps: number,
): bigint {
  const protocol = (amountUnits * BigInt(protocolFeeBps)) / 10000n
  const agent = (amountUnits * BigInt(agentFeeBps)) / 10000n
  return amountUnits - protocol - agent
}

/** Quote estimate: `amountUnits` of base converted to quote currency. */
export function quoteOf(
  amountUnits: bigint,
  rate: bigint,
  baseDecimals = CFG.tokenDecimals,
): bigint {
  return (amountUnits * rate) / 10n ** BigInt(baseDecimals)
}

export function formatWhole(value: bigint): string {
  return value.toLocaleString('en-US')
}

export function shortAddress(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 6)}…${pk.slice(-4)}` : pk
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`
}
