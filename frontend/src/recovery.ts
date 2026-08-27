import { BACKEND_URL, normalizeBase } from "./api";
import { parseOrThrow } from "./api-error";
import type { RecoveryCheckResponse, SetPasswordResponse } from "./protocol";

// HTTP client for the recovery / set-password flow (the no-email "forgot
// password"). Both endpoints are public — the recovery token is the credential —
// so, unlike records.ts, no bearer header is sent.

/** Validate a recovery token before showing the form. Throws ApiError if invalid. */
export async function checkRecovery(
  token: string,
  base: string = BACKEND_URL,
): Promise<RecoveryCheckResponse> {
  const res = await fetch(
    `${normalizeBase(base)}/recovery?token=${encodeURIComponent(token)}`,
  );
  return parseOrThrow<RecoveryCheckResponse>(res);
}

/** Set a password from a recovery token; returns a fresh session (auto sign-in). */
export async function setPassword(
  input: { token: string; password: string },
  base: string = BACKEND_URL,
): Promise<SetPasswordResponse> {
  const res = await fetch(`${normalizeBase(base)}/set-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseOrThrow<SetPasswordResponse>(res);
}
