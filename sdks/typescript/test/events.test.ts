import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { xdr } from "@stellar/stellar-sdk";
import { decodeEvent, decodeEventXdr } from "../src/events.js";
import type { VectorFile } from "../src/vectors.js";

const vectorsDir = fileURLToPath(new URL("../../../vectors/", import.meta.url));

function vector(name: string): VectorFile {
  return JSON.parse(readFileSync(join(vectorsDir, `${name}.json`), "utf8")) as VectorFile;
}

test("decodes typed StreamCreated event fields", () => {
  const source = vector("create-stream");
  const event = decodeEventXdr(source.eventsXdr[0]!);
  assert.ok(event);
  assert.equal(event.type, "StreamCreated");
  assert.equal(event.streamId, 1n);
  assert.equal(event.deposit, 10_000_000_000n);
  assert.equal(event.cancelable, false);
  const expected = source.expected as { events: Array<{ contract: string }> };
  assert.equal(event.contractId, expected.events[0]!.contract);
  assert.ok(decodeEventXdr(source.eventsXdr[0]!, expected.events[0]!.contract));
  assert.equal(
    decodeEventXdr(
      source.eventsXdr[0]!,
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4"
    ),
    null
  );
});

test("decodes cancellation payouts", () => {
  const event = decodeEventXdr(vector("cancel-stream").eventsXdr[0]!);
  assert.ok(event);
  assert.equal(event.type, "StreamCancelled");
  assert.equal(event.recipientAmount, 1_999_000_000n);
  assert.equal(event.senderAmount, 8_000_000_000n);
});

test("event decoding rejects extra topics", () => {
  const event = xdr.ContractEvent.fromXDR(vector("create-stream").eventsXdr[0]!, "base64");
  event.body.v0.topics.push(xdr.ScVal.scvU32(999));
  assert.throws(
    () => decodeEvent(event),
    /event stream_created has 3 topics; expected 2/
  );
});

test("malformed XDR is a decode failure, not a silent null", () => {
  assert.throws(() => decodeEventXdr("not-xdr"), /decode failed/);
});
