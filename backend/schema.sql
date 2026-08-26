-- D1 schema for do-sockets backend.
-- The event log: every published event is persisted here, then broadcast to
-- any WebSocket clients connected to the event's channel.

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,
  type       TEXT,
  payload    TEXT NOT NULL,            -- JSON-encoded event body
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_channel ON events (channel, id);

-- Records: first-class application entities (padel socials) created, fetched, and
-- updated over HTTP. Each is bound to a websocket `channel` so updates can be
-- broadcast live to connected clients.
CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,          -- UUID, generated in the Worker
  status     INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL,             -- JSON-encoded record body
  ownerid    TEXT NOT NULL,
  channel    TEXT NOT NULL,             -- websocket channel / Durable Object name
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_records_channel ON records (channel);

-- Owner-scoped, newest-first listing (GET /my-events).
CREATE INDEX IF NOT EXISTS idx_records_owner ON records (ownerid, created_at);

-- Users: manually seeded (no signup). `password` is an encoded PBKDF2 string:
-- pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,          -- UUID
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,             -- encoded PBKDF2 hash (see auth.ts)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions: long-lived bearer tokens. We store only the SHA-256 of the token, so
-- a database leak can't yield usable tokens.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,          -- sha-256(token), hex
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
