import {
  Address,
  Keypair,
  Transaction,
  TransactionBuilder,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";

export const AIRGAP_ENVELOPE_SCHEMA = "streampay-airgap/v1" as const;
const QR_PREFIX = "sp-airgap-v1";
const MAX_ENVELOPE_BYTES = 1_000_000;
const MAX_QR_CHUNKS = 4096;
const DEFAULT_QR_CHUNK_SIZE = 512;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface AirGapUnsignedEnvelope {
  schema: typeof AIRGAP_ENVELOPE_SCHEMA;
  contractId: string;
  networkPassphrase: string;
  sourceAccount: string;
  method: string;
  transactionXdr: string;
  contentHash: string;
}

export interface AirGapSignedEnvelope extends AirGapUnsignedEnvelope {
  signedTransactionXdr: string;
}

export interface SignedEnvelopeExpectation {
  sourceAccount?: string;
  method?: string;
  contentHash?: string;
}

export interface AirGapEnvelopeExpectation extends SignedEnvelopeExpectation {
  contractId: string;
  networkPassphrase: string;
}

export type AirGapErrorCode =
  | "invalid-envelope"
  | "hash-mismatch"
  | "network-mismatch"
  | "contract-mismatch"
  | "transaction-mismatch"
  | "missing-signature"
  | "invalid-signature"
  | "invalid-chunks"
  | "incomplete-chunks";

export class AirGapError extends Error {
  constructor(message: string, readonly code: AirGapErrorCode) {
    super(message);
    this.name = "AirGapError";
  }
}

type UnsignedEnvelopeInput = Omit<AirGapUnsignedEnvelope, "schema" | "contentHash">;

type InvokeOperation = {
  type?: string;
  func?: {
    invokeContract?: {
      contractAddress: Parameters<typeof Address.fromScAddress>[0];
      functionName: { bytes: Uint8Array };
    };
  };
};

export async function createUnsignedEnvelope(
  input: UnsignedEnvelopeInput
): Promise<AirGapUnsignedEnvelope> {
  const envelope: AirGapUnsignedEnvelope = {
    schema: AIRGAP_ENVELOPE_SCHEMA,
    contractId: input.contractId,
    networkPassphrase: input.networkPassphrase,
    sourceAccount: input.sourceAccount,
    method: input.method,
    transactionXdr: input.transactionXdr,
    contentHash: "0".repeat(64),
  };
  validateEnvelopeShape(envelope);
  assertEnvelopeTransaction(envelope);
  envelope.contentHash = await hashEnvelopeContent(envelope);
  assertSerializedSize(canonicalJson(envelope));
  return envelope;
}

export async function exportUnsignedEnvelope(
  input: AirGapUnsignedEnvelope | string
): Promise<string> {
  const envelope = await parseUnsignedEnvelope(input);
  return canonicalJson(envelope);
}

export async function parseUnsignedEnvelope(
  input: AirGapUnsignedEnvelope | string
): Promise<AirGapUnsignedEnvelope> {
  const value = typeof input === "string" ? parseJson(input) : input;
  const envelope = copyEnvelope(value);
  validateEnvelopeShape(envelope);
  assertEnvelopeTransaction(envelope);
  const expected = await hashEnvelopeContent(envelope);
  if (envelope.contentHash !== expected) {
    throw new AirGapError("unsigned envelope content hash does not match", "hash-mismatch");
  }
  assertSerializedSize(canonicalJson(envelope));
  return envelope;
}

export async function importSignedEnvelope(
  unsignedInput: AirGapUnsignedEnvelope | string,
  signedTransactionXdr: string,
  expected: AirGapEnvelopeExpectation
): Promise<AirGapSignedEnvelope> {
  const unsigned = await parseUnsignedEnvelope(unsignedInput);
  assertExpectedContext(unsigned, expected);
  const signed: AirGapSignedEnvelope = {
    ...unsigned,
    signedTransactionXdr,
  };
  validateEnvelopeShape(signed);
  assertSerializedSize(canonicalJson(signed));
  await assertSignedTransaction(signed);
  return signed;
}

export async function verifySignedEnvelope(
  input: AirGapSignedEnvelope,
  expected: AirGapEnvelopeExpectation
): Promise<AirGapSignedEnvelope> {
  const signed = copyEnvelope(input) as AirGapSignedEnvelope;
  validateEnvelopeShape(signed);
  assertExpectedContext(signed, expected);
  const signedTransactionXdr = signed.signedTransactionXdr;
  const { signedTransactionXdr: _signed, ...unsigned } = signed;
  const parsed = await parseUnsignedEnvelope(unsigned);
  await assertSignedTransaction({ ...parsed, signedTransactionXdr });
  assertSerializedSize(canonicalJson({ ...parsed, signedTransactionXdr }));
  return { ...parsed, signedTransactionXdr };
}

export interface QrChunkOptions {
  chunkSize?: number;
  maxChunks?: number;
}

export async function encodeQrChunks(
  serializedEnvelope: string,
  options: QrChunkOptions = {}
): Promise<string[]> {
  const chunkSize = options.chunkSize ?? DEFAULT_QR_CHUNK_SIZE;
  const maxChunks = options.maxChunks ?? MAX_QR_CHUNKS;
  if (!Number.isInteger(chunkSize) || chunkSize < 128 || chunkSize > 4096) {
    throw new AirGapError("QR chunkSize must be an integer between 128 and 4096", "invalid-chunks");
  }
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_QR_CHUNKS) {
    throw new AirGapError(`maxChunks must be an integer between 1 and ${MAX_QR_CHUNKS}`, "invalid-chunks");
  }
  const bytes = new TextEncoder().encode(serializedEnvelope);
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw new AirGapError("serialized envelope exceeds the QR transport limit", "invalid-chunks");
  }
  const payload = toBase64Url(bytes);
  const digest = await sha256(bytes);
  const total = Math.ceil(payload.length / chunkSize);
  if (total > maxChunks) {
    throw new AirGapError(`envelope needs ${total} chunks, exceeding maxChunks=${maxChunks}`, "invalid-chunks");
  }
  return Array.from({ length: total }, (_, index) => {
    const data = payload.slice(index * chunkSize, (index + 1) * chunkSize);
    return `${QR_PREFIX}:${index}:${total}:${digest}:${data}`;
  });
}

