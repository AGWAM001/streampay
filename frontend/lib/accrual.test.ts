// Unit tests for accrual.ts using Node.js built-in test runner

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  availableAmountAt,
  computeAccruedAt,
  computeAvailable,
  elapsedSecondsAt,
  inferLedgerTime,
  streamedAmountAt,
  type StreamSnapshot,
} from "./accrual.ts";
import { MathOverflowError } from "./oracle.ts";

describe("computeAccruedAt", () => {
  it("returns 0 at stream start", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 1000n), 0n);
  });

  it("returns 0 before start", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 500n), 0n);
  });

  it("returns full deposit at end", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 2000n), 1000n);
  });

  it("returns full deposit after end", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 2500n), 1000n);
  });

  it("returns partial amount in middle", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 1500n), 500n);
  });

  it("returns zero for zero deposit", () => {
    assert.strictEqual(computeAccruedAt(0n, 1000, 2000, 1500n), 0n);
  });

  it("returns zero for zero duration", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 1000, 1500n), 0n);
  });

  it("returns zero for zero elapsed", () => {
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 1000n), 0n);
  });

  it("handles floor division (truncates)", () => {
    // 1000 * 333 / 1000 = 333 (truncated)
    assert.strictEqual(computeAccruedAt(1000n, 1000, 2000, 1333n), 333n);
  });

  it("handles large values", () => {
    // 1000000 * 999 / 1000 = 999000
    assert.strictEqual(computeAccruedAt(1000000n, 1000, 2000, 1999n), 999000n);
  });
});

describe("computeAvailable", () => {
  it("returns 0 for cancelled stream", () => {
    assert.strictEqual(computeAvailable(1000n, 1000, 2000, 100n, "Cancelled", 1500n), 0n);
  });

  it("returns 0 for depleted stream", () => {
    assert.strictEqual(computeAvailable(1000n, 1000, 2000, 100n, "Depleted", 1500n), 0n);
  });

  it("returns streamed - withdrawn for active stream", () => {
    // 1000n * 500n / 1000n = 500n, 500n - 100n = 400n
    assert.strictEqual(computeAvailable(1000n, 1000, 2000, 100n, "Active", 1500n), 400n);
  });
});
// ------------------------------------------------ contract-exact mirror --
// Issue #39: the per-second counter evaluates these at a ledger second.

const single = (over: Partial<StreamSnapshot> = {}): StreamSnapshot => ({
  deposit: 1000n,
  startTime: 1000,
  endTime: 1100, // 10 units per second
  withdrawn: 0n,
  status: "Active",
  ...over,
});

describe("elapsedSecondsAt mirrors elapsed_seconds_at (half-open window)", () => {
  it("clamps before, inside and after the window", () => {
    assert.strictEqual(elapsedSecondsAt(999n, 1000n, 1100n), 0n);
    assert.strictEqual(elapsedSecondsAt(1000n, 1000n, 1100n), 0n);
    assert.strictEqual(elapsedSecondsAt(1001n, 1000n, 1100n), 1n);
    assert.strictEqual(elapsedSecondsAt(1099n, 1000n, 1100n), 99n);
    assert.strictEqual(elapsedSecondsAt(1100n, 1000n, 1100n), 100n);
    assert.strictEqual(elapsedSecondsAt(5000n, 1000n, 1100n), 100n);
  });
});

describe("streamedAmountAt agrees with the contract's generated vectors", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const vectors: Array<{
    deposit: string;
    duration: string;
    elapsed: string;
    expected_result: string | null;
    expected_error: string | null;
  }> = JSON.parse(
    readFileSync(resolve(here, "../../tests/vectors/accrual_vectors.json"), "utf-8")
  );

  it("matches every in-window vector through the single-window snapshot path", () => {
    let checked = 0;
    for (const v of vectors) {
      const duration = BigInt(v.duration);
      const elapsed = BigInt(v.elapsed);
      // A snapshot window is [0, duration); in-window vectors reach
      // streamed_at unclamped, exactly as streamed_amount_at calls it.
      if (elapsed < 0n || elapsed > duration || duration > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      const snapshot = single({ deposit: BigInt(v.deposit), startTime: 0, endTime: Number(duration) });
      if (v.expected_error) {
        assert.throws(() => streamedAmountAt(snapshot, elapsed), MathOverflowError);
      } else {
        assert.strictEqual(streamedAmountAt(snapshot, elapsed).toString(), v.expected_result);
      }
      checked += 1;
    }
    assert.ok(checked > 50, `only ${checked} vectors were in-window`);
  });
});

