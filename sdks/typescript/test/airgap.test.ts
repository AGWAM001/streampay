import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  Account,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { StreamPayClient } from "../src/client.js";
import {
  AirGapError,
  AIRGAP_ENVELOPE_SCHEMA,
  createUnsignedEnvelope,
  decodeQrChunks,
  encodeQrChunks,
  exportUnsignedEnvelope,
  parseUnsignedEnvelope,
  type AirGapSignedEnvelope,
  type AirGapUnsignedEnvelope,
} from "../src/airgap.js";
import type { Clock } from "../src/retry.js";

const CONTRACT_ID = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));

function fakeClock(): Clock & { t: number } {
  const clock = {
    t: 1_000_000,
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms; },
    random: () => 0,
  };
  return clock;
}

function networkError(): Error {
  return Object.assign(new Error("socket ECONNRESET"), { code: "ECONNRESET" });
}

type Step<T> = T | Error;

function mockServer(script: {
  send?: Step<"PENDING">[];
  get?: Step<rpc.Api.GetTransactionStatus>[];
  includeReturnValue?: boolean;
} = {}) {
  const calls = { getAccount: 0, simulate: 0, send: [] as string[], get: [] as string[] };
  const next = <T>(steps: Step<T>[] | undefined, index: number, fallback: T): T => {
    const step = steps?.[Math.min(index, Math.max(0, steps.length - 1))] ?? fallback;
    if (step instanceof Error) throw step;
    return step;
  };
  const server = {
    async getAccount(accountId: string) {
      calls.getAccount += 1;
      return new Account(accountId, "41");
    },
    async simulateTransaction() {
      calls.simulate += 1;
      return {
        _parsed: true,
        id: "1",
        latestLedger: 100,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "100",
        result: { auth: [], retval: xdr.ScVal.scvU32(7) },
      };
    },
    async sendTransaction(tx: { toXDR(): string; hash(): Buffer }) {
      calls.send.push(tx.toXDR());
      return {
        status: next(script.send, calls.send.length - 1, "PENDING" as const),
        hash: tx.hash().toString("hex"),
        latestLedger: 100,
        latestLedgerCloseTime: 0,
      };
    },
    async getTransaction(hash: string) {
      calls.get.push(hash);
      const status = next(script.get, calls.get.length - 1, rpc.Api.GetTransactionStatus.SUCCESS);
      return {
        status,
        ...(script.includeReturnValue === false ? {} : { returnValue: xdr.ScVal.scvU32(9) }),
        resultXdr: "AAAA",
      };
    },
  };
  return { server: server as unknown as rpc.Server, calls };
}

