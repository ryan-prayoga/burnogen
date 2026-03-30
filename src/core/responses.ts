import type { HttpMethod } from "./model";

const DEFAULT_STATUS_FOR_METHOD: Record<HttpMethod, string> = {
  get: "200",
  post: "201",
  put: "200",
  patch: "200",
  delete: "204",
  head: "200",
  options: "200",
};

/**
 * Returns the default response status code for a given HTTP method.
 * Used when no explicit response status is inferred.
 */
export function defaultStatusForMethod(method: HttpMethod): string {
  return DEFAULT_STATUS_FOR_METHOD[method] ?? "200";
}
