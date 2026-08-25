import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

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
];

beforeAll(async () => {
  for (const stmt of SCHEMA) {
    await env.DB.exec(stmt.replace(/\s+/g, " ").trim());
  }
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
