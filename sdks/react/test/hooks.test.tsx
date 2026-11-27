import { Component, Suspense, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  StreamPayClient,
  type Stream,
  type StreamFeedEvent,
  type WalletAccount,
  type WalletCapabilities,
  type WalletStandardAdapter,
} from "@streampay/sdk";
import { StreamPayProvider, useAccrual, useStream, useStreamPay, useStreams, useWallet, useWithdraw } from "../src/index.js";
import { QueryResource, StreamResource, type StreamPayStore } from "../src/store.js";

const fake = vi.hoisted(() => ({
  clients: [] as Array<{ options: Record<string, unknown> }>,
  streams: new Map<string, Stream>(),
  ids: [] as bigint[],
  available: 50n,
  failGetStream: undefined as Error | undefined,
  failGetStreamAfter: Number.POSITIVE_INFINITY,
  failAvailableAfter: Number.POSITIVE_INFINITY,
  availableCalls: 0,
  withdrawError: undefined as Error | undefined,
  getStreamGate: undefined as Promise<void> | undefined,
  withdrawGate: undefined as Promise<void> | undefined,
  waiters: [] as Array<(event: StreamFeedEvent | null) => void>,
  calls: { getStream: [] as string[], withdraw: [] as string[], withdrawMax: [] as string[] },
}));

vi.mock("@streampay/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@streampay/sdk")>();
  class MockStreamPayClient {
    readonly networkPassphrase: string;
    constructor(options: Record<string, unknown>) {
      this.networkPassphrase = typeof options.networkPassphrase === "string"
        ? options.networkPassphrase
        : "Test SDF Network ; September 2015";
      fake.clients.push({ options });
    }
    async getStream({ streamId }: { streamId: bigint }) {
      const id = String(streamId);
      fake.calls.getStream.push(id);
      if (fake.getStreamGate) await fake.getStreamGate;
      if (fake.calls.getStream.length > fake.failGetStreamAfter) {
        throw new Error("stream reconciliation unavailable");
      }
      if (fake.failGetStream) throw fake.failGetStream;
      const stream = fake.streams.get(id);
      if (!stream) throw new Error(`missing stream ${id}`);
      return { ...stream };
    }
    async streamIds() {
      return [...fake.ids];
    }
    async available() {
      fake.availableCalls += 1;
      if (fake.availableCalls > fake.failAvailableAfter) {
        throw new Error("accrual reconciliation unavailable");
      }
      return fake.available;
    }
    async withdraw({ streamId, amount }: { streamId: bigint; amount: bigint }) {
      const id = String(streamId);
      fake.calls.withdraw.push(id);
      if (fake.withdrawGate) await fake.withdrawGate;
      if (fake.withdrawError) throw fake.withdrawError;
      const stream = fake.streams.get(id)!;
      fake.streams.set(id, { ...stream, withdrawn: stream.withdrawn + amount });
    }
    async withdrawMax({ streamId }: { streamId: bigint }) {
      const id = String(streamId);
      fake.calls.withdrawMax.push(id);
      if (fake.withdrawGate) await fake.withdrawGate;
      if (fake.withdrawError) throw fake.withdrawError;
      const stream = fake.streams.get(id)!;
      const amount = fake.available;
      const withdrawn = stream.withdrawn + amount;
      fake.streams.set(id, {
        ...stream,
        withdrawn,
        status: withdrawn >= stream.deposit ? "Depleted" : stream.status,
      });
      fake.available = 0n;
      return amount;
    }
    async *subscribeEvents(_streamId: bigint, options: { signal: AbortSignal }) {
      while (!options.signal.aborted) {
        const event = await new Promise<StreamFeedEvent | null>((resolve) => {
          fake.waiters.push(resolve);
          options.signal.addEventListener("abort", () => resolve(null), { once: true });
        });
        if (event) yield event;
      }
    }
  }
  return { ...actual, StreamPayClient: MockStreamPayClient };
});

