export interface Config {
  rpcUrl: string;
  contractId: string;
  dbPath: string;
  pollIntervalMs: number;
  port: number;
  startLedger?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rpcUrl = env.RPC_URL || 'https://soroban-testnet.stellar.org';
  const contractId = env.CONTRACT_ID || '';
  const dbPath = env.DATABASE_PATH || 'indexer.sqlite';
  const pollIntervalSeconds = Number(env.POLL_INTERVAL_SECONDS || 5);
  const pollIntervalMs = isNaN(pollIntervalSeconds) ? 5000 : Math.max(100, Math.floor(pollIntervalSeconds * 1000));
  const port = Number(env.PORT || 3001);
  const startLedger = env.START_LEDGER ? Number(env.START_LEDGER) : undefined;

  return {
    rpcUrl,
    contractId,
    dbPath,
    pollIntervalMs,
    port: isNaN(port) ? 3001 : port,
    startLedger: startLedger !== undefined && !isNaN(startLedger) ? startLedger : undefined,
  };
}

