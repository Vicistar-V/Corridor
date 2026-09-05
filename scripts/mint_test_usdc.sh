#!/usr/bin/env bash
#
# mint_test_usdc.sh — top up an address with demo USDC (DEMOUSDC) on testnet.
#
# The sender-app needs the connected wallet to hold and trust DEMOUSDC before it
# can run a transfer. This script mints testnet tokens to any address using the
# deployer identity (the token issuer):
#
#   ./scripts/mint_test_usdc.sh <G-address> [amount-in-small-units]
#
# Default amount: 1000.0000000 DEMOUSDC (10000000000 small units).
#
# The wallet must add a trustline to DEMOUSDC first (the sender-app shows the
# exact command / walks through it on the "demo USDC" card).

set -euo pipefail

NETWORK="${1:-testnet}"
TARGET="${2:-}"
UNITS="${3:-10000000000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.contracts.${NETWORK}.env"

if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 <network> <G-address> [units]" >&2
  echo "  e.g.: $0 testnet GA7QNF5GMJBCXS74SPON2NSL3CYYVRE3EGXQK7FYW5GA4F7AREBR3F7A" >&2
  exit 1
fi

[[ -f "${ENV_FILE}" ]] || { echo "error: missing ${ENV_FILE} — run deploy.sh first" >&2; exit 1; }
# shellcheck disable=SC1090
source "${ENV_FILE}"

if [[ -n "${SOROBAN:-}" ]]; then CLI="${SOROBAN}";
elif command -v soroban >/dev/null 2>&1; then CLI="soroban";
elif command -v stellar >/dev/null 2>&1; then CLI="stellar";
else echo "error: Stellar CLI not found" >&2; exit 1; fi

"$CLI" contract invoke --id "${DEMO_USDC_ID}" --source-account deployer \
  --network "${NETWORK}" --send yes \
  -- mint --to "${TARGET}" --amount "${UNITS}" >/dev/null 2>&1

echo "✅ Minted ${UNITS} ${DEMO_USDC_CODE} to ${TARGET} (network: ${NETWORK})"