import type { Options, PlayerID, Round } from "./social";

// Domain model for the app (main-thread side). The optimizer and its worker
// traffic in bare `PlayerID`s (see social.ts); the rich objects below live here
// on the main thread and resolve to those ids at the worker boundary.

/**
 * A participant in a social. `id` is the stable identity token handed to the
 * optimizer/worker; everything else stays main-thread only. Extend freely with
 * more per-player data (skill, avatar, a persistence uuid, …).
 */
export interface Player {
  id: PlayerID;
  name: string;
  /**
   * Temporarily sit this player out. When set, they're added to the optimizer's
   * `force_sitting` on the next generated round (no court assigned) until cleared.
   * Absent/false means active. See EventEditor (checkbox) and round-worker.
   */
  disabled?: boolean;
}

/** A court that matches are played on. */
export interface Court {
  /** Optional display name (e.g. "Center Court"); falls back to a number in UI. */
  name?: string;
}

/** Descriptive metadata for a social event. */
export interface SocialEventMetadata {
  name: string;
  description: string;
  location: string;
  /**
   * ISO 8601 date/time string. Kept as a string (not a `Date`) so it survives
   * JSON round-trips through the backend `records.data` blob.
   */
  date: string;
  /**
   * Free-form time of day, opaque on purpose so an organiser can express a range
   * (e.g. "11:00 – 1:00") rather than a single instant. Optional; older records
   * predate it.
   */
  time?: string;
}

/**
 * The top-level data for one social: its participants, its courts, and its
 * descriptive metadata. This is the shape we persist as the JSON `data` blob on
 * a backend `records` row and pass around the UI. The optimizer receives
 * `players.map((p) => p.id)` and `courts.length`.
 */
export interface SocialEvent {
  players: Player[];
  courts: Court[];
  metadata: SocialEventMetadata;
  /** The generated schedule. Absent until rounds have been generated. */
  rounds?: Round[];
  /** Optimizer configuration; absent means defaults. */
  options?: Partial<Options>;
  /**
   * When true, unauthenticated players (anyone with the /view/:id link) may enter
   * provisional match scores, shown live to everyone until the owner confirms
   * them by saving. Absent/false means owner-only scoring (the default). Kept
   * top-level (not in `options`) so it never crosses the optimizer worker boundary.
   */
  allowPlayerScores?: boolean;
}
