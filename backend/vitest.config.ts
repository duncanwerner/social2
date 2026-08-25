import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Runs tests inside the Workers runtime, reusing the real Worker config so the
  // DO + D1 bindings match production.
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
