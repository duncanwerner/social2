/**
 * validate-rounds.ts — distribution validation for the round generator.
 *
 * `NextRound` in `src/social.ts` is a stochastic optimizer: every call samples
 * ~2500+ candidate rounds and returns the best one under a fixed set of
 * criteria (fewest over-sat players, nobody sitting twice in a row, fewest
 * repeated teams, then fewest repeated opponents). The *quality* of any single
 * call is not the interesting question — the *distribution* of results over
 * many calls is. A generator that is technically well-formed but always sits
 * the same player, or always returns the same schedule, is broken in a way that
 * no single-round assertion would catch.
 *
 * This script takes sample data (a player pool, a court count and optionally
 * some already-played rounds) and runs the generator many times, then checks:
 *
 *   structure   every returned round is a legal round: a partition of the pool
 *               into disjoint fours and sitters, at most one game per player,
 *               `force_sitting` honoured, fresh `[-1,-1]` scores, unique
 *               matchup ids, and metrics that match an independent recount.
 *   robustness  the generator never returns nothing (it is typed as returning
 *               a round; a hole here reaches the UI as a crash).
 *   shuffle     with no history the optimizer's fast path is a plain shuffle,
 *               so every player's *partner* distribution must be uniform.
 *   quality     with history, the chosen round must actually be at the
 *               optimum the optimizer claims to pursue: nobody sitting twice
 *               in a row, and max-sitting / repeat-team counts pinned to the
 *               best value any trial achieved.
 *   session     the real usage: generate a whole social round by round,
 *               feeding each round back in as history. Sitting must stay
 *               balanced (spread <= 1), nobody sits back to back, and the
 *               schedule must beat a purely random scheduler on repeats.
 *   diversity   results must actually vary between calls (no degenerate
 *               collapse onto a single answer).
 *   seed        filling a manually edited round (RoundSeed): the seeded players
 *               keep their court, the open slots are completed, a court that
 *               cannot be completed is dropped rather than crashing, and every
 *               active player is accounted for exactly once.
 *
 * Usage:
 *   npm run validate:rounds
 *   node scripts/validate-rounds.ts --trials 500 --seed 7
 *   node scripts/validate-rounds.ts --file ../../lib/sample-event.json
 *   node scripts/validate-rounds.ts --json > report.json
 *
 * Exit code is 0 unless a check FAILs (see --strict and --no-edge).
 */

import { CreatePlayerID, NextRound } from "../src/social.ts";
import type {
  InstrumentedRound,
  Options,
  PartialMatchup,
  PlayerID,
  Round,
  RoundSeed,
} from "../src/social.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Severity = "pass" | "info" | "warn" | "fail";

interface Finding {
  check: string;
  severity: Severity;
  summary: string;
  details: string[];
}

const finding = (
  check: string,
  severity: Severity,
  summary: string,
  details: string[] = [],
): Finding => ({ check, severity, summary, details });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------
//
// `social.ts` hard-codes `Math.random()` (see the "placeholder for a better
// RNG" comment there), so the only way to make a validation run reproducible
// without editing that file is to swap the global out for a seeded generator
// while the suite runs, then put it back. `currentRng` is what this script's
// own reference scheduler uses, so both stay on one deterministic stream.

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

let currentRng: () => number = Math.random;

const installSeed = (seed: number): (() => void) => {
  const original = Math.random;
  currentRng = mulberry32(seed);
  Math.random = currentRng;
  return () => {
    Math.random = original;
    currentRng = original;
  };
};

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

interface Sample {
  label: string;
  players: PlayerID[];
  names: Map<PlayerID, string>;
  courts: number;
  history: Round[];
  options: Partial<Options>;
  /** Trials to run for this sample (auto-scaled by cost when omitted). */
  trials?: number;
  /** Simulated whole-social sessions (auto-scaled when omitted). */
  sessions?: number;
  /** Rounds per simulated session. */
  roundsPerSession?: number;
  /**
   * True for inputs from which *no* legal round exists (e.g. fewer than four
   * players and a non-empty history). The generator cannot do anything but
   * return nothing, so that is reported as a warning rather than a failure.
   */
  degenerate?: boolean;
  /** Skip the session simulation (edge cases, and slow giant pools). */
  noSession?: boolean;
  /** Reason to skip the sit-balance half of the session check. */
  skipSessionFairness?: string;
}

const displayName = (sample: Sample, player: PlayerID): string =>
  sample.names.get(player) ?? `#${player}`;

/** Accepts either the legacy `{players: number[]}` shape or a `SocialEvent`. */
const loadSampleFile = (path: string): Sample => {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error("sample JSON must be an object");

  const rawPlayers = raw["players"];
  const rawCourts = raw["courts"];
  const rawRounds = raw["rounds"];
  const rawOptions = raw["options"];
  const names = new Map<PlayerID, string>();
  let players: PlayerID[] = [];
  let courts = 0;

  if (Array.isArray(rawPlayers) && rawPlayers.every((p) => typeof p === "number")) {
    // Legacy shape: lib/sample-event.json
    players = (rawPlayers as number[]).map(CreatePlayerID);
    const playerNames = raw["player_names"];
    if (Array.isArray(playerNames)) {
      playerNames.forEach((name, index) => {
        const player = players[index];
        if (typeof name === "string" && player !== undefined) names.set(player, name);
      });
    }
    courts = typeof rawCourts === "number" ? rawCourts : 0;
  } else if (Array.isArray(rawPlayers) && rawPlayers.every(isRecord)) {
    // SocialEvent shape (src/types.ts): players are objects, courts is an array.
    const objects = rawPlayers as Record<string, unknown>[];
    players = objects.map((p) => CreatePlayerID(Number(p["id"])));
    objects.forEach((p, index) => {
      const name = p["name"];
      if (typeof name === "string") names.set(players[index], name);
    });
    courts = Array.isArray(rawCourts) ? rawCourts.length : 0;
  } else {
    throw new Error(
      "sample JSON needs `players: number[]` (legacy) or `players: {id,name}[]` (SocialEvent)",
    );
  }

  if (!players.length) throw new Error("sample JSON has no players");
  if (players.some((p) => !Number.isFinite(p))) {
    throw new Error("player ids must be finite numbers (the optimizer traffics in numeric ids)");
  }

  const options: Partial<Options> = isRecord(rawOptions)
    ? { ...(rawOptions as Partial<Options>) }
    : {};

  // Mirror round-worker.ts: a disabled player is folded into force_sitting.
  if (Array.isArray(rawPlayers) && rawPlayers.every(isRecord)) {
    const disabled = (rawPlayers as Record<string, unknown>[])
      .filter((p) => p["disabled"] === true)
      .map((p) => CreatePlayerID(Number(p["id"])));
    if (disabled.length) {
      options.force_sitting = [...new Set([...(options.force_sitting ?? []), ...disabled])];
    }
  }

  const history = Array.isArray(rawRounds)
    ? (rawRounds as unknown[]).filter(
        (r): r is Round =>
          isRecord(r) && Array.isArray(r["matchups"]) && Array.isArray(r["sitting"]),
      )
    : [];

  return {
    label: path.replace(/^.*[\\/]/, ""),
    players,
    names,
    courts,
    history,
    options,
  };
};

