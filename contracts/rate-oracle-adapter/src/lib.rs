#![no_std]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Env, Symbol,
};

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateKey {
    pub base: Symbol,
    pub quote: Symbol,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateValue {
    pub rate: i128,
    pub timestamp: u64,
}

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    RateNotFound = 1,
    RateStale = 2,
    InvalidPair = 3,
}

const STALENESS_THRESHOLD: u64 = 300;

#[contract]
pub struct RateOracleAdapter;

#[contractimpl]
impl RateOracleAdapter {
    pub fn set_rate(env: Env, base: Symbol, quote: Symbol, rate: i128) {
        let key = RateKey { base, quote };
        let value = RateValue {
            rate,
            timestamp: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &value);
    }

    pub fn get_rate(env: Env, base: Symbol, quote: Symbol) -> Result<RateValue, Error> {
        let key = RateKey { base, quote };
        let value: RateValue = env.storage().persistent().get(&key).ok_or(Error::RateNotFound)?;

        let age = env.ledger().timestamp().saturating_sub(value.timestamp);
        if age > STALENESS_THRESHOLD {
            return Err(Error::RateStale);
        }

        Ok(value)
    }

    pub fn has_rate(env: Env, base: Symbol, quote: Symbol) -> bool {
        let key = RateKey { base, quote };
        env.storage().persistent().has(&key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Ledger, Env, Symbol};

    #[test]
    fn get_rate_normal() {
        let env = Env::default();
        let contract_id = env.register_contract(None, RateOracleAdapter);
        let client = RateOracleAdapterClient::new(&env, &contract_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });
        client.set_rate(&Symbol::new(&env, "USDC"), &Symbol::new(&env, "NGN"), &1_500);
        env.ledger().with_mut(|li| {
            li.timestamp = 1001;
        });
        let rate = client.get_rate(&Symbol::new(&env, "USDC"), &Symbol::new(&env, "NGN"));
        assert_eq!(rate.rate, 1_500);
    }

    #[test]
    fn get_rate_missing() {
        let env = Env::default();
        let contract_id = env.register_contract(None, RateOracleAdapter);
        let client = RateOracleAdapterClient::new(&env, &contract_id);

        assert!(!client.has_rate(&Symbol::new(&env, "USDC"), &Symbol::new(&env, "EUR")));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn get_rate_stale() {
        let env = Env::default();
        let contract_id = env.register_contract(None, RateOracleAdapter);
        let client = RateOracleAdapterClient::new(&env, &contract_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 1000;
        });
        client.set_rate(&Symbol::new(&env, "USDC"), &Symbol::new(&env, "NGN"), &1_500);
        env.ledger().with_mut(|li| {
            li.timestamp = 1400;
        });
        client.get_rate(&Symbol::new(&env, "USDC"), &Symbol::new(&env, "NGN"));
    }
}
