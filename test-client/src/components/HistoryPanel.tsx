import { createSignal, untrack, type Accessor } from "solid-js";
import { For, Show } from "@solidjs/web";
import { getHistory } from "../api";
import type { EventRecord } from "../types";

export function HistoryPanel(props: {
  baseUrl: Accessor<string>;
  channel: Accessor<string>;
}) {
  // One-time snapshot of the connected channel to seed the field.
  const [histChannel, setHistChannel] = createSignal(untrack(props.channel));
  const [limit, setLimit] = createSignal(50);
  const [events, setEvents] = createSignal<EventRecord[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);

  async function load() {
    setError("");
    setBusy(true);
    try {
      const res = await getHistory(props.baseUrl(), histChannel().trim(), limit());
      setEvents(res.events);
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="panel">
      <h2>History</h2>

      <div class="row">
        <label>Channel</label>
        <input
          value={histChannel()}
          onInput={(e) => setHistChannel(e.currentTarget.value)}
          spellcheck={false}
        />
        <label>Limit</label>
        <input
          class="narrow"
          type="number"
          min="1"
          max="200"
          value={limit()}
          onInput={(e) => setLimit(Number(e.currentTarget.value) || 50)}
        />
        <button class="primary" onClick={load} disabled={busy()}>
          {busy() ? "Loading…" : "Fetch"}
        </button>
      </div>

      <Show when={error()}>
        <pre class="err">{error()}</pre>
      </Show>

      <ul class="events">
        <For
          each={events()}
          fallback={
            <Show when={loaded()}>
              <li class="empty">No events.</li>
            </Show>
          }
        >
          {(ev) => (
            <li>
              <div class="ev-head">
                <span class="tag">#{ev.id}</span>
                <span>{ev.type ?? "—"}</span>
                <span class="ts">{ev.created_at}</span>
              </div>
              <pre>{JSON.stringify(ev.payload, null, 2)}</pre>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
