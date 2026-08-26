import { BACKEND_URL, normalizeBase } from "./api";
import { ApiError, parseOrThrow } from "./api-error";
import { untrack } from "solid-js";
import { clearAuth, token } from "./auth";
import type {
  MyEventsResponse,
  RecordEntity,
  UpdateRecordResponse,
} from "./protocol";
import type { SocialEvent } from "./types";

// HTTP client for the backend records API (/create-event, /get-event,
// /update-event). The record's `data` blob is a SocialEvent. Mutations send the
// bearer token; the owner is derived server-side from the session.

// Re-exported for existing importers.
export { ApiError };

/** JSON headers plus the bearer token when signed in. */
function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  // Point-in-time read: a request captures the current token; building headers
  // must never subscribe (this runs during render on some load paths).
  const t = untrack(token);
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  // An expired/revoked session — drop it so the UI can re-guard to /login.
  if (res.status === 401) clearAuth();
  return parseOrThrow<T>(res);
}

export function createRecord(
  input: { data: SocialEvent; channel: string },
  base: string = BACKEND_URL,
): Promise<RecordEntity> {
  return request<RecordEntity>(`${normalizeBase(base)}/create-event`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
}

export function getRecord(
  id: string,
  base: string = BACKEND_URL,
): Promise<RecordEntity> {
  // Send the token when signed in so the backend can flag ownership (`owner`).
  return request<RecordEntity>(
    `${normalizeBase(base)}/get-event?id=${encodeURIComponent(id)}`,
    { headers: headers() },
  );
}

/**
 * A page of the signed-in user's own records, newest first. `all` includes
 * finished events (default is active-only). Sends the bearer token.
 */
export function listMyEvents(
  input: { page: number; all: boolean },
  base: string = BACKEND_URL,
): Promise<MyEventsResponse> {
  const query = `?page=${input.page}&all=${input.all ? "1" : "0"}`;
  return request<MyEventsResponse>(
    `${normalizeBase(base)}/my-events${query}`,
    { headers: headers() },
  );
}

export function updateRecord(
  input: { id: string; status?: number; data?: SocialEvent },
  base: string = BACKEND_URL,
): Promise<UpdateRecordResponse> {
  return request<UpdateRecordResponse>(`${normalizeBase(base)}/update-event`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(input),
  });
}
