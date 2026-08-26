import { createContext, useContext, type Accessor } from "solid-js";
import type { SocialEvent } from "./types";
import type { SocketStatus } from "./socket";

// Shared live state for the /view/:id layout and its child pages. The layout
// loads the record once and (unless finished) subscribes to its channel; children
// read the reactive event + connection state from here.

/** Connection state as shown to viewers. */
export type ViewConnection = SocketStatus | "loading" | "static";

export interface ViewLive {
  event: Accessor<SocialEvent | null>;
  /** The record's status int (see event-status.ts). */
  eventStatus: Accessor<number>;
  connection: Accessor<ViewConnection>;
  recordId: string;
  /** True when the signed-in user owns this record (from get-event). */
  isOwner: Accessor<boolean>;
  /**
   * Owner-only: optimistically apply `next` and persist it via update-event
   * (which broadcasts to all viewers). Throws on failure.
   */
  save: (next: SocialEvent) => Promise<void>;
}

// Default-less: useContext returns ViewLive directly and throws if used outside
// the /view/:id layout's provider.
export const ViewContext = createContext<ViewLive>();

export function useViewLive(): ViewLive {
  return useContext(ViewContext);
}
