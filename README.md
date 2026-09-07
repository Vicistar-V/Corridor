# Corridor

**Programmable cross-border remittance settlement on Stellar/Soroban.**

Corridor is a Soroban smart contract protocol (plus reference frontend) that turns cross-border remittances into programmable, on-chain settlement flows — locked FX rates, multi-party split payouts, and conditional release tied to verified local off-ramp agents. It is built as a Stellar-first project: the settlement logic lives in Soroban contracts, not in a centralized backend, and it plugs into Stellar's existing anchor/SEP infrastructure instead of reinventing compliance and cash-out rails.

> Status: 🚧 Early development — testnet MVP in progress
> Track: [Stellar Community Fund](https://communityfund.stellar.org/) — Build Award (target: SCF Build)

---

## Table of Contents

- [Why Corridor](#why-corridor)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Smart Contracts](#smart-contracts)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
- [Usage Flows](#usage-flows)
- [Roadmap](#roadmap)
- [Security Model](#security-model)
- [Stellar Ecosystem Fit](#stellar-ecosystem-fit)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## Why Corridor

Cross-border remittances remain slow, expensive, and opaque — even when "on-chain," because most stablecoin remittance apps are just a wallet plus a swap. They don't use what a smart contract platform actually makes possible: programmable settlement logic that encodes the real-world agreement between sender, recipient, and the local agent who ultimately hands over cash or local currency.

Corridor addresses three specific pain points:

| Problem | Traditional / naive on-chain approach | Corridor's approach |
|---|---|---|
| FX rate risk between send and payout | Rate floats until settlement, sender/recipient absorbs slippage | Rate is locked on-chain at time of send via an oracle-fed contract call |
| Local payout coordination | Off-chain manual coordination with cash-out agents | On-chain **Agent Registry** with verified, corridor-specific payout agents |
| Fee transparency & multi-party splits | Opaque fees baked into FX spread | Explicit, auditable on-chain split (agent fee, protocol fee, recipient amount) enforced by contract |
| Trust that funds are released only on delivery | Sender trusts a custodial platform | Funds held in a Soroban escrow contract, released only on confirmed delivery attestation |

Corridor doesn't try to replace Stellar's anchor network or KYC/compliance stack — it composes with it (SEP-24 deposit/withdrawal, SEP-31 direct cross-border payments) and adds the missing programmable settlement layer on top.

---

## How It Works

1. **Sender initiates a transfer** — chooses a corridor (e.g., `US-NG`, `EU-NG`), enters an amount in a supported stablecoin (e.g., USDC on Stellar), and selects a recipient.
2. **Rate lock** — the contract reads a current FX rate (via oracle or signed price feed) and locks it for a bounded validity window (e.g., 15 minutes), so neither party is exposed to rate drift during settlement.
3. **Escrow** — funds move into a per-transfer Soroban escrow contract instance, split according to a pre-declared fee schedule (protocol fee, agent fee, recipient payout).
4. **Agent routing** — the contract queries the on-chain **Agent Registry** for verified, active payout agents in the destination corridor and assigns (or lets the sender select) an agent.
5. **Delivery & release** — the assigned agent confirms payout to the recipient (cash pickup, mobile money, bank deposit) via a signed attestation call. The contract validates the attestation and releases the escrowed funds accordingly.
6. **Dispute / timeout path** — if no attestation is received within a defined window, funds are refundable to the sender (or escalate to a dispute-resolution role), so funds are never permanently stuck.

---

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────┐
│   Sender Frontend    │        │     Agent Dashboard       │
│  (React + Freighter) │        │   (React + Freighter)     │
└──────────┬───────────┘        └────────────┬─────────────┘
           │                                  │
           │        Soroban RPC / SDK         │
           ▼                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                     Soroban Contracts                        │
│                                                                │
│  ┌─────────────────┐   ┌───────────────────┐   ┌───────────┐│
│  │ Corridor Escrow  │──▶│  Agent Registry    │   │ Rate Oracle││
│  │   Contract       │   │   Contract         │◀──│  Adapter   ││
│  └────────┬─────────┘   └────────────────────┘   └───────────┘│
│           │                                                    │
│  ┌────────▼─────────┐                                         │
│  │  Fee Splitter /   │                                         │
│  │  Payout Logic     │                                         │
│  └───────────────────┘                                         │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
   Stellar Network (SEP-24 / SEP-31 anchors, stablecoin rails)
```

**Design principle:** every contract is single-responsibility and composable — the Escrow contract doesn't know how to price FX, and the Rate Oracle Adapter doesn't know how to split fees. This keeps each piece auditable and independently upgradable.

---

## Smart Contracts

### 1. `corridor-escrow`
Core settlement contract. One instance (or one logical transfer record) per remittance.

- `initiate_transfer(sender, recipient, corridor_id, amount, token) -> transfer_id`
- `lock_rate(transfer_id) -> locked_rate` — calls the Rate Oracle Adapter, stores rate + expiry
- `fund(transfer_id)` — pulls stablecoin from sender into escrow (requires prior `approve`)
- `assign_agent(transfer_id, agent_id)` — queries Agent Registry for eligibility
- `confirm_delivery(transfer_id, attestation_sig)` — agent-signed proof of payout; releases funds
- `refund(transfer_id)` — callable by sender after timeout if undelivered
- `dispute(transfer_id)` — escalates to a designated arbiter role (multisig, in MVP)

### 2. `agent-registry`
On-chain directory of verified payout agents per corridor.

- `register_agent(agent_address, corridor_ids[], metadata_uri)`
- `verify_agent(agent_address)` — restricted to a verifier/admin role during MVP; designed to move to a reputation/stake-based model later
- `deactivate_agent(agent_address)`
- `get_agents_for_corridor(corridor_id) -> Vec<Agent>`

### 3. `rate-oracle-adapter`
Thin adapter contract that normalizes external FX price data into a format the Escrow contract can consume.

- `get_rate(base, quote) -> (rate, timestamp)`
- Pluggable backend: reflector/oracle network in production, mock feed for local testing

### 4. `fee-splitter` (library module, not a separate deployed contract)
Shared logic imported by `corridor-escrow` to compute the split between protocol fee, agent fee, and net recipient payout, given a corridor's declared fee schedule.

> All contracts are written in Rust targeting the Soroban SDK, with `#![no_std]` where applicable, and are structured as independent crates under `contracts/` sharing a `common/` types crate for shared structs (e.g., `TransferStatus`, `Corridor`, `Agent`).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart contracts | Rust, Soroban SDK |
| Contract testing | Soroban CLI, `soroban-sdk` test utils, `cargo test` |
| Frontend | React, TypeScript, Vite |
| Wallet integration | Freighter (Stellar wallet), `@stellar/stellar-sdk`, `@stellar/freighter-api` |
| Off-chain services (optional, MVP+) | Node.js indexer for transfer history, listens to contract events |
| Anchor / compliance integration | SEP-24 (interactive deposit/withdrawal), SEP-31 (direct payments) |
| Network | Soroban Testnet (MVP) → Futurenet/Mainnet (post-audit) |
| CI | GitHub Actions — contract build + test, frontend build + lint, on every push to `main` and every PR |

---

## Repository Structure

```
corridor/
├── contracts/
│   ├── corridor-escrow/
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── transfer.rs
│   │   │   ├── fee_splitter.rs
│   │   │   └── test.rs
│   │   └── Cargo.toml
│   ├── agent-registry/
│   │   ├── src/
│   │   └── Cargo.toml
│   ├── rate-oracle-adapter/
│   │   ├── src/
│   │   └── Cargo.toml
│   └── common/
│       ├── src/
│       │   ├── lib.rs
│       │   └── types.rs
│       └── Cargo.toml
├── frontend/
│   ├── sender-app/          # Sender-facing transfer flow
│   └── agent-dashboard/     # Agent-facing confirm/payout flow
├── scripts/
│   ├── deploy.sh            # Deploy all contracts to testnet
│   ├── fund_identities.sh   # Fund test accounts via Friendbot
│   ├── setup_corridor.sh    # Register a demo corridor + agents
│   ├── mint_test_usdc.sh    # Mint demo DEMOUSDC for a testnet wallet
│   └── verify_lifecycle.sh  # Drive one full transfer end-to-end on testnet
├── docs/
│   ├── ARCHITECTURE.md      # Per-contract architecture detail
│   └── CONTRACT_INTERFACES.md  # Function signatures + parameter docs
├── .github/workflows/ci.yml
├── Cargo.toml                # Workspace root
├── LICENSE
└── README.md
```

---

## Getting Started

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable) + `wasm32v1-none` target
- [Soroban CLI](https://developers.stellar.org/docs/tools/developer-tools#cli) (the `soroban` command is provided by the modern Stellar CLI, installed as `stellar`)
- [Node.js](https://nodejs.org/) 18+ and npm/pnpm
- [Freighter wallet](https://www.freighter.app/) browser extension (for testnet interaction)

### 1. Clone and install

```bash
git clone https://github.com/<your-org>/corridor.git
cd corridor
rustup target add wasm32v1-none
```

### 2. Build the contracts

```bash
cd contracts
cargo build --target wasm32v1-none --release
```

### 3. Run contract tests

```bash
cargo test
```

### 4. Deploy to Soroban Testnet

```bash
# Fund a deployer identity
soroban keys generate deployer --network testnet
soroban keys fund deployer --network testnet

# Deploy
./scripts/deploy.sh testnet
```

### 5. Run the frontends

The repo ships two frontends that share the same testnet contract deployment:

```bash
# Sender app — initiates and funds transfers
cd frontend/sender-app
npm install
npm run dev
```

```bash
# Agent dashboard — picked up by a registered payout agent
cd frontend/agent-dashboard
npm install
npm run dev
```

Open the printed URLs, connect **Freighter** on testnet to a funded wallet, add
a `DEMOUSDC` trustline, and fund it:

```bash
./scripts/mint_test_usdc.sh testnet <your G-address>
```

Both apps are wired to the testnet contracts deployed by `./scripts/deploy.sh`
(that script regenerates `frontend/<app>/src/contracts.ts` for **both**
frontends, so every frontend observes the same on-chain transfer lifecycle).

### 6. Run the full end-to-end demo (sender → agent → delivery)

This is the core proof that the sender and agent frontends form one working
loop against the same testnet contracts:

1. **Sender app** (`localhost:5173`): as the `sender` wallet, pick the
   `USNG` corridor, enter an amount (e.g. `100`) and a recipient, then
   **Initiate** → **Approve + fund escrow**.
2. **Deployer wallet** (operator controls in the sender app): **Refresh rate**,
   **Lock rate**, then **Assign agent** (auto-selects a verified agent).
   The transfer is now `AgentAssigned` and awaiting payout.
3. **Agent dashboard** (`localhost:5174`): connect Freighter with the same
   registered **agent wallet** (e.g. `agent1`). The dashboard shows a green
   *verified agent* pill. Look up the transfer id from step 1 and track it —
   it reports `AgentAssigned`.
4. **Off-chain payout** (manual/external, out of scope for the foundation):
   the agent hands over cash / mobile money / bank deposit to the recipient
   directly.
5. **Agent dashboard**: tick *Off-chain payout completed*, then **Submit
   delivery attestation**. The wallet signs the attestation; the escrow
   contract releases the funds (recipient, agent fee, protocol fee).
6. **Sender app**: refresh the transfer — the status timeline reaches
   **Delivered**.

> Headless / CI note: the browser steps above need the Freighter extension, so
> they cannot run unattended in CI. The identical on-chain lifecycle is
> driven end-to-end against the same live deployment by
> `./scripts/verify_lifecycle.sh testnet`. The last verified run walked
> transfer **#2** to `Delivered` with the expected split (recipient
> `970000000`, agent fee `20000000`, protocol fee `10000000` DEMOUSDC units)
> and the agent dashboard's runtime read calls (`get_agents_for_corridor`,
> `status`) confirmed the same contracts return `AgentAssigned`-eligible
> agents and the final `Delivered` status.

---

## Usage Flows

### Sender flow
1. Connect Freighter wallet
2. Select corridor (e.g., US → NG) and enter amount
3. Review locked FX rate and fee breakdown
4. Approve token spend and confirm transfer
5. Track transfer status (Locked → Funded → Agent Assigned → Delivered / Refunded)

### Agent flow
1. Connect Freighter wallet (registered agent address)
2. View assigned transfers awaiting payout
3. Complete off-chain payout (cash pickup, mobile money, bank deposit)
4. Submit delivery attestation on-chain to trigger fund release

---

## Roadmap

- [x] Architecture design + contract interface spec
- [x] `corridor-escrow` contract — core transfer + fund + release logic
- [x] `agent-registry` contract — MVP with admin-verified agents
- [x] `rate-oracle-adapter` — mock feed for testnet
- [ ] `rate-oracle-adapter` — real oracle integration for mainnet
- [x] Sender frontend (testnet demo)
- [x] Agent dashboard (testnet demo)
- [ ] Single-corridor pilot (e.g., US → NG) with 1–2 real off-ramp partners
- [ ] Third-party contract audit
- [ ] SEP-24 / SEP-31 anchor integration
- [ ] Mainnet launch
- [ ] Multi-corridor expansion + agent staking/reputation model

All checked items are wired to the same live testnet deployment and verified
end-to-end (see [Getting Started](#getting-started) and the full lifecycle run
via `./scripts/verify_lifecycle.sh`). The unchecked items require partnerships,
audit, or mainnet infrastructure and are intentionally out of scope for the
foundation phase.

---

## Security Model

- **Non-custodial by design** — funds sit in the Escrow contract, never in a centralized wallet controlled by the team.
- **Timeout-based refunds** — every transfer has a bounded delivery window; undelivered funds are refundable to the sender, preventing indefinite fund lock.
- **Agent verification** — MVP uses an admin-gated allowlist for agents; the roadmap moves this to a stake-and-slash reputation model to reduce centralization.
- **Rate lock expiry** — locked rates are only valid for a short window to prevent stale-price exploitation.
- **Dispute path** — a designated arbiter role can intervene on contested transfers during the MVP phase; intended to evolve toward a decentralized dispute mechanism.
- **Planned audit** — a third-party Soroban contract audit is budgeted into the roadmap before any mainnet deployment with real funds.

> This project has **not yet been audited**. Do not use with real funds until an audit is complete and this notice is removed.

---

## Stellar Ecosystem Fit

Corridor is built as a **Stellar-first** project, not a multi-chain app with Stellar bolted on:

- Uses Soroban for actual programmable settlement logic (escrow, splits, conditional release) — not just as a token-transfer rail.
- Composes with Stellar's existing anchor framework (SEP-24, SEP-31) instead of duplicating compliance/off-ramp infrastructure.
- Directly targets SDF's stated goal of fast, inexpensive, transparent cross-border payments.
- Designed for submission to the [Stellar Community Fund](https://communityfund.stellar.org/) Build Award track.

---

## Contributing

Contributions, issue reports, and corridor/agent partnership inquiries are welcome. Please open an issue to discuss significant changes before submitting a PR.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/sender-ux`)
3. Commit your changes with clear messages
4. Open a PR against `main`

### Local setup gotchas

Things that bit us during the first week of building — check these before
opening an issue:

- **Wasm target.** Contracts must build for `wasm32v1-none`, not
  `wasm32-unknown-unknown` — Soroban's protocol-28 VM rejects the
  reference-types/multivalue encodings the old target emits. Run
  `rustup target add wasm32v1-none` and build with
  `cargo build --workspace --target wasm32v1-none --release`
  (`.cargo/config.toml` documents why).
- **Rust toolchain is pinned.** `rust-toolchain.toml` pins channel `1.96.0`
  (with the `wasm32v1-none` target). The Soroban 20.x dependency graph pins
  `ethnum = "=1.5.0"`, which Rust 1.97+ rejects (`E0512`: `TryFromIntError`
  changed size). `rustup` auto-installs the pinned channel on first `cargo`
  use, and CI reads the same file — don't compile the contracts with a newer
  rustc.
- **The `soroban` command lives in the Stellar CLI.** `soroban` is provided by
  the modern CLI installed as `stellar`; the scripts prefer `soroban`, then
  fall back to `stellar`. Either works on `PATH`.
- **Strict frontend typecheck.** `npm run build` runs `tsc -b` with
  `noUnusedLocals`/`noUnusedParameters`. Dead code fails CI, not just lints.
  Use `npm ci` (the lockfiles are the source of truth), and run both
  `npm run lint` and `npm run build` before pushing.
- **Rate staleness.** The demo oracle expires a rate after 300 s. Refresh the
  rate (sender app's *Refresh rate*) before `lock_rate`, and `fund` within the
  15-minute lock window or it rejects with `RateExpired`.
- **Agents must be registered + verified first.** `assign_agent` only accepts
  agents returned by the registry for the corridor. Run
  `./scripts/setup_corridor.sh` once after deploying; the agent dashboard
  flags any connected wallet that is not a registered agent.
- **Never hand-edit `frontend/*/src/contracts.ts`.** It is generated by
  `./scripts/deploy.sh` for **both** apps so every frontend talks to the same
  deployment. Re-deploy (or re-run the generator loop in `deploy.sh`) instead.
- **Freighter must be on testnet.** Both apps check the wallet network and
  show a warning when it isn't testnet.
- **Live-network checks are not CI-silent.** The browser Freighter flow can't
  run unattended; the reproducible on-chain equivalent is
  `./scripts/verify_lifecycle.sh testnet`.

---

## License

[Apache 2.0](LICENSE) — matches Stellar/Soroban SDK licensing conventions.

---

## Acknowledgements

- [Stellar Development Foundation](https://stellar.org) and the Soroban SDK team
- [Stellar Community Fund](https://communityfund.stellar.org/) for ecosystem grant support
- Stellar anchor network operators enabling SEP-24 / SEP-31 flows
