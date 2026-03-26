import type { GenerationWarning, NormalizedAuth } from "./model";

const builtinBearerPatterns = [
  "auth",
  "authenticate",
  "authmiddleware",
  "requireauth",
  "isauthenticated",
  "verifytoken",
  "jwt",
  "jwtmiddleware",
  "bearer",
  "oauth",
  "protected",
  "guard",
  "authorize",
  "authorization",
];

const authLikeWarningPatterns = [
  "auth",
  "jwt",
  "token",
  "bearer",
  "oauth",
  "protected",
  "guard",
  "verify",
  "authoriz",
  "permission",
  "scope",
  "role",
  "acl",
  "access",
];

export interface MiddlewareAuthInference {
  auth: NormalizedAuth;
  warnings: GenerationWarning[];
}

export function inferBearerAuthFromMiddleware(
  frameworkLabel: "Express" | "Go",
  middleware: string[],
  extraBearerPatterns: string[] = [],
): MiddlewareAuthInference {
  const candidates = dedupeValues(middleware.flatMap(extractMiddlewareCandidates));
  const normalizedCandidates = candidates.map((candidate) => ({
    raw: candidate,
    normalized: normalizeMiddlewarePattern(candidate),
  })).filter((candidate) => candidate.normalized);
  const allPatterns = [...builtinBearerPatterns, ...extraBearerPatterns]
    .map((pattern) => normalizeMiddlewarePattern(pattern))
    .filter(Boolean);
  const hasBearerAuth = normalizedCandidates.some((candidate) => matchesAnyPattern(candidate.normalized, allPatterns));

  const warnings = normalizedCandidates
    .filter((candidate) => looksLikeAuthMiddleware(candidate.normalized) && !matchesAnyPattern(candidate.normalized, allPatterns))
    .map((candidate) => ({
      code: `${frameworkLabel.toUpperCase()}_AUTH_MIDDLEWARE_UNKNOWN`,
      message: `${frameworkLabel}: auth middleware '${candidate.raw}' not recognized — add it to config.auth.middlewarePatterns.bearer to infer bearerAuth.`,
    }));

  return {
    auth: hasBearerAuth ? { type: "bearer" } : { type: "none" },
    warnings,
  };
}

function extractMiddlewareCandidates(expression: string): string[] {
  const trimmed = expression.trim().replace(/^await\s+/, "");
  if (!trimmed) {
    return [];
  }

  const bare = trimmed
    .replace(/^&/, "")
    .replace(/\s+/g, "")
    .replace(/\(.*$/, "");
  if (!bare) {
    return [];
  }

  const parts = bare.split(".").filter(Boolean);
  return dedupeValues([
    bare,
    ...parts,
    parts.at(-1) ?? "",
  ].filter(Boolean));
}

function looksLikeAuthMiddleware(normalizedCandidate: string): boolean {
  return authLikeWarningPatterns.some((pattern) => normalizedCandidate.includes(pattern));
}

function matchesAnyPattern(normalizedCandidate: string, normalizedPatterns: string[]): boolean {
  return normalizedPatterns.some((pattern) => (
    normalizedCandidate.includes(pattern) || pattern.includes(normalizedCandidate)
  ));
}

function normalizeMiddlewarePattern(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function dedupeValues(values: string[]): string[] {
  return [...new Set(values)];
}
