import { defineConfig } from "vitest/config";

// The Worker only uses web-standard APIs (fetch, WebCrypto), so tests run in
// Node with outbound fetch stubbed per test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
