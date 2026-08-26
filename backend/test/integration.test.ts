import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { constantTimeEqual, hashPassword, verifyPassword } from "../src/auth";

// Apply the D1 schema to the test's isolated storage. Each statement must be a
// single line for env.DB.exec (which splits its input on newlines).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     channel TEXT NOT NULL,
     type TEXT,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_channel ON events (channel, id)`,
  `CREATE TABLE IF NOT EXISTS records (
     id TEXT PRIMARY KEY,
     status INTEGER NOT NULL DEFAULT 0,
     data TEXT NOT NULL,
     ownerid TEXT NOT NULL,
     channel TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_records_channel ON records (channel)`,
  `CREATE INDEX IF NOT EXISTS idx_records_owner ON records (ownerid, created_at)`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     password TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     expires_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
];

// Two seeded users for the auth + records tests.
const OWNER = { id: "user-owner", username: "owner", password: "pw-owner-123" };
const OTHER = { id: "user-other", username: "other", password: "pw-other-123" };
let ownerToken = "";
let otherToken = "";

async function seedUser(u: { id: string; username: string; password: string }) {
  await env.DB.prepare(
    "INSERT INTO users (id, username, password) VALUES (?, ?, ?)",
  )
    .bind(u.id, u.username, await hashPassword(u.password))
    .run();
}

function login(username: string, password: string) {
  return SELF.fetch("https://example.com/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

beforeAll(async () => {
  for (const stmt of SCHEMA) {
    await env.DB.exec(stmt.replace(/\s+/g, " ").trim());
  }
  await seedUser(OWNER);
  await seedUser(OTHER);
  ownerToken = ((await (await login(OWNER.username, OWNER.password)).json()) as {
    token: string;
  }).token;
  otherToken = ((await (await login(OTHER.username, OTHER.password)).json()) as {
    token: string;
  }).token;
});

describe("do-sockets backend", () => {
  it("persists events and returns them from /history", async () => {
    const res = await SELF.fetch("https://example.com/publish", {
      method: "POST",
      body: JSON.stringify({ channel: "demo", type: "test", payload: { hi: 1 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    expect(body.id).toBeGreaterThan(0);

    const hist = await SELF.fetch("https://example.com/history?channel=demo");
    const h = (await hist.json()) as { events: Array<{ payload: unknown }> };
    expect(h.events[0].payload).toEqual({ hi: 1 });
  });

  it("delivers events only to sockets on the same channel", async () => {
    const roomRes = await SELF.fetch("https://example.com/connect?channel=room", {
      headers: { Upgrade: "websocket" },
    });
    expect(roomRes.status).toBe(101);
    const roomWs = roomRes.webSocket!;
    roomWs.accept();

    const otherRes = await SELF.fetch(
      "https://example.com/connect?channel=elsewhere",
      { headers: { Upgrade: "websocket" } },
    );
    const otherWs = otherRes.webSocket!;
    otherWs.accept();

    const roomGot = new Promise<string>((resolve) => {
      roomWs.addEventListener("message", (e: MessageEvent) => resolve(e.data as string), {
        once: true,
      });
    });
    let otherReceived = false;
    otherWs.addEventListener("message", () => {
      otherReceived = true;
    });

    const pub = await SELF.fetch("https://example.com/publish", {
      method: "POST",
      body: JSON.stringify({ channel: "room", payload: { n: 42 } }),
    });
    const pubBody = (await pub.json()) as { delivered: number };
    expect(pubBody.delivered).toBe(1);

    const msg = JSON.parse(await roomGot) as { channel: string; payload: unknown };
    expect(msg.channel).toBe("room");
    expect(msg.payload).toEqual({ n: 42 });
    expect(otherReceived).toBe(false);
  });

  it("rejects invalid channel names", async () => {
    const res = await SELF.fetch("https://example.com/history?channel=bad%20name");
    expect(res.status).toBe(400);
  });
});

function authHeaders(token: string) {
  return { "content-type": "application/json", Authorization: `Bearer ${token}` };
}

describe("records HTTP API", () => {
  function createRecord(body: unknown, token = ownerToken) {
    return SELF.fetch("https://example.com/create-event", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  }

  function updateEvent(body: unknown, token = ownerToken) {
    return SELF.fetch("https://example.com/update-event", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  }

  it("creates a record and reads it back", async () => {
    const res = await createRecord({
      data: { title: "Sat social" },
      channel: "rec-1",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      status: number;
      data: unknown;
      ownerid?: string;
      channel: string;
      created_at: string;
    };
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.status).toBe(0);
    expect(created.data).toEqual({ title: "Sat social" });
    expect(created.channel).toBe("rec-1");
    // ownerid is write-only — never returned to clients.
    expect(created.ownerid).toBeUndefined();

    const got = await SELF.fetch(
      `https://example.com/get-event?id=${created.id}`,
    );
    expect(got.status).toBe(200);
    const fetched = (await got.json()) as {
      id: string;
      data: unknown;
      ownerid?: string;
    };
    expect(fetched.id).toBe(created.id);
    expect(fetched.data).toEqual({ title: "Sat social" });
    expect(fetched.ownerid).toBeUndefined();
  });

  it("returns 404 for an unknown record id", async () => {
    const res = await SELF.fetch(
      "https://example.com/get-event?id=does-not-exist",
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({
      error: "event_not_found",
    });
  });

  it("updates status/data and reflects it on a later read", async () => {
    const created = (await (
      await createRecord({ data: { n: 1 }, channel: "rec-2" })
    ).json()) as { id: string };

    const upd = await updateEvent({ id: created.id, status: 2, data: { n: 2 } });
    expect(upd.status).toBe(200);
    const updated = (await upd.json()) as { status: number; data: unknown };
    expect(updated.status).toBe(2);
    expect(updated.data).toEqual({ n: 2 });

    const got = (await (
      await SELF.fetch(`https://example.com/get-event?id=${created.id}`)
    ).json()) as { status: number; data: unknown };
    expect(got.status).toBe(2);
    expect(got.data).toEqual({ n: 2 });
  });

  it("broadcasts the updated record to sockets on its channel", async () => {
    const created = (await (
      await createRecord({ data: { n: 0 }, channel: "rec-live" })
    ).json()) as { id: string };

    const wsRes = await SELF.fetch(
      "https://example.com/connect?channel=rec-live",
      { headers: { Upgrade: "websocket" } },
    );
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket!;
    ws.accept();

    const got = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e: MessageEvent) => resolve(e.data as string), {
        once: true,
      });
    });

    const upd = await updateEvent({ id: created.id, status: 1 });
    const updBody = (await upd.json()) as { delivered: number };
    expect(updBody.delivered).toBe(1);

    const msg = JSON.parse(await got) as {
      kind: string;
      record: { id: string; status: number; ownerid?: string };
    };
    expect(msg.kind).toBe("record.updated");
    expect(msg.record.id).toBe(created.id);
    expect(msg.record.status).toBe(1);
    // the broadcast must not leak ownerid to viewers on the channel.
    expect(msg.record.ownerid).toBeUndefined();
  });

  it("returns 404 when updating a missing record", async () => {
    const res = await updateEvent({ id: "nope", status: 1 });
    expect(res.status).toBe(404);
  });

  it("validates create and update bodies", async () => {
    // missing data
    expect((await createRecord({ channel: "c" })).status).toBe(400);
    // invalid channel
    expect(
      (await createRecord({ data: {}, channel: "bad name" })).status,
    ).toBe(400);

    const created = (await (
      await createRecord({ data: {}, channel: "rec-v" })
    ).json()) as { id: string };

    // missing id
    expect((await updateEvent({ status: 1 })).status).toBe(400);
    // no fields to update
    expect((await updateEvent({ id: created.id })).status).toBe(400);
  });
});

