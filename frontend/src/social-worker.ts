
import { NextRound, type Options, type PlayerID, type Round, type RoundSeed } from './social';

export interface RoundMessage {
  players: PlayerID[];
  rounds: Round[];
  courts: number;
  options: Partial<Options>;
  count?: number;
  /**
   * Optional manual assignment for the round being filled; only applies to the
   * first generated round (a seed describes one specific round). See RoundSeed.
   */
  seed?: RoundSeed;
}

onmessage = (event: MessageEvent) => {

  const data: RoundMessage = event.data;
  if (data) {
    const rounds: Round[] = [...data.rounds];
    const count = data.count || 1;
    for (let i = 0; i < count; i++) {
      const round = NextRound(data.players, data.courts, rounds, data.options, i === 0 ? data.seed : undefined);
      rounds.push(round);
    }
    postMessage(rounds);
  }

};

