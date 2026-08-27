import { createEffect, createSignal } from "solid-js";
import { Show } from "@solidjs/web";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { checkRecovery, setPassword } from "../recovery";
import { adoptSession } from "../auth";
import { BACKEND_URL } from "../api";
import { ApiError } from "../api-error";

// Surfaced (as on /login) so it's obvious when you're pointed at local dev.
const IS_LOCAL_BACKEND = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(
  BACKEND_URL,
);

// Keep in sync with MIN_PASSWORD_LENGTH in backend/src/index.ts.
const MIN_PASSWORD_LENGTH = 8;

// /set-password?token=… — public page reached via an emailed recovery link. It
// validates the token, lets the user choose a password, then auto signs-in.
export default function SetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tokenParam = () =>
    typeof params.token === "string" ? params.token : "";

  const [status, setStatus] = createSignal<"loading" | "ready" | "invalid">(
    "loading",
  );
  const [username, setUsername] = createSignal("");
  const [password, setPasswordValue] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // Validate the recovery token on mount / whenever it changes. The `cancelled`
  // flag drops a response that resolves after the token changed (see [id].tsx).
  createEffect(
    () => tokenParam(),
    (token) => {
      let cancelled = false;
      setStatus("loading");
      if (!token) {
        setStatus("invalid");
        return;
      }
      void (async () => {
        try {
          const res = await checkRecovery(token);
          if (cancelled) return;
          setUsername(res.username);
          setStatus("ready");
        } catch {
          if (!cancelled) setStatus("invalid");
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  );

  async function submit(e: Event) {
    e.preventDefault();
    if (busy()) return;
    setError("");
    if (password().length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password() !== confirm()) {
      setError("Passwords don’t match.");
      return;
    }
    setBusy(true);
    try {
      const res = await setPassword({
        token: tokenParam(),
        password: password(),
      });
      adoptSession(res.token, res.user);
      navigate("/", { replace: true });
    } catch (err) {
      // The token may have expired or been used between load and submit.
      if (err instanceof ApiError && err.code === "invalid_token") {
        setStatus("invalid");
      } else if (err instanceof ApiError && err.code === "weak_password") {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      } else {
        setError("Could not set your password — is the backend running?");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="auth-page">
      <form class="card auth-card" onSubmit={submit}>
        <h1>Set your password</h1>
        <Show when={IS_LOCAL_BACKEND}>
          <p class="backend-note">
            Local backend — <code>{BACKEND_URL}</code>
          </p>
        </Show>

        <Show when={status() === "loading"}>
          <p class="hint">Checking your link…</p>
        </Show>

        <Show when={status() === "invalid"}>
          <p class="err-inline">
            This link is invalid or has expired. Ask for a new recovery link.
          </p>
          <button
            type="button"
            class="secondary"
            onClick={() => navigate("/login")}
          >
            Go to sign in
          </button>
        </Show>

        <Show when={status() === "ready"}>
          <p class="hint">
            Choose a password for <strong>{username()}</strong>.
          </p>
          <label class="field">
            <span>New password</span>
            <input
              type="password"
              value={password()}
              onInput={(e) => setPasswordValue(e.currentTarget.value)}
              autocomplete="new-password"
              autofocus
            />
          </label>
          <label class="field">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirm()}
              onInput={(e) => setConfirm(e.currentTarget.value)}
              autocomplete="new-password"
            />
          </label>
          <Show when={error()}>
            <p class="err-inline">{error()}</p>
          </Show>
          <button class="primary" type="submit" disabled={busy()}>
            {busy() ? "Saving…" : "Set password & sign in"}
          </button>
        </Show>
      </form>
    </main>
  );
}
