#!/usr/bin/env bash
#
# setup_corridor.sh — register the demo corridor and mock agents on testnet.
#
# Reads the contract IDs written by ./scripts/deploy.sh
# (scripts/.contracts.<network>.env) and wires up the demo material the sender
# frontend talks to:
#   - initializes agent-registry (admin = deployer)
#   - registers + verifies two mock payout agents for the USNG corridor
#   - publishes a fresh USDC→NGN rate on rate-oracle-adapter
#   - registers the USNG corridor fee schedule (100bps protocol / 200bps agent)
#     on corridor-escrow
#   - gives every participant a DEMOUSDC trustline and mints demo balances
#
# This mirrors README's eventual single-corridor pilot (e.g. US → NG) with 1–2
# off-ramp partners.
#
# Usage:
#   ./scripts/deploy.sh <network>
#   ./scripts/setup_corridor.sh [network]

set -euo pipefail

NETWORK="${1:-testnet}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.contracts.${NETWORK}.env"
TS_ATTR="$(date +%s)"

RATE=1550
# Demo balances (in DEMOUSDC small units; the SAC uses 7 decimals).
SENDER_TOPUP=10000000000   # 1000.0000000 DEMOUSDC
AGENT_TOPUP=500000000      # 50.0000000

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

[[ -f "${ENV_FILE}" ]] || fail "missing ${ENV_FILE} — run ./scripts/deploy.sh ${NETWORK} first"
# shellcheck disable=SC1090
source "${ENV_FILE}"

# ---- helpers ----------------------------------------------------------------

invoke() {
  local contract_id="$1"
  local source="$2"
  local fn="$3"
  shift 3
  local attempt
  attempt=0
  while :; do
    if "$CLI" contract invoke \
      --id "${contract_id}" \
      --source-account "${source}" \
      --network "${NETWORK}" \
      --send yes \
      -- "$fn" "$@" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    if (( attempt >= 5 )); then
      return 1
    fi
    log "[invoke] retrying '${fn}' (attempt ${attempt})..."
    sleep 3
  done
}

log() { printf '%s\n' "$*"; }

# add_trustline <identity> — classic trustline to DEMOUSDC for a CLI identity.
add_trustline() {
  local id="$1"
  local xdr signed
  log "[trust] DEMOUSDC trustline for '${id}'"
  xdr="$("$CLI" tx new change-trust \
    --build-only \
    --source-account "${id}" \
    --line "${DEMO_USDC_CODE}:${DEMO_USDC_ISSUER}" \
    --network "${NETWORK}" 2>/dev/null)"
  signed="$(printf '%s' "${xdr}" | "$CLI" tx sign \
    --sign-with-key "${id}" --network "${NETWORK}" 2>/dev/null)"
  if printf '%s' "${signed}" | "$CLI" tx send --network "${NETWORK}" >/dev/null 2>&1; then
    log "[trust]   ✓ '${id}' can hold ${DEMO_USDC_CODE}"
  else
    log "[trust]   (skipping '${id}' — likely already trusted)"
  fi
}

# mint_to <identity> <units> — mint DEMOUSDC from the deployer (token issuer).
mint_to() {
  local id="$1"
  local units="$2"
  local pk="$("$CLI" keys public-key "${id}")"
  log "[mint]  ${units} ${DEMO_USDC_CODE} -> '${id}'"
  invoke "${DEMO_USDC_ID}" deployer mint --to "${pk}" --amount "${units}" ||
    log "[mint]   (skipping '${id}' — mint failed, likely already minted)"
  sleep 1
}

# ---- agent-registry ----------------------------------------------------------

log "== Agent registry =="
if invoke "${AGENT_REGISTRY_ID}" deployer init --admin "${DEPLOYER_ADDRESS}"; then
  log "[init]  agent-registry initialized (admin = deployer)"
else
  log "[init]  agent-registry already initialized (continuing)"
fi

