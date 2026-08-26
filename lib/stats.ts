
import { type EventData, MatchupWinner, PlayerNames } from './event';
import type { Player } from './social';

export interface PlayerStats {
  match_win: number;
  match_loss: number;
  match_draw: number;
  game_win: number;
  game_loss: number;
  game_pct: number;
  points: number;
  matches_played: number;
  games_played: number;
}

export type ExtendedStats = PlayerStats & { name: string };

export type SortKey = keyof PlayerStats;

// let sort_key: SortKey = $state('game_win');
// let sort_subkeys: SortKey[] = $state(['games_played']);
// let sort_reverse = $state(false);

const empty_stats: PlayerStats = {
  game_win: 0, 
  game_loss: 0, 
  game_pct: 0,
  match_win: 0,
  match_loss: 0,
  match_draw: 0, 
  points: 0, 
  matches_played: 0,
  games_played: 0,
}

export const CalculateStats = (data: EventData) => {

  // const stats: PlayerStats[] = [];
  const map: Map<Player, PlayerStats> = new Map();

  for (const round of data.rounds) {
    for (const matchup of round.matchups) {

      const winner = MatchupWinner(matchup);
      const total_games = matchup.score[0] + matchup.score[1];

      for (const player of [...matchup.A, ...matchup.B]) {

        let stats = map.get(player);
        if (!stats) {
          stats = {...empty_stats};
          map.set(player, stats);
        }

        if (winner >= 0) {
          stats.matches_played++;
          stats.games_played += total_games;
        }
      }

      const a0 = map.get(matchup.A[0]) as PlayerStats;
      const a1 = map.get(matchup.A[1]) as PlayerStats;
      const b0 = map.get(matchup.B[0]) as PlayerStats;
      const b1 = map.get(matchup.B[1]) as PlayerStats;

      if (winner >= 0) {

        a0.game_win += matchup.score[0];
        a1.game_win += matchup.score[0];
        a0.game_loss += matchup.score[1];
        a1.game_loss += matchup.score[1];

        b0.game_win += matchup.score[1];
        b1.game_win += matchup.score[1];
        b0.game_loss += matchup.score[0];
        b1.game_loss += matchup.score[0];

      }

      switch (winner) {
        case 0:
          a0.match_win++;
          a1.match_win++;
          b0.match_loss++;
          b1.match_loss++;
          break;

        case 1:
          a0.match_loss++;
          a1.match_loss++;
          b0.match_win++;
          b1.match_win++;
          break;

        case 2:
          a0.match_draw++;
          a1.match_draw++;
          b0.match_draw++;
          b1.match_draw++;
          break;
      }
    }
  }

  for (const entry of data.players) {
    if (!map.has(entry)) {
      map.set(entry, {...empty_stats});
    }
  }

  const extended: ExtendedStats[] = [];
  for (const [key, value] of map.entries()) {
    if (value.matches_played > 0) {
      value.points = value.match_win * 3 + value.match_draw;
      value.game_pct = value.game_win / value.games_played;
    }
    extended.push({
      ...value, name: PlayerNames(data, key)[0],
    });
  }

  return extended;

};
