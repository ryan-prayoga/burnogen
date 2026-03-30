import type { NormalizedParameter } from "./model";
import type { NormalizedResponse } from "./model";

/**
 * Remove duplicate parameters based on their `in` and `name` combination.
 * Keeps the first occurrence of each unique parameter.
 */
export function dedupeParameters(params: NormalizedParameter[]): NormalizedParameter[] {
  const seen = new Map<string, NormalizedParameter>();

  for (const param of params) {
    const key = `${param.in}:${param.name}`;
    if (!seen.has(key)) {
      seen.set(key, param);
    }
  }

  return Array.from(seen.values());
}

/**
 * Remove duplicate responses by status code.
 * Keeps the first occurrence of each unique status code.
 */
export function dedupeResponsesByStatusCode(responses: NormalizedResponse[]): NormalizedResponse[] {
  const seen = new Set<string>();
  return responses.filter((response) => {
    if (seen.has(response.statusCode)) {
      return false;
    }
    seen.add(response.statusCode);
    return true;
  });
}
