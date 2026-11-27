/**
 * Typed StreamPay client.
 *
 * Mutating calls follow the same pipeline as the StreamPay frontend:
 * build → simulate → sign → send → poll for inclusion → decode. Read-only
 * calls simulate without a signer, using a syntactically valid dummy source.
 */
import {
  Account,
  Contract,
  Keypair,
  Networks,
  type FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  createUnsignedEnvelope,
  importSignedEnvelope,
  verifySignedEnvelope,
  type AirGapSignedEnvelope,
  type AirGapUnsignedEnvelope,
  type SignedEnvelopeExpectation,
} from "./airgap.js";
import { MAX_PAGE_SIZE, type Stream } from "./generated.js";
import { StreamPayMethods } from "./methods.js";
import { StreamPayError } from "./errors.js";
import {
  isTransientError,
  pause,
  resolveRetryPolicy,
  systemClock,
  withRetry,
  type Clock,
  type ResolvedRetryPolicy,
  type SubmitRetryPolicy,
} from "./retry.js";
import { collectPages, type IndexRole } from "./pagination.js";
import { sdkTelemetry } from "./telemetry.js";
import { subscribeEvents as createEventSubscription, type SubscribeEventsOptions, type StreamFeedEvent } from "./subscription.js";

/** Wallet adapter: Freighter, a server keypair, or a hardware signer. */
export interface Signer {
  publicKey(): string;
  signTransaction(
    envelopeXdr: string,
    options: { networkPassphrase: string }
  ): Promise<{ signedTxXdr: string }>;
}

/** Adapts a `Keypair` (e.g. a bot key) to the {@link Signer} interface. */
export function signerFromKeypair(keypair: Keypair): Signer {
  return {
    publicKey: () => keypair.publicKey(),
    async signTransaction(envelopeXdr, { networkPassphrase }) {
      const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR() };
    },
  };
}

export interface StreamPayClientOptions {
  rpcUrl?: string;
  contractId: string;
  networkPassphrase?: string;
  signer?: Signer;
  /** Injected for tests; defaults to `new rpc.Server(rpcUrl)`. */
  server?: rpc.Server;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Base URL for the indexer SSE event feed. */
  eventFeedUrl?: string;
  /**
   * Opt-in retry policy for mutating calls. Off by default: without it every
   * failure surfaces exactly as before. `true` uses the defaults
   * (3 attempts, 250 ms base, 5 s cap, full jitter). See the README's
   * "Retrying submissions" section for the safety argument.
   */
  retry?: SubmitRetryPolicy | boolean;
  /** Injected for tests; defaults to the system clock and timers. */
  clock?: Clock;
}

/** ed25519 all-zero key: valid source for simulations, never signs. */
const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

export interface BuildUnsignedOptions {
  method: string;
  args: xdr.ScVal[];
  sourceAccount: string;
  /** Expiry window for transport to an offline signer; defaults to one hour. */
  timeoutSeconds?: number;
}

export interface ImportSignedOptions {
  unsignedEnvelope: AirGapUnsignedEnvelope | string;
  signedTransactionXdr: string;
  /** Optional out-of-band pin for the original source, method, or content hash. */
  expected?: SignedEnvelopeExpectation;
}

export interface SubmitSignedOptions {
  /** Recheck the original context before using the idempotent submission pipeline. */
  expected?: SignedEnvelopeExpectation;
}

export class StreamPayClient extends StreamPayMethods {
  readonly contractId: string;
  readonly networkPassphrase: string;
  private readonly server: rpc.Server;
  private readonly signer?: Signer;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly eventFeedUrl: string | undefined;
  private readonly retry: ResolvedRetryPolicy;
  private readonly clock: Clock;

  constructor(options: StreamPayClientOptions) {
    super();
    if (!options.contractId) throw new Error("contractId is required");
    this.contractId = options.contractId;
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    this.server = options.server ?? new rpc.Server(options.rpcUrl ?? "https://soroban-testnet.stellar.org");
    if (options.signer !== undefined) this.signer = options.signer;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
    this.eventFeedUrl = options.eventFeedUrl;
    this.retry = resolveRetryPolicy(options.retry);
    this.clock = options.clock ?? systemClock;
  }

