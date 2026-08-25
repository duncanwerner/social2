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

/** The message pushed to connected WebSocket clients. */
export type OutboundMessage = EventRecord;
