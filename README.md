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
| [`frontend/`](frontend/README.md) | **Rotation** — the product UI. A client-side SolidJS 2.0 RC SPA (file-based routing) for scheduling Padel socials, deployed on Cloudflare Pages. |

## How it works

Clients connect to `GET /connect?channel=X` and land on that channel's Durable
Object. A producer `POST`s an event to `/publish`; the Worker stores it in D1 and
broadcasts it to every socket on that channel. Hibernation means a few dozen idle
connections cost nothing until data actually flows — the reason this platform was
chosen for a low-utilization workload.

## The Rotation app

`frontend/` is **Rotation**: schedule a Padel *social* (players rotate partners
across short matches), then run it live.

- **Owner** signs in, creates an event (roster, courts, metadata), and shares a
  public `/view/{id}` link.
- **Players** open that link — event info, rounds, and stats — and see updates
  live over the WebSocket (no account needed).
- On the **rounds** page the signed-in owner generates each round (the optimizer
  runs in a Web Worker) and enters scores; every save broadcasts to all viewers.

## Quick start

```bash
# Backend (local Miniflare on :8787)
cd backend && npm install && npm run db:init && npm run dev
npm run create-user -- <name>      # seed a login (prints a random password once)

# Frontend (Vite on :5174) — in a second terminal
cd frontend && npm install && npm run dev
```

Then open http://localhost:5174, sign in, and create a social. (The `test-client/`
package remains a minimal dev tool for the raw pub/sub endpoints.)

## Status

- Backend: implemented and tested — pub/sub + a `records` table for events, and
  **auth** (password login, bearer session tokens, owner-scoped record writes).
- Frontend (`frontend/`, "Rotation"): login + guard, event editor, and the public
  player view (info / rounds / stats) with live updates and owner round-generation
  + score entry. Rounds page is live; a dedicated stats page is still a stub.

See [`CLAUDE.md`](CLAUDE.md) for architecture and development notes.
