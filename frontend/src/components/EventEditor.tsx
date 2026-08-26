import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { For, Show } from "@solidjs/web";
import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { CreatePlayerID } from "../social";
import type { SocialEvent } from "../types";
import { ApiError, createRecord, getRecord, updateRecord } from "../records";
import { isAuthenticated } from "../auth";
import { EventStatus, isFinished } from "../event-status";
import { ErrorView } from "./ErrorView";

const PLAYER_MIN = 0;
const PLAYER_MAX = 40;
const COURT_MIN = 1;
const COURT_MAX = 20;

/** A blank event for the create form: a realistic default roster to tweak. */
function blankEvent(): SocialEvent {
  return {
    players: Array.from({ length: 8 }, (_, i) => ({
      id: CreatePlayerID(i),
      name: "",
    })),
    courts: Array.from({ length: 2 }, () => ({})),
    metadata: { name: "", description: "", location: "", date: "", time: "" },
  };
}

/**
 * Create or edit a social. Mode is driven by the route param: `/create-event`
 * has no id (create mode — a blank form), `/update-event/:id` carries the
 * **backend record id** (edit mode — the form is seeded from the fetched record).
 *
 * This outer component handles the auth guard and, in edit mode, the async load
 * of the record; the form itself (`EventEditorForm`) mounts only once its seed
 * data is ready, so its signals can be seeded synchronously as before.
 */
export function EventEditor() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // Snapshotted at mount: the record id in edit mode, undefined in create mode.
  // The /update-event/:id route keys EventEditor on the id, so this never changes
  // under us — a different id forces a fresh mount.
  const recordId = untrack(() => params.id);

  // Guard: bounce to /login (remembering where we were) when not signed in.
  createEffect(
    () => isAuthenticated(),
    (authed) => {
      if (authed) return;
      const from = untrack(() => location.pathname);
      // Defer the navigate: calling it inside the effect callback runs during the
      // in-progress flush (a no-op flush warning); a microtask redirects cleanly.
      queueMicrotask(() =>
        navigate(`/login?redirect=${encodeURIComponent(from)}`, {
          replace: true,
        }),
      );
    },
  );

  // Create mode: seed synchronously from a blank event and render immediately.
  if (!recordId) {
    return (
      <EventEditorForm initial={blankEvent()} recordId={undefined} channel={undefined} status={null} />
    );
  }

  // Edit mode: fetch the record, then render the form seeded from it. `get-event`
  // is public but returns `owner: true` only for our token — a non-owner is sent
  // to the read-only view. (Not signed in → the guard above redirects to /login,
  // so we don't start the load in that case.)
  const [seed, setSeed] = createSignal<{
    initial: SocialEvent;
    channel: string;
    status: number;
  } | null>(null);
  const [failed, setFailed] = createSignal(false);

  if (untrack(isAuthenticated)) {
    void (async () => {
      try {
        const record = await getRecord(recordId);
        if (record.owner !== true) {
          navigate(`/view/${recordId}`, { replace: true });
          return;
        }
        setSeed({
          initial: record.data as SocialEvent,
          channel: record.channel,
          status: record.status,
        });
      } catch {
        setFailed(true);
      }
    })();
  }

  return (
    <Show
      when={!failed()}
      fallback={
        <ErrorView
          title="Event not found"
          message="This link doesn’t point to an event you own."
        />
      }
    >
      <Show when={seed()} fallback={<div class="view-loading">Loading…</div>}>
        {(s) => (
          <EventEditorForm
            initial={s().initial}
            recordId={recordId}
            channel={s().channel}
            status={s().status}
          />
        )}
      </Show>
    </Show>
  );
}

interface EventEditorFormProps {
  /** Seed data for the form (a blank event in create mode, the record's data in edit mode). */
  initial: SocialEvent;
  /** The backend record id in edit mode; undefined in create mode. */
  recordId: string | undefined;
  /** The record's channel in edit mode; undefined in create mode. */
  channel: string | undefined;
  /** The record's status in edit mode; null in create mode. */
  status: number | null;
}

function EventEditorForm(props: EventEditorFormProps) {
  const navigate = useNavigate();
  // Read once at setup to seed the form; the form is remounted per record, so
  // these props are stable for this instance. Untracked: props are reactive
  // getters, and a bare read outside a tracking scope trips STRICT_READ_UNTRACKED.
  const initial = untrack(() => props.initial);
  const recordId = untrack(() => props.recordId);
  const channel = untrack(() => props.channel);
  const status = untrack(() => props.status);
  const editing = recordId !== undefined;

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

  // The backend record this form is bound to (null until a create succeeds).
  const [linkedRef, setLinkedRef] = createSignal<{ id: string; channel: string } | null>(
    recordId ? { id: recordId, channel: channel! } : null,
  );
  // Backend record status (drives the Finish/Reopen control); null in create mode.
  const [recordStatus, setRecordStatus] = createSignal<number | null>(status);
  const [finishing, setFinishing] = createSignal(false);

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
  const [saved, setSaved] = createSignal(untrack(linkedRef) !== null);
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
        : editing
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
  // rounds/scores straight to it, so it can be newer than the copy we seeded
  // from; merging onto it keeps those from being clobbered. Falls back to `initial`.
  async function freshBase(refId: string): Promise<SocialEvent> {
    try {
      return (await getRecord(refId)).data as SocialEvent;
    } catch {
      return initial; // record gone or offline — keep the seed base
    }
  }

  // Explicit save: the "Create social" action for a brand-new event. Mints a
  // channel, creates the backend record, and navigates to the update page (keyed
  // by the new record id), where edits auto-save from then on.
  async function save() {
    const event = buildEvent(initial);
    setSaved(true);
    if (!isAuthenticated()) return; // guard will redirect; nothing to sync

    setSyncing(true);
    setSync("Syncing…");
    try {
      // A fresh channel for the record's live socket (url/path-safe uuid).
      const created = await createRecord({ data: event, channel: crypto.randomUUID() });
      setLinkedRef({ id: created.id, channel: created.channel });
      setRecordStatus(created.status);
      navigate(`/update-event/${created.id}`);
    } catch (err) {
      const reason = err instanceof ApiError ? err.message : String(err);
      setSync(`Could not create — ${reason}`);
    } finally {
      setSyncing(false);
    }
  }

  // Auto-save: once the event has a backend record, persist edits to it directly
  // (no button). Debounced so a burst of edits becomes one write + one broadcast.
  async function persist(ref: { id: string; channel: string }) {
    if (!editing || !isAuthenticated()) return;
    setSyncing(true);
    try {
      const event = buildEvent(await freshBase(ref.id));
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
    // Runs from the autosave effect (a non-tracking scope); read current values.
    const ref = untrack(linkedRef);
    if (!ref || !untrack(isAuthenticated)) return; // brand-new event: wait for Create
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
  // Untracked: a one-time capture of the form's initial serialized state. The
  // effect below compares against it to skip the mount fire (and reverts).
  const initialSnapshot = untrack(snapshot);
  createEffect(snapshot, (snap) => {
    if (snap === initialSnapshot) return; // mount / reverted — nothing to save
    scheduleAutoSave();
  });

  // Flush a pending debounce if the user navigates away mid-edit.
  onCleanup(() => {
    if (autoTimer) {
      clearTimeout(autoTimer);
      const ref = untrack(linkedRef);
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
        <h1>{editing ? "Edit social" : "New social"}</h1>
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
