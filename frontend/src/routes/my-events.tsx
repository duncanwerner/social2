import { createEffect, createSignal, untrack } from "solid-js";
import { For, Show } from "@solidjs/web";
import { useLocation, useNavigate } from "@solidjs/router";
import { isAuthenticated } from "../auth";
import { listMyEvents } from "../records";
import { isFinished } from "../event-status";
import type { RecordEntity } from "../protocol";
import type { SocialEvent } from "../types";

// /my-events — the signed-in user's own socials, newest first, 12 per page.
// Owner-only: guarded like the editor. Each row opens the editor by record id.

// The "show finished" filter persists across paging and revisits.
const ALL_KEY = "rotation:my-events-all";
function readShowFinished(): boolean {
  try {
    return localStorage.getItem(ALL_KEY) === "1";
  } catch {
    return false;
  }
}

const asEvent = (r: RecordEntity): SocialEvent => r.data as SocialEvent;

// Created date, shown as a plain calendar date (created_at is UTC "YYYY-MM-DD …").
function createdLabel(created_at: string): string {
  const d = new Date(created_at.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime())
    ? created_at
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export default function MyEvents() {
  const navigate = useNavigate();
  const location = useLocation();

  // Guard: bounce to /login (remembering where we were) when not signed in.
  createEffect(
    () => isAuthenticated(),
    (authed) => {
      if (authed) return;
      const from = untrack(() => location.pathname);
      queueMicrotask(() =>
        navigate(`/login?redirect=${encodeURIComponent(from)}`, {
          replace: true,
        }),
      );
    },
  );

  const [page, setPage] = createSignal(1);
  const [showFinished, setShowFinished] = createSignal(readShowFinished());
  const [records, setRecords] = createSignal<RecordEntity[]>([]);
  const [hasMore, setHasMore] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [failed, setFailed] = createSignal(false);

  function selectShowFinished(v: boolean) {
    setShowFinished(v);
    try {
      localStorage.setItem(ALL_KEY, v ? "1" : "0");
    } catch {
      /* storage unavailable — the filter still applies for this session */
    }
    setPage(1); // a filter change restarts pagination
  }

  // Load a page whenever the page number or the filter changes. Manual async
  // (like the view layout) so the header/filter stay on screen while it loads.
  createEffect(
    () => `${page()}|${showFinished() ? 1 : 0}`,
    () => {
      if (!untrack(isAuthenticated)) return; // guard will redirect
      let cancelled = false;
      const p = untrack(page);
      const all = untrack(showFinished);
      setLoading(true);
      setFailed(false);
      void (async () => {
        try {
          const res = await listMyEvents({ page: p, all });
          if (cancelled) return;
          setRecords(res.records);
          setHasMore(res.hasMore);
        } catch {
          if (cancelled) return;
          setFailed(true);
          setRecords([]);
          setHasMore(false);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  );

  const statusPill = (r: RecordEntity) =>
    isFinished(r.status)
      ? { label: "Finished", cls: "pill-finished" }
      : { label: "Active", cls: "pill-live" };

  return (
    <main class="my-events">
      <header class="my-events-head">
        <h1>My events</h1>
        <label class="filter-check">
          <input
            type="checkbox"
            checked={showFinished()}
            onChange={(e) => selectShowFinished(e.currentTarget.checked)}
          />
          Show finished
        </label>
      </header>

      <Show when={failed()}>
        <section class="card view-stub">
          <h2>Couldn’t load your events</h2>
          <p class="hint">Is the backend running? Try again in a moment.</p>
        </section>
      </Show>

      <Show when={!failed() && !loading() && records().length === 0}>
        <section class="card view-stub">
          <h2>No events yet</h2>
          <p class="hint">
            {showFinished()
              ? "You haven’t created any events."
              : "No active events. Tick “Show finished” to see finished ones."}
          </p>
          <button
            class="link"
            type="button"
            onClick={() => navigate("/create-event")}
          >
            Create a social →
          </button>
        </section>
      </Show>

      <Show when={records().length > 0}>
        <ul class={loading() ? "event-list loading" : "event-list"}>
          <For each={records()}>
            {(r) => {
              const ev = asEvent(r);
              const pill = statusPill(r);
              return (
                <li>
                  <button
                    type="button"
                    class="card event-row"
                    onClick={() => navigate(`/update-event/${r.id}`)}
                  >
                    <div class="event-row-main">
                      <span class="event-name">
                        {ev.metadata?.name?.trim() || "Untitled event"}
                      </span>
                      <span class="event-meta hint">
                        {[ev.metadata?.date, ev.metadata?.time]
                          .filter((s) => s && s.trim())
                          .join(" · ") || "No date set"}
                      </span>
                      <span class="event-created hint">
                        Created {createdLabel(r.created_at)}
                      </span>
                    </div>
                    <span class={`pill ${pill.cls}`}>{pill.label}</span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>

      <Show when={records().length > 0 || page() > 1}>
        <div class="pager">
          <button
            class="secondary"
            type="button"
            disabled={page() <= 1 || loading()}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Prev
          </button>
          <span class="pager-page">Page {page()}</span>
          <button
            class="secondary"
            type="button"
            disabled={!hasMore() || loading()}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      </Show>
    </main>
  );
}
