import { ChannelHub } from "./channel-hub";
import { insertEvent, recentEvents } from "./db";
import type { Env, PublishRequest } from "./types";

// The Durable Object class must be exported from the Worker entry point.
export { ChannelHub };

/** Allowed channel names: url/path-safe, 1–128 chars. */
const CHANNEL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (pathname === "/healthz") {
        return json({ ok: true });
      }
      if (pathname === "/connect") {
        return handleConnect(request, env, url);
      }
      if (pathname === "/publish" && request.method === "POST") {
        return handlePublish(request, env);
      }
      if (pathname === "/history" && request.method === "GET") {
        return handleHistory(env, url);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "internal", message: String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** GET /connect?channel=<name> — upgrade to a WebSocket on the channel's DO. */
async function handleConnect(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return json({ error: "expected_websocket_upgrade" }, 426);
  }
  const channel = url.searchParams.get("channel");
  if (!channel || !CHANNEL_RE.test(channel)) {
    return json({ error: "invalid_channel" }, 400);
  }

  // AUTH HOOK: validate a connection token here before upgrading.

  const stub = env.CHANNEL_HUB.get(env.CHANNEL_HUB.idFromName(channel));
  return stub.fetch(request);
}

/** POST /publish — persist an event to D1, then broadcast to the channel. */
async function handlePublish(request: Request, env: Env): Promise<Response> {
  // AUTH HOOK: validate a publish token here.

  let body: PublishRequest;
  try {
    body = (await request.json()) as PublishRequest;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const channel = body?.channel;
  if (!channel || !CHANNEL_RE.test(channel)) {
    return json({ error: "invalid_channel" }, 400);
  }
  if (body.payload === undefined) {
    return json({ error: "missing_payload" }, 400);
  }

  const type = typeof body.type === "string" ? body.type : null;
  const record = await insertEvent(env, {
    channel,
    type,
    payload: JSON.stringify(body.payload),
  });

  const stub = env.CHANNEL_HUB.get(env.CHANNEL_HUB.idFromName(channel));
  const delivered = await stub.broadcast({
    id: record.id,
    channel,
    type,
    payload: body.payload,
    created_at: record.created_at,
  });

  return json({ id: record.id, created_at: record.created_at, delivered });
}

/** GET /history?channel=<name>&limit=<n> — recent persisted events. */
async function handleHistory(env: Env, url: URL): Promise<Response> {
  const channel = url.searchParams.get("channel");
  if (!channel || !CHANNEL_RE.test(channel)) {
    return json({ error: "invalid_channel" }, 400);
  }
  const requested = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.trunc(requested)), 200)
    : 50;

  const events = await recentEvents(env, channel, limit);
  return json({ channel, events });
}
