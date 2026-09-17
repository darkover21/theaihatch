import { ProviderError, type ProviderErrorKind } from "./types.js";

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error) || typeof error.status !== "number") return undefined;
  return error.status;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return "provider request failed";
}

export function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && error.name === "AbortError") return new ProviderError("cancelled", "provider request cancelled");
  const status = errorStatus(error);
  let kind: ProviderErrorKind = "unknown";
  let retryable = false;
  if (status === 401 || status === 403) kind = "authentication";
  else if (status === 400 || status === 422) kind = "invalid_request";
  else if (status === 408 || status === 409 || status === 429) { kind = "rate_limit"; retryable = true; }
  else if (status !== undefined && status >= 500) { kind = "transient"; retryable = true; }
  else if (error instanceof TypeError) { kind = "unavailable"; retryable = true; }
  return new ProviderError(kind, errorMessage(error), retryable, status);
}