const pool = (count: number, offset = 0): PlayerID[] =>
  Array.from({ length: count }, (_, i) => CreatePlayerID(i + offset));

const withNames = (players: PlayerID[], prefix: string): Map<PlayerID, string> =>
  new Map(players.map((p, i) => [p, `${prefix}${i + 1}`]));

/** A session's worth of history, as if the social were already under way. */
const syntheticHistory = (players: PlayerID[], courts: number, rounds: number): Round[] => {
  const history: Round[] = [];
  for (let i = 0; i < rounds; i++) {
    const round = NextRound(players, courts, history);
    if (!round) break;
    history.push(round);
  }
  return history;
};

/**
 * The default suite. Deliberately spans the shapes a real social takes: full
 * courts with nobody sitting, one court with most people sitting, odd numbers
 * of players, disabled players, and each documented option.
 */
const builtInSamples = (): { samples: Sample[]; notes: string[] } => {
  const samples: Sample[] = [];
  const notes: string[] = [];

  // The repo's own sample: 10 players, 3 courts, six rounds already played.
  const samplePath = join(import.meta.dirname, "..", "..", "lib", "sample-event.json");
  try {
    samples.push({ ...loadSampleFile(samplePath), label: "lib/sample-event.json", trials: 200 });
  } catch (error) {
    notes.push(`could not load ${samplePath}: ${String(error)}`);
  }

  const fresh = (
    label: string,
    size: number,
    courts: number,
    extra: Partial<Sample> = {},
  ): Sample => {
    const players = pool(size);
    return {
      label,
      players,
      names: withNames(players, "P"),
      courts,
      history: [],
      options: {},
      ...extra,
    };
  };

  // Fresh socials: the very first call takes the plain-shuffle fast path.
  samples.push(fresh("fresh 10 players / 3 courts", 10, 3, { trials: 400, sessions: 8 }));
  samples.push(fresh("fresh 8 players / 2 courts", 8, 2, { trials: 200, sessions: 8 }));
  // Full courts: nobody sits, so all the pressure is on repeat teams.
  samples.push(fresh("fresh 12 players / 3 courts (nobody sits)", 12, 3, { trials: 150, sessions: 8 }));
  samples.push(
    fresh("fresh 16 players / 4 courts", 16, 4, { trials: 80, sessions: 5, roundsPerSession: 6 }),
  );
  samples.push(
    fresh("fresh 20 players / 5 courts", 20, 5, {
      trials: 40,
      sessions: 4,
      roundsPerSession: 5,
    }),
  );
  // Odd pool: exactly one player sits each round.
  samples.push(fresh("fresh 13 players / 3 courts (1 sits)", 13, 3, { trials: 120, sessions: 8 }));

  // Mid-social, continuing an existing history.
  for (const [size, courts] of [
    [10, 3],
    [12, 3],
  ] as const) {
    const players = pool(size);
    samples.push({
      label: `continuing ${size} players / ${courts} courts (3 rounds played)`,
      players,
      names: withNames(players, "P"),
      courts,
      history: syntheticHistory(players, courts, 3),
      options: {},
      trials: size <= 12 ? 200 : 150,
      sessions: 8,
    });
  }

  // Disabled players — the app's "Sit" checkbox path (round-worker.ts).
  {
    const players = pool(10);
    const disabled = players.slice(8);
    samples.push({
      label: "10 players / 3 courts, 2 forced to sit",
      players,
      names: withNames(players, "P"),
      courts: 3,
      history: syntheticHistory(players, 3, 3),
      options: { force_sitting: disabled },
      trials: 150,
      sessions: 6,
      skipSessionFairness: "forced sitters are meant to sit every round",
    });
  }

  // Documented options.
  {
    const players = pool(10);
    samples.push({
      label: "maximize_sitting_distance (10 players / 3 courts)",
      players,
      names: withNames(players, "P"),
      courts: 3,
      history: syntheticHistory(players, 3, 3),
      options: { maximize_sitting_distance: true },
      trials: 150,
      sessions: 8,
    });
  }
  {
    const players = pool(12);
    samples.push({
      label: "absences_as_sitting (12 players / 3 courts)",
      players,
      names: withNames(players, "P"),
      courts: 3,
      history: syntheticHistory(players, 3, 3),
      options: { absences_as_sitting: true },
      trials: 120,
      sessions: 6,
      skipSessionFairness: "absences count as sitting by design",
    });
  }

  // Edge inputs. Two of these are reachable from the UI today (the "Sit"
  // checkbox has no minimum-players guard, and courts are user-chosen), so a
  // hole here is a real defect rather than a hypothetical.
  samples.push({
    label: "EDGE 10 players / 3 courts with 7 disabled (3 left)",
    players: pool(10),
    names: withNames(pool(10), "P"),
    courts: 3,
    history: syntheticHistory(pool(10), 3, 3),
    options: { force_sitting: pool(7) },
    trials: 25,
    noSession: true,
  });
  samples.push({
    label: "EDGE 10 players / 1 court (6 must sit)",
    players: pool(10),
    names: withNames(pool(10), "P"),
    courts: 1,
    history: syntheticHistory(pool(10), 1, 1),
    options: {},
    trials: 25,
    noSession: true,
  });
  samples.push({
    label: "DEGENERATE 3 players / 1 court",
    players: pool(3),
    names: withNames(pool(3), "P"),
    courts: 1,
    history: syntheticHistory(pool(3), 1, 1),
    options: {},
    trials: 25,
    noSession: true,
    degenerate: true,
  });
  samples.push({
    label: "DEGENERATE 4 players / 0 courts",
    players: pool(4),
    names: withNames(pool(4), "P"),
    courts: 0,
    history: [],
    options: {},
    trials: 10,
    noSession: true,
    degenerate: true,
  });

  return { samples, notes };
};

// ---------------------------------------------------------------------------
// Independent measurement
// ---------------------------------------------------------------------------
//
// A re-implementation of the counting that `instrument()` does inside
// social.ts. Its whole value is that it is written from the spec (fewest
// over-sat players, no back-to-back sits, fewest repeat teams, then repeat
// opponents) rather than copied, so a drift between the metrics the optimizer
// reports and the round it actually returns is caught. The one subtlety it
// must mirror is that social.ts measures a candidate *before* appending the
// forced sitters, so forced players are excluded here too.

interface Metrics {
  max_sitting_count: number;
  min_sitting_delta: number;
  max_repeat_teams: number;
  max_repeat_opponents: number;
  min_repeat_team_delta: number;
}

/** social.ts sorts with the default (lexicographic) comparator; match it. */
const teamHash = (team: readonly PlayerID[]): string => [...team].sort().join(",");
const pairKey = (a: PlayerID, b: PlayerID): [PlayerID, PlayerID] => {
  const pair: [PlayerID, PlayerID] = [a, b];
  pair.sort();
  return pair;
};

