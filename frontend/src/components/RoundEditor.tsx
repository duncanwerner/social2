import { createSignal } from "solid-js";
import { For, Show } from "@solidjs/web";
import { generateRounds } from "../round-worker";
import { ApiError } from "../api-error";
import type { Matchup, PartialMatchup, PlayerID, Round, RoundSeed } from "../social";
import type { SocialEvent } from "../types";

// Manual round editing (owner-only, on the newest unscored round). The owner
// assigns players to court slots; picking someone who is already on another
// court moves them here. Slots left open are resolved by the optimizer through
// `generateRounds(event, 1, seed)`, which honours the manual assignments, fills
// the open courts within the usual fairness constraints, and sits whoever is
// left (see RoundSeed in social.ts).

/** one court's four slots, in A0, A1, B0, B1 order; null = open */
type CourtSlots = [PlayerID | null, PlayerID | null, PlayerID | null, PlayerID | null];

const EMPTY_COURT = (): CourtSlots => [null, null, null, null];

const slotsOf = (round: Round, size: number): CourtSlots[] =>
  Array.from({ length: size }, (_, i) => {
    const m = round.matchups[i];
    return m ? [m.A[0], m.A[1], m.B[0], m.B[1]] : EMPTY_COURT();
  });

const countIn = (slots: CourtSlots) => slots.filter((s) => s !== null).length;

/** Does this matchup field exactly these four slots? */
const lineupMatches = (matchup: Matchup, slots: CourtSlots) =>
  matchup.A[0] === slots[0] &&
  matchup.A[1] === slots[1] &&
  matchup.B[0] === slots[2] &&
  matchup.B[1] === slots[3];

/**
 * Project a filled round back onto the editor's court layout. The optimizer
 * returns a dense matchup list — a court it could not complete is dropped — so
 * each seeded court is matched back by its fixed players, keeping the owner's
 * court numbering. Dropped courts come back open (and their players sit); games
 * created on courts the owner left open land on those open courts, in order.
 *
 * Exported for the round-generation validator.
 */
export function applyFill(
  base: CourtSlots[],
  filled: Round,
  size: number,
): { courts: CourtSlots[]; dropped: number[] } {
  const courts = Array.from({ length: size }, EMPTY_COURT);
  const remaining = filled.matchups.slice();
  const dropped: number[] = [];

  base.forEach((slots, i) => {
    const fixed = slots.filter((s): s is PlayerID => s !== null);
    if (!fixed.length) return; // an open court: filled fresh, matched below
    const at = remaining.findIndex((m) => {
      const four: PlayerID[] = [...m.A, ...m.B];
      return fixed.every((p) => four.includes(p));
    });
    if (at === -1) {
      // The optimizer dropped this court: nobody could fill its open slots.
      dropped.push(i);
      return;
    }
    const m = remaining.splice(at, 1)[0];
    courts[i] = [m.A[0], m.A[1], m.B[0], m.B[1]];
  });

  for (const m of remaining) {
    const i = courts.findIndex((slots) => countIn(slots) === 0);
    if (i === -1) break;
    courts[i] = [m.A[0], m.A[1], m.B[0], m.B[1]];
  }

  return { courts, dropped };
}

interface RoundEditorProps {
  /** the whole event: the roster and courts the editor works from */
  event: SocialEvent;
  /** rounds played before the one being edited — the optimizer's history */
  history: Round[];
  /** the round being edited (the newest, unscored one) */
  round: Round;
  /** 0-based index of the edited round, for the heading */
  index: number;
  onCancel: () => void;
  /** persist the edited round; rejects on failure */
  onSave: (round: Round) => Promise<void>;
}

