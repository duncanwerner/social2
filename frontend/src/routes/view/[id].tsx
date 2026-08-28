import { createEffect, createSignal } from "solid-js";
import { Show } from "@solidjs/web";
import {
  useLocation,
  useNavigate,
  useParams,
  type RouteSectionProps,
} from "@solidjs/router";
import { getRecord, submitScore, updateRecord } from "../../records";
import { ApiError } from "../../api-error";
import { createSocket, type SocketClient } from "../../socket";
import { isRecordUpdate, isScoreProposed } from "../../protocol";
import { isFinished } from "../../event-status";
import { ErrorView } from "../../components/ErrorView";
import {
  overlayProvisional,
  ViewContext,
  type ProvisionalScores,
  type ViewConnection,
  type ViewLive,
} from "../../view-live";
import type { SocialEvent } from "../../types";

// Layout for /view/:id/*. Loads the record (public GET) keyed on the id; if the
// event isn't finished, subscribes to its channel for live updates. Re-loads and
// re-subscribes if the id changes while mounted. Shares the reactive event with
// the child pages (info / rounds / stats) via ViewContext.
export default function ViewLayout(props: RouteSectionProps) {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [event, setEvent] = createSignal<SocialEvent | null>(null);
  const [provisional, setProvisional] = createSignal<ProvisionalScores>({});
  const [eventStatus, setEventStatus] = createSignal(0);
  const [connection, setConnection] = createSignal<ViewConnection>("loading");
  const [error, setError] = createSignal<string | null>(null);
  const [isOwner, setIsOwner] = createSignal(false);

  // The owner-authoritative event with provisional player scores overlaid, for
  // display. `event()` stays raw for owner saves and persisted-score comparisons.
  const mergedEvent = (): SocialEvent | null => {
    const ev = event();
    return ev ? overlayProvisional(ev, provisional()) : null;
  };

  // Load the record and (unless finished) subscribe to its channel — keyed on the
  // record id. The router keeps this layout mounted when navigating /view/A →
  // /view/B (it just updates the param), so the load/subscribe re-runs on id
  // change: the returned cleanup tears down A's socket before B loads, and the
  // `cancelled` flag drops any in-flight A response that resolves after we've
  // moved on. (Solid 2 effects return their cleanup — onCleanup isn't valid here.)
  createEffect(
    () => params.id,
    (id) => {
      let cancelled = false;
      let client: SocketClient | undefined;
      // Reset to the loading state for the new id.
      setEvent(null);
      setProvisional({});
      setError(null);
      setIsOwner(false);
      setConnection("loading");

      void (async () => {
        try {
          const record = await getRecord(id);
          if (cancelled) return;
          setEvent(record.data as SocialEvent);
          setProvisional(record.player_scores ?? {});
          setEventStatus(record.status);
          setIsOwner(record.owner === true);

          if (isFinished(record.status)) {
            setConnection("static"); // no updates will ever come
            return;
          }

          client = createSocket({
            channel: record.channel,
            reconnect: true,
            onStatus: (s) => {
              if (!cancelled) setConnection(s);
            },
            onEvent: (msg) => {
              if (cancelled) return;
              if (isScoreProposed(msg)) {
                // Patch the single matchup's provisional score live.
                setProvisional((prev) => ({
                  ...prev,
                  [msg.matchupId]: msg.score,
                }));
                return;
              }
              if (!isRecordUpdate(msg)) return;
              setEvent(msg.record.data as SocialEvent);
              // Re-seed the overlay from the record (an owner save may have
              // confirmed/pruned provisional entries).
              setProvisional(msg.record.player_scores ?? {});
              setEventStatus(msg.record.status);
              if (isFinished(msg.record.status)) {
                client?.close();
                setConnection("static");
              }
            },
          });
          if (cancelled) {
            client.close();
            return;
          }
          client.connect();
        } catch (err) {
          if (cancelled) return;
          setError(
            err instanceof ApiError && err.status === 404 ? "not_found" : "error",
          );
        }
      })();

      return () => {
        cancelled = true;
        client?.close();
      };
    },
  );

  // Owner-only: optimistically update, then persist (which broadcasts to all
  // viewers). The broadcast echo re-applies the same value (idempotent).
  async function save(next: SocialEvent) {
    setEvent(next);
    await updateRecord({ id: params.id, data: next });
  }

  // Any viewer: submit a provisional score for one matchup. Optimistically patch
  // the overlay so the submitter sees it immediately; the broadcast echo re-applies
  // the same value (idempotent).
  async function submit(matchupId: string, score: [number, number]) {
    setProvisional((prev) => ({ ...prev, [matchupId]: score }));
    await submitScore({ id: params.id, matchupId, score });
  }

  const live: ViewLive = {
    event,
    mergedEvent,
    provisional,
    eventStatus,
    connection,
    // Getter so consumers read the current id even if the layout is reused
    // across ids (see the load effect above).
    get recordId() {
      return params.id;
    },
    isOwner,
    save,
    submitScore: submit,
  };

  const base = () => `/view/${params.id}`;
  const isActive = (suffix: "" | "/rounds" | "/stats") =>
    location.pathname.replace(/\/$/, "") === base() + suffix;

  const pill = (): { label: string; cls: string } => {
    // A finished event is terminal — show "Finished" regardless of the socket's
    // transient state (closing the socket on the finish broadcast briefly reports
    // "closed" before it settles).
    if (isFinished(eventStatus())) {
      return { label: "Finished", cls: "pill-finished" };
    }
    switch (connection()) {
      case "open":
        return { label: "Live", cls: "pill-live" };
      case "static":
        return { label: "Finished", cls: "pill-finished" };
      case "connecting":
      case "loading":
        return { label: "Connecting…", cls: "pill-wait" };
      default:
        return { label: "Reconnecting…", cls: "pill-wait" };
    }
  };

  return (
    <Show
      when={!error()}
      fallback={
        <ErrorView
          title="Event not found"
          message="This link doesn’t point to an event. Check the link and try again."
        />
      }
    >
      <Show when={event()} fallback={<div class="view-loading">Loading…</div>}>
        <ViewContext value={live}>
          <div class="view">
            <div class="view-status">
              <Show when={isOwner()}>
                <button
                  type="button"
                  class="link edit-link"
                  onClick={() => navigate(`/update-event/${params.id}`)}
                >
                  Edit event
                </button>
              </Show>
              <span class={`pill ${pill().cls}`}>{pill().label}</span>
            </div>
            <div class="view-body">{props.children}</div>
            <nav class="tab-bar">
              <button
                type="button"
                class={isActive("") ? "tab active" : "tab"}
                onClick={() => navigate(base())}
              >
                <span class="tab-icon" aria-hidden="true">🏠</span>
                <span class="tab-label">Info</span>
              </button>
              <button
                type="button"
                class={isActive("/rounds") ? "tab active" : "tab"}
                onClick={() => navigate(base() + "/rounds")}
              >
                <span class="tab-icon" aria-hidden="true">🎾</span>
                <span class="tab-label">Rounds</span>
              </button>
              <button
                type="button"
                class={isActive("/stats") ? "tab active" : "tab"}
                onClick={() => navigate(base() + "/stats")}
              >
                <span class="tab-icon" aria-hidden="true">🏆</span>
                <span class="tab-label">Stats</span>
              </button>
            </nav>
          </div>
        </ViewContext>
      </Show>
    </Show>
  );
}
