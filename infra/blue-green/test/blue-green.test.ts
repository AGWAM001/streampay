import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FencedProjectionOutboxStore, StaleEpochError } from "../src/fencing.ts";
import { BlueGreenController } from "../src/orchestrator.ts";
import { evaluateSloSample, type SloSample } from "../src/slo-monitor.ts";

function healthySample(ts: number): SloSample {
  return {
    timestampMs: ts,
    ingestionLagSec: 4,
    outboxLagItems: 10,
    errorRate: 0.002,
    rpcHealthy: true,
    rpcErrorRate: 0.005,
  };
}

describe("Issue #614 — Blue-Green Indexer Deploys & SLO-Triggered Rollback", () => {
  test("SLO-breach automatic-rollback chaos test: reverts green -> blue on sustained lag/error/RPC breach", () => {
    let clock = 1_000_000;
    const controller = new BlueGreenController({
      initialSlot: "blue",
      initialVersion: "v1.4.0",
      config: { maxTimeToRevertMs: 250 },
      nowFn: () => {
        clock += 5;
        return clock;
      },
    });

    controller.deployStandby("green", "v1.5.0", 1005, "ci-pipeline");
    const cutoverRes = controller.cutover("green", "ci-pipeline");
    assert.equal(cutoverRes.activeSlot, "green");
    assert.equal(controller.getRouterActiveSlot(), "green");

    // Inject transient single-sample jitter -> should NOT flap/rollback
    const jitter = controller.evaluateAndAutoRollback([
      {
        timestampMs: clock,
        ingestionLagSec: 45, // breaches #483
        outboxLagItems: 10,
        errorRate: 0.001,
        rpcHealthy: true,
        rpcErrorRate: 0,
      },
      healthySample(clock + 1000),
    ]);
    assert.equal(jitter.rolledBack, false);
    assert.equal(controller.getRouterActiveSlot(), "green");

    // Inject sustained chaos regression: ingestion lag (#483), outbox lag (#542), error rate, RPC failure
    const chaosRes = controller.evaluateAndAutoRollback([
      {
        timestampMs: clock + 2000,
        ingestionLagSec: 72,
        outboxLagItems: 820,
        errorRate: 0.14,
        rpcHealthy: false,
        rpcErrorRate: 0.35,
      },
      {
        timestampMs: clock + 3000,
        ingestionLagSec: 85,
        outboxLagItems: 910,
        errorRate: 0.18,
        rpcHealthy: false,
        rpcErrorRate: 0.42,
      },
    ]);

    assert.equal(chaosRes.rolledBack, true);
    assert.equal(chaosRes.activeSlot, "blue");
    assert.equal(controller.getRouterActiveSlot(), "blue");
    assert.ok(chaosRes.breachedMetrics.some((m) => m.includes("#483")));
    assert.ok(chaosRes.breachedMetrics.some((m) => m.includes("#542")));
    assert.ok(chaosRes.breachedMetrics.some((m) => m.includes("rpc_failover_unhealthy")));
    assert.ok(
      controller.getAlerts().some((a) => a.severity === "critical" && a.title.includes("green -> blue"))
    );
  });

  test("exactly-once projection & outbox delivery across cutover and rollback (#212)", () => {
    const store = new FencedProjectionOutboxStore("blue", 1);
    const controller = new BlueGreenController({ initialSlot: "blue", store });

    // Blue (epoch 1) commits evt-1
    const r1 = store.commitAndDeliver("blue", 1, { eventId: "evt-1", ledger: 100, payload: {} });
    assert.deepEqual(r1, { committed: true, duplicate: false });

    // Cutover to green -> epoch becomes 2
    controller.deployStandby("green", "v2.0.0", 100);
    const { epoch: greenEpoch } = controller.cutover("green");
    assert.equal(greenEpoch, 2);

    // Stale blue worker (epoch 1) tries to commit evt-2 or duplicate evt-1 -> FENCED OUT
    assert.throws(
      () => store.commitAndDeliver("blue", 1, { eventId: "evt-2", ledger: 101, payload: {} }),
      StaleEpochError
    );

    // Green (epoch 2) commits evt-2, and idempotently ignores duplicate evt-1
    const r2 = store.commitAndDeliver("green", greenEpoch, { eventId: "evt-2", ledger: 101, payload: {} });
    assert.deepEqual(r2, { committed: true, duplicate: false });
    const dup = store.commitAndDeliver("green", greenEpoch, { eventId: "evt-1", ledger: 100, payload: {} });
    assert.deepEqual(dup, { committed: false, duplicate: true });

    // Trigger SLO rollback back to blue -> epoch becomes 3
    const rb = controller.evaluateAndAutoRollback([
      { timestampMs: 1, ingestionLagSec: 99, outboxLagItems: 900, errorRate: 0.2, rpcHealthy: true, rpcErrorRate: 0 },
      { timestampMs: 2, ingestionLagSec: 99, outboxLagItems: 900, errorRate: 0.2, rpcHealthy: true, rpcErrorRate: 0 },
    ]);
    assert.equal(rb.rolledBack, true);
    const { fenceEpoch: restoredEpoch, activeSlot } = store.getFenceState();
    assert.equal(activeSlot, "blue");
    assert.equal(restoredEpoch, 3);

    // Stale green worker (epoch 2) is now fenced out
    assert.throws(
      () => store.commitAndDeliver("green", 2, { eventId: "evt-3", ledger: 102, payload: {} }),
      StaleEpochError
    );

    // Restored blue (epoch 3) processes evt-3 cleanly
    const r3 = store.commitAndDeliver("blue", restoredEpoch, { eventId: "evt-3", ledger: 102, payload: {} });
    assert.deepEqual(r3, { committed: true, duplicate: false });

    // Exactly 3 unique events committed & delivered — zero duplicates, zero loss
    assert.deepEqual(store.getCommittedEventIds(), ["evt-1", "evt-2", "evt-3"]);
    assert.equal(store.getOutboxDeliveries().length, 3);
  });

  test("time-to-revert bound, manual override, and audit-log completeness", () => {
    let t = 5000;
    const controller = new BlueGreenController({
      initialSlot: "blue",
      config: { maxTimeToRevertMs: 100 },
      nowFn: () => {
        t += 10;
        return t;
      },
    });

    controller.deployStandby("green", "v2.1.0", 2000, "release-bot");
    controller.cutover("green", "release-bot");

    // Manual override suppresses auto-rollback while operator investigates
    controller.setManualOverride(true, "oncall-alice", "Pinning green during RPC maintenance");
    const lockedRes = controller.evaluateAndAutoRollback([
      { timestampMs: 1, ingestionLagSec: 50, outboxLagItems: 10, errorRate: 0, rpcHealthy: true, rpcErrorRate: 0 },
      { timestampMs: 2, ingestionLagSec: 55, outboxLagItems: 10, errorRate: 0, rpcHealthy: true, rpcErrorRate: 0 },
    ]);
    assert.equal(lockedRes.rolledBack, false);
    assert.equal(controller.getRouterActiveSlot(), "green");

    // Manual rollback works even when override was set
    const manualRb = controller.manualRollback("oncall-alice", "Confirmed regression; reverting to blue");
    assert.equal(manualRb.activeSlot, "blue");
    assert.ok(manualRb.durationMs <= 100);

    // Audit log captured every transition in order
    const actions = controller.getAuditLog().map((e) => e.action);
    assert.deepEqual(actions, [
      "deploy-standby",
      "cutover",
      "manual-override",
      "manual-rollback",
    ]);

    // Pure SLO helper sanity
    assert.equal(evaluateSloSample(healthySample(0)).length, 0);
  });
});