register_agent() {
  local id="$1"
  local uri="$2"
  local pk="$("$CLI" keys public-key "${id}")"
  local agent_json
  agent_json="$(printf '{ "address": {"address": "%s"}, "corridor_ids": [ {"symbol": "%s"} ], "metadata_uri": {"string": "%s"}, "verified": {"bool": false}, "active": {"bool": true} }' "${pk}" "${CORRIDOR_ID}" "${uri}")"
  log "[agent] registering ${id} (${pk})"
  if invoke "${AGENT_REGISTRY_ID}" deployer register_agent --agent "${agent_json}"; then
    if invoke "${AGENT_REGISTRY_ID}" deployer verify_agent --agent-address "${pk}"; then
      log "[agent]   ✓ ${id} registered + verified for ${CORRIDOR_ID}"
    else
      log "[agent]   (verify failed for ${id})"
    fi
  else
    log "[agent]   (${id} already registered — continuing)"
  fi
}

register_agent "agent1" "uri://agent1-lagos"
register_agent "agent2" "uri://agent2-abuja"

agent_count="$( "$CLI" contract invoke \
  --id "${AGENT_REGISTRY_ID}" --source-account deployer --network "${NETWORK}" --send no \
  -- get_agents_for_corridor --corridor-id "${CORRIDOR_ID}" 2>/dev/null \
  | grep -o '"address"' | wc -l )"
log "[agent] ${agent_count:-0} verified agent(s) currently serve ${CORRIDOR_ID}"

# ---- rate oracle --------------------------------------------------------------

log "== Rate oracle =="
invoke "${RATE_ORACLE_ADAPTER_ID}" deployer set_rate \
  --base "${CORRIDOR_BASE}" --quote "${CORRIDOR_QUOTE}" --rate "${RATE}" \
  || log "[rate]  (rate already published — continuing)"
log "[rate]  ${CORRIDOR_BASE}/${CORRIDOR_QUOTE} = ${RATE} published (fresh ${TS_ATTR})"

# ---- corridor escrow ----------------------------------------------------------

log "== Corridor escrow =="
corridor_json="$(printf '{ "id": {"symbol": "%s"}, "base": {"symbol": "%s"}, "quote": {"symbol": "%s"}, "protocol_fee_bps": {"u32": %s}, "agent_fee_bps": {"u32": %s} }' \
  "${CORRIDOR_ID}" "${CORRIDOR_BASE}" "${CORRIDOR_QUOTE}" "${PROTOCOL_FEE_BPS}" "${AGENT_FEE_BPS}")"
if invoke "${CORRIDOR_ESCROW_ID}" deployer set_corridor --corridor "${corridor_json}"; then
  log "[corr]  corridor '${CORRIDOR_ID}' registered (protocol ${PROTOCOL_FEE_BPS}bps / agent ${AGENT_FEE_BPS}bps)"
else
  log "[corr]  corridor '${CORRIDOR_ID}' already registered (continuing)"
fi

# ---- token trustlines + demo balances ----------------------------------------

log "== ${DEMO_USDC_CODE} token setup =="
for identity in sender recipient agent1 agent2 treasury; do
  add_trustline "${identity}"
done

mint_to sender "${SENDER_TOPUP}"
mint_to agent1 "${AGENT_TOPUP}"
mint_to agent2 "${AGENT_TOPUP}"
mint_to treasury "${AGENT_TOPUP}"

echo ""
echo "== Demo corridor ready on ${NETWORK} =="
printf '  %-22s %s\n' "corridor" "${CORRIDOR_ID} (${CORRIDOR_BASE}→${CORRIDOR_QUOTE}, rate ${RATE})"
printf '  %-22s %s\n' "escrow" "${CORRIDOR_ESCROW_ID}"
printf '  %-22s %s\n' "agent-registry" "${AGENT_REGISTRY_ID}"
printf '  %-22s %s\n' "rate-oracle-adapter" "${RATE_ORACLE_ADAPTER_ID}"
printf '  %-22s %s\n' "${DEMO_USDC_CODE}" "${DEMO_USDC_ID} (issuer ${DEMO_USDC_ISSUER})"
echo ""
echo "Walk one full transfer:  ./scripts/verify_lifecycle.sh ${NETWORK}"