  /** Streams typed feed events for a stream, resuming after `fromCursor`. */
  subscribeEvents(
    streamId: bigint | number | string,
    options: Omit<SubscribeEventsOptions, "eventFeedUrl"> & { eventFeedUrl?: string } = {}
  ): AsyncGenerator<StreamFeedEvent> {
    const eventFeedUrl = options.eventFeedUrl ?? this.eventFeedUrl;
    if (!eventFeedUrl) {
      throw new Error("eventFeedUrl is required to subscribe to stream events");
    }
    return createEventSubscription(streamId, { ...options, eventFeedUrl });
  }

  // ------------------------------------------------------------- pagination
  /** One page of ids from the on-chain sender/recipient index. */
  async streamIdsPage(
    role: IndexRole,
    address: string,
    offset: number,
    limit: number = MAX_PAGE_SIZE
  ): Promise<bigint[]> {
    if (role === "sender") {
      return this.senderStreams({ sender: address, offset, limit });
    }
    return this.recipientStreams({ recipient: address, offset, limit });
  }

  /** Every indexed stream id for `address`, following pages to exhaustion. */
  streamIds(role: IndexRole, address: string): Promise<bigint[]> {
    return collectPages((offset, limit) => this.streamIdsPage(role, address, offset, limit));
  }

  /**
   * Loads every stream for `address`. Ids that no longer resolve (read
   * failures, archived state) are skipped, matching the frontend's discovery
   * behaviour.
   */
  async streamsFor(role: IndexRole, address: string): Promise<Stream[]> {
    const ids = await this.streamIds(role, address);
    const streams: Stream[] = [];
    for (const id of ids) {
      try {
        streams.push(await this.getStream({ streamId: id }));
      } catch {
        // A stale index entry must not hide the rest of the portfolio.
      }
    }
    return streams;
  }

