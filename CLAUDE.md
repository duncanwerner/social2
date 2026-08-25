# CLAUDE.md — do-sockets

Guidance for working in this repository.

## What this is

A server-push notification system: browsers keep a WebSocket open and receive
state updates without polling. Two packages:

- **`backend/`** — Cloudflare Worker + Durable Objects (WebSocket **hibernation**)
  + D1. This is the real service.
- **`test-client/`** — a SolidJS 2.0 RC + TypeScript dev tool for exercising the
  backend interactively. Not the eventual product UI.

Platform rationale: hibernation keeps a few dozen idle connections open with **no
duration billing**; you only pay when a message actually flows. Expected load is
low (dozens of clients, tens of events/hour).

## Architecture (backend)

- **Channels.** Clients connect to a named channel; each channel maps to one
  `ChannelHub` Durable Object instance via `idFromName(channel)`. Events fan out
  only to sockets on the same channel.
- **Publish.** `POST /publish {channel, type?, payload}` → the Worker writes the
  event to D1, then calls the channel's DO (`stub.broadcast`, RPC) to push to live
  sockets. Broadcast returns a delivery count.
- **Hibernation.** The DO uses `ctx.acceptWebSocket()` + the `webSocket*` handler
  methods (NOT the in-memory `addEventListener` API) so it can evict between
  events. `setWebSocketAutoResponse` answers client `ping` with `pong` without
  waking the DO.
- **Endpoints:** `GET /connect?channel=X` (WS upgrade), `POST /publish`,
  `GET /history?channel=X&limit=n`, `GET /healthz`. Channel names must match
  `^[A-Za-z0-9._:-]{1,128}$`. HTTP endpoints send permissive CORS.
- **Auth:** none yet, by design. Insertion points are marked `AUTH HOOK` in
  `backend/src/index.ts` (connect + publish).

Key files: `backend/src/index.ts` (routing), `backend/src/channel-hub.ts` (DO),
`backend/src/db.ts` (D1), `backend/schema.sql`, `backend/wrangler.jsonc`.

## Running locally

```bash
# Backend — local Miniflare on :8787
cd backend && npm install
npm run db:init          # apply D1 schema to local storage (one-time)
npm run dev

# Test client — Vite on :5173
cd test-client && npm install
npm run dev              # open http://localhost:5173
```

`wrangler dev` runs fully local (Miniflare) and ignores the placeholder
`database_id` in `wrangler.jsonc`; local D1 is keyed by `database_name`. The real
`database_id` (from `npx wrangler d1 create do-sockets`) is only needed to deploy.

## Testing & verification

- **Backend:** `cd backend && npm test` — Vitest via
  `@cloudflare/vitest-pool-workers`, running the real Worker + DO + D1 in-process.
  Covers persistence, channel-isolated WS delivery, and validation.
- **Type/build:** each package has `npm run typecheck`; test-client also
  `npm run build`.
- **UI must be verified at runtime**, not just typecheck/build — a runtime-only
  error can still blank the screen (this happened once with a Solid 2 RC API
  change). Render it in a browser (headless Playwright works) before calling UI
  work done.

## Toolchain notes (current / bleeding-edge)

- Backend: Wrangler 4, `@cloudflare/workers-types` v5, `vitest-pool-workers` v4
  API (configured via the `cloudflareTest` Vite plugin, not the old
  `defineWorkersConfig`).
- Test client: **SolidJS 2.0 RC**, which differs from Solid 1 in ways that fail
  only at runtime. If touching `test-client`, read the specifics before editing:
  - `createEffect` takes **two** functions in Solid 2:
    `createEffect(() => track(), (v) => effect(v))`. The one-arg form throws.
  - `render` / `For` / `Show` import from **`@solidjs/web`** (not `solid-js/web`);
    reactivity stays in `solid-js`. `onMount` was removed.
  - tsconfig uses `jsxImportSource: "@solidjs/web"`; build plugin is
    `@solidjs/vite-plugin`.
  These are RC version pins — expect to bump and re-verify as Solid 2 stabilizes.

## Conventions

- TypeScript throughout, `strict` + `verbatimModuleSyntax` (use `import type` for
  type-only imports).
- Don't destructure Solid component `props` (breaks reactivity) — access
  `props.x()`.
