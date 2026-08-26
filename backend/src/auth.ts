// Password hashing and session tokens, using the Workers-native Web Crypto API
// (no bcrypt/argon2 in the runtime).
//
// Password hash format (one string, stored in users.password):
//   pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>
// The iteration count is embedded so it can be raised later without breaking
// existing users. `backend/scripts/create-user.mjs` MUST use these same params —
// the seed→login end-to-end check guards against drift.

const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BITS = 256;

/** Long-lived sessions; low-stakes app. */
export const SESSION_TTL_DAYS = 365;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    PBKDF2_KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Hash a password into the encoded `pbkdf2$...` string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Constant-time equality over two byte arrays (no early return). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Verify a password against an encoded hash. Returns false on any parse error. */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") {
    return false;
  }
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[3]);
    expected = fromBase64(parts[4]);
  } catch {
    return false;
  }
  const actual = await pbkdf2(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

/** A random opaque session token (base64url, 32 bytes of entropy). */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of a token, hex — this is what we store/look up in `sessions`. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