export function RoundEditor(props: RoundEditorProps) {
  const courtSize = () =>
    Math.max(props.event.courts.length, props.round.matchups.length, 1);

  const [courts, setCourts] = createSignal<CourtSlots[]>(
    slotsOf(props.round, courtSize()),
  );
  const [busy, setBusy] = createSignal<"fill" | "save" | null>(null);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  // The layout the last "Fill remaining" started from. Keeping it means a second
  // press re-rolls the open slots instead of filling an already-complete round.
  // A manual edit clears it, so the next fill starts from what the owner sees.
  const [fillSeed, setFillSeed] = createSignal<CourtSlots[] | null>(null);

  // Players marked "Sit" are not pickable: the checkbox always wins (NextRound
  // also clears them from a seed defensively). Disabled players show up in the
  // sitting list below instead.
  const pickable = () => props.event.players.filter((p) => !p.disabled);
  const nameOf = (id: PlayerID) =>
    props.event.players.find((p) => p.id === id)?.name?.trim() || `Player ${id + 1}`;
  const courtName = (i: number) =>
    props.event.courts[i]?.name?.trim() || `Court ${i + 1}`;

  const assigned = () => {
    const ids = new Set<PlayerID>();
    for (const slots of courts()) for (const s of slots) if (s !== null) ids.add(s);
    return ids;
  };
  const sitting = () => props.event.players.filter((p) => !assigned().has(p.id));

  /** the court `player` currently plays on, or -1 when they are sitting */
  const courtOf = (player: PlayerID) => {
    const all = courts();
    for (let i = 0; i < all.length; i++) if (all[i].includes(player)) return i;
    return -1;
  };
  const optionLabel = (player: PlayerID) => {
    const at = courtOf(player);
    return at === -1 ? nameOf(player) : `${nameOf(player)} · ${courtName(at)}`;
  };
  const slotValue = (court: number, slot: number) => {
    const player = courts()[court][slot];
    return player === null ? "" : String(player);
  };

  function assign(court: number, slot: number, raw: string) {
    const player = raw === "" ? null : (Number(raw) as PlayerID);
    setCourts((prev) => {
      const next = prev.map((slots) => slots.slice() as CourtSlots);
      if (player !== null) {
        // One player, one court: take them off whoever holds them.
        for (const slots of next) {
          for (let i = 0; i < slots.length; i++) {
            if (slots[i] === player) slots[i] = null;
          }
        }
      }
      next[court][slot] = player;
      return next;
    });
    setFillSeed(null);
    setError("");
    setNotice("");
  }

  function clearCourt(court: number) {
    setCourts((prev) =>
      prev.map((slots, i) => (i === court ? EMPTY_COURT() : slots)),
    );
    setFillSeed(null);
    setError("");
    setNotice("");
  }

  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

  async function fillRemaining() {
    if (busy()) return;
    const base = fillSeed() ?? courts();
    const seed: RoundSeed = {
      matchups: base.map((slots): PartialMatchup => ({
        A: [slots[0], slots[1]],
        B: [slots[2], slots[3]],
      })),
    };
    setBusy("fill");
    setError("");
    setNotice("");
    try {
      const all = await generateRounds(
        { ...props.event, rounds: props.history },
        1,
        seed,
      );
      const filled = all[all.length - 1];
      if (!filled) throw new Error("the optimizer returned no round");
      const applied = applyFill(base, filled, courtSize());
      setFillSeed(base);
      setCourts(applied.courts);
      if (applied.dropped.length) {
        const names = applied.dropped.map(courtName).join(", ");
        setNotice(
          `Not enough unassigned players to complete ${names} — those players ` +
            `now sit. Clear the court or free up players to fill it.`,
        );
      } else {
        setNotice("Filled the open courts and slots.");
      }
    } catch (e) {
      setError(`Could not fill the round — ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const current = courts();
    const partial = current
      .map((slots, i) => ({ i, count: countIn(slots) }))
      .filter(({ count }) => count > 0 && count < 4);
    if (partial.length) {
      const { i, count } = partial[0];
      setError(`${courtName(i)} has ${count} of 4 players — fill it or clear it.`);
      return;
    }
    const complete = current
      .map((slots, i) => ({ slots, i }))
      .filter(({ slots }) => countIn(slots) === 4);
    if (!complete.length) {
      setError("Assign four players to at least one court.");
      return;
    }

    const matchups: Matchup[] = complete.map(({ slots, i }) => {
      const original = props.round.matchups[i];
      return {
        // Keep the matchup id when the lineup is untouched, so a pending
        // player-entered score for it isn't orphaned by an unrelated edit.
        id: original && lineupMatches(original, slots)
          ? original.id
          : crypto.randomUUID(),
        A: [slots[0]!, slots[1]!],
        B: [slots[2]!, slots[3]!],
        score: [-1, -1],
      };
    });

    setBusy("save");
    setError("");
    try {
      await props.onSave({
        matchups,
        sitting: sitting().map((p) => p.id),
        // Mirrors a generated round: the Sit players are always listed here.
        force_sitting: props.event.players
          .filter((p) => p.disabled)
          .map((p) => p.id),
      });
      // On success the parent unmounts this editor; no state to reset.
    } catch (e) {
      setError(`Could not save the round — ${errMsg(e)}`);
      setBusy(null);
    }
  }

  const SlotSelect = (selectProps: { court: number; slot: number; label: string }) => (
    <select
      class="slot-select"
      aria-label={selectProps.label}
      value={slotValue(selectProps.court, selectProps.slot)}
      onChange={(e) => assign(selectProps.court, selectProps.slot, e.currentTarget.value)}
    >
      <option value="">— open —</option>
      <For each={pickable()}>
        {(player) => <option value={player.id}>{optionLabel(player.id)}</option>}
      </For>
    </select>
  );

  return (
    <div class="round-edit">
      <header class="rounds-head">
        <span class="rounds-title">Editing round {props.index + 1}</span>
      </header>
      <p class="hint">
        Pick players for each court. Choosing someone already on another court
        moves them here. Leave slots open and use Fill remaining to complete the
        round.
      </p>

      <For each={courts()} keyed={false}>
        {(slots, court) => (
          <section class="card matchup">
            <div class="court-label">
              {courtName(court)}
              <span class="edit-count">{countIn(slots())}/4</span>
            </div>
            <div class="slot-row">
              <SlotSelect
                court={court}
                slot={0}
                label={`${courtName(court)} team A, player 1`}
              />
              <SlotSelect
                court={court}
                slot={1}
                label={`${courtName(court)} team A, player 2`}
              />
            </div>
            <div class="vs">vs</div>
            <div class="slot-row">
              <SlotSelect
                court={court}
                slot={2}
                label={`${courtName(court)} team B, player 1`}
              />
              <SlotSelect
                court={court}
                slot={3}
                label={`${courtName(court)} team B, player 2`}
              />
            </div>
            <Show when={countIn(slots()) > 0}>
              <button
                class="link clear-court"
                type="button"
                onClick={() => clearCourt(court)}
              >
                Clear court
              </button>
            </Show>
          </section>
        )}
      </For>

      <section class="card sitting">
        <span class="info-label">Sitting</span>
        <span>
          {sitting().length ? sitting().map((p) => nameOf(p.id)).join(", ") : "—"}
        </span>
      </section>

      <Show when={notice()}>
        <p class="hint">{notice()}</p>
      </Show>
      <Show when={error()}>
        <p class="err-inline">{error()}</p>
      </Show>

      <div class="rounds-actions">
        <button
          class="secondary"
          type="button"
          disabled={busy() !== null}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          class="secondary"
          type="button"
          disabled={busy() !== null}
          onClick={fillRemaining}
        >
          {busy() === "fill" ? "Filling…" : "Fill remaining"}
        </button>
      </div>
      <div class="rounds-actions">
        <button
          class="primary"
          type="button"
          disabled={busy() !== null}
          onClick={save}
        >
          {busy() === "save" ? "Saving…" : "Save round"}
        </button>
      </div>
    </div>
  );
}
