export interface SpecFunction {
  name: string;
  doc?: string;
  args?: Array<{ name: string; type: unknown }>;
  returns?: unknown;
}

export interface SpecEnum {
  name: string;
  cases?: Array<{ name: string; value: number; doc?: string }>;
}

export interface SpecEvent {
  name: string;
  doc?: string;
}

export interface ContractSpec {
  schema?: string;
  functions?: SpecFunction[];
  enums?: SpecEnum[];
  events?: SpecEvent[];
}

export interface SurfaceEntry {
  kind: "function" | "error" | "event";
  name: string;
  detail: string;
  doc: string;
}

const ABI_SCHEMA_VERSION = 1;

export function exploreSurface(spec: ContractSpec, filter: { kind?: SurfaceEntry["kind"]; name?: string } = {}): {
  schemaVersion: number;
  entries: SurfaceEntry[];
} {
  const entries: SurfaceEntry[] = [];
  for (const fn of spec.functions ?? []) {
    const args = (fn.args ?? []).map((arg) => `${arg.name}:${JSON.stringify(arg.type)}`).join(", ");
    entries.push({
      kind: "function",
      name: fn.name,
      detail: `(${args}) -> ${JSON.stringify(fn.returns ?? "void")}`,
      doc: fn.doc ?? "",
    });
  }
  for (const item of spec.enums ?? []) {
    if (!item.name.toLowerCase().includes("error")) continue;
    for (const itemCase of item.cases ?? []) {
      entries.push({
        kind: "error",
        name: `${item.name}.${itemCase.name}`,
        detail: String(itemCase.value),
        doc: itemCase.doc ?? `docs/errors/${item.name}.md`,
      });
    }
  }
  for (const event of spec.events ?? []) {
    entries.push({
      kind: "event",
      name: event.name,
      detail: "event",
      doc: event.doc ?? "",
    });
  }
  const filtered = entries.filter((entry) => {
    if (filter.kind && entry.kind !== filter.kind) return false;
    if (filter.name && !entry.name.includes(filter.name)) return false;
    return true;
  });
  filtered.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  return { schemaVersion: ABI_SCHEMA_VERSION, entries: filtered };
}

export function renderTable(model: { entries: SurfaceEntry[] }): string {
  const lines = ["KIND | NAME | DETAIL"];
  for (const entry of model.entries) {
    lines.push(`${entry.kind} | ${entry.name} | ${entry.detail}`);
  }
  return lines.join("\n");
}

export function diffSurface(left: ContractSpec, right: ContractSpec): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const leftEntries = new Map(exploreSurface(left).entries.map((entry) => [entryKey(entry), entry]));
  const rightEntries = new Map(exploreSurface(right).entries.map((entry) => [entryKey(entry), entry]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, entry] of rightEntries) {
    const previous = leftEntries.get(key);
    if (!previous) added.push(key);
    else if (previous.detail !== entry.detail) changed.push(key);
  }
  for (const key of leftEntries.keys()) {
    if (!rightEntries.has(key)) removed.push(key);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export function detectDrift(specNames: string[], registryNames: string[], deployedNames: string[]): string[] {
  const problems: string[] = [];
  const spec = new Set(specNames);
  const registry = new Set(registryNames);
  const deployed = new Set(deployedNames);
  for (const name of spec) {
    if (!registry.has(name)) problems.push(`registry missing ${name}`);
    if (!deployed.has(name)) problems.push(`deployed interface missing ${name}`);
  }
  for (const name of registry) {
    if (!spec.has(name)) problems.push(`spec missing ${name}`);
  }
  for (const name of deployed) {
    if (!spec.has(name)) problems.push(`spec missing deployed ${name}`);
  }
  return problems.sort();
}

function entryKey(entry: SurfaceEntry): string {
  return `${entry.kind}:${entry.name}`;
}
