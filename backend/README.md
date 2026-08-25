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
- **Auth.** None yet — connections and publishes are open. Hook points are marked
  `AUTH HOOK` in `src/index.ts`.

## Endpoints

| Method | Path                              | Purpose                                   |
|--------|-----------------------------------|-------------------------------------------|
| GET    | `/connect?channel=<name>`         | WebSocket upgrade; subscribe to a channel |
| POST   | `/publish`                        | `{ channel, type?, payload }` → store + broadcast |
| GET    | `/history?channel=<name>&limit=n` | Recent persisted events (newest first)    |
| GET    | `/healthz`                        | Liveness check                            |

Channel names must match `^[A-Za-z0-9._:-]{1,128}$`.

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
