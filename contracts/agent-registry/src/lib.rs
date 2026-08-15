#![no_std]
#![allow(unexpected_cfgs)]

use corridor_common::types::Agent;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentKey(pub Address);

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorridorAgents(pub Symbol);

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminKey(pub Symbol);

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Unauthorized = 1,
    AgentAlreadyRegistered = 2,
    AgentNotFound = 3,
    AgentNotVerified = 4,
    AgentDeactivated = 5,
}

#[contract]
pub struct AgentRegistry;

#[contractimpl]
impl AgentRegistry {
    pub fn init(env: Env, admin: Address) {
        env.storage()
            .persistent()
            .set(&AdminKey(Symbol::new(&env, "admin")), &admin);
    }

    pub fn register_agent(env: Env, agent: Agent) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&AdminKey(Symbol::new(&env, "admin")))
            .expect("admin not set");
        admin.require_auth();

        let key = AgentKey(agent.address.clone());

        if env.storage().persistent().has(&key) {
            return Err(Error::AgentAlreadyRegistered);
        }

        env.storage().persistent().set(&key, &agent);

        for corridor in agent.corridor_ids.iter() {
            let mut list: Vec<Address> = env
                .storage()
                .persistent()
                .get(&CorridorAgents(corridor.clone()))
                .unwrap_or(Vec::new(&env));
            list.push_back(agent.address.clone());
            env.storage()
                .persistent()
                .set(&CorridorAgents(corridor.clone()), &list);
        }

        Ok(())
    }

    pub fn verify_agent(env: Env, agent_address: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&AdminKey(Symbol::new(&env, "admin")))
            .expect("admin not set");
        admin.require_auth();

        let key = AgentKey(agent_address.clone());
        let mut agent: Agent = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::AgentNotFound)?;

        agent.verified = true;
        env.storage().persistent().set(&key, &agent);

        Ok(())
    }

    pub fn deactivate_agent(env: Env, agent_address: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&AdminKey(Symbol::new(&env, "admin")))
            .expect("admin not set");
        admin.require_auth();

        let key = AgentKey(agent_address.clone());
        let mut agent: Agent = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::AgentNotFound)?;

        agent.active = false;
        env.storage().persistent().set(&key, &agent);

        Ok(())
    }

    pub fn get_agents_for_corridor(env: Env, corridor_id: Symbol) -> Vec<Agent> {
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&CorridorAgents(corridor_id))
            .unwrap_or(Vec::new(&env));

        let mut result = Vec::new(&env);
        for addr in list.iter() {
            let key = AgentKey(addr.clone());
            if let Some(agent) = env.storage().persistent().get::<AgentKey, Agent>(&key) {
                if agent.verified && agent.active {
                    result.push_back(agent);
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, String, Symbol};

    fn setup() -> (Env, Address, Agent, Address) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, AgentRegistry);

        let mut corridor_ids = Vec::new(&env);
        corridor_ids.push_back(Symbol::new(&env, "USNG"));
        let agent = Agent {
            address: Address::generate(&env),
            corridor_ids,
            metadata_uri: String::from_str(&env, "uri://agent1"),
            verified: false,
            active: true,
        };
        (env, admin, agent, contract_id)
    }

    #[test]
    fn register_and_get_agents() {
        let (env, admin, agent, contract_id) = setup();
        env.mock_all_auths();
        let client = AgentRegistryClient::new(&env, &contract_id);

        client.init(&admin);
        client.register_agent(&agent);

        let list = client.get_agents_for_corridor(&Symbol::new(&env, "USNG"));
        assert_eq!(list.len(), 0);
    }

    #[test]
    fn verify_agent() {
        let (env, admin, agent, contract_id) = setup();
        env.mock_all_auths();
        let client = AgentRegistryClient::new(&env, &contract_id);

        client.init(&admin);
        client.register_agent(&agent);
        client.verify_agent(&agent.address);

        let list = client.get_agents_for_corridor(&Symbol::new(&env, "USNG"));
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn deactivate_agent() {
        let (env, admin, agent, contract_id) = setup();
        env.mock_all_auths();
        let client = AgentRegistryClient::new(&env, &contract_id);

        client.init(&admin);
        client.register_agent(&agent);
        client.verify_agent(&agent.address);
        client.deactivate_agent(&agent.address);

        let list = client.get_agents_for_corridor(&Symbol::new(&env, "USNG"));
        assert_eq!(list.len(), 0);
    }
}
