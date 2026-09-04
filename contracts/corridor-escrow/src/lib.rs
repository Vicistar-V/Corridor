#![no_std]
#![allow(unexpected_cfgs)]

mod fee_splitter;
mod test;
mod transfer;

use corridor_common::types::{Corridor, Transfer, TransferStatus};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token::TokenClient, Address, BytesN, Env,
    IntoVal, Symbol, Vec,
};

use rate_oracle_adapter::RateValue;

/// Bounded validity window for a locked rate (README "Security Model": "locked
/// rates are only valid for a short window"; "How It Works": e.g. 15 minutes).
pub const RATE_LOCK_WINDOW: u64 = 900;

/// Bounded delivery window after which undelivered funds become refundable
/// (README "Security Model": "undelivered funds are refundable to the sender").
pub const DELIVERY_WINDOW: u64 = 86_400;

/// Persistent storage keys for the escrow contract.
#[contracttype]
pub enum Key {
    Admin,
    AgentRegistry,
    Oracle,
    Treasury,
    NextTransferId,
    Corridor(Symbol),
    Transfer(u64),
    TransferAgent(u64),
}

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Unauthorized = 1,
    NotInitialized = 2,
    CorridorNotFound = 3,
    TransferNotFound = 4,
    InvalidState = 5,
    RateNotLocked = 6,
    RateExpired = 7,
    AgentNotEligible = 8,
    CorridorAlreadySet = 9,
    BeforeDeadline = 10,
    AlreadyTerminal = 11,
}

/// Core settlement contract. One instance (or one logical transfer record)
/// per remittance (README "Smart Contracts > 1. corridor-escrow").
#[contract]
pub struct CorridorEscrow;

// (use core::result::Result explicitly so the SDK macro recognizes results)

#[contractimpl]
impl CorridorEscrow {
    /// Configure the contract's dependencies. `admin` doubles as the
    /// designated arbiter role for `dispute` (README "Security Model"), the
    /// `agent_registry` and `oracle` are the Day 2 contracts, and `treasury`
    /// receives the protocol fee on delivery.
    pub fn init(
        env: Env,
        admin: Address,
        agent_registry: Address,
        oracle: Address,
        treasury: Address,
    ) {
        if storage_get::<Address>(&env, &Key::Admin).is_some() {
            panic!("already initialized");
        }
        storage_set(&env, &Key::Admin, &admin);
        storage_set(&env, &Key::AgentRegistry, &agent_registry);
        storage_set(&env, &Key::Oracle, &oracle);
        storage_set(&env, &Key::Treasury, &treasury);
        storage_set(&env, &Key::NextTransferId, &1u64);
    }

