import { createEffect, createSignal } from "solid-js";
import { For, Show } from "@solidjs/web";
import { useViewLive } from "../../../view-live";
import { generateRounds } from "../../../round-worker";
import { isFinished } from "../../../event-status";
import { ApiError } from "../../../api-error";
import type { PlayerID, Team } from "../../../social";

// /view/:id/rounds — the live round display. Players read; the owner (signed in)
// generates rounds and enters scores here — one page for both.
export default function ViewRounds() {
  const live = useViewLive();

  const rounds = () => live.event()?.rounds ?? [];
  const canManage = () => live.isOwner() && !isFinished(live.eventStatus());

  const [viewIdx, setViewIdx] = createSignal(0);
  const [draft, setDraft] = createSignal<[number, number][]>([]);
  const [generating, setGenerating] = createSignal(false);
  const [savingScores, setSavingScores] = createSignal(false);
  const [error, setError] = createSignal("");

  // Jump to the newest round whenever a round is appended (length changes).
  createEffect(
    () => rounds().length,
    (len) => {
      if (len > 0) setViewIdx(len - 1);
    },
  );

  // Seed editable scores when the viewed round changes or a round is added.
  // The tracked value must be a STABLE primitive (a string key), not a fresh
  // array — otherwise Solid's reference compare treats every event update as a
  // change and the reseed wipes the owner's in-progress edits (their own save
  // echo included).
  createEffect(
    () => `${viewIdx()}|${rounds().length}`,
    () => {
      const r = rounds()[viewIdx()];
      setDraft(r ? r.matchups.map((m) => [m.score[0], m.score[1]]) : []);
    },
  );

  const round = () => rounds()[viewIdx()];

  const nameOf = (id: PlayerID) => {
    const p = live.event()?.players.find((pp) => pp.id === id);
    return p?.name?.trim() || `Player ${id + 1}`;
  };
  const teamName = (t: Team) => `${nameOf(t[0])} & ${nameOf(t[1])}`;
  const courtName = (i: number) =>
    live.event()?.courts[i]?.name?.trim() || `Court ${i + 1}`;

  const scoreLabel = (n: number) => (n < 0 ? "—" : String(n));
  const draftVal = (m: number, side: 0 | 1) => {
    const v = draft()[m]?.[side];
    return v === undefined || v < 0 ? "" : String(v);
  };
  const setScore = (m: number, side: 0 | 1, value: string) => {
    const n = value === "" ? -1 : Math.max(0, Math.floor(Number(value) || 0));
    setDraft((prev) => {
      const copy = prev.map((p) => [p[0], p[1]] as [number, number]);
      if (copy[m]) copy[m][side] = n;
      return copy;
    });
  };

  // Unsaved-changes tracking: compare the draft to the persisted round scores.
  const savedScore = (m: number, side: 0 | 1) =>
    round()?.matchups[m]?.score[side] ?? -1;
  const isDirty = (m: number, side: 0 | 1) =>
    (draft()[m]?.[side] ?? -1) !== savedScore(m, side);
  const dirty = () =>
    draft().some((d, m) => d[0] !== savedScore(m, 0) || d[1] !== savedScore(m, 1));

  // The current event with the viewed round's draft scores merged in.
  const eventWithDraftScores = () => {
    const ev = live.event();
    if (!ev || !ev.rounds) return ev;
    const idx = viewIdx();
    const d = draft();
    const nextRounds = ev.rounds.map((r, ri) =>
      ri !== idx
        ? r
        : {
            ...r,
            matchups: r.matchups.map((mm, mi) => ({
              ...mm,
              score: [d[mi]?.[0] ?? -1, d[mi]?.[1] ?? -1] as [number, number],
            })),
          },
    );
    return { ...ev, rounds: nextRounds };
  };

  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

  async function generate() {
    const base = eventWithDraftScores(); // fold in unsaved scores first
    if (!base || generating()) return;
    setGenerating(true);
    setError("");
    try {
      const nextRounds = await generateRounds(base, 1);
      await live.save({ ...base, rounds: nextRounds });
    } catch (e) {
      setError(`Could not generate round — ${errMsg(e)}`);
    } finally {
      setGenerating(false);
    }
  }

  async function saveScores() {
    const next = eventWithDraftScores();
    if (!next || savingScores()) return;
    setSavingScores(true);
    setError("");
    try {
      await live.save(next);
    } catch (e) {
      setError(`Could not save scores — ${errMsg(e)}`);
    } finally {
      setSavingScores(false);
    }
  }

  return (
    <main class="view-page">
      <Show
        when={rounds().length > 0}
        fallback={
          <section class="card view-stub">
            <h2>No rounds yet</h2>
            <Show
              when={canManage()}
              fallback={<p class="hint">The organiser hasn’t started play.</p>}
            >
              <button
                class="primary"
                type="button"
                disabled={generating()}
                onClick={generate}
              >
                {generating() ? "Generating…" : "Generate first round"}
              </button>
            </Show>
          </section>
        }
      >
        <header class="rounds-head">
          <button
            class="link"
            type="button"
            disabled={viewIdx() === 0}
            onClick={() => setViewIdx((i) => Math.max(0, i - 1))}
          >
            ‹ Prev
          </button>
          <span class="rounds-title">
            Round {viewIdx() + 1} of {rounds().length}
          </span>
          <button
            class="link"
            type="button"
            disabled={viewIdx() >= rounds().length - 1}
            onClick={() =>
              setViewIdx((i) => Math.min(rounds().length - 1, i + 1))
            }
          >
            Next ›
          </button>
        </header>

        <For each={round()?.matchups ?? []}>
          {(m, i) => (
            <section class="card matchup">
              <div class="court-label">{courtName(i())}</div>
              <div class="team-row">
                <span class="team">{teamName(m.A)}</span>
                <Show
                  when={canManage()}
                  fallback={<span class="score">{scoreLabel(m.score[0])}</span>}
                >
                  <input
                    class={isDirty(i(), 0) ? "score-input dirty" : "score-input"}
                    type="number"
                    inputmode="numeric"
                    min="0"
                    value={draftVal(i(), 0)}
                    onInput={(e) => setScore(i(), 0, e.currentTarget.value)}
                  />
                </Show>
              </div>
              <div class="vs">vs</div>
              <div class="team-row">
                <span class="team">{teamName(m.B)}</span>
                <Show
                  when={canManage()}
                  fallback={<span class="score">{scoreLabel(m.score[1])}</span>}
                >
                  <input
                    class={isDirty(i(), 1) ? "score-input dirty" : "score-input"}
                    type="number"
                    inputmode="numeric"
                    min="0"
                    value={draftVal(i(), 1)}
                    onInput={(e) => setScore(i(), 1, e.currentTarget.value)}
                  />
                </Show>
              </div>
            </section>
          )}
        </For>

        <Show when={(round()?.sitting?.length ?? 0) > 0}>
          <section class="card sitting">
            <span class="info-label">Sitting</span>
            <span>{round()!.sitting.map(nameOf).join(", ")}</span>
          </section>
        </Show>

        <Show when={error()}>
          <p class="err-inline">{error()}</p>
        </Show>

        <Show when={canManage()}>
          <div class="rounds-actions">
            <button
              class={dirty() ? "primary" : "secondary"}
              type="button"
              disabled={!dirty() || savingScores()}
              onClick={saveScores}
            >
              {savingScores()
                ? "Saving…"
                : dirty()
                  ? "Save scores"
                  : "Scores saved"}
            </button>
            <button
              class="primary"
              type="button"
              disabled={generating()}
              onClick={generate}
            >
              {generating() ? "Generating…" : "Generate next round"}
            </button>
          </div>
        </Show>
      </Show>
    </main>
  );
}
