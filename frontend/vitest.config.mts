import { defineConfig } from "vitest/config";

// The claim-scheduler and fee-stats logic is pure (no DOM, no RPC), so the
// tests run in the node environment. React components are not unit-tested here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
