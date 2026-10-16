import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Exact Rust logic for streamed_at
function rustStreamedAt(depositStr, durationStr, elapsedStr) {
  const deposit = BigInt(depositStr);
  const duration = BigInt(durationStr);
  const elapsed = BigInt(elapsedStr);

  if (elapsed <= 0n || deposit <= 0n || duration <= 0n) {
    return { ok: "0" };
  }

  const u128Max = (1n << 128n) - 1n;
  const product = deposit * elapsed;
  if (product > u128Max) {
    return { err: "MathOverflow" };
  }

  const streamed = product / duration;
  const clamped = streamed > deposit ? deposit : streamed;
  return { ok: clamped.toString() };
}

const entries = [];

const deposits = [
  "-100",
  "-1",
  "0",
  "1",
  "100",
  "1000000",
  "10000000000",
  "1000000000000000000",
  "170141183460469231731687303715884105727", // i128::MAX
  "85070591730234615865843651857942052863", // i128::MAX / 2
];

const durations = [
  "0",
  "1",
  "2",
  "10",
  "100",
  "86400",
  "604800",
  "2592000",
  "31536000",
  "18446744073709551615", // u64::MAX
];

const elapseds = [
  "0",
  "1",
  "2",
  "50",
  "100",
  "43200",
  "86400",
  "172800",
  "18446744073709551615", // u64::MAX
];

for (const deposit of deposits) {
  for (const duration of durations) {
    for (const elapsed of elapseds) {
      const res = rustStreamedAt(deposit, duration, elapsed);
      entries.push({
        deposit,
        duration,
        elapsed,
        expected_result: res.ok ?? null,
        expected_error: res.err ?? null,
      });
    }
  }
}

// Pseudorandom pseudo-fuzz cases
let seed = 0xdeadbeef12345678n;
function nextBig() {
  seed ^= (seed << 13n) & 0xffffffffffffffffn;
  seed ^= seed >> 7n;
  seed ^= (seed << 17n) & 0xffffffffffffffffn;
  return seed;
}

for (let i = 0; i < 1500; i++) {
  const dLow = nextBig();
  const dHigh = nextBig() & 0x7fffffffffffffffn;
  const deposit = (dHigh << 64n) | dLow;
  const duration = nextBig();
  const elapsed = duration > 0n ? nextBig() % (duration * 2n) : nextBig();

  const dStr = deposit.toString();
  const durStr = duration.toString();
  const elStr = elapsed.toString();

  const res = rustStreamedAt(dStr, durStr, elStr);
  entries.push({
    deposit: dStr,
    duration: durStr,
    elapsed: elStr,
    expected_result: res.ok ?? null,
    expected_error: res.err ?? null,
  });
}

const outDir = join(__dirname, "../tests/vectors");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "accrual_vectors.json");
writeFileSync(outPath, JSON.stringify(entries, null, 2), "utf-8");
console.log(`Generated ${entries.length} differential test vectors to ${outPath}`);
