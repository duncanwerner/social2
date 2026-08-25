import { createSignal, type Accessor, type Setter } from "solid-js";
import { Show } from "@solidjs/web";
import { health } from "../api";

export function SettingsBar(props: {
  baseUrl: Accessor<string>;
  setBaseUrl: Setter<string>;
}) {
  const [result, setResult] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function check() {
    setError("");
    setResult("");
    setBusy(true);
    try {
      const r = await health(props.baseUrl());
      setResult(`ok · ${r.ms}ms`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="settings">
      <label>Backend base URL</label>
      <input
        class="grow"
        value={props.baseUrl()}
        onInput={(e) => props.setBaseUrl(e.currentTarget.value)}
        spellcheck={false}
      />
      <button onClick={check} disabled={busy()}>
        {busy() ? "…" : "Check health"}
      </button>
      <Show when={result()}>
        <span class="ok-inline">{result()}</span>
      </Show>
      <Show when={error()}>
        <span class="err-inline">{error()}</span>
      </Show>
    </section>
  );
}
