import { DurableObject } from "cloudflare:workers";
import type { Env, OutboundMessage } from "./types";

/**
 * One instance per channel (addressed by `idFromName(channel)`).
 *
 * Holds the live WebSocket connections for its channel and fans out events to
 * them. Uses the **hibernation** API (`acceptWebSocket` + the `webSocket*`
 * handler methods) so the object can be evicted from memory between events —
 * idle connections cost nothing.
 */
export class ChannelHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer client keepalive "ping" with "pong" automatically, without waking
    // (and therefore without billing) the Durable Object.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  /** WebSocket upgrades are routed here by the Worker via `stub.fetch(request)`. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable accept: the runtime keeps the socket open even if this DO is
    // evicted, and re-instantiates us to deliver messages.
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Broadcast an event to every socket on this channel. Called via RPC from the
   * Worker after the event has been persisted to D1. Returns the delivery count.
   */
  async broadcast(message: OutboundMessage): Promise<number> {
    const data = JSON.stringify(message);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
        delivered++;
      } catch {
        // Socket is going away mid-send; drop it.
        try {
          ws.close(1011, "send failed");
        } catch {
          /* already closed */
        }
      }
    }
    return delivered;
  }

  // Push-only model: inbound client frames are ignored. (Keepalive "ping" is
  // handled by the auto-response above and never reaches this handler.)
  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  override webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    try {
      // Complete the closing handshake. 1005/1006 cannot be set manually, so
      // fall back to a normal closure code.
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
    } catch {
      /* already closed */
    }
  }

  override webSocketError(_ws: WebSocket, _error: unknown): void {
    // The runtime follows an error with webSocketClose; nothing to do here.
  }
}
