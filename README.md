# do-sockets

Server-push notifications for web apps: browsers keep a WebSocket open and receive
state updates without polling or refreshes. Built on Cloudflare Workers, Durable
Objects (with WebSocket **hibernation**, so idle connections aren't billed), and
D1.

## Packages

| Package | What it is |
|---------|-----------|
| [`backend/`](backend/README.md) | The service — a Cloudflare Worker with a `ChannelHub` Durable Object per channel and a D1 event log. |
| [`test-client/`](test-client/README.md) | A SolidJS 2.0 RC dev tool to exercise the backend (connect, publish, watch pushes, history). Not the product UI. |

## How it works

Clients connect to `GET /connect?channel=X` and land on that channel's Durable
Object. A producer `POST`s an event to `/publish`; the Worker stores it in D1 and
broadcasts it to every socket on that channel. Hibernation means a few dozen idle
connections cost nothing until data actually flows — the reason this platform was
chosen for a low-utilization workload.

## Quick start

```bash
# Backend (local Miniflare on :8787)
cd backend && npm install && npm run db:init && npm run dev

# Test client (Vite on :5173) — in a second terminal
cd test-client && npm install && npm run dev
```

Then open http://localhost:5173, connect to a channel, and publish an event to see
it pushed live.

## Status

- Backend: implemented and tested (persistence, channel-isolated delivery,
  keepalive). **No auth yet** — hook points are marked in `backend/src/index.ts`.
- Test client: implemented, verified end-to-end.
- Front-end product UI: not started.

See [`CLAUDE.md`](CLAUDE.md) for architecture and development notes.
