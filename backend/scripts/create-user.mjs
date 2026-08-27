// Seed a user into the D1 `users` table. No signup endpoint exists by design;
// this is the manual way to create accounts.
//
//   node scripts/create-user.mjs <username> [--remote] [--hostname <host>]
//
// The user is created WITHOUT a usable password: a random, never-disclosed
// password satisfies the NOT NULL column, and the only way in is the recovery
// token this prints. Email the user the token/link and they set their own
// password via the frontend's /set-password page. With --hostname, a full
// clickable URL is printed; otherwise just the raw token.

import {
  mintRecoveryToken,
  parseArgs,
  printRecovery,
} from "./recovery.mjs";
import { execFileSync } from "node:child_process";

// Keep these in sync with backend/src/auth.ts.
const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BITS = 256;

const { remote, hostname, positional } = parseArgs(process.argv.slice(2));
const username = positional[0];

if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
  console.error(
    "Usage: node scripts/create-user.mjs <username> [--remote] [--hostname <host>]\n" +
      "  username must match [A-Za-z0-9._-]{1,64}",
  );
  process.exit(1);
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    PBKDF2_KEY_BITS,
  );
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

// A random, never-shared password keeps `password NOT NULL` satisfied; the user
// can never know it, so the recovery token below is the only way to sign in.
function randomSecret() {
  return b64(crypto.getRandomValues(new Uint8Array(15)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const id = crypto.randomUUID();
const hash = await hashPassword(randomSecret());

// hash and id contain only [A-Za-z0-9$+/=-]; username is validated above — none
// contain a single quote, so single-quoted SQL literals are safe here.
const sql = `INSERT INTO users (id, username, password) VALUES ('${id}', '${username}', '${hash}')`;

try {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "do-sockets",
      remote ? "--remote" : "--local",
      "--command",
      sql,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
} catch (err) {
  console.error("\nFailed to insert user (is the username already taken?)");
  process.exit(1);
}

const token = await mintRecoveryToken({ userId: id, remote });

console.log(`\nCreated user (${remote ? "remote" : "local"}):`);
console.log(`  username: ${username}`);
console.log(`  id:       ${id}`);
printRecovery({ token, hostname });
