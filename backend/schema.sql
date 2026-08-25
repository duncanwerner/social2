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