    /// Register a corridor's fee schedule (protocol + agent bps) used by the
    /// fee splitter on delivery. Admin-gated.
    pub fn set_corridor(env: Env, corridor: Corridor) -> Result<(), Error> {
        admin(&env).require_auth();
        let key = Key::Corridor(corridor.id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::CorridorAlreadySet);
        }
        storage_set(&env, &key, &corridor);
        Ok(())
    }

    /// Start a remittance and return a new `transfer_id` (README "Smart
    /// Contracts > 1. corridor-escrow").
    pub fn initiate_transfer(
        env: Env,
        sender: Address,
        recipient: Address,
        corridor_id: Symbol,
        amount: i128,
        token: Address,
    ) -> Result<u64, Error> {
        sender.require_auth();

        let key = Key::Corridor(corridor_id.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::CorridorNotFound);
        }

        let next: u64 = storage_get(&env, &Key::NextTransferId).unwrap();
        storage_set(&env, &Key::NextTransferId, &(next + 1));

        transfer::create_transfer(
            &env,
            next,
            sender,
            recipient,
            corridor_id,
            amount,
            token,
            env.ledger().timestamp(),
        );
        Ok(next)
    }

    /// Call the rate-oracle-adapter, store the rate + expiry, return the
    /// locked rate. Only valid while the transfer is still `Locked`.
    pub fn lock_rate(env: Env, transfer_id: u64) -> Result<i128, Error> {
        let oracle: Address = storage_get(&env, &Key::Oracle).ok_or(Error::NotInitialized)?;
        let mut transfer = load(&env, transfer_id)?;
        require_status(&transfer, TransferStatus::Locked)?;

        let corridor = get_corridor(&env, &transfer.corridor_id)?;

        let args = soroban_sdk::vec![
            &env,
            corridor.base.into_val(&env),
            corridor.quote.into_val(&env),
        ];
        let value = env.invoke_contract::<RateValue>(
            &oracle,
            &Symbol::new(&env, "get_rate"),
            args,
        );

        transfer.locked_rate = Some(value.rate);
        transfer.rate_expiry = env.ledger().timestamp() + RATE_LOCK_WINDOW;
        transfer::save_transfer(&env, &transfer);
        Ok(value.rate)
    }

    /// Pull the stablecoin from the sender into escrow. Rejects a transfer
    /// that was never rate-locked or whose rate lock has expired.
    pub fn fund(env: Env, transfer_id: u64) -> Result<(), Error> {
        let mut transfer = load(&env, transfer_id)?;
        require_status(&transfer, TransferStatus::Locked)?;

        if transfer.locked_rate.is_none() {
            return Err(Error::RateNotLocked);
        }
        if env.ledger().timestamp() > transfer.rate_expiry {
            return Err(Error::RateExpired);
        }

        transfer.sender.require_auth();
        let token = TokenClient::new(&env, &transfer.token);
        token.transfer_from(
            &env.current_contract_address(),
            &transfer.sender,
            &env.current_contract_address(),
            &transfer.amount,
        );

        transfer.status = TransferStatus::Funded;
        // The delivery-window clock starts once funds are in escrow.
        transfer.delivery_deadline = env.ledger().timestamp() + DELIVERY_WINDOW;
        transfer::save_transfer(&env, &transfer);
        Ok(())
    }

    /// Query the agent-registry for a verified, active agent serving the
    /// transfer's corridor and assign the payout agent.
    pub fn assign_agent(env: Env, transfer_id: u64, agent_id: Address) -> Result<(), Error> {
        let registry: Address =
            storage_get(&env, &Key::AgentRegistry).ok_or(Error::NotInitialized)?;
        let mut transfer = load(&env, transfer_id)?;
        require_status(&transfer, TransferStatus::Funded)?;

        let corridor = get_corridor(&env, &transfer.corridor_id)?;
        let args = soroban_sdk::vec![&env, corridor.id.into_val(&env)];
        let agents: Vec<corridor_common::types::Agent> =
            env.invoke_contract(&registry, &Symbol::new(&env, "get_agents_for_corridor"), args);

        let eligible = agents.iter().any(|a| a.address == agent_id);
        if !eligible {
            return Err(Error::AgentNotEligible);
        }

        storage_set(&env, &Key::TransferAgent(transfer_id), &agent_id);
        transfer.status = TransferStatus::AgentAssigned;
        transfer::save_transfer(&env, &transfer);
        Ok(())
    }

    /// Validate the assigned agent's attestation, run the fee splitter, and
    /// release escrowed funds to recipient, agent, and treasury accordingly.
    pub fn confirm_delivery(env: Env, transfer_id: u64, _attestation_sig: BytesN<65>) -> Result<(), Error> {
        let mut transfer = load(&env, transfer_id)?;
        require_status(&transfer, TransferStatus::AgentAssigned)?;

        let agent: Address = storage_get(&env, &Key::TransferAgent(transfer_id))
            .ok_or(Error::InvalidState)?;
        // The assigned agent authorizes this call — this is the agent's
        // on-chain signature attesting to a completed payout. Unauthorized
        // callers (non-agents) are rejected by require_auth.
        agent.require_auth();

        let corridor = get_corridor(&env, &transfer.corridor_id)?;
        let split = fee_splitter::compute_split(&corridor, transfer.amount);
        let treasury: Address = storage_get(&env, &Key::Treasury).ok_or(Error::NotInitialized)?;

        let token = TokenClient::new(&env, &transfer.token);
        let from = env.current_contract_address();
        if split.recipient_amount > 0 {
            token.transfer(&from, &transfer.recipient, &split.recipient_amount);
        }
        if split.agent_fee > 0 {
            token.transfer(&from, &agent, &split.agent_fee);
        }
        if split.protocol_fee > 0 {
            token.transfer(&from, &treasury, &split.protocol_fee);
        }

        transfer.status = TransferStatus::Delivered;
        transfer::save_transfer(&env, &transfer);
        Ok(())
    }

    /// Refund undelivered funds to the sender once the delivery window has
    /// lapsed. Rejects any already-settled transfer (double-refund guard).
    pub fn refund(env: Env, transfer_id: u64) -> Result<(), Error> {
        let mut transfer = load(&env, transfer_id)?;

        if transfer.status != TransferStatus::Funded
            && transfer.status != TransferStatus::AgentAssigned
        {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() <= transfer.delivery_deadline {
            return Err(Error::BeforeDeadline);
        }

        transfer.sender.require_auth();
        let token = TokenClient::new(&env, &transfer.token);
        token.transfer(
            &env.current_contract_address(),
            &transfer.sender,
            &transfer.amount,
        );

        transfer.status = TransferStatus::Refunded;
        transfer::save_transfer(&env, &transfer);
        Ok(())
    }

    /// Escalate a contested transfer to the designated arbiter role
    /// (admin/multisig in MVP; README "Security Model"). Admin-gated.
    pub fn dispute(env: Env, transfer_id: u64) -> Result<(), Error> {
        admin(&env).require_auth();
        let mut transfer = load(&env, transfer_id)?;

        match transfer.status {
            TransferStatus::Delivered
            | TransferStatus::Refunded
            | TransferStatus::Disputed => return Err(Error::AlreadyTerminal),
            _ => {}
        }

        transfer.status = TransferStatus::Disputed;
        transfer::save_transfer(&env, &transfer);
        Ok(())
    }

    /// Read the current status of a transfer (test/UX helper).
    pub fn status(env: Env, transfer_id: u64) -> TransferStatus {
        load(&env, transfer_id).expect("transfer not found").status
    }
}

fn admin(env: &Env) -> Address {
    storage_get(env, &Key::Admin).expect("not initialized")
}

fn get_corridor(env: &Env, id: &Symbol) -> Result<Corridor, Error> {
    storage_get(env, &Key::Corridor(id.clone())).ok_or(Error::CorridorNotFound)
}

fn load(env: &Env, transfer_id: u64) -> Result<Transfer, Error> {
    if !env
        .storage()
        .persistent()
        .has(&transfer::TransferKey(transfer_id))
    {
        return Err(Error::TransferNotFound);
    }
    Ok(transfer::load_transfer(env, transfer_id))
}

fn require_status(transfer: &Transfer, expected: TransferStatus) -> Result<(), Error> {
    if transfer.status != expected {
        return Err(Error::InvalidState);
    }
    Ok(())
}

fn storage_set<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val> + Clone>(env: &Env, key: &Key, val: &V) {
    env.storage().persistent().set::<Key, V>(key, val);
}

fn storage_get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val> + Clone>(
    env: &Env,
    key: &Key,
) -> Option<V> {
    env.storage().persistent().get::<Key, V>(key)
}
