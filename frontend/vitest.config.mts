import { configDefaults, defineConfig } from "vitest/config";

// The claim-scheduler and fee-stats logic is pure (no DOM, no RPC), so the
// tests run in the node environment. React components are not unit-tested here.
// `lib/accrual.test.ts` uses the Node built-in test runner (`node --test`), so
// it is excluded here and executed by the `test:accrual` script instead.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/accrual.test.ts"],
  },
});
