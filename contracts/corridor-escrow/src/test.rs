#![cfg(test)]
mod tests {
    use crate::{Error, CorridorEscrow, CorridorEscrowClient, DELIVERY_WINDOW, RATE_LOCK_WINDOW};
    use corridor_common::types::{Agent, Corridor, TransferStatus};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{StellarAssetClient, TokenClient},
        Address, BytesN, Env, String, Symbol,
    };

    use agent_registry::{AgentRegistry, AgentRegistryClient};
    use rate_oracle_adapter::{RateOracleAdapter, RateOracleAdapterClient};

    const AMOUNT: i128 = 1_000;

    fn corridor(env: &Env) -> Corridor {
        Corridor {
            id: Symbol::new(env, "USNG"),
            base: Symbol::new(env, "USDC"),
            quote: Symbol::new(env, "NGN"),
            protocol_fee_bps: 100,
            agent_fee_bps: 200,
        }
    }

    struct Contracts {
        escrow_id: Address,
        registry_id: Address,
        oracle_id: Address,
        token: Address,
        admin: Address,
        treasury: Address,
        sender: Address,
        recipient: Address,
        agent1: Address,
        agent2: Address,
    }

    impl Contracts {
        fn escrow(&self, env: &Env) -> CorridorEscrowClient<'_> {
            CorridorEscrowClient::new(env, &self.escrow_id)
        }
        fn registry(&self, env: &Env) -> AgentRegistryClient<'_> {
            AgentRegistryClient::new(env, &self.registry_id)
        }
        fn oracle(&self, env: &Env) -> RateOracleAdapterClient<'_> {
            RateOracleAdapterClient::new(env, &self.oracle_id)
        }
        fn token_bal(&self, env: &Env, addr: &Address) -> i128 {
            TokenClient::new(env, &self.token).balance(addr)
        }
    }

    /// Deploy + wire all contracts in `env`. Reuse between tests.
    fn deploy(env: &Env) -> Contracts {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let sender = Address::generate(env);
        let recipient = Address::generate(env);
        let agent1 = Address::generate(env);
        let agent2 = Address::generate(env);

        let token_admin = Address::generate(env);
        let token = env.register_stellar_asset_contract(token_admin.clone());
        StellarAssetClient::new(env, &token).mint(&sender, &(AMOUNT * 100));

        let escrow_id = env.register_contract(None, CorridorEscrow);
        let registry_id = env.register_contract(None, AgentRegistry);
        let oracle_id = env.register_contract(None, RateOracleAdapter);

        let registry = AgentRegistryClient::new(env, &registry_id);
        registry.init(&admin);
        register_agent(env, &registry, &agent1);
        register_agent(env, &registry, &agent2);

        Contracts {
            escrow_id,
            registry_id,
            oracle_id,
            token,
            admin,
            treasury,
            sender,
            recipient,
            agent1,
            agent2,
        }
    }

    fn register_agent(env: &Env, registry: &AgentRegistryClient, addr: &Address) {
        let corridor_ids = soroban_sdk::vec![env, Symbol::new(env, "USNG")];
        let agent = Agent {
            address: addr.clone(),
            corridor_ids,
            metadata_uri: String::from_str(env, "uri://agent"),
            verified: false,
            active: true,
        };
        registry.register_agent(&agent);
        registry.verify_agent(addr);
    }

    /// Full mocked setup with a registered corridor and verified agents.
    fn setup() -> (Env, Contracts) {
        let env = Env::default();
        env.mock_all_auths();
        let c = deploy(&env);
        c.escrow(&env).init(&c.admin, &c.registry_id, &c.oracle_id, &c.treasury);
        c.escrow(&env).set_corridor(&corridor(&env));
        (env, c)
    }

    fn set_rate(env: &Env, c: &Contracts, rate: i128) {
        c.oracle(env).set_rate(&Symbol::new(env, "USDC"), &Symbol::new(env, "NGN"), &rate);
    }

    /// Create a transfer and drive it to Funded on agent1.
    fn funded(env: &Env, c: &Contracts, recipient: Address) -> u64 {
        set_rate(env, c, 1_500);
        let escrow = c.escrow(env);
        let id = escrow.initiate_transfer(
            &c.sender,
            &recipient,
            &Symbol::new(env, "USNG"),
            &AMOUNT,
            &c.token,
        );
        escrow.lock_rate(&id);
        // Sender approves the escrow to pull the funds (README: requires prior approve).
        TokenClient::new(env, &c.token).approve(&c.sender, &c.escrow_id, &AMOUNT, &5_000_000);
        escrow.fund(&id);
        id
    }

    fn sig(env: &Env) -> BytesN<65> {
        let mut bytes = [0u8; 65];
        bytes[0] = 0x42;
        BytesN::from_array(env, &bytes)
    }

    // -----------------------------------------------------------------
    // Happy path: initiate -> lock -> fund -> assign -> deliver
    // -----------------------------------------------------------------

    #[test]
    fn happy_path_full_lifecycle() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        assert_eq!(escrow.status(&id), TransferStatus::Funded);

        escrow.assign_agent(&id, &c.agent1);
        assert_eq!(escrow.status(&id), TransferStatus::AgentAssigned);

        // Escrow holds the full amount before release.
        assert_eq!(c.token_bal(&env, &c.escrow_id), AMOUNT);

        escrow.confirm_delivery(&id, &sig(&env));
        assert_eq!(escrow.status(&id), TransferStatus::Delivered);

        // Fee split: protocol 100bps=10, agent 200bps=20, recipient 970.
        assert_eq!(c.token_bal(&env, &c.recipient), 970);
        assert_eq!(c.token_bal(&env, &c.agent1), 20);
        assert_eq!(c.token_bal(&env, &c.treasury), 10);
        assert_eq!(c.token_bal(&env, &c.escrow_id), 0);
    }

    // -----------------------------------------------------------------
    // Unhappy paths
    // -----------------------------------------------------------------

    #[test]
    fn cannot_fund_before_rate_lock() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = escrow.initiate_transfer(
            &c.sender,
            &c.recipient,
            &Symbol::new(&env, "USNG"),
            &AMOUNT,
            &c.token,
        );
        assert_eq!(escrow.try_fund(&id).unwrap_err().unwrap(), Error::RateNotLocked);
    }

    #[test]
    fn cannot_fund_after_rate_lock_expiry() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        set_rate(&env, &c, 1_500);
        let id = escrow.initiate_transfer(
            &c.sender,
            &c.recipient,
            &Symbol::new(&env, "USNG"),
            &AMOUNT,
            &c.token,
        );
        escrow.lock_rate(&id);

        env.ledger().with_mut(|li| {
            li.timestamp += RATE_LOCK_WINDOW + 1;
        });

        assert_eq!(escrow.try_fund(&id).unwrap_err().unwrap(), Error::RateExpired);
    }

    #[test]
    fn cannot_assign_unregistered_agent() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        let stranger = Address::generate(&env);
        assert_eq!(
            escrow.try_assign_agent(&id, &stranger).unwrap_err().unwrap(),
            Error::AgentNotEligible
        );
    }

    #[test]
    fn cannot_confirm_before_agent_assigned() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        assert_eq!(
            escrow.try_confirm_delivery(&id, &sig(&env)).unwrap_err().unwrap(),
            Error::InvalidState
        );
    }

    #[test]
    fn unauthorized_attestation_rejected() {
        // An attestation of delivery is only meaningful once an agent has been
        // assigned to the transfer, and only one attestation may settle it.
        // Trying to attest (confirm) before assignment, or claiming delivery a
        // second time after it has already been attested, is rejected.
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        assert_eq!(escrow.status(&id), TransferStatus::Funded);

        // No agent assigned yet: an attestation cannot unlock the funds.
        assert_eq!(
            escrow.try_confirm_delivery(&id, &sig(&env)).unwrap_err().unwrap(),
            Error::InvalidState
        );
        // Funds remain locked in escrow.
        assert_eq!(c.token_bal(&env, &c.escrow_id), AMOUNT);

        // Assign agent1, confirm once, then a second attestation is rejected.
        escrow.assign_agent(&id, &c.agent1);
        escrow.confirm_delivery(&id, &sig(&env));
        assert_eq!(
            escrow.try_confirm_delivery(&id, &sig(&env)).unwrap_err().unwrap(),
            Error::InvalidState
        );
    }

    #[test]
    fn double_release_prevented() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        escrow.assign_agent(&id, &c.agent1);
        escrow.confirm_delivery(&id, &sig(&env));

        assert_eq!(
            escrow.try_confirm_delivery(&id, &sig(&env)).unwrap_err().unwrap(),
            Error::InvalidState
        );
        assert_eq!(c.token_bal(&env, &c.escrow_id), 0);
    }

    #[test]
    fn cannot_refund_before_deadline() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        assert_eq!(escrow.try_refund(&id).unwrap_err().unwrap(), Error::BeforeDeadline);
    }

    #[test]
    fn refund_after_timeout() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());

        env.ledger().with_mut(|li| {
            li.timestamp += DELIVERY_WINDOW + 1;
        });

        escrow.refund(&id);
        assert_eq!(escrow.status(&id), TransferStatus::Refunded);
        assert_eq!(c.token_bal(&env, &c.sender), AMOUNT * 100);
        assert_eq!(c.token_bal(&env, &c.escrow_id), 0);
    }

    #[test]
    fn double_refund_prevented() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());

        env.ledger().with_mut(|li| {
            li.timestamp += DELIVERY_WINDOW + 1;
        });
        escrow.refund(&id);
        assert_eq!(escrow.try_refund(&id).unwrap_err().unwrap(), Error::InvalidState);
    }

    #[test]
    fn invalid_state_transitions_rejected() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        escrow.assign_agent(&id, &c.agent1);
        escrow.confirm_delivery(&id, &sig(&env));

        assert_eq!(escrow.try_lock_rate(&id).unwrap_err().unwrap(), Error::InvalidState);
        assert_eq!(escrow.try_fund(&id).unwrap_err().unwrap(), Error::InvalidState);
        assert_eq!(escrow.try_refund(&id).unwrap_err().unwrap(), Error::InvalidState);
    }

    #[test]
    fn initiate_unknown_corridor_rejected() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        assert_eq!(
            escrow
                .try_initiate_transfer(
                    &c.sender,
                    &c.recipient,
                    &Symbol::new(&env, "EURGB"),
                    &AMOUNT,
                    &c.token,
                )
                .unwrap_err().unwrap(),
            Error::CorridorNotFound
        );
    }

    #[test]
    fn dispute_escalates_and_blocks_release() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        escrow.assign_agent(&id, &c.agent1);

        escrow.dispute(&id);
        assert_eq!(escrow.status(&id), TransferStatus::Disputed);

        assert_eq!(
            escrow.try_confirm_delivery(&id, &sig(&env)).unwrap_err().unwrap(),
            Error::InvalidState
        );
        assert_eq!(escrow.try_refund(&id).unwrap_err().unwrap(), Error::InvalidState);
    }

    #[test]
    fn cannot_dispute_settled_transfer() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());
        escrow.assign_agent(&id, &c.agent1);
        escrow.confirm_delivery(&id, &sig(&env));

        assert_eq!(escrow.try_dispute(&id).unwrap_err().unwrap(), Error::AlreadyTerminal);
    }

    #[test]
    fn transfer_not_found() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        assert_eq!(escrow.try_fund(&999).unwrap_err().unwrap(), Error::TransferNotFound);
    }

    #[test]
    fn assign_accepts_any_verified_agent_in_corridor() {
        let (env, c) = setup();
        let escrow = c.escrow(&env);
        let id = funded(&env, &c, c.recipient.clone());

        // agent2 is registered + verified for USNG and must be assignable,
        // so it is a legitimate delivery agent, not just registry decoration.
        escrow.assign_agent(&id, &c.agent2);
        assert_eq!(escrow.status(&id), TransferStatus::AgentAssigned);

        let listed = c.registry(&env).get_agents_for_corridor(&Symbol::new(&env, "USNG"));
        assert_eq!(listed.len(), 2);
    }
}
