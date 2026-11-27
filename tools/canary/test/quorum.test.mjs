import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_QUORUM, evaluateQuorum, signProbe, verifyProbe } from "../quorum.mjs";

const now = 1_000_000;

function report(region, ok, observedAt = now) {
  const result = { region, ok, observedAt, nonce: `${region}-${observedAt}`, sequence: 1 };
  result.signature = signProbe(result, "canary-secret");
  return result;
}

test("a single region failure is suppressed", () => {
  const decision = evaluateQuorum(
    [report("us-east", false), report("eu-west", true), report("ap-southeast", true)],
    DEFAULT_QUORUM,
    now,
  );
  assert.equal(decision.action, "suppress");
  assert.equal(decision.suppressed, true);
});

test("quorum failure pages and a sustained failure escalates", () => {
  const reports = [report("us-east", false), report("eu-west", false), report("ap-southeast", true)];
  const first = evaluateQuorum(reports, DEFAULT_QUORUM, now);
  assert.equal(first.action, "page");
  const second = evaluateQuorum(reports, DEFAULT_QUORUM, now, { consecutiveFailures: first.consecutiveFailures });
  assert.equal(second.action, "escalate");
});

test("a down region does not create a false page or a false recovery", () => {
  const down = evaluateQuorum(
    [report("us-east", true)],
    DEFAULT_QUORUM,
    now,
  );
  assert.equal(down.action, "suppress");
  assert.equal(down.missing, 2);
  const healthy = evaluateQuorum(
    [report("us-east", true), report("eu-west", true)],
    DEFAULT_QUORUM,
    now,
  );
  assert.equal(healthy.action, "recover");
});

test("replayed and unsigned probes are rejected", () => {
  const seen = new Set();
  const probe = report("us-east", false);
  assert.equal(verifyProbe(probe, "canary-secret", seen).ok, true);
  assert.equal(verifyProbe(probe, "canary-secret", seen).reason, "replay");
  const forged = { ...report("eu-west", false), signature: "00000000" };
  assert.equal(verifyProbe(forged, "canary-secret", new Set()).reason, "bad-signature");
});
