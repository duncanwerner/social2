import type { Env as BackendEnv } from "../src/types";

// The Workers test harness types `env` (from "cloudflare:test") as
// `Cloudflare.Env`. Point that at the Worker's real binding shape so tests are
// type-checked against it. (`npm run typegen` would generate this namespace from
// wrangler.jsonc; we declare it explicitly to keep type-checking self-contained.)
declare global {
  namespace Cloudflare {
    interface Env extends BackendEnv {}
  }
}