const contractId = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";

function stream(id: bigint, withdrawn = 10n): Stream {
  return {
    id,
    sender: "GSENDER",
    recipient: "GRECIPIENT",
    token: "CTOKEN",
    deposit: 100n,
    withdrawn,
    startTime: 1n,
    endTime: 2n,
    cancelable: true,
    status: "Active",
    useOracle: null,
  };
}

function provider(children: ReactNode, eventFeedUrl?: string) {
  return (
    <StreamPayProvider
      client={new StreamPayClient({ contractId })}
      {...(eventFeedUrl === undefined ? {} : { eventFeedUrl })}
    >
      {children}
    </StreamPayProvider>
  );
}

let activeStore: StreamPayStore | undefined;

function StoreCapture() {
  activeStore = useStreamPay().store;
  return null;
}

function StreamView({ id = 1n }: { id?: bigint }) {
  const value = useStream(id);
  return <div>stream {String(value.id)} withdrawn {String(value.withdrawn)} {value.status}</div>;
}

function StreamsView() {
  const streams = useStreams("recipient", "GRECIPIENT");
  return <div>{streams.map((value) => <span key={String(value.id)}>list {String(value.id)} {String(value.withdrawn)}</span>)}</div>;
}

function AccrualView() {
  const { amount, refresh } = useAccrual(1n, { pollIntervalMs: 20 });
  return <button onClick={() => void refresh()}>accrual {String(amount)}</button>;
}

function WithdrawView() {
  const value = useStream(1n);
  const accrual = useAccrual(1n, { pollIntervalMs: 0 });
  const withdrawal = useWithdraw(1n);
  return (
    <div>
      <span>withdraw view {String(value.withdrawn)} {value.status}</span>
      <span>available {String(accrual.amount)}</span>
      <button onClick={() => void withdrawal.withdrawMax().catch(() => undefined)}>
        {withdrawal.pending ? "pending" : "withdraw"}
      </button>
      {withdrawal.error && <span>error {withdrawal.error.message}</span>}
    </div>
  );
}

