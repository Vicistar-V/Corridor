#![allow(dead_code)]

use corridor_common::types::Transfer;
use soroban_sdk::{Address, Symbol};

/// Transfer record storage helpers for corridor-escrow. One logical transfer
/// record per remittance (README "Smart Contracts > 1. corridor-escrow").
///
/// Day 1 scaffold: signatures only, bodies are `todo!()` pending Day 3.
pub fn create_transfer(
    _transfer_id: u64,
    _sender: Address,
    _recipient: Address,
    _corridor_id: Symbol,
    _amount: i128,
    _token: Address,
) -> Transfer {
    todo!()
}

pub fn load_transfer(_transfer_id: u64) -> Transfer {
    todo!()
}

pub fn save_transfer(_transfer: &Transfer) {
    todo!()
}
