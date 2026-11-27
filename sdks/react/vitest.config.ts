import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@streampay/sdk": fileURLToPath(new URL("../typescript/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx"],
    restoreMocks: true,
  },
});
