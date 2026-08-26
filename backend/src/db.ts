import { SESSION_TTL_DAYS } from "./auth";
import type { Env, EventRecord, RecordEntity, User } from "./types";

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

// --- records ---------------------------------------------------------------

/** Raw `records` row as stored in D1 (JSON `data` still a string). */
interface RecordRow {
  id: string;
  status: number;
  data: string;
  ownerid: string;
  channel: string;
  created_at: string;
}

function toRecord(r: RecordRow): RecordEntity {
  return {
    id: r.id,
    status: r.status,
    data: safeParse(r.data),
    ownerid: r.ownerid,
    channel: r.channel,
    created_at: r.created_at,
  };
}

export interface InsertRecordInput {
  id: string;
  status: number;
  /** JSON-encoded record body. */
  data: string;
  ownerid: string;
  channel: string;
}

/** Persist a new record and return it (with the generated `created_at`). */
export async function insertRecord(
  env: Env,
  input: InsertRecordInput,
): Promise<RecordEntity> {
  const row = await env.DB.prepare(
    `INSERT INTO records (id, status, data, ownerid, channel)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id, status, data, ownerid, channel, created_at`,
  )
    .bind(input.id, input.status, input.data, input.ownerid, input.channel)
    .first<RecordRow>();

  if (!row) throw new Error("insert_failed");
  return toRecord(row);
}

/** Fetch a single record by id, or null if it doesn't exist. */
export async function getRecord(
  env: Env,
  id: string,
): Promise<RecordEntity | null> {
  const row = await env.DB.prepare(
    `SELECT id, status, data, ownerid, channel, created_at
     FROM records
     WHERE id = ?`,
  )
    .bind(id)
    .first<RecordRow>();

  return row ? toRecord(row) : null;
}

/**
 * Update a record's mutable fields (`status` and/or `data`, `data` passed
 * pre-stringified) and return the new state, or null if no such record. At
 * least one field must be provided by the caller.
 */
export async function updateRecord(
  env: Env,
  id: string,
  fields: { status?: number; data?: string },
): Promise<RecordEntity | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (fields.status !== undefined) {
    sets.push("status = ?");
    binds.push(fields.status);
  }
  if (fields.data !== undefined) {
    sets.push("data = ?");
    binds.push(fields.data);
  }

  const row = await env.DB.prepare(
    `UPDATE records
     SET ${sets.join(", ")}
     WHERE id = ?
     RETURNING id, status, data, ownerid, channel, created_at`,
  )
    .bind(...binds, id)
    .first<RecordRow>();

  return row ? toRecord(row) : null;
}

// --- users & sessions ------------------------------------------------------

/** Insert a user (id + username + encoded password hash). */
export async function insertUser(
  env: Env,
  input: { id: string; username: string; password: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, username, password) VALUES (?, ?, ?)`,
  )
    .bind(input.id, input.username, input.password)
    .run();
}

export async function getUserByUsername(
  env: Env,
  username: string,
): Promise<User | null> {
  return env.DB.prepare(
    `SELECT id, username, password FROM users WHERE username = ?`,
  )
    .bind(username)
    .first<User>();
}

export async function getUserById(
  env: Env,
  id: string,
): Promise<User | null> {
  return env.DB.prepare(
    `SELECT id, username, password FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<User>();
}

/** Create a session with a TTL of SESSION_TTL_DAYS from now. */
export async function insertSession(
  env: Env,
  input: { token_hash: string; user_id: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`,
  )
    .bind(input.token_hash, input.user_id, `+${SESSION_TTL_DAYS} days`)
    .run();
}

/** Look up a non-expired session by token hash. Expired rows return null. */
export async function getSession(
  env: Env,
  token_hash: string,
): Promise<{ user_id: string } | null> {
  return env.DB.prepare(
    `SELECT user_id FROM sessions
     WHERE token_hash = ? AND expires_at > datetime('now')`,
  )
    .bind(token_hash)
    .first<{ user_id: string }>();
}

export async function deleteSession(
  env: Env,
  token_hash: string,
): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`)
    .bind(token_hash)
    .run();
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
