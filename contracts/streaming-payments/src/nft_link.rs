//! Atomic stream + stream-NFT mint linkage (issue #575).
//!
//! A stream and its companion stream-NFT are created in one transaction:
//! [`crate::StreamingPayments::create_stream_with_nft`] completes every
//! stream effect (deposit pull, stream record, indexes, fee, `StreamCreated`)
//! before the single external interaction — the NFT contract's `mint_linked`
//! call — and only then records the link and emits `StreamNftMinted`
//! (checks-effects-interactions).
//!
//! Atomicity needs no compensating writes: the mint is invoked fallibly
//! (`try_invoke_contract`), its failure is translated to a StreamPay error
//! code, and returning that error aborts the top-level invocation, so the
//! deposit pull, the stream record and any partial NFT state roll back
//! together. Neither side can be left with an orphan.
//!
//! Reentrancy: an instance-wide in-flight lock (temporary storage, so it
//! lives exactly as long as the transaction) is held across the mint call.
//! A hostile NFT that calls back into `create_stream_with_nft` is refused
//! with `AtomicMintReentrancyBlocked`, which fails its mint and therefore
//! the whole atomic pair. The companion NFT additionally guards its own
//! mint with a per-contract lock (see `contracts/stream-nft`).
//!
//! The link is bidirectional: this contract stores `stream_id -> nft`
//! ([`DataKey::StreamNftLink`]) after a successful mint, and the NFT stores
//! `stream_id -> core contract` and is bound at initialization to the same
//! stream id, which the mint call re-verifies before minting.

use soroban_sdk::{Address, Env, IntoVal, InvokeError, Symbol, TryFromVal, Val, Vec};

use crate::stream::{DataKey, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};

/// Returns the NFT contract linked to `stream_id`, if it was created
/// atomically via `create_stream_with_nft`.
pub fn get_nft_link(env: &Env, stream_id: u64) -> Option<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::StreamNftLink(stream_id))
}

/// Records the `stream_id -> nft_contract` link after a successful mint.
pub fn put_nft_link(env: &Env, stream_id: u64, nft_contract: &Address) {
    let key = DataKey::StreamNftLink(stream_id);
    env.storage().persistent().set(&key, nft_contract);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Whether an atomic create+mint is currently in flight in this transaction.
pub fn atomic_mint_in_flight(env: &Env) -> bool {
    env.storage()
        .temporary()
        .get(&DataKey::AtomicMintLock)
        .unwrap_or(false)
}

/// Sets or clears the atomic-mint in-flight lock.
pub fn set_atomic_mint_lock(env: &Env, locked: bool) {
    if locked {
        env.storage()
            .temporary()
            .set(&DataKey::AtomicMintLock, &true);
    } else {
        env.storage().temporary().remove(&DataKey::AtomicMintLock);
    }
}

/// Reads the stream id the NFT contract is bound to (`stream_id` getter on
/// the companion). Returns `None` if the call fails or the return value is
/// not a `u64` — a hostile or non-companion contract cannot prove its
/// binding, so it is treated as unlinked.
pub fn nft_bound_stream_id(env: &Env, nft_contract: &Address) -> Option<u64> {
    let res = env.try_invoke_contract::<Val, InvokeError>(
        nft_contract,
        &Symbol::new(env, "stream_id"),
        Vec::new(env),
    );
    match res {
        Ok(Ok(val)) => u64::try_from_val(env, &val).ok(),
        _ => None,
    }
}

/// Fallibly calls the companion's `mint_linked(recipient, stream_id)`.
/// Returns `true` only when the mint invocation succeeded; every failure
/// mode (callee contract error, panic, trap, malformed return) is `false`
/// and is mapped by the caller to a StreamPay code — a raw NFT error code
/// never escapes this contract (see `errors.rs`).
pub fn try_mint_linked(
    env: &Env,
    nft_contract: &Address,
    recipient: &Address,
    stream_id: u64,
) -> bool {
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(recipient.into_val(env));
    args.push_back(stream_id.into_val(env));
    let res = env.try_invoke_contract::<Val, InvokeError>(
        nft_contract,
        &Symbol::new(env, "mint_linked"),
        args,
    );
    matches!(res, Ok(Ok(_)))
}
