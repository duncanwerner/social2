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
  (`id` UUID, `status` int, `data` JSON, `ownerid`, `channel`, `player_scores`
  JSON, `created_at`), managed over HTTP. `update-event` broadcasts the new record
  to its `channel` as a `{ kind: "record.updated", record }` frame (reusing
  `stub.broadcast`).
- **Endpoints:** `GET /connect?channel=X` (WS upgrade), `POST /publish`,
  `GET /history?channel=X&limit=n`, `POST /create-event`, `GET /get-event?id=X`,
  `POST /update-event`, `GET /my-events?page=n&all=0|1` (owner's own records,
  newest first, 12/page, auth-gated, active-only unless `all=1`),
  `POST /submit-score` (public provisional player scores — see below),
  `GET /recovery?token=X` + `POST /set-password` (recovery flow, both public — see
  Auth), `GET /healthz`.
  Channel names must match `^[A-Za-z0-9._:-]{1,128}$`. HTTP endpoints send
  permissive CORS.
- **Auth:** password login + long-lived bearer session tokens (`POST /login`,
  `/logout`, `GET /me`). Users are seeded manually — no signup
  (`npm run create-user -- <name>`). Passwords: PBKDF2-HMAC-SHA256 in
  `backend/src/auth.ts`; sessions store the token's SHA-256 hash. `create-event`
  and `update-event` require a token — the record owner is the authenticated user
  (`ownerid` server-derived, never returned); `update-event` is owner-only (403).
  `get-event`, `/connect`, and `/submit-score` are public (viewers need no account;
  browsers can't set headers on a WS upgrade, so gating `/connect` later means a
  `?token=` param). Frontend keeps the token in `localStorage` and sends
  `Authorization: Bearer`.
- **Password recovery (no email).** The "forgot password" flow, minus any mail
  server: an admin mints a **recovery token** for a user and emails them a
  `/set-password?token=X` link. `create-user` no longer prints a password — it
  creates the user with a random, never-disclosed one (so `password` stays
  `NOT NULL`, `/login` untouched) and prints a recovery link; `npm run
  reset-password -- <name>` mints one for an existing user. Both take `--hostname`
  to print a full URL (raw token otherwise) and live in `backend/scripts/`
  (`recovery.mjs` shared helper). Tokens are single-use, 7-day TTL, stored as a
  SHA-256 hash in the `recovery_tokens` table (mirrors `sessions`). `GET /recovery`
  validates a token (returns the username for the form); `POST /set-password
  {token, password}` (min 8 chars) sets the password, consumes the token, and
  issues a session for auto sign-in. Both public — the token is the credential.
- **Provisional player scores (unauthenticated).** When a record's
  `data.allowPlayerScores` is on, anyone with the public `/view/:id` link can
  propose match scores via `POST /submit-score {id, matchupId, score}` (public —
  the record id is the capability, like `/connect`; 403 if the flag is off, 400 for
  an unknown `matchupId`). These live in the **separate `player_scores` column**
  (`{ matchupId: [a,b] }`), decoupled from the owner's `data` writes so neither
  clobbers the other. Precedence is a read-time overlay: the owner's `data` score
  wins for any matchup it has scored (score ≠ `[-1,-1]`); otherwise the player
  score shows as **provisional**. Writes are race-safe via one atomic
  `json_patch(coalesce(player_scores,'{}'), ?)` statement (distinct matchup keys
  never collide, same-key is last-write-wins) — see `mergePlayerScore` in `db.ts`,
  not app-level read-modify-write. Each submission broadcasts a
  `{ kind: "score.proposed", matchupId, score }` frame so live viewers update. The
  overlay is keyed by a stable **matchup id** (minted in `social.ts`), so owner
  regeneration orphans stale proposals automatically (ephemeral by design).
  `get-event` and `record.updated` carry `player_scores` so viewers see it on cold
  load. Schema note: no migration framework — a new `records` column means editing
  `schema.sql`, the inline `SCHEMA` copy in `test/integration.test.ts`, AND a
  one-off `ALTER TABLE` (`--local` and `--remote`) for existing DBs.

Key files: `backend/src/index.ts` (routing), `backend/src/channel-hub.ts` (DO),
`backend/src/db.ts` (D1), `backend/src/auth.ts` (PBKDF2 + tokens),
`backend/schema.sql`, `backend/wrangler.jsonc`.

## Architecture (frontend — `frontend/`, "Rotation")

Solid 2 RC SPA, file-based routing (`filesystem-routing` + `@solidjs/router`).

- **Owner flow.** `/login` → guard; `/create-event` and `/update-event/:id`
  (`components/EventEditor.tsx`) are the setup surface (roster/courts/metadata).
  (`/login` shows a "Local backend" note when `BACKEND_URL` is localhost/loopback —
  a dev aid so it's obvious you're not signing in against the deployed Worker.)
  The editor is keyed by the **backend record id** (no local-storage layer): create
  mode seeds a blank form; edit mode's outer `EventEditor` fetches `get-event`
  (owner-only, else it bounces to the read-only view) and mounts the inner
  `EventEditorForm` seeded from `record.data`. The `/update-event/:id` route wraps
  it in `<Show keyed when={params.id}>` to force a fresh mount when the id changes
  (the router would otherwise reuse the instance). The update page has: a shareable
  `/view/{recordId}` player link + a "View as player" link, per-player **Sit**
  checkboxes (temporarily bench a player — see optimizer note), a free-text event
  **time** (opaque, so ranges like "11:00 – 1:00" work), and a **Finish / Reopen**
  control that flips the record's status.
