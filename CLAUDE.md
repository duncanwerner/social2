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
- **Records.** First-class entities (padel socials) in the `records` D1 table
  (`id` UUID, `status` int, `data` JSON, `ownerid`, `channel`, `created_at`),
  managed over HTTP. `update-event` broadcasts the new record to its `channel` as
  a `{ kind: "record.updated", record }` frame (reusing `stub.broadcast`).
- **Endpoints:** `GET /connect?channel=X` (WS upgrade), `POST /publish`,
  `GET /history?channel=X&limit=n`, `POST /create-event`, `GET /get-event?id=X`,
  `POST /update-event`, `GET /healthz`. Channel names must match
  `^[A-Za-z0-9._:-]{1,128}$`. HTTP endpoints send permissive CORS.
- **Auth:** password login + long-lived bearer session tokens (`POST /login`,
  `/logout`, `GET /me`). Users are seeded manually — no signup
  (`npm run create-user -- <name>`). Passwords: PBKDF2-HMAC-SHA256 in
  `backend/src/auth.ts`; sessions store the token's SHA-256 hash. `create-event`
  and `update-event` require a token — the record owner is the authenticated user
  (`ownerid` server-derived, never returned); `update-event` is owner-only (403).
  `get-event` and `/connect` are public (viewers need no account; browsers can't
  set headers on a WS upgrade, so gating `/connect` later means a `?token=` param).
  Frontend keeps the token in `localStorage` and sends `Authorization: Bearer`.

Key files: `backend/src/index.ts` (routing), `backend/src/channel-hub.ts` (DO),
`backend/src/db.ts` (D1), `backend/src/auth.ts` (PBKDF2 + tokens),
`backend/schema.sql`, `backend/wrangler.jsonc`.

## Architecture (frontend — `frontend/`, "Rotation")

Solid 2 RC SPA, file-based routing (`filesystem-routing` + `@solidjs/router`).

- **Owner flow.** `/login` → guard; `/create-event` and `/update-event/:localId`
  (`components/EventEditor.tsx`) are the setup surface (roster/courts/metadata),
  saved locally (`event-store.ts`) and pushed to the backend as a record. The
  update page has: a shareable `/view/{recordId}` player link + a "View as player"
  link, per-player **Sit** checkboxes (temporarily bench a player — see optimizer
  note), a free-text event **time** (opaque, so ranges like "11:00 – 1:00" work),
  and a **Finish / Reopen** control that flips the record's status.
- **Saving.** A brand-new event stays local until the explicit **Create social**
  press (which creates the backend record); from then on the editor **auto-saves**
  edits on a ~1s debounce (a `createEffect` over a serialized snapshot of the form
  → `persist()`), flushing any pending save in `onCleanup` if you navigate away.
  No Save button once the record exists — just an "All changes saved" status.
- **Saves are backend-authoritative for untouched fields.** Rounds/scores are
  written by the live rounds page straight to the record, so localStorage goes
  stale. Both the explicit `save()` and the auto-save `persist()` build the payload
  via `buildEvent(base)` where `base` is the **freshly-fetched record** (not stale
  `initial`), or the save would wipe the rounds. Any field the form doesn't render
  must be preserved this way.
- **Player flow.** `/view/:id` is a **layout** (`routes/view/[id].tsx`) that loads
  the record once (public `get-event`) and — unless the event is finished —
  subscribes to its channel (`socket.ts`, auto-reconnect); it shares state with its
  child pages via a context (`view-live.ts`). Children: `index.tsx` (info),
  `rounds.tsx` (live rounds), `stats.tsx` (league table). A finished status shows
  a "Finished" pill and opens no socket (the pill is derived from event status, not
  the transient socket state). Bad id → `ErrorView`.
- **Owner-on-view.** `get-event` returns `owner: true` for the owner's token, so the
  rounds page shows owner controls: **generate round** / **regenerate** the current
  unscored round (optimizer runs in a Web Worker — `round-worker.ts` wrapping
  `social-worker.ts`/`social.ts`) and **score entry**. Generate is disabled off the
  last round. Disabled players are folded into the optimizer's `force_sitting` at
  generation time, so they get no court until re-enabled. Saving calls
  `update-event`, which broadcasts to every viewer live.
- **Stats** (`stats.tsx` + `standings.ts`) — a live league table with two modes:
  **Games** (games won/lost, Win%, ±) and **Matches** (football 3/1/0 points).
  Competition ranking (ties share a rank); leaders get a crown + bold row.
- **Domain types** in `types.ts` (`SocialEvent`/`Player`/`Court`; `Player.disabled`,
  `metadata.time` are optional); the optimizer's branded `PlayerID`/`Round` live in
  `social.ts`. Backend wire types in `protocol.ts`; the records/auth clients in
  `records.ts` / `auth.ts`.
- **Status** ints: `event-status.ts` (`Active = 0`, `Finished = 2`).

## Running locally

```bash
# Backend — local Miniflare on :8787
cd backend && npm install
npm run db:init                 # apply D1 schema to local storage (one-time)
npm run create-user -- <name>   # seed a login (prints a random password once)
npm run dev

# Frontend — Vite on :5174
cd frontend && npm install
npm run dev                     # open http://localhost:5174

# (test-client/ is a separate minimal pub/sub dev tool on :5173)
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
