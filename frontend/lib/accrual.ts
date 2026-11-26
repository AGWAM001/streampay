/**
 * Per-second accrual math mirroring Soroban streaming-payments contract.
 *
 * Computes: deposit * floor(now - start, 0, duration) / duration
 * Equivalent to contract's streamed_at(deposit, duration, floor_elapsed)
 *
 * All math uses BigInt for exact i128 arithmetic without overflow.
 * Clamping ensures: 0 <= result <= deposit
 */

import { MathOverflowError, streamedAt } from "./oracle.ts";

/**
 * Compute accrued amount at wall-clock time `now`, mirroring Soroban's
 * streamed_at(deposit, duration, elapsed) with floor division and clamping.
 *
 * @param deposit — total deposit (i128 as BigInt)
 * @param startTime — stream start timestamp (Unix seconds)
 * @param endTime — stream end timestamp (Unix seconds)
 * @param now — current wall-clock timestamp (Unix seconds as BigInt)
 * @returns streamed amount capped at deposit (0 <= result <= deposit)
 */
export function computeAccruedAt(
  deposit: bigint,
  startTime: number,
  endTime: number,
  now: bigint
): bigint {
  const duration: bigint = BigInt(endTime - startTime);
  const elapsed: bigint =
    now < BigInt(startTime) ? 0n : now > BigInt(endTime) ? duration : now - BigInt(startTime);

  if (elapsed === 0n || deposit <= 0n || duration === 0n) return 0n;

  const streamed: bigint = (deposit * elapsed) / duration;
  return streamed > deposit ? deposit : streamed;
}

/**
 * Compute accrued-but-unwithdrawn balance for an active stream.
 * Returns 0 for cancelled or depleted streams (mirrors contract's available_amount).
 */
export function computeAvailable(
  deposit: bigint,
  startTime: number,
  endTime: number,
  withdrawn: bigint,
  status: string,
  now: bigint
): bigint {
  if (status !== "Active") return 0n;
  return computeAccruedAt(deposit, startTime, endTime, now) - withdrawn;
}

/**
 * One window of a renegotiated stream's piecewise rate schedule, as returned
 * by the contract's `rate_segments` view (`RateSegment` in stream.rs).
 */
export type RateSegmentSnapshot = {
  startTime: number;
  endTime: number;
  allocation: bigint;
  basisSeconds: number;
};

export type StreamSnapshot = {
  deposit: bigint;
  startTime: number;
  endTime: number;
  withdrawn: bigint;
  status: string;
  /**
   * The stream's rate schedule. Absent or empty means "never renegotiated":
   * the single `[startTime, endTime)` window funded with `deposit`.
   */
  segments?: readonly RateSegmentSnapshot[];
};

// ------------------------------------------------- contract-exact mirror --
//
// The functions below mirror contracts/streaming-payments/src/stream.rs
// one-to-one so the live counter can evaluate the contract's own formula at
// any ledger second:
//
//   elapsed_seconds_at          -> elapsedSecondsAt
//   streamed_at                 -> streamedAt (lib/oracle.ts, vector-tested)
//   segment_accrual             -> segmentAccrualAt
//   streamed_amount_at_segments -> streamedAmountAt
//   available_amount_at_segments-> availableAmountAt
//
// Integer math is BigInt throughout (amounts are i128 stroops). A
// `MathOverflowError` from `streamedAt` is the contract's `MathOverflow`;
// callers that cannot mirror a value must not guess one.

/** `elapsed_seconds_at`: seconds of the half-open window `[start, end)` elapsed at `now`. */
export function elapsedSecondsAt(now: bigint, startTime: bigint, endTime: bigint): bigint {
  if (now <= startTime) return 0n;
  if (now >= endTime) return endTime - startTime;
  return now - startTime;
}

/** `segment_accrual`: the amount one rate segment has accrued at `now`. */
export function segmentAccrualAt(segment: RateSegmentSnapshot, now: bigint): bigint {
  const basis = BigInt(segment.basisSeconds);
  return streamedAt(
    segment.allocation,
    basis > 1n ? basis : 1n,
    elapsedSecondsAt(now, BigInt(segment.startTime), BigInt(segment.endTime))
  );
}

/**
 * `streamed_amount_at_segments`: total streamed at ledger time `now`. With no
 * schedule this is `streamed_at(deposit, end - start, elapsed)`, exactly the
 * single-window path.
 */
export function streamedAmountAt(snapshot: StreamSnapshot, now: bigint): bigint {
  const segments = snapshot.segments ?? [];
  if (segments.length === 0) {
    const start = BigInt(snapshot.startTime);
    const end = BigInt(snapshot.endTime);
    return streamedAt(snapshot.deposit, end - start, elapsedSecondsAt(now, start, end));
  }
  let total = 0n;
  for (const segment of segments) total += segmentAccrualAt(segment, now);
  return total;
}

/**
 * `available_amount_at_segments`: accrued-but-unwithdrawn at ledger time
 * `now`. Zero for cancelled streams (settled at cancellation); every other
 * status keeps `streamed - withdrawn`, as the contract does.
 */
export function availableAmountAt(snapshot: StreamSnapshot, now: bigint): bigint {
  if (snapshot.status === "Cancelled") return 0n;
  return streamedAmountAt(snapshot, now) - snapshot.withdrawn;
}

/**
 * Recovers the ledger second a simulate-backed `available` read was evaluated
 * at, from the stream fields read alongside it.
 *
 * RPC simulation does not report the ledger timestamp, so the client anchors
 * its ticker by solving `availableAmountAt(snapshot, t) === confirmed` for the
 * `t` closest to the local clock within `maxSkewSeconds`. Accrual is
 * monotonic in `t`, so any solution is a moment the contract agrees with.
 *
 * Returns `null` when no second in the window reproduces the confirmed value.
 * That means the local mirror does not describe this stream right now: it is
 * paused (accrual frozen at the pause point, which no view exposes), release
 * gated, settling against an oracle clock outside the skew window, or the
 * read raced a state change. The caller must then show the confirmed value
 * as-is instead of extrapolating it.
 */
export function inferLedgerTime(
  snapshot: StreamSnapshot,
  confirmed: bigint,
  localTime: bigint,
  maxSkewSeconds: bigint
): bigint | null {
  try {
    if (availableAmountAt(snapshot, localTime) === confirmed) return localTime;
    for (let offset = 1n; offset <= maxSkewSeconds; offset += 1n) {
      if (availableAmountAt(snapshot, localTime - offset) === confirmed) {
        return localTime - offset;
      }
      if (availableAmountAt(snapshot, localTime + offset) === confirmed) {
        return localTime + offset;
      }
    }
  } catch (e) {
    if (e instanceof MathOverflowError) return null;
    throw e;
  }
  return null;
}
