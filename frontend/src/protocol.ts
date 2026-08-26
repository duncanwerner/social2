// Wire types for talking to the backend. Mirrors the shapes returned by
// backend/src/index.ts. Duplicated across packages by design — there is no
// shared types package yet.

export interface EventRecord {
  id: number;
  channel: string;
  type: string | null;
  payload: unknown;
  created_at: string;
}

export interface PublishResponse {
  id: number;
  created_at: string;
  delivered: number;
}

export interface HistoryResponse {
  channel: string;
  events: EventRecord[];
}

/** A frame pushed over the WebSocket is a single event record. */
export type OutboundMessage = EventRecord;

/**
 * A record as returned by /create-event, /get-event, /update-event. `ownerid`
 * is write-only on the backend (accepted on create, never returned), so it is
 * not part of the client-facing shape.
 */
export interface RecordEntity {
  id: string;
  status: number;
  data: unknown;
  channel: string;
  created_at: string;
  /** Only from GET /get-event: true when the caller's token owns the record. */
  owner?: boolean;
}

/** /update-event also reports how many live sockets received the broadcast. */
export interface UpdateRecordResponse extends RecordEntity {
  delivered: number;
}

/** The frame broadcast to a record's channel when it changes. */
export interface RecordUpdate {
  kind: "record.updated";
  record: RecordEntity;
}

/** Narrow a parsed WebSocket frame to a record-update envelope. */
export function isRecordUpdate(msg: unknown): msg is RecordUpdate {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { kind?: unknown }).kind === "record.updated"
  );
}
