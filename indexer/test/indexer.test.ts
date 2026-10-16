import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';

import { IndexerDatabase } from '../src/database.js';
import { EventPoller } from '../src/poller.js';
import { createServer } from '../src/server.js';
import { RawRpcEvent } from '../src/decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getFixturePath(): string {
  const candidates = [
    path.resolve(__dirname, 'events-fixture.json'),
    path.resolve(__dirname, '../../test/events-fixture.json'),
    path.resolve(process.cwd(), 'test/events-fixture.json'),
    path.resolve(process.cwd(), 'indexer/test/events-fixture.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  throw new Error(`Cannot locate events-fixture.json in any expected path`);
}

function fetchJson(url: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({ status: res.statusCode || 200, data });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

describe('Indexer Integration Tests', () => {
  const fixturePath = getFixturePath();
  const fixtureEvents: RawRpcEvent[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  it('indexes events, persists cursor, prevents double-counting, handles cancel payout, and serves API', async () => {
    const testDbPath = path.resolve(__dirname, 'test-indexer.sqlite');
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Step 1: Start indexer worker against test SQLite database
    let db = new IndexerDatabase(testDbPath);

    // Initial cursor check: should be null before any polling
    assert.equal(db.getCursor(), null);

    // Mock RPC fetcher that yields fixture events
    const customRpcFetcher = async (startLedger: number) => {
      // Filter events whose ledger >= startLedger
      const events = fixtureEvents.filter((e) => e.ledger >= startLedger);
      return {
        events,
        latestLedger: 120,
      };
    };

    const poller = new EventPoller({
      rpcUrl: 'http://localhost:8000',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4',
      pollIntervalMs: 1000,
      db,
      customRpcFetcher,
    });

    // Run one poll cycle
    const processedFirst = await poller.pollOnce();
    assert.equal(processedFirst, 4, 'Should process all 4 fixture events');

    // Cursor should now be updated to max ledger (120)
    const cursor1 = db.getCursor();
    assert.equal(cursor1, 120, 'Cursor should be updated to 120');

    // Step 2: Start HTTP server on an ephemeral port
    const server = createServer(db);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // Step 3: Assert correct API output for both endpoints
      // GET /streams?recipient=<address>
      const recipient = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4';
      const streamsRes = await fetchJson(`${baseUrl}/streams?recipient=${recipient}`);
      assert.equal(streamsRes.status, 200);
      assert.equal(Array.isArray(streamsRes.data), true);
      assert.equal(streamsRes.data.length, 1);

      const stream = streamsRes.data[0];
      assert.equal(stream.id, '1');
      assert.equal(stream.sender, 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M');
      assert.equal(stream.recipient, recipient);
      assert.equal(stream.status, 'Cancelled');
      assert.equal(stream.cancelable, 1);
      assert.equal(stream.cancelled_by, 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M');
      assert.equal(stream.recipient_amount, '3000000');
      assert.equal(stream.sender_amount, '10000000');
      // Total withdrawn is previous withdrawn (2000000) + cancel recipient_amount (3000000) = 5000000
      assert.equal(stream.withdrawn, '5000000');
      // Deposit was topped up to 15000000
      assert.equal(stream.deposit, '15000000');

      // GET /streams?recipient=nonexistent returns empty array gracefully (not 500)
      const emptyStreamsRes = await fetchJson(`${baseUrl}/streams?recipient=NONEXISTENT`);
      assert.equal(emptyStreamsRes.status, 200);
      assert.deepEqual(emptyStreamsRes.data, []);

      // GET /streams/:id/history returns full event history in ledger order
      const historyRes = await fetchJson(`${baseUrl}/streams/1/history`);
      assert.equal(historyRes.status, 200);
      assert.equal(Array.isArray(historyRes.data), true);
      assert.equal(historyRes.data.length, 4);

      assert.equal(historyRes.data[0].event_type, 'stream_created');
      assert.equal(historyRes.data[0].ledger, 100);
      assert.equal(historyRes.data[1].event_type, 'withdrawn');
      assert.equal(historyRes.data[1].ledger, 105);
      assert.equal(historyRes.data[2].event_type, 'stream_topped_up');
      assert.equal(historyRes.data[2].ledger, 110);
      assert.equal(historyRes.data[3].event_type, 'stream_cancelled');
      assert.equal(historyRes.data[3].ledger, 115);

      // GET /streams/999/history returns empty array gracefully (not 500)
      const emptyHistoryRes = await fetchJson(`${baseUrl}/streams/999/history`);
      assert.equal(emptyHistoryRes.status, 200);
      assert.deepEqual(emptyHistoryRes.data, []);

      // Step 4: Test that restarting with a persisted cursor does not double-count events
      // Simulate another poll with all events returned (e.g. from ledger 100)
      const duplicatePoll = await poller.pollOnce();
      assert.equal(duplicatePoll, 0, 'No duplicate events should be applied');

      // Check DB events count directly
      const eventsInDb = db.getStreamHistory('1');
      assert.equal(eventsInDb.length, 4, 'Event log remains exactly 4 events without duplicates');

      // Now close server and db to simulate service shutdown
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();

      // Restart service with existing sqlite file
      const restartedDb = new IndexerDatabase(testDbPath);
      assert.equal(restartedDb.getCursor(), 120, 'Cursor persisted across restart');

      const restartedPoller = new EventPoller({
        rpcUrl: 'http://localhost:8000',
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4',
        pollIntervalMs: 1000,
        db: restartedDb,
        customRpcFetcher: async (startLedger) => {
          assert.equal(startLedger, 120, 'Poller should resume from persisted cursor 120');
          // Even if RPC returned all historical fixture events
          return {
            events: fixtureEvents,
            latestLedger: 120,
          };
        },
      });

      const processedAfterRestart = await restartedPoller.pollOnce();
      assert.equal(processedAfterRestart, 0, 'Zero events double-counted across restart');
      assert.equal(restartedDb.getStreamHistory('1').length, 4);

      restartedDb.close();
    } finally {
      if (fs.existsSync(testDbPath)) {
        try {
          fs.unlinkSync(testDbPath);
        } catch {
          // ignore
        }
      }
    }
  });
});
