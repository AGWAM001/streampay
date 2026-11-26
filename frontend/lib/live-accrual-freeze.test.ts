// Live-accrual engine: when the counter ticks and when it freezes (issue #39).
//
// The detail page reads the stream through RPC simulation, which reports no
// ledger timestamp, so the engine anchors its per-second ticker by solving
// the contract formula for the confirmed `available` read. These tests pin
// the cases where the local mirror must not extrapolate: paused, cancelled,
// ended, release-gated, and a reported anchor that disagrees with the chain.

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { anchorFor, startLiveAccrual, type LiveAccrualState } from "./live-accrual.ts";
import { availableAmountAt, type StreamSnapshot } from "./accrual.ts";

const BASE = 1_700_000_000;

let ledger: number;
let updates: LiveAccrualState[];

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function tickSeconds(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    ledger += 1;
    mock.timers.tick(1000);
    await flush();
  }
}

/**
 * Starts the engine against a fake chain. `availableAt` is the chain's truth
 * (it may diverge from the plain formula: a pause, a gate); `snapshot` is what
 * `get_stream` returns.
 */
function start(
  snapshot: () => StreamSnapshot,
  availableAt: (ledgerTime: bigint) => bigint
): { stop(): void } {
  return startLiveAccrual({
    readStream: async () => snapshot(),
    readAvailable: async () => availableAt(BigInt(ledger)),
    nowMs: () => ledger * 1000,
    tickMs: 1000,
    refreshMs: 15_000,
    onUpdate: (state) => updates.push(state),
  });
}

const active = (over: Partial<StreamSnapshot> = {}): StreamSnapshot => ({
  deposit: 86_400_000n,
  startTime: BASE - 100,
  endTime: BASE + 86_300, // 1000 units per second
  withdrawn: 0n,
  status: "Active",
  ...over,
});

beforeEach(() => {
  mock.timers.enable({ apis: ["setInterval"] });
  ledger = BASE;
  updates = [];
});

afterEach(() => {
  mock.timers.reset();
});

describe("ticking between polls", () => {
  it("advances every second with the contract formula and re-syncs on the 15s read", async () => {
    const s = active();
    const engine = start(() => s, (t) => availableAmountAt(s, t));
    await flush();
    const seen: bigint[] = [];
    for (let i = 0; i < 20; i += 1) {
      await tickSeconds(1);
      const last = updates[updates.length - 1];
      assert.strictEqual(last.ticking, true);
      assert.strictEqual(last.displayAvailable, availableAmountAt(s, BigInt(ledger)));
      seen.push(last.displayAvailable ?? 0n);
    }
    // 1000 units every second: strictly increasing, one step per second.
    for (let i = 1; i < seen.length; i += 1) assert.strictEqual(seen[i] - seen[i - 1], 1000n);
    engine.stop();
  });

  it("mirrors a renegotiated rate schedule", async () => {
    const s = active({
      deposit: 3000n,
      startTime: BASE - 10,
      endTime: BASE + 90,
      segments: [
        { startTime: BASE - 10, endTime: BASE, allocation: 1000n, basisSeconds: 100 },
        { startTime: BASE, endTime: BASE + 90, allocation: 1800n, basisSeconds: 90 },
      ],
    });
    const engine = start(() => s, (t) => availableAmountAt(s, t));
    await flush();
    await tickSeconds(5);
    const last = updates[updates.length - 1];
    assert.strictEqual(last.ticking, true);
    assert.strictEqual(last.displayAvailable, 100n + 100n); // 10 units/s head, 20 units/s tail
    engine.stop();
  });

  it("stops moving at end_time without any extra re-render", async () => {
    const s = active({ deposit: 50n, startTime: BASE - 3, endTime: BASE + 2 });
    const engine = start(() => s, (t) => availableAmountAt(s, t));
    await flush();
    await tickSeconds(3);
    const count = updates.length;
    assert.strictEqual(updates[count - 1].displayAvailable, 50n);
    await tickSeconds(5);
    assert.strictEqual(updates.length, count, "an ended stream must not re-render every second");
    engine.stop();
  });
});

describe("freezing at the confirmed value", () => {
  it("a paused stream does not tick: the chain's frozen value cannot be reproduced near now", async () => {
    const s = active();
    const pausedAt = BigInt(BASE - 60);
    const engine = start(() => s, (t) => availableAmountAt(s, t < pausedAt ? t : pausedAt));
    await flush();
    const frozen = availableAmountAt(s, pausedAt);
    await tickSeconds(20); // spans one automatic refresh
    for (const update of updates) {
      assert.strictEqual(update.ticking, false);
      assert.strictEqual(update.displayAvailable, frozen);
    }
    engine.stop();
  });

  it("a release-gated stream (available reads 0 mid-window) stays at 0", async () => {
    const s = active();
    const engine = start(() => s, () => 0n);
    await flush();
    await tickSeconds(5);
    const last = updates[updates.length - 1];
    assert.strictEqual(last.ticking, false);
    assert.strictEqual(last.displayAvailable, 0n);
    engine.stop();
  });

  it("a cancelled stream is frozen", async () => {
    const s = active({ status: "Cancelled", withdrawn: 5000n });
    const engine = start(() => s, () => 0n);
    await flush();
    await tickSeconds(5);
    assert.ok(updates.every((u) => u.ticking === false && u.displayAvailable === 0n));
    engine.stop();
  });

  it("a stream cancelled between polls freezes at the next read", async () => {
    let s = active();
    const engine = start(() => s, (t) => availableAmountAt(s, t));
    await flush();
    await tickSeconds(5);
    assert.strictEqual(updates[updates.length - 1].ticking, true);
    s = { ...s, status: "Cancelled" };
    await tickSeconds(10); // the 15s refresh lands
    const last = updates[updates.length - 1];
    assert.strictEqual(last.ticking, false);
    assert.strictEqual(last.displayAvailable, 0n);
    const count = updates.length;
    await tickSeconds(3);
    assert.strictEqual(updates.length, count);
    engine.stop();
  });

  it("resumes ticking once the chain matches the mirror again", async () => {
    let paused = true;
    const s = active();
    const pausedAt = BigInt(BASE - 60);
    const engine = start(
      () => s,
      (t) => availableAmountAt(s, paused && t > pausedAt ? pausedAt : t)
    );
    await flush();
    assert.strictEqual(updates[updates.length - 1].ticking, false);
    paused = false;
    await tickSeconds(15);
    assert.strictEqual(updates[updates.length - 1].ticking, true);
    engine.stop();
  });
});

describe("anchorFor", () => {
  const s = active();
  it("accepts a reported ledger time only when it reproduces the confirmed value", () => {
    const t = BigInt(BASE);
    assert.strictEqual(anchorFor(s, availableAmountAt(s, t), BASE, t), t);
    assert.strictEqual(anchorFor(s, availableAmountAt(s, t) - 1n, BASE, t), null);
  });

  it("infers a missing ledger time within the skew window", () => {
    const t = BigInt(BASE);
    assert.strictEqual(anchorFor(s, availableAmountAt(s, t), undefined, t + 7n), t);
  });

  it("never anchors a non-active stream", () => {
    const t = BigInt(BASE);
    for (const status of ["Cancelled", "Depleted"]) {
      assert.strictEqual(anchorFor({ ...s, status }, availableAmountAt(s, t), BASE, t), null);
    }
  });
});
