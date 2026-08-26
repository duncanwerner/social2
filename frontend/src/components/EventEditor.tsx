import { createEffect, createSignal, onCleanup } from "solid-js";
import { For, Show } from "@solidjs/web";
import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { CreatePlayerID } from "../social";
import type { SocialEvent } from "../types";
import {
  blankEvent,
  loadEvent,
  loadRecordRef,
  newEventId,
  saveEvent,
  saveRecordRef,
} from "../event-store";
import { ApiError, createRecord, getRecord, updateRecord } from "../records";
import { isAuthenticated } from "../auth";
import { EventStatus, isFinished } from "../event-status";

const PLAYER_MIN = 0;
const PLAYER_MAX = 40;
const COURT_MIN = 1;
const COURT_MAX = 20;

/**
 * Create or edit a social. Mode is driven by the route param: `/create-event`
 * has no id (create), `/update-event/:id` carries one (edit). Phone-first — the
 * player/court counts are set with a compact stepper, and naming is tucked into
 * an expandable section so the default view stays short.
 */
export function EventEditor() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // `params.id` is undefined on /create-event.
  const editingId = params.id;

  // Guard: bounce to /login (remembering where we were) when not signed in.
  createEffect(
    () => isAuthenticated(),
    (authed) => {
      if (!authed) {
        navigate(`/login?redirect=${encodeURIComponent(location.pathname)}`, {
          replace: true,
        });
      }
    },
  );

  const initial: SocialEvent =
    (editingId ? loadEvent(editingId) : null) ?? blankEvent();

  const [evName, setEvName] = createSignal(initial.metadata.name);
  const [evDate, setEvDate] = createSignal(initial.metadata.date);
  const [evTime, setEvTime] = createSignal(initial.metadata.time ?? "");
  const [evLocation, setEvLocation] = createSignal(initial.metadata.location);
  const [evDescription, setEvDescription] = createSignal(
    initial.metadata.description,
  );

  const [playerNames, setPlayerNames] = createSignal<string[]>(
    initial.players.map((p) => p.name),
  );
  const [courtNames, setCourtNames] = createSignal<string[]>(
    initial.courts.map((c) => c.name ?? ""),
  );
  // Parallel to playerNames by index (index === PlayerID): true = sitting out.
  const [playerDisabled, setPlayerDisabled] = createSignal<boolean[]>(
    initial.players.map((p) => !!p.disabled),
  );

  const [linkedRef, setLinkedRef] = createSignal(
    editingId ? loadRecordRef(editingId) : null,
  );
  // Backend record status (drives the Finish/Reopen control); null until loaded.
  const [recordStatus, setRecordStatus] = createSignal<number | null>(null);
  const [finishing, setFinishing] = createSignal(false);

  // Load the record's status for a synced event being edited.
  void (async () => {
    const ref = editingId ? loadRecordRef(editingId) : null;
    if (!ref || !isAuthenticated()) return;
    try {
      setRecordStatus((await getRecord(ref.id)).status);
    } catch {
      /* offline or gone — leave null; the control stays disabled */
    }
  })();

  // Finish the event (status → Finished) so viewers go read-only and no new
  // sockets open; or reopen it (→ Active). The update broadcasts, so live viewers
  // switch immediately. Same button both ways for symmetry (and testing).
  async function toggleFinished() {
    const ref = linkedRef();
    const current = recordStatus();
    if (!ref || current === null || finishing()) return;
    const next = isFinished(current)
      ? EventStatus.Active
      : EventStatus.Finished;
    setFinishing(true);
    setSync("");
    try {
      const res = await updateRecord({ id: ref.id, status: next });
      setRecordStatus(res.status);
      setSync(isFinished(res.status) ? "Event finished." : "Event reopened.");
    } catch (err) {
      const reason = err instanceof ApiError ? err.message : String(err);
      setSync(`Could not update status — ${reason}`);
    } finally {
      setFinishing(false);
    }
  }
  const [showPlayers, setShowPlayers] = createSignal(false);
  const [showCourts, setShowCourts] = createSignal(false);
  // A freshly-loaded synced event starts "saved"; a brand-new one starts unsaved.
  const [saved, setSaved] = createSignal(linkedRef() !== null);
  const [syncing, setSyncing] = createSignal(false);
  const [sync, setSync] = createSignal("");
  const [copied, setCopied] = createSignal(false);

  // Shareable link for players → the (public) view page. Available once the
  // event is synced to the backend, since it's keyed by the record id.
  const viewUrl = (): string => {
    const ref = linkedRef();
    return ref ? `${window.location.origin}/view/${ref.id}` : "";
  };

  async function copyViewUrl() {
    const url = viewUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the link is still selectable in the field */
    }
  }

  const buttonLabel = () =>
    syncing()
      ? "Saving…"
      : saved()
        ? "Saved ✓"
        : editingId
          ? "Save changes"
          : "Create social";

  type NameSetter = (fn: (prev: string[]) => string[]) => void;

  const resize = (set: NameSetter, n: number, min: number, max: number) => {
    const target = Math.max(min, Math.min(max, Math.floor(n) || 0));
    set((prev) => {
      const next = prev.slice(0, target);
      while (next.length < target) next.push("");
      return next;
    });
    setSaved(false);
  };

  const setNameAt = (set: NameSetter, i: number, value: string) => {
    set((prev) => {
      const next = prev.slice();
      next[i] = value;
      return next;
    });
    setSaved(false);
  };

  // Player count drives two parallel arrays (names + disabled flags); resize both
  // together so index === PlayerID stays true.
  const resizePlayers = (n: number) => {
    const target = Math.max(PLAYER_MIN, Math.min(PLAYER_MAX, Math.floor(n) || 0));
    setPlayerNames((prev) => {
      const next = prev.slice(0, target);
      while (next.length < target) next.push("");
      return next;
    });
    setPlayerDisabled((prev) => {
      const next = prev.slice(0, target);
      while (next.length < target) next.push(false);
      return next;
    });
    setSaved(false);
  };

  const togglePlayerDisabled = (i: number) => {
    setPlayerDisabled((prev) => {
      const next = prev.slice();
      next[i] = !next[i];
      return next;
    });
    setSaved(false);
  };

  // Assemble the event from the form, spreading `base` first so fields the form
  // doesn't edit (rounds/scores/options) are preserved.
  const buildEvent = (base: SocialEvent): SocialEvent => ({
    ...base,
    players: playerNames().map((name, i) => ({
      id: CreatePlayerID(i),
      name: name.trim(),
      ...(playerDisabled()[i] ? { disabled: true } : {}),
    })),
    courts: courtNames().map((name) =>
      name.trim() ? { name: name.trim() } : {},
    ),
    metadata: {
      name: evName().trim(),
      description: evDescription().trim(),
      location: evLocation().trim(),
      date: evDate(),
      time: evTime().trim(),
    },
  });

  // Fetch the current record as the merge base — the live rounds page writes
  // rounds/scores straight to it, so it can be newer than our localStorage copy;
  // merging onto it keeps those from being clobbered. Falls back to local.
  async function freshBase(refId: string): Promise<SocialEvent> {
    try {
      return (await getRecord(refId)).data as SocialEvent;
    } catch {
      return initial; // record gone or offline — keep the local base
    }
  }

  // Explicit save: the "Create social" action for a not-yet-synced event. Creates
  // the backend record (or updates it, if a ref already exists) and navigates to
  // the update page, where edits auto-save from then on.
  async function save() {
    const id = editingId ?? newEventId();
    const existingRef = loadRecordRef(id);

    const base = existingRef && isAuthenticated() ? await freshBase(existingRef.id) : initial;
    const event = buildEvent(base);
    saveEvent(id, event);
    setSaved(true);

    if (isAuthenticated()) {
      setSyncing(true);
      setSync("Syncing…");

      const create = async (channel: string, note: string) => {
        const created = await createRecord({ data: event, channel });
        const ref = { id: created.id, channel: created.channel };
        saveRecordRef(id, ref);
        setLinkedRef(ref);
        setSync(`${note} ${created.id}`);
      };

      try {
        if (existingRef) {
          try {
            const updated = await updateRecord({ id: existingRef.id, data: event });
            setSync(`Updated record ${existingRef.id} (delivered ${updated.delivered})`);
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              await create(existingRef.channel, "Re-created record (previous link was stale)");
            } else {
              throw err;
            }
          }
        } else {
          // The event's local id doubles as its channel on first create.
          await create(id, "Created record");
        }
      } catch (err) {
        const reason = err instanceof ApiError ? err.message : String(err);
        setSync(`Saved locally, but backend sync failed — ${reason}`);
      } finally {
        setSyncing(false);
      }
    }

    if (!editingId) navigate(`/update-event/${id}`);
  }

  // Auto-save: once the event has a backend record, persist edits to it directly
  // (no button). Debounced so a burst of edits becomes one write + one broadcast.
  async function persist(ref: { id: string; channel: string }) {
    if (!editingId || !isAuthenticated()) return;
    setSyncing(true);
    try {
      const event = buildEvent(await freshBase(ref.id));
      saveEvent(editingId, event);
      await updateRecord({ id: ref.id, data: event });
      setSaved(true);
      setSync("");
    } catch (err) {
      const reason = err instanceof ApiError ? err.message : String(err);
      setSync(`Couldn’t save — ${reason}`);
    } finally {
      setSyncing(false);
    }
  }

  const AUTOSAVE_MS = 1000;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAutoSave = () => {
    const ref = linkedRef();
    if (!ref || !isAuthenticated()) return; // brand-new event: wait for Create
    setSaved(false);
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = undefined;
      void persist(ref);
    }, AUTOSAVE_MS);
  };

  // A stable string of every editable field; the effect fires whenever it changes.
  const snapshot = () =>
    JSON.stringify({
      n: evName(),
      d: evDate(),
      t: evTime(),
      l: evLocation(),
      desc: evDescription(),
      p: playerNames(),
      c: courtNames(),
      dis: playerDisabled(),
    });
  const initialSnapshot = snapshot();
  createEffect(snapshot, (snap) => {
    if (snap === initialSnapshot) return; // mount / reverted — nothing to save
    scheduleAutoSave();
  });

  // Flush a pending debounce if the user navigates away mid-edit.
  onCleanup(() => {
    if (autoTimer) {
      clearTimeout(autoTimer);
      const ref = linkedRef();
      if (ref) void persist(ref);
    }
  });

  return (
    <main class="editor">
      <header class="editor-head">
        <div class="editor-nav">
          <button class="link" type="button" onClick={() => navigate("/")}>
            ← Home
          </button>
          {/* Converse of the view page's "Edit event" link: jump to the player
              view once the event has been synced to a record. */}
          <Show when={linkedRef()}>
            <button
              class="link"
              type="button"
              onClick={() => navigate(`/view/${linkedRef()!.id}`)}
            >
              View as player →
            </button>
          </Show>
        </div>
        <h1>{editingId ? "Edit social" : "New social"}</h1>
      </header>

      <section class="card">
        <h2>Details</h2>
        <label class="field">
          <span>Name</span>
          <input
            value={evName()}
            onInput={(e) => {
              setEvName(e.currentTarget.value);
              setSaved(false);
            }}
            placeholder="Saturday morning social"
          />
        </label>
        <div class="field-row">
          <label class="field">
            <span>Date</span>
            <input
              type="date"
              value={evDate()}
              onInput={(e) => {
                setEvDate(e.currentTarget.value);
                setSaved(false);
              }}
            />
          </label>
          <label class="field">
            <span>Time</span>
            <input
              value={evTime()}
              onInput={(e) => {
                setEvTime(e.currentTarget.value);
                setSaved(false);
              }}
              placeholder="11:00 – 1:00"
            />
          </label>
        </div>
        <label class="field">
          <span>Location</span>
          <input
            value={evLocation()}
            onInput={(e) => {
              setEvLocation(e.currentTarget.value);
              setSaved(false);
            }}
            placeholder="Club courts"
          />
        </label>
        <label class="field">
          <span>Description</span>
          <textarea
            rows="2"
            value={evDescription()}
            onInput={(e) => {
              setEvDescription(e.currentTarget.value);
              setSaved(false);
            }}
            placeholder="Optional notes"
          />
        </label>
      </section>

      <section class="card">
        <div class="counter">
          <div class="counter-label">
            <h2>Players</h2>
            <span class="hint">{playerNames().length} in the pool</span>
          </div>
          <div class="stepper">
            <button
              type="button"
              aria-label="Fewer players"
              onClick={() => resizePlayers(playerNames().length - 1)}
            >
              −
            </button>
            <input
              class="stepper-num"
              type="number"
              inputmode="numeric"
              min={PLAYER_MIN}
              max={PLAYER_MAX}
              value={playerNames().length}
              onInput={(e) => resizePlayers(Number(e.currentTarget.value))}
            />
            <button
              type="button"
              aria-label="More players"
              onClick={() => resizePlayers(playerNames().length + 1)}
            >
              +
            </button>
          </div>
        </div>
        <Show when={playerNames().length > 0}>
          <button
            type="button"
            class="disclosure"
            aria-expanded={showPlayers() ? "true" : "false"}
            onClick={() => setShowPlayers(!showPlayers())}
          >
            <span class="chevron">{showPlayers() ? "▾" : "▸"}</span> Manage
            players
          </button>
          <Show when={showPlayers()}>
            <div class="name-grid">
              <For each={playerNames()} keyed={false}>
                {(name, i) => (
                  <div
                    class={
                      playerDisabled()[i]
                        ? "name-field player-out"
                        : "name-field"
                    }
                  >
                    <span class="name-index">{i + 1}</span>
                    <input
                      value={name()}
                      onInput={(e) =>
                        setNameAt(setPlayerNames, i, e.currentTarget.value)
                      }
                      placeholder={`Player ${i + 1}`}
                    />
                    <label
                      class="sit-toggle"
                      title="Sit this player out of the next generated round"
                    >
                      <input
                        type="checkbox"
                        checked={!!playerDisabled()[i]}
                        onChange={() => togglePlayerDisabled(i)}
                      />
                      Sit
                    </label>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>

      <section class="card">
        <div class="counter">
          <div class="counter-label">
            <h2>Courts</h2>
            <span class="hint">{courtNames().length} available</span>
          </div>
          <div class="stepper">
            <button
              type="button"
              aria-label="Fewer courts"
              onClick={() =>
                resize(
                  setCourtNames,
                  courtNames().length - 1,
                  COURT_MIN,
                  COURT_MAX,
                )
              }
            >
              −
            </button>
            <input
              class="stepper-num"
              type="number"
              inputmode="numeric"
              min={COURT_MIN}
              max={COURT_MAX}
              value={courtNames().length}
              onInput={(e) =>
                resize(
                  setCourtNames,
                  Number(e.currentTarget.value),
                  COURT_MIN,
                  COURT_MAX,
                )
              }
            />
            <button
              type="button"
              aria-label="More courts"
              onClick={() =>
                resize(
                  setCourtNames,
                  courtNames().length + 1,
                  COURT_MIN,
                  COURT_MAX,
                )
              }
            >
              +
            </button>
          </div>
        </div>
        <button
          type="button"
          class="disclosure"
          aria-expanded={showCourts() ? "true" : "false"}
          onClick={() => setShowCourts(!showCourts())}
        >
          <span class="chevron">{showCourts() ? "▾" : "▸"}</span> Manage courts
        </button>
        <Show when={showCourts()}>
          <div class="name-grid">
            <For each={courtNames()} keyed={false}>
              {(name, i) => (
                <label class="name-field">
                  <span class="name-index">{i + 1}</span>
                  <input
                    value={name()}
                    onInput={(e) =>
                      setNameAt(setCourtNames, i, e.currentTarget.value)
                    }
                    placeholder={`Court ${i + 1}`}
                  />
                </label>
              )}
            </For>
          </div>
        </Show>
      </section>

      <Show when={linkedRef()}>
        <section class="card share">
          <h2>Share with players</h2>
          <div class="share-row">
            <input
              class="share-url"
              type="text"
              readonly
              value={viewUrl()}
              onClick={(e) => e.currentTarget.select()}
            />
            <button type="button" class="copy-btn" onClick={copyViewUrl}>
              {copied() ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p class="hint">
            Channel <code>{linkedRef()?.channel}</code>
          </p>
        </section>
      </Show>

      <Show when={linkedRef() && recordStatus() !== null}>
        <section class="card status-card">
          <div class="status-row">
            <div class="status-text">
              <h2>{isFinished(recordStatus()!) ? "Finished" : "Active"}</h2>
              <p class="hint">
                {isFinished(recordStatus()!)
                  ? "Viewers are read-only; no live connections open."
                  : "Viewers connect live and see updates as they happen."}
              </p>
            </div>
            <button
              type="button"
              class={isFinished(recordStatus()!) ? "secondary" : "danger"}
              disabled={finishing()}
              onClick={toggleFinished}
            >
              {finishing()
                ? "Saving…"
                : isFinished(recordStatus()!)
                  ? "Reopen"
                  : "Finish event"}
            </button>
          </div>
        </section>
      </Show>

      <Show when={sync()}>
        <p class="hint sync editor-sync">{sync()}</p>
      </Show>

      <div class="action-bar">
        <Show
          when={linkedRef()}
          fallback={
            <button
              class="primary"
              type="button"
              disabled={syncing()}
              onClick={save}
            >
              {buttonLabel()}
            </button>
          }
        >
          {/* Synced event: edits auto-save (debounced) — no button, just status. */}
          <p class="hint autosave-status">
            {syncing() ? "Saving…" : saved() ? "All changes saved ✓" : "Saving…"}
          </p>
        </Show>
      </div>
    </main>
  );
}
