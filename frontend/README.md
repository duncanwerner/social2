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

Static SPA (no app SSR), plus one small edge function for link previews.

- Build command: `npm run build`
- Output directory: `dist`
- Root directory: `frontend`
- `public/_redirects` (`/* /index.html 200`) provides the SPA fallback so deep-link
  refreshes reach the client router instead of 404ing.

### Link-preview meta (`functions/view/[id].ts`)

Crawlers that build link previews (iMessage, Slack, Facebook, X, …) don't run JS,
so the SPA can't give them per-event Open Graph tags. This **Pages Function**
intercepts `/view/:id` and, **for crawler user-agents only**, fetches the event
from the public backend and injects `og:`/`twitter:` tags (and the `<title>`) via
`HTMLRewriter` before returning the shell. Humans get the SPA untouched — no
backend fetch, no rewrite. Functions ship inside the same `wrangler pages deploy`
(no separate Worker); the function only runs on `/view/*`.

- It reads `BACKEND_URL` (the backend origin for `get-event`); set it in the Pages
  project's env vars for production. It falls back to the deployed Worker if unset.
- **Run it locally** against your local backend (the plain `npm run dev` Vite server
  does *not* execute Functions):

  ```bash
  npm run preview:pages      # build + `wrangler pages dev dist`
  ```

  `wrangler pages dev` auto-loads `.dev.vars` (gitignored) for `BACKEND_URL` — it
  ships pointing at `http://localhost:8787`. Verify by curling with a bot UA:

  ```bash
  curl -sA Googlebot http://localhost:8788/view/<id> | grep 'og:title'
  ```
- `npm run typecheck` also type-checks `functions/` (via `functions/tsconfig.json`,
  which pulls in `@cloudflare/workers-types`).

> **Advisory — verifying a deploy on the right URL.** `wrangler pages deploy`
> reads the *current git branch* to decide production vs preview. Deploying from
> any branch other than the project's production branch (`main`) publishes a
> **preview** deployment at its own hashed URL and leaves the production
> `*.pages.dev` domain on the previous build. So when validating a change on the
> live site, confirm you're loading the **URL wrangler just printed** (the
> deployment/preview URL), not the base production URL — otherwise you're testing
> stale code and will wrongly suspect caching. To actually update production,
> deploy from `main` (or pass `--branch main`). CSS/JS are content-hashed, so a
> real production deploy always serves new filenames; if the served
> `<link rel="stylesheet">` hash hasn't changed, the deploy didn't land where you
> looked.

## Solid 2 RC notes

Same bleeding-edge caveats as `test-client` (see root `CLAUDE.md`): import `render`
and control-flow from `@solidjs/web`; `createEffect` takes **two** functions; no
`onMount`; don't destructure component `props`.
