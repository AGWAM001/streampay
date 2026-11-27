import assert from "node:assert/strict";
import test from "node:test";
import { detectDrift, diffSurface, exploreSurface, renderTable } from "../src/abi-explorer.ts";

const left = {
  schema: "streampay-spec/v3",
  functions: [
    { name: "create_stream", args: [{ name: "sender", type: "address" }], returns: "u64", doc: "create" },
  ],
  enums: [
    { name: "StreamError", cases: [{ name: "ZeroAmount", value: 1, doc: "amount" }] },
  ],
  events: [{ name: "StreamCreated", doc: "created" }],
};

test("json surface and table stay stable", () => {
  const model = exploreSurface(left);
  assert.equal(model.schemaVersion, 1);
  assert.deepEqual(model.entries.map((entry) => entry.name), [
    "StreamError.ZeroAmount",
    "StreamCreated",
    "create_stream",
  ]);
  assert.match(renderTable(model), /function \| create_stream/);
});

test("version diff reports added and removed surface", () => {
  const right = {
    ...left,
    functions: [
      { name: "create_stream", args: [{ name: "sender", type: "address" }], returns: "u64" },
      { name: "withdraw", args: [], returns: "i128" },
    ],
    events: [],
  };
  const diff = diffSurface(left, right);
  assert.deepEqual(diff.added, ["function:withdraw"]);
  assert.deepEqual(diff.removed, ["event:StreamCreated"]);
});

test("drift between spec, registry, and deployed interface is reported", () => {
  const problems = detectDrift(["create_stream", "withdraw"], ["create_stream"], ["create_stream", "extra"]);
  assert.ok(problems.includes("registry missing withdraw"));
  assert.ok(problems.includes("deployed interface missing withdraw"));
  assert.ok(problems.includes("spec missing deployed extra"));
});
