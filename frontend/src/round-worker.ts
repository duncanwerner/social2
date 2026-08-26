import SocialWorker from "./social-worker?worker";
import type { RoundMessage } from "./social-worker";
import type { Round } from "./social";
import type { SocialEvent } from "./types";

// Runs the round optimizer (NextRound) off the main thread. The worker takes the
// current players/courts/rounds/options and returns the full rounds array with
// `count` new rounds appended. A worker is spawned per call and terminated after,
// which keeps calls independent (generation is infrequent — once per round).

export function generateRounds(
  event: SocialEvent,
  count = 1,
): Promise<Round[]> {
  return new Promise((resolve, reject) => {
    const worker = new SocialWorker();
    const message: RoundMessage = {
      players: event.players.map((p) => p.id),
      courts: event.courts.length,
      rounds: event.rounds ?? [],
      options: event.options ?? {},
      count,
    };
    worker.onmessage = (e: MessageEvent) => {
      resolve(e.data as Round[]);
      worker.terminate();
    };
    worker.onerror = (e: ErrorEvent) => {
      reject(new Error(e.message || "round worker error"));
      worker.terminate();
    };
    worker.postMessage(message);
  });
}