  /** Builds a hash-bound, signed-by-nobody envelope for offline signing. */
  async buildUnsigned(options: BuildUnsignedOptions): Promise<AirGapUnsignedEnvelope> {
    const timeoutSeconds = options.timeoutSeconds ?? 3_600;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 2_592_000) {
      throw new RangeError("timeoutSeconds must be an integer between 1 and 2592000");
    }
    const { transaction, simulated } = await this.prepare(
      options.method,
      options.args,
      options.sourceAccount,
      true,
      timeoutSeconds,
      true
    );
    const ready = rpc.assembleTransaction(transaction, simulated).build();
    return createUnsignedEnvelope({
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
      sourceAccount: options.sourceAccount,
      method: options.method,
      transactionXdr: ready.toXDR(),
    });
  }

  /** Verifies externally signed bytes against the exact prepared transaction. */
  async importSigned(options: ImportSignedOptions): Promise<AirGapSignedEnvelope> {
    return importSignedEnvelope(
      options.unsignedEnvelope,
      options.signedTransactionXdr,
      {
        ...options.expected,
        contractId: this.contractId,
        networkPassphrase: this.networkPassphrase,
      }
    );
  }

  /** Submits an imported envelope using the normal idempotent retry pipeline. */
  async submitSigned<T>(
    envelope: AirGapSignedEnvelope,
    decode: (value: xdr.ScVal) => T,
    options: SubmitSignedOptions = {}
  ): Promise<T> {
    return sdkTelemetry.track(envelope.method, async () => {
      const verified = await verifySignedEnvelope(envelope, {
        ...options.expected,
        contractId: this.contractId,
        networkPassphrase: this.networkPassphrase,
      });
      const signed = TransactionBuilder.fromXDR(
        verified.signedTransactionXdr,
        this.networkPassphrase
      );
      if (!(signed instanceof Transaction)) {
        throw new StreamPayError(
          "imported envelope must contain a standard transaction",
          "submission",
          { transactionXdr: verified.signedTransactionXdr }
        );
      }
      const hash = await this.submit(signed);
      return this.confirmAndDecode(signed, hash, undefined, decode);
    });
  }

  // ----------------------------------------------------------------- internals
  private requireSigner(): Signer {
    if (this.signer === undefined) {
      throw new StreamPayError(
        "a signer is required for mutating calls (pass options.signer)",
        "transport"
      );
    }
    return this.signer;
  }

  protected async call<T>(
    method: string,
    args: xdr.ScVal[],
    mutating: boolean,
    decode: (value: xdr.ScVal) => T
  ): Promise<T> {
    // Opt-in telemetry (#595) wraps the whole pipeline so it sees one method
    // name, one outcome and one latency bucket. It is disabled by default and
    // never changes the result or the error.
    return sdkTelemetry.track(method, () => this.invoke(method, args, mutating, decode));
  }

  private async prepare(
    method: string,
    args: xdr.ScVal[],
    source: string,
    mutating: boolean,
    timeoutSeconds = 60,
    boundedWindow = false
  ): Promise<{
    transaction: Transaction;
    simulated: rpc.Api.SimulateTransactionSuccessResponse;
    simulatedValue: xdr.ScVal;
  }> {
    let account: Account;
    try {
      account = mutating
        ? await withRetry("account", this.retry, this.clock, () =>
            this.server.getAccount(source)
          )
        : new Account(source, "0");
    } catch (error) {
      throw StreamPayError.fromRpc("transport", messageOf(error));
    }

    const operation = new Contract(this.contractId).call(method, ...args);
    const builder = new TransactionBuilder(account, {
      fee: mutating ? "1000000" : "100",
      networkPassphrase: this.networkPassphrase,
    }).addOperation(operation);
    if (boundedWindow) {
      const now = Math.floor(this.clock.now() / 1_000);
      builder.setTimebounds(now, now + timeoutSeconds);
    } else {
      builder.setTimeout(timeoutSeconds);
    }
    const transaction = builder.build();

    // Nothing has been signed or sent yet, so a transient preflight failure is
    // always safe to repeat.
    const simulation = await withRetry("simulation", this.retry, this.clock, () =>
      this.server.simulateTransaction(transaction)
    );
    if (rpc.Api.isSimulationError(simulation)) {
      throw StreamPayError.fromRpc("simulation", simulation.error, transaction.toXDR());
    }

    const simulated = simulation as rpc.Api.SimulateTransactionSuccessResponse;
    const simulatedValue = simulated.result?.retval;
    if (simulatedValue === undefined) {
      throw new StreamPayError(
        "simulation returned no value",
        "simulation",
        { transactionXdr: transaction.toXDR() }
      );
    }
    return { transaction, simulated, simulatedValue };
  }

  private async invoke<T>(
    method: string,
    args: xdr.ScVal[],
    mutating: boolean,
    decode: (value: xdr.ScVal) => T
  ): Promise<T> {
    const signer = mutating ? this.requireSigner() : undefined;
    const source = signer === undefined ? DUMMY_SOURCE.accountId() : signer.publicKey();
    const prepared = await this.prepare(method, args, source, mutating);
    if (!mutating) {
      return this.safeDecode(decode, prepared.simulatedValue, prepared.transaction.toXDR());
    }

    const ready = rpc.assembleTransaction(prepared.transaction, prepared.simulated).build();
    const signedXdr = await signer!.signTransaction(ready.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signed = TransactionBuilder.fromXDR(
      signedXdr.signedTxXdr,
      this.networkPassphrase
    );
    const hash = await this.submit(signed);
    return this.confirmAndDecode(
      signed,
      hash,
      prepared.simulatedValue,
      decode
    );
  }

  private async confirmAndDecode<T>(
    signed: Transaction | FeeBumpTransaction,
    hash: string,
    simulatedValue: xdr.ScVal | undefined,
    decode: (value: xdr.ScVal) => T
  ): Promise<T> {
    const deadline = this.clock.now() + this.pollTimeoutMs;
    while (this.clock.now() < deadline) {
      await this.clock.sleep(this.pollIntervalMs);
      let result: rpc.Api.GetTransactionResponse;
      try {
        result = await this.server.getTransaction(hash);
      } catch (error) {
        // With a policy, a flaky status read is not a verdict on the
        // transaction: keep polling until the deadline.
        if (this.retry.maxAttempts > 1 && isTransientError(error)) continue;
        throw error;
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw StreamPayError.fromRpc(
          "inclusion",
          `transaction ${hash} failed: ${JSON.stringify(result.resultXdr)}`,
          signed.toXDR()
        );
      }
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const returned = (result as { returnValue?: xdr.ScVal }).returnValue;
        const value = returned ?? simulatedValue;
        if (value === undefined) {
          throw new StreamPayError(
            "included transaction returned no value",
            "inclusion",
            { transactionXdr: signed.toXDR(), transactionHash: hash }
          );
        }
        return this.safeDecode(decode, value, signed.toXDR());
      }
    }
    // Submitted but unconfirmed: the outcome is unknown, so this is never
    // retried. Callers reconcile with `transactionHash` instead of resending.
    throw new StreamPayError(
      `timed out after ${this.pollTimeoutMs}ms waiting for ${hash}`,
      "inclusion",
      { transactionXdr: signed.toXDR(), transactionHash: hash }
    );
  }

  /**
   * Sends a signed envelope and returns its hash once the RPC has accepted it
   * (or already knows it). Retries only resend the same bytes, and only after
   * checking whether an earlier, unanswered attempt already landed, so a
   * retry can never produce a second transaction.
   */
  private async submit(signed: Transaction | FeeBumpTransaction): Promise<string> {
    const hash = toHex(signed.hash());
    const retrying = this.retry.maxAttempts > 1;
    // True once an attempt went unanswered and may have reached the network.
    let maybeSent = false;
    for (let attempt = 1; ; attempt += 1) {
      let sent: rpc.Api.SendTransactionResponse;
      try {
        sent = await this.server.sendTransaction(signed);
      } catch (error) {
        if (attempt >= this.retry.maxAttempts || !isTransientError(error)) throw error;
        maybeSent = true;
        await pause("submission", this.retry, this.clock, attempt, error);
        if (await this.isKnown(hash)) return hash;
        continue;
      }

      if (sent.status === "ERROR") {
        // After an unanswered attempt, a rejection such as `tx_bad_seq` can
        // mean our own earlier send consumed the sequence number.
        if (maybeSent && (await this.isKnown(hash))) return hash;
        throw StreamPayError.fromRpc(
          "submission",
          `sendTransaction: ${JSON.stringify(sent.errorResult)}`,
          signed.toXDR()
        );
      }

      if (sent.status === "TRY_AGAIN_LATER" && retrying) {
        // The node refused to queue it: nothing was submitted.
        if (attempt >= this.retry.maxAttempts) {
          throw new StreamPayError(
            `sendTransaction: TRY_AGAIN_LATER after ${attempt} attempts`,
            "submission",
            { transactionXdr: signed.toXDR(), transactionHash: hash }
          );
        }
        await pause("submission", this.retry, this.clock, attempt, sent);
        continue;
      }

      // PENDING, DUPLICATE (already queued — not a second submission), or a
      // TRY_AGAIN_LATER without a policy, which keeps the historical behaviour.
      return sent.hash;
    }
  }

  /** Whether the network already has `hash` (pending, included, or failed). */
  private async isKnown(hash: string): Promise<boolean> {
    try {
      const result = await this.server.getTransaction(hash);
      return result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND;
    } catch {
      // Unknown: resending the identical envelope is still safe.
      return false;
    }
  }

  private safeDecode<T>(
    decode: (value: xdr.ScVal) => T,
    value: xdr.ScVal,
    transactionXdr: string
  ): T {
    try {
      return decode(value);
    } catch (error) {
      throw new StreamPayError(`decode failed: ${messageOf(error)}`, "decode", {
        transactionXdr,
      });
    }
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
