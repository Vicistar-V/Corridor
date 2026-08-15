#![allow(dead_code)]

use corridor_common::types::Corridor;

/// Fee splitter / payout logic — shared library module imported by
/// `corridor-escrow`, not a separate deployed contract (README "Smart
/// Contracts > 4. fee-splitter"). Computes the split between protocol fee,
/// agent fee, and net recipient payout given a corridor's fee schedule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Split {
    pub protocol_fee: i128,
    pub agent_fee: i128,
    pub recipient_amount: i128,
}

pub fn compute_split(corridor: &Corridor, amount: i128) -> Split {
    let protocol_fee = (amount * corridor.protocol_fee_bps as i128) / 10_000;
    let agent_fee = (amount * corridor.agent_fee_bps as i128) / 10_000;
    let recipient_amount = amount - protocol_fee - agent_fee;
    Split {
        protocol_fee,
        agent_fee,
        recipient_amount,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Symbol;

    #[test]
    fn standard_split() {
        let env = soroban_sdk::Env::default();
        let corridor = Corridor {
            id: Symbol::new(&env, "USNG"),
            base: Symbol::new(&env, "USDC"),
            quote: Symbol::new(&env, "NGN"),
            protocol_fee_bps: 100,
            agent_fee_bps: 200,
        };
        let split = compute_split(&corridor, 1_000);
        assert_eq!(split.protocol_fee, 10);
        assert_eq!(split.agent_fee, 20);
        assert_eq!(split.recipient_amount, 970);
    }

    #[test]
    fn zero_amount_split() {
        let env = soroban_sdk::Env::default();
        let corridor = Corridor {
            id: Symbol::new(&env, "USNG"),
            base: Symbol::new(&env, "USDC"),
            quote: Symbol::new(&env, "NGN"),
            protocol_fee_bps: 50,
            agent_fee_bps: 50,
        };
        let split = compute_split(&corridor, 0);
        assert_eq!(split.protocol_fee, 0);
        assert_eq!(split.agent_fee, 0);
        assert_eq!(split.recipient_amount, 0);
    }

    #[test]
    fn rounding_down_split() {
        let env = soroban_sdk::Env::default();
        let corridor = Corridor {
            id: Symbol::new(&env, "USNG"),
            base: Symbol::new(&env, "USDC"),
            quote: Symbol::new(&env, "NGN"),
            protocol_fee_bps: 333,
            agent_fee_bps: 333,
        };
        let split = compute_split(&corridor, 1);
        assert_eq!(split.protocol_fee, 0);
        assert_eq!(split.agent_fee, 0);
        assert_eq!(split.recipient_amount, 1);
    }
}
