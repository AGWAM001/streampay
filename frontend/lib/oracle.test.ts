import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { streamedAt, MathOverflowError, computeVestingAccrual } from "./oracle";

interface VectorEntry {
  deposit: string;
  duration: string;
  elapsed: string;
  expected_result: string | null;
  expected_error: string | null;
}

describe("oracle differential fuzz-vector suite against contract streamed_at", () => {
  const vectorPath = resolve(__dirname, "../../../tests/vectors/accrual_vectors.json");

  it("loads vector corpus", () => {
    expect(existsSync(vectorPath)).toBe(true);
  });

  const content = readFileSync(vectorPath, "utf-8");
  const vectors: VectorEntry[] = JSON.parse(content);

  it(`passes all ${vectors.length} differential test vectors without divergence`, () => {
    let checked = 0;
    for (const vector of vectors) {
      const deposit = BigInt(vector.deposit);
      const duration = BigInt(vector.duration);
      const elapsed = BigInt(vector.elapsed);

      if (vector.expected_error) {
        expect(() => streamedAt(deposit, duration, elapsed)).toThrowError(MathOverflowError);
      } else {
        const actual = streamedAt(deposit, duration, elapsed);
        expect(actual.toString()).toBe(vector.expected_result);
      }
      checked++;
    }
    expect(checked).toBe(vectors.length);
  });
});

describe("computeVestingAccrual", () => {
  it("respects cliff duration — returns 0 before cliff", () => {
    const params = {
      deposit: 1000n,
      duration: 100n,
      cliffDuration: 25n,
      cliffAmount: 250n,
    };
    expect(computeVestingAccrual(params, 10n)).toBe(0n);
    expect(computeVestingAccrual(params, 24n)).toBe(0n);
  });

  it("unlocks cliff amount at cliff elapsed", () => {
    const params = {
      deposit: 1000n,
      duration: 100n,
      cliffDuration: 25n,
      cliffAmount: 250n,
    };
    expect(computeVestingAccrual(params, 25n)).toBe(250n);
  });

  it("accrues linearly after cliff up to total duration", () => {
    const params = {
      deposit: 1000n,
      duration: 100n,
      cliffDuration: 25n,
      cliffAmount: 250n,
    };
    // At t=62.5 (37.5 after cliff out of 75 duration = 50% of 750 = 375 => total 625)
    // t=62 -> 37 elapsed after cliff. (750 * 37) / 75 = 370. Total = 250 + 370 = 620.
    expect(computeVestingAccrual(params, 62n)).toBe(620n);
    expect(computeVestingAccrual(params, 100n)).toBe(1000n);
    expect(computeVestingAccrual(params, 150n)).toBe(1000n);
  });

  it("handles segmented piecewise schedules", () => {
    const params = {
      deposit: 1000n,
      duration: 100n,
      cliffDuration: 0n,
      cliffAmount: 0n,
      segments: [
        { duration: 50n, percentBps: 2000n }, // 20% over first 50s = 200
        { duration: 50n, percentBps: 8000n }, // 80% over next 50s = 800
      ],
    };

    expect(computeVestingAccrual(params, 25n)).toBe(100n);
    expect(computeVestingAccrual(params, 50n)).toBe(200n);
    expect(computeVestingAccrual(params, 75n)).toBe(600n);
    expect(computeVestingAccrual(params, 100n)).toBe(1000n);
  });
});
