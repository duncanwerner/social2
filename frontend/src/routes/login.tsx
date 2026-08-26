import { createSignal } from "solid-js";
import { Show } from "@solidjs/web";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { login } from "../auth";
import { BACKEND_URL } from "../api";
import { ApiError } from "../api-error";

// True when the configured backend is a local dev server (localhost / loopback).
// Surfaced on the login page so it's obvious you're signing in against local dev
// and not the deployed Worker — avoids confusing "wrong password" style errors.
const IS_LOCAL_BACKEND = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(
  BACKEND_URL,
);

// /login — username/password sign-in. On success, returns to ?redirect= (or /).
export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy()) return;
    setError("");
    setBusy(true);
    try {
      await login(username().trim(), password());
      const redirect =
        typeof params.redirect === "string" ? params.redirect : "/";
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Invalid username or password."
          : "Could not sign in — is the backend running?",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="auth-page">
      <form class="card auth-card" onSubmit={submit}>
        <h1>Sign in</h1>
        <Show when={IS_LOCAL_BACKEND}>
          <p class="backend-note">
            Local backend — <code>{BACKEND_URL}</code>
          </p>
        </Show>
        <label class="field">
          <span>Username</span>
          <input
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value)}
            autocomplete="username"
            autofocus
          />
        </label>
        <label class="field">
          <span>Password</span>
          <input
            type="password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            autocomplete="current-password"
          />
        </label>
        <Show when={error()}>
          <p class="err-inline">{error()}</p>
        </Show>
        <button class="primary" type="submit" disabled={busy()}>
          {busy() ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
