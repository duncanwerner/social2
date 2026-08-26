import { Show } from "@solidjs/web";
import { useViewLive } from "../../../view-live";

// /view/:id — event info (metadata + roster summary), live-updating.
export default function ViewInfo() {
  const { event } = useViewLive();

  const dateLabel = (iso: string): string => {
    if (!iso) return "";
    // A date-only "YYYY-MM-DD" parses as UTC midnight via `new Date()`, which
    // renders as the previous day in negative-offset zones — build it as a local
    // date instead. Full datetimes still go through the default parser.
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    const d = parts
      ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
      : new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };

  return (
    <Show when={event()}>
      {(ev) => (
        <main class="view-page">
          <header class="view-head">
            <h1>{ev().metadata.name || "Untitled social"}</h1>
          </header>

          <section class="card">
            <Show when={ev().metadata.date}>
              <div class="info-row">
                <span class="info-label">Date</span>
                <span>{dateLabel(ev().metadata.date)}</span>
              </div>
            </Show>
            <Show when={ev().metadata.time}>
              <div class="info-row">
                <span class="info-label">Time</span>
                <span>{ev().metadata.time}</span>
              </div>
            </Show>
            <Show when={ev().metadata.location}>
              <div class="info-row">
                <span class="info-label">Location</span>
                <span>{ev().metadata.location}</span>
              </div>
            </Show>
            <div class="info-row">
              <span class="info-label">Players</span>
              <span>{ev().players.length}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Courts</span>
              <span>{ev().courts.length}</span>
            </div>
          </section>

          <Show when={ev().metadata.description}>
            <section class="card">
              <h2>Notes</h2>
              <p class="view-description">{ev().metadata.description}</p>
            </section>
          </Show>
        </main>
      )}
    </Show>
  );
}
