import { BACKEND_URL, wsUrl } from "./api";

// Typed client for the backend's `/connect?channel=` WebSocket.
//
// The socket is RECEIVE-ONLY for application data: the server pushes frames, and
// mutations happen over HTTP. The only frame the client sends is the literal text
// `"ping"` keepalive, which the Durable Object answers with `"pong"` via
// setWebSocketAutoResponse — without waking (or billing) the hibernating DO.
//
// Framework-agnostic on purpose (no Solid imports) so any component can drive it.
// `onEvent` receives the parsed JSON frame as `unknown`; callers narrow it (e.g.
// `isRecordUpdate` in protocol.ts).

export type SocketStatus =
  | "disconnected"
  | "connecting"
  | "open"
  | "closed";

export interface SocketOptions {
  channel: string;
  /** HTTP base URL of the backend; defaults to BACKEND_URL. */
  base?: string;
  /** Called with each parsed (non-keepalive) frame. Narrow it in the callback. */
  onEvent?: (message: unknown) => void;
  /** Called whenever the connection status changes. */
  onStatus?: (status: SocketStatus, detail?: string) => void;
  /** Keepalive ping interval in ms (default 20s). Set 0 to disable. */
  pingIntervalMs?: number;
  /** Auto-reconnect (capped exponential backoff) on unexpected close. */
  reconnect?: boolean;
}

export interface SocketClient {
  connect(): void;
  close(): void;
  status(): SocketStatus;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function createSocket(opts: SocketOptions): SocketClient {
  const base = opts.base ?? BACKEND_URL;
  const pingMs = opts.pingIntervalMs ?? 20_000;

  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = RECONNECT_MIN_MS;
  let manuallyClosed = false;
  let currentStatus: SocketStatus = "disconnected";

  function setStatus(status: SocketStatus, detail?: string) {
    currentStatus = status;
    opts.onStatus?.(status, detail);
  }

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
  }

  function startPing() {
    if (pingMs <= 0) return;
    clearPing();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, pingMs);
  }

  function scheduleReconnect() {
    if (!opts.reconnect || manuallyClosed || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, delay);
  }

  function open() {
    const url = wsUrl(base, opts.channel);
    setStatus("connecting", url);

    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      setStatus("closed", String(err));
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.addEventListener("open", () => {
      backoff = RECONNECT_MIN_MS; // reset after a successful connection
      setStatus("open");
      startPing();
    });

    sock.addEventListener("message", (e: MessageEvent) => {
      const data = typeof e.data === "string" ? e.data : null;
      if (data === null || data === "pong") return; // keepalive / ignore binary
      try {
        opts.onEvent?.(JSON.parse(data));
      } catch {
        /* non-JSON frame — ignore */
      }
    });

    sock.addEventListener("close", (e: CloseEvent) => {
      clearPing();
      setStatus("closed", `code ${e.code}${e.reason ? ` — ${e.reason}` : ""}`);
      if (ws === sock) ws = null;
      scheduleReconnect();
    });

    sock.addEventListener("error", () => {
      setStatus("closed", "socket error");
      // A close event usually follows; reconnect is scheduled there.
    });
  }

  function connect() {
    close();
    manuallyClosed = false;
    backoff = RECONNECT_MIN_MS;
    open();
  }

  function close() {
    manuallyClosed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    clearPing();
    if (ws) {
      try {
        ws.close(1000, "client disconnect");
      } catch {
        /* already closing */
      }
      ws = null;
    }
    if (currentStatus !== "disconnected") setStatus("disconnected");
  }

  return { connect, close, status: () => currentStatus };
}
