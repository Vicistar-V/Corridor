#![no_std]
#![allow(unexpected_cfgs)]

mod fee_splitter;
mod test;
mod transfer;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Symbol};

/// Core settlement contract. One instance (or one logical transfer record)
/// per remittance (README "Smart Contracts > 1. corridor-escrow").
///
/// Day 1 scaffold: signatures only, bodies are `todo!()` pending Day 3.
#[contract]
pub struct CorridorEscrow;

#[contractimpl]
impl CorridorEscrow {
    /// Start a remittance: chooses a corridor, amount and recipient.
    /// Returns a `transfer_id`.
    pub fn initiate_transfer(
        _env: Env,
        _sender: Address,
        _recipient: Address,
        _corridor_id: Symbol,
        _amount: i128,
        _token: Address,
    ) -> u64 {
        todo!()
    }

    /// Calls the Rate Oracle Adapter, stores the rate + expiry, and returns
    /// the locked rate (README: "stores rate + expiry").
    pub fn lock_rate(_env: Env, _transfer_id: u64) -> i128 {
        todo!()
    }

    /// Pulls the stablecoin from the sender into escrow (requires prior
    /// `approve`).
    pub fn fund(_env: Env, _transfer_id: u64) {
        todo!()
    }

    /// Queries the Agent Registry for eligibility and assigns a payout agent.
    pub fn assign_agent(_env: Env, _transfer_id: u64, _agent_id: Address) {
        todo!()
    }

    /// Validates the agent-signed attestation and releases escrowed funds.
    pub fn confirm_delivery(_env: Env, _transfer_id: u64, _attestation_sig: BytesN<65>) {
        todo!()
    }

    /// Callable by the sender after timeout if undelivered.
    pub fn refund(_env: Env, _transfer_id: u64) {
        todo!()
    }

    /// Escalates a contested transfer to the designated arbiter role.
    pub fn dispute(_env: Env, _transfer_id: u64) {
        todo!()
    }
}
