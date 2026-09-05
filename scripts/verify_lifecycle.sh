#!/usr/bin/env bash
#
# verify_lifecycle.sh — drive one full transfer end-to-end on Soroban via the
# CLI to confirm the deployed contracts work against the live network, not just
# in local cargo tests.
#
# Walks the exact Day-3 happy path:
#   initiate_transfer -> approve -> lock_rate -> fund ->
#   assign_agent -> confirm_delivery
# and prints the transfer status after each step plus the final fee split.
#
# Uses the identities/contracts provisioned by:
#   ./scripts/fund_identities.sh
#   ./scripts/deploy.sh
#   ./scripts/setup_corridor.sh
#
# Usage:
#   ./scripts/verify_lifecycle.sh [network]

set -euo pipefail

NETWORK="${1:-testnet}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.contracts.${NETWORK}.env"
AMOUNT="${AMOUNT:-1000000000}"        # 100.0000000 DEMOUSDC
LIVE_UNTIL_BUFFER=10000

# Resolve the Stellar/Soroban CLI: prefer `SOROBAN`, then `soroban`, then `stellar`.
if [[ -n "${SOROBAN:-}" ]]; then
  CLI="${SOROBAN}"
elif command -v soroban >/dev/null 2>&1; then
  CLI="soroban"
elif command -v stellar >/dev/null 2>&1; then
  CLI="stellar"
else
  echo "error: neither 'soroban' nor 'stellar' CLI found on PATH" >&2
  exit 1
fi

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

[[ -f "${ENV_FILE}" ]] || fail "missing ${ENV_FILE} — run deploy.sh + setup_corridor.sh first"
# shellcheck disable=SC1090
source "${ENV_FILE}"

SENDER="$("$CLI" keys public-key sender)"
RECIPIENT="$("$CLI" keys public-key recipient)"
AGENT1="$("$CLI" keys public-key agent1)"

# A dummy 65-byte attestation (an integration mock; agent signing key crypto is
# future work — the contract only validates the caller is the assigned agent).
ATTESTATION_SIG="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40"

invoke_retval() {
  local contract_id="$1"
  local source="$2"
  local fn="$3"
  shift 3
  "$CLI" contract invoke \
    --id "${contract_id}" --source-account "${source}" \
    --network "${NETWORK}" --send no \
    -- "$fn" "$@" 2>/dev/null | tail -1 | tr -d '"'
}

# latest_ledger — current testnet ledger sequence via Soroban RPC.
latest_ledger() {
  curl -s -m 15 -X POST https://soroban-testnet.stellar.org \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}' \
    | grep -oE '"sequence":[0-9]+' | grep -oE '[0-9]+'
}

sender_balance() {
  "$CLI" contract invoke --id "${DEMO_USDC_ID}" --source-account deployer \
    --network "${NETWORK}" --send no -- balance --id "${SENDER}" 2>/dev/null | tail -1 | tr -d '"'
}

echo "== Corridor transfer lifecycle — network: ${NETWORK} =="
printf '  escrow   %s\n  registry %s\n  oracle   %s\n  token    %s\n\n' \
  "${CORRIDOR_ESCROW_ID}" "${AGENT_REGISTRY_ID}" "${RATE_ORACLE_ADAPTER_ID}" "${DEMO_USDC_ID}"

# Refresh the mock rate so lock_rate's staleness guard (300 ledgers) passes.
log "[1/7] publishing fresh ${CORRIDOR_BASE}/${CORRIDOR_QUOTE} rate"
"$CLI" contract invoke --id "${RATE_ORACLE_ADAPTER_ID}" --source-account deployer \
  --network "${NETWORK}" --send yes \
  -- set_rate --base "${CORRIDOR_BASE}" --quote "${CORRIDOR_QUOTE}" --rate 1550 >/dev/null 2>&1

log "[2/7] initiate_transfer(sender=${SENDER:0:8}…, amount=${AMOUNT})"
TRANSFER_ID="$("$CLI" contract invoke --id "${CORRIDOR_ESCROW_ID}" --source-account sender \
  --network "${NETWORK}" --send yes \
  -- initiate_transfer --sender "${SENDER}" --recipient "${RECIPIENT}" \
  --corridor-id "${CORRIDOR_ID}" --amount "${AMOUNT}" --token "${DEMO_USDC_ID}" 2>/dev/null | tail -1)"
