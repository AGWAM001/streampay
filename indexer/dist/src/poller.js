import { rpc } from '@stellar/stellar-sdk';
import { decodeEvent } from './decoder.js';
export class EventPoller {
    rpcServer;
    contractId;
    pollIntervalMs;
    startLedger;
    db;
    customRpcFetcher;
    timer = null;
    running = false;
    polling = false;
    constructor(options) {
        this.contractId = options.contractId;
        this.pollIntervalMs = options.pollIntervalMs;
        this.startLedger = options.startLedger;
        this.db = options.db;
        this.customRpcFetcher = options.customRpcFetcher;
        if (!options.customRpcFetcher) {
            this.rpcServer = new rpc.Server(options.rpcUrl);
        }
    }
    async pollOnce() {
        if (this.polling)
            return 0;
        this.polling = true;
        try {
            // 1. Get cursor or fallback to startLedger or 1
            const persistedCursor = this.db.getCursor();
            const currentStartLedger = persistedCursor !== null
                ? persistedCursor
                : (this.startLedger !== undefined ? this.startLedger : 1);
            let events = [];
            let maxProcessedLedger = currentStartLedger;
            if (this.customRpcFetcher) {
                const res = await this.customRpcFetcher(currentStartLedger);
                events = res.events;
                if (res.latestLedger !== undefined) {
                    maxProcessedLedger = Math.max(maxProcessedLedger, res.latestLedger);
                }
            }
            else if (this.rpcServer) {
                // Fetch via Soroban RPC getEvents
                const filters = [];
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
                        events = res.events;
                    }
                    if (res && res.latestLedger !== undefined) {
                        maxProcessedLedger = Math.max(maxProcessedLedger, res.latestLedger);
                    }
                }
                catch (err) {
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
                    const applied = this.db.applyEvent(rawEvent.id, rawEvent.contractId || this.contractId, rawEvent.ledger, rawEvent.ledgerClosedAt || null, rawEvent.txHash || null, decoded);
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
        }
        finally {
            this.polling = false;
        }
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        const loop = async () => {
            if (!this.running)
                return;
            try {
                await this.pollOnce();
            }
            catch (err) {
                console.error('[Indexer] Error during poll cycle:', err);
            }
            if (this.running) {
                this.timer = setTimeout(loop, this.pollIntervalMs);
            }
        };
        void loop();
    }
    stop() {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
