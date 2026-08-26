
import { NextRound, type Options, type PlayerID, type Round } from './social';

export interface RoundMessage {
  players: PlayerID[];
  rounds: Round[];
  courts: number;
  options: Partial<Options>;
  count?: number;
}

onmessage = (event: MessageEvent) => {

  const data: RoundMessage = event.data;
  if (data) {
    const rounds: Round[] = [...data.rounds];
    const count = data.count || 1;
    for (let i = 0; i < count; i++) {
      const round = NextRound(data.players, data.courts, rounds, data.options);
      rounds.push(round);
    }
    postMessage(rounds);
  }

};

