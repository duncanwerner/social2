# Deploying do-sockets

Two pieces ship separately:

- **Backend** → Cloudflare **Workers** + Durable Objects + D1
  (`do-sockets-backend.trebdev.workers.dev`).
- **Frontend** ("Rotation") → Cloudflare **Pages** (`<project>.pages.dev`).

They are **different hosts** by design. The frontend finds the backend through a
single build-time constant, `BACKEND_URL` in `frontend/src/api.ts`, driven by the
`VITE_BACKEND_URL` env var (falling back to `http://localhost:8787` for local
dev). The WebSocket URL is derived from the same base (`https://` → `wss://`), so
there is nothing else to configure. CORS on the Worker is permissive
(`Access-Control-Allow-Origin: *`, allowing the `Authorization` header), so the
cross-origin Pages → Worker calls work as-is.

Deploy the **backend first** — you need its URL to configure the frontend.

## Phase 1 — Backend (Workers + D1)

```bash
cd backend
npx wrangler login
```

1. **Create the production D1 database:**

   ```bash
   npx wrangler d1 create do-sockets
   ```

   This prints a `database_id`. **Paste it into `backend/wrangler.jsonc`**,
   replacing the `"REPLACE_WITH_ID_FROM_wrangler_d1_create"` placeholder. Deploy
   fails until this is a real id. (Local `wrangler dev` ignores it — local D1 is
   keyed by `database_name` — so this only matters for deploying.)

2. **Apply the schema to the remote database:**

   ```bash
   npm run db:init:remote     # wrangler d1 execute do-sockets --remote --file=./schema.sql
   ```

3. **Deploy the Worker:**

   ```bash
   npm run deploy
   ```

   Note the printed URL — `https://do-sockets-backend.trebdev.workers.dev`.
   Sanity-check it:

   ```bash
   curl https://do-sockets-backend.trebdev.workers.dev/healthz
   # → {"ok":true}
   ```

4. **Seed a production login** (there is no signup endpoint by design):

   ```bash
   npm run create-user -- <name> --remote
   ```

   Save the random password it prints — it is shown only once.

   **Rotating a password.** Usernames are unique, so re-running the command for
   an existing user errors. To reset instead, add `--force`:

   ```bash
   npm run create-user -- <name> --remote --force
   ```

   This keeps the user's id (so their records stay owned), prints a fresh
   password, and revokes their existing sessions (they'll need to log in again).

## Phase 2 — Frontend (Pages)

Set the backend URL as a Pages build environment variable:

```
VITE_BACKEND_URL = https://do-sockets-backend.trebdev.workers.dev
```

(No trailing slash needed — `normalizeBase()` strips it.) Because Vite inlines
this at **build time**, changing it requires a rebuild.

Build settings:

| Setting            | Value           |
| ------------------ | --------------- |
| Root directory     | `frontend`      |
| Build command      | `npm run build` |
| Output directory   | `dist`          |

**Git-connected Pages (recommended):** point the Pages project at this repo with
the settings above; it rebuilds on push, and `VITE_BACKEND_URL` lives in the
project's environment variables.

**Direct upload alternative:**

```bash
cd frontend
VITE_BACKEND_URL=https://do-sockets-backend.trebdev.workers.dev npm run build
npx wrangler pages deploy dist
```

## Verify

1. Open the `*.pages.dev` URL and log in with the seeded user.
2. Create an event, then open its `/view/{recordId}` link.
3. In the browser Network tab, confirm the `wss://…/connect` WebSocket connects
   and that a score/round change pushes live to the viewer.

## Notes

- **No Worker secrets to manage.** Auth uses the D1 `users`/`sessions` tables, not
  env secrets — nothing to `wrangler secret put`.
- **Locking down CORS later** (optional hardening): replace the `*` in
  `backend/src/index.ts` with your Pages origin.
- **Custom domains** (optional): bind the Worker to e.g. `api.example.com` via a
  route and set `VITE_BACKEND_URL` to it; put the Pages site on your apex/`www`.
