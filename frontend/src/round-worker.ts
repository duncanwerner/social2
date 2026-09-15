import SocialWorker from "./social-worker?worker";
import type { RoundMessage } from "./social-worker";
import type { Round, RoundSeed } from "./social";
import type { SocialEvent } from "./types";

// Runs the round optimizer (NextRound) off the main thread. The worker takes the
// current players/courts/rounds/options and returns the full rounds array with
// `count` new rounds appended. A worker is spawned per call and terminated after,
// which keeps calls independent (generation is infrequent — once per round).
//
// An optional `seed` fills a manually edited round: the seeded courts/players are
// kept as-is and the optimizer only decides the open slots (see RoundSeed).

export function generateRounds(
  event: SocialEvent,
  count = 1,
  seed?: RoundSeed,
): Promise<Round[]> {
  // Players flagged `disabled` sit the next round out: fold them into the
  // optimizer's force_sitting (deduped with any already configured), which pulls
  // them from the pool and lists them as sitting rather than assigning a court.
  const forced = new Set(event.options?.force_sitting ?? []);
  for (const p of event.players) if (p.disabled) forced.add(p.id);

  return new Promise((resolve, reject) => {
    const worker = new SocialWorker();
    const message: RoundMessage = {
      players: event.players.map((p) => p.id),
      courts: event.courts.length,
      rounds: event.rounds ?? [],
      options: { ...(event.options ?? {}), force_sitting: [...forced] },
      count,
      seed,
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
