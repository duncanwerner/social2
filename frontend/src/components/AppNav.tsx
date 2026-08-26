import { Show } from "@solidjs/web";
import { useNavigate } from "@solidjs/router";
import { isAuthenticated, logout, user } from "../auth";

// Slim top bar shown across the app: brand on the left, auth state on the right.
export function AppNav() {
  const navigate = useNavigate();

  async function doLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <nav class="app-nav">
      <button class="brand" type="button" onClick={() => navigate("/")}>
        Rotation
      </button>
      <div class="nav-right">
        <Show
          when={isAuthenticated()}
          fallback={
            <button
              class="link"
              type="button"
              onClick={() => navigate("/login")}
            >
              Sign in
            </button>
          }
        >
          <button
            class="link"
            type="button"
            onClick={() => navigate("/my-events")}
          >
            My events
          </button>
          <span class="nav-user">{user()?.username}</span>
          <button class="link" type="button" onClick={doLogout}>
            Sign out
          </button>
        </Show>
      </div>
    </nav>
  );
}
