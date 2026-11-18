import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "sst/resource": fileURLToPath(
        new URL("./tests/fixtures/sst-resource.js", import.meta.url),
      ),
    },
  },
});
