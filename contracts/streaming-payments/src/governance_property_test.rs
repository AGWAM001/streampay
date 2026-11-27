//! Fixed-seed lifecycle properties for governance proposals.
#![cfg(test)]

extern crate std;

use std::format;
use std::vec::Vec as StdVec;

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestRunner};
use soroban_sdk::{testutils::Address as _, Address, Vec};

use crate::test::Fixture;
use crate::{GovernanceAction, MAX_FEE_BPS, REQUIRED_SIGNATURES, ROTATION_WINDOW_MULTIPLIER};

const WINDOW: u64 = crate::DEFAULT_VETO_WINDOW_SECONDS;
const KEY_COUNT: usize = 4;

struct ProposalModel {
    id: u64,
    executable_at: u64,
    rotation_to: Option<StdVec<usize>>,
    signers: StdVec<usize>,
    vetoed: bool,
    executed: bool,
}

fn contract_addresses(env: &soroban_sdk::Env, signers: &[Address]) -> Vec<Address> {
    let mut addresses = Vec::new(env);
    for signer in signers {
        addresses.push_back(signer.clone());
    }
    addresses
}

fn current_addresses(keys: &[Address], current: &[usize]) -> StdVec<Address> {
    current.iter().map(|&index| keys[index].clone()).collect()
}

fn selected_signers(mask: u8) -> StdVec<usize> {
    let selected: StdVec<_> = (0..KEY_COUNT)
        .filter(|&index| mask & (1 << index) != 0)
        .collect();
    if selected.len() >= 2 {
        selected
    } else {
        std::vec![0, 1]
    }
}

