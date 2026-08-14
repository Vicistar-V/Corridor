use soroban_sdk::{contracttype, Address, String, Symbol, Vec};

/// Lifecycle of a remittance transfer, per the states implied by README
/// "Smart Contracts > 1. corridor-escrow" and "Usage Flows".
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransferStatus {
    /// `initiate_transfer` called; rate pending or locked.
    Locked,
    /// `fund` completed; funds held in escrow.
    Funded,
    /// `assign_agent` completed; payout agent set.
    AgentAssigned,
    /// `confirm_delivery` attestation accepted; funds released.
    Delivered,
    /// `refund` executed after the delivery window lapsed.
    Refunded,
    /// `dispute` escalated to the arbiter role.
    Disputed,
}

/// A remittance corridor (e.g. `US-NG`), with its declared fee schedule used
/// by the fee splitter (README "Smart Contracts > 4. fee-splitter").
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Corridor {
    /// Corridor identifier, e.g. "US-NG".
    pub id: Symbol,
    /// Settlement currency of the sending side, e.g. "USDC".
    pub base: Symbol,
    /// Destination currency of the payout side, e.g. "NGN".
    pub quote: Symbol,
    /// Protocol fee, in basis points, charged per transfer.
    pub protocol_fee_bps: u32,
    /// Agent fee, in basis points, paid to the payout agent per transfer.
    pub agent_fee_bps: u32,
}

/// A registered payout agent per README "Smart Contracts > 2. agent-registry".
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    /// On-chain address of the agent.
    pub address: Address,
    /// Corridors the agent is registered to serve.
    pub corridor_ids: Vec<Symbol>,
    /// Off-chain metadata URI (e.g. licensing, location) for the agent.
    pub metadata_uri: String,
    /// Whether the agent passed verification (`verify_agent`).
    pub verified: bool,
    /// Whether the agent is currently active (`deactivate_agent` sets false).
    pub active: bool,
}

/// The escrow record backing one remittance, one logical transfer per
/// corridor-escrow instance (README "Smart Contracts > 1. corridor-escrow").
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    /// Unique identifier returned by `initiate_transfer`.
    pub transfer_id: u64,
    /// Sender of the funds (Stellar address).
    pub sender: Address,
    /// Intended recipient of the payout.
    pub recipient: Address,
    /// Corridor the transfer runs through, e.g. "US-NG".
    pub corridor_id: Symbol,
    /// Amount being remitted, in the `token` smallest units.
    pub amount: i128,
    /// Stablecoin asset used to fund the transfer.
    pub token: Address,
    /// FX rate locked on-chain by `lock_rate` (oracle-fed); unset until locked.
    pub locked_rate: Option<i128>,
    /// Current lifecycle state.
    pub status: TransferStatus,
    /// Ledger timestamp of `initiate_transfer`.
    pub created_at: u64,
    /// Ledger timestamp at which the locked rate expires
    /// (README: "stores rate + expiry", bounded validity window).
    pub rate_expiry: u64,
    /// Ledger timestamp by which delivery must be confirmed before refund,
    /// enforcing the timeout-based refund path (README "Security Model").
    pub delivery_deadline: u64,
}
