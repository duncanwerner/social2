// Mirrors the shapes returned by backend/src/index.ts.

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
