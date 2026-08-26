import { useViewLive } from "../../../view-live";

// /view/:id/stats — stub. Consumes the shared live event so it stays in sync
// once built out (the score table).
export default function ViewStats() {
  useViewLive();
  return (
    <main class="view-page">
      <section class="card view-stub">
        <h2>Stats</h2>
        <p class="hint">Coming soon.</p>
      </section>
    </main>
  );
}