- **Set password.** `/set-password?token=X` (`routes/set-password.tsx`, public, no
  guard) is the recovery-link landing page: it validates the token via
  `GET /recovery` (`recovery.ts`) and shows the target username or an
  invalid/expired message, takes a new password + confirm, then `POST /set-password`
  and auto signs-in (`adoptSession` in `auth.ts`) → `/`. Mirrors the `/login` form.
- **My events.** `/my-events` (`routes/my-events.tsx`) lists the signed-in owner's
  records via `GET /my-events` (`listMyEvents` in `records.ts`), newest first,
  12/page, with a "Show finished" filter persisted in `localStorage`
  (`rotation:my-events-all`). Auth-guarded like the editor; header link in `AppNav`.
  Each row opens `/update-event/<recordId>`.
- **Saving.** A brand-new event lives only in the form until the explicit **Create
  social** press (which mints a channel, creates the backend record, and navigates
  to `/update-event/<recordId>`); from then on the editor **auto-saves** edits on a
  ~1s debounce (a `createEffect` over a serialized snapshot of the form →
  `persist()`), flushing any pending save in `onCleanup` if you navigate away. No
  Save button once the record exists — just an "All changes saved" status.
- **Saves are backend-authoritative for untouched fields.** Rounds/scores are
  written by the live rounds page straight to the record, so the form's seed data
  goes stale. Both the explicit `save()` and the auto-save `persist()` build the
  payload via `buildEvent(base)` where `base` is the **freshly-fetched record**
  (not the stale mount-time `initial`), or the save would wipe the rounds. Any
  field the form doesn't render must be preserved this way.
- **Player flow.** `/view/:id` is a **layout** (`routes/view/[id].tsx`) that loads
  the record (public `get-event`) and — unless the event is finished — subscribes
  to its channel (`socket.ts`, auto-reconnect) in a `createEffect` **keyed on the
  id** (so /view/A → /view/B, which reuses the mounted layout, reloads + resubscribes;
  the effect returns its cleanup to tear down the old socket). It shares state with
  its child pages via a context (`view-live.ts`). Children: `index.tsx` (info),
  `rounds.tsx` (live rounds), `stats.tsx` (league table). A finished status shows
  a "Finished" pill and opens no socket (the pill is derived from event status, not
  the transient socket state). Bad id → `ErrorView`.
- **Link previews (`functions/view/[id].ts`).** A SPA can't give link-preview
  crawlers (iMessage, Slack, Facebook, X) per-event Open Graph tags — they don't
  run JS. A Cloudflare **Pages Function** intercepts `/view/:id` and, **for crawler
  user-agents only**, fetches the record from the public backend and injects
  `og:`/`twitter:` tags + the `<title>` via `HTMLRewriter`; humans get the untouched
  SPA (no backend fetch). Ships inside the same `wrangler pages deploy` — no separate
  Worker. Reads `BACKEND_URL` (Pages env var; falls back to the deployed Worker);
  `.dev.vars` points it at a local backend for `npm run preview:pages` (the plain
  Vite `npm run dev` does **not** run Functions). `npm run typecheck` also covers
  `functions/` via `functions/tsconfig.json`. See `frontend/README.md`.
- **Owner-on-view.** `get-event` returns `owner: true` for the owner's token, so the
  rounds page shows owner controls: **generate round** / **regenerate** the current
  unscored round (optimizer runs in a Web Worker — `round-worker.ts` wrapping
  `social-worker.ts`/`social.ts`) and **score entry**. Generate is disabled off the
  last round. Disabled players are folded into the optimizer's `force_sitting` at
  generation time, so they get no court until re-enabled. Saving calls
  `update-event`, which broadcasts to every viewer live.
- **Provisional player scores.** When the owner ticks **Let players enter scores**
  (`EventEditor.tsx` → top-level `SocialEvent.allowPlayerScores`), non-owner viewers
  get per-matchup score inputs + a **Submit** button on the rounds page (→
  `submitScore` in `records.ts` → `/submit-score`). The layout keeps a separate
  `provisional` overlay signal (seeded from `record.player_scores`, patched by
  `score.proposed` frames) and exposes a derived `mergedEvent` (`view-live.ts`
  `overlayProvisional`) that the rounds + stats pages read; raw `event()` stays
  owner-authoritative for saves. Provisional scores render red-tinted, and the
  owner's inputs pre-fill with them as **dirty** so **Save scores** blesses them
  (no accept button — precedence flips once persisted). The rounds page's reseed
  effect keys on the *displayed* scores so live submissions appear immediately, but
  a `touched`-cells set preserves whatever the owner/player is mid-typing.
  **Gotcha:** that effect is declared *after* its `displayScore` helper because this
  Solid 2 RC evaluates a `createEffect` dependency fn eagerly — a dep closing over a
  `const` declared below it hits the TDZ, and the effect silently never registers.
- **Stats** (`stats.tsx` + `standings.ts`) — a live league table with two modes:
  **Games** (games won/lost, Win%, ±) and **Matches** (football 3/1/0 points).
  Competition ranking (ties share a rank); leaders get a crown + bold row. Rows
  whose totals include a provisional score get an **asterisk** (after the medal).
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
npm run create-user -- <name>   # seed a login (prints a recovery link, not a password)
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
