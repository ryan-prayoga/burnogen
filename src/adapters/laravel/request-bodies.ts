export {
  buildLaravelSchemaFromRules,
  extractInlineValidationRules,
  parseFormRequestSchema,
} from "./request-rules";
export {
  extractLaravelManualRequestSchema,
  mergeLaravelRequestBodies,
} from "./request-manual";
import { normalizePhpClassName } from "./shared";

export function extractFirstRequestType(params: string): string | undefined {
  const paramMatches = params.split(",").map((entry) => entry.trim());
  for (const param of paramMatches) {
    const match = param.match(/([A-Za-z0-9_\\]+)\s+\$[A-Za-z0-9_]+/);
    if (match?.[1]) {
      return normalizePhpClassName(match[1]);
    }
  }

  return undefined;
}
