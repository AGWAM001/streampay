"use client";

import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { IndexRole, Int128, Stream, U64 } from "@streampay/sdk";
import { useStreamPay } from "./provider.js";
import { normalizeStreamId } from "./store.js";

export function useStream(streamId: U64): Stream {
  const { store } = useStreamPay();
  const id = normalizeStreamId(streamId);
  const resource = store.stream(id);
  use(resource.promise);
  const stream = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
  useEffect(() => store.watch(id), [id, store]);
  return stream;
}

export function useStreams(role: IndexRole, address: string): Stream[] {
  const { store } = useStreamPay();
  const resource = store.streamsFor(role, address);
  use(resource.promise);
  const streams = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
  useEffect(() => {
    const stops = streams.map((stream) => store.watch(stream.id));
    return () => {
      for (const stop of stops) stop();
    };
  }, [store, streams]);
  return streams;
}

export interface AccrualState {
  amount: bigint;
  refresh(): Promise<bigint>;
}

export interface UseAccrualOptions {
  pollIntervalMs?: number;
}

export function useAccrual(streamId: U64, options: UseAccrualOptions = {}): AccrualState {
  const { store } = useStreamPay();
  const id = normalizeStreamId(streamId);
  const resource = store.accrual(id);
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("pollIntervalMs must be a non-negative finite number");
  }
  use(resource.promise);
  const amount = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
  const refresh = useCallback(() => resource.refresh(), [resource]);
  useEffect(() => store.watch(id), [id, store]);
  useEffect(() => {
    if (pollIntervalMs === 0) return;
    const timer = setInterval(() => {
      void resource.refresh().catch(() => undefined);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [pollIntervalMs, resource]);
  return useMemo(() => ({ amount, refresh }), [amount, refresh]);
}

export interface WithdrawState {
  withdrawMax(): Promise<bigint>;
  withdraw(amount: Int128): Promise<void>;
  pending: boolean;
  error: Error | undefined;
  reset(): void;
}

export function useWithdraw(streamId: U64): WithdrawState {
  const { client, store } = useStreamPay();
  const id = normalizeStreamId(streamId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const busy = useRef(false);

  useEffect(() => store.watch(id), [id, store]);

  const run = useCallback(async (amount: bigint | undefined): Promise<bigint | undefined> => {
    if (busy.current) throw new Error("A withdrawal is already pending for this stream");
    busy.current = true;
    setPending(true);
    setError(undefined);
    let token: number | undefined;
    try {
      await store.stream(id).promise;
      const withdrawn = amount ?? await client.available({ streamId: BigInt(id) });
      token = store.optimisticWithdraw(id, withdrawn);
      const result = amount === undefined
        ? await client.withdrawMax({ streamId: BigInt(id) })
        : await client.withdraw({ streamId: BigInt(id), amount }).then(() => undefined);
      await store.reconcile(id).catch(() => undefined);
      return result;
    } catch (cause) {
      if (token !== undefined) store.clearOptimistic(id, token);
      setError(asError(cause));
      throw cause;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [busy, client, id, store]);

  const withdrawMax = useCallback(() => run(undefined) as Promise<bigint>, [run]);
  const withdraw = useCallback(async (amount: Int128) => {
    await run(toBeBigInt(amount));
  }, [run]);
  const reset = useCallback(() => setError(undefined), []);

  return useMemo(
    () => ({ withdrawMax, withdraw, pending, error, reset }),
    [error, pending, reset, withdraw, withdrawMax]
  );
}

function toBeBigInt(value: Int128): bigint {
  if (typeof value === "bigint") return value;
  if (!/^\d+$/.test(value)) throw new RangeError("amount must be an unsigned integer");
  return BigInt(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
