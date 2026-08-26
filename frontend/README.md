# frontend — Rotation

The product front-end: a client-side SolidJS 2.0 RC SPA for scheduling Padel
**socials** (events where players rotate partners across short matches). Talks to
the `backend/` Worker over WebSockets for live updates. This is the real product
UI — distinct from `test-client/`, which only exercises the backend.

## Stack

- **SolidJS 2.0 RC** (`solid-js` + `@solidjs/web`), Vite 8, TypeScript (`strict` +
  `verbatimModuleSyntax`).
- **File-based routing** via `filesystem-routing` (Vite adapter) feeding
  `@solidjs/router`'s `createRouter`. Route modules live in `src/routes/`; a module
  is a page via its default export (`index.tsx` → `/`). Strictly client-side — no
  SSR.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5174  (backend runs separately on :8787)
```

Other scripts: `npm run build` (emits `dist/`), `npm run preview`,
`npm run typecheck`.

Backend URL defaults to `http://localhost:8787`; override with a `VITE_BACKEND_URL`
env var (e.g. in `.env` or the Pages build environment).

## Layout

- `src/routes/` — pages (file-based routing).
- `src/app.tsx` — wires the router; the render-prop is the app shell.
- `src/api.ts` — HTTP helpers (`health`, `publish`, `getHistory`, `wsUrl`).
- `src/socket.ts` — typed WebSocket client (`createSocket`) for `/connect`;
  receive-only with a `ping`/`pong` keepalive. Wired but not yet consumed by a page.
- `src/types.ts` — event/response shapes mirroring the backend.

## Deploy (Cloudflare Pages)

Static SPA, no SSR / no Pages Functions.

- Build command: `npm run build`
- Output directory: `dist`
- Root directory: `frontend`
- `public/_redirects` (`/* /index.html 200`) provides the SPA fallback so deep-link
  refreshes reach the client router instead of 404ing.

## Solid 2 RC notes

Same bleeding-edge caveats as `test-client` (see root `CLAUDE.md`): import `render`
and control-flow from `@solidjs/web`; `createEffect` takes **two** functions; no
`onMount`; don't destructure component `props`.