export async function decodeQrChunks(chunks: readonly string[]): Promise<string> {
  if (chunks.length === 0) {
    throw new AirGapError("no QR chunks were supplied", "incomplete-chunks");
  }
  if (chunks.length > MAX_QR_CHUNKS) {
    throw new AirGapError("too many QR chunks", "invalid-chunks");
  }
  const parts = new Map<number, string>();
  let total: number | undefined;
  let digest: string | undefined;
  for (const chunk of chunks) {
    if (typeof chunk !== "string" || chunk.length > 5000) {
      throw new AirGapError("QR chunk is not a bounded string", "invalid-chunks");
    }
    const match = /^sp-airgap-v1:(\d+):(\d+):([0-9a-f]{64}):([A-Za-z0-9_-]+)$/.exec(chunk);
    if (!match) throw new AirGapError("malformed QR chunk", "invalid-chunks");
    const index = Number(match[1]);
    const chunkTotal = Number(match[2]);
    const chunkDigest = match[3]!;
    const data = match[4]!;
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(chunkTotal) ||
        chunkTotal < 1 || chunkTotal > MAX_QR_CHUNKS || index >= chunkTotal) {
      throw new AirGapError("QR chunk index or total is invalid", "invalid-chunks");
    }
    if (total !== undefined && (total !== chunkTotal || digest !== chunkDigest)) {
      throw new AirGapError("QR chunks belong to different envelopes", "invalid-chunks");
    }
    total = chunkTotal;
    digest = chunkDigest;
    const previous = parts.get(index);
    if (previous !== undefined && previous !== data) {
      throw new AirGapError(`conflicting QR chunk ${index}`, "invalid-chunks");
    }
    parts.set(index, data);
  }
  const expectedTotal = total;
  if (expectedTotal === undefined || parts.size !== expectedTotal) {
    const missing = Array.from({ length: expectedTotal ?? 0 }, (_, index) => index)
      .filter((index) => !parts.has(index));
    throw new AirGapError(`missing QR chunks: ${missing.join(", ")}`, "incomplete-chunks");
  }
  const payload = Array.from({ length: expectedTotal }, (_, index) => parts.get(index)!).join("");
  if (payload.length > Math.ceil(MAX_ENVELOPE_BYTES / 3) * 4) {
    throw new AirGapError("reassembled QR payload exceeds the transport limit", "invalid-chunks");
  }
  const bytes = fromBase64Url(payload);
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw new AirGapError("reassembled QR payload exceeds the transport limit", "invalid-chunks");
  }
  if ((await sha256(bytes)) !== digest) {
    throw new AirGapError("reassembled QR payload hash does not match", "hash-mismatch");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AirGapError("reassembled QR payload is not valid UTF-8", "invalid-chunks");
  }
}

