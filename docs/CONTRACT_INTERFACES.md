# Corridor — Contract Interfaces

Full function signatures and parameter documentation for the three deployed
Soroban contracts: `corridor-escrow`, `agent-registry`, and
`rate-oracle-adapter`, plus the shared wire types from `corridor-common`.

This mirrors README's [Smart Contracts](../README.md#smart-contracts) section.
Function signatures below are the Rust `#[contractimpl]` methods; the Soroban
CLI invokes them with kebab-case flags (e.g. `--transfer-id`, `--agent-id`) and
the frontends with camel-case object keys.

---

## Shared types (`corridor-common`)

Defined in `contracts/common/src/types.rs`; `#[contracttype]` so they serialize
directly to/from `scVal` on the wire.

### `TransferStatus` (enum)

```
Locked | Funded | AgentAssigned | Delivered | Refunded | Disputed
```

| Variant | Meaning |
|---|---|
| `Locked` | `initiate_transfer` called; rate pending or already locked |
| `Funded` | `fund` completed; funds held in escrow |
| `AgentAssigned` | `assign_agent` completed; payout agent set |
| `Delivered` | `confirm_delivery` accepted; funds released |
| `Refunded` | `refund` executed after the delivery window lapsed |
| `Disputed` | `dispute` escalated to the arbiter role |

On the wire, the SDK encodes a field-less variant as `scvVec([Symbol])`; the
CLI prints the bare string. Frontends normalize both encodings.

### `Corridor` (struct)

| Field | Type | Meaning |
|---|---|---|
| `id` | `Symbol` | Corridor identifier, e.g. `"USNG"` |
| `base` | `Symbol` | Settlement currency of the sending side, e.g. `"USDC"` |
| `quote` | `Symbol` | Destination currency of the payout side, e.g. `"NGN"` |
| `protocol_fee_bps` | `u32` | Protocol fee in basis points per transfer |
| `agent_fee_bps` | `u32` | Agent fee in basis points paid to the payout agent |

### `Agent` (struct)

| Field | Type | Meaning |
|---|---|---|
| `address` | `Address` | On-chain address of the agent |
| `corridor_ids` | `Vec<Symbol>` | Corridors the agent is registered to serve |
| `metadata_uri` | `String` | Off-chain metadata URI (licensing, location) |
| `verified` | `bool` | Whether the agent passed `verify_agent` |
| `active` | `bool` | Whether the agent is currently active |

### `Transfer` (struct)

| Field | Type | Meaning |
|---|---|---|
| `transfer_id` | `u64` | Unique identifier returned by `initiate_transfer` |
| `sender` | `Address` | Sender of the funds |
| `recipient` | `Address` | Intended recipient of the payout |
| `corridor_id` | `Symbol` | Corridor the transfer runs through |
| `amount` | `i128` | Amount remitted, in `token` smallest units |
| `token` | `Address` | Stablecoin asset funding the transfer |
| `locked_rate` | `Option<i128>` | FX rate locked by `lock_rate`; unset until locked |
| `status` | `TransferStatus` | Current lifecycle state |
| `created_at` | `u64` | Ledger timestamp of `initiate_transfer` |
| `rate_expiry` | `u64` | Ledger timestamp after which the locked rate is invalid |
| `delivery_deadline` | `u64` | Ledger timestamp by which delivery must be confirmed |

---

## 1. `corridor-escrow` — `contracts/corridor-escrow/src/lib.rs`

