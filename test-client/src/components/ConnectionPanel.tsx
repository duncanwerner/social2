import {
  createSignal,
  createEffect,
  onCleanup,
  type Accessor,
  type Setter,
} from "solid-js";
import { For, Show } from "@solidjs/web";
import { wsUrl } from "../api";

type Status = "disconnected" | "connecting" | "open" | "closed";

interface LogEntry {
  id: number;
  kind: "event" | "pong" | "raw" | "system";
  text: string;
  at: string;
}

export function ConnectionPanel(props: {
  baseUrl: Accessor<string>;
  channel: Accessor<string>;
  setChannel: Setter<string>;
}) {
  const [status, setStatus] = createSignal<Status>("disconnected");
  const [detail, setDetail] = createSignal("");
  const [log, setLog] = createSignal<LogEntry[]>([]);
  const [autoPing, setAutoPing] = createSignal(false);

  let ws: WebSocket | null = null;
  let logSeq = 0;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const active = () => status() === "open" || status() === "connecting";

  function addLog(kind: LogEntry["kind"], text: string) {
    const entry: LogEntry = {
      id: ++logSeq,
      kind,
      text,
      at: new Date().toLocaleTimeString(),
    };
    setLog((prev) => [entry, ...prev].slice(0, 200));
  }

  function disconnect() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
    if (ws) {
      try {
        ws.close(1000, "client disconnect");
      } catch {
        /* already closing */
      }
      ws = null;
    }
  }

  function connect() {
    disconnect();
    const url = wsUrl(props.baseUrl(), props.channel());
    setStatus("connecting");
    setDetail(url);

    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      setStatus("closed");
      setDetail(String(err));
      return;
    }
    ws = sock;

    sock.addEventListener("open", () => {
      setStatus("open");
      addLog("system", `connected to "${props.channel()}"`);
    });

    sock.addEventListener("message", (e: MessageEvent) => {
      const data = typeof e.data === "string" ? e.data : "[binary frame]";
      if (data === "pong") {
        addLog("pong", "pong");
        return;
      }
      try {
        addLog("event", JSON.stringify(JSON.parse(data), null, 2));
      } catch {
        addLog("raw", data);
      }
    });

    sock.addEventListener("close", (e: CloseEvent) => {
      setStatus("closed");
      setDetail(`code ${e.code}${e.reason ? ` — ${e.reason}` : ""}`);
      addLog("system", `closed (code ${e.code})`);
      if (ws === sock) ws = null;
    });

    sock.addEventListener("error", () => {
      addLog("system", "socket error");
    });
  }

  function sendPing() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send("ping");
      addLog("system", "sent ping");
    }
  }

  // Manage the auto-ping timer reactively. Solid 2's createEffect takes a
  // tracking function and a separate effect function (value => …).
  createEffect(
    () => autoPing(),
    (enabled) => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
      if (enabled) {
        pingTimer = setInterval(sendPing, 20_000);
      }
    },
  );

  onCleanup(disconnect);

  return (
    <section class="panel">
      <h2>Connection</h2>

      <div class="row">
        <label>Channel</label>
        <input
          value={props.channel()}
          onInput={(e) => props.setChannel(e.currentTarget.value)}
          disabled={active()}
          spellcheck={false}
        />
      </div>

      <div class="row">
        <Show
          when={active()}
          fallback={
            <button class="primary" onClick={connect}>
              Connect
            </button>
          }
        >
          <button onClick={disconnect}>Disconnect</button>
        </Show>
        <button onClick={sendPing} disabled={status() !== "open"}>
          Send ping
        </button>
        <label class="check">
          <input
            type="checkbox"
            checked={autoPing()}
            onChange={(e) => setAutoPing(e.currentTarget.checked)}
          />
          auto-ping 20s
        </label>
        <button onClick={() => setLog([])}>Clear log</button>
      </div>

      <div class={`status status-${status()}`}>
        <strong>{status()}</strong>
        <Show when={detail()}>
          <span class="detail">{detail()}</span>
        </Show>
      </div>

      <ul class="log">
        <For each={log()} fallback={<li class="empty">No messages yet.</li>}>
          {(entry) => (
            <li class={`log-${entry.kind}`}>
              <span class="ts">{entry.at}</span>
              <span class="tag">{entry.kind}</span>
              <pre>{entry.text}</pre>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
