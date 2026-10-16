import { rpc } from '@stellar/stellar-sdk';
import { decodeEvent, RawRpcEvent } from './decoder.js';
import { IndexerDatabase } from './database.js';

export interface PollerOptions {
  rpcUrl: string;
  contractId: string;
  pollIntervalMs: number;
  startLedger?: number;
  db: IndexerDatabase;
  customRpcFetcher?: (startLedger: number) => Promise<{ events: RawRpcEvent[]; latestLedger?: number }>;
}

export class EventPoller {
  private rpcServer?: rpc.Server;
  private contractId: string;
  private pollIntervalMs: number;
  private startLedger?: number;
  private db: IndexerDatabase;
  private customRpcFetcher?: (startLedger: number) => Promise<{ events: RawRpcEvent[]; latestLedger?: number }>;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private polling: boolean = false;

  constructor(options: PollerOptions) {
    this.contractId = options.contractId;
    this.pollIntervalMs = options.pollIntervalMs;
    this.startLedger = options.startLedger;
    this.db = options.db;
    this.customRpcFetcher = options.customRpcFetcher;
    if (!options.customRpcFetcher) {
      this.rpcServer = new rpc.Server(options.rpcUrl);
    }
  }

  public async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;

    try {
      // 1. Get cursor or fallback to startLedger or 1
      const persistedCursor = this.db.getCursor();
      const currentStartLedger = persistedCursor !== null
        ? persistedCursor
        : (this.startLedger !== undefined ? this.startLedger : 1);

      let events: RawRpcEvent[] = [];
      let maxProcessedLedger = currentStartLedger;

      if (this.customRpcFetcher) {
        const res = await this.customRpcFetcher(currentStartLedger);
        events = res.events;
        if (res.latestLedger !== undefined) {
          maxProcessedLedger = Math.max(maxProcessedLedger, res.latestLedger);
        }
      } else if (this.rpcServer) {
        // Fetch via Soroban RPC getEvents
        const filters: rpc.Api.EventFilter[] = [];
        if (this.contractId) {
          filters.push({
            type: 'contract',
            contractIds: [this.contractId],
          });
        }

        try {
          const res = await this.rpcServer.getEvents({
            startLedger: currentStartLedger,
            filters,
            limit: 100,
          });

          if (res && res.events) {
            events = res.events as unknown as RawRpcEvent[];
          }
          if (res && res.latestLedger !== undefined) {
            maxProcessedLedger = Math.max(maxProcessedLedger, res.latestLedger);
          }
        } catch (err) {
          console.error('[Indexer] RPC error fetching events:', err);
          return 0;
        }
      }

      let processedCount = 0;

      for (const rawEvent of events) {
        // Filter by contract ID if configured
        if (this.contractId && rawEvent.contractId && rawEvent.contractId !== this.contractId) {
          continue;
        }

        const decoded = decodeEvent(rawEvent);
        if (decoded) {
          const applied = this.db.applyEvent(
            rawEvent.id,
            rawEvent.contractId || this.contractId,
            rawEvent.ledger,
            rawEvent.ledgerClosedAt || null,
            rawEvent.txHash || null,
            decoded
          );
          if (applied) {
            processedCount++;
          }
        }

        if (rawEvent.ledger > maxProcessedLedger) {
          maxProcessedLedger = rawEvent.ledger;
        }
      }

      // 3. Upsert new cursor after batch
      this.db.setCursor(maxProcessedLedger);

      return processedCount;
    } finally {
      this.polling = false;
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;

    const loop = async () => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch (err) {
        console.error('[Indexer] Error during poll cycle:', err);
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.pollIntervalMs);
      }
    };

    void loop();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

