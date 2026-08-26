import { createSignal, onCleanup } from "solid-js";
import { Show } from "@solidjs/web";
import {
  useLocation,
  useNavigate,
  useParams,
  type RouteSectionProps,
} from "@solidjs/router";
import { getRecord, updateRecord } from "../../records";
import { findLocalIdForRecord } from "../../event-store";
import { ApiError } from "../../api-error";
import { createSocket, type SocketClient } from "../../socket";
import { isRecordUpdate } from "../../protocol";
import { isFinished } from "../../event-status";
import { ErrorView } from "../../components/ErrorView";
import { ViewContext, type ViewConnection, type ViewLive } from "../../view-live";
import type { SocialEvent } from "../../types";

// Layout for /view/:id/*. Loads the record once (public GET); if the event isn't
// finished, subscribes to its channel for live updates. Shares the reactive event
// with the child pages (info / rounds / stats) via ViewContext.
export default function ViewLayout(props: RouteSectionProps) {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [event, setEvent] = createSignal<SocialEvent | null>(null);
  const [eventStatus, setEventStatus] = createSignal(0);
  const [connection, setConnection] = createSignal<ViewConnection>("loading");
  const [error, setError] = createSignal<string | null>(null);
  const [isOwner, setIsOwner] = createSignal(false);

  let client: SocketClient | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    client?.close();
  });

  void (async () => {
    try {
      const record = await getRecord(params.id);
      if (disposed) return;
      setEvent(record.data as SocialEvent);
      setEventStatus(record.status);
      setIsOwner(record.owner === true);

      if (isFinished(record.status)) {
        setConnection("static"); // no updates will ever come
        return;
      }

      client = createSocket({
        channel: record.channel,
        reconnect: true,
        onStatus: (s) => setConnection(s),
        onEvent: (msg) => {
          if (!isRecordUpdate(msg)) return;
          setEvent(msg.record.data as SocialEvent);
          setEventStatus(msg.record.status);
          if (isFinished(msg.record.status)) {
            client?.close();
            setConnection("static");
          }
        },
      });
      if (disposed) {
        client.close();
        return;
      }
      client.connect();
    } catch (err) {
      if (disposed) return;
      setError(err instanceof ApiError && err.status === 404 ? "not_found" : "error");
    }
  })();

  // Owner-only: optimistically update, then persist (which broadcasts to all
  // viewers). The broadcast echo re-applies the same value (idempotent).
  async function save(next: SocialEvent) {
    setEvent(next);
    await updateRecord({ id: params.id, data: next });
  }

  const live: ViewLive = {
    event,
    eventStatus,
    connection,
    recordId: params.id,
    isOwner,
    save,
  };

  // If this browser holds the local copy that created the record, the owner can
  // jump back to the editor (keyed by local id). Missing → no edit link shown.
  const editLocalId = findLocalIdForRecord(params.id);

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
              <Show when={isOwner() && editLocalId}>
                <button
                  type="button"
                  class="link edit-link"
                  onClick={() => navigate(`/update-event/${editLocalId}`)}
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
                <span class="tab-icon" aria-hidden="true">👑</span>
                <span class="tab-label">Stats</span>
              </button>
            </nav>
          </div>
        </ViewContext>
      </Show>
    </Show>
  );
}
