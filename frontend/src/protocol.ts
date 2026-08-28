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
  /**
   * Provisional, unauthenticated player-entered scores: a map of
   * `matchupId -> [a, b]`, overlaid on the owner-authoritative `data` scores at
   * read time. Always present (defaults to `{}`) from the backend.
   */
  player_scores?: Record<string, [number, number]>;
  /** Only from GET /get-event: true when the caller's token owns the record. */
  owner?: boolean;
}

/** /update-event also reports how many live sockets received the broadcast. */
export interface UpdateRecordResponse extends RecordEntity {
  delivered: number;
}

/** One page of the caller's own records from GET /my-events (newest first). */
export interface MyEventsResponse {
  records: RecordEntity[];
  page: number;
  /** Whether a further page exists after this one. */
  hasMore: boolean;
}

/** GET /recovery — a valid recovery token, with the target user's name. */
export interface RecoveryCheckResponse {
  valid: true;
  username: string;
}

/** POST /set-password — a fresh session (auto sign-in), mirroring /login. */
export interface SetPasswordResponse {
  token: string;
  user: { id: string; username: string };
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

/** The frame broadcast when a player submits a provisional score for a matchup. */
export interface ScoreProposed {
  kind: "score.proposed";
  matchupId: string;
  score: [number, number];
}

/** Narrow a parsed WebSocket frame to a provisional-score envelope. */
export function isScoreProposed(msg: unknown): msg is ScoreProposed {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { kind?: unknown }).kind === "score.proposed"
  );
}

/** POST /submit-score — how many live sockets received the proposed score. */
export interface SubmitScoreResponse {
  ok: true;
  delivered: number;
}
