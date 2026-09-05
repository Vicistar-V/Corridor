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

/** Parse a "1234" or "1.25" token amount into smallest units; null when invalid. */
export function tokensToUnits(input: string, decimals = CFG.tokenDecimals): bigint | null {
  const raw = input.trim()
  if (!/^\d+(\.\d+)?$/.test(raw)) return null
  const [whole, frac = ''] = raw.split('.')
  if (frac.length > decimals) return null
  const divisor = 10n ** BigInt(decimals)
  const units = BigInt((whole || '0') + frac.padEnd(decimals, '0'))
  if (units % divisor !== 0n) return units
  return BigInt((whole || '0') + frac.padEnd(decimals, '0'))
}

/** Truncate a token amount to a no-fraction integer string for tx args. */
export function unitsToWhole(units: bigint, decimals = CFG.tokenDecimals): string {
  const divisor = 10n ** BigInt(decimals)
  return (units / divisor).toString()
}

/**
 * Expected payout after the corridor's protocol + agent fees are deducted,
 * in smallest units.
 */
export function payoutAfterFees(
  amountUnits: bigint,
  protocolFeeBps: number,
  agentFeeBps: number,
): bigint {
  const protocol = (amountUnits * BigInt(protocolFeeBps)) / 10000n
  const agent = (amountUnits * BigInt(agentFeeBps)) / 10000n
  return amountUnits - protocol - agent
}

/**
 * Quote estimate: `amountUnits` of base converted to quote currency. The oracle
 * reports quote per *whole* base token (1550 NGN/USDC), so divide the base
 * smallest units by 10^decimals. Result is a plain quote integer (NGN).
 */
export function quoteOf(
  amountUnits: bigint,
  rate: bigint,
  baseDecimals = CFG.tokenDecimals,
): bigint {
  return (amountUnits * rate) / 10n ** BigInt(baseDecimals)
}

/** Format a plain integer (e.g. a quote currency amount) with thousands separators. */
export function formatWhole(value: bigint): string {
  return value.toLocaleString('en-US')
}

export function shortAddress(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 6)}…${pk.slice(-4)}` : pk
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`
}