fn run_governance_sequence(seed: u64, steps: &[(u8, u8, u8, u16)]) -> Result<(), TestCaseError> {
    let f = Fixture::setup_quiet();
    let keys: StdVec<_> = (0..KEY_COUNT).map(|_| Address::generate(&f.env)).collect();
    let mut current = std::vec![0, 1];
    f.client.mock_all_auths().governance_bootstrap(
        &f.governor,
        &contract_addresses(&f.env, &current_addresses(&keys, &current)),
        &WINDOW,
    );

    let mut proposals = StdVec::<ProposalModel>::new();
    for (step_index, &(operation, selector, signer_mask, time_delta)) in steps.iter().enumerate() {
        let context =
            format!("seed {seed:#x}, step {step_index}, operation {operation}, sequence {steps:?}");
        match operation % 7 {
            0 => {
                let proposer = current[selector as usize % current.len()];
                let id = f.client.mock_all_auths().governance_propose(
                    &keys[proposer],
                    &GovernanceAction::SetFeeBps(time_delta as u32 % (MAX_FEE_BPS + 1)),
                );
                let now = f.env.ledger().timestamp();
                proposals.push(ProposalModel {
                    id,
                    executable_at: now + WINDOW,
                    rotation_to: None,
                    signers: StdVec::new(),
                    vetoed: false,
                    executed: false,
                });
            }
            1 => {
                let proposer = current[selector as usize % current.len()];
                let rotation_to = selected_signers(signer_mask);
                let candidate = current_addresses(&keys, &rotation_to);
                let id = f.client.mock_all_auths().governance_propose(
                    &keys[proposer],
                    &GovernanceAction::SetSigners(contract_addresses(&f.env, &candidate)),
                );
                let now = f.env.ledger().timestamp();
                proposals.push(ProposalModel {
                    id,
                    executable_at: now + WINDOW * ROTATION_WINDOW_MULTIPLIER,
                    rotation_to: Some(rotation_to),
                    signers: StdVec::new(),
                    vetoed: false,
                    executed: false,
                });
            }
            2 if !proposals.is_empty() => {
                let index = selector as usize % proposals.len();
                let id = proposals[index].id;
                let attempted: StdVec<_> = current
                    .iter()
                    .copied()
                    .filter(|&key| signer_mask & (1 << key) != 0)
                    .collect();
                for key in attempted {
                    let should_sign = !proposals[index].executed
                        && !proposals[index].vetoed
                        && !proposals[index].signers.contains(&key);
                    let result = f
                        .client
                        .mock_all_auths()
                        .try_governance_sign(&keys[key], &id);
                    prop_assert_eq!(result.is_ok(), should_sign, "{}", context);
                    if should_sign {
                        proposals[index].signers.push(key);
                    }
                }
            }
            3 if !proposals.is_empty() => {
                let index = selector as usize % proposals.len();
                let proposal = &proposals[index];
                let required = if proposal.rotation_to.is_some() {
                    1
                } else {
                    REQUIRED_SIGNATURES as usize
                };
                let live_signatures = proposal
                    .signers
                    .iter()
                    .filter(|key| current.contains(key))
                    .count();
                let should_execute = !proposal.executed
                    && !proposal.vetoed
                    && f.env.ledger().timestamp() >= proposal.executable_at
                    && live_signatures >= required;
                let id = proposal.id;
                let result = f
                    .client
                    .mock_all_auths()
                    .try_governance_execute(&Address::generate(&f.env), &id);
                prop_assert_eq!(result.is_ok(), should_execute, "{}", context);
                if should_execute {
                    proposals[index].executed = true;
                    if let Some(rotation) = &proposals[index].rotation_to {
                        current = rotation.clone();
                    }
                }
            }
            4 if !proposals.is_empty() => {
                let index = selector as usize % proposals.len();
                let signer = current[signer_mask as usize % current.len()];
                let should_veto = !proposals[index].executed
                    && !proposals[index].vetoed
                    && f.env.ledger().timestamp() < proposals[index].executable_at;
                let result = f
                    .client
                    .mock_all_auths()
                    .try_governance_veto(&keys[signer], &proposals[index].id);
                prop_assert_eq!(result.is_ok(), should_veto, "{}", context);
                if should_veto {
                    proposals[index].vetoed = true;
                }
            }
            5 => {
                let delta = time_delta as u64 % (WINDOW * 2 + 1);
                f.advance_time(delta);
            }
            6 if !proposals.is_empty() => {
                // Maturity closes the veto window but does not void the proposal.
                let index = selector as usize % proposals.len();
                let now = f.env.ledger().timestamp();
                if now < proposals[index].executable_at {
                    f.advance_time(proposals[index].executable_at - now + (time_delta as u64 % 3));
                }
                let signer = current[signer_mask as usize % current.len()];
                let result = f
                    .client
                    .mock_all_auths()
                    .try_governance_veto(&keys[signer], &proposals[index].id);
                prop_assert!(
                    !result.is_ok(),
                    "{}: veto succeeded after maturity",
                    context
                );
            }
            _ => {}
        }

        let client = f.client.mock_all_auths();
        prop_assert_eq!(
            client.governance_signers(),
            contract_addresses(&f.env, &current_addresses(&keys, &current)),
            "{}: current signer set diverged",
            context
        );
        for proposal in &proposals {
            let record = client
                .governance_proposal(&proposal.id)
                .expect("model proposal must exist");
            prop_assert_eq!(record.executed, proposal.executed, "{}", context);
            prop_assert_eq!(record.vetoed, proposal.vetoed, "{}", context);
            prop_assert_eq!(record.executable_at, proposal.executable_at, "{}", context);
            prop_assert_eq!(
                record.signers,
                contract_addresses(&f.env, &current_addresses(&keys, &proposal.signers)),
                "{}: recorded signatures diverged",
                context
            );
            if record.executed {
                prop_assert!(!record.vetoed, "{}: vetoed proposal executed", context);
                prop_assert!(
                    f.env.ledger().timestamp() >= record.executable_at,
                    "{}: proposal executed before its delay",
                    context
                );
            }
        }
    }
    Ok(())
}

#[test]
fn property_governance_lifecycle_sequences_preserve_timelock_invariants() {
    const SEEDS: [u64; 3] = [0x60A7_1101, 0x60A7_1102, 0x60A7_1103];
    const CASES_PER_SEED: u32 = 12;

    let sequence = proptest::collection::vec(any::<(u8, u8, u8, u16)>(), 1..33);
    for seed in SEEDS {
        let mut runner = TestRunner::new(ProptestConfig {
            cases: CASES_PER_SEED,
            rng_seed: RngSeed::Fixed(seed),
            ..ProptestConfig::default()
        });
        if let Err(error) = runner.run(&sequence, |steps| run_governance_sequence(seed, &steps)) {
            panic!("governance lifecycle property failed with seed {seed:#x}: {error}");
        }
    }
}