function validateEnvelopeShape(value: unknown): asserts value is AirGapUnsignedEnvelope | AirGapSignedEnvelope {
  if (!isRecord(value)) throw new AirGapError("envelope must be an object", "invalid-envelope");
  const allowed = new Set([
    "schema", "contractId", "networkPassphrase", "sourceAccount", "method",
    "transactionXdr", "contentHash", "signedTransactionXdr",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AirGapError("envelope contains unknown fields", "invalid-envelope");
  }
  if (value.schema !== AIRGAP_ENVELOPE_SCHEMA) {
    throw new AirGapError(`unsupported envelope schema: ${String(value.schema)}`, "invalid-envelope");
  }
  boundedString(value.contractId, "contractId", 56);
  boundedString(value.networkPassphrase, "networkPassphrase", 512);
  boundedString(value.sourceAccount, "sourceAccount", 56);
  boundedString(value.method, "method", 128);
  boundedString(value.transactionXdr, "transactionXdr", MAX_ENVELOPE_BYTES);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.method)) {
    throw new AirGapError("method is not a Soroban function name", "invalid-envelope");
  }
  if (typeof value.contentHash !== "string" || !HASH_PATTERN.test(value.contentHash)) {
    throw new AirGapError("contentHash must be 64 lowercase hex characters", "invalid-envelope");
  }
  if ("signedTransactionXdr" in value) {
    boundedString(value.signedTransactionXdr, "signedTransactionXdr", MAX_ENVELOPE_BYTES);
  }
}

function assertExpectedContext(
  envelope: AirGapUnsignedEnvelope,
  expected: AirGapEnvelopeExpectation
): void {
  if (envelope.networkPassphrase !== expected.networkPassphrase) {
    throw new AirGapError("envelope is bound to a different Stellar network", "network-mismatch");
  }
  if (envelope.contractId !== expected.contractId) {
    throw new AirGapError("envelope targets a different StreamPay contract", "contract-mismatch");
  }
  if (expected.sourceAccount !== undefined && envelope.sourceAccount !== expected.sourceAccount) {
    throw new AirGapError("envelope source account does not match the expected source", "transaction-mismatch");
  }
  if (expected.method !== undefined && envelope.method !== expected.method) {
    throw new AirGapError("envelope method does not match the expected method", "transaction-mismatch");
  }
  if (expected.contentHash !== undefined && envelope.contentHash !== expected.contentHash) {
    throw new AirGapError("envelope content hash does not match the expected hash", "hash-mismatch");
  }
}

function assertEnvelopeTransaction(envelope: AirGapUnsignedEnvelope): void {
  let transaction: Transaction | FeeBumpTransaction;
  try {
    transaction = TransactionBuilder.fromXDR(envelope.transactionXdr, envelope.networkPassphrase);
  } catch {
    throw new AirGapError("transactionXdr is not valid for the declared network", "invalid-envelope");
  }
  if (!(transaction instanceof Transaction) || transaction.source !== envelope.sourceAccount) {
    throw new AirGapError("transaction source does not match sourceAccount", "transaction-mismatch");
  }
  if (transaction.operations.length !== 1) {
    throw new AirGapError("air-gap envelopes must contain exactly one operation", "transaction-mismatch");
  }
  const operation = transaction.operations[0] as unknown as InvokeOperation;
  const invoke = operation.func?.invokeContract;
  if (operation.type !== "invokeHostFunction" || invoke === undefined) {
    throw new AirGapError("air-gap envelopes must contain an invokeContract operation", "transaction-mismatch");
  }
  const contractId = Address.fromScAddress(invoke.contractAddress).toString();
  const method = new TextDecoder().decode(invoke.functionName.bytes);
  if (contractId !== envelope.contractId || method !== envelope.method) {
    throw new AirGapError("transaction contract or method does not match the envelope", "transaction-mismatch");
  }
}

