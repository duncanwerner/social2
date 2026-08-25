# do-sockets test client

A small **SolidJS 2.0 (RC)** + TypeScript web app for exercising the `backend/`
Worker interactively: connect to channels over WebSocket, publish events, watch
pushes arrive live, pull history, and hit health.

Developer tool only — not the eventual product UI.

## Stack

Solid 2 is pre-release and differs from Solid 1:

- `solid-js@2.0.0-rc.2` — reactivity (`createSignal`, `createEffect`, `onCleanup`).
- `@solidjs/web@2.0.0-rc.2` — DOM renderer + control flow (`render`, `For`, `Show`).
  In Solid 1 these lived at `solid-js/web`.
- `@solidjs/vite-plugin@3.0.0-next` — build plugin (successor to `vite-plugin-solid`).
- `vite@8`, `typescript@5.9`. `tsconfig` uses `jsxImportSource: "@solidjs/web"`.

> **Solid 2 gotcha:** `createEffect` now takes **two** functions —
> `createEffect(() => track(), (value) => effect(value))`. The Solid-1 one-arg
> form throws `MISSING_EFFECT_FN` at runtime (it halts reactivity → blank screen)
> even though it type-checks and builds. `onMount` was also removed. These fail
> only at runtime, so verify changes in a real browser, not just via typecheck/build.

## Run it

The client talks to the backend over HTTP + WebSocket, so start the backend first.

```bash
# Terminal 1 — backend (local Miniflare on :8787)
cd ../backend
npm install
npm run db:init        # apply D1 schema to local storage (one-time)
npm run dev

# Terminal 2 — this client (Vite on :5173)
cd test-client
npm install
npm run dev
```

Open http://localhost:5173. The default backend base URL is
`http://localhost:8787` (editable in the top bar).

## Panels

- **Settings bar** — backend base URL + a health check.
- **Connection** — one WebSocket at a time. Enter a channel, Connect, and watch
  inbound events stream into the log. `Send ping` (and the `auto-ping 20s`
  toggle) exercise the Durable Object's keepalive auto-`pong`.
- **Publish** — channel + optional type + a raw JSON payload editor (validated
  before send). Shows the `{ id, created_at, delivered }` response. Publish to a
  *different* channel than you're connected to, to prove isolation.
- **History** — fetch recent persisted events for a channel from D1.

## Testing channel isolation

Open the page in two tabs. Connect tab A to `demo` and tab B to `other`. Publish
to `demo` from either tab — only tab A's log updates, and the publish response
shows `delivered: 1`.

## Scripts

```bash
npm run dev        # Vite dev server (HMR)
npm run build      # production build to dist/
npm run preview    # serve the production build
npm run typecheck  # tsc --noEmit
```

## Notes

- Cross-origin calls to `:8787` rely on the backend's permissive CORS; no proxy.
- The backend currently has no auth, so the client sends no credentials.