function client(
  server: rpc.Server,
  options: { retry?: boolean; networkPassphrase?: string; signer?: never } = {}
): StreamPayClient {
  return new StreamPayClient({
    contractId: CONTRACT_ID,
    networkPassphrase: options.networkPassphrase ?? Networks.TESTNET,
    server,
    clock: fakeClock(),
    pollIntervalMs: 10,
    pollTimeoutMs: 100,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
}

async function prepare(): Promise<{ unsigned: AirGapUnsignedEnvelope; serialized: string }> {
  const { server } = mockServer();
  const unsigned = await client(server).buildUnsigned({
    method: "withdraw",
    args: [nativeToScVal(7n, { type: "u64" })],
    sourceAccount: keypair.publicKey(),
  });
  return { unsigned, serialized: await exportUnsignedEnvelope(unsigned) };
}

function sign(unsigned: AirGapUnsignedEnvelope): AirGapSignedEnvelope {
  const transaction = TransactionBuilder.fromXDR(unsigned.transactionXdr, unsigned.networkPassphrase);
  assert.ok(transaction instanceof Transaction);
  transaction.sign(keypair);
  return { ...unsigned, signedTransactionXdr: transaction.toXDR() };
}

function invalidlySigned(unsigned: AirGapUnsignedEnvelope): string {
  const transaction = TransactionBuilder.fromXDR(unsigned.transactionXdr, unsigned.networkPassphrase);
  assert.ok(transaction instanceof Transaction);
  transaction.addDecoratedSignature(new xdr.DecoratedSignature({
    hint: Buffer.alloc(4),
    signature: Buffer.alloc(64),
  }));
  return transaction.toXDR();
}

function signedWithDifferentBody(unsigned: AirGapUnsignedEnvelope): string {
  const transaction = new TransactionBuilder(new Account(unsigned.sourceAccount, "42"), {
    fee: "1000000",
    networkPassphrase: unsigned.networkPassphrase,
  })
    .addOperation(new Contract(CONTRACT_ID).call("pause"))
    .setTimeout(60)
    .build();
  transaction.sign(keypair);
  return transaction.toXDR();
}

function signedWithTamperedHint(unsigned: AirGapUnsignedEnvelope): string {
  const transaction = TransactionBuilder.fromXDR(unsigned.transactionXdr, unsigned.networkPassphrase);
  assert.ok(transaction instanceof Transaction);
  transaction.sign(keypair);
  const envelope = transaction.toEnvelope();
  const original = envelope.value.signatures[0]!;
  envelope.value.signatures[0] = new xdr.DecoratedSignature({
    hint: Buffer.alloc(4),
    signature: original.signature.value,
  });
  return envelope.toXdr("base64");
}

test("buildUnsigned prepares and simulates without a signer or submission", async () => {
  const { server, calls } = mockServer();
  const unsigned = await client(server).buildUnsigned({
    method: "withdraw",
    args: [nativeToScVal(7n, { type: "u64" })],
    sourceAccount: keypair.publicKey(),
  });

  assert.equal(unsigned.schema, AIRGAP_ENVELOPE_SCHEMA);
  assert.match(unsigned.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(calls.getAccount, 1);
  assert.equal(calls.simulate, 1);
  assert.deepEqual(calls.send, []);
  const transaction = TransactionBuilder.fromXDR(unsigned.transactionXdr, Networks.TESTNET);
  assert.ok(transaction instanceof Transaction);
  assert.equal(transaction.toEnvelope().value.signatures.length, 0);
  const bounds = transaction.timeBounds!;
  assert.equal(BigInt(bounds.maxTime.toString()) - BigInt(bounds.minTime.toString()), 3_600n);
  assert.deepEqual(await parseUnsignedEnvelope(unsigned), unsigned);
});

test("buildUnsigned accepts a bounded offline signing window and rejects invalid expiry", async () => {
  const { server, calls } = mockServer();
  const sdk = client(server);
  const unsigned = await sdk.buildUnsigned({
    method: "withdraw",
    args: [nativeToScVal(7n, { type: "u64" })],
    sourceAccount: keypair.publicKey(),
    timeoutSeconds: 7_200,
  });
  const transaction = TransactionBuilder.fromXDR(unsigned.transactionXdr, Networks.TESTNET);
  assert.ok(transaction instanceof Transaction);
  const bounds = transaction.timeBounds!;
  assert.equal(BigInt(bounds.maxTime.toString()) - BigInt(bounds.minTime.toString()), 7_200n);
  await assert.rejects(
    sdk.buildUnsigned({
      method: "withdraw",
      args: [],
      sourceAccount: keypair.publicKey(),
      timeoutSeconds: 0,
    }),
    RangeError
  );
  assert.equal(calls.getAccount, 1);
});

test("offline round trip submits the externally signed bytes and preserves retry idempotency", async () => {
  const { unsigned } = await prepare();
  const signed = sign(unsigned);
  const { server, calls } = mockServer({
    send: [networkError(), "PENDING"],
    get: [rpc.Api.GetTransactionStatus.NOT_FOUND, rpc.Api.GetTransactionStatus.SUCCESS],
  });
  const sdk = client(server, { retry: true });
  const imported = await sdk.importSigned({
    unsignedEnvelope: unsigned,
    signedTransactionXdr: signed.signedTransactionXdr,
  });
  const result = await sdk.submitSigned(imported, (value) => Number(scValToNative(value)));

  assert.equal(result, 9);
  assert.equal(calls.send.length, 2);
  assert.equal(new Set(calls.send).size, 1);
  assert.equal(calls.send[0], signed.signedTransactionXdr);
});

test("portable JSON and QR transport complete the external-signing round trip", async () => {
  const { unsigned, serialized } = await prepare();
  const chunks = await encodeQrChunks(serialized, { chunkSize: 128 });
  const transported = await decodeQrChunks([...chunks].reverse());
  const externalUnsigned = await parseUnsignedEnvelope(transported);
  const externalSigned = sign(externalUnsigned);
  const expected = {
    sourceAccount: keypair.publicKey(),
    method: "withdraw",
    contentHash: unsigned.contentHash,
  };
  const { server, calls } = mockServer();
  const sdk = client(server);
  const imported = await sdk.importSigned({
    unsignedEnvelope: transported,
    signedTransactionXdr: externalSigned.signedTransactionXdr,
    expected,
  });
  const result = await sdk.submitSigned(imported, (value) => Number(scValToNative(value)), { expected });
  assert.equal(result, 9);
  assert.deepEqual(calls.send, [externalSigned.signedTransactionXdr]);
});

test("import rejects a tampered content hash", async () => {
  const { unsigned } = await prepare();
  const signed = sign(unsigned);
  await assert.rejects(
    client(mockServer().server).importSigned({
      unsignedEnvelope: { ...unsigned, contentHash: "0".repeat(64) },
      signedTransactionXdr: signed.signedTransactionXdr,
    }),
    (error) => error instanceof AirGapError && error.code === "hash-mismatch"
  );
  const withUnknownField = { ...unsigned, unexpected: "payload" };
  await assert.rejects(
    client(mockServer().server).importSigned({
      unsignedEnvelope: withUnknownField,
      signedTransactionXdr: signed.signedTransactionXdr,
    }),
    (error) => error instanceof AirGapError && error.code === "invalid-envelope"
  );
});

test("import rejects the wrong Stellar network and wrong StreamPay contract", async () => {
  const { unsigned } = await prepare();
  const signed = sign(unsigned);
  const wrongNetwork = client(mockServer().server, { networkPassphrase: Networks.PUBLIC });
  await assert.rejects(
    wrongNetwork.importSigned({ unsignedEnvelope: unsigned, signedTransactionXdr: signed.signedTransactionXdr }),
    (error) => error instanceof AirGapError && error.code === "network-mismatch"
  );
  const wrongContract = new StreamPayClient({
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMLF4",
    networkPassphrase: Networks.TESTNET,
    server: mockServer().server,
  });
  await assert.rejects(
    wrongContract.importSigned({ unsignedEnvelope: unsigned, signedTransactionXdr: signed.signedTransactionXdr }),
    (error) => error instanceof AirGapError && error.code === "contract-mismatch"
  );
});

test("out-of-band expectations reject a rehashed replacement envelope", async () => {
  const { unsigned } = await prepare();
  const replacementTransaction = new TransactionBuilder(new Account(keypair.publicKey(), "42"), {
    fee: "1000000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(CONTRACT_ID).call("pause"))
    .setTimeout(3_600)
    .build();
  const replacement = await createUnsignedEnvelope({
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    sourceAccount: keypair.publicKey(),
    method: "pause",
    transactionXdr: replacementTransaction.toXDR(),
  });
  const signed = sign(replacement);
  const sdk = client(mockServer().server);
  await assert.rejects(
    sdk.importSigned({
      unsignedEnvelope: replacement,
      signedTransactionXdr: signed.signedTransactionXdr,
      expected: { method: "withdraw" },
    }),
    (error) => error instanceof AirGapError && error.code === "transaction-mismatch"
  );
  await assert.rejects(
    sdk.importSigned({
      unsignedEnvelope: replacement,
      signedTransactionXdr: signed.signedTransactionXdr,
      expected: { contentHash: unsigned.contentHash },
    }),
    (error) => error instanceof AirGapError && error.code === "hash-mismatch"
  );
});

test("import requires signatures and an unchanged transaction body", async () => {
  const { unsigned } = await prepare();
  await assert.rejects(
    client(mockServer().server).importSigned({
      unsignedEnvelope: unsigned,
      signedTransactionXdr: unsigned.transactionXdr,
    }),
    (error) => error instanceof AirGapError && error.code === "missing-signature"
  );
  await assert.rejects(
    client(mockServer().server).importSigned({
      unsignedEnvelope: unsigned,
      signedTransactionXdr: invalidlySigned(unsigned),
    }),
    (error) => error instanceof AirGapError && error.code === "invalid-signature"
  );
  await assert.rejects(
    client(mockServer().server).importSigned({
      unsignedEnvelope: unsigned,
      signedTransactionXdr: signedWithTamperedHint(unsigned),
    }),
    (error) => error instanceof AirGapError && error.code === "invalid-signature"
  );
  await assert.rejects(
    client(mockServer().server).importSigned({
      unsignedEnvelope: unsigned,
      signedTransactionXdr: signedWithDifferentBody(unsigned),
    }),
    (error) => error instanceof AirGapError && error.code === "transaction-mismatch"
  );
});

test("submitSigned revalidates envelopes that were changed after import", async () => {
  const { unsigned } = await prepare();
  const imported = sign(unsigned);
  await assert.rejects(
    client(mockServer().server).submitSigned(
      { ...imported, signedTransactionXdr: signedWithDifferentBody(unsigned) },
      (value) => value
    ),
    (error) => error instanceof AirGapError && error.code === "transaction-mismatch"
  );
});

test("QR chunks are deterministic and can be reassembled out of order", async () => {
  const { serialized } = await prepare();
  const chunks = await encodeQrChunks(serialized, { chunkSize: 128 });
  assert.ok(chunks.length > 2);
  assert.deepEqual(await encodeQrChunks(serialized, { chunkSize: 128 }), chunks);
  assert.equal(await decodeQrChunks([...chunks].reverse()), serialized);
  assert.equal(await decodeQrChunks([chunks[0]!, ...chunks, chunks[0]!]), serialized);
});

test("QR reassembly rejects missing, conflicting, and tampered chunks", async () => {
  const { serialized } = await prepare();
  const chunks = await encodeQrChunks(serialized, { chunkSize: 128 });
  await assert.rejects(
    decodeQrChunks(chunks.slice(1)),
    (error) => error instanceof AirGapError && error.code === "incomplete-chunks"
  );
  const conflict = [...chunks];
  const first = conflict[0]!;
  conflict.push(`${first.slice(0, -1)}${first.endsWith("A") ? "B" : "A"}`);
  await assert.rejects(
    decodeQrChunks(conflict),
    (error) => error instanceof AirGapError && error.code === "invalid-chunks"
  );
  const tampered = [...chunks];
  const payloadIndex = tampered.length - 1;
  const original = tampered[payloadIndex]!;
  tampered[payloadIndex] = `${original.slice(0, -1)}${original.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(
    decodeQrChunks(tampered),
    (error) => error instanceof AirGapError && error.code === "hash-mismatch"
  );
});

test("QR reassembly enforces the same byte limit as encoding", async () => {
  const bytes = Buffer.alloc(1_000_001);
  const payload = bytes.toString("base64url");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const chunkSize = 4_096;
  const total = Math.ceil(payload.length / chunkSize);
  const chunks = Array.from({ length: total }, (_, index) =>
    `sp-airgap-v1:${index}:${total}:${digest}:${payload.slice(index * chunkSize, (index + 1) * chunkSize)}`
  );
  await assert.rejects(
    decodeQrChunks(chunks),
    (error) => error instanceof AirGapError && error.code === "invalid-chunks"
  );
});

test("an included imported transaction without a return value fails explicitly", async () => {
  const { unsigned } = await prepare();
  const imported = sign(unsigned);
  await assert.rejects(
    client(mockServer({ includeReturnValue: false }).server).submitSigned(imported, (value) => value),
    /included transaction returned no value/
  );
});

test("fixed positive and negative offline-signing fixtures remain stable", async () => {
  const fixture = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../test/fixtures/airgap-v1.json", import.meta.url)),
    "utf8"
  )) as {
    unsigned: AirGapUnsignedEnvelope;
    serializedSha256: string;
    signedTransactionXdrSha256: string;
    qrChunkSize: number;
    qrChunkSha256: string[];
  };
  assert.deepEqual(await parseUnsignedEnvelope(fixture.unsigned), fixture.unsigned);
  const serialized = await exportUnsignedEnvelope(fixture.unsigned);
  const chunks = await encodeQrChunks(serialized, { chunkSize: fixture.qrChunkSize });
  assert.equal(chunks[0]!.split(":")[3], fixture.serializedSha256);
  assert.deepEqual(
    chunks.map((chunk) => createHash("sha256").update(chunk).digest("hex")),
    fixture.qrChunkSha256
  );
  assert.equal(await decodeQrChunks(chunks), serialized);
  const signed = sign(fixture.unsigned);
  assert.equal(
    createHash("sha256").update(signed.signedTransactionXdr).digest("hex"),
    fixture.signedTransactionXdrSha256
  );

  const negatives = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../test/fixtures/airgap-negative-v1.json", import.meta.url)),
    "utf8"
  )) as {
    tamperedHash: string;
    wrongNetwork: string;
    missingChunkIndex: number;
    conflictingChunkIndex: number;
  };
  await assert.rejects(
    parseUnsignedEnvelope({ ...fixture.unsigned, contentHash: negatives.tamperedHash }),
    (error) => error instanceof AirGapError && error.code === "hash-mismatch"
  );
  await assert.rejects(
    decodeQrChunks(chunks.filter((_, index) => index !== negatives.missingChunkIndex)),
    (error) => error instanceof AirGapError && error.code === "incomplete-chunks"
  );
  const conflicting = [...chunks];
  const original = conflicting[negatives.conflictingChunkIndex]!;
  conflicting.push(`${original.slice(0, -1)}${original.endsWith("A") ? "B" : "A"}`);
  await assert.rejects(
    decodeQrChunks(conflicting),
    (error) => error instanceof AirGapError && error.code === "invalid-chunks"
  );
  const server = mockServer().server;
  await assert.rejects(
    client(server, { networkPassphrase: negatives.wrongNetwork }).importSigned({
      unsignedEnvelope: fixture.unsigned,
      signedTransactionXdr: signed.signedTransactionXdr,
    }),
    (error) => error instanceof AirGapError && error.code === "network-mismatch"
  );
});
