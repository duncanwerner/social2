import type { HistoryResponse, PublishResponse } from "./types";

/** Strip trailing slashes so we can append paths cleanly. */
export function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

/** Build the WebSocket URL for a channel from the HTTP base URL. */
export function wsUrl(base: string, channel: string): string {
  const b = normalizeBase(base);
  const scheme = b.startsWith("https://") ? "wss://" : "ws://";
  const host = b.replace(/^https?:\/\//, "");
  return `${scheme}${host}/connect?channel=${encodeURIComponent(channel)}`;
}

async function parseJsonOrThrow(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail =
      body && typeof body === "object" ? JSON.stringify(body) : String(body);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return body;
}

export async function health(base: string): Promise<{ ok: boolean; ms: number }> {
  const start = performance.now();
  const res = await fetch(`${normalizeBase(base)}/healthz`);
  const body = (await parseJsonOrThrow(res)) as { ok?: boolean } | null;
  return { ok: Boolean(body?.ok), ms: Math.round(performance.now() - start) };
}

export async function publish(
  base: string,
  input: { channel: string; type: string | null; payload: unknown },
): Promise<PublishResponse> {
  const res = await fetch(`${normalizeBase(base)}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await parseJsonOrThrow(res)) as PublishResponse;
}

export async function getHistory(
  base: string,
  channel: string,
  limit: number,
): Promise<HistoryResponse> {
  const url =
    `${normalizeBase(base)}/history` +
    `?channel=${encodeURIComponent(channel)}&limit=${limit}`;
  const res = await fetch(url);
  return (await parseJsonOrThrow(res)) as HistoryResponse;
}
