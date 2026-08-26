/** Thrown when the backend responds with a non-2xx status. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Parse a fetch Response, throwing ApiError on non-2xx. */
export async function parseOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const code =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : "";
    const detail =
      body && typeof body === "object" ? JSON.stringify(body) : String(body);
    throw new ApiError(res.status, code, `HTTP ${res.status}: ${detail}`);
  }
  return body as T;
}
