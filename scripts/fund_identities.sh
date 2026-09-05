#!/usr/bin/env bash
#
# fund_identities.sh — generate and fund Corridor test identities via Friendbot.
#
# Corridor's deployment tooling uses a small set of named identities stored in
# the Stellar CLI keystore. This script creates any that are missing and funds
# each one on the given network (default: testnet) via `stellar keys fund`,
# which hits the network's Friendbot endpoint.
#
# Usage:
#   ./scripts/fund_identities.sh [network]
#
# Network defaults to "testnet". Passing e.g. `futurenet` targets futurenet.
#
# The identities mirror the roles used by README's Sender/Agent flows:
#   deployer  — contract admin/arbiter (double duties: token issuer + treasury owner at MVP)
#   treasury  — receives the protocol fee on delivery
#   sender    — funds a transfer (USDC wallet in the sender flow)
#   recipient — destination of a payout
#   agent1, agent2 — mock payout agents registered for the demo corridor

set -euo pipefail

NETWORK="${1:-testnet}"
IDENTITIES=(deployer sender recipient agent1 agent2 treasury)

# Resolve the Stellar/Soroban CLI: prefer `SOROBAN`, then `soroban`, then `stellar`.
if [[ -n "${SOROBAN:-}" ]]; then
  CLI="${SOROBAN}"
elif command -v soroban >/dev/null 2>&1; then
  CLI="soroban"
elif command -v stellar >/dev/null 2>&1; then
  CLI="stellar"
else
  echo "error: neither 'soroban' nor 'stellar' CLI found on PATH" >&2
  echo "install the Stellar CLI (https://developers.stellar.org/docs/tools/developer-tools/cli)" >&2
  exit 1
fi

ensure_identity() {
  local name="$1"
  if "$CLI" keys ls | grep -qx "${name}"; then
    echo "[skip] identity '${name}' already exists"
    return 0
  fi
  echo "[gen]  generating identity '${name}'"
  "$CLI" keys generate "${name}"
}

fund_identity() {
  local name="$1"
  echo "[fund] funding '${name}' on '${NETWORK}' via Friendbot"
  # Funding an already-funded account is an expected no-op on re-runs.
  "$CLI" keys fund "${name}" --network "${NETWORK}" ||
    echo "[fund] '${name}' already funded (skipping)"
}

echo "== Corridor identities — network: ${NETWORK} =="
for identity in "${IDENTITIES[@]}"; do
  ensure_identity "${identity}"
done

for identity in "${IDENTITIES[@]}"; do
  fund_identity "${identity}"
done

echo ""
echo "== Summary =="
printf "%-12s %s\n" "identity" "address"
for identity in "${IDENTITIES[@]}"; do
  printf "%-12s %s\n" "${identity}" "$("$CLI" keys public-key "${identity}")"
done

echo ""
echo "Deploy with:  ./scripts/deploy.sh ${NETWORK}"
echo "Set up demo:  ./scripts/setup_corridor.sh ${NETWORK}"