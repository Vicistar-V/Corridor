#![allow(dead_code)]

use corridor_common::types::Corridor;

/// Fee splitter / payout logic — shared library module imported by
/// `corridor-escrow`, not a separate deployed contract (README "Smart
/// Contracts > 4. fee-splitter"). Computes the split between protocol fee,
/// agent fee, and net recipient payout given a corridor's fee schedule.
///
/// Day 1 scaffold: signature only, body is `todo!()` pending Day 3.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Split {
    pub protocol_fee: i128,
    pub agent_fee: i128,
    pub recipient_amount: i128,
}

pub fn compute_split(_corridor: &Corridor, _amount: i128) -> Split {
    todo!()
}
