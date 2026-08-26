import type { PlayerID } from "./social";
import type { SocialEvent } from "./types";

// League-table computation for the stats page. Two scoring views over the same
// results:
//   - "games":   a straight count of games won vs lost (the raw score totals).
//   - "matches": football scoring — 3 points per match won, 1 per draw, 0 per loss.
// Both are derived from the same per-matchup tallies below; only the ranking key
// and the displayed columns differ (see the stats route).

export type StandingsMode = "games" | "matches";

export interface Standing {
  id: PlayerID;
  name: string;
  /** Scored matches the player appeared in. */
  played: number;
  /** Matches won / drawn / lost. */
  wins: number;
  draws: number;
  losses: number;
  /** Games won (sum of the player's side of each score) and games lost. */
  gamesFor: number;
  gamesAgainst: number;
  gamesDiff: number;
  /** Football points: 3·wins + 1·draws. */
  points: number;
}

/** A standing with its 1-based table position (ties share a position). */
export type RankedStanding = Standing & { rank: number };

/**
 * Tally every scored matchup into per-player rows. All roster players are
 * included (a player with no results yet shows zeroes). Unscored matchups (either
 * side < 0) are skipped, so the table fills in as results are entered.
 */
export function computeStandings(event: SocialEvent): Standing[] {
  const rows = new Map<PlayerID, Standing>();
  for (const p of event.players) {
    rows.set(p.id, {
      id: p.id,
      name: p.name?.trim() || `Player ${p.id + 1}`,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      gamesFor: 0,
      gamesAgainst: 0,
      gamesDiff: 0,
      points: 0,
    });
  }

  for (const round of event.rounds ?? []) {
    for (const m of round.matchups) {
      const [a, b] = m.score;
      if (a < 0 || b < 0) continue; // not yet scored

      const tally = (
        team: readonly PlayerID[],
        gf: number,
        ga: number,
        result: "win" | "draw" | "loss",
      ) => {
        for (const pid of team) {
          const r = rows.get(pid);
          if (!r) continue; // team references a player no longer on the roster
          r.played += 1;
          r.gamesFor += gf;
          r.gamesAgainst += ga;
          if (result === "win") r.wins += 1;
          else if (result === "draw") r.draws += 1;
          else r.losses += 1;
        }
      };

      if (a > b) {
        tally(m.A, a, b, "win");
        tally(m.B, b, a, "loss");
      } else if (b > a) {
        tally(m.A, a, b, "loss");
        tally(m.B, b, a, "win");
      } else {
        tally(m.A, a, b, "draw");
        tally(m.B, b, a, "draw");
      }
    }
  }

  for (const r of rows.values()) {
    r.gamesDiff = r.gamesFor - r.gamesAgainst;
    r.points = r.wins * 3 + r.draws;
  }
  return [...rows.values()];
}

/** The value that ranks the table in the given mode. */
const rankKey = (r: Standing, mode: StandingsMode): number =>
  mode === "games" ? r.gamesFor : r.points;

/**
 * Sort standings for a mode and assign competition ranks (equal leading values
 * share a rank, e.g. 1, 1, 3). Within a tie, rows are ordered by game difference
 * then games won then name — a stable, sensible display order — but still share
 * the rank number.
 */
export function rankStandings(
  rows: Standing[],
  mode: StandingsMode,
): RankedStanding[] {
  const sorted = [...rows].sort(
    (x, y) =>
      rankKey(y, mode) - rankKey(x, mode) ||
      y.gamesDiff - x.gamesDiff ||
      y.gamesFor - x.gamesFor ||
      x.name.localeCompare(y.name),
  );

  let rank = 0;
  let prevKey: number | null = null;
  return sorted.map((r, i) => {
    const key = rankKey(r, mode);
    if (prevKey === null || key !== prevKey) {
      rank = i + 1;
      prevKey = key;
    }
    return { ...r, rank };
  });
}