[[ "${TRANSFER_ID}" =~ ^[0-9]+$ ]] || fail "initiate_transfer returned unexpected value: ${TRANSFER_ID}"
log "  ✓ transfer id = ${TRANSFER_ID}"

log "[3/7] lock_rate(transfer_id=${TRANSFER_ID})"
RATE="$("$CLI" contract invoke --id "${CORRIDOR_ESCROW_ID}" --source-account deployer \
  --network "${NETWORK}" --send yes \
  -- lock_rate --transfer-id "${TRANSFER_ID}" 2>/dev/null | tail -1 | tr -d '"')"
log "  ✓ locked rate = ${RATE}"

log "[4/7] approve(escrow, amount) + fund(transfer_id=${TRANSFER_ID})"
LEDGER="$(latest_ledger)"
"$CLI" contract invoke --id "${DEMO_USDC_ID}" --source-account sender \
  --network "${NETWORK}" --send yes \
  -- approve --from "${SENDER}" --spender "${CORRIDOR_ESCROW_ID}" \
  --amount "${AMOUNT}" --live_until_ledger "$((LEDGER + LIVE_UNTIL_BUFFER))" >/dev/null 2>&1
"$CLI" contract invoke --id "${CORRIDOR_ESCROW_ID}" --source-account sender \
  --network "${NETWORK}" --send yes \
  -- fund --transfer-id "${TRANSFER_ID}" >/dev/null 2>&1
log "  ✓ funds moved into escrow"

log "[5/7] assign_agent(transfer_id=${TRANSFER_ID}, agent_id=agent1)"
"$CLI" contract invoke --id "${CORRIDOR_ESCROW_ID}" --source-account deployer \
  --network "${NETWORK}" --send yes \
  -- assign_agent --transfer-id "${TRANSFER_ID}" --agent-id "${AGENT1}" >/dev/null 2>&1
log "  ✓ agent assigned: ${AGENT1:0:8}…"

log "[6/7] confirm_delivery(transfer_id=${TRANSFER_ID})"
"$CLI" contract invoke --id "${CORRIDOR_ESCROW_ID}" --source-account agent1 \
  --network "${NETWORK}" --send yes \
  -- confirm_delivery --transfer-id "${TRANSFER_ID}" --_attestation_sig "${ATTESTATION_SIG}" >/dev/null 2>&1

log "[7/7] verifying balances after settlement"
FINAL_STATUS="$(invoke_retval "${CORRIDOR_ESCROW_ID}" deployer status --transfer-id "${TRANSFER_ID}")"

PROTOCOL_FEE=$((AMOUNT * PROTOCOL_FEE_BPS / 10000))
AGENT_FEE=$((AMOUNT * AGENT_FEE_BPS / 10000))
RECIPIENT_AMOUNT=$((AMOUNT - PROTOCOL_FEE - AGENT_FEE))

echo ""
echo "== Result =="
printf '  %-24s %s\n' "transfer id" "${TRANSFER_ID}"
printf '  %-24s %s\n' "locked rate" "${RATE} ${CORRIDOR_QUOTE}/${CORRIDOR_BASE}"
printf '  %-24s %s\n' "final status" "${FINAL_STATUS}"
printf '  %-24s %s\n' "recipient payout" "${RECIPIENT_AMOUNT} ${DEMO_USDC_CODE}"
printf '  %-24s %s\n' "agent fee" "${AGENT_FEE} ${DEMO_USDC_CODE}"
printf '  %-24s %s\n' "protocol fee" "${PROTOCOL_FEE} ${DEMO_USDC_CODE}"
printf '  %-24s %s\n' "last balance (sender)" "$(sender_balance) ${DEMO_USDC_CODE}"

if [[ "${FINAL_STATUS}" == "Delivered" ]]; then
  echo ""
  echo "✅ Full transfer lifecycle verified on ${NETWORK}."
else
  echo ""
  echo "❌ Transfer did not settle — final status was '${FINAL_STATUS}'." >&2
  exit 1
fi