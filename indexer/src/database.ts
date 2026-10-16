import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DecodedEvent,
  StreamCancelledPayload,
  StreamCreatedPayload,
  StreamToppedUpPayload,
  WithdrawnPayload,
} from './decoder.js';

export interface StreamRow {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  deposit: string;
  withdrawn: string;
  start_time: number;
  end_time: number;
  cancelable: number;
  status: string;
  cancelled_by: string | null;
  recipient_amount: string | null;
  sender_amount: string | null;
  created_at_ledger: number;
  updated_at_ledger: number;
}

export interface EventRow {
  id: number;
  event_id: string;
  stream_id: string;
  contract_id: string;
  ledger: number;
  ledger_closed_at: string | null;
  tx_hash: string | null;
  event_type: string;
  payload: string;
  created_at: string;
}

export class IndexerDatabase {
  public db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const schemaPaths = [
      path.resolve(currentDir, '../../db/schema.sql'),
      path.resolve(currentDir, '../db/schema.sql'),
      path.resolve(process.cwd(), 'db/schema.sql'),
      path.resolve(process.cwd(), 'indexer/db/schema.sql'),
    ];

    let schemaSql: string | null = null;
    for (const p of schemaPaths) {
      if (fs.existsSync(p)) {
        schemaSql = fs.readFileSync(p, 'utf8');
        break;
      }
    }

    if (!schemaSql) {
      // Fallback schema if file not found
      schemaSql = `
        CREATE TABLE IF NOT EXISTS streams (
            id TEXT PRIMARY KEY,
            sender TEXT NOT NULL,
            recipient TEXT NOT NULL,
            token TEXT NOT NULL,
            deposit TEXT NOT NULL,
            withdrawn TEXT NOT NULL DEFAULT '0',
            start_time INTEGER NOT NULL,
            end_time INTEGER NOT NULL,
            cancelable INTEGER NOT NULL,
            status TEXT NOT NULL,
            cancelled_by TEXT,
            recipient_amount TEXT,
            sender_amount TEXT,
            created_at_ledger INTEGER NOT NULL,
            updated_at_ledger INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_streams_recipient ON streams(recipient);
        CREATE INDEX IF NOT EXISTS idx_streams_sender ON streams(sender);

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT UNIQUE NOT NULL,
            stream_id TEXT NOT NULL,
            contract_id TEXT NOT NULL,
            ledger INTEGER NOT NULL,
            ledger_closed_at TEXT,
            tx_hash TEXT,
            event_type TEXT NOT NULL,
            payload JSON NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_events_stream_id_ledger ON events(stream_id, ledger ASC, id ASC);
        CREATE INDEX IF NOT EXISTS idx_events_contract_ledger ON events(contract_id, ledger ASC);

        CREATE TABLE IF NOT EXISTS cursor (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_ledger INTEGER NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;
    }

    this.db.exec(schemaSql);
  }

  public getCursor(): number | null {
    const stmt = this.db.prepare('SELECT last_ledger FROM cursor WHERE id = 1');
    const row = stmt.get() as { last_ledger: number } | undefined;
    return row ? row.last_ledger : null;
  }

  public setCursor(ledger: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO cursor (id, last_ledger, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        last_ledger = excluded.last_ledger,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(ledger);
  }

  public applyEvent(
    eventId: string,
    contractId: string,
    ledger: number,
    ledgerClosedAt: string | null,
    txHash: string | null,
    decoded: DecodedEvent
  ): boolean {
    // Check if event already processed
    const checkStmt = this.db.prepare('SELECT 1 FROM events WHERE event_id = ?');
    if (checkStmt.get(eventId)) {
      return false; // Already processed
    }

    const { eventType, streamId, payload } = decoded;

    // Insert into events table
    const insertEventStmt = this.db.prepare(`
      INSERT INTO events (event_id, stream_id, contract_id, ledger, ledger_closed_at, tx_hash, event_type, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEventStmt.run(
      eventId,
      streamId,
      contractId,
      ledger,
      ledgerClosedAt,
      txHash,
      eventType,
      JSON.stringify(payload)
    );

    // Upsert into streams table based on event type
    switch (eventType) {
      case 'stream_created': {
        const p = payload as StreamCreatedPayload;
        const upsertStreamStmt = this.db.prepare(`
          INSERT INTO streams (
            id, sender, recipient, token, deposit, withdrawn, start_time, end_time, cancelable, status,
            cancelled_by, recipient_amount, sender_amount, created_at_ledger, updated_at_ledger
          ) VALUES (?, ?, ?, ?, ?, '0', ?, ?, ?, 'Active', NULL, NULL, NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            sender = excluded.sender,
            recipient = excluded.recipient,
            token = excluded.token,
            deposit = excluded.deposit,
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            cancelable = excluded.cancelable,
            updated_at_ledger = excluded.updated_at_ledger
        `);
        upsertStreamStmt.run(
          streamId,
          p.sender,
          p.recipient,
          p.token,
          p.deposit,
          p.start_time,
          p.end_time,
          p.cancelable ? 1 : 0,
          ledger,
          ledger
        );
        break;
      }

      case 'withdrawn': {
        const p = payload as WithdrawnPayload;
        const updateStmt = this.db.prepare(`
          UPDATE streams
          SET withdrawn = ?,
              updated_at_ledger = ?
          WHERE id = ?
        `);
        updateStmt.run(p.withdrawn_total, ledger, streamId);
        break;
      }

      case 'stream_cancelled': {
        const p = payload as StreamCancelledPayload;
        // Payout to recipient increases stream's withdrawn total
        // We get current withdrawn to add recipient_amount
        const getStreamStmt = this.db.prepare('SELECT withdrawn FROM streams WHERE id = ?');
        const s = getStreamStmt.get(streamId) as { withdrawn: string } | undefined;
        let newWithdrawn = p.recipient_amount;
        if (s && s.withdrawn) {
          try {
            newWithdrawn = (BigInt(s.withdrawn) + BigInt(p.recipient_amount)).toString();
          } catch {
            newWithdrawn = p.recipient_amount;
          }
        }

        const cancelStmt = this.db.prepare(`
          UPDATE streams
          SET status = 'Cancelled',
              cancelled_by = ?,
              recipient_amount = ?,
              sender_amount = ?,
              withdrawn = ?,
              updated_at_ledger = ?
          WHERE id = ?
        `);
        cancelStmt.run(
          p.cancelled_by,
          p.recipient_amount,
          p.sender_amount,
          newWithdrawn,
          ledger,
          streamId
        );
        break;
      }

      case 'stream_topped_up': {
        const p = payload as StreamToppedUpPayload;
        const topUpStmt = this.db.prepare(`
          UPDATE streams
          SET deposit = ?,
              updated_at_ledger = ?
          WHERE id = ?
        `);
        topUpStmt.run(p.new_deposit, ledger, streamId);
        break;
      }
    }

    return true;
  }

  public getStreamsByRecipient(recipient: string): StreamRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM streams
      WHERE recipient = ?
      ORDER BY CAST(id AS INTEGER) ASC, id ASC
    `);
    const rows = stmt.all(recipient);
    return rows as unknown as StreamRow[];
  }

  public getStreamHistory(streamId: string): EventRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE stream_id = ?
      ORDER BY ledger ASC, id ASC
    `);
    const rows = stmt.all(streamId);
    return rows as unknown as EventRow[];
  }

  public close(): void {
    this.db.close();
  }
}

