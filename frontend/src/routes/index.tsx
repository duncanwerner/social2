import { useNavigate } from "@solidjs/router";

// Landing page — served at "/". A route module is a page via its default export.
export default function Home() {
  const navigate = useNavigate();
  return (
    <main class="landing">
      <section class="hero">
        <h1>Rotation</h1>
        <p class="tagline">
          Schedule Padel socials where players rotate partners across short
          matches — and watch the schedule update live.
        </p>
        <button
          class="primary hero-cta"
          type="button"
          onClick={() => navigate("/create-event")}
        >
          Create a social
        </button>
      </section>
    </main>
  );
}
