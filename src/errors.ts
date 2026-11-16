import type { Result, WaveHouseError } from "./types.js";

/** Create a WaveHouseError from an HTTP response. */
export async function parseErrorResponse(res: Response): Promise<WaveHouseError> {
  let body: Record<string, unknown> | undefined;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = undefined;
  }

  const message =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : res.statusText;

  // On an API answer, `retryable` is the server's own verdict (or the status's
  // default): the answer is transient, not a promise that this SDK resends it.
  // A `wh.sql()` call is never resent after an answer, and a pipe call only on
  // the server's own `retryable: true`, a 429 or a 503 with `Retry-After`, so
  // either can carry `retryable: true` and still be sent once.
  //
  // The server's own `code` and `retryable` win where it sends them (a
  // failed ClickHouse query, for one); the status decides otherwise: 5xx, 408
  // and 429, the standard "try again".
  const code =
    typeof body?.code === "string" && body.code !== "" ? body.code : `HTTP_${res.status}`;
  const retryable =
    typeof body?.retryable === "boolean"
      ? body.retryable
      : res.status >= 500 || res.status === 408 || res.status === 429;
  return {
    status: res.status,
    code,
    message,
    details: body,
    retryable,
  };
}

/**
 * Create a WaveHouseError from a network/fetch error.
 *
 * `retryable` is true here, and `request` then adjusts it for the call: it is
 * cleared for a `wh.sql()` or pipe call whose request may have reached the
 * server, where `true` means a resend is safe.
 */
export function networkError(cause: unknown): WaveHouseError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    status: 0,
    code: "NETWORK_ERROR",
    message,
    retryable: true,
  };
}

/** Wrap a successful value in a Result. */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data, error: null };
}

/** Wrap a successful paginated value in a Result. */
export function okPage<T>(data: T, hasMore: boolean, next?: () => Promise<Result<T>>): Result<T> {
  return { ok: true, data, error: null, hasMore, next };
}

/** Wrap an error in a Result. */
export function err<T = unknown>(error: WaveHouseError): Result<T> {
  return { ok: false, data: null, error };
}
