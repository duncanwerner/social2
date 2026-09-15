
declare const __brand: unique symbol;

type Branded<T, B> = T & { [__brand]: B }

/** branded type for players */
export type PlayerID = Branded<number, "PlayerID">

/** represents a team (two players) */
export type Team = [PlayerID, PlayerID];

/** represents a match; two teams */
export interface Matchup {

  /**
   * Stable identity for this matchup, minted at generation time. Keys the
   * provisional `player_scores` overlay so a regenerated round (new matchups →
   * new ids) automatically orphans stale player submissions.
   */
  id: string;

  A: Team;
  B: Team;

  /** implicitly [A, B] */
  score: [number, number];

  /**
   * Transient, view-only: set on the merged copy when this matchup's score came
   * from an unconfirmed player submission (not the owner). Never persisted.
   */
  provisional?: boolean;
}

/** represents a round; some matchups plus who has to sit */
export interface Round {
  matchups: Matchup[];
  sitting: PlayerID[];
  force_sitting?: PlayerID[];
}

/** a team slot that may still be empty while a round is being edited */
export type PartialTeam = [PlayerID | null, PlayerID | null];

/** a matchup under construction: any of its four slots may be empty */
export interface PartialMatchup {
  A: PartialTeam;
  B: PartialTeam;
}

/**
 * A partially assigned round, used to fill a manually edited round. `matchups`
 * is positional — `matchups[i]` describes court `i`, and an all-empty entry is a
 * court the caller left open. Seeded courts are completed from the pool first;
 * a court the remaining pool cannot complete is dropped, and whoever was
 * assigned to it sits this round. See `NextRound`.
 */
export interface RoundSeed {
  matchups: PartialMatchup[];
}

export type InstrumentedRound = Round & { 
  max_sitting_count: number;
  min_sitting_delta: number;
  max_repeat_teams: number;
  max_repeat_opponents: number;
  min_repeat_team_delta: number;
};

/** utility */
export const CreatePlayerID = (id: number) => id as PlayerID;

export interface Options {

  /** 
   * optionally maximize games between sitting for every player.
   * this will (in some cases) increase the likelihood of repeated
   * teams. even if this is false, we don't allow a player to sit
   * twice if there are any other options.
   */
  maximize_sitting_distance: boolean;

  /**
   * optionally force one or more players to sit. this is to allow
   * players to request a break without breaking the round.
   */
  force_sitting?: PlayerID[];

  /**
   * for players who start late, treat initial absences as sitting.
   * that will maximize games after they show up. maybe you think
   * this is fair? defaults to false, for now...
   * 
   * NOTE: this is unbalanced, because if someone shows up after 
   * 7 rounds they'll have a sit count of 7 and get the next 7
   * games in a row (probably). not that you'd ever get that far
   * in the real world, but still... we'll have to cap this somehow
   * 
   * Hmmm using a fixed cap is also a bit broken... what we really
   * need is to assign the average (maybe ceil average?) when they
   * show up -- HOWEVER this won't be applied properly to "retired"
   * players... leave the fixed cap for now
   * 
   * 
   */
  absences_as_sitting?: boolean;

};

/** placeholder for a better RNG */
const RNG = () => Math.random();

/** knuth shuffle, returns a copy */
const KnuthShuffle = <T>(values: T[]) => {

  const shuffled = values.slice(0);
  const count = shuffled.length;

  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(RNG() * (count - i));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }

  return shuffled;

}

/** the four slots of a (possibly partial) matchup, in A0, A1, B0, B1 order */
const SeedSlots = (matchup: PartialMatchup): (PlayerID | null)[] => [
  matchup.A[0], matchup.A[1], matchup.B[0], matchup.B[1],
];

/** how many of a partial matchup's four slots are already assigned */
const SeedFixedCount = (matchup: PartialMatchup): number =>
  SeedSlots(matchup).filter((player) => player !== null).length;

