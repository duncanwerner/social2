import { CreatePlayerID } from "./social";
import type { SocialEvent } from "./types";

// Local persistence for social events, keyed by id. This is a temporary
// placeholder for the backend records API (/create-event, /get-event,
// /update-event) — same read/write shape, so swapping it later is contained to
// this file. Events live in localStorage under `rotation:event:<id>`.

const KEY_PREFIX = "rotation:event:";

/** A fresh id for a newly-created event. */
export function newEventId(): string {
  return crypto.randomUUID();
}

/** A blank event for the create form: a realistic default roster to tweak. */
export function blankEvent(): SocialEvent {
  return {
    players: Array.from({ length: 8 }, (_, i) => ({
      id: CreatePlayerID(i),
      name: "",
    })),
    courts: Array.from({ length: 2 }, () => ({})),
    metadata: { name: "", description: "", location: "", date: "", time: "" },
  };
}

/** Load an event by id, or null if it isn't stored (or storage is unavailable). */
export function loadEvent(id: string): SocialEvent | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + id);
    return raw ? (JSON.parse(raw) as SocialEvent) : null;
  } catch {
    return null;
  }
}

/** Persist an event under the given id. */
export function saveEvent(id: string, event: SocialEvent): void {
  try {
    localStorage.setItem(KEY_PREFIX + id, JSON.stringify(event));
  } catch {
    /* storage unavailable or over quota — ignore for now */
  }
}

// --- local→backend record mapping ------------------------------------------
// Links a local event id to the backend record it created (owned by the signed-in
// user), so later saves update that record instead of creating a new one.

const REF_PREFIX = "rotation:recordref:";

/** Backend record a local event has been pushed to. */
export interface RecordRef {
  id: string;
  channel: string;
}

export function loadRecordRef(localId: string): RecordRef | null {
  try {
    const raw = localStorage.getItem(REF_PREFIX + localId);
    return raw ? (JSON.parse(raw) as RecordRef) : null;
  } catch {
    return null;
  }
}

export function saveRecordRef(localId: string, ref: RecordRef): void {
  try {
    localStorage.setItem(REF_PREFIX + localId, JSON.stringify(ref));
  } catch {
    /* ignore */
  }
}

/**
 * Reverse of loadRecordRef: the local event id that created a given backend
 * record, or null if this browser has no local copy (e.g. created elsewhere).
 * Used by the view page to offer the owner an "edit" link back to the editor,
 * which is keyed by local id.
 */
export function findLocalIdForRecord(recordId: string): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(REF_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const ref = JSON.parse(raw) as RecordRef;
      if (ref.id === recordId) return key.slice(REF_PREFIX.length);
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}
