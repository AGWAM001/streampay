import assert from "node:assert/strict";
import test from "node:test";
import { dryRun, executeManifest, validateManifest } from "../src/batch-manifest.ts";

const manifest = {
  schemaVersion: 1,
  rows: [
    { id: "a", op: "create", params: { amount: "10" } },
    { id: "b", op: "top-up", params: { amount: "5" } },
    { id: "c", op: "cancel", params: { amount: "3" } },
  ],
};

test("malformed manifests are rejected", () => {
  const result = validateManifest({ schemaVersion: 2, rows: [{ id: "", op: "nope" }] });
  assert.ok(result.errors.length >= 2);
  assert.equal(result.manifest, undefined);
});

test("dry-run totals value movement and execution is idempotent", () => {
  const parsed = validateManifest(manifest);
  assert.ok(parsed.manifest);
  const preview = dryRun(parsed.manifest);
  assert.equal(preview.total, "12");
  assert.equal(preview.effects.length, 3);
  assert.throws(() => executeManifest(parsed.manifest!, { completed: [], audit: [] }, false));
  const first = executeManifest(parsed.manifest!, { completed: [], audit: [] }, true);
  assert.deepEqual(first.completed.sort(), ["a", "b", "c"]);
  const second = executeManifest(parsed.manifest!, first, true);
  assert.equal(second.audit.filter((entry) => entry.result === "applied").length, 3);
  assert.equal(second.audit.filter((entry) => entry.result === "skipped").length, 3);
  assert.equal(second.audit[1].prev.length > 0, true);
});
