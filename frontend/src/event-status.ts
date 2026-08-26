// Named values for a record's `status` int. A finished event's data can't change,
// so views render it statically (no socket). 1 is reserved for a future
// "in progress" / live state.
export const EventStatus = {
  Active: 0,
  Finished: 2,
} as const;

export function isFinished(status: number): boolean {
  return status === EventStatus.Finished;
}
