# Corridor — Architecture

This document expands the architecture diagram in [`README.md`](../README.md
#architecture) into per-contract responsibilities, data flow, and storage
layout. The README is the single source of truth for scope; anything here is a
detail of what the README already describes.

---

## System diagram

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
│  │    (admin =      │   │   (admin =         │   │   (mock    ││
│  │    arbiter)      │   │   deployer)        │   │   feed)    ││
│  └────────┬─────────┘   └────────────────────┘   └───────────┘│
│           │                                                    │
│  ┌────────▼─────────┐                                         │
│  │  Fee Splitter /   │                                         │
│  │  Payout Logic     │                                         │
│  │  (library module) │                                         │
│  └───────────────────┘                                         │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
   Stellar Network (SEP-24 / SEP-31 anchors, stablecoin rails)
```

Reads top-to-bottom as control flow:

- The **two frontends** are independent UIs over the **same** deployed
  contracts. The sender app creates and funds transfers; the agent dashboard
  confirms delivery. They never talk to each other directly — the escrow
  contract is the shared state.
- **Corridor Escrow** is the settlement core. It *calls* the Agent Registry to
  resolve an eligible payout agent and *calls* the Rate Oracle Adapter to fetch
  the FX rate it locks. It does **not** know how to price FX or verify agents.
- **Fee Splitter** is a pure library module compiled into the escrow contract
  (not a separate deployment) that computes the protocol / agent / recipient
  split from a corridor's fee schedule.
- Below the contracts sits the Stellar network: the `DEMOUSDC` stablecoin
  (Stellar Asset Contract wrapping a classic asset) moves in and out of the
  escrow, and SEP-24/SEP-31 anchors are the intended compliance/off-ramp rails.

---

## Per-contract responsibility

### 1. `corridor-escrow` — settlement core

Single-responsibility: **hold funds in escrow and release them only when the
programmed conditions are met.**

Responsibilities:

- Own one `Transfer` record per remittance (a per-transfer logical instance),
  keyed by an incrementing `transfer_id`.
- Enforce the lifecycle state machine (`Locked → Funded → AgentAssigned →
  Delivered`, plus `Refunded` / `Disputed` terminal states).
- Lock an FX rate with a bounded validity window (`RATE_LOCK_WINDOW = 900` s)
  by invoking the Rate Oracle Adapter.
- Pull the stablecoin from the sender (via SAC `transfer_from`) into escrow.
- Assign a payout agent **only if** the Agent Registry currently lists that
  agent as verified + active for the transfer's corridor.
- Release funds on delivery: the assigned agent authorizes `confirm_delivery`,
  and the Fee Splitter computes recipient / agent / protocol amounts that are
  paid out of escrow.
- Refund undelivered funds to the sender once the delivery window
  (`DELIVERY_WINDOW = 86_400` s) has lapsed.
- Escalate contested transfers to an arbiter role (the admin, in MVP).

Storage keys:

| Key | Value |
|---|---|
| `Admin` | admin address (doubles as MVP arbiter / dispute role) |
| `AgentRegistry` | agent-registry contract address |
| `Oracle` | rate-oracle-adapter contract address |
| `Treasury` | address that receives the protocol fee |
| `NextTransferId` | counter for `transfer_id` allocation |
| `Corridor(Symbol)` | corridor fee schedule (`Corridor`) |
| `Transfer(u64)` | the `Transfer` record |
| `TransferAgent(u64)` | the assigned agent address |

### 2. `agent-registry` — on-chain payout-agent directory

Single-responsibility: **maintain the allowlist of verified, active payout
agents per corridor** and answer one question — *who may serve this corridor?*

Responsibilities:

- Register an agent with the corridors it serves, an off-chain metadata URI,
  and `verified = false`, `active = true` defaults.
- `verify_agent` flips an agent to `verified`; `deactivate_agent` flips
  `active` off. Both are admin-gated.
- `get_agents_for_corridor` returns only agents that are **both**
  `verified && active`, and backs the corridor→agent index maintained at
  registration time.

Storage keys:

| Key | Value |
|---|---|
| `AdminKey(Symbol "admin")` | admin address |
| `AgentKey(Address)` | the `Agent` record |
| `CorridorAgents(Symbol)` | `Vec<Address>` serving a corridor |

### 3. `rate-oracle-adapter` — FX feed normalization

Single-responsibility: **store a current FX rate for a base/quote pair and
serve it to callers, rejecting stale values.**

Responsibilities:

- `set_rate` stores a rate with the ledger timestamp (unauthored mock feed in
  the foundation phase; pluggable backend later).
- `get_rate` returns `(rate, timestamp)` or fails with `RateStale` when the
  stored rate is older than `STALENESS_THRESHOLD = 300` seconds.
- `has_rate` is a cheap existence check.

Storage keys:

| Key | Value |
|---|---|
| `RateKey { base, quote }` | `RateValue { rate, timestamp }` |

### 4. `fee-splitter` — payout math (library)

Not a deployed contract. `compute_split(corridor, amount)` computes
`protocol_fee = amount * protocol_fee_bps / 10_000`,
`agent_fee = amount * agent_fee_bps / 10_000`, and
`recipient = amount - protocol - agent`, rounding down per term. It is the
implementation of README's "explicit, auditable on-chain split".

---

## Shared types (`corridor-common`)

`contracts/common/src/types.rs` defines the structs every contract consumes:
`TransferStatus`, `Corridor`, `Agent`, and `Transfer`. See
[`CONTRACT_INTERFACES.md`](CONTRACT_INTERFACES.md#shared-types-corridor-common)
for the field-by-field documentation.

---

## Transfer lifecycle & sequence

```
Sender            Escrow             Oracle Adapter        Registry        Recipient/Agent
  │  initiate_transfer()  │               │                   │                │
  ├──────────────────────▶│  (validates corridor exists)     │                │
  │◀──── transfer_id ─────┤               │                   │                │
  │                       │ lock_rate(id) │                   │                │
  │                       ├──────────────▶│                   │                │
  │                       │◀── (rate, ts) ├───────────────────┤                │
  │                       │  (store rate + expiry)            │                │
  │  approve(escrow,amt)  │               │                   │                │
  ├──────────────────────▶│ (SAC)         │                   │                │
  │  fund(id)             │               │                   │                │
  ├──────────────────────▶│ transfer_from(sender → escrow)    │                │
  │ (admin) assign_agent(id, agent)       │                   │                │
  ├──────────────────────▶│  get_agents_for_corridor(USNG)    │                │
  │                       ├──────────────────────────────────▶│                │
  │                       │◀───────── Vec<Agent> ─────────────┤                │
  │                       │ (must contain agent_id, else      │                │
  │                       │  AgentNotEligible)                │                │
  │ (agent) confirm_delivery(id, attn)    │                   │                │
  ├──────────────────────▶│ agent.require_auth()              │                │
  │                       │ compute_split()                   │                │
  │                       │ transfer: recipient / agent /     │                │
  │                       │           treasury                │                │
  │◀──── status: Delivered ┤               │                   │                │
```

Funds never move until after `confirm_delivery`: `fund` moves them *in*, and
`confirm_delivery` is the **only** path that moves them *out* (alongside
`refund`/dispute paths per the README Security Model).

---

## Error model

Each contract declares a `#[contracterror]` enum; failures are returned as
`Error(Contract, #N)` host errors.

| Contract | Code | Meaning |
|---|---|---|
| escrow | 1 | `Unauthorized` |
| escrow | 2 | `NotInitialized` (missing admin/registry/oracle/treasury) |
| escrow | 3 | `CorridorNotFound` |
| escrow | 4 | `TransferNotFound` |
| escrow | 5 | `InvalidState` (wrong lifecycle step) |
| escrow | 6 | `RateNotLocked` |
| escrow | 7 | `RateExpired` |
| escrow | 8 | `AgentNotEligible` |
| escrow | 9 | `CorridorAlreadySet` |
| escrow | 10 | `BeforeDeadline` (refund attempted too early) |
| escrow | 11 | `AlreadyTerminal` |
| registry | 1 | `Unauthorized` |
| registry | 2 | `AgentAlreadyRegistered` |
| registry | 3 | `AgentNotFound` |
| registry | 4 | `AgentNotVerified` *(reserved)* |
| registry | 5 | `AgentDeactivated` *(reserved)* |
| oracle | 1 | `RateNotFound` |
| oracle | 2 | `RateStale` |
| oracle | 3 | `InvalidPair` |

---

## Security model mechanics

The README Security Model maps directly onto contract behavior:

- **Non-custodial:** funds sit in the escrow contract, not a team wallet
  (escrow `init` sets an independent `Treasury` for the protocol fee).
- **Timeout-based refunds:** `delivery_deadline` is set at `fund` time; once
  the ledger passes it, `refund` (sender-authorized) moves the full `amount`
  back. The contract blocks early refunds (`BeforeDeadline`) and double
  refunds (state moves to terminal `Refunded`).
- **Agent verification:** `assign_agent` only accepts an agent that the
  registry currently returns for the corridor; `confirm_delivery` requires the
  *assigned* agent's auth, so a non-agent cannot release funds.
- **Rate lock expiry:** `lock_rate` stores `rate_expiry`; `fund` rejects a
  transfer whose lock has expired.
- **Dispute path:** admin-gated `dispute` escalates a live transfer to
  `Disputed`; the contract refuses to escalate already-terminal transfers.

> Not audited — do not use with real funds. See README.

---

## Repo layout → architecture map

| README layer | Repository location |
|---|---|
| Corridor Escrow | `contracts/corridor-escrow/src/lib.rs`, `transfer.rs`, `fee_splitter.rs` |
| Agent Registry | `contracts/agent-registry/src/lib.rs` |
| Rate Oracle Adapter | `contracts/rate-oracle-adapter/src/lib.rs` |
| Shared types | `contracts/common/src/types.rs` |
| Sender frontend | `frontend/sender-app/` |
| Agent dashboard | `frontend/agent-dashboard/` |
| Deploy / setup / verify | `scripts/{deploy,setup_corridor,fund_identities,mint_test_usdc,verify_lifecycle}.sh` |