# StreamPay Event Indexer

The StreamPay Event Indexer is a standalone TypeScript Node.js service that polls Soroban RPC `getEvents` for StreamPay smart contract events, decodes the contract's typed XDR event payloads using `@stellar/stellar-sdk`, persists stream metadata and an append-only event log in SQLite, maintains cursor persistence, and serves a lightweight HTTP query API.

---

## 1. Prerequisites

- **Node.js**: `v22.5.0` or higher (uses built-in `node:sqlite`).
- **npm**: `v10+` or `v11+`.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `RPC_URL` | Soroban RPC endpoint URL | `https://soroban-testnet.stellar.org` |
| `CONTRACT_ID` | StreamPay contract address (`C...`) to filter events | `""` (all events if unset) |
| `DATABASE_PATH` | Path to the SQLite database file | `indexer.sqlite` |
| `POLL_INTERVAL_SECONDS` | Interval between RPC poll cycles in seconds | `5` |
| `PORT` | Port for the HTTP API server | `3001` |
| `START_LEDGER` | Initial ledger sequence if starting fresh without a saved cursor | `1` |

---

## 2. How to Run Locally

### Installation & Build

```bash
cd indexer
npm install
npm run build
```

### Running the Indexer

```bash
npm start
```

Or run directly with specific environment settings:

```bash
PORT=3001 CONTRACT_ID="CB..." DATABASE_PATH="data/indexer.sqlite" npm start
```

---

## 3. How to Run Against Testnet vs. Local RPC Node

### Running Against Stellar Testnet

```bash
export RPC_URL="https://soroban-testnet.stellar.org"
export CONTRACT_ID="<YOUR_TESTNET_CONTRACT_ADDRESS>"
export START_LEDGER=1000000
npm start
```

### Running Against Local RPC Node (e.g. Local Soroban Network / Standalone)

```bash
export RPC_URL="http://localhost:8000/soroban/rpc"
export CONTRACT_ID="<LOCAL_CONTRACT_ADDRESS>"
export START_LEDGER=1
export POLL_INTERVAL_SECONDS=2
npm start
```

---

## 4. Database Location & Resetting the Cursor

The SQLite database path is controlled by `DATABASE_PATH` (defaults to `indexer.sqlite` in the current working directory).

### Database Schema

- **`streams`**: Stream metadata upserted on `stream_created`, `withdrawn`, `stream_topped_up`, and `stream_cancelled` events.
- **`events`**: Append-only log of every processed event with `event_id`, `stream_id`, `contract_id`, `ledger`, `tx_hash`, `event_type`, and decoded `payload` stored as JSON.
- **`cursor`**: Single-row cursor table tracking `last_ledger` to guarantee zero double-counting across restarts.

### How to Reset Cursor

To re-index from a specific ledger or reprocess all events:

1. **Option A: Reset cursor table to a specific ledger:**
   ```bash
   sqlite3 indexer.sqlite "UPDATE cursor SET last_ledger = 100000 WHERE id = 1;"
   ```

2. **Option B: Reset cursor to start from scratch:**
   ```bash
   sqlite3 indexer.sqlite "DELETE FROM cursor; DELETE FROM events; DELETE FROM streams;"
   ```

3. **Option C: Remove the database file:**
   ```bash
   rm indexer.sqlite
   ```

---

## 5. API Endpoint Reference

The service exposes an HTTP API on the configured `PORT` (default `3001`).

### `GET /streams?recipient=<address>`

Returns all streams where `recipient` matches the query parameter in creation order. Returns an empty array `[]` (with HTTP 200) if no streams are found or if the parameter is omitted.

#### Example Response:
```json
[
  {
    "id": "1",
    "sender": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
    "recipient": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
    "token": "CBEPDNVYXQGWB5YUBXKJWYJA7OXTZW5LFLNO5JRRGE6Z6C5OSUZPCCEL",
    "deposit": "15000000",
    "withdrawn": "5000000",
    "start_time": 1700000000,
    "end_time": 1700864000,
    "cancelable": 1,
    "status": "Cancelled",
    "cancelled_by": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
    "recipient_amount": "3000000",
    "sender_amount": "10000000",
    "created_at_ledger": 100,
    "updated_at_ledger": 115
  }
]
```

### `GET /streams/:id/history`

Returns the full event history for a stream ID in ledger order (`ledger ASC, id ASC`). Returns an empty array `[]` (with HTTP 200) if no events exist for the given stream ID.

#### Example Response:
```json
[
  {
    "id": 1,
    "event_id": "0000000100-00001",
    "stream_id": "1",
    "contract_id": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4",
    "ledger": 100,
    "ledger_closed_at": "2026-01-01T00:00:00Z",
    "tx_hash": "txhash1",
    "event_type": "stream_created",
    "payload": {
      "stream_id": "1",
      "sender": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
      "recipient": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
      "token": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
      "deposit": "10000000",
      "start_time": 100,
      "end_time": 500,
      "cancelable": true
    },
    "created_at": "2026-10-16 07:00:00"
  },
  {
    "id": 2,
    "event_id": "0000000105-00001",
    "stream_id": "1",
    "contract_id": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4",
    "ledger": 105,
    "ledger_closed_at": "2026-01-01T00:05:00Z",
    "tx_hash": "txhash2",
    "event_type": "withdrawn",
    "payload": {
      "stream_id": "1",
      "recipient": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
      "amount": "2000000",
      "withdrawn_total": "2000000"
    },
    "created_at": "2026-10-16 07:05:00"
  }
]
```

### `GET /health`

Health check endpoint returning indexer status and current cursor ledger.
```json
{
  "status": "ok",
  "cursor": 120
}
```

---

## 6. Testing

Run the integration test suite:

```bash
npm test
```

