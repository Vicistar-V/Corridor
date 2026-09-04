#![allow(dead_code)]

use corridor_common::types::Transfer;
use soroban_sdk::{contracttype, Address, Env, Symbol};

/// Storage key for a single `Transfer` record, keyed by `transfer_id`.
#[contracttype]
pub struct TransferKey(pub u64);

/// Create a new `Transfer` record in `Locked` status and persist it.
pub fn create_transfer(
    env: &Env,
    transfer_id: u64,
    sender: Address,
    recipient: Address,
    corridor_id: Symbol,
    amount: i128,
    token: Address,
    created_at: u64,
) -> Transfer {
    let transfer = Transfer {
        transfer_id,
        sender,
        recipient,
        corridor_id,
        amount,
        token,
        locked_rate: None,
        status: corridor_common::types::TransferStatus::Locked,
        created_at,
        rate_expiry: 0,
        delivery_deadline: 0,
    };
    save_transfer(env, &transfer);
    transfer
}

pub fn load_transfer(env: &Env, transfer_id: u64) -> Transfer {
    if !env.storage().persistent().has(&TransferKey(transfer_id)) {
        panic!("transfer not found");
    }
    env.storage()
        .persistent()
        .get(&TransferKey(transfer_id))
        .unwrap()
}

pub fn save_transfer(env: &Env, transfer: &Transfer) {
    env.storage()
        .persistent()
        .set(&TransferKey(transfer.transfer_id), transfer);
}
