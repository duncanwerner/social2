import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { For, Show } from "@solidjs/web";
import { useViewLive } from "../../../view-live";
import { generateRounds } from "../../../round-worker";
import { RoundEditor } from "../../../components/RoundEditor";
import { isFinished } from "../../../event-status";
import { ApiError } from "../../../api-error";
import type { Matchup, PlayerID, Round, Team } from "../../../social";

// /view/:id/rounds — the live round display. Players read; the owner (signed in)
// generates rounds and enters scores here — one page for both.
export default function ViewRounds() {
  const live = useViewLive();

  // Raw (owner-authoritative) rounds — stable object identity, so iterating them
  // doesn't tear down inputs when a provisional score arrives. Provisional scores
  // are overlaid per-cell at display time (see displayScore below).
  const rounds = () => live.event()?.rounds ?? [];
  const canManage = () => live.isOwner() && !isFinished(live.eventStatus());
  // Any non-owner viewer may enter scores when the owner has enabled the flag.
  const canPlayerScore = () =>
    !live.isOwner() &&
    !isFinished(live.eventStatus()) &&
    !!live.event()?.allowPlayerScores;

  const [viewIdx, setViewIdx] = createSignal(0);
  const [draft, setDraft] = createSignal<[number, number][]>([]);
  const [generating, setGenerating] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [savingScores, setSavingScores] = createSignal(false);
  const [submitting, setSubmitting] = createSignal<number | null>(null);
  // True while the owner is manually assigning the newest round's courts.
  const [editing, setEditing] = createSignal(false);
  // Matchup indices showing a transient "Submitted ✓" confirmation (player path).
  const [submitted, setSubmitted] = createSignal<Set<number>>(new Set());
  // Cells ("m:side") the owner/player has hand-edited since the round was seeded;
  // live provisional updates refresh only the *un*touched cells (see reseed effect).
  const [touched, setTouched] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal("");
  let confirmTimers: ReturnType<typeof setTimeout>[] = [];
  onCleanup(() => confirmTimers.forEach(clearTimeout));

  // Jump to the newest round whenever a round is appended (length changes).
  createEffect(
    () => rounds().length,
    (len) => {
      if (len > 0) setViewIdx(len - 1);
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

  // Provisional (player-entered) score for a matchup: present only when the owner
  // hasn't scored it and a player has proposed one. Owner scores always win.
  const provisionalFor = (m: Matchup): [number, number] | undefined => {
    if (m.score[0] >= 0 || m.score[1] >= 0) return undefined; // owner scored
    return m.id ? live.provisional()[m.id] : undefined;
  };
  const isProvisional = (m: Matchup) => provisionalFor(m) !== undefined;
  // The score to show: owner score if entered, else the provisional one, else -1.
  const displayScore = (m: Matchup, side: 0 | 1): number => {
    const p = provisionalFor(m);
    return p ? p[side] : m.score[side];
  };
  // Has the owner scored this matchup (by index within the current round)?
  const ownerScored = (m: number): boolean => {
    const s = round()?.matchups[m]?.score;
    return !!s && (s[0] >= 0 || s[1] >= 0);
  };

  // The winning side of a matchup once both scores are in: 0 = A, 1 = B, -1 =
  // unscored or a draw (no team highlighted). Uses displayed (owner-or-provisional)
  // scores.
  const winner = (m: Matchup): 0 | 1 | -1 => {
    const a = displayScore(m, 0);
    const b = displayScore(m, 1);
    if (a < 0 || b < 0 || a === b) return -1;
    return a > b ? 0 : 1;
  };

  // Seed/refresh the editable score inputs from the displayed scores. The tracked
  // key includes both the round identity AND a signature of the displayed scores,
  // so a live provisional submission (which changes the scores but not the round
  // length) re-runs this and the owner sees it immediately. To avoid clobbering
  // in-progress typing, cells the user has hand-edited (`touched`) are preserved;
  // only untouched cells pick up the new value. Switching rounds clears `touched`
  // and reseeds everything. (Defined here, after displayScore — this Solid 2 RC
  // evaluates the dependency function eagerly, so it must not close over a
  // not-yet-initialised const.)
  let prevRoundKey = "";
  createEffect(
    () => {
      const r = rounds()[viewIdx()];
      const sig = r
        ? r.matchups.map((m) => `${displayScore(m, 0)}/${displayScore(m, 1)}`).join(",")
        : "";
      return `${viewIdx()}|${rounds().length}##${sig}`;
    },
    (key) =>
      untrack(() => {
        const roundKey = key.slice(0, key.indexOf("##"));
        const roundChanged = roundKey !== prevRoundKey;
        prevRoundKey = roundKey;
        const r = rounds()[viewIdx()];
        if (!r) {
          if (roundChanged) setTouched(new Set<string>());
          setDraft([]);
          return;
        }
        if (roundChanged) {
          // A different round is in view — forget prior edits, reseed all cells.
          setTouched(new Set<string>());
          setDraft(r.matchups.map((m) => [displayScore(m, 0), displayScore(m, 1)]));
          return;
        }
        // Same round, displayed scores changed live (e.g. a player just submitted):
        // refresh only the cells the user hasn't edited.
        const t = touched();
        setDraft((prev) =>
          r.matchups.map((m, i) => {
            const cur = prev[i];
            const s0 = t.has(`${i}:0`) && cur ? cur[0] : displayScore(m, 0);
            const s1 = t.has(`${i}:1`) && cur ? cur[1] : displayScore(m, 1);
            return [s0, s1];
          }),
        );
      }),
  );

  const scoreLabel = (n: number) => (n < 0 ? "—" : String(n));
  const draftVal = (m: number, side: 0 | 1) => {
    const v = draft()[m]?.[side];
    return v === undefined || v < 0 ? "" : String(v);
  };
  const setScore = (m: number, side: 0 | 1, value: string) => {
    const n = value === "" ? -1 : Math.max(0, Math.floor(Number(value) || 0));
    // Mark this cell hand-edited so a live provisional update won't overwrite it.
    setTouched((t) => new Set<string>(t).add(`${m}:${side}`));
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

  // "Just generated" affordance: the viewed round is the newest one and has no
  // saved scores yet (and none half-entered). Regenerating replaces it in place.
  const isLastRound = () => viewIdx() === rounds().length - 1;
  const currentUnscored = () =>
    (round()?.matchups ?? []).every((m) => m.score[0] < 0 && m.score[1] < 0);
  const canRegenerate = () =>
    canManage() && isLastRound() && !dirty() && currentUnscored();

  // Discard the current (newest) round and generate a fresh one in its place,
  // keeping all prior rounds so the optimizer still avoids repeats.
  async function regenerate() {
    const ev = live.event();
    if (!ev || generating()) return;
    const kept = { ...ev, rounds: (ev.rounds ?? []).slice(0, viewIdx()) };
    setGenerating(true);
    setError("");
    try {
      const nextRounds = await generateRounds(kept, 1);
      await live.save({ ...kept, rounds: nextRounds });
    } catch (e) {
      setError(`Could not regenerate round — ${errMsg(e)}`);
    } finally {
      setGenerating(false);
    }
  }

  // Manual editing targets the same round Regenerate does: the newest, unscored
  // one. History is never editable, and a played round's scores are never
  // disturbed. A court-less event has nothing to assign.
  const canEditRound = () =>
    canRegenerate() && (live.event()?.courts.length ?? 0) > 0;

  // Deleting mirrors editing's guard exactly: the newest, unscored round, with
  // nothing half-entered. It deliberately does not require courts — there is
  // nothing to assign — so an event whose courts were removed can still drop its
  // stale round. Discarding it is safe: the round is unscored and regenerable.
  const canDeleteRound = () => canRegenerate();

  // Drop the newest round and persist (which broadcasts to viewers). Prior rounds
  // are kept, so the optimizer's history for the next generation is unchanged.
  async function deleteRound() {
    const ev = live.event();
    if (!ev?.rounds?.length || !canDeleteRound() || deleting()) return;
    setDeleting(true);
    setError("");
    try {
      await live.save({ ...ev, rounds: ev.rounds.slice(0, -1) });
    } catch (e) {
      setError(`Could not delete round — ${errMsg(e)}`);
    } finally {
      setDeleting(false);
    }
  }

  // Replace the edited round in place and persist (which broadcasts to viewers).
  // Rejects on failure so the editor can show the message and stay open.
  async function saveEditedRound(edited: Round) {
    const ev = live.event();
    if (!ev?.rounds) throw new Error("the event is no longer available");
    const idx = viewIdx();
    await live.save({
      ...ev,
      rounds: ev.rounds.map((r, i) => (i === idx ? edited : r)),
    });
    setEditing(false);
  }

  async function saveScores() {
    const next = eventWithDraftScores();
    if (!next || savingScores()) return;
    setSavingScores(true);
    setError("");
    try {
      await live.save(next);
      // Scores are now persisted; forget the edit marks so later live provisional
      // updates for this round flow into the inputs again.
      setTouched(new Set<string>());
    } catch (e) {
      setError(`Could not save scores — ${errMsg(e)}`);
    } finally {
      setSavingScores(false);
    }
  }

  // Player path: submit one matchup's provisional score. Both sides must be
  // entered. Goes to /submit-score (not the owner save), broadcasts to everyone.
  async function submitOne(m: number) {
    const mu = round()?.matchups[m];
    const d = draft()[m];
    if (!mu || !d || d[0] < 0 || d[1] < 0 || submitting() !== null) return;
    setSubmitting(m);
    setError("");
    try {
      await live.submitScore(mu.id, [d[0], d[1]]);
      // Show a "Submitted ✓" confirmation on this matchup for ~3s.
      setSubmitted((s) => new Set<number>(s).add(m));
      confirmTimers.push(
        setTimeout(() => {
          setSubmitted((s) => {
            const next = new Set(s);
            next.delete(m);
            return next;
          });
        }, 3000),
      );
    } catch (e) {
      setError(`Could not submit score — ${errMsg(e)}`);
    } finally {
      setSubmitting(null);
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
        <Show
          when={editing() ? round() : undefined}
          fallback={
            <>
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
                {(m, i) => {
                  // A cell is editable for the owner, or for a player when the owner
                  // hasn't already scored this matchup.
                  const editable = () => canManage() || (canPlayerScore() && !ownerScored(i()));
                  const inputClass = (side: 0 | 1) =>
                    canManage()
                      ? isDirty(i(), side)
                        ? "score-input dirty"
                        : "score-input"
                      : isProvisional(m)
                        ? "score-input provisional"
                        : "score-input";
                  const cell = (side: 0 | 1) => (
                    <Show
                      when={editable()}
                      fallback={
                        <span class={isProvisional(m) ? "score provisional" : "score"}>
                          {scoreLabel(displayScore(m, side))}
                        </span>
                      }
                    >
                      <input
                        class={inputClass(side)}
                        type="number"
                        inputmode="numeric"
                        min="0"
                        value={draftVal(i(), side)}
                        onInput={(e) => setScore(i(), side, e.currentTarget.value)}
                      />
                    </Show>
                  );
                  return (
                    <section class="card matchup">
                      <div class="court-label">{courtName(i())}</div>
                      <div class="team-row">
                        <span class={winner(m) === 0 ? "team win" : "team"}>
                          {teamName(m.A)}
                        </span>
                        {cell(0)}
                      </div>
                      <div class="vs">vs</div>
                      <div class="team-row">
                        <span class={winner(m) === 1 ? "team win" : "team"}>
                          {teamName(m.B)}
                        </span>
                        {cell(1)}
                      </div>
                      <Show when={canPlayerScore() && !ownerScored(i())}>
                        <button
                          class={
                            submitted().has(i())
                              ? "secondary submit-score"
                              : "primary submit-score"
                          }
                          type="button"
                          disabled={
                            submitting() === i() ||
                            submitted().has(i()) ||
                            draftVal(i(), 0) === "" ||
                            draftVal(i(), 1) === ""
                          }
                          onClick={(e) => {
                            // iOS Safari freezes scrolling in the overflow container
                            // when the just-tapped button becomes disabled while it
                            // still holds focus — it unsticks only when the button
                            // re-enables. Drop focus before the submit disables it.
                            e.currentTarget.blur();
                            void submitOne(i());
                          }}
                        >
                          {submitting() === i()
                            ? "Submitting…"
                            : submitted().has(i())
                              ? "Submitted ✓"
                              : "Submit score"}
                        </button>
                      </Show>
                    </section>
                  );
                }}
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

              {/* Owner-only, and only on the newest unscored round: history is
                  never editable or deletable. Kept out of the action row below so
                  its buttons still fit on a phone. */}
              <Show when={canRegenerate()}>
                <div class="rounds-edit-bar">
                  <Show when={canEditRound()}>
                    <button
                      class="link"
                      type="button"
                      disabled={generating()}
                      onClick={() => {
                        setError("");
                        setEditing(true);
                      }}
                    >
                      ✎ Edit round manually
                    </button>
                  </Show>
                  <Show when={canDeleteRound()}>
                    <button
                      class="link danger-link"
                      type="button"
                      disabled={deleting() || generating()}
                      onClick={deleteRound}
                    >
                      {deleting() ? "Deleting…" : "🗑 Delete round"}
                    </button>
                  </Show>
                </div>
              </Show>

              <Show when={canManage()}>
                <div class="rounds-actions">
                  {/* On a fresh, unscored round the score save is a no-op, so Regenerate
                      takes that slot — keeping the row to two buttons that never wrap. */}
                  <Show
                    when={canRegenerate()}
                    fallback={
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
                    }
                  >
                    <button
                      class="secondary"
                      type="button"
                      disabled={generating()}
                      onClick={regenerate}
                    >
                      {generating() ? "Regenerating…" : "Regenerate"}
                    </button>
                  </Show>
                  <button
                    class="primary"
                    type="button"
                    disabled={generating() || !isLastRound()}
                    onClick={generate}
                  >
                    {generating() ? "Generating…" : "+ Next round"}
                  </button>
                </div>
              </Show>
            </>
          }
        >
          {(r) => (
            <RoundEditor
              event={live.event()!}
              history={rounds().slice(0, viewIdx())}
              round={r()}
              index={viewIdx()}
              onCancel={() => setEditing(false)}
              onSave={saveEditedRound}
            />
          )}
        </Show>
      </Show>
    </main>
  );
}
