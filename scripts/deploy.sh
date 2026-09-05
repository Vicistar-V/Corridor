#!/usr/bin/env bash
#
# deploy.sh — build the contracts and deploy them to Soroban in dependency order.
#
# Corridor's contracts each own one responsibility and reference each other by
# address, so the deploy order matters:
#   1. rate-oracle-adapter (no dependencies)
#   2. agent-registry       (no dependencies)
#   3. corridor-escrow      (depends on the registry + oracle addresses)
#   4. DEMOUSDC token       (Stellar Asset Contract wrapping a classic asset)
#
# After deployment the escrow contract is initialized with the registry, the
# oracle, an admin/arbiter (deployer) and a treasury. Contract IDs are printed
# and persisted to:
#   scripts/.contracts.<network>.env       (read by setup_corridor.sh)
#   frontend/sender-app/src/contracts.ts   (generated, read by the sender app)
#
# Usage:
#   ./scripts/fund_identities.sh [network]
#   ./scripts/deploy.sh <network>
#
# Requires the Stellar CLI (`stellar` or `soroban`) and, to rebuild from source,
# a Rust toolchain with the `wasm32v1-none` target installed.

set -euo pipefail

NETWORK="${1:-testnet}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTRACTS_DIR="${REPO_ROOT}/contracts"
WASM_DIR="${REPO_ROOT}/target/wasm32v1-none/release"
TARGET="wasm32v1-none"
OUT_FILE="${SCRIPT_DIR}/.contracts.${NETWORK}.env"
FALLBACK_LOAN_TIMEOUT="60"

# Demo token constants (mock stablecoin issued by the deployer for the testnet demo).
TOKEN_CODE="DEMOUSDC"
TOKEN_DECIMALS=7
# Fee schedule used for lock/fund/deliver and mirrored by the sender-app UI.
CORRIDOR_ID="USNG"
CORRIDOR_BASE="USDC"
CORRIDOR_QUOTE="NGN"
PROTOCOL_FEE_BPS=100
AGENT_FEE_BPS=200

# Testnet network description (public Soroban testnet).
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
RPC_URL="https://soroban-testnet.stellar.org"

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

log() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_identity() {
  local name="$1"
  if ! "$CLI" keys ls | grep -qx "${name}"; then
    fail "identity '${name}' missing — run ./scripts/fund_identities.sh ${NETWORK} first"
  fi
}

# build_contracts — compile the common-dependent contracts for wasm32v1-none
# (the only wasm target Soroban's protocol-28 VM accepts; wasm32-unknown-unknown
# emits reference-types/multivalue encodings that fail network validation).
build_contracts() {
  if [[ -f "${WASM_DIR}/rate_oracle_adapter.wasm" &&
        -f "${WASM_DIR}/agent_registry.wasm" &&
        -f "${WASM_DIR}/corridor_escrow.wasm" ]]; then
    log "[build] using existing ${TARGET} artifacts in ${WASM_DIR}"
    return
  fi
  log "[build] compiling contracts for ${TARGET} (release)..."
  (
    cd "${CONTRACTS_DIR}"
    cargo build --workspace --target "${TARGET}" --release
  )
}