const measure = (round: Round, history: Round[]): Metrics => {
  const teams = new Map<string, number>();
  const sitting = new Map<PlayerID, number>();
  const opponents = new Map<PlayerID, Map<PlayerID, number>>();
  const teamLastRound = new Map<string, number>();

  for (const [index, past] of history.entries()) {
    for (const matchup of past.matchups) {
      for (const team of [matchup.A, matchup.B]) {
        const hash = teamHash(team);
        teams.set(hash, (teams.get(hash) ?? 0) + 1);
        teamLastRound.set(hash, history.length - index);
      }
      for (const a of matchup.A) {
        for (const b of matchup.B) {
          const [key, value] = pairKey(a, b);
          const check = opponents.get(key) ?? new Map<PlayerID, number>();
          check.set(value, (check.get(value) ?? 0) + 1);
          opponents.set(key, check);
        }
      }
    }
    for (const member of past.sitting) sitting.set(member, (sitting.get(member) ?? 0) + 1);
  }

  const baseSittingCount = Math.max(...sitting.values(), 0);
  const sitCheck = history.map((r) => r.sitting).reverse();

  let maxSittingCount = baseSittingCount;
  let minSittingDelta = -1;
  let maxRepeatTeams = 0;
  let maxRepeatOpponents = 0;
  let minRepeatTeamDelta = -1;

  const forced = round.force_sitting ?? [];
  for (const member of round.sitting) {
    if (forced.includes(member)) continue;
    maxSittingCount = Math.max(maxSittingCount, (sitting.get(member) ?? 0) + 1);
    for (const [index, entry] of sitCheck.entries()) {
      if (entry.includes(member)) {
        minSittingDelta = minSittingDelta === -1 ? index : Math.min(minSittingDelta, index);
        break;
      }
    }
  }

  for (const matchup of round.matchups) {
    for (const team of [matchup.A, matchup.B]) {
      const hash = teamHash(team);
      if (teams.has(hash)) maxRepeatTeams = Math.max(maxRepeatTeams, teams.get(hash) ?? 0);
      const last = teamLastRound.get(hash);
      if (last) minRepeatTeamDelta = minRepeatTeamDelta === -1 ? last : Math.min(minRepeatTeamDelta, last);
    }
    for (const a of matchup.A) {
      for (const b of matchup.B) {
        const [key, value] = pairKey(a, b);
        maxRepeatOpponents = Math.max(maxRepeatOpponents, opponents.get(key)?.get(value) ?? 0);
      }
    }
  }

  return {
    max_sitting_count: maxSittingCount,
    min_sitting_delta: minSittingDelta,
    max_repeat_teams: maxRepeatTeams,
    max_repeat_opponents: maxRepeatOpponents,
    min_repeat_team_delta: minRepeatTeamDelta,
  };
};

/** What a legal round must look like for this sample. */
interface Expectations {
  forced: PlayerID[];
  available: PlayerID[];
  onCourt: number;
  sitting: number;
}

const expectationsFor = (sample: Sample, players = sample.players): Expectations => {
  const forced = (sample.options.force_sitting ?? []).filter((p) => players.includes(p));
  const available = players.filter((p) => !forced.includes(p));
  const fours = Math.min(Math.floor(available.length / 4), Math.max(0, sample.courts));
  return {
    forced,
    available,
    onCourt: fours * 4,
    // The forced players are put back into `sitting` at the end of generation,
    // so they count towards the sitter list even though they never competed for
    // a court.
    sitting: available.length - fours * 4 + forced.length,
  };
};

const sameSet = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((value) => b.includes(value));

/** Structural validation of one generated round. Returns human-readable issues. */
const checkRoundShape = (round: InstrumentedRound, sample: Sample, history: Round[]): string[] => {
  const issues: string[] = [];
  const expected = expectationsFor(sample);
  const forced = expected.forced;
  const available = expected.available;

  const courtPlayers: PlayerID[] = [];
  const matchups = round.matchups ?? [];
  if (!Array.isArray(matchups)) return ["matchups is not an array"];

  if (matchups.length * 4 > Math.max(0, sample.courts) * 4) {
    issues.push(`more matchups (${matchups.length}) than courts (${sample.courts})`);
  }

  const seenIds = new Set<string>();
  for (const [index, matchup] of matchups.entries()) {
    const four = [...matchup.A, ...matchup.B];
    if (matchup.A.length !== 2 || matchup.B.length !== 2) {
      issues.push(`matchup ${index}: teams must hold exactly two players`);
    }
    if (new Set(four).size !== four.length) {
      issues.push(`matchup ${index}: a player appears twice (${four.join(", ")})`);
    }
    if (matchup.score[0] !== -1 || matchup.score[1] !== -1) {
      issues.push(`matchup ${index}: fresh round should score [-1,-1], got [${matchup.score}]`);
    }
    if (typeof matchup.id !== "string" || !matchup.id) {
      issues.push(`matchup ${index}: missing matchup id`);
    } else if (seenIds.has(matchup.id)) {
      issues.push(`matchup ${index}: duplicate matchup id ${matchup.id}`);
    } else {
      seenIds.add(matchup.id);
    }
    courtPlayers.push(...four);
  }

  if (new Set(courtPlayers).size !== courtPlayers.length) {
    issues.push("a player is on court more than once");
  }
  if (courtPlayers.length !== expected.onCourt) {
    issues.push(
      `expected ${expected.onCourt} players on court, got ${courtPlayers.length}` +
        ` (pool ${sample.players.length}, forced sitting ${forced.length}, courts ${sample.courts})`,
    );
  }
  for (const player of courtPlayers) {
    if (!available.includes(player)) {
      issues.push(`player ${displayName(sample, player)} plays but was forced to sit`);
    }
  }

  const sitting = round.sitting ?? [];
  if (new Set(sitting).size !== sitting.length) issues.push("a player sits more than once");
  if (sitting.length !== expected.sitting) {
    issues.push(`expected ${expected.sitting} sitters, got ${sitting.length}`);
  }
  for (const player of forced) {
    if (!sitting.includes(player)) {
      issues.push(`player ${displayName(sample, player)} was forced to sit but is not listed`);
    }
  }
  for (const player of sitting) {
    if (courtPlayers.includes(player)) {
      issues.push(`player ${displayName(sample, player)} both plays and sits`);
    }
  }
  const accounted = [...courtPlayers, ...sitting];
  const duplicates = accounted.filter((p, i) => accounted.indexOf(p) !== i);
  if (duplicates.length) {
    issues.push(`duplicated players across the round: ${[...new Set(duplicates)].join(", ")}`);
  }
  if (!sameSet(accounted, sample.players)) {
    const missing = sample.players.filter((p) => !accounted.includes(p));
    issues.push(`players not accounted for: ${missing.map((p) => displayName(sample, p)).join(", ")}`);
  }
  if (!sameSet(round.force_sitting ?? [], forced)) {
    issues.push(
      `force_sitting mismatch: expected [${forced.join(", ")}], got [${(round.force_sitting ?? []).join(", ")}]`,
    );
  }

  // The metrics the optimizer reports must match an independent recount. The
  // empty-history shortcut is exempt: it returns a random round with the
  // instrumentation fields hard-coded to zero rather than measured.
  if (history.length) {
    const reported: Metrics = {
      max_sitting_count: round.max_sitting_count,
      min_sitting_delta: round.min_sitting_delta,
      max_repeat_teams: round.max_repeat_teams,
      max_repeat_opponents: round.max_repeat_opponents,
      min_repeat_team_delta: round.min_repeat_team_delta,
    };
    const actual = measure(round, history);
    for (const key of Object.keys(actual) as (keyof Metrics)[]) {
      if (reported[key] !== actual[key]) {
        issues.push(`metric ${key}: optimizer reported ${reported[key]}, recount says ${actual[key]}`);
      }
    }
  }

  return issues;
};

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const mean = (values: number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

const shannonEntropy = (counts: number[]): number => {
  const total = sum(counts);
  if (!total) return 0;
  return -sum(counts.map((c) => (c <= 0 ? 0 : (c / total) * Math.log2(c / total))));
};

const chiSquare = (observed: number[], expected: number[]): number =>
  sum(observed.map((o, i) => (expected[i] > 0 ? (o - expected[i]) ** 2 / expected[i] : 0)));

/**
 * Upper-tail critical value for a chi-square with `df` degrees of freedom,
 * via the Wilson–Hilferty approximation. `z` is the normal quantile: 3.0902
 * for alpha=0.001, 3.7190 for alpha=0.0001.
 */
const chiSquareCritical = (df: number, z: number): number => {
  if (df <= 0) return 0;
  const term = 1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df));
  return df * term ** 3;
};

