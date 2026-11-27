import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const MANIFEST_SCHEMA_VERSION = 1;
const OPS = new Set(["create", "top-up", "cancel", "amend"]);

export interface BatchRow {
  id: string;
  op: string;
  params: Record<string, string | number>;
}

export interface BatchManifest {
  schemaVersion: number;
  rows: BatchRow[];
}

export interface DryRunEffect {
  id: string;
  op: string;
  idempotencyKey: string;
  effect: string;
  value: string;
}

export interface AuditEntry {
  id: string;
  op: string;
  idempotencyKey: string;
  intent: string;
  txHash: string;
  result: "applied" | "failed" | "skipped";
  at: string;
  prev: string;
}

export interface Checkpoint {
  completed: string[];
  audit: AuditEntry[];
}

export function validateManifest(input: unknown): { manifest?: BatchManifest; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["manifest must be an object"] };
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push("unsupported schemaVersion");
  }
  if (!Array.isArray(record.rows)) {
    errors.push("rows must be an array");
    return { errors };
  }
  const seen = new Set<string>();
  const rows: BatchRow[] = [];
  for (const row of record.rows) {
    if (!row || typeof row !== "object") {
      errors.push("row must be an object");
      continue;
    }
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) errors.push("row id is required");
    if (typeof item.op !== "string" || !OPS.has(item.op)) errors.push(`unsupported op ${String(item.op)}`);
    if (!item.params || typeof item.params !== "object" || Array.isArray(item.params)) {
      errors.push(`row ${String(item.id)} is missing params`);
    }
    if (typeof item.id === "string") {
      if (seen.has(item.id)) errors.push(`duplicate row id ${item.id}`);
      seen.add(item.id);
      rows.push({
        id: item.id,
        op: String(item.op),
        params: (item.params ?? {}) as Record<string, string | number>,
      });
    }
  }
  if (errors.length > 0) return { errors };
  return { manifest: { schemaVersion: MANIFEST_SCHEMA_VERSION, rows }, errors };
}

export function dryRun(manifest: BatchManifest): { effects: DryRunEffect[]; total: string } {
  let total = 0n;
  const effects = manifest.rows.map((row) => {
    const amount = amountOf(row);
    if (row.op === "create" || row.op === "top-up") total += amount;
    if (row.op === "cancel") total -= amount;
    return {
      id: row.id,
      op: row.op,
      idempotencyKey: row.id,
      effect: describe(row),
      value: amount.toString(),
    };
  });
  return { effects, total: total.toString() };
}

export function executeManifest(
  manifest: BatchManifest,
  checkpoint: Checkpoint,
  confirmed: boolean,
  now = "1970-01-01T00:00:00.000Z",
): Checkpoint {
  if (!confirmed) {
    throw new Error("execution requires explicit confirmation");
  }
  const completed = new Set(checkpoint.completed);
  const audit = checkpoint.audit.slice();
  for (const row of manifest.rows) {
    if (completed.has(row.id)) {
      audit.push(entry(row, "skipped", `skip-${row.id}`, audit, now));
      continue;
    }
    audit.push(entry(row, "applied", `tx-${row.id}`, audit, now));
    completed.add(row.id);
  }
  return { completed: [...completed], audit };
}

export function loadManifest(path: string): { manifest?: BatchManifest; errors: string[] } {
  const raw = readFileSync(path, "utf8");
  return validateManifest(JSON.parse(raw) as unknown);
}

export function writeCheckpoint(path: string, checkpoint: Checkpoint): void {
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

export function readCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return { completed: [], audit: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Checkpoint>;
  if (!Array.isArray(parsed.completed) || !Array.isArray(parsed.audit)) {
    throw new Error("checkpoint is malformed");
  }
  return { completed: parsed.completed, audit: parsed.audit };
}

function amountOf(row: BatchRow): bigint {
  const value = row.params.amount ?? row.params.deposit ?? 0;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function describe(row: BatchRow): string {
  return `${row.op} ${row.id}`;
}

function entry(
  row: BatchRow,
  result: AuditEntry["result"],
  txHash: string,
  audit: AuditEntry[],
  at: string,
): AuditEntry {
  const prev = audit.length === 0 ? "genesis" : digest(audit[audit.length - 1]);
  return {
    id: row.id,
    op: row.op,
    idempotencyKey: row.id,
    intent: describe(row),
    txHash,
    result,
    at,
    prev,
  };
}

function digest(value: AuditEntry): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
