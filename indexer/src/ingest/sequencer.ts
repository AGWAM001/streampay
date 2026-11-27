/**
 * Sequencing for the parallel ingester (issue #117).
 *
 * Parallel fetch buys throughput at the price of arrival order; sequencing is how
 * we get the guarantees back. Two independent questions, two small machines:
 *
 * - **Coverage**: did we read every ledger between the last committed cursor and
 *   the tip, with no hole? `LedgerCoverage` answers that. A hole is possible in
 *   exactly one way — the RPC refuses a `startLedger` older than its history
 *   retention — and that is a data-loss event, so it is counted and reported,
 *   never silently skipped.
 * - **Per-stream order**: is this event older than what the stream projection
 *   already holds? `StreamSequencer` answers that per stream, and is the metric
 *   that tells an operator the reorder window actually caught something.
 *
 * Neither is authoritative for correctness: the ledger guard in `store.ts` is.
 * These exist so the guard's no-ops are visible instead of mysterious.
 */

import type { LedgerWindow } from "./planner.js";
import { emitLedgerGapTelemetry, type LedgerGapRecord } from "../telemetry.js";

export type { LedgerGapRecord };

export interface SequencedEvent {
  id: string;
  /** null for the events that are not about a stream; they are counted but
   *  never keyed, so they cannot share one pseudo-stream. */
  streamId: string | null;
  ledger: number;
}

export type EventOrder = "in-order" | "late";

/** Cumulative counters, safe to expose on an ops endpoint. */
export interface SequencerMetrics {
  windowsCommitted: number;
  ledgersCovered: number;
  /** Committed windows that did not abut the previous coverage. */
  gapWindows: number;
  /** Ledgers skipped between the end of coverage and a later window. */
  gapLedgers: number;
  eventsSeen: number;
  /** Events older than the ledger already committed for their stream. */
  lateEvents: number;
  /** Highest ledger-gap in ledgers between a late event and committed state. */
  maxLateDepth: number;
  streamsTracked: number;
  activeGaps?: number;
}

export class IngestSequencer {
  private windowsCommitted = 0;
  private ledgersCovered = 0;
  private gapWindows = 0;
  private gapLedgers = 0;
  private eventsSeen = 0;
  private lateEvents = 0;
  private maxLateDepth = 0;
  private lastCovered?: number;
  /** Active unresolved gap records. */
  private readonly gaps: LedgerGapRecord[] = [];
  /** Highest ledger already committed per stream. Seeded from the database. */
  private readonly streamLedgers = new Map<string, number>();

  constructor(seed?: Iterable<readonly [string, number]>) {
    if (seed) {
      for (const [streamId, ledger] of seed) this.streamLedgers.set(streamId, ledger);
    }
  }

  /**
   * Records that `[from .. to]` is now durably committed.
   *
   * The first window only establishes the baseline; afterwards any window that
   * starts past `contiguousThrough + 1` means ledgers were never read, so the
   * skipped count is added to `gapLedgers` (the number an operator pages on)
   * and a gap record + telemetry alert is emitted.
   */
  coverWindow(window: LedgerWindow, source = "rpc"): void {
    this.windowsCommitted += 1;
    const span = Math.max(0, window.to - window.from + 1);
    this.ledgersCovered += span;
    if (this.lastCovered !== undefined && window.from > this.lastCovered + 1) {
      const from = this.lastCovered + 1;
      const to = window.from - 1;
      const size = to - from + 1;
      this.gapWindows += 1;
      this.gapLedgers += size;
      const record: LedgerGapRecord = {
        from,
        to,
        size,
        source,
        detectedAt: Date.now(),
      };
      this.gaps.push(record);
      emitLedgerGapTelemetry(record);
    }
    this.resolveGaps(window);
    this.lastCovered = Math.max(this.lastCovered ?? 0, window.to);
  }

  /**
   * Records that missing ledgers `[from .. to]` have been backfilled.
   * Resolves and clears or shrinks any active gap records matching the window.
   */
  backfillWindow(window: LedgerWindow, source = "backfill"): void {
    const span = Math.max(0, window.to - window.from + 1);
    this.ledgersCovered += span;
    this.resolveGaps(window);
  }

  private resolveGaps(window: LedgerWindow): void {
    if (this.gaps.length === 0) return;
    for (let i = this.gaps.length - 1; i >= 0; i--) {
      const g = this.gaps[i];
      if (window.from <= g.from && window.to >= g.to) {
        // Fully covered
        this.gaps.splice(i, 1);
      } else if (window.from <= g.from && window.to >= g.from && window.to < g.to) {
        // Covers beginning of gap
        g.from = window.to + 1;
        g.size = g.to - g.from + 1;
      } else if (window.from > g.from && window.from <= g.to && window.to >= g.to) {
        // Covers end of gap
        g.to = window.from - 1;
        g.size = g.to - g.from + 1;
      } else if (window.from > g.from && window.to < g.to) {
        // Covers interior of gap: split into two residual gaps
        const rightGap: LedgerGapRecord = {
          from: window.to + 1,
          to: g.to,
          size: g.to - (window.to + 1) + 1,
          source: g.source,
          detectedAt: g.detectedAt,
        };
        g.to = window.from - 1;
        g.size = g.to - g.from + 1;
        this.gaps.splice(i + 1, 0, rightGap);
      }
    }
  }

  /** Active gap records currently unresolved. */
  get activeGaps(): readonly LedgerGapRecord[] {
    return this.gaps;
  }

  get gapRecords(): readonly LedgerGapRecord[] {
    return this.gaps;
  }

  clearGaps(): void {
    this.gaps.length = 0;
  }

  /** Ledger through which coverage is contiguous, or `undefined` if nothing yet. */
  get coveredThrough(): number | undefined {
    return this.lastCovered;
  }

  /**
   * Classifies one event against the stream's committed position, in commit
   * order. Advances the stream position for in-order events so a later replay of
   * the same window is classified correctly.
   */
  classify(event: SequencedEvent): EventOrder {
    this.eventsSeen += 1;
    if (event.streamId === null) return "in-order";
    const committed = this.streamLedgers.get(event.streamId);
    if (committed !== undefined && event.ledger < committed) {
      this.lateEvents += 1;
      this.maxLateDepth = Math.max(this.maxLateDepth, committed - event.ledger);
      return "late";
    }
    if (committed === undefined || event.ledger > committed) {
      this.streamLedgers.set(event.streamId, event.ledger);
    }
    return "in-order";
  }

  metrics(): SequencerMetrics {
    return {
      windowsCommitted: this.windowsCommitted,
      ledgersCovered: this.ledgersCovered,
      gapWindows: this.gapWindows,
      gapLedgers: this.gapLedgers,
      eventsSeen: this.eventsSeen,
      lateEvents: this.lateEvents,
      maxLateDepth: this.maxLateDepth,
      streamsTracked: this.streamLedgers.size,
      activeGaps: this.gaps.length,
    };
  }
}
