/**
 * Framework-free live-accrual engine (issue #211).
 *
 * Owns the 15s simulate refresh + 1s local ticker loop used by the stream
 * detail views, with two seams the clock-skew suite drives:
 *
 *  - `nowMs` — the local wall clock (injectable fake timer source),
 *  - `readStream` — may report the server's ledger timestamp for the read;
 *    when it does, the engine anchors the ticker to ledger time instead of
 *    the local clock, which makes the guarded display obey the
 *    never-over-up contract even with a skewed local clock.
 *
 * Display rule (docs/TIME_HANDLING.md): the counter may re-anchor down
 * (stale-down) but may never show more than contract-available at the known
 * ledger moment plus one epsilon.
 *
 * Between reads the counter is the contract's own formula
 * (`availableAmountAt`, a 1:1 mirror of stream.rs, rate schedule included)
 * evaluated at the anchored ledger second: `anchor.ledgerTime` plus the whole
 * local seconds elapsed since the read. Only the local clock's *rate* is
 * trusted, never its absolute value. When a read carries no ledger timestamp
 * (RPC simulation does not report one) the anchor is recovered from the
 * confirmed `available` value (`inferLedgerTime`). When no anchor reproduces
 * it, or the stream is no longer Active, the display is frozen at the
 * confirmed value until the next read (issue #39).
 */

import {
  availableAmountAt,
  inferLedgerTime,
  type StreamSnapshot,
} from "./accrual.ts";
import { MathOverflowError } from "./oracle.ts";
import {
  MAX_SKEW_SECONDS,
  REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./clock-skew.ts";

export type LiveStreamRead = StreamSnapshot & {
  /** `ledger().timestamp()` of the ledger the read was pinned to. */
  ledgerTime?: number;
};

export type LiveAccrualState = {
  snapshot: StreamSnapshot | null;
  /** Simulate-confirmed available: the value a withdraw action is guarded by. */
  available: bigint | null;
  displayAvailable: bigint | null;
  /**
   * True while `displayAvailable` advances every second from a ledger anchor;
   * false when it is frozen at the confirmed `available` (ended, cancelled,
   * paused or otherwise not locally mirrorable) or before the first read.
   */
  ticking: boolean;
  error: unknown;
};

export type LiveAccrualOptions = {
  readStream: () => Promise<LiveStreamRead>;
  readAvailable: () => Promise<bigint>;
  nowMs?: () => number;
  tickMs?: number;
  refreshMs?: number;
  onUpdate: (state: LiveAccrualState) => void;
};

export type LiveAccrual = {
  stop(): void;
  refresh(): Promise<void>;
};

export const INITIAL_STATE: LiveAccrualState = {
  snapshot: null,
  available: null,
  displayAvailable: null,
  ticking: false,
  error: null,
};

function toSeconds(ms: number): bigint {
  return BigInt(Math.floor(ms / 1000));
}

/**
 * The ledger second to anchor the ticker to, or `null` to freeze the display
 * at the confirmed value. Only an Active stream ticks, and only when the local
 * mirror reproduces the confirmed `available` at the anchor: a reported
 * ledger time is checked, a missing one is inferred.
 */
export function anchorFor(
  snapshot: StreamSnapshot,
  available: bigint,
  reportedLedgerTime: number | undefined,
  localTime: bigint
): bigint | null {
  if (snapshot.status !== "Active") return null;
  if (reportedLedgerTime === undefined) {
    return inferLedgerTime(snapshot, available, localTime, MAX_SKEW_SECONDS);
  }
  const ledgerTime = BigInt(reportedLedgerTime);
  try {
    return availableAmountAt(snapshot, ledgerTime) === available ? ledgerTime : null;
  } catch (e) {
    if (e instanceof MathOverflowError) return null;
    throw e;
  }
}

export function startLiveAccrual(options: LiveAccrualOptions): LiveAccrual {
  const nowMs = options.nowMs ?? ((): number => Date.now());
  const tickMs = options.tickMs ?? TICK_INTERVAL_MS;
  const refreshMs = options.refreshMs ?? REFRESH_INTERVAL_MS;

  let state = INITIAL_STATE;
  let anchor: { ledgerTime: bigint; localTime: bigint } | null = null;
  let stopped = false;

  /** The mirror at the anchored ledger second, or `null` if it cannot be mirrored. */
  const displayAt = (snapshot: StreamSnapshot, localTime: bigint): bigint | null => {
    if (!anchor) return null;
    // A local clock stepping backwards (NTP correction) must not run the
    // counter below the confirmed value: hold at the anchor instead.
    const delta = localTime > anchor.localTime ? localTime - anchor.localTime : 0n;
    try {
      return availableAmountAt(snapshot, anchor.ledgerTime + delta);
    } catch (e) {
      if (e instanceof MathOverflowError) return null;
      throw e;
    }
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    try {
      const [stream, available] = await Promise.all([
        options.readStream(),
        options.readAvailable(),
      ]);
      if (stopped) return;
      const localTime = toSeconds(nowMs());
      const snapshot: StreamSnapshot = {
        deposit: stream.deposit,
        startTime: stream.startTime,
        endTime: stream.endTime,
        withdrawn: stream.withdrawn,
        status: stream.status,
        ...(stream.segments ? { segments: stream.segments } : {}),
      };
      anchor = null;
      const ledgerTime = anchorFor(snapshot, available, stream.ledgerTime, localTime);
      if (ledgerTime !== null) anchor = { ledgerTime, localTime };
      const live = displayAt(snapshot, localTime);
      state = {
        snapshot,
        available,
        displayAvailable: live ?? available,
        ticking: live !== null,
        error: null,
      };
      options.onUpdate(state);
    } catch (e) {
      if (stopped) return;
      state = { ...state, error: e };
      options.onUpdate(state);
    }
  };

  const tickTimer = setInterval(() => {
    if (stopped || !state.snapshot || !state.ticking) return;
    const localTime = toSeconds(nowMs());
    const displayAvailable = displayAt(state.snapshot, localTime);
    if (displayAvailable === null || displayAvailable === state.displayAvailable) return;
    state = { ...state, displayAvailable };
    options.onUpdate(state);
  }, tickMs);

  const refreshTimer = setInterval(() => {
    void refresh();
  }, refreshMs);

  void refresh();

  return {
    stop() {
      stopped = true;
      clearInterval(tickTimer);
      clearInterval(refreshTimer);
    },
    refresh,
  };
}