/** Canonical identity of a round: who partners whom, and who sits. */
const roundSignature = (round: Round): string => {
  const teams = round.matchups
    .flatMap((m) => [teamHash(m.A), teamHash(m.B)])
    .sort()
    .join(" + ");
  return `${teams} / sit ${[...round.sitting].sort((a, b) => a - b).join(",")}`;
};

const repeatCounts = (rounds: readonly Round[]): { teams: number; opponents: number } => {
  const seenTeams = new Set<string>();
  const seenOpponents = new Set<string>();
  let teams = 0;
  let opponents = 0;
  for (const round of rounds) {
    for (const matchup of round.matchups) {
      for (const team of [matchup.A, matchup.B]) {
        const hash = teamHash(team);
        if (seenTeams.has(hash)) teams++;
        seenTeams.add(hash);
      }
      for (const a of matchup.A) {
        for (const b of matchup.B) {
          const [key, value] = pairKey(a, b);
          const hash = `${key}|${value}`;
          if (seenOpponents.has(hash)) opponents++;
          seenOpponents.add(hash);
        }
      }
    }
  }
  return { teams, opponents };
};

/** A deliberately naive scheduler: shuffle the pool, fill courts, rest sit. */
const naiveRound = (sample: Sample): Round => {
  const expected = expectationsFor(sample);
  const shuffled = [...expected.available];
  for (let i = 0; i < shuffled.length; i++) {
    const j = i + Math.floor(currentRng() * (shuffled.length - i));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  const round: Round = { matchups: [], sitting: [] };
  let index = 0;
  for (let i = 0; i < expected.onCourt / 4; i++) {
    round.matchups.push({
      id: `naive-${i}`,
      A: [shuffled[index++], shuffled[index++]],
      B: [shuffled[index++], shuffled[index++]],
      score: [-1, -1],
    });
  }
  round.sitting = [...shuffled.slice(index), ...expected.forced];
  return round;
};

const naiveSession = (sample: Sample, rounds: number): Round[] =>
  Array.from({ length: rounds }, () => naiveRound(sample));

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

interface TrialRun {
  rounds: InstrumentedRound[];
  undefinedCount: number;
  structureIssues: string[][];
}

const runTrials = (sample: Sample, trials: number): TrialRun => {
  const rounds: InstrumentedRound[] = [];
  const structureIssues: string[][] = [];
  let undefinedCount = 0;

  const before = JSON.stringify(sample.history);
  for (let i = 0; i < trials; i++) {
    const round: InstrumentedRound | undefined = NextRound(
      sample.players,
      sample.courts,
      sample.history,
      sample.options,
    );
    if (!round) {
      undefinedCount++;
      continue;
    }
    rounds.push(round);
    structureIssues.push(checkRoundShape(round, sample, sample.history));
  }
  if (JSON.stringify(sample.history) !== before) {
    structureIssues.push(["generation mutated the caller's history array"]);
  }

  return { rounds, undefinedCount, structureIssues };
};

const structureFinding = (sample: Sample, trials: TrialRun, trialsRequested: number): Finding => {
  const answered = trials.rounds.length;
  if (!answered) {
    return finding(
      "structure",
      "info",
      `no rounds produced (${trials.undefinedCount}/${trialsRequested} calls returned nothing)`,
    );
  }
  const bad = trials.structureIssues.filter((issues) => issues.length);
  if (!bad.length) {
    return finding("structure", "pass", `${answered}/${trialsRequested} rounds well-formed`);
  }
  return finding(
    "structure",
    "fail",
    `${bad.length}/${answered} rounds malformed`,
    bad.slice(0, 5).map((issues) => `round: ${issues.join("; ")}`),
  );
};

const robustnessFinding = (sample: Sample, trials: TrialRun, trialsRequested: number): Finding => {
  if (!trials.undefinedCount) {
    return finding("robustness", "pass", `every call returned a round (${trialsRequested} calls)`);
  }
  const severity: Severity = sample.degenerate ? "warn" : "fail";
  const detail =
    `${trials.undefinedCount}/${trialsRequested} calls returned undefined. ` +
    `NextRound is typed as returning InstrumentedRound, and round-worker.ts pushes the result ` +
    `straight into the rounds array, so this surfaces in the UI as a crash.`;
  return finding(
    "robustness",
    severity,
    sample.degenerate
      ? `no legal round exists for this input (${trials.undefinedCount}/${trialsRequested} returned nothing)`
      : `generator returned nothing on a reachable input (${trials.undefinedCount}/${trialsRequested} calls)`,
    [detail],
  );
};

const qualityFinding = (sample: Sample, trials: TrialRun): Finding => {
  if (!sample.history.length) {
    return finding("quality", "info", "no history to optimize against (plain shuffle fast path)");
  }
  if (!trials.rounds.length) {
    return finding("quality", "info", "no rounds produced to assess");
  }
  const details: string[] = [];

  // Nobody should sit twice in a row while any acceptable alternative exists.
  const backToBack = trials.rounds.filter((r) => r.min_sitting_delta === 0).length;
  const expected = expectationsFor(sample);
  const sitters = expected.sitting;

  // ...but sometimes no alternative exists. Let n be the active pool, k the
  // players who must sit this round, and R the active players who sat last
  // round: a k-subset disjoint from R exists only while n - |R| >= k. RG-1's
  // fallback deliberately re-seats someone in that case (it is the only legal
  // round), so the rule is asserted only when it was actually satisfiable.
  const active = expected.available;
  const activeSitters = expected.sitting - expected.forced.length;
  const lastSitters = sample.history.length
    ? (sample.history[sample.history.length - 1].sitting ?? []).filter((p) =>
        active.includes(p),
      )
    : [];
  const backToBackAvoidable = active.length - lastSitters.length >= activeSitters;

  // The optimizer claims to minimize max sitting count and repeat teams: those
  // should be pinned to the best value seen across trials, not scattered.
  const mscBest = Math.min(...trials.rounds.map((r) => r.max_sitting_count));
  const mscAtBest = trials.rounds.filter((r) => r.max_sitting_count === mscBest).length;
  const mrtBest = Math.min(...trials.rounds.map((r) => r.max_repeat_teams));
  const mrtAtBest = trials.rounds.filter((r) => r.max_repeat_teams === mrtBest).length;

  details.push(
    `max_sitting_count ${mscBest} in ${mscAtBest}/${trials.rounds.length} trials ` +
      `(spread ${Math.max(...trials.rounds.map((r) => r.max_sitting_count)) - mscBest})`,
  );
  details.push(
    `max_repeat_teams ${mrtBest} in ${mrtAtBest}/${trials.rounds.length} trials ` +
      `(spread ${Math.max(...trials.rounds.map((r) => r.max_repeat_teams)) - mrtBest})`,
  );
  if (sitters > 0) details.push(`sitting twice in a row: ${backToBack}/${trials.rounds.length} rounds`);
  if (!backToBackAvoidable) {
    details.push(
      `no round can avoid re-seating a sitter (pool ${active.length}, ` +
        `${activeSitters} must sit, ${lastSitters.length} sat last round): not asserted`,
    );
  }

  const problems: string[] = [];
  if (backToBackAvoidable && sitters > 0 && backToBack > 0) {
    problems.push(`${backToBack}/${trials.rounds.length} rounds sit someone who sat the round before`);
  }
  if (mscAtBest / trials.rounds.length < 0.95) {
    problems.push(`max_sitting_count not at the optimum in ${trials.rounds.length - mscAtBest} trials`);
  }
  if (mrtAtBest / trials.rounds.length < 0.95) {
    problems.push(`max_repeat_teams not at the optimum in ${trials.rounds.length - mrtAtBest} trials`);
  }

  return problems.length
    ? finding("quality", "fail", problems.join("; "), details)
    : finding("quality", "pass", `chosen rounds sit at the optimum the optimizer targets`, details);
};

/**
 * With no history every player is interchangeable, so the first-round fast path
 * must spread partners uniformly: for a given player, the partner they draw is
 * uniform over the rest of the pool. That is a clean multinomial per player,
 * and it is the check that would catch a biased shuffle or a stuck RNG.
 */
const shuffleFinding = (sample: Sample, trials: TrialRun, trialsRequested: number): Finding => {
  if (sample.history.length) {
    return finding("shuffle", "info", "skipped: history makes the target distribution non-uniform");
  }
  if (sample.options.force_sitting?.length) {
    return finding("shuffle", "info", "skipped: forced sitters remove players from the pool");
  }
  const partners = new Map<PlayerID, Map<PlayerID, number>>();
  const played = new Map<PlayerID, number>();
  for (const round of trials.rounds) {
    for (const matchup of round.matchups) {
      for (const team of [matchup.A, matchup.B]) {
        const [first, second] = team;
        for (const [player, partner] of [
          [first, second],
          [second, first],
        ] as const) {
          const row = partners.get(player) ?? new Map<PlayerID, number>();
          row.set(partner, (row.get(partner) ?? 0) + 1);
          partners.set(player, row);
          played.set(player, (played.get(player) ?? 0) + 1);
        }
      }
    }
  }
  if (!partners.size) {
    return finding("shuffle", "info", "nobody played; no partner distribution to test");
  }

  // Bonferroni: alpha 0.001 spread across the players tested.
  const z = 3.719;
  const tested = [...partners.keys()];
  const threshold = chiSquareCritical(tested.length - 2, z);
  let worst = { player: tested[0], chi: 0, df: 0 };
  const details: string[] = [];
  for (const player of tested) {
    const others = sample.players.filter((p) => p !== player);
    const draws = played.get(player) ?? 0;
    const observed = others.map((p) => partners.get(player)?.get(p) ?? 0);
    const expected = others.map(() => draws / others.length);
    const chi = chiSquare(observed, expected);
    details.push(
      `${displayName(sample, player)}: chi2=${chi.toFixed(1)} (df ${others.length - 1}, critical ${threshold.toFixed(1)}), ` +
        `${draws} games across ${others.length} possible partners`,
    );
    if (chi > worst.chi) worst = { player, chi, df: others.length - 1 };
  }

  if (worst.chi > threshold) {
    return finding(
      "shuffle",
      "fail",
      `partner draw is not uniform for ${displayName(sample, worst.player)} ` +
        `(chi2=${worst.chi.toFixed(1)} > ${threshold.toFixed(1)}, df ${worst.df}, ${trialsRequested} trials)`,
      details.slice(0, 6),
    );
  }
  return finding(
    "shuffle",
    "pass",
    `partner draw uniform for all ${tested.length} players ` +
      `(worst chi2=${worst.chi.toFixed(1)} vs critical ${threshold.toFixed(1)}, df ${worst.df})`,
  );
};

const diversityFinding = (trials: TrialRun, trialsRequested: number): Finding => {
  if (!trials.rounds.length) return finding("diversity", "info", "no rounds produced");
  const matchups = trials.rounds.reduce((total, round) => total + round.matchups.length, 0);
  if (!matchups) {
    return finding(
      "diversity",
      "info",
      "no courts could be filled (every player sits), so there is nothing to vary",
    );
  }
  const counts = new Map<string, number>();
  for (const round of trials.rounds) {
    const signature = roundSignature(round);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const distinct = counts.size;
  const ratio = distinct / trials.rounds.length;
  const entropy = shannonEntropy([...counts.values()]);
  const commonest = Math.max(...counts.values());
  const summary =
    `${distinct}/${trialsRequested} distinct rounds, entropy ${entropy.toFixed(2)} bits, ` +
    `commonest answer ${commonest}x`;

  if (distinct < 2) {
    return finding(
      "diversity",
      "fail",
      `every call returned the same round (${summary})`,
    );
  }
  if (ratio < 0.02) {
    return finding(
      "diversity",
      "warn",
      `results vary but cluster hard (${summary})`,
      ["A low ratio can be legitimate for a tightly constrained pool; check the scenario by hand."],
    );
  }
  return finding("diversity", "pass", summary);
};

// ---------------------------------------------------------------------------
// Seeded fill — the manual "edit round" path (RoundSeed)
// ---------------------------------------------------------------------------
//
// The editor hands `NextRound` a layout with some slots already filled and lets
// it complete the rest. These scenarios pin down that contract: manual picks are
// never moved or duplicated, a court that cannot be completed is dropped (its
// players sit) rather than producing a partial or missing round, and the result
// is still a legal partition of the pool.

interface SeedScenario {
  label: string;
  players: PlayerID[];
  courts: number;
  history: Round[];
  options: Partial<Options>;
  seed: RoundSeed;
  /** court indices whose seeded lineup must survive untouched */
  pinned: number[];
  /** court indices that cannot be completed: their players must sit instead */
  dropped: number[];
  /** expected matchup count in the filled round */
  matchups: number;
}

/** One court's four slots, A0 A1 B0 B1. */
type CourtPlan = [PlayerID | null, PlayerID | null, PlayerID | null, PlayerID | null] | null;

/** Build a positional seed; courts left out are open. */
const SeedFrom = (courts: number, plans: CourtPlan[]): RoundSeed => ({
  matchups: Array.from({ length: courts }, (_, i) => {
    const slots = plans[i];
    if (!slots) return { A: [null, null], B: [null, null] };
    return { A: [slots[0], slots[1]], B: [slots[2], slots[3]] };
  }),
});

const seedScenarios = (): SeedScenario[] => {
  const scenarios: SeedScenario[] = [];

  {
    const players = pool(12);
    scenarios.push({
      label: "a complete court is kept together",
      players,
      courts: 3,
      history: syntheticHistory(players, 3, 3),
      options: {},
      seed: SeedFrom(3, [[players[0], players[1], players[2], players[3]]]),
      pinned: [0],
      dropped: [],
      matchups: 3,
    });
  }

  {
    const players = pool(12);
    scenarios.push({
      label: "two half-filled courts are completed in place",
      players,
      courts: 3,
      history: syntheticHistory(players, 3, 3),
      options: {},
      seed: SeedFrom(3, [
        [players[0], players[1], null, null],
        null,
        [players[4], null, null, null],
      ]),
      pinned: [0, 2],
      dropped: [],
      matchups: 3,
    });
  }

  {
    // Three players are left and three of them are pinned to a court that needs
    // a fourth: nobody can fill it, so the court is dropped and they all sit.
    const players = pool(10);
    scenarios.push({
      label: "a court with no one left to complete it is dropped",
      players,
      courts: 3,
      history: syntheticHistory(players, 3, 3),
      options: { force_sitting: players.slice(3) },
      seed: SeedFrom(3, [[players[0], players[1], players[2], null]]),
      pinned: [],
      dropped: [0],
      matchups: 0,
    });
  }

  {
    // The RG-1 input (10 players / 1 court, 6 must sit) combined with a seeded
    // court: no candidate can avoid re-seating a sitter, and the fill must still
    // answer with a legal round.
    const players = pool(10);
    scenarios.push({
      label: "RG-1 pressure (more than half must sit) with a seeded court",
      players,
      courts: 1,
      history: syntheticHistory(players, 1, 1),
      options: {},
      seed: SeedFrom(1, [[players[0], players[1], null, null]]),
      pinned: [0],
      dropped: [],
      matchups: 1,
    });
  }

  {
    // A caller bug (the same player in several slots) must not corrupt the round.
    const players = pool(8);
    scenarios.push({
      label: "repeated seed slots are deduped",
      players,
      courts: 2,
      history: [],
      options: {},
      seed: SeedFrom(2, [
        [players[0], players[0], null, null],
        [players[0], players[1], null, null],
      ]),
      pinned: [],
      dropped: [],
      matchups: 2,
    });
  }

  return scenarios;
};

/** The players a partial matchup already commits to a court. */
const SeedPlayers = (matchup: PartialMatchup): PlayerID[] =>
  [matchup.A[0], matchup.A[1], matchup.B[0], matchup.B[1]].filter(
    (player): player is PlayerID => player !== null,
  );

/** Invariants one filled round must satisfy for a scenario. */
const checkSeededRound = (round: InstrumentedRound, scenario: SeedScenario): string[] => {
  const issues: string[] = [];
  const matchups = round.matchups ?? [];

  if (matchups.length !== scenario.matchups) {
    issues.push(`expected ${scenario.matchups} matchups, got ${matchups.length}`);
  }
  if (matchups.length > scenario.courts) {
    issues.push(`more matchups (${matchups.length}) than courts (${scenario.courts})`);
  }

  const seenIds = new Set<string>();
  const onCourt: PlayerID[] = [];
  matchups.forEach((m, index) => {
    const four = [...m.A, ...m.B];
    if (new Set(four).size !== 4) {
      issues.push(`matchup ${index}: players are not four distinct ids (${four.join(", ")})`);
    }
    if (m.score[0] !== -1 || m.score[1] !== -1) {
      issues.push(`matchup ${index}: score should be fresh [-1,-1]`);
    }
    if (!m.id || seenIds.has(m.id)) {
      issues.push(`matchup ${index}: missing or duplicate matchup id`);
    }
    seenIds.add(m.id);
    onCourt.push(...four);
  });
  if (new Set(onCourt).size !== onCourt.length) issues.push("a player is on court twice");

  const sitting = round.sitting ?? [];
  if (new Set(sitting).size !== sitting.length) issues.push("a player sits twice");
  const both = sitting.filter((p) => onCourt.includes(p));
  if (both.length) issues.push(`both playing and sitting: ${both.join(", ")}`);

  const accounted = [...onCourt, ...sitting];
  const missing = scenario.players.filter((p) => !accounted.includes(p));
  const extra = accounted.filter((p) => !scenario.players.includes(p));
  if (missing.length) issues.push(`players unaccounted for: ${missing.join(", ")}`);
  if (extra.length) issues.push(`players not in the pool: ${extra.join(", ")}`);
  if (accounted.length !== scenario.players.length) {
    issues.push(`accounted ${accounted.length} of ${scenario.players.length} players`);
  }

  for (const player of scenario.options.force_sitting ?? []) {
    if (onCourt.includes(player)) issues.push(`forced sitter ${player} is on court`);
    if (!sitting.includes(player)) issues.push(`forced sitter ${player} is not listed as sitting`);
  }

  for (const court of scenario.pinned) {
    const seeded = scenario.seed.matchups[court];
    const matchup = matchups[court];
    if (!matchup) {
      issues.push(`pinned court ${court} is missing`);
      continue;
    }
    // Only the slots the caller actually fixed must survive; the open ones are
    // exactly what the fill is for.
    const want = [...seeded.A, ...seeded.B];
    const got = [...matchup.A, ...matchup.B];
    const moved = want
      .map((player, slot) => (player !== null && player !== got[slot] ? slot : -1))
      .filter((slot) => slot !== -1);
    if (moved.length) {
      issues.push(
        `pinned court ${court}: seeded players moved (wanted ${want.join(",")} got ${got.join(",")})`,
      );
    }
  }

  for (const court of scenario.dropped) {
    const fixed = SeedPlayers(scenario.seed.matchups[court]);
    const playing = fixed.filter((p) => onCourt.includes(p));
    const notSitting = fixed.filter((p) => !sitting.includes(p));
    if (playing.length) issues.push(`dropped court ${court}: ${playing.join(", ")} still plays`);
    if (notSitting.length) {
      issues.push(`dropped court ${court}: ${notSitting.join(", ")} is not sitting`);
    }
  }

  return issues;
};

const seedFinding = (scenarios: SeedScenario[], trials: number): Finding => {
  const details: string[] = [];
  let checked = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    const before = JSON.stringify(scenario.seed);
    const distinct = new Set<string>();
    const issues: string[] = [];
    let undefinedCount = 0;

    for (let i = 0; i < trials; i++) {
      const round: InstrumentedRound | undefined = NextRound(
        scenario.players,
        scenario.courts,
        scenario.history,
        scenario.options,
        scenario.seed,
      );
      if (!round) {
        undefinedCount++;
        continue;
      }
      checked++;
      distinct.add(roundSignature(round));
      for (const issue of checkSeededRound(round, scenario)) {
        if (issues.length < 6) issues.push(issue);
      }
    }

    if (JSON.stringify(scenario.seed) !== before) {
      issues.push("generation mutated the caller's seed");
    }
    if (undefinedCount) {
      issues.unshift(`${undefinedCount}/${trials} fills returned undefined`);
    }

    if (issues.length) {
      failed++;
      details.push(`FAIL ${scenario.label}: ${issues.slice(0, 4).join("; ")}`);
    } else {
      details.push(`ok   ${scenario.label}: ${trials} fills, ${distinct.size} distinct`);
    }
  }

  if (!checked) return finding("seed", "info", "no seeded fills were exercised");
  return failed
    ? finding(
        "seed",
        "fail",
        `${failed}/${scenarios.length} seeded-fill scenarios misbehaved`,
        details,
      )
    : finding(
        "seed",
        "pass",
        `${scenarios.length} seeded-fill scenarios well-formed (${checked} fills)`,
        details,
      );
};

interface SessionTrial {
  undefinedAt: number;
  spread: number;
  cumulativeSpread: number;
  backToBack: number;
  repeats: { teams: number; opponents: number };
}

const runSession = (sample: Sample, rounds: number): SessionTrial => {
  const generated: InstrumentedRound[] = [];
  let undefinedAt = -1;
  for (let i = 0; i < rounds; i++) {
    const round: InstrumentedRound | undefined = NextRound(
      sample.players,
      sample.courts,
      generated,
      sample.options,
    );
    if (!round) {
      undefinedAt = i;
      break;
    }
    generated.push(round);
  }

  const expected = expectationsFor(sample);
  const historyCounts = new Map<PlayerID, number>();
  for (const past of sample.history) {
    for (const player of past.sitting) {
      historyCounts.set(player, (historyCounts.get(player) ?? 0) + 1);
    }
  }
  const counts = new Map<PlayerID, number>(sample.players.map((p) => [p, 0]));
  for (const round of generated) {
    for (const player of round.sitting) counts.set(player, (counts.get(player) ?? 0) + 1);
  }
  const balanced = sample.players.filter((p) => !expected.forced.includes(p));
  const spreadOf = (values: number[]): number =>
    values.length ? Math.max(...values) - Math.min(...values) : 0;
  // Fairness is asserted on the generated rounds alone (a whole social, from a
  // clean slate); the cumulative figure shows what the optimizer manages when
  // it inherits the sample's already-lopsided history.
  const spread = spreadOf(balanced.map((p) => counts.get(p) ?? 0));
  const cumulativeSpread = spreadOf(
    balanced.map((p) => (historyCounts.get(p) ?? 0) + (counts.get(p) ?? 0)),
  );

  let backToBack = 0;
  for (let i = 1; i < generated.length; i++) {
    const previous = generated[i - 1].sitting.filter((p) => !expected.forced.includes(p));
    const current = generated[i].sitting.filter((p) => !expected.forced.includes(p));
    if (current.some((p) => previous.includes(p))) backToBack++;
  }

  return {
    undefinedAt,
    spread,
    cumulativeSpread,
    backToBack,
    repeats: repeatCounts(generated),
  };
};

const sessionFinding = (sample: Sample, sessionCount: number, rounds: number, baselineSamples: number): Finding => {
  if (sample.noSession || sessionCount <= 0) {
    return finding("session", "info", "skipped");
  }
  const trials: SessionTrial[] = [];
  for (let i = 0; i < sessionCount; i++) trials.push(runSession(sample, rounds));

  const holes = trials.filter((t) => t.undefinedAt >= 0);
  const completed = trials.filter((t) => t.undefinedAt < 0);
  const details: string[] = [];

  if (holes.length) {
    details.push(
      `${holes.length}/${sessionCount} sessions stopped early at round ${holes
        .map((t) => t.undefinedAt + 1)
        .join(", ")}`,
    );
  }
  if (!completed.length) {
    return finding("session", sample.degenerate ? "warn" : "fail", "no session completed", details);
  }

  const spreads = completed.map((t) => t.spread);
  const worstSpread = Math.max(...spreads);
  const backToBacks = completed.map((t) => t.backToBack);
  const worstBackToBack = Math.max(...backToBacks);
  const optimizerRepeats = mean(completed.map((t) => t.repeats.teams));

  // Baseline: the same session length with a purely random scheduler.
  const naiveRuns = Array.from({ length: baselineSamples }, () => repeatCounts(naiveSession(sample, rounds)));
  const naiveRepeats = mean(naiveRuns.map((r) => r.teams));

  details.push(
    `sitting spread over the generated rounds: <=1 in ` +
      `${spreads.filter((s) => s <= 1).length}/${completed.length} sessions (worst ${worstSpread})`,
  );
  if (sample.history.length) {
    details.push(
      `cumulative spread including the sample's ${plural(sample.history.length, "round")} of history: ` +
        `worst ${Math.max(...completed.map((t) => t.cumulativeSpread))}`,
    );
  }
  details.push(
    `back-to-back sits: ${backToBacks.reduce((a, b) => a + b, 0)} across ` +
      `${completed.length * rounds} rounds (worst session ${worstBackToBack})`,
  );
  details.push(
    `repeated-team slots: optimizer ${optimizerRepeats.toFixed(2)} vs random scheduler ` +
      `${naiveRepeats.toFixed(2)} per session`,
  );

  const problems: string[] = [];
  const fairnessSkipped = sample.skipSessionFairness;
  if (!fairnessSkipped && worstSpread > 1) {
    problems.push(`sitting is unbalanced (spread ${worstSpread} > 1)`);
  }
  if (worstBackToBack > 0) {
    problems.push(`${backToBacks.reduce((a, b) => a + b, 0)} back-to-back sits across sessions`);
  }
  if (naiveRepeats === 0) {
    details.push("random scheduler produced no repeats either; the comparison is vacuous");
  } else if (!(optimizerRepeats < naiveRepeats)) {
    problems.push(
      `optimizer repeats (${optimizerRepeats.toFixed(2)}) not better than random (${naiveRepeats.toFixed(2)})`,
    );
  }
  if (holes.length) {
    problems.push(`${holes.length}/${sessionCount} sessions hit an undefined round`);
  }
  if (fairnessSkipped) details.push(`sit balance not asserted: ${fairnessSkipped}`);

  const severity: Severity = problems.length ? (sample.degenerate ? "warn" : "fail") : "pass";
  return finding(
    "session",
    severity,
    problems.length
      ? problems.join("; ")
      : `${completed.length} sessions x ${rounds} rounds: balanced, no back-to-back sits, beats random on repeats`,
    details,
  );
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface ScenarioReport {
  label: string;
  players: number;
  courts: number;
  history: number;
  trials: number;
  findings: Finding[];
  /** overrides the "[Np · N courts · N rounds]" bracket when set */
  note?: string;
}

const SYMBOL: Record<Severity, string> = { pass: "PASS", info: "----", warn: "WARN", fail: "FAIL" };

/** No ANSI escapes when the report is piped to a file or CI log. */
const COLOR = Boolean(process.stdout.isTTY);

const printFinding = (f: Finding, verbose: boolean): void => {
  const line = `    ${SYMBOL[f.severity]}  ${f.check.padEnd(11)} ${f.summary}`;
  const color = f.severity === "fail" ? "\u001b[31m" : f.severity === "warn" ? "\u001b[33m" : "";
  console.log(COLOR && color ? `${color}${line}\u001b[0m` : line);
  if (verbose || f.severity === "warn" || f.severity === "fail") {
    for (const detail of f.details) console.log(`            ${detail}`);
  }
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Config {
  file?: string;
  trials?: number;
  sessions?: number;
  rounds: number;
  seed: number;
  baselineSamples: number;
  quick: boolean;
  full: boolean;
  json: boolean;
  strict: boolean;
  edge: boolean;
  verbose: boolean;
  help: boolean;
}

const parseArgs = (argv: string[]): Config => {
  const config: Config = {
    rounds: 8,
    seed: 1,
    baselineSamples: 25,
    quick: false,
    full: false,
    json: false,
    strict: false,
    edge: true,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--file": config.file = next(); break;
      case "--trials": config.trials = Number(next()); break;
      case "--sessions": config.sessions = Number(next()); break;
      case "--rounds": config.rounds = Number(next()); break;
      case "--seed": config.seed = Number(next()); break;
      case "--baseline-samples": config.baselineSamples = Number(next()); break;
      case "--quick": config.quick = true; break;
      case "--full": config.full = true; break;
      case "--json": config.json = true; break;
      case "--strict": config.strict = true; break;
      case "--no-edge": config.edge = false; break;
      case "--verbose": case "-v": config.verbose = true; break;
      case "--help": case "-h": config.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  return config;
};

const HELP = `validate-rounds.ts — distribution validation for NextRound (src/social.ts)

  --file <path>            validate a sample JSON (legacy or SocialEvent shape)
  --trials <n>             calls per sample          (default: scaled by pool size)
  --sessions <n>           simulated whole socials  (default: scaled)
  --rounds <n>             rounds per simulated social (default 8)
  --seed <n>               RNG seed (default 1; social.ts is seeded via Math.random)
  --baseline-samples <n>   random-scheduler samples per session (default 25)
  --quick | --full         shrink / grow the trial counts
  --strict                 treat warnings as failures
  --no-edge                skip the edge/degenerate samples
  --verbose                print detail lines for passing checks too
  --json                   machine-readable report
  --help

Samples come from lib/sample-event.json plus a built-in suite covering full
courts, odd pools, disabled players and each documented option.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = (): number => {
  let config: Config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error("run with --help for usage");
    return 2;
  }
  if (config.help) {
    console.log(HELP);
    return 0;
  }

  const restore = installSeed(config.seed);
  const reports: ScenarioReport[] = [];
  const notes: string[] = [];

  try {
    let samples: Sample[];
    if (config.file) {
      try {
        samples = [loadSampleFile(config.file)];
      } catch (error) {
        console.error(`could not read sample ${config.file}: ${String(error)}`);
        return 2;
      }
    } else {
      const built = builtInSamples();
      samples = built.samples;
      notes.push(...built.notes);
    }
    if (!config.edge) {
      samples = samples.filter((s) => !s.label.startsWith("EDGE") && !s.label.startsWith("DEGENERATE"));
    }

    const scale = config.quick ? 0.25 : config.full ? 2.5 : 1;
    const scaled = (value: number | undefined, fallback: number): number =>
      Math.max(5, Math.round((value ?? fallback) * (value === undefined ? 1 : scale)));

    if (!config.json) {
      console.log(`Round-generation distribution validation`);
      console.log(
        `seed ${config.seed} · sessions ${config.sessions ?? "auto"} x ${config.rounds} rounds · ` +
          `baseline ${config.baselineSamples} random sessions`,
      );
      console.log("");
    }

    for (const sample of samples) {
      const trialsRequested = scaled(config.trials ?? sample.trials, 200);
      const sessionCount =
        config.sessions === 0 ? 0 : scaled(config.sessions ?? sample.sessions, config.quick ? 4 : 8);
      const rounds = sample.roundsPerSession ?? config.rounds;

      const trials = runTrials(sample, trialsRequested);
      const findings: Finding[] = [
        structureFinding(sample, trials, trialsRequested),
        robustnessFinding(sample, trials, trialsRequested),
        qualityFinding(sample, trials),
        shuffleFinding(sample, trials, trialsRequested),
        sessionFinding(sample, sessionCount, rounds, config.baselineSamples),
        diversityFinding(trials, trialsRequested),
      ];

      reports.push({
        label: sample.label,
        players: sample.players.length,
        courts: sample.courts,
        history: sample.history.length,
        trials: trialsRequested,
        findings,
      });

      if (!config.json) {
        console.log(
          `  ${sample.label}  [${sample.players.length}p · ${plural(sample.courts, "court")} · ` +
            `${plural(sample.history.length, "round")} of history · ${trialsRequested} trials]`,
        );
        for (const finding of findings) printFinding(finding, config.verbose);
        console.log("");
      }
    }

    // The manual-edit fill path: not a sample in the usual sense (it owns its
    // pools and layouts), so it is reported as its own scenario.
    const seedTrials = config.quick ? 25 : config.full ? 200 : 80;
    const seedScenariosList = seedScenarios();
    const seedReport: ScenarioReport = {
      label: "seeded fill (manual round edit)",
      players: 0,
      courts: 0,
      history: 0,
      trials: seedTrials,
      findings: [seedFinding(seedScenariosList, seedTrials)],
      note: `${plural(seedScenariosList.length, "scenario")} of RoundSeed fills`,
    };
    reports.push(seedReport);
    if (!config.json) {
      console.log(`  ${seedReport.label}  [${seedReport.note} · ${seedTrials} trials]`);
      for (const finding of seedReport.findings) printFinding(finding, config.verbose);
      console.log("");
    }
  } finally {
    restore();
  }

  for (const note of notes) console.log(`note: ${note}`);

  const all = reports.flatMap((r) => r.findings);
  const summary = {
    pass: all.filter((f) => f.severity === "pass").length,
    info: all.filter((f) => f.severity === "info").length,
    warn: all.filter((f) => f.severity === "warn").length,
    fail: all.filter((f) => f.severity === "fail").length,
  };
  // Informational findings are notes, not problems: only warns and fails move
  // the run off "pass".
  const worst: Severity = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass";
  const effectiveWorst: Severity = config.strict && worst === "warn" ? "fail" : worst;

  if (config.json) {
    console.log(
      JSON.stringify(
        {
          seed: config.seed,
          strict: config.strict,
          scenarios: reports,
          summary,
          status: effectiveWorst === "pass" ? "pass" : effectiveWorst,
        },
        null,
        2,
      ),
    );
  } else {
    const problems = all.filter((f) => f.severity === "fail" || f.severity === "warn");
    if (problems.length) {
      console.log("Findings needing attention");
      for (const report of reports) {
        for (const finding of report.findings) {
          if (finding.severity !== "fail" && finding.severity !== "warn") continue;
          console.log(`  [${SYMBOL[finding.severity]}] ${report.label} · ${finding.check}`);
          console.log(`         ${finding.summary}`);
          for (const detail of finding.details) console.log(`         ${detail}`);
        }
      }
      console.log("");
    }
    console.log(
      `${summary.pass} passed, ${summary.warn} warned, ${summary.fail} failed, ${summary.info} informational`,
    );
    console.log(
      effectiveWorst === "pass"
        ? "OK — round generation distributes results as intended."
        : effectiveWorst === "fail"
          ? "FAILED — see the findings above."
          : "WARNINGS — rerun with --strict to fail on them.",
    );
  }

  return effectiveWorst === "fail" ? 1 : 0;
};

process.exitCode = main();
