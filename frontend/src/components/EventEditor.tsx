import { createEffect, createSignal } from "solid-js";
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
import { ApiError, createRecord, updateRecord } from "../records";
import { isAuthenticated } from "../auth";

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

  const [linkedRef, setLinkedRef] = createSignal(
    editingId ? loadRecordRef(editingId) : null,
  );
  const [showPlayers, setShowPlayers] = createSignal(false);
  const [showCourts, setShowCourts] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
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

  async function save() {
    const event: SocialEvent = {
      ...initial, // preserve rounds/options when editing
      players: playerNames().map((name, i) => ({
        id: CreatePlayerID(i),
        name: name.trim(),
      })),
      courts: courtNames().map((name) =>
        name.trim() ? { name: name.trim() } : {},
      ),
      metadata: {
        name: evName().trim(),
        description: evDescription().trim(),
        location: evLocation().trim(),
        date: evDate(),
      },
    };
    const id = editingId ?? newEventId();
    saveEvent(id, event);
    setSaved(true);

    // Push to the backend records API (the owner is the signed-in user). Create
    // the record the first time; update it (using the stored ref) thereafter.
    if (isAuthenticated()) {
      setSyncing(true);
      setSync("Syncing…");

      // Create a backend record for this event and remember the link.
      const create = async (channel: string, note: string) => {
        const created = await createRecord({ data: event, channel });
        const ref = { id: created.id, channel: created.channel };
        saveRecordRef(id, ref);
        setLinkedRef(ref);
        setSync(`${note} ${created.id}`);
      };

      try {
        const ref = loadRecordRef(id);
        if (ref) {
          try {
            const updated = await updateRecord({ id: ref.id, data: event });
            setSync(
              `Updated record ${ref.id} (delivered ${updated.delivered})`,
            );
          } catch (err) {
            // The linked record is gone on the backend — self-heal by
            // re-creating it (keeping the same channel).
            if (err instanceof ApiError && err.status === 404) {
              await create(ref.channel, "Re-created record (previous link was stale)");
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

  return (
    <main class="editor">
      <header class="editor-head">
        <button class="link" type="button" onClick={() => navigate("/")}>
          ← Home
        </button>
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
        </div>
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
              onClick={() =>
                resize(
                  setPlayerNames,
                  playerNames().length - 1,
                  PLAYER_MIN,
                  PLAYER_MAX,
                )
              }
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
              onInput={(e) =>
                resize(
                  setPlayerNames,
                  Number(e.currentTarget.value),
                  PLAYER_MIN,
                  PLAYER_MAX,
                )
              }
            />
            <button
              type="button"
              aria-label="More players"
              onClick={() =>
                resize(
                  setPlayerNames,
                  playerNames().length + 1,
                  PLAYER_MIN,
                  PLAYER_MAX,
                )
              }
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
            <span class="chevron">{showPlayers() ? "▾" : "▸"}</span> Name players
          </button>
          <Show when={showPlayers()}>
            <div class="name-grid">
              <For each={playerNames()} keyed={false}>
                {(name, i) => (
                  <label class="name-field">
                    <span class="name-index">{i + 1}</span>
                    <input
                      value={name()}
                      onInput={(e) =>
                        setNameAt(setPlayerNames, i, e.currentTarget.value)
                      }
                      placeholder={`Player ${i + 1}`}
                    />
                  </label>
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
          <span class="chevron">{showCourts() ? "▾" : "▸"}</span> Name courts
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

      <Show when={sync()}>
        <p class="hint sync editor-sync">{sync()}</p>
      </Show>

      <div class="action-bar">
        <button
          class="primary"
          type="button"
          disabled={syncing()}
          onClick={save}
        >
          {buttonLabel()}
        </button>
      </div>
    </main>
  );
}