/** the players already assigned to a partial matchup */
const SeedPlayers = (matchup: PartialMatchup): PlayerID[] =>
  SeedSlots(matchup).filter((player): player is PlayerID => player !== null);

/**
 * generate a random round, purely stochastic.
 *
 * with a `seed`, the courts the caller has already committed to are honoured:
 * their fixed players stay in their slots, their open slots are drawn from the
 * pool in shuffle order, and any other court is filled fresh. courts the seed
 * cannot complete (not enough players left) are dropped, and whoever was
 * assigned to them sits — see RoundSeed.
 */
const RandomRound = (players: PlayerID[], courts: number, seed?: RoundSeed): Round => {

  const shuffled = KnuthShuffle(players);
  let index = 0;
  const take = (): PlayerID => shuffled[index++];

  // The positional court layout: the seed's courts, then a fresh (all-empty)
  // entry for every court the seed didn't describe. Keeping a slot per court is
  // what lets the filler report back against the caller's court numbering.
  const layout: PartialMatchup[] = [];
  for (let i = 0; i < Math.max(0, courts); i++) {
    layout.push(seed?.matchups[i] ?? { A: [null, null], B: [null, null] });
  }

  // Complete the most-committed courts first, so a court the owner has already
  // half-filled can't be starved by an open court listed above it.
  const order = layout
    .map((_, i) => i)
    .sort((a, b) => SeedFixedCount(layout[b]) - SeedFixedCount(layout[a]));

  const round: Round = {
    matchups: [],
    sitting: [],
  };
  const built: (Matchup | null)[] = new Array(layout.length).fill(null);

  for (const i of order) {

    const entry = layout[i];
    const open = 4 - SeedFixedCount(entry);

    if (players.length - index < open) {
      // Not enough players left to complete this court. An open court is simply
      // unused; anyone the caller assigned to it sits this round.
      round.sitting.push(...SeedPlayers(entry));
      continue;
    }

    const A: Team = [entry.A[0] ?? take(), entry.A[1] ?? take()];
    const B: Team = [entry.B[0] ?? take(), entry.B[1] ?? take()];
    built[i] = {id: crypto.randomUUID(), A, B, score: [-1, -1]};
  }

  for (const matchup of built) if (matchup) round.matchups.push(matchup);
  for (; index < shuffled.length; index++) {
    round.sitting.push(shuffled[index]);
  }

  return round;
  
}

/** generate n rounds at once */
const RandomRounds = (count: number, players: PlayerID[], courts: number, seed?: RoundSeed): Round[] => {
  const rounds: Round[] = [];
  for (let i = 0; i < count; i++) {
    rounds.push(RandomRound(players, courts, seed));
  }
  return rounds;
}

/** 
 * generate the next round. this is our optimization function. essentially
 * we generate some number of candidate rounds and select the best one (pareto
 * optimality). what "best" means in this case is the tricky part.
 * 
 * @param players - 
 * @param courts - the number of courts. we need this information to figure
 * out how many players play/sit. assume 4 per court.
 * @param options - 
 * @param seed - optionally, a partially assigned round to work around. the
 * seeded players keep their slot, are taken out of the pool, and the optimizer
 * only decides the open slots and courts. this is how a manually edited round
 * is filled (see RoundSeed).
 */