describe("auth", () => {
  it("logs in and returns a token + user", async () => {
    const res = await login(OWNER.username, OWNER.password);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      user: { id: string; username: string };
    };
    expect(body.token).toBeTruthy();
    expect(body.user).toEqual({ id: OWNER.id, username: OWNER.username });
  });

  it("rejects a wrong password and an unknown user identically", async () => {
    expect((await login(OWNER.username, "wrong")).status).toBe(401);
    expect((await login("ghost", "whatever")).status).toBe(401);
  });

  it("GET /me returns the user with a token, 401 without", async () => {
    const me = await SELF.fetch("https://example.com/me", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(me.status).toBe(200);
    expect(
      ((await me.json()) as { user: { username: string } }).user.username,
    ).toBe(OWNER.username);

    expect((await SELF.fetch("https://example.com/me")).status).toBe(401);
  });

  it("create-event requires auth and derives ownerid from the session", async () => {
    const noAuth = await SELF.fetch("https://example.com/create-event", {
      method: "POST",
      body: JSON.stringify({ data: {}, channel: "auth-c" }),
    });
    expect(noAuth.status).toBe(401);
  });

  it("get-event reports owner=true only for the record's owner", async () => {
    const created = (await (
      await SELF.fetch("https://example.com/create-event", {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ data: { m: 1 }, channel: "owned-flag" }),
      })
    ).json()) as { id: string };

    const getFlag = async (token?: string) =>
      (await (
        await SELF.fetch(`https://example.com/get-event?id=${created.id}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
      ).json()) as { owner?: boolean; ownerid?: string };

    expect((await getFlag(ownerToken)).owner).toBe(true);
    expect((await getFlag(otherToken)).owner).toBe(false);
    const anon = await getFlag();
    expect(anon.owner).toBe(false);
    expect(anon.ownerid).toBeUndefined();
  });

  it("update-event is owner-only (403 for a different user)", async () => {
    const created = (await (
      await SELF.fetch("https://example.com/create-event", {
        method: "POST",
        headers: authHeaders(ownerToken),
        body: JSON.stringify({ data: { a: 1 }, channel: "owned" }),
      })
    ).json()) as { id: string };

    const forbidden = await SELF.fetch("https://example.com/update-event", {
      method: "POST",
      headers: authHeaders(otherToken),
      body: JSON.stringify({ id: created.id, status: 5 }),
    });
    expect(forbidden.status).toBe(403);

    const ok = await SELF.fetch("https://example.com/update-event", {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ id: created.id, status: 5 }),
    });
    expect(ok.status).toBe(200);
  });
});

describe("GET /my-events", () => {
  // A dedicated owner with a directly-seeded record set, so ordering and
  // pagination are deterministic. (HTTP-created records all land in the same
  // whole-second `created_at`, and the `id` tiebreaker is a random UUID — no
  // stable creation order. Seeding explicit timestamps avoids that.)
  const LISTER = { id: "user-lister", username: "lister", password: "pw-lister-1" };
  let listerToken = "";

  async function seedRecord(
    id: string,
    status: number,
    created_at: string,
    ownerid = LISTER.id,
  ) {
    await env.DB.prepare(
      `INSERT INTO records (id, status, data, ownerid, channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, status, JSON.stringify({ id }), ownerid, `ch-${id}`, created_at)
      .run();
  }

  function listMyEvents(query: string, token = listerToken) {
    return SELF.fetch(`https://example.com/my-events${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  type Listing = { records: Array<{ id: string; ownerid?: string }>; page: number; hasMore: boolean };

  beforeAll(async () => {
    await seedUser(LISTER);
    listerToken = ((await (await login(LISTER.username, LISTER.password)).json()) as {
      token: string;
    }).token;

    // 15 active records, created_at increasing (l-a-15 newest).
    for (let i = 1; i <= 15; i++) {
      const n = String(i).padStart(2, "0");
      await seedRecord(`l-a-${n}`, 0, `2024-01-01 00:00:${n}`);
    }
    // 2 finished records, newest of all (2024-06-01).
    await seedRecord("l-f-1", 2, "2024-06-01 00:00:01");
    await seedRecord("l-f-2", 2, "2024-06-01 00:00:02");
    // A record owned by someone else — must never appear in LISTER's listing.
    await seedRecord("owner-only", 0, "2024-12-01 00:00:00", OWNER.id);
  });

  it("requires a bearer token", async () => {
    const res = await SELF.fetch("https://example.com/my-events");
    expect(res.status).toBe(401);
  });

  it("lists only the caller's records, newest first, without ownerid", async () => {
    const body = (await (await listMyEvents("")).json()) as Listing;
    // Only LISTER's records (the seeded 'l-' ids), never 'owner-only'.
    expect(body.records.every((r) => r.id.startsWith("l-"))).toBe(true);
    expect(body.records.some((r) => r.id === "owner-only")).toBe(false);
    // ownerid is write-only.
    expect(body.records.every((r) => r.ownerid === undefined)).toBe(true);
    // Default (active only) → newest active first.
    expect(body.records[0].id).toBe("l-a-15");
  });

  it("paginates 12 per page with a hasMore flag", async () => {
    const p1 = (await (await listMyEvents("?page=1")).json()) as Listing;
    expect(p1.records).toHaveLength(12);
    expect(p1.hasMore).toBe(true);
    expect(p1.records.map((r) => r.id)).toEqual([
      "l-a-15", "l-a-14", "l-a-13", "l-a-12", "l-a-11", "l-a-10",
      "l-a-09", "l-a-08", "l-a-07", "l-a-06", "l-a-05", "l-a-04",
    ]);

    const p2 = (await (await listMyEvents("?page=2")).json()) as Listing;
    expect(p2.records.map((r) => r.id)).toEqual(["l-a-03", "l-a-02", "l-a-01"]);
    expect(p2.hasMore).toBe(false);
  });

  it("hides finished records by default and includes them with all=1", async () => {
    const active = (await (await listMyEvents("?all=0")).json()) as Listing;
    expect(active.records.some((r) => r.id.startsWith("l-f-"))).toBe(false);

    const all = (await (await listMyEvents("?all=1")).json()) as Listing;
    // Finished records are the newest, so they lead the all listing.
    expect(all.records[0].id).toBe("l-f-2");
    expect(all.records[1].id).toBe("l-f-1");
    expect(all.hasMore).toBe(true);
  });
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const enc = await hashPassword("s3cret");
    expect(enc.startsWith("pbkdf2$sha256$")).toBe(true);
    expect(await verifyPassword("s3cret", enc)).toBe(true);
    expect(await verifyPassword("nope", enc)).toBe(false);
  });

  it("constantTimeEqual compares byte arrays", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
