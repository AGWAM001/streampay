//! Differential tests: Wasm contract execution vs reference model.
//!
//! Executes all seeded unit test scenarios against both sides, verifies roundtrip
//! seed persistence, and demonstrates that the differential oracle catches intentional
//! model divergences.
#![cfg(test)]

extern crate std;
use std::format;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::println;
use std::vec;
use std::vec::Vec;

use soroban_sdk::{testutils::Address as _, Address, Env, Vec as SdkVec};
use streampay_model::{
    streamed_at_rate_schedule, streamed_at_schedule, ModelError, ModelRateSegment,
};
use crate::{
    streamed_amount_at_segments, RateSegment, Stream, StreamError, StreamStatus,
};

use streampay_model::seeds::{
    all_seeded_scenarios, seed_cancel_by_sender, seed_create_and_linear_withdraw,
    seed_protocol_fees_and_treasury_withdraw,
};
use streampay_model::ActionSequence;

use crate::differential_harness::DifferentialHarness;

#[test]
fn differential_test_all_unit_test_seeded_scenarios() {
    for (name, sequence) in all_seeded_scenarios() {
        let mut harness = DifferentialHarness::new();
        harness.execute_sequence(&sequence.actions);
        println!(
            "Differential scenario passed: {name} ({} actions)",
            sequence.actions.len()
        );
    }
}

#[test]
fn generate_and_verify_seed_corpus_files() {
    let corpus_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fuzz")
        .join("corpus")
        .join("differential");

    fs::create_dir_all(&corpus_dir).expect("failed to create corpus dir");

    for (name, sequence) in all_seeded_scenarios() {
        let bytes = sequence.to_bytes();
        let file_path = corpus_dir.join(format!("seed_{name}"));
        fs::write(&file_path, &bytes).expect("failed to write seed file");

        // Verify roundtrip decoding and execution
        let decoded = ActionSequence::from_bytes(&bytes).expect("failed to decode seed");
        assert_eq!(decoded, sequence, "decoded seed mismatch for {name}");

        let mut harness = DifferentialHarness::new();
        harness.execute_sequence(&decoded.actions);
    }
}

#[test]
fn demonstrate_intentional_accrual_divergence_caught() {
    let mut harness = DifferentialHarness::new();
    // Temporarily break the model by introducing an off-by-one in accrual math (+1 token)
    harness.model.mutations.break_accrual_add_one = true;

    let seq = seed_create_and_linear_withdraw();
    let result = catch_unwind(AssertUnwindSafe(|| {
        harness.execute_sequence(&seq.actions);
    }));

    assert!(
        result.is_err(),
        "Harness MUST catch intentional accrual divergence"
    );
    println!("SUCCESS: Intentional accrual divergence was caught by the differential harness!");
}

#[test]
fn demonstrate_intentional_fee_divergence_caught() {
    let mut harness = DifferentialHarness::new();
    // Temporarily break the model by introducing an off-by-one in protocol fee calculation (+1 token)
    harness.model.mutations.break_fee_math_add_one = true;

    let seq = seed_protocol_fees_and_treasury_withdraw();
    let result = catch_unwind(AssertUnwindSafe(|| {
        harness.execute_sequence(&seq.actions);
    }));

    assert!(
        result.is_err(),
        "Harness MUST catch intentional fee calculation divergence"
    );
    println!(
        "SUCCESS: Intentional fee calculation divergence was caught by the differential harness!"
    );
}

#[test]
fn demonstrate_intentional_cancel_split_divergence_caught() {
    let mut harness = DifferentialHarness::new();
    // Temporarily break the model by shortchanging the sender refund by 1 token
    harness.model.mutations.break_cancel_sender_refund_sub_one = true;

    let seq = seed_cancel_by_sender();
    let result = catch_unwind(AssertUnwindSafe(|| {
        harness.execute_sequence(&seq.actions);
    }));

    assert!(
        result.is_err(),
        "Harness MUST catch intentional cancel refund divergence"
    );
    println!(
        "SUCCESS: Intentional cancel split divergence was caught by the differential harness!"
    );
}

