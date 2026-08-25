import { createSignal, untrack, type Accessor } from "solid-js";
import { Show } from "@solidjs/web";
import { publish } from "../api";
import type { PublishResponse } from "../types";

export function PublishPanel(props: {
  baseUrl: Accessor<string>;
  channel: Accessor<string>;
}) {
  // One-time snapshot of the connected channel to seed the field.
  const [pubChannel, setPubChannel] = createSignal(untrack(props.channel));
  const [type, setType] = createSignal("update");
  const [payload, setPayload] = createSignal('{\n  "hello": "world"\n}');
  const [result, setResult] = createSignal<PublishResponse | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function send() {
    setError("");
    setResult(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload());
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }

    setBusy(true);
    try {
      const res = await publish(props.baseUrl(), {
        channel: pubChannel().trim(),
        type: type().trim() || null,
        payload: parsed,
      });
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="panel">
      <h2>Publish</h2>

      <div class="row">
        <label>Channel</label>
        <input
          value={pubChannel()}
          onInput={(e) => setPubChannel(e.currentTarget.value)}
          spellcheck={false}
        />
        <button class="link" onClick={() => setPubChannel(props.channel())}>
          use connected
        </button>
      </div>

      <div class="row">
        <label>Type</label>
        <input
          value={type()}
          onInput={(e) => setType(e.currentTarget.value)}
          placeholder="(optional)"
          spellcheck={false}
        />
      </div>

      <div class="row col">
        <label>Payload (JSON)</label>
        <textarea
          rows={8}
          value={payload()}
          onInput={(e) => setPayload(e.currentTarget.value)}
          spellcheck={false}
        />
      </div>

      <div class="row">
        <button class="primary" onClick={send} disabled={busy()}>
          {busy() ? "Sending…" : "Publish"}
        </button>
        <span class="hint">
          Delivery reaches this tab only if it's connected to the same channel.
        </span>
      </div>

      <Show when={result()}>
        {(r) => (
          <pre class="ok">
            delivered: {r().delivered} · id: {r().id} · {r().created_at}
          </pre>
        )}
      </Show>
      <Show when={error()}>
        <pre class="err">{error()}</pre>
      </Show>
    </section>
  );
}
