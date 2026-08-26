import type { ChannelHub } from "./channel-hub";

/**
 * Worker bindings. Kept in sync with wrangler.jsonc.
 * (You can also generate a global `Env` with `npm run typegen`; this explicit
 * interface keeps type-checking self-contained and gives the DO namespace its
 * RPC type parameter.)
 */
export interface Env {
  CHANNEL_HUB: DurableObjectNamespace<ChannelHub>;
  DB: D1Database;
}

/** Body of a POST /publish request. */
export interface PublishRequest {
  channel: string;
  type?: string | null;
  payload: unknown;
}

/** An event as persisted in D1 and returned by GET /history. */
export interface EventRecord {
  id: number;
  channel: string;
  type: string | null;
  payload: unknown;
  created_at: string;
}

/**
 * A record (padel social) as persisted in the `records` table and returned by
 * the /create-event, /get-event, and /update-event routes. Named `RecordEntity`
 * to avoid shadowing the built-in `Record<K, V>` utility type.
 */
export interface RecordEntity {
  id: string;
  status: number;
  data: unknown; // decoded JSON
  ownerid: string;
  channel: string;
  created_at: string;
}

/**
 * The client-facing view of a record. `ownerid` is write-only (accepted on
 * create, used server-side) and is never returned to clients or broadcast to
 * viewers, so it's omitted here.
 */
export type PublicRecord = Omit<RecordEntity, "ownerid">;

/** Body of a POST /create-event request. `ownerid` is derived from the session. */
export interface CreateEventRequest {
  data: unknown;
  channel: string;
  status?: number; // optional; defaults to 0
}

/** Body of a POST /update-event request. */
export interface UpdateEventRequest {
  id: string;
  status?: number;
  data?: unknown;
}

/** Pushed to a record's channel when the record changes. */
export interface RecordUpdate {
  kind: "record.updated";
  record: PublicRecord;
}

/** The message pushed to connected WebSocket clients. */
export type OutboundMessage = EventRecord | RecordUpdate;

/** A user row. `password` is the encoded PBKDF2 hash (never returned to clients). */
export interface User {
  id: string;
  username: string;
  password: string;
}

/** The client-facing view of a user. */
export type PublicUser = Pick<User, "id" | "username">;

/** Body of a POST /login request. */
export interface LoginRequest {
  username: string;
  password: string;
}
