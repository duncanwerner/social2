// Seed a user into the D1 `users` table. No signup endpoint exists by design;
// this is the manual way to create the first accounts.
//
//   node scripts/create-user.mjs <username> [--remote]
//
// Generates a random password, hashes it with the SAME PBKDF2 params as
// backend/src/auth.ts, inserts the row via `wrangler d1 execute`, and prints the
// password ONCE. (Compatibility with auth.ts is confirmed by logging in.)

import { execFileSync } from "node:child_process";

// Keep these in sync with backend/src/auth.ts.
const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BITS = 256;

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const username = args.find((a) => !a.startsWith("--"));

if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
  console.error(
    "Usage: node scripts/create-user.mjs <username> [--remote]\n" +
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

// A readable-ish strong random password (base64url of 15 bytes → 20 chars).
function generatePassword() {
  return b64(crypto.getRandomValues(new Uint8Array(15)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const id = crypto.randomUUID();
const password = generatePassword();
const hash = await hashPassword(password);

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

console.log(`\nCreated user (${remote ? "remote" : "local"}):`);
console.log(`  username: ${username}`);
console.log(`  id:       ${id}`);
console.log(`  password: ${password}`);
console.log("\nSave the password now — it is not stored anywhere else.");