# deploy_module <wasm> <alias> — deploy a contract wasm and print its ID.
deploy_module() {
  local wasm="$1"
  local alias="$2"
  local attempt id
  attempt=0
  while :; do
    id="$("$CLI" contract deploy \
      --wasm "${wasm}" \
      --source-account deployer \
      --network "${NETWORK}" \
      --alias "${alias}" 2>/dev/null | tail -1)"
    if [[ "${id}" == C* && ${#id} -eq 56 ]]; then
      echo "${id}"
      return 0
    fi
    attempt=$((attempt + 1))
    if (( attempt >= 5 )); then
      fail "could not deploy '${alias}' (wasm=${wasm})"
    fi
    log "[deploy] retrying ${alias} (attempt ${attempt})..."
    sleep 3
  done
}

# invoke <contract_id> <source> <fn> [args...] — invoke a contract function.
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
      fail "invoke '${fn}' on ${contract_id} failed (source=${source})"
    fi
    log "[invoke] retrying ${fn} (attempt ${attempt})..."
    sleep 3
  done
}

require_identity deployer
require_identity treasury
build_contracts

DEPLOYER_ADDRESS="$("$CLI" keys public-key deployer)"
TREASURY_ADDRESS="$("$CLI" keys public-key treasury)"

echo "== Corridor deploy — network: ${NETWORK} =="

# 1. rate-oracle-adapter (no dependencies).
log "[deploy] rate-oracle-adapter"
RATE_ORACLE_ADAPTER_ID="$(deploy_module "${WASM_DIR}/rate_oracle_adapter.wasm" "rate-oracle")"

# 2. agent-registry (no dependencies).
log "[deploy] agent-registry"
AGENT_REGISTRY_ID="$(deploy_module "${WASM_DIR}/agent_registry.wasm" "agent-registry")"

# 3. corridor-escrow (depends on registry + oracle addresses).
log "[deploy] corridor-escrow"
CORRIDOR_ESCROW_ID="$(deploy_module "${WASM_DIR}/corridor_escrow.wasm" "corridor-escrow")"

# 4. DEMOUSDC — a mock stablecoin used for the testnet demo (SAC wrapping a
#    classic asset issued by the deployer). SAC addresses are deterministic per
#    asset, so if the token already exists we reuse it (idempotent re-deploys).
log "[deploy] ${TOKEN_CODE} token (Stellar Asset Contract)"
DEMO_USDC_ID=""
attempt=0
while [[ -z "${DEMO_USDC_ID}" && ${attempt} -lt 5 ]]; do
  if out="$("$CLI" contract asset deploy \
    --asset "${TOKEN_CODE}:${DEPLOYER_ADDRESS}" \
    --source-account deployer \
    --network "${NETWORK}" \
    --alias "demo-usdc" 2>&1)"; then
    DEMO_USDC_ID="$(printf '%s\n' "${out}" | tail -1)"
    [[ "${DEMO_USDC_ID}" == C* && ${#DEMO_USDC_ID} -eq 56 ]] || DEMO_USDC_ID=""
  fi
  if [[ -z "${DEMO_USDC_ID}" ]]; then
    DEMO_USDC_ID="$("$CLI" contract id asset \
      --asset "${TOKEN_CODE}:${DEPLOYER_ADDRESS}" \
      --network "${NETWORK}" 2>/dev/null | tail -1 || true)"
    [[ "${DEMO_USDC_ID}" == C* && ${#DEMO_USDC_ID} -eq 56 ]] || DEMO_USDC_ID=""
  fi
  if [[ -z "${DEMO_USDC_ID}" ]]; then
    attempt=$((attempt + 1))
    log "[deploy] retrying token setup (attempt ${attempt})..."
    sleep 3
  fi
done
[[ -n "${DEMO_USDC_ID}" ]] || fail "could not set up the ${TOKEN_CODE} token"
log "[deploy] ${TOKEN_CODE} = ${DEMO_USDC_ID}"

# 5. Initialize corridor-escrow with its dependency addresses.
log "[init] corridor-escrow.init(admin, agent_registry, oracle, treasury)"
invoke "${CORRIDOR_ESCROW_ID}" deployer init \
  --admin "${DEPLOYER_ADDRESS}" \
  --agent-registry "${AGENT_REGISTRY_ID}" \
  --oracle "${RATE_ORACLE_ADAPTER_ID}" \
  --treasury "${TREASURY_ADDRESS}"

# Persist the contract IDs where setup_corridor.sh can read them.
{
  printf 'NETWORK=%s\n' "${NETWORK}"
  printf 'NETWORK_PASSPHRASE=%s\n' "${NETWORK_PASSPHRASE}"
  printf 'RPC_URL=%s\n' "${RPC_URL}"
  printf 'CORRIDOR_ESCROW_ID=%s\n' "${CORRIDOR_ESCROW_ID}"
  printf 'AGENT_REGISTRY_ID=%s\n' "${AGENT_REGISTRY_ID}"
  printf 'RATE_ORACLE_ADAPTER_ID=%s\n' "${RATE_ORACLE_ADAPTER_ID}"
  printf 'DEMO_USDC_ID=%s\n' "${DEMO_USDC_ID}"
  printf 'DEMO_USDC_CODE=%s\n' "${TOKEN_CODE}"
  printf 'DEMO_USDC_ISSUER=%s\n' "${DEPLOYER_ADDRESS}"
  printf 'DEMO_USDC_DECIMALS=%s\n' "${TOKEN_DECIMALS}"
  printf 'DEPLOYER_ADDRESS=%s\n' "${DEPLOYER_ADDRESS}"
  printf 'TREASURY_ADDRESS=%s\n' "${TREASURY_ADDRESS}"
  printf 'CORRIDOR_ID=%s\n' "${CORRIDOR_ID}"
  printf 'CORRIDOR_BASE=%s\n' "${CORRIDOR_BASE}"
  printf 'CORRIDOR_QUOTE=%s\n' "${CORRIDOR_QUOTE}"
  printf 'PROTOCOL_FEE_BPS=%s\n' "${PROTOCOL_FEE_BPS}"
  printf 'AGENT_FEE_BPS=%s\n' "${AGENT_FEE_BPS}"
} > "${OUT_FILE}"
log "[out]  wrote ${OUT_FILE}"

# Regenerate the sender-app's contract wiring so the frontend talks to these
# exact testnet instances.
FRONTEND_SRC="${REPO_ROOT}/frontend/sender-app/src/contracts.ts"
if [[ -d "${REPO_ROOT}/frontend/sender-app/src" ]]; then
  cat > "${FRONTEND_SRC}" <<EOF
// DO NOT EDIT — generated by scripts/deploy.sh. Re-run to point the sender app
// at a freshly deployed set of testnet contracts.
export const CONTRACTS = {
  testnet: {
    network: "${NETWORK}",
    networkPassphrase: "${NETWORK_PASSPHRASE}",
    rpcUrl: "${RPC_URL}",
    escrow: "${CORRIDOR_ESCROW_ID}",
    registry: "${AGENT_REGISTRY_ID}",
    oracle: "${RATE_ORACLE_ADAPTER_ID}",
    token: "${DEMO_USDC_ID}",
    tokenCode: "${TOKEN_CODE}",
    tokenIssuer: "${DEPLOYER_ADDRESS}",
    tokenDecimals: ${TOKEN_DECIMALS},
    corridor: {
      id: "${CORRIDOR_ID}",
      base: "${CORRIDOR_BASE}",
      quote: "${CORRIDOR_QUOTE}",
      protocolFeeBps: ${PROTOCOL_FEE_BPS},
      agentFeeBps: ${AGENT_FEE_BPS},
    },
  },
}
EOF
  log "[out]  regenerated ${FRONTEND_SRC}"
fi

echo ""
echo "== Deployed contract IDs (${NETWORK}) =="
printf '  %-24s %s\n' "corridor-escrow" "${CORRIDOR_ESCROW_ID}"
printf '  %-24s %s\n' "agent-registry" "${AGENT_REGISTRY_ID}"
printf '  %-24s %s\n' "rate-oracle-adapter" "${RATE_ORACLE_ADAPTER_ID}"
printf '  %-24s %s\n' "${TOKEN_CODE} (token)" "${DEMO_USDC_ID}"
echo ""
echo "Register the demo corridor + agents with:  ./scripts/setup_corridor.sh ${NETWORK}"