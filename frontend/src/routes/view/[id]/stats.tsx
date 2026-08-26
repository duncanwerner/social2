import { createSignal } from "solid-js";
import { For, Show } from "@solidjs/web";
import { useViewLive } from "../../../view-live";
import {
  computeStandings,
  rankStandings,
  type RankedStanding,
  type StandingsMode,
} from "../../../standings";

// Scoring-view preference persists in sessionStorage (per browser tab) so paging
// between the stats/rounds/info tabs — which remounts this page — keeps the view.
const MODE_KEY = "rotation:stats-mode";
function readMode(): StandingsMode {
  try {
    const v = sessionStorage.getItem(MODE_KEY);
    return v === "matches" || v === "games" ? v : "games";
  } catch {
    return "games";
  }
}

// /view/:id/stats — the league table. Two scoring views over the same results:
// "Games" (games won/lost) and "Matches" (football points, 3/1/0). Live-updating
// via the shared event.
export default function ViewStats() {
  const live = useViewLive();
  const [mode, setMode] = createSignal<StandingsMode>(readMode());

  // Persist the choice as well as applying it.
  const selectMode = (m: StandingsMode) => {
    setMode(m);
    try {
      sessionStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore — storage unavailable (private mode, etc.) */
    }
  };

  const table = (): RankedStanding[] => {
    const ev = live.event();
    return ev ? rankStandings(computeStandings(ev), mode()) : [];
  };
  // Any scores entered yet? (Otherwise everyone is on zero — show a hint.)
  const hasResults = () => table().some((r) => r.played > 0);

  const fmtDiff = (n: number) => (n > 0 ? `+${n}` : String(n));
  // Game win rate: games won / total games played (— when nothing played yet).
  const winPct = (r: RankedStanding) => {
    const total = r.gamesFor + r.gamesAgainst;
    return total === 0 ? "—" : `${Math.round((r.gamesFor / total) * 100)}%`;
  };

  // Columns after the fixed rank + name. `strong` marks the ranking column.
  type Col = { label: string; get: (r: RankedStanding) => string; strong?: boolean };
  const columns = (): Col[] =>
    mode() === "matches"
      ? [
          { label: "P", get: (r) => String(r.played) },
          { label: "W", get: (r) => String(r.wins) },
          { label: "D", get: (r) => String(r.draws) },
          { label: "L", get: (r) => String(r.losses) },
          { label: "Pts", get: (r) => String(r.points), strong: true },
        ]
      : [
          { label: "Won", get: (r) => String(r.gamesFor), strong: true },
          { label: "Lost", get: (r) => String(r.gamesAgainst) },
          { label: "Win%", get: (r) => winPct(r) },
          { label: "+/−", get: (r) => fmtDiff(r.gamesDiff) },
        ];

  return (
    <main class="view-page">
      <div class="seg" role="tablist" aria-label="Scoring">
        <button
          type="button"
          role="tab"
          aria-selected={mode() === "games" ? "true" : "false"}
          class={mode() === "games" ? "seg-btn active" : "seg-btn"}
          onClick={() => selectMode("games")}
        >
          Games
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode() === "matches" ? "true" : "false"}
          class={mode() === "matches" ? "seg-btn active" : "seg-btn"}
          onClick={() => selectMode("matches")}
        >
          Matches
        </button>
      </div>

      <Show
        when={hasResults()}
        fallback={
          <section class="card view-stub">
            <h2>No results yet</h2>
            <p class="hint">The table fills in as scores are entered.</p>
          </section>
        }
      >
        <section class="card standings-card">
          <table class="standings">
            <thead>
              <tr>
                <th class="col-rank">#</th>
                <th class="col-name">Player</th>
                <For each={columns()}>
                  {(c) => (
                    <th class={c.strong ? "col-num col-key" : "col-num"}>
                      {c.label}
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={table()}>
                {(r) => (
                  <tr class={r.rank === 1 ? "leader" : undefined}>
                    <td class="col-rank">{r.rank}</td>
                    <td class="col-name">
                      {r.name}
                      <Show when={r.rank === 1}>
                        <span class="crown" title="Leader" aria-label="Leader">
                          {" "}
                          👑
                        </span>
                      </Show>
                    </td>
                    <For each={columns()}>
                      {(c) => (
                        <td class={c.strong ? "col-num col-key" : "col-num"}>
                          {c.get(r)}
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <p class="hint standings-note">
            {mode() === "matches"
              ? "3 points for a win, 1 for a draw."
              : "Total games won and lost."}
          </p>
        </section>
      </Show>
    </main>
  );
}