export const NextRound = (players: PlayerID[], courts: number, previous_rounds: Round[] = [], options: Partial<Options> = {}, seed?: RoundSeed): InstrumentedRound => {

  // force sitting: rmove player(s) from the pool, then 
  // add them back at the end

  const restore_players: PlayerID[] = [];
  if (options?.force_sitting?.length) {
    players = players.filter(player => {
      if (options.force_sitting?.includes(player)) {
        restore_players.push(player);
        return false;
      }
      return true;
    });
  }

  // resolve a manual seed against what's actually available. a seeded player who
  // is sitting this round (the Sit checkbox beats a manual pick) or who isn't in
  // the roster is cleared from their slot, and a player seeded into two courts
  // only keeps the first. the surviving seeded players then leave the pool, so
  // the random filler can't hand them a second game. slots stay positional: an
  // empty court remains in the layout so court numbering survives the fill.

  let resolved_seed: RoundSeed | undefined;
  if (seed) {
    const active = new Set(players);
    const taken = new Set<PlayerID>();
    const keep = (player: PlayerID | null): PlayerID | null => {
      if (player === null || !active.has(player) || taken.has(player)) return null;
      taken.add(player);
      return player;
    };
    resolved_seed = {
      matchups: seed.matchups.map((matchup) => ({
        A: [keep(matchup.A[0]), keep(matchup.A[1])] as PartialTeam,
        B: [keep(matchup.B[0]), keep(matchup.B[1])] as PartialTeam,
      })),
    };
    players = players.filter(player => !taken.has(player));
  }

  // shortcut: if this is the first round, just return something randomly
  // why not return just the list of players in order? kind of fairness,
  // in the event someone has to sit; although I recognize this is arbitrary

  if (!previous_rounds.length) {
    const round = RandomRound(players, courts, resolved_seed);
    round.sitting.push(...restore_players);
    return {
      ...round,
      force_sitting: [...restore_players],
      max_repeat_opponents: 0,
      max_sitting_count: 0,
      max_repeat_teams: 0,
      min_repeat_team_delta: 0,
      min_sitting_delta: 0,
    };
  }

  // count teams, opponents, sitting. teams are hashed (more or less).
  // opppnents are independent of teams.

  const teams: Map<string, number> = new Map();
  const sitting: Map<PlayerID, number> = new Map();
  const opponents: Map<PlayerID, Map<PlayerID, number>> = new Map();

  // for absences, cap on "free sitting"
  const absence_sit_cap = 2;
  const absence_map: Map<PlayerID, number> = new Map();

  /** map of team -> last round played. used to check delta */
  const team_last_round: Map<string, number> = new Map();

  for (const [index, round] of previous_rounds.entries()) {

    const seen: PlayerID[] = [];

    for (const matchup of round.matchups) {
      for (const team of [matchup.A, matchup.B]) {
        const hash = [...team].sort().join(',');
        teams.set(hash, (teams.get(hash) || 0) + 1);
        team_last_round.set(hash, previous_rounds.length - index);

        if (options.absences_as_sitting) {
          seen.push(...team); // we've seen these players
        }
      }

      // opponents. this is symmetrical (if you sort), so we only 
      // need to do one side

      for (const a of matchup.A) {
        for (const b of matchup.B) {
          const [key, value] = [a, b].sort();
          const check: Map<PlayerID, number> = opponents.get(key) || new Map();
          check.set(value, (check.get(value) || 0) + 1);
          opponents.set(key, check);
        }
      }

    }

    const sit_list = [...round.sitting];

    // optionally: add absent players to sitting
    if (options.absences_as_sitting) {
      seen.push(...sit_list);
      for (const player of players) {
        if (!seen.includes(player)) {

          const absence_count = absence_map.get(player) || 0;
          if (absence_count < absence_sit_cap) {
            sit_list.push(player);
            absence_map.set(player, absence_count + 1);
          }
        }
      }
    }

    // sitting
    for (const member of sit_list) {
      sitting.set(member, (sitting.get(member) || 0 ) + 1);
    }

  }

  const sitting_counts = Array.from(sitting.values());
  const base_sitting_count = Math.max(...sitting_counts, 0);

  const sit_check = previous_rounds.map(round => round.sitting).reverse();

  /** instrument rounds for comparison */
  const instrument = (round: Round): InstrumentedRound => {

    let max_sitting_count = base_sitting_count;
    let min_sitting_delta = -1; // min sitting delta
    let max_repeat_teams = 0; // max repeat teams
    let max_repeat_opponents = 0;
    let min_repeat_team_delta = -1;

    for (const member of round.sitting) {
      const check = (sitting.get(member) || 0) + 1;
      max_sitting_count = Math.max(max_sitting_count, check);
      for (const [index, entry] of sit_check.entries()) {
        if (entry.includes(member)) {
          if ( min_sitting_delta === -1 ) { 
            min_sitting_delta = index; 
          }
          else 
          {
            min_sitting_delta = Math.min(min_sitting_delta, index);
          }
          break;
        }
      }
    }

    // UPDATE: adding a penalty for repeat teams from the very last round
    // OR: maybe we should just delta this?

    for (const matchup of round.matchups) {
      for (const team of [matchup.A, matchup.B]) {
        const hash = [...team].sort().join(',');

        if (teams.has(hash)) {
          const check = (teams.get(hash) || 0);
          max_repeat_teams = Math.max(max_repeat_teams, check);
        }

        const check = team_last_round.get(hash);
        if (check) {
          min_repeat_team_delta = (min_repeat_team_delta === -1) ? check : Math.min(min_repeat_team_delta, check);
        }

      }

      for (const a of matchup.A) {
        for (const b of matchup.B) {
          const [key, value] = [a, b].sort();
          const check: Map<PlayerID, number> = opponents.get(key) || new Map();
          max_repeat_opponents = Math.max(max_repeat_opponents, check.get(value) || 0);
        }
      }

    }

    round.sitting.push(...restore_players);

    return { 
      ...round, 
      force_sitting: [...restore_players],
      max_sitting_count,
      min_sitting_delta,
      max_repeat_teams,
      max_repeat_opponents,
      min_repeat_team_delta,
    };
    
  }

  // randomly generate some rounds and instrument them. the number 
  // should be based on the number of players...

  // 10 -> 2500
  // 16 -> 5000

  const n = 2500 + Math.max(0, players.length - 12) * 2000;
  const rounds = RandomRounds(n, players, courts, resolved_seed).map(instrument);

  // pass 1: no one should sit more than anyone else, if at all possible.
  // that means that we want to minimize the max sitting count. we also 
  // don't want anyone sitting twice in a row, unless absolutely necessary.

  // sort by max sitting, then min sitting delta
  rounds.sort((a, b) => {
    return (a.max_sitting_count - b.max_sitting_count) || (b.min_sitting_delta - a.min_sitting_delta) ;
  });

  // filter acceptable. start by taking the set with MSC = min. we can also
  // exclude anything where min sitting delta = 0.

  const target_msc = rounds[0].max_sitting_count;
  const acceptable: InstrumentedRound[] = [];
  for (const round of rounds) {
    if (round.max_sitting_count > target_msc) {
      break;
    }
    acceptable.push(round);
  }

  // "nobody sits twice in a row" is a filter, not a rule: when more than half
  // the pool (or a seeded layout) forces it, every candidate re-seats someone
  // and this set is empty. fall back to the acceptable set so the optimizer
  // always returns a round instead of `undefined` (RG-1); pass 2 still picks
  // the best of what's left.
  const filtered = acceptable.filter(
    round => round.min_sitting_delta === -1 || round.min_sitting_delta > 0,
  );
  const candidates = filtered.length ? filtered : acceptable;

  // pass 2: minimize repeated teams and repeated opponents, in that order.
  // UPDATE: maximize sitting delta first? 

  // UPDATE: maximize the "repeat team delta"? before or after the MRT?

  if (options.maximize_sitting_distance) {
    candidates.sort((a, b) => {
      return (b.min_sitting_delta - a.min_sitting_delta) || 
             (a.max_repeat_teams - b.max_repeat_teams) || 
             (b.min_repeat_team_delta - a.min_repeat_team_delta) ||
             (a.max_repeat_opponents - b.max_repeat_opponents);
    });
  }
  else {
    candidates.sort((a, b) => {
      return (a.max_repeat_teams - b.max_repeat_teams) || 
             (b.min_repeat_team_delta - a.min_repeat_team_delta) ||
             (a.max_repeat_opponents - b.max_repeat_opponents);
    });
  }
    
  return candidates[0];

};
