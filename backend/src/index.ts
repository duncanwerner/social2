import {
  generateToken,
  hashToken,
  verifyPassword,
} from "./auth";
import { ChannelHub } from "./channel-hub";
import {
  deleteSession,
  getRecord,
  getSession,
  getUserById,
  getUserByUsername,
  insertEvent,
  insertRecord,
  insertSession,
  recentEvents,
  updateRecord,
} from "./db";
import type {
  CreateEventRequest,
  Env,
  LoginRequest,
  PublicRecord,
  PublishRequest,
  RecordEntity,
  UpdateEventRequest,
  User,
} from "./types";

// A fixed, valid-format hash to verify against when a username doesn't exist, so
// login still runs PBKDF2 and timing doesn't reveal whether an account exists.
// (The password can never match; base64 parts are valid so verification runs.)
const DUMMY_HASH = "pbkdf2$sha256$210000$c2FsdA==$aGFzaA==";

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

/**
 * Resolve the caller's user from an `Authorization: Bearer <token>` header, or
 * null if there is no valid, unexpired session.
 */
async function authenticate(request: Request, env: Env): Promise<User | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  const session = await getSession(env, await hashToken(match[1]));
  if (!session) return null;
  return getUserById(env, session.user_id);
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
      if (pathname === "/login" && request.method === "POST") {
        return handleLogin(request, env);
      }
      if (pathname === "/logout" && request.method === "POST") {
        return handleLogout(request, env);
      }
      if (pathname === "/me" && request.method === "GET") {
        return handleMe(request, env);
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
      if (pathname === "/create-event" && request.method === "POST") {
        return handleCreateEvent(request, env);
      }
      if (pathname === "/get-event" && request.method === "GET") {
        return handleGetEvent(request, env, url);
      }
      if (pathname === "/update-event" && request.method === "POST") {
        return handleUpdateEvent(request, env);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "internal", message: String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** POST /login {username, password} — issue a session token on success. */
async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: LoginRequest;
  try {
    body = (await request.json()) as LoginRequest;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof body?.username !== "string" || typeof body?.password !== "string") {
    return json({ error: "invalid_credentials" }, 401);
  }

  const user = await getUserByUsername(env, body.username);
  // Always run a verification so timing doesn't reveal whether the user exists.
  const ok = await verifyPassword(body.password, user?.password ?? DUMMY_HASH);
  if (!user || !ok) {
    return json({ error: "invalid_credentials" }, 401);
  }

  const token = generateToken();
  await insertSession(env, {
    token_hash: await hashToken(token),
    user_id: user.id,
  });
  return json({ token, user: { id: user.id, username: user.username } });
}

/** POST /logout — revoke the caller's session token. */
async function handleLogout(request: Request, env: Env): Promise<Response> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (match) {
    await deleteSession(env, await hashToken(match[1]));
  }
  return json({ ok: true });
}

/** GET /me — the current user, or 401. */
async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await authenticate(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  return json({ user: { id: user.id, username: user.username } });
}

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

  // AUTH HOOK: viewers connect without auth (public read model). Browsers can't
  // set headers on a WS upgrade, so gating this later means a `?token=` param.

  const stub = env.CHANNEL_HUB.get(env.CHANNEL_HUB.idFromName(channel));
  return stub.fetch(request);
}

/** POST /publish — persist an event to D1, then broadcast to the channel. */
async function handlePublish(request: Request, env: Env): Promise<Response> {
  // AUTH HOOK: left open (legacy pub/sub demo, separate from records). Add
  // `authenticate()` here to require a session for publishing.

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

/**
 * Client-facing view of a record. `ownerid` is owner-only and write-only — never
 * returned to callers or broadcast to viewers.
 */
function publicRecord(record: RecordEntity): PublicRecord {
  return {
    id: record.id,
    status: record.status,
    data: record.data,
    channel: record.channel,
    created_at: record.created_at,
  };
}

/** POST /create-event — persist a new record owned by the authenticated user. */
async function handleCreateEvent(
  request: Request,
  env: Env,
): Promise<Response> {
  // AUTH HOOK: the record owner is the authenticated user (not client-supplied).
  const user = await authenticate(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: CreateEventRequest;
  try {
    body = (await request.json()) as CreateEventRequest;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (body?.data === undefined) {
    return json({ error: "missing_data" }, 400);
  }
  if (!body.channel || !CHANNEL_RE.test(body.channel)) {
    return json({ error: "invalid_channel" }, 400);
  }
  if (body.status !== undefined && !Number.isInteger(body.status)) {
    return json({ error: "invalid_status" }, 400);
  }

  const record = await insertRecord(env, {
    id: crypto.randomUUID(),
    status: Number.isInteger(body.status) ? (body.status as number) : 0,
    data: JSON.stringify(body.data),
    ownerid: user.id,
    channel: body.channel,
  });

  return json(publicRecord(record), 201);
}

/**
 * GET /get-event?id=<uuid> — fetch a single record (public). If a valid bearer
 * token is supplied AND that user owns the record, the response includes
 * `owner: true` so the caller can show owner controls. `ownerid` itself is never
 * returned.
 */
async function handleGetEvent(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const id = url.searchParams.get("id");
  if (!id) {
    return json({ error: "missing_event_id" }, 400);
  }

  const record = await getRecord(env, id);
  if (!record) {
    return json({ error: "event_not_found" }, 404);
  }

  const user = await authenticate(request, env);
  const owner = !!user && user.id === record.ownerid;
  return json({ ...publicRecord(record), owner });
}

/** POST /update-event — mutate a record's status/data, then broadcast it live. */
async function handleUpdateEvent(
  request: Request,
  env: Env,
): Promise<Response> {
  // AUTH HOOK: only the record's owner may mutate it.
  const user = await authenticate(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: UpdateEventRequest;
  try {
    body = (await request.json()) as UpdateEventRequest;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (!body?.id) {
    return json({ error: "missing_event_id" }, 400);
  }

  const fields: { status?: number; data?: string } = {};
  if (body.status !== undefined) {
    if (!Number.isInteger(body.status)) {
      return json({ error: "invalid_status" }, 400);
    }
    fields.status = body.status;
  }
  if (body.data !== undefined) {
    fields.data = JSON.stringify(body.data);
  }
  if (fields.status === undefined && fields.data === undefined) {
    return json({ error: "no_update_fields" }, 400);
  }

  const existing = await getRecord(env, body.id);
  if (!existing) {
    return json({ error: "event_not_found" }, 404);
  }
  if (existing.ownerid !== user.id) {
    return json({ error: "forbidden" }, 403);
  }

  const record = await updateRecord(env, body.id, fields);
  if (!record) {
    return json({ error: "event_not_found" }, 404);
  }

  // Push the new state to the record's channel so live clients see it — as the
  // public view, so ownerid never reaches viewers.
  const view = publicRecord(record);
  const stub = env.CHANNEL_HUB.get(env.CHANNEL_HUB.idFromName(record.channel));
  const delivered = await stub.broadcast({ kind: "record.updated", record: view });

  return json({ ...view, delivered });
}
