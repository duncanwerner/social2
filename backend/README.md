# do-sockets backend

Cloudflare Worker that pushes server events to browsers over WebSockets, backed
by Durable Objects (with **hibernation**, so idle connections aren't billed) and
D1 for durable storage.

## Model

- **Channels.** Clients connect to a named channel; each channel maps to one
  `ChannelHub` Durable Object instance (`idFromName(channel)`). Events are fanned
  out only to sockets on the same channel.
- **Publish.** A producer POSTs an event to the Worker; it is written to D1 and
  then broadcast to the channel's live sockets.
- **Records.** First-class entities (padel socials) stored in the `records` table
  and managed over HTTP (`create`/`get`/`update`). Each record carries a `channel`;
  updating a record broadcasts its new state to that channel's live sockets as a
  `{ kind: "record.updated", record }` frame.
- **Auth.** Password login with long-lived bearer session tokens. Users are seeded
  manually (no signup). `create-event`/`update-event` require a token; the record
  owner is the authenticated user (`ownerid` is server-derived, never client-set,
  never returned). `get-event` and `/connect` are public. Passwords are hashed with
  PBKDF2-HMAC-SHA256 (`src/auth.ts`); tokens are stored as their SHA-256 hash.

## Endpoints

| Method | Path                              | Purpose                                   |
|--------|-----------------------------------|-------------------------------------------|
| POST   | `/login`                          | `{ username, password }` → `{ token, user }` (401 on failure) |
| POST   | `/logout`                         | Revoke the caller's session (bearer token) |
| GET    | `/me`                             | Current user for a bearer token (401 otherwise) |
| GET    | `/connect?channel=<name>`         | WebSocket upgrade; subscribe to a channel (public) |
| POST   | `/publish`                        | `{ channel, type?, payload }` → store + broadcast |
| GET    | `/history?channel=<name>&limit=n` | Recent persisted events (newest first)    |
| POST   | `/create-event` 🔒                | `{ data, channel, status? }` → new record (201); owner = session user |
| GET    | `/get-event?id=<uuid>`            | Fetch one record (public; 404 if unknown). With the owner's bearer token, response adds `owner: true` |
| POST   | `/update-event` 🔒                | `{ id, status?, data? }` → update (owner-only, 403 otherwise) + broadcast |
| GET    | `/healthz`                        | Liveness check                            |

🔒 = requires `Authorization: Bearer <token>`. Channel names must match
`^[A-Za-z0-9._:-]{1,128}$`. Record `id`s are server-generated UUIDs.

### Storage

Four D1 tables (`schema.sql`): `events` (pub/sub log), `records` (id `TEXT` UUID,
`status`, `data` JSON, `ownerid`, `channel`, `created_at`), `users` (`username`
unique, `password` = encoded PBKDF2 hash), and `sessions` (`token_hash`, `user_id`,
`expires_at`).

### Users

No signup — seed the first users manually (needs the DB schema applied):

```bash
npm run create-user -- <username>            # local D1; prints a random password once
npm run create-user -- <username> --remote   # deployed D1
```

## Setup

```bash
cd backend
npm install

# Create the D1 database, then paste the printed database_id into wrangler.jsonc.
npx wrangler d1 create do-sockets

# Apply the schema to the local (Miniflare) D1.
npm run db:init

# Run locally on http://localhost:8787
npm run dev
```

## Try it

```bash
# Terminal A — subscribe (any WebSocket client works; wscat shown here):
npx wscat -c "ws://localhost:8787/connect?channel=demo"

# Terminal B — publish:
curl -X POST localhost:8787/publish \
  -H 'content-type: application/json' \
  -d '{"channel":"demo","type":"test","payload":{"hi":1}}'

# Terminal A prints: {"id":1,"channel":"demo","type":"test","payload":{"hi":1},"created_at":"..."}

curl "localhost:8787/history?channel=demo"
```

## Test

```bash
npm test        # vitest + @cloudflare/vitest-pool-workers (DO + D1 in-process)
npm run typecheck
```

## Deploy

```bash
npm run db:init:remote   # apply schema to the remote D1
npm run deploy
```

## Keepalive

Clients should send the text frame `ping` periodically; the Durable Object
auto-responds `pong` without waking, keeping the connection alive during idle
periods without incurring compute charges.
