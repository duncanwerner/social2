import { createContext, useContext, type Accessor } from "solid-js";
import type { SocialEvent } from "./types";
import type { SocketStatus } from "./socket";

// Shared live state for the /view/:id layout and its child pages. The layout
// loads the record (keyed on the id) and, unless finished, subscribes to its
// channel; children read the reactive event + connection state from here.

/** Connection state as shown to viewers. */
export type ViewConnection = SocketStatus | "loading" | "static";

/** A map of matchupId → provisional player-entered score `[a, b]`. */
export type ProvisionalScores = Record<string, [number, number]>;

export interface ViewLive {
  /**
   * The owner-authoritative event (raw `record.data`). Use this for owner saves
   * and for "is this score persisted?" comparisons. For display, prefer
   * `mergedEvent` so provisional player scores are shown.
   */
  event: Accessor<SocialEvent | null>;
  /**
   * `event` with provisional player scores overlaid: for any matchup whose owner
   * score is `[-1,-1]`, the player-entered score is applied and the matchup is
   * flagged `provisional`. Owner scores always win. Read this for display.
   */
  mergedEvent: Accessor<SocialEvent | null>;
  /** The current provisional overlay (matchupId → score). */
  provisional: Accessor<ProvisionalScores>;
  /** The record's status int (see event-status.ts). */
  eventStatus: Accessor<number>;
  connection: Accessor<ViewConnection>;
  recordId: string;
  /** True when the signed-in user owns this record (from get-event). */
  isOwner: Accessor<boolean>;
  /**
   * Owner-only: optimistically apply `next` and persist it via update-event
   * (which broadcasts to all viewers). Throws on failure.
   */
  save: (next: SocialEvent) => Promise<void>;
  /**
   * Submit a provisional score for one matchup (any viewer, when the event's
   * `allowPlayerScores` is on). Persists via /submit-score and broadcasts a
   * `score.proposed` frame. Throws on failure.
   */
  submitScore: (matchupId: string, score: [number, number]) => Promise<void>;
}

/**
 * Overlay provisional player scores onto an event for display. Pure: returns a
 * shallow-cloned event; for every matchup whose owner score is still `[-1,-1]`
 * and that has a provisional entry, applies that score and marks it
 * `provisional`. Owner-entered scores (non-`[-1,-1]`) always win and are left
 * untouched. Matchups without an id, or without a provisional entry, pass through.
 */
export function overlayProvisional(
  event: SocialEvent,
  provisional: ProvisionalScores,
): SocialEvent {
  if (!event.rounds || Object.keys(provisional).length === 0) return event;
  return {
    ...event,
    rounds: event.rounds.map((round) => ({
      ...round,
      matchups: round.matchups.map((m) => {
        const p = m.id ? provisional[m.id] : undefined;
        const ownerScored = m.score[0] >= 0 || m.score[1] >= 0;
        if (!p || ownerScored) return m;
        return { ...m, score: [p[0], p[1]] as [number, number], provisional: true };
      }),
    })),
  };
}

// Default-less: useContext returns ViewLive directly and throws if used outside
// the /view/:id layout's provider.
export const ViewContext = createContext<ViewLive>();

export function useViewLive(): ViewLive {
  return useContext(ViewContext);
}
