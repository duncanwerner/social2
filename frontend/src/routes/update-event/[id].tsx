import { Show } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { EventEditor } from "../../components/EventEditor";

// /update-event/:id — EventEditor reads the id from the route and loads it.
// Keyed on the id so navigating between two editor URLs (which the router would
// otherwise service by reusing this component and just updating the param) forces
// a fresh EventEditor mount — the editor snapshots the id at mount to seed its
// form, so it must be remounted per event rather than reused.
export default function UpdateEvent() {
  const params = useParams<{ id: string }>();
  return (
    <Show keyed when={params.id}>
      <EventEditor />
    </Show>
  );
}