async function assertSignedTransaction(envelope: AirGapSignedEnvelope): Promise<void> {
  const unsigned = TransactionBuilder.fromXDR(envelope.transactionXdr, envelope.networkPassphrase);
  let signed: Transaction | FeeBumpTransaction;
  try {
    signed = TransactionBuilder.fromXDR(envelope.signedTransactionXdr, envelope.networkPassphrase);
  } catch {
    throw new AirGapError("signedTransactionXdr is not valid for the declared network", "invalid-envelope");
  }
  if (!(signed instanceof Transaction)) {
    throw new AirGapError("signed envelope must be a standard transaction", "transaction-mismatch");
  }
  const unsignedBody = unsigned.toEnvelope().value.tx.toXDR("base64");
  const signedBody = signed.toEnvelope().value.tx.toXDR("base64");
  if (unsignedBody !== signedBody) {
    throw new AirGapError("signing changed the unsigned transaction body", "transaction-mismatch");
  }
  const signatures = signed.toEnvelope().value.signatures;
  if (signatures.length === 0) {
    throw new AirGapError("signed transaction contains no signatures", "missing-signature");
  }
  const source = Keypair.fromPublicKey(signed.source);
  const expectedHint = source.signatureHint();
  if (!signatures.some(({ hint, signature }) =>
    equalBytes(hint.value, expectedHint) && source.verify(signed.hash(), signature.value)
  )) {
    throw new AirGapError("signed transaction has no valid source-account signature", "invalid-signature");
  }
}

async function hashEnvelopeContent(envelope: AirGapUnsignedEnvelope): Promise<string> {
  const { contentHash: _contentHash, ...content } = envelope;
  return sha256(new TextEncoder().encode(canonicalJson(content)));
}

function copyEnvelope(value: unknown): AirGapUnsignedEnvelope | AirGapSignedEnvelope {
  if (!isRecord(value)) return value as AirGapUnsignedEnvelope;
  return { ...value } as unknown as AirGapUnsignedEnvelope | AirGapSignedEnvelope;
}

function parseJson(serialized: string): unknown {
  if (typeof serialized !== "string" || serialized.length === 0 ||
      new TextEncoder().encode(serialized).byteLength > MAX_ENVELOPE_BYTES) {
    throw new AirGapError("serialized envelope is empty or too large", "invalid-envelope");
  }
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new AirGapError("envelope is not valid JSON", "invalid-envelope");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedString(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AirGapError(`${name} must be a non-empty string of at most ${maxLength} characters`, "invalid-envelope");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSerializedSize(serialized: string): void {
  if (new TextEncoder().encode(serialized).byteLength > MAX_ENVELOPE_BYTES) {
    throw new AirGapError("serialized envelope exceeds the transport limit", "invalid-envelope");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new AirGapError("WebCrypto SHA-256 is unavailable", "invalid-envelope");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const value = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    if (index + 1 < bytes.length) output += alphabet[(value >>> 6) & 63];
    if (index + 2 < bytes.length) output += alphabet[value & 63];
  }
  return output;
}

function fromBase64Url(payload: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  if (payload.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new AirGapError("QR payload is not valid unpadded base64url", "invalid-chunks");
  }
  const output = new Uint8Array(Math.floor(payload.length * 6 / 8));
  let offset = 0;
  let accumulator = 0;
  let bits = 0;
  for (const character of payload) {
    const value = alphabet.indexOf(character);
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (accumulator >>> bits) & 255;
    }
  }
  return output;
}
