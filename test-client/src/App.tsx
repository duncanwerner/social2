import { createSignal } from "solid-js";
import { SettingsBar } from "./components/SettingsBar";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { PublishPanel } from "./components/PublishPanel";
import { HistoryPanel } from "./components/HistoryPanel";

export function App() {
  const [baseUrl, setBaseUrl] = createSignal("http://localhost:8787");
  const [channel, setChannel] = createSignal("demo");

  return (
    <div class="app">
      <header>
        <h1>do-sockets test client</h1>
        <p class="sub">
          Exercise the Cloudflare Workers + Durable Objects + D1 backend.
        </p>
      </header>

      <SettingsBar baseUrl={baseUrl} setBaseUrl={setBaseUrl} />

      <div class="grid">
        <ConnectionPanel
          baseUrl={baseUrl}
          channel={channel}
          setChannel={setChannel}
        />
        <PublishPanel baseUrl={baseUrl} channel={channel} />
        <HistoryPanel baseUrl={baseUrl} channel={channel} />
      </div>

      <footer>
        Single active WebSocket per tab &mdash; open this page in another tab on a
        different channel to watch channel isolation.
      </footer>
    </div>
  );
}