Constants: `RATE_LOCK_WINDOW = 900` (rate valid for 15 minutes),
`DELIVERY_WINDOW = 86_400` (24h), errors `1..=11` (see
[ARCHITECTURE.md](ARCHITECTURE.md#error-model)).

### `init`

```
pub fn init(env: Env, admin: Address, agent_registry: Address, oracle: Address, treasury: Address)
```

Configures the escrow contract. Callable once; panics on re-init.

| Param | Meaning |
|---|---|
| `admin` | Admin; doubles as the designated arbiter for `dispute` |
| `agent_registry` | Address of the deployed agent-registry contract |
| `oracle` | Address of the deployed rate-oracle-adapter contract |
| `treasury` | Address that receives the protocol fee on delivery |

Auth: none (first call only). CLI: `init --admin G… --agent-registry C… --oracle C… --treasury G…`.

### `set_corridor`

```
pub fn set_corridor(env: Env, corridor: Corridor) -> Result<(), Error>
```

Registers a corridor's fee schedule. Errors `CorridorAlreadySet` (9) if the id
is already registered.

Auth: **admin**. CLI: `set_corridor --corridor '{"id":{"symbol":"USNG"},...}'`. Note the CLI takes `--corridor` with a nested scVal JSON (see `scripts/setup_corridor.sh`), the SDK takes the `Corridor` struct.

### `initiate_transfer`

```
pub fn initiate_transfer(env: Env, sender: Address, recipient: Address, corridor_id: Symbol, amount: i128, token: Address) -> Result<u64, Error>
```

Starts a remittance and returns the new `transfer_id`.

| Param | Meaning |
|---|---|
| `sender` | Sender (must authorize the call) |
| `recipient` | Intended recipient of the payout |
| `corridor_id` | Corridor id, e.g. `USNG` — must be registered |
| `amount` | Amount in `token` smallest units |
| `token` | Stablecoin contract address funding the transfer |

Errors `CorridorNotFound` (3). Auth: **sender**. Returns `u64` `transfer_id`.

### `lock_rate`

```
pub fn lock_rate(env: Env, transfer_id: u64) -> Result<i128, Error>
```

Calls the oracle `get_rate(base, quote)`, stores the rate + `rate_expiry`, and
returns the locked rate.

Errors `NotInitialized` (2), `TransferNotFound` (4), `InvalidState` (5, when
not `Locked`), `CorridorNotFound` (3). Auth: none. Note: an oracle `RateStale`
failure surfaces as a host error `Error(Contract, #2)` from the oracle.

### `fund`

```
pub fn fund(env: Env, transfer_id: u64) -> Result<(), Error>
```

Pulls the stablecoin from `sender` into escrow via SAC `transfer_from`
(requires prior `approve(usc spender=escrow)`). Sets `delivery_deadline` and
moves the transfer to `Funded`.

Errors `RateNotLocked` (6), `RateExpired` (7), `InvalidState` (5). Auth:
**sender**.

### `assign_agent`

```
pub fn assign_agent(env: Env, transfer_id: u64, agent_id: Address) -> Result<(), Error>
```

Queries the registry `get_agents_for_corridor(corridor_id)`; if `agent_id`
appears (verified + active), stores `TransferAgent` and moves to
`AgentAssigned`.

Errors `AgentNotEligible` (8), `InvalidState` (5). Auth: none.

### `confirm_delivery`

```
pub fn confirm_delivery(env: Env, transfer_id: u64, _attestation_sig: BytesN<65>) -> Result<(), Error>
```

Validates that the caller is the assigned agent, computes the fee split, and
releases funds to recipient, agent, and treasury. `_attestation_sig` is a
65-byte signature slot accepted but **not verified in the foundation phase**
(the agent's auth *is* the attestation).

Errors `InvalidState` (5) when not `AgentAssigned`. Auth: **assigned agent**.

### `refund`

```
pub fn refund(env: Env, transfer_id: u64) -> Result<(), Error>
```

After `delivery_deadline`, refunds the full amount to the sender and moves to
`Refunded`. Errors `InvalidState` (5, when not `Funded`/`AgentAssigned`),
`BeforeDeadline` (10). Auth: **sender**.

### `dispute`

```
pub fn dispute(env: Env, transfer_id: u64) -> Result<(), Error>
```

Escalates a non-terminal transfer to `Disputed`. Errors `AlreadyTerminal` (11)
for `Delivered`/`Refunded`/`Disputed`. Auth: **admin** (arbiter).

### `status`

```
pub fn status(env: Env, transfer_id: u64) -> TransferStatus
```

Read-only; returns the current `TransferStatus`. Panics (`transfer not found`)
when the id does not exist — the read path used by both frontends.

---

## 2. `agent-registry` — `contracts/agent-registry/src/lib.rs`

Errors `1..=5` (see [ARCHITECTURE.md](ARCHITECTURE.md#error-model)).

### `init`

```
pub fn init(env: Env, admin: Address)
```

Sets the admin. Callable once (guard: `expect("admin not set")` pattern wrapped
in the admin lookups).

### `register_agent`

```
pub fn register_agent(env: Env, agent: Agent) -> Result<(), Error>
```

Registers an agent and appends its address to each corridor's index.
Errors `AgentAlreadyRegistered` (2). Auth: **admin**.

CLI arg: `register_agent --agent '{"address":{"address":"G…"},...}'`.

### `verify_agent`

```
pub fn verify_agent(env: Env, agent_address: Address) -> Result<(), Error>
```

Marks an agent `verified = true`. Errors `AgentNotFound` (3). Auth: **admin**.

### `deactivate_agent`

```
pub fn deactivate_agent(env: Env, agent_address: Address) -> Result<(), Error>
```

Marks an agent `active = false`. Errors `AgentNotFound` (3). Auth: **admin**.

### `get_agents_for_corridor`

```
pub fn get_agents_for_corridor(env: Env, corridor_id: Symbol) -> Vec<Agent>
```

Returns the corridor's `verified && active` agents. Read-only, no auth.

---

## 3. `rate-oracle-adapter` — `contracts/rate-oracle-adapter/src/lib.rs`

Constant: `STALENESS_THRESHOLD = 300` (seconds of ledger time). Errors `1..=3`.

### `set_rate`

```
pub fn set_rate(env: Env, base: Symbol, quote: Symbol, rate: i128)
```

Stores `RateValue { rate, timestamp: now }`. No auth in the mock feed.

### `get_rate`

```
pub fn get_rate(env: Env, base: Symbol, quote: Symbol) -> Result<RateValue, Error>
```

Returns `RateValue { rate, timestamp }`; errors `RateNotFound` (1) or
`RateStale` (2) when age > 300 seconds.

### `has_rate`

```
pub fn has_rate(env: Env, base: Symbol, quote: Symbol) -> bool
```

Existence check. Read-only.

---

## CLI invocation quick reference

```bash
# corridor-escrow
stellar contract invoke --id $ESCROW --source-account deployer --network testnet --send yes \
  -- init --admin G… --agent-registry C… --oracle C… --treasury G…
stellar contract invoke --id $ESCROW --source-account sender --network testnet --send yes \
  -- initiate_transfer --sender G… --recipient G… --corridor-id USNG --amount 1000000000 --token $TOKEN
stellar contract invoke --id $ESCROW --source-account sender --network testnet --send yes \
  -- lock_rate --transfer-id 1
stellar contract invoke --id $TOKEN --source-account sender --network testnet --send yes \
  -- approve --from G… --spender $ESCROW --amount 1000000000 --live_until_ledger $((LEDGER+10000))
stellar contract invoke --id $ESCROW --source-account sender --network testnet --send yes \
  -- fund --transfer-id 1
stellar contract invoke --id $ESCROW --source-account deployer --network testnet --send yes \
  -- assign_agent --transfer-id 1 --agent-id G…
stellar contract invoke --id $ESCROW --source-account agent1 --network testnet --send yes \
  -- confirm_delivery --transfer-id 1 --_attestation_sig 0001…3f40
stellar contract invoke --id $ESCROW --source-account deployer --network testnet --send no \
  -- status --transfer-id 1
```

The canonical end-to-end walk is `./scripts/verify_lifecycle.sh testnet`; the
`DEMOUSDC` token follows the SAC interface (`balance`, `allowance`, `approve`,
`transfer`, `transfer_from`, `mint`, `decimals`, `symbol`).