describe("availableAmountAt mirrors available_amount_at_segments", () => {
  it("ticks one floor-divided second at a time from stream_start", () => {
    const s = single();
    assert.strictEqual(availableAmountAt(s, 1000n), 0n);
    assert.strictEqual(availableAmountAt(s, 1001n), 10n);
    assert.strictEqual(availableAmountAt(s, 1037n), 370n);
    assert.strictEqual(availableAmountAt(s, 1100n), 1000n);
    assert.strictEqual(availableAmountAt(s, 1200n), 1000n);
  });

  it("floors sub-unit rates exactly like integer division in the contract", () => {
    const s = single({ deposit: 7n, endTime: 1003 }); // 7/3 units per second
    assert.deepStrictEqual(
      [1000n, 1001n, 1002n, 1003n].map((t) => availableAmountAt(s, t)),
      [0n, 2n, 4n, 7n]
    );
  });

  it("subtracts withdrawn and keeps streamed - withdrawn for every non-cancelled status", () => {
    assert.strictEqual(availableAmountAt(single({ withdrawn: 250n }), 1050n), 250n);
    assert.strictEqual(availableAmountAt(single({ withdrawn: 1000n, status: "Depleted" }), 1200n), 0n);
    assert.strictEqual(availableAmountAt(single({ withdrawn: 400n, status: "Depleted" }), 1200n), 600n);
  });

  it("reads zero for a cancelled stream", () => {
    assert.strictEqual(availableAmountAt(single({ status: "Cancelled" }), 1050n), 0n);
  });

  it("handles i128-scale stroop amounts without precision loss", () => {
    const deposit = 10n ** 30n + 7n;
    const s = single({ deposit, startTime: 0, endTime: 3 });
    assert.strictEqual(availableAmountAt(s, 1n), deposit / 3n);
    assert.strictEqual(availableAmountAt(s, 3n), deposit);
  });

  it("sums a renegotiated rate schedule segment by segment", () => {
    // 1000 over [0,100) renegotiated at t=40 to 1200 over the remaining 60s:
    // the head keeps its original line (1000/100 per s) clipped at 40, the
    // tail streams 1200/60 = 20 per second (segments_after_change).
    const s = single({
      deposit: 1600n,
      startTime: 0,
      endTime: 100,
      segments: [
        { startTime: 0, endTime: 40, allocation: 1000n, basisSeconds: 100 },
        { startTime: 40, endTime: 100, allocation: 1200n, basisSeconds: 60 },
      ],
    });
    assert.strictEqual(availableAmountAt(s, 20n), 200n);
    assert.strictEqual(availableAmountAt(s, 40n), 400n);
    assert.strictEqual(availableAmountAt(s, 50n), 600n);
    assert.strictEqual(availableAmountAt(s, 100n), 1600n);
    assert.strictEqual(availableAmountAt(s, 500n), 1600n);
  });

  it("a single segment covering the window is the single-window formula", () => {
    const plain = single({ deposit: 999n, startTime: 0, endTime: 77 });
    const seg = { ...plain, segments: [{ startTime: 0, endTime: 77, allocation: 999n, basisSeconds: 77 }] };
    for (let t = -1n; t <= 80n; t += 1n) {
      assert.strictEqual(availableAmountAt(seg, t), availableAmountAt(plain, t));
    }
  });

  it("treats a zero basis as one second, like basis_seconds.max(1)", () => {
    const s = single({
      startTime: 0,
      endTime: 10,
      segments: [{ startTime: 0, endTime: 10, allocation: 50n, basisSeconds: 0 }],
    });
    assert.strictEqual(availableAmountAt(s, 1n), 50n);
  });
});

describe("inferLedgerTime recovers the read's ledger second", () => {
  const s = single();

  it("returns the local second when the clocks agree", () => {
    assert.strictEqual(inferLedgerTime(s, 370n, 1037n, 10n), 1037n);
  });

  it("finds the ledger second for a local clock running fast or slow", () => {
    assert.strictEqual(inferLedgerTime(s, 370n, 1044n, 10n), 1037n);
    assert.strictEqual(inferLedgerTime(s, 370n, 1030n, 10n), 1037n);
  });

  it("returns null when no second within the skew window reproduces the value (paused / gated)", () => {
    assert.strictEqual(inferLedgerTime(s, 100n, 1037n, 10n), null); // frozen at t=1010
    assert.strictEqual(inferLedgerTime(s, 0n, 1050n, 10n), null); // release-gated reads 0
  });

  it("returns null instead of throwing when the mirror would overflow", () => {
    const huge = single({ deposit: (1n << 127n) - 1n, startTime: 0, endTime: 100 });
    assert.strictEqual(inferLedgerTime(huge, 5n, 50n, 2n), null);
  });
});
