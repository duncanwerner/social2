import { CreatePlayer, type Matchup, type Options, type Player, type Round, type Team } from './social';
import SocialWorker from '$lib/social-worker?worker';
import type { RoundMessage } from './social-worker';

import sample_data from '$lib/sample-event.json';

export interface EventData {

  players: Player[];
  rounds: Round[];
  courts: number;
  options: Partial<Options>;
  player_names: string[];
  max_player: number;

  // how should we manage retired players? ... for the 
  // time being we'll keep a separate list. we really need
  // a richer player interface, with the name in there as well

  retired_players?: Player[];

}

export const LoadSampleData = () => {

  const data = GetEvent();
  if (data.rounds.length || data.player_names.some(test => !!test)) {
    if (!confirm('This will overwrite your current event, are you sure?')) {
      return false;
    }
  }
  SaveEvent(sample_data as unknown as EventData);
  return true;
};

export const CreateEvent = (players = 12, courts = 3, invert_players = false): EventData => {

  const mapped: Player[] = [];
  for (let i = 0; i < players; i++) {
    mapped.push(CreatePlayer(i));
  }

  if (invert_players) {
    mapped.reverse();
  }

  return {
    players: mapped, 
    courts, rounds: [], 
    player_names: [], 
    options: {},
    max_player: mapped.length - 1,
  }

};

// let worker: Worker|undefined;
let resolver: ((rounds: Round[]) => void) | undefined;
let worker: Worker | undefined = undefined;

const EnsureWorker = () => {

  if (!worker) {
    worker = new SocialWorker();
    worker.onmessage = (event) => {
      const rounds: Round[] = event.data;
      if (resolver) {
        const temp = resolver;
        resolver = undefined;
        temp(rounds); // [rounds.length - 1]);
      }
    }  
  }

  return worker;

};


export const GenerateRound = async (social_event: EventData, stop_round = -1, additional_options: Partial<Options> = {}) => {

  const rounds = stop_round >= 0 ? social_event.rounds.slice(0, stop_round) : social_event.rounds.slice(0);

  const data: RoundMessage = {
    ...social_event,
    rounds, // : social_event.rounds.slice(0), // , -1),
    options: {
      ...social_event.options,
      ...additional_options,
    }
  };

  const new_rounds = await new Promise<Round[]>((resolve, reject) => {
    resolver = resolve;
    EnsureWorker().postMessage(JSON.parse(JSON.stringify(data)));
  });

  return new_rounds[new_rounds.length - 1];

};

const storage_key = 'social_event_data';

export const SaveEvent = (event: EventData) => {

  const data = JSON.stringify(event);
  // console.info("SE", data);

  localStorage.setItem(storage_key, data);
};

export const GetEvent = (): EventData => {

  const data = localStorage?.getItem(storage_key);
  if (data) {
    try {
      const parsed = JSON.parse(data) as EventData;

      // patch
      for (const round of parsed.rounds) {
        for (const matchup of round.matchups) {
          for (const index of [0, 1]) {
            if (typeof matchup.score[index] !== 'number') {
              matchup.score[index] = Number(matchup.score[index]) || 0;
            }
          }
        }
      }

      return parsed;
    }
    catch (err) {
      console.error(err);
    }
  }

  const event = CreateEvent();
  localStorage.setItem(storage_key, JSON.stringify(event));
  return event;

};

export const ResetEvent = async (courts = 3, players = 4 * courts, rounds = 0, invert_players = false) => {
  const event = CreateEvent(players, courts, invert_players);
  event.options = {
    ...event.options, absences_as_sitting: true,
  };

  if (rounds) {
    const data: RoundMessage = {
      ...event,
      count: rounds,
    };

    const new_rounds = await new Promise<Round[]>((resolve, reject) => {
      resolver = resolve;
      EnsureWorker().postMessage(JSON.parse(JSON.stringify(data)));
    });

    event.rounds.push(...new_rounds);

  }

  localStorage.setItem(storage_key, JSON.stringify(event));
  return event;
 
};

export const FindPlayer = (event: EventData, name: string) => {

  name = name.toUpperCase();
  for (const [index, value] of event.player_names.entries()) {
    if (value && name === value.toUpperCase()) {
      return CreatePlayer(index);
    }
  }

  return undefined;

};

/**
 * special handling for missing names. FIXME: i18n
 */
export const TeamNames = (social_event: EventData, team: Team) => {

  // disable defaults, do some custom formatting

  const names = PlayerNames(social_event, team, '');
  if (!names[0] && !names[1]) {
    return `Players ${team[0] + 1} & ${team[1] + 1}`;
  }
  else {
    for (let i = 0; i < 2; i++) {
      if (!names[i]) {
        names[i] = `Player ${team[i] + 1}`;
      }
    }
    return names.join(' and ');
  }

};


export const PlayerNames = (event: EventData, players: Player|Player[], default_text = `Player #`) => {
  
  if (!Array.isArray(players)) {
    players = [players];
  }

  return players.map(player => {
    const name = event.player_names[player];
    if (name) { return name; }
    return default_text.replace(/#/g, (player + 1).toString());
  });

};

export const MatchupWinner = (matchup: Matchup) => {
  if (matchup.score[0] >= 0 && matchup.score[1] >= 0) {
    if (matchup.score[0] > matchup.score[1]) {
      return 0;
    }
    if (matchup.score[1] > matchup.score[0]) {
      return 1;
    }
    return 2;
  }
  return -1;
};

export const AddPlayer = (social_event: EventData, insert_at_front = false) => {

  const new_player = CreatePlayer(++social_event.max_player);

  if (insert_at_front) {
    social_event.players.unshift(new_player);
  }
  else {
    social_event.players.push(new_player);
  }
  SaveEvent(social_event);
};

export const DeletePlayer = (social_event: EventData, player: Player) => {

  // FIXME: we should mark deleted so we can save stats
  // or are stats maintained separately? (...)

  social_event.players = social_event.players.filter(test => test !== player);
  SaveEvent(social_event);

};

/**
 * sort the matchup so that the target player is always listed 
 * first. use a copy so we don't affect the original.
 */
export const SortMatchup = (matchup: Matchup, player: Player) => {

  const clone: Matchup = JSON.parse(JSON.stringify(matchup));

  if (!clone.A.includes(player)) {

    // swap teams and scores
    const temp = clone.A;
    clone.A = clone.B;
    clone.B = temp;
    clone.score.reverse();

  }

  // sort team 

  if (clone.A[0] !== player) {
    clone.A[1] = clone.A[0];
    clone.A[0] = player;
  }

  return clone;

};

export const FindMatchup = (round: Round, player: Player) => {

  for (const matchup of round.matchups) {
    if (matchup.A.includes(player) || matchup.B.includes(player)) {
      // return sort ? SortMatchup(matchup, player) : matchup;
      return matchup;
    }
  }

  return undefined;

};

