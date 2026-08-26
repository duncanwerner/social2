import { useNavigate } from "@solidjs/router";

// A generic, centered error page (e.g. a bad /view link).
export function ErrorView(props: { title?: string; message?: string }) {
  const navigate = useNavigate();
  return (
    <main class="error-view">
      <div class="error-card">
        <h1>{props.title ?? "Something went wrong"}</h1>
        <p>{props.message ?? "This page could not be loaded."}</p>
        <button class="primary" type="button" onClick={() => navigate("/")}>
          Go home
        </button>
      </div>
    </main>
  );
}
