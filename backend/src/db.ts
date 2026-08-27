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
 * Records owned by `ownerid`, newest first, one page at a time. `created_at` has
 * whole-second granularity so `id` is the tiebreaker for a stable order. When
 * `includeFinished` is false, Finished records (status 2) are omitted. Callers
 * fetch `limit + 1` rows to detect a next page without a separate COUNT.
 */
export async function recordsByOwner(
  env: Env,
  ownerid: string,
  opts: { limit: number; offset: number; includeFinished: boolean },
): Promise<RecordEntity[]> {
  const where = opts.includeFinished
    ? "ownerid = ?"
    : "ownerid = ? AND status = 0";
  const result = await env.DB.prepare(
    `SELECT id, status, data, ownerid, channel, created_at
     FROM records
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(ownerid, opts.limit, opts.offset)
    .all<RecordRow>();

  return (result.results ?? []).map(toRecord);
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

/** Update a user's encoded password hash. */
export async function updateUserPassword(
  env: Env,
  input: { id: string; password: string },
): Promise<void> {
  await env.DB.prepare(`UPDATE users SET password = ? WHERE id = ?`)
    .bind(input.password, input.id)
    .run();
}

// --- recovery tokens -------------------------------------------------------

/** How long a recovery token stays valid after it's minted. */
export const RECOVERY_TTL_DAYS = 7;

/**
 * Mint a recovery token for a user (stores only its hash). Any earlier unused
 * tokens for the same user should be cleared first via
 * `deleteRecoveryTokensForUser` so only the latest link works.
 */
export async function insertRecoveryToken(
  env: Env,
  input: { token_hash: string; user_id: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO recovery_tokens (token_hash, user_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`,
  )
    .bind(input.token_hash, input.user_id, `+${RECOVERY_TTL_DAYS} days`)
    .run();
}

/** Look up a valid (unused, unexpired) recovery token by its hash. */
export async function getValidRecoveryToken(
  env: Env,
  token_hash: string,
): Promise<{ user_id: string } | null> {
  return env.DB.prepare(
    `SELECT user_id FROM recovery_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(token_hash)
    .first<{ user_id: string }>();
}

/** Mark a recovery token consumed so it can't be reused. */
export async function markRecoveryTokenUsed(
  env: Env,
  token_hash: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE recovery_tokens SET used_at = datetime('now') WHERE token_hash = ?`,
  )
    .bind(token_hash)
    .run();
}

/** Invalidate a user's outstanding recovery tokens (e.g. before minting a new one). */
export async function deleteRecoveryTokensForUser(
  env: Env,
  user_id: string,
): Promise<void> {
  await env.DB.prepare(`DELETE FROM recovery_tokens WHERE user_id = ?`)
    .bind(user_id)
    .run();
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
