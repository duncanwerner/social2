import { createSignal } from "solid-js";
import { BACKEND_URL, normalizeBase } from "./api";
import { parseOrThrow } from "./api-error";

// Reactive auth store + client. The bearer token lives in localStorage and is
// sent as `Authorization: Bearer <token>` (see records.ts). Module-level signals
// give every component one shared source of truth.

export interface AuthUser {
  id: string;
  username: string;
}

const TOKEN_KEY = "rotation:token";
const USER_KEY = "rotation:user";

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function readUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

const [token, setToken] = createSignal<string | null>(readToken());
const [user, setUser] = createSignal<AuthUser | null>(readUser());

export { token, user };
export const isAuthenticated = (): boolean => token() !== null;

function persist(t: string, u: AuthUser): void {
  setToken(t);
  setUser(u);
  try {
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}

/**
 * Adopt a session returned by the backend (e.g. the auto sign-in from
 * /set-password) as the current auth state, persisting it like `login` does.
 */
export function adoptSession(t: string, u: AuthUser): void {
  persist(t, u);
}

/** Clear local auth state (does not call the backend). */
export function clearAuth(): void {
  setToken(null);
  setUser(null);
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

const base = () => normalizeBase(BACKEND_URL);

/** Log in; throws ApiError (code "invalid_credentials") on failure. */
export async function login(username: string, password: string): Promise<void> {
  const res = await fetch(`${base()}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await parseOrThrow<{ token: string; user: AuthUser }>(res);
  persist(body.token, body.user);
}

/** Log out: revoke the session on the backend and clear local state. */
export async function logout(): Promise<void> {
  const t = token();
  clearAuth();
  if (t) {
    try {
      await fetch(`${base()}/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}` },
      });
    } catch {
      /* best-effort */
    }
  }
}

/** Validate the stored token on app load; clears it if the session is gone. */
export async function refreshMe(): Promise<void> {
  const t = token();
  if (!t) return;
  try {
    const res = await fetch(`${base()}/me`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (res.status === 401) {
      clearAuth();
      return;
    }
    if (res.ok) {
      const body = (await res.json()) as { user: AuthUser };
      setUser(body.user);
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(body.user));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* offline — keep the token, it may still be valid */
  }
}
