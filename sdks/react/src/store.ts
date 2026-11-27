import {
  type IndexRole,
  type Stream,
  type StreamPayClient,
  type U64,
} from "@streampay/sdk";

export class QueryResource<T> {
  private suspensePromise: Promise<T>;
  private queue: Promise<unknown>;
  private current: T | undefined;
  private hasValue = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly load: () => Promise<T>) {
    this.suspensePromise = load();
    this.queue = this.suspensePromise.then(() => undefined, () => undefined);
    void this.suspensePromise.then(
      (value) => {
        this.current = value;
        this.hasValue = true;
        this.emit();
      },
      () => undefined
    );
  }

  get promise(): Promise<T> {
    return this.suspensePromise;
  }

  getSnapshot = (): T => this.value();

  getServerSnapshot = (): T => this.value();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh(): Promise<T> {
    const request = this.queue.then(() => this.load());
    this.queue = request.then(() => undefined, () => undefined);
    const value = await request;
    const recoverSuspense = !this.hasValue;
    this.current = value;
    this.hasValue = true;
    if (recoverSuspense) {
      this.suspensePromise = Promise.resolve(value);
    }
    this.emit();
    return value;
  }

  protected value(): T {
    return this.current as T;
  }

  protected set(value: T): void {
    this.current = value;
    this.hasValue = true;
    this.emit();
  }

  protected emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export class StreamResource extends QueryResource<Stream> {
  private optimistic: Stream | undefined;
  private mutation = 0;

  constructor(load: () => Promise<Stream>) {
    super(load);
  }

  override getSnapshot = (): Stream => (this.optimistic ?? this.value()) as Stream;

  override getServerSnapshot = (): Stream => this.getSnapshot();

  committed(): Stream {
    return this.value();
  }

  override async refresh(): Promise<Stream> {
    const stream = await super.refresh();
    const optimistic = this.optimistic;
    if (optimistic === undefined || stream.withdrawn >= optimistic.withdrawn) {
      this.clearOptimistic();
    }
    return stream;
  }

  applyOptimistic(stream: Stream): number {
    this.mutation += 1;
    this.optimistic = stream;
    this.emit();
    return this.mutation;
  }

  clearOptimistic(token?: number): void {
    if (token !== undefined && token !== this.mutation) return;
    this.optimistic = undefined;
    this.emit();
  }
}

class StreamListResource extends QueryResource<Stream[]> {
  private ids: bigint[] = [];
  private readonly unsubscribe: Array<() => void> = [];

  constructor(load: () => Promise<Stream[]>, private readonly store: StreamPayStore) {
    super(load);
  }

  observe(ids: bigint[]): void {
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe.length = 0;
    this.ids = ids;
    for (const id of ids) {
      this.unsubscribe.push(this.store.stream(id).subscribe(() => this.recompute()));
    }
  }

  private recompute(): void {
    this.set(this.ids.map((id) => this.store.stream(id).getSnapshot()));
  }
}

interface EventWatcher {
  controller: AbortController;
  subscribers: number;
}

export class StreamPayStore {
  private readonly streams = new Map<string, StreamResource>();
  private readonly accruals = new Map<string, QueryResource<bigint>>();
  private readonly lists = new Map<string, QueryResource<Stream[]>>();
  private readonly watchers = new Map<string, EventWatcher>();

  constructor(
    readonly client: StreamPayClient,
    private readonly eventFeedUrl?: string
  ) {}

  stream(streamId: U64): StreamResource {
    const id = normalizeStreamId(streamId);
    let resource = this.streams.get(id);
    if (!resource) {
      resource = new StreamResource(() => this.client.getStream({ streamId: BigInt(id) }));
      this.streams.set(id, resource);
    }
    return resource;
  }

  accrual(streamId: U64): QueryResource<bigint> {
    const id = normalizeStreamId(streamId);
    let resource = this.accruals.get(id);
    if (!resource) {
      resource = new QueryResource(() => this.client.available({ streamId: BigInt(id) }));
      this.accruals.set(id, resource);
    }
    return resource;
  }

  streamsFor(role: IndexRole, address: string): QueryResource<Stream[]> {
    if (address.length === 0) throw new Error("address is required");
    const key = `${role}:${address}`;
    let resource = this.lists.get(key);
    if (!resource) {
      let created: StreamListResource;
      created = new StreamListResource(async () => {
        const ids = await this.client.streamIds(role, address);
        const streams = await Promise.all(ids.map((id) => this.stream(id).promise));
        created.observe(ids);
        return streams;
      }, this);
      resource = created;
      this.lists.set(key, resource);
    }
    return resource;
  }

  watch(streamId: U64): () => void {
    const id = normalizeStreamId(streamId);
    if (this.eventFeedUrl === undefined) return () => undefined;
    let watcher = this.watchers.get(id);
    if (!watcher) {
      watcher = { controller: new AbortController(), subscribers: 0 };
      this.watchers.set(id, watcher);
      void this.consumeEvents(id, watcher.controller.signal);
    }
    watcher.subscribers += 1;
    return () => {
      watcher.subscribers -= 1;
      if (watcher.subscribers === 0) {
        watcher.controller.abort();
        this.watchers.delete(id);
      }
    };
  }

  optimisticWithdraw(streamId: U64, amount: bigint): number {
    if (amount <= 0n) throw new RangeError("withdrawal amount must be positive");
    const resource = this.stream(streamId);
    const stream = resource.getSnapshot();
    const withdrawn = stream.withdrawn + amount;
    return resource.applyOptimistic({
      ...stream,
      withdrawn,
      status: withdrawn >= stream.deposit ? "Depleted" : stream.status,
    });
  }

  clearOptimistic(streamId: U64, token: number): void {
    this.stream(streamId).clearOptimistic(token);
  }

  async reconcile(streamId: U64): Promise<Stream> {
    const stream = await this.stream(streamId).refresh();
    await this.accrual(streamId).refresh().catch(() => undefined);
    return stream;
  }

  private async consumeEvents(id: string, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.client.subscribeEvents(BigInt(id), {
        eventFeedUrl: this.eventFeedUrl!,
        signal,
      })) {
        if (event.streamId === null || event.streamId !== id) continue;
        await this.reconcile(id).catch(() => undefined);
      }
    } catch {
      return;
    }
  }
}

export function normalizeStreamId(streamId: U64): string {
  if (typeof streamId === "bigint") {
    if (streamId < 0n) throw new RangeError("streamId must be unsigned");
    return streamId.toString();
  }
  if (typeof streamId === "number") {
    if (!Number.isSafeInteger(streamId) || streamId < 0) {
      throw new RangeError("streamId must be a non-negative safe integer");
    }
    return String(streamId);
  }
  if (!/^\d+$/.test(streamId)) throw new RangeError("streamId must be an unsigned integer");
  return streamId.replace(/^0+(?=\d)/, "");
}
