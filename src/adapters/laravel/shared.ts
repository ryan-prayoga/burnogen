import { extractBalanced, findTopLevelTerminator } from "../../core/parsing";
import { defaultStatusForMethod } from "../../core/responses";
import type {
  GenerationWarning,
  HttpMethod,
  NormalizedEndpoint,
  NormalizedParameter,
  NormalizedRequestBody,
  NormalizedResponse,
  SchemaObject,
} from "../../core/model";

export interface PhpClassRecord {
  shortName: string;
  fullName: string;
  filePath: string;
}

export interface GroupContext {
  prefixes: string[];
  middleware: string[];
  controller?: string;
}

export interface ControllerAnalysis {
  requestBody?: NormalizedRequestBody;
  queryParameters: NormalizedParameter[];
  headerParameters: NormalizedParameter[];
  responses: NormalizedResponse[];
  warnings: GenerationWarning[];
}

export interface LaravelResourceSchema {
  schema: SchemaObject;
  example: unknown;
  collectionExample?: unknown[];
}

export interface ParsedHandler {
  controller?: string;
  action?: string;
}

export interface PhpFileContext {
  namespace?: string;
  imports: Map<string, string>;
}

export function extractReturnArray(methodBody: string): string | null {
  const returnMatch = methodBody.match(/return\s+\[/);
  if (!returnMatch?.index && returnMatch?.index !== 0) {
    return null;
  }

  const startIndex = methodBody.indexOf("[", returnMatch.index);
  return startIndex >= 0
    ? extractBalancedBracket(methodBody, startIndex)
    : null;
}

export function extractReturnStatements(methodBody: string): string[] {
  const statements: string[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const returnIndex = methodBody.indexOf("return", offset);
    if (returnIndex < 0) {
      break;
    }

    const statementEnd = findTopLevelTerminator(methodBody, returnIndex, [";"]);
    if (statementEnd < 0) {
      break;
    }

    statements.push(methodBody.slice(returnIndex, statementEnd + 1).trim());
    offset = statementEnd + 1;
  }

  return statements;
}

export function extractDirectReturnArrays(methodBody: string): string[] {
  const results: string[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const returnIndex = methodBody.indexOf("return [", offset);
    if (returnIndex < 0) {
      break;
    }

    const openBracketIndex = methodBody.indexOf("[", returnIndex);
    const arrayBlock =
      openBracketIndex >= 0
        ? extractBalancedBracket(methodBody, openBracketIndex)
        : null;
    if (!arrayBlock) {
      break;
    }

    results.push(arrayBlock);
    offset = openBracketIndex + arrayBlock.length;
  }

  return results;
}

export function findPhpMethod(
  content: string,
  methodName: string,
): { params: string[]; rawParams: string; body: string } | undefined {
  const methodMatch = new RegExp(
    `function\\s+${methodName}\\s*\\(([^)]*)\\)`,
    "m",
  ).exec(content);
  if (!methodMatch) {
    return undefined;
  }

  const bodyStartIndex = content.indexOf("{", methodMatch.index);
  const body =
    bodyStartIndex >= 0
      ? extractBalanced(content, bodyStartIndex, "{", "}")
      : null;
  if (!body) {
    return undefined;
  }

  return {
    params: extractPhpParamNames(methodMatch[1] ?? ""),
    rawParams: methodMatch[1] ?? "",
    body,
  };
}

export function mergeGroupContexts(contexts: GroupContext[]): GroupContext {
  return contexts.reduce<GroupContext>(
    (accumulator, context) => ({
      prefixes: [...accumulator.prefixes, ...context.prefixes],
      middleware: [...accumulator.middleware, ...context.middleware],
      controller: context.controller ?? accumulator.controller,
    }),
    { prefixes: [], middleware: [] },
  );
}

export function joinRoutePath(prefixes: string[], rawPath: string): string {
  const segments = [...prefixes, rawPath]
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);

  return `/${segments.join("/")}`.replace(/\/+/g, "/");
}

