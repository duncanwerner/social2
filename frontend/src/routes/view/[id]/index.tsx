import { Show } from "@solidjs/web";
import { useViewLive } from "../../../view-live";

// /view/:id — event info (metadata + roster summary), live-updating.
export default function ViewInfo() {
  const { event } = useViewLive();

  const dateLabel = (iso: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
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
