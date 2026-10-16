import { loadConfig } from './config.js';
import { IndexerDatabase } from './database.js';
import { EventPoller } from './poller.js';
import { createServer } from './server.js';
export function run() {
    const config = loadConfig();
    console.log('[Indexer] Starting StreamPay event indexer worker...');
    console.log(`[Indexer] RPC URL: ${config.rpcUrl}`);
    console.log(`[Indexer] Contract ID: ${config.contractId || '(all/unfiltered)'}`);
    console.log(`[Indexer] Database: ${config.dbPath}`);
    console.log(`[Indexer] Poll Interval: ${config.pollIntervalMs}ms`);
    console.log(`[Indexer] HTTP Port: ${config.port}`);
    const db = new IndexerDatabase(config.dbPath);
    const poller = new EventPoller({
        rpcUrl: config.rpcUrl,
        contractId: config.contractId,
        pollIntervalMs: config.pollIntervalMs,
        startLedger: config.startLedger,
        db,
    });
    const server = createServer(db);
    server.listen(config.port, () => {
        console.log(`[Indexer] HTTP server listening on port ${config.port}`);
    });
    poller.start();
    const shutdown = () => {
        console.log('[Indexer] Shutting down gracefully...');
        poller.stop();
        server.close(() => {
            db.close();
            console.log('[Indexer] Closed database and server.');
            process.exit(0);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
// Only invoke run directly when this file is executed as entry point
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
    run();
}
