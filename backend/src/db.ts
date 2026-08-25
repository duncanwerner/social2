import type { Env, EventRecord } from "./types";

export interface InsertEventInput {
  channel: string;
  type: string | null;
  /** JSON-encoded payload string. */
  payload: string;
}

export interface InsertedEvent {
  id: number;
  created_at: string;
}

/** Persist an event and return its generated id + timestamp. */
export async function insertEvent(
  env: Env,
  input: InsertEventInput,
): Promise<InsertedEvent> {
  const row = await env.DB.prepare(
    `INSERT INTO events (channel, type, payload)
     VALUES (?, ?, ?)
     RETURNING id, created_at`,
  )
    .bind(input.channel, input.type, input.payload)
    .first<{ id: number; created_at: string }>();

  if (!row) throw new Error("insert_failed");
  return { id: row.id, created_at: row.created_at };
}

/** Most-recent events for a channel, newest first (bounded by `limit`). */
export async function recentEvents(
  env: Env,
  channel: string,
  limit: number,
): Promise<EventRecord[]> {
  const result = await env.DB.prepare(
    `SELECT id, channel, type, payload, created_at
     FROM events
     WHERE channel = ?
     ORDER BY id DESC
     LIMIT ?`,
  )
    .bind(channel, limit)
    .all<{
      id: number;
      channel: string;
      type: string | null;
      payload: string;
      created_at: string;
    }>();

  return (result.results ?? []).map((r) => ({
    id: r.id,
    channel: r.channel,
    type: r.type,
    payload: safeParse(r.payload),
    created_at: r.created_at,
  }));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