export function normalizeLaravelPath(pathname: string): string {
  return (
    pathname
      .replace(/\{([^}:]+):[^}]+\}/g, "{$1}")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "") || "/"
  );
}

export function extractPathParameters(pathname: string): NormalizedParameter[] {
  const matches = [...pathname.matchAll(/\{([^}]+)\}/g)];
  return matches.map((match) => ({
    name: match[1],
    in: "path" as const,
    required: true,
    schema: { type: "string" as const },
  }));
}

export function buildOperationId(
  method: HttpMethod,
  pathname: string,
  handler?: ParsedHandler,
): string {
  if (handler?.controller && handler.action) {
    return `${camelCase(buildControllerOperationStem(handler.controller))}${capitalize(handler.action)}`;
  }

  const cleanPath = pathname
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .map(capitalize)
    .join("");
  return `${method}${cleanPath || "Root"}`;
}

export function buildSummary(
  method: HttpMethod,
  pathname: string,
  handler?: ParsedHandler,
): string {
  if (handler?.action && handler.controller) {
    return `${buildControllerDisplayName(handler.controller)}::${handler.action}`;
  }

  return `${method.toUpperCase()} ${pathname}`;
}

export function inferTag(pathname: string, controller?: string): string {
  if (controller) {
    return buildControllerTag(controller);
  }

  return pathname.split("/").filter(Boolean)[0] ?? "default";
}

export function buildDefaultResponses(method: HttpMethod): NormalizedResponse[] {
  return [
    {
      statusCode: defaultStatusForMethod(method),
      description: "Generated default response",
    },
  ];
}

export function extractRouteChainCalls(
  statement: string,
): Array<{ name: string; value: string }> {
  const results: Array<{ name: string; value: string }> = [];
  const regex = /(?:Route::|->)(prefix|middleware|controller|name)\(([^)]*)\)/g;

  for (const match of statement.matchAll(regex)) {
    if (match[1] && match[2] !== undefined) {
      results.push({ name: match[1], value: match[2] });
    }
  }

  return results;
}

export function parsePhpStringList(input: string): string[] {
  const matches = [...input.matchAll(/['"]([^'"]+)['"]/g)];
  return matches.map((match) => match[1]).filter(Boolean);
}

