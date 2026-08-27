// Shared helpers for minting password-recovery tokens from the seeding scripts
// (create-user.mjs, reset-password.mjs). A recovery token lets a user set their
// own password via the frontend's /set-password page — the no-email version of
// a forgot-password flow. We store only the SHA-256 of the token (matching
// backend/src/db.ts), so what lands in the DB can't be used as a link.

import { execFileSync } from "node:child_process";

// Keep in sync with RECOVERY_TTL_DAYS in backend/src/db.ts.
const RECOVERY_TTL_DAYS = 7;

const b64url = (bytes) =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A random opaque recovery token (base64url, 32 bytes of entropy, URL-safe). */
export function generateToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 of a token, lowercase hex — matches auth.ts's hashToken. */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Run a D1 SQL command (local unless `remote`). With `json`, returns stdout. */
export function d1Exec(sql, { remote, json = false } = {}) {
  return execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "do-sockets",
      remote ? "--remote" : "--local",
      ...(json ? ["--json"] : []),
      "--command",
      sql,
    ],
    { stdio: json ? ["ignore", "pipe", "inherit"] : ["ignore", "ignore", "inherit"] },
  );
}

/**
 * Look up a user's id by username, or null if there is no such user. `username`
 * must already be validated (safe in a single-quoted SQL literal).
 */
export function lookupUserId(username, { remote }) {
  const out = d1Exec(`SELECT id FROM users WHERE username = '${username}'`, {
    remote,
    json: true,
  }).toString();
  try {
    const parsed = JSON.parse(out);
    const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
    return results && results[0] ? results[0].id : null;
  } catch {
    return null;
  }
}

/**
 * Mint a recovery token for a user id, invalidating any prior tokens for them so
 * only the newest link works. Returns the raw token. `userId` is a UUID (safe in
 * a single-quoted SQL literal); the hash is hex.
 */
export async function mintRecoveryToken({ userId, remote }) {
  const token = generateToken();
  const hash = await hashToken(token);
  const sql =
    `DELETE FROM recovery_tokens WHERE user_id = '${userId}';` +
    `INSERT INTO recovery_tokens (token_hash, user_id, expires_at) ` +
    `VALUES ('${hash}', '${userId}', datetime('now', '+${RECOVERY_TTL_DAYS} days'))`;
  d1Exec(sql, { remote });
  return token;
}

/** Build the full set-password URL, or null if no hostname was supplied. */
export function buildSetPasswordUrl(hostname, token) {
  if (!hostname) return null;
  let base;
  if (/^https?:\/\//i.test(hostname)) {
    base = hostname; // scheme supplied — use as-is
  } else {
    // Loopback hosts serve over http in dev; everything else over https.
    const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(hostname)
      ? "http"
      : "https";
    base = `${scheme}://${hostname}`;
  }
  return `${base.replace(/\/+$/, "")}/set-password?token=${token}`;
}

/**
 * Print the recovery token, plus a full clickable link when a `--hostname` was
 * given. Without a hostname we print just the token + the path to append.
 */
export function printRecovery({ token, hostname }) {
  const url = buildSetPasswordUrl(hostname, token);
  console.log(`\n  recovery token: ${token}`);
  if (url) {
    console.log(`  set-password link: ${url}`);
  } else {
    console.log(`  set-password path: /set-password?token=${token}`);
  }
  console.log(
    `\nEmail this link to the user — it lets them set a password ` +
      `(valid ${RECOVERY_TTL_DAYS} days, single use).`,
  );
}

/**
 * Parse shared CLI args: `--remote`, `--hostname <host>` (or `--hostname=host`),
 * and positional args. Returns { remote, hostname, positional }.
 */
export function parseArgs(argv) {
  const remoteFlag = "--remote";
  const hostFlag = "--hostname";
  let remote = false;
  let hostname;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === remoteFlag) {
      remote = true;
    } else if (a === hostFlag) {
      hostname = argv[++i];
    } else if (a.startsWith(`${hostFlag}=`)) {
      hostname = a.slice(hostFlag.length + 1);
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }
  return { remote, hostname, positional };
}