function WalletView() {
  const wallet = useWallet();
  const withdrawal = useWithdraw(1n);
  return (
    <div>
      <button onClick={() => void wallet.connect().catch(() => undefined)}>
        {wallet.connecting ? "connecting" : wallet.connected ? wallet.account?.address : "connect"}
      </button>
      <button onClick={() => void withdrawal.withdrawMax().catch(() => undefined)}>wallet withdraw</button>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | undefined }> {
  state = { error: undefined as Error | undefined };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <div>boundary {this.state.error.message}</div> : this.props.children;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function renderAsync(ui: ReactNode) {
  await act(async () => {
    render(ui);
  });
}

beforeEach(() => {
  activeStore = undefined;
  fake.clients.length = 0;
  fake.streams.clear();
  fake.ids = [1n];
  fake.available = 50n;
  fake.failGetStream = undefined;
  fake.failGetStreamAfter = Number.POSITIVE_INFINITY;
  fake.failAvailableAfter = Number.POSITIVE_INFINITY;
  fake.availableCalls = 0;
  fake.withdrawError = undefined;
  fake.getStreamGate = undefined;
  fake.withdrawGate = undefined;
  fake.waiters.length = 0;
  fake.calls.getStream.length = 0;
  fake.calls.withdraw.length = 0;
  fake.calls.withdrawMax.length = 0;
  fake.streams.set("1", stream(1n));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("React StreamPay hooks", () => {
  test("useStream suspends and resolves typed stream state", async () => {
    const gate = deferred();
    fake.getStreamGate = gate.promise;
    await renderAsync(<Suspense fallback={<div>loading</div>}>{provider(<StreamView />)}</Suspense>);
    expect(screen.getByText("loading")).toBeTruthy();
    await act(async () => gate.resolve());
    expect(await screen.findByText("stream 1 withdrawn 10 Active")).toBeTruthy();
  });

  test("query failures cross the React error boundary", async () => {
    fake.failGetStream = new Error("RPC unavailable");
    await renderAsync(<ErrorBoundary><Suspense fallback={<div>loading</div>}>{provider(<StreamView />)}</Suspense></ErrorBoundary>);
    expect(await screen.findByText("boundary RPC unavailable")).toBeTruthy();
  });

  test("a successful refresh recovers the Suspense promise after an initial failure", async () => {
    fake.failGetStream = new Error("RPC unavailable");
    const tree = (key: number) => provider(
      <>
        <StoreCapture />
        <ErrorBoundary key={key}>
          <Suspense fallback={<div>loading</div>}><StreamView /></Suspense>
        </ErrorBoundary>
      </>
    );
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(tree(1)); });
    expect(await screen.findByText("boundary RPC unavailable")).toBeTruthy();
    fake.failGetStream = undefined;
    await act(async () => { await activeStore!.stream(1n).refresh(); });
    await act(async () => { view.rerender(tree(2)); });
    expect(await screen.findByText("stream 1 withdrawn 10 Active")).toBeTruthy();
  });

  test("overlapping refreshes are sequenced so older responses cannot overwrite newer state", async () => {
    const initial = deferredValue<number>();
    const first = deferredValue<number>();
    const second = deferredValue<number>();
    const responses = [initial.promise, first.promise, second.promise];
    let calls = 0;
    const resource = new QueryResource(() => responses[calls++]!);
    const firstRefresh = resource.refresh();
    const secondRefresh = resource.refresh();
    expect(calls).toBe(1);
    initial.resolve(0);
    await vi.waitFor(() => expect(calls).toBe(2));
    first.resolve(1);
    await firstRefresh;
    expect(resource.getSnapshot()).toBe(1);
    await vi.waitFor(() => expect(calls).toBe(3));
    second.resolve(2);
    await secondRefresh;
    expect(resource.getSnapshot()).toBe(2);
  });

  test("a stale stream response cannot clear a newer optimistic withdrawal", async () => {
    const responses = [
      Promise.resolve(stream(1n)),
      Promise.resolve(stream(1n)),
      Promise.resolve(stream(1n, 60n)),
      Promise.resolve(stream(1n, 70n)),
    ];
    let calls = 0;
    const resource = new StreamResource(() => responses[calls++]!);
    await resource.promise;
    resource.applyOptimistic(stream(1n, 60n));
    await resource.refresh();
    expect(resource.getSnapshot().withdrawn).toBe(60n);
    await resource.refresh();
    await resource.refresh();
    expect(resource.getSnapshot().withdrawn).toBe(70n);
  });

  test("useStreams reconciles optimistic state from indexer SSE", async () => {
    fake.ids = [1n, 2n];
    fake.streams.set("2", stream(2n, 20n));
    await renderAsync(<Suspense fallback={<div>loading</div>}>{provider(<StreamsView />, "https://indexer.test/events")}</Suspense>);
    expect(await screen.findByText("list 1 10")).toBeTruthy();
    expect(screen.getByText("list 2 20")).toBeTruthy();
    fake.streams.set("1", stream(1n, 35n));
    await act(async () => {
      for (const resolve of fake.waiters.splice(0)) {
        resolve({
          id: "event-1",
          cursor: "event-1",
          type: "Withdrawn",
          streamId: "1",
          ledger: 1,
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          data: {},
        });
      }
    });
    expect(await screen.findByText("list 1 35")).toBeTruthy();
  });

  test("useAccrual refreshes on the configured polling interval", async () => {
    await renderAsync(<Suspense fallback={<div>loading</div>}>{provider(<AccrualView />)}</Suspense>);
    expect(await screen.findByText("accrual 50")).toBeTruthy();
    fake.available = 75n;
    expect(await screen.findByText("accrual 75")).toBeTruthy();
  });

  test("useWithdraw applies optimistic state and reconciles the confirmed result", async () => {
    const gate = deferred();
    fake.withdrawGate = gate.promise;
    await renderAsync(<Suspense fallback={<div>loading</div>}>{provider(<WithdrawView />)}</Suspense>);
    expect(await screen.findByText("withdraw view 10 Active")).toBeTruthy();
    fireEvent.click(screen.getByText("withdraw"));
    expect(await screen.findByText("withdraw view 60 Active")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    await act(async () => gate.resolve());
    await waitFor(() => expect(screen.getByText("withdraw")).toBeTruthy());
    expect(screen.getByText("withdraw view 60 Active")).toBeTruthy();
    expect(fake.calls.withdrawMax).toEqual(["1"]);
    expect(await screen.findByText("available 0")).toBeTruthy();
  });

  test("useWithdraw keeps confirmed optimistic state when stream reconciliation fails", async () => {
    await renderAsync(<Suspense fallback={<div>loading</div>}>{provider(<WithdrawView />)}</Suspense>);
    expect(await screen.findByText("withdraw view 10 Active")).toBeTruthy();
    fake.failGetStreamAfter = fake.calls.getStream.length;
    fireEvent.click(screen.getByText("withdraw"));
    expect(await screen.findByText("withdraw view 60 Active")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("withdraw")).toBeTruthy());
    expect(screen.getByText("withdraw view 60 Active")).toBeTruthy();
    expect(screen.queryByText(/^error /)).toBeNull();
  });

  test("useWithdraw reconciles the stream even when accrual reconciliation fails", async () => {
    await renderAsync(<Suspense fallback={<div>loading</div>}>{provider(<WithdrawView />)}</Suspense>);
    expect(await screen.findByText("withdraw view 10 Active")).toBeTruthy();
    fake.failAvailableAfter = fake.availableCalls + 1;
    fireEvent.click(screen.getByText("withdraw"));
    expect(await screen.findByText("withdraw view 60 Active")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("withdraw")).toBeTruthy());
    expect(screen.getByText("withdraw view 60 Active")).toBeTruthy();
    expect(screen.queryByText(/^error /)).toBeNull();
  });

  test("useWithdraw rolls optimistic state back when the transaction fails", async () => {
    fake.withdrawError = new Error("signature rejected");
    await renderAsync(<Suspense fallback={<div>loading</div>}>{provider(<WithdrawView />)}</Suspense>);
    expect(await screen.findByText("withdraw view 10 Active")).toBeTruthy();
    fireEvent.click(screen.getByText("withdraw"));
    expect(await screen.findByText("error signature rejected")).toBeTruthy();
    expect(screen.getByText("withdraw view 10 Active")).toBeTruthy();
  });

  test("wallet connection attaches the existing adapter signer to a new SDK client", async () => {
    const account: WalletAccount = { address: "GWALLET", publicKey: "GWALLET" };
    const capabilities: WalletCapabilities = { features: ["signTransaction"], networks: "*" };
    const adapter: WalletStandardAdapter = {
      id: "mock-wallet",
      name: "Mock Wallet",
      async discover() {
        return [{ id: "mock-wallet", name: "Mock Wallet", capabilities }];
      },
      async connect() {
        return account;
      },
      async signTransaction() {
        return { signedTxXdr: "signed" };
      },
      async signAndSubmit() {
        return { hash: "hash" };
      },
      async disconnect() {},
    };
    await renderAsync(
      <StreamPayProvider clientOptions={{ contractId }} wallet={adapter}>
        <Suspense fallback={<div>loading</div>}><WalletView /></Suspense>
      </StreamPayProvider>
    );
    fireEvent.click(await screen.findByText("connect"));
    expect(await screen.findByText("GWALLET")).toBeTruthy();
    expect(fake.clients).toHaveLength(2);
    expect(fake.clients[1]!.options.signer).toBeDefined();
  });
});