export function parsePhpString(input: string): string | undefined {
  const match = input.trim().match(/^['"](.+?)['"]$/);
  return match?.[1];
}

export function collectLaravelRouteStatement(
  lines: string[],
  startLine: number,
): { value: string; lastLine: number; braceDelta: number } {
  let value = lines[startLine]?.trim() ?? "";
  let lastLine = startLine;
  let braceDelta = countBraceDelta(lines[startLine] ?? "");

  while (lastLine + 1 < lines.length && !isCompleteLaravelRouteStatement(value)) {
    lastLine += 1;
    value = `${value}\n${lines[lastLine].trim()}`;
    braceDelta += countBraceDelta(lines[lastLine] ?? "");
  }

  return { value, lastLine, braceDelta };
}

export function parsePhpFileContext(content: string): PhpFileContext {
  return {
    namespace: parsePhpNamespace(content),
    imports: parsePhpUseImports(content),
  };
}

export function parsePhpNamespace(content: string): string | undefined {
  return content.match(/^\s*namespace\s+([^;]+);/m)?.[1]?.trim();
}

export function parsePhpUseImports(content: string): Map<string, string> {
  const imports = new Map<string, string>();

  for (const match of content.matchAll(/^\s*use\s+(?!function\b|const\b)([^;]+);/gm)) {
    const rawStatement = match[1]?.trim();
    if (!rawStatement || rawStatement.includes("{")) {
      continue;
    }

    for (const part of rawStatement.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }

      const importMatch = trimmed.match(
        /^([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/i,
      );
      if (!importMatch?.[1]) {
        continue;
      }

      const fullName = normalizePhpClassName(importMatch[1]);
      const alias = importMatch[2] ?? shortPhpClassName(fullName);
      imports.set(alias, fullName);
    }
  }

  return imports;
}

export function resolvePhpClassName(
  input: string,
  fileContext?: PhpFileContext,
): string {
  const normalized = normalizePhpClassName(input);
  if (!normalized) {
    return normalized;
  }

  if (normalized.includes("\\")) {
    return normalized;
  }

  const imported = fileContext?.imports.get(normalized);
  if (imported) {
    return imported;
  }

  if (fileContext?.namespace) {
    return `${fileContext.namespace}\\${normalized}`;
  }

  return normalized;
}

export function resolvePhpClassRecord(
  classIndex: Map<string, PhpClassRecord>,
  input: string,
  fileContext?: PhpFileContext,
): PhpClassRecord | undefined {
  const resolvedName = resolvePhpClassName(input, fileContext);
  return classIndex.get(resolvedName) ?? classIndex.get(shortPhpClassName(resolvedName));
}

export function normalizePhpClassName(input: string): string {
  return input.trim().replace(/^\\+/, "").replace(/::class$/, "");
}

export function shortPhpClassName(input: string): string {
  const cleaned = normalizePhpClassName(input);
  const parts = cleaned.split("\\");
  return parts[parts.length - 1];
}

function buildControllerDisplayName(controller: string): string {
  const parts = normalizedControllerParts(controller);
  return parts.join("\\");
}

function buildControllerOperationStem(controller: string): string {
  return normalizedControllerParts(controller).join(" ");
}

function buildControllerTag(controller: string): string {
  const parts = normalizedControllerParts(controller);
  return parts
    .map((part, index) =>
      index === parts.length - 1
        ? part.replace(/Controller$/, "")
        : part,
    )
    .join("");
}

function normalizedControllerParts(controller: string): string[] {
  const parts = normalizePhpClassName(controller).split("\\").filter(Boolean);
  const controllerIndex = parts.lastIndexOf("Controllers");
  const relevantParts =
    controllerIndex >= 0 ? parts.slice(controllerIndex + 1) : parts;

  return relevantParts.length > 0 ? relevantParts : [shortPhpClassName(controller)];
}

export function countBraceDelta(input: string): number {
  let delta = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of input) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "'" || character === '"') {
      if (quote === character) {
        quote = null;
      } else if (!quote) {
        quote = character;
      }
      continue;
    }

    if (quote) {
      continue;
    }

    if (character === "{") {
      delta += 1;
    }

    if (character === "}") {
      delta -= 1;
    }
  }

  return delta;
}

export function splitOnce(input: string, delimiter: string): [string, string] {
  const index = input.indexOf(delimiter);
  if (index < 0) {
    return [input, ""];
  }

  return [input.slice(0, index), input.slice(index + delimiter.length)];
}

export function dedupeStrings(values: string[]): string[] | undefined {
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function singularize(input: string): string {
  if (input.endsWith("ies")) {
    return `${input.slice(0, -3)}y`;
  }

  if (input.endsWith("s") && input.length > 1) {
    return input.slice(0, -1);
  }

  return input;
}

export function camelCase(input: string): string {
  const clean = input.replace(/[^a-zA-Z0-9]+/g, " ");
  return clean
    .split(" ")
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : capitalize(part.toLowerCase()),
    )
    .join("");
}

export function capitalize(input: string): string {
  return input ? `${input[0].toUpperCase()}${input.slice(1)}` : input;
}

function extractPhpParamNames(params: string): string[] {
  return params
    .split(",")
    .map((param) => param.trim().match(/\$([A-Za-z_][A-Za-z0-9_]*)/)?.[1])
    .filter((value): value is string => Boolean(value));
}

function isCompleteLaravelRouteStatement(statement: string): boolean {
  if (statement.includes("->group(function")) {
    return statement.includes("{");
  }

  return findTopLevelTerminator(statement, 0, [";"]) >= 0;
}

function extractBalancedBracket(
  input: string,
  startIndex: number,
): string | null {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = startIndex; index < input.length; index += 1) {
    const character = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      if (quote === character) {
        quote = null;
      } else if (!quote) {
        quote = character;
      }
      continue;
    }

    if (quote) {
      continue;
    }

    if (character === "[") {
      depth += 1;
      continue;
    }

    if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}