/// Seeded deterministic matrix for piecewise rate schedules (Issue #475).
/// Generates varied schedules across segment counts, boundary placements,
/// and rate deltas up/down, including all degenerate cases, asserting
/// exact parity between the contract and the reference model at and between boundaries.
#[test]
fn differential_matrix_for_piecewise_rate_schedules() {
    let env = Env::default();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    // Deterministic PRNG with committed seed for reproducibility
    const SEED: u64 = 0x53545245414d5059; // "STREAMPY"
    struct DeterministicRng {
        state: u64,
    }
    impl DeterministicRng {
        fn new(seed: u64) -> Self {
            Self { state: seed }
        }
        fn next_u64(&mut self) -> u64 {
            self.state ^= self.state << 13;
            self.state ^= self.state >> 7;
            self.state ^= self.state << 17;
            self.state
        }
        fn next_range(&mut self, min: u64, max: u64) -> u64 {
            if min >= max {
                min
            } else {
                min + (self.next_u64() % (max - min + 1))
            }
        }
    }
    let mut rng = DeterministicRng::new(SEED);

    struct TestSchedule {
        name: &'static str,
        segments: Vec<(u64, u64, i128, u64)>, // (start, end, allocation, basis)
        exact_rate: Option<Vec<(u64, u64, i128)>>,
    }

    let mut test_cases: Vec<TestSchedule> = Vec::new();

    // Degenerate case 1: Single segment
    test_cases.push(TestSchedule {
        name: "degenerate: single segment",
        segments: vec![(1000, 2000, 500_000, 1000)],
        exact_rate: Some(vec![(1000, 2000, 500)]),
    });

    // Degenerate case 2: Zero-length segment (start == end)
    test_cases.push(TestSchedule {
        name: "degenerate: zero-length segment",
        segments: vec![
            (1000, 1500, 250_000, 500),
            (1500, 1500, 0, 1),
            (1500, 2000, 250_000, 500),
        ],
        exact_rate: None,
    });

    // Degenerate case 3: Adjacent equal rates
    test_cases.push(TestSchedule {
        name: "degenerate: adjacent equal rates",
        segments: vec![
            (1000, 1500, 250_000, 500),
            (1500, 2000, 250_000, 500),
        ],
        exact_rate: Some(vec![
            (1000, 1500, 500),
            (1500, 2000, 500),
        ]),
    });

    // Degenerate case 4: Rate decrease (models accept_rate_decrease.txt: 5000 down to 500)
    test_cases.push(TestSchedule {
        name: "degenerate: steep rate decrease (accept_rate_decrease)",
        segments: vec![
            (1000, 2000, 5_000_000, 1000), // rate 5000
            (2000, 4000, 1_000_000, 2000), // rate 500
        ],
        exact_rate: Some(vec![
            (1000, 2000, 5000),
            (2000, 4000, 500),
        ]),
    });

    // Generate 64 seeded random schedules varying count, boundary placement, and rates
    for _ in 0..64 {
        let seg_count = (rng.next_range(1, 8)) as usize;
        let mut cur_time = rng.next_range(500, 2000);
        let mut segs = Vec::new();
        let mut exact_rates = Vec::new();
        let mut all_exact = true;

        for _ in 0..seg_count {
            let start = cur_time;
            let length = rng.next_range(10, 500);
            let end = start + length;
            // Vary rates: increase, decrease, or equal
            let rate = (rng.next_range(10, 2000)) as i128;
            let exact = (rng.next_u64() % 3) != 0; // 66% exact
            let (alloc, basis) = if exact {
                exact_rates.push((start, end, rate));
                (rate * length as i128, length)
            } else {
                all_exact = false;
                let random_basis = rng.next_range(1, 1000);
                let random_alloc = (rng.next_range(100, 1_000_000)) as i128;
                (random_alloc, random_basis)
            };

            segs.push((start, end, alloc, basis));
            let gap = if (rng.next_u64() % 4) == 0 { rng.next_range(1, 50) } else { 0 };
            cur_time = end + gap;
        }

        test_cases.push(TestSchedule {
            name: "seeded random schedule",
            segments: segs,
            exact_rate: if all_exact { Some(exact_rates) } else { None },
        });
    }

    println!("Running differential matrix across {} piecewise schedules...", test_cases.len());

    for (case_idx, tc) in test_cases.iter().enumerate() {
        let mut contract_segments: SdkVec<RateSegment> = SdkVec::new(&env);
        let mut model_segments: Vec<ModelRateSegment> = Vec::new();
        let mut deposit: i128 = 0;
        let mut min_start = u64::MAX;
        let mut max_end = 0u64;

        for &(start_time, end_time, allocation, basis_seconds) in &tc.segments {
            contract_segments.push_back(RateSegment {
                start_time,
                end_time,
                allocation,
                basis_seconds,
            });
            model_segments.push(ModelRateSegment {
                start_time,
                end_time,
                allocation,
                basis_seconds,
            });
            deposit += allocation.max(0);
            min_start = min_start.min(start_time);
            max_end = max_end.max(end_time);
        }

        let start_time = if min_start == u64::MAX { 0 } else { min_start };
        let stream = Stream {
            id: (case_idx + 1) as u64,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            deposit,
            withdrawn: 0,
            start_time,
            end_time: max_end,
            cancelable: false,
            status: StreamStatus::Active,
            use_oracle: Some(false),
        };

        // Collect evaluation timestamps: before start, boundaries, midway points, after end
        let mut eval_points: Vec<u64> = Vec::new();
        eval_points.push(start_time.saturating_sub(10));
        eval_points.push(start_time.saturating_sub(1));
        for &(start, end, _, _) in &tc.segments {
            eval_points.push(start);
            eval_points.push(start + 1);
            if end > start {
                eval_points.push((start + end) / 2);
                eval_points.push(end - 1);
            }
            eval_points.push(end);
            eval_points.push(end + 1);
        }
        eval_points.push(max_end + 10);
        eval_points.push(max_end + 100);

        for &now in &eval_points {
            let contract_res = streamed_amount_at_segments(&stream, now, &contract_segments);
            let model_res = streamed_at_schedule(now, &model_segments);

            // Mismatch check with full schedule printed on failure
            match (&contract_res, &model_res) {
                (Ok(c_val), Ok(m_val)) => {
                    if c_val != m_val {
                        panic!(
                            "Piecewise differential MISMATCH at t={now}!\n\
                             Case: {} (index {case_idx})\n\
                             Contract value: {c_val}\n\
                             Model value:    {m_val}\n\
                             Schedule segments:\n{:#?}\n",
                            tc.name, tc.segments
                        );
                    }
                    if let Some(ref exact_windows) = tc.exact_rate {
                        if let Ok(exact_val) = streamed_at_rate_schedule(now, exact_windows) {
                            if *c_val != exact_val {
                                panic!(
                                    "Exact rate schedule MISMATCH at t={now}!\n\
                                     Case: {} (index {case_idx})\n\
                                     Contract: {c_val}, Exact: {exact_val}\n\
                                     Schedule segments:\n{:#?}\n",
                                    tc.name, tc.segments
                                );
                            }
                        }
                    }
                }
                (Err(StreamError::MathOverflow), Err(ModelError::MathOverflow)) => {
                    // Both overflowed identically
                }
                _ => {
                    panic!(
                        "Piecewise differential ERROR MISMATCH at t={now}!\n\
                         Case: {} (index {case_idx})\n\
                         Contract result: {contract_res:?}\n\
                         Model result:    {model_res:?}\n\
                         Schedule segments:\n{:#?}\n",
                        tc.name, tc.segments
                    );
                }
            }
        }
    }

    println!("Differential matrix verified: all piecewise schedules agreed with reference model.");
}
