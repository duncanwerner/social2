import { EventEditor } from "../components/EventEditor";

// /create-event — no route param, so EventEditor runs in create mode.
export default function CreateEvent() {
  return <EventEditor />;
}
