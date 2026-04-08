import {
  extractBalanced,
  findTopLevelTerminator,
  splitTopLevel,
  splitTopLevelSequence,
} from "../../core/parsing";
import type { SchemaObject } from "../../core/model";
import { parsePhpString, parsePhpStringList, singularize } from "./shared";

const unresolvedPhpExample = Symbol("unresolved-php-example");

export interface PhpExampleContext {
  assignments: Map<string, string>;
  cache: Map<string, unknown | typeof unresolvedPhpExample>;
  resolving: Set<string>;
  selfExample?: Record<string, unknown>;
  selfCollectionExample?: unknown[];
}

export function createPhpExampleContext(
  methodBody: string,
  seedAssignments?: Map<string, string>,
  selfExample?: Record<string, unknown>,
  selfCollectionExample?: unknown[],
): PhpExampleContext {
  const assignments = new Map(seedAssignments ?? []);
  for (const [variableName, expression] of extractPhpVariableAssignments(
    methodBody,
  )) {
    assignments.set(variableName, expression);
  }

  return {
    assignments,
    cache: new Map(),
    resolving: new Set(),
    selfExample,
    selfCollectionExample,
  };
}

export function parsePhpExampleValue(
  rawValue: string,
  context?: PhpExampleContext,
): unknown {
  const value = resolvePhpExampleValue(rawValue, context);
  return value === unresolvedPhpExample ? {} : value;
}

export function inferSchemaFromExample(example: unknown): SchemaObject {
  if (example === null || example === undefined) {
    return { nullable: true };
  }

  if (Array.isArray(example)) {
    return {
      type: "array",
      items:
        example.length > 0
          ? inferSchemaFromExample(example[0])
          : { type: "string" },
    };
  }

  switch (typeof example) {
    case "string":
      return { type: "string" };
    case "number":
      return Number.isInteger(example)
        ? { type: "integer" }
        : { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(example as Record<string, unknown>).map(
            ([key, value]) => [key, inferSchemaFromExample(value)],
          ),
        ),
      };
    default:
      return { type: "string" };
  }
}

function extractPhpVariableAssignments(
  methodBody: string,
): Map<string, string> {
  const assignments = new Map<string, string>();

  for (const match of methodBody.matchAll(
    /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g,
  )) {
    const variableName = match[1];
    const matchIndex = match.index ?? -1;
    if (!variableName || matchIndex < 0) {
      continue;
    }

    const equalsIndex = matchIndex + match[0].length - 1;
    const nextCharacter = methodBody[equalsIndex + 1];
    if (nextCharacter === "=" || nextCharacter === ">") {
      continue;
    }

    const statementEnd = findTopLevelTerminator(methodBody, equalsIndex + 1, [
      ";",
    ]);
    if (statementEnd < 0) {
      continue;
    }

    const expression = methodBody.slice(equalsIndex + 1, statementEnd).trim();
    if (!expression) {
      continue;
    }

    assignments.set(variableName, expression);
  }

  return assignments;
}

function resolvePhpExampleValue(
  rawValue: string,
  context?: PhpExampleContext,
): unknown | typeof unresolvedPhpExample {
  const value = unwrapPhpParentheses(rawValue.trim());
  if (!value) {
    return unresolvedPhpExample;
  }

  const nullCoalesceOperands = splitTopLevelSequence(value, "??");
  if (nullCoalesceOperands.length > 1) {
    for (const operand of nullCoalesceOperands) {
      const resolvedOperand = resolvePhpExampleValue(operand, context);
      if (
        resolvedOperand !== unresolvedPhpExample &&
        resolvedOperand !== null
      ) {
        return resolvedOperand;
      }
    }

    return null;
  }

  const stringValue = parsePhpString(value);
  if (stringValue !== undefined) {
    return stringValue;
  }

  if (value === "true" || value === "false") {
    return value === "true";
  }

  if (value === "null") {
    return null;
  }

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }

  const objectCastMatch = value.match(/^\(object\)\s*([\s\S]+)$/);
  if (objectCastMatch?.[1]) {
    return resolvePhpExampleValue(objectCastMatch[1], context);
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const entries = splitTopLevel(value.slice(1, -1), ",");
    const isAssoc = entries.some((entry) => hasTopLevelArrow(entry));

    if (!isAssoc) {
      return entries
        .filter(Boolean)
        .map((entry) => parsePhpExampleValue(entry, context));
    }

    return Object.fromEntries(
      entries
        .filter((entry) => hasTopLevelArrow(entry))
        .map((entry) => {
          const [rawKey, rawEntryValue] = splitTopLevelArrow(entry);
          const parsedKey = parsePhpString(rawKey.trim()) ?? rawKey.trim();
          return [
            String(parsedKey),
            parsePhpExampleValue(rawEntryValue, context),
          ];
        }),
    );
  }

  const directVariableMatch = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (directVariableMatch?.[1]) {
    return resolvePhpVariableExample(directVariableMatch[1], context);
  }

  const requestAccessorExample = inferLaravelRequestAccessorExample(value);
  if (requestAccessorExample !== unresolvedPhpExample) {
    return requestAccessorExample;
  }

  const collectionTransformExample = inferLaravelCollectionTransformExample(
    value,
    context,
  );
  if (collectionTransformExample !== unresolvedPhpExample) {
    return collectionTransformExample;
  }

  const propertyAccessMatch = value.match(
    /^\$([A-Za-z_][A-Za-z0-9_]*)->([A-Za-z_][A-Za-z0-9_]*)$/,
  );
  if (propertyAccessMatch?.[1] && propertyAccessMatch[2]) {
    const baseName = propertyAccessMatch[1];
    const propertyName = propertyAccessMatch[2];

    if (baseName === "this" && propertyName === "collection" && context?.selfCollectionExample) {
      return context.selfCollectionExample;
    }

    if (baseName === "this" && context?.selfExample?.[propertyName] !== undefined) {
      return context.selfExample[propertyName];
    }

    const baseValue = resolvePhpVariableExample(baseName, context);
    if (
      baseValue !== unresolvedPhpExample &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue) &&
      propertyName in baseValue
    ) {
      return (baseValue as Record<string, unknown>)[propertyName];
    }

    return buildPhpExampleForField(propertyName);
  }

  const arrayAccessMatch = value.match(
    /^\$([A-Za-z_][A-Za-z0-9_]*)\[['"]([^'"]+)['"]\]$/,
  );
  if (arrayAccessMatch?.[1] && arrayAccessMatch[2]) {
    const baseValue = resolvePhpVariableExample(arrayAccessMatch[1], context);
    const fieldName = arrayAccessMatch[2];

    if (
      baseValue !== unresolvedPhpExample &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue) &&
      fieldName in baseValue
    ) {
      return (baseValue as Record<string, unknown>)[fieldName];
    }

    return buildPhpExampleForField(fieldName);
  }

  return unresolvedPhpExample;
}

function resolvePhpVariableExample(
  variableName: string,
  context?: PhpExampleContext,
): unknown | typeof unresolvedPhpExample {
  if (!context) {
    return unresolvedPhpExample;
  }

  const cached = context.cache.get(variableName);
  if (cached !== undefined) {
    return cached;
  }

  if (context.resolving.has(variableName)) {
    return unresolvedPhpExample;
  }

  const expression = context.assignments.get(variableName);
  if (!expression) {
    return unresolvedPhpExample;
  }

  context.resolving.add(variableName);
  const resolved = resolvePhpExampleValue(expression, context);
  context.resolving.delete(variableName);
  context.cache.set(variableName, resolved);
  return resolved;
}

function inferLaravelRequestAccessorExample(
  rawValue: string,
): unknown | typeof unresolvedPhpExample {
  const value = rawValue.trim();
  const typedPatterns: Array<{
    regex: RegExp;
    type: "string" | "integer" | "number" | "boolean" | "array" | "date-time";
  }> = [
    {
      regex:
        /^(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:input|get|post|json|string|query|header)\s*\(\s*['"]([^'"]+)['"][\s\S]*\)$/,
      type: "string",
    },
    {
      regex:
        /^(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*integer\s*\(\s*['"]([^'"]+)['"][\s\S]*\)$/,
      type: "integer",
    },
    {
      regex:
        /^(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:float|double)\s*\(\s*['"]([^'"]+)['"][\s\S]*\)$/,
      type: "number",
    },
    {
      regex:
        /^(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*boolean\s*\(\s*['"]([^'"]+)['"][\s\S]*\)$/,
      type: "boolean",
    },
    {
      regex:
        /^(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:has|filled)\s*\(\s*['"]([^'"]+)['"][\s\S]*\)$/,
      type: "boolean",
    },
    {
      regex:
        /^(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:array|collect)\s*\(\s*['"]([^'"]+)['"][\s\S]*\)$/,
      type: "array",
    },
    {
      regex:
        /^(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*date\s*\(\s*['"]([^'"]+)['"][\s\S]*\)$/,
      type: "date-time",
    },
    {
      regex: /^request\s*\(\s*['"]([^'"]+)['"]\s*\)$/,
      type: "string",
    },
  ];

  for (const pattern of typedPatterns) {
    const match = value.match(pattern.regex);
    if (match?.[1]) {
      return buildPhpExampleForField(match[1], pattern.type);
    }
  }

  const onlyMatch = value.match(
    /^(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))(?:\s*->\s*safe\s*\(\s*\))?\s*->\s*only\s*\(\s*(\[[^\]]*\])\s*\)$/,
  );
  if (onlyMatch?.[1]) {
    return Object.fromEntries(
      parsePhpStringList(onlyMatch[1]).map((fieldName) => [
        fieldName,
        buildPhpExampleForField(fieldName),
      ]),
    );
  }

  return unresolvedPhpExample;
}

function inferLaravelCollectionTransformExample(
  rawValue: string,
  context?: PhpExampleContext,
): unknown | typeof unresolvedPhpExample {
  const parsedChain = parseLaravelCollectionTransformChain(rawValue);
  if (!parsedChain) {
    return unresolvedPhpExample;
  }

  const parsedCallback = parseLaravelCollectionTransformCallback(
    parsedChain.args,
  );
  if (!parsedCallback) {
    return unresolvedPhpExample;
  }

  let rest = parsedChain.rest;

  const filterCall = consumePhpChainCall(rest, "filter");
  if (filterCall) {
    rest = filterCall.rest;
  }

  const valuesCall = consumePhpChainCall(rest, "values");
  if (valuesCall) {
    if (valuesCall.args.trim()) {
      return unresolvedPhpExample;
    }

    rest = valuesCall.rest;
  }

  const finalizeCall =
    consumePhpChainCall(rest, "all") ?? consumePhpChainCall(rest, "toArray");
  if (finalizeCall) {
    if (finalizeCall.args.trim()) {
      return unresolvedPhpExample;
    }

    rest = finalizeCall.rest;
  }

  if (rest.trim()) {
    return unresolvedPhpExample;
  }

  const source = resolvePhpExampleValue(parsedChain.sourceExpression, context);
  if (!Array.isArray(source)) {
    return unresolvedPhpExample;
  }

  return source.map((item, index) => {
    const seedAssignments = new Map<string, string>([
      [parsedCallback.parameter, stringifyPhpExampleValue(item)],
    ]);
    if (parsedCallback.indexParameter) {
      seedAssignments.set(parsedCallback.indexParameter, String(index));
    }

    return parsePhpExampleValue(
      parsedCallback.expression,
      createPhpExampleContext("", seedAssignments),
    );
  });
}

function parseLaravelCollectionTransformChain(
  rawValue: string,
): { sourceExpression: string; args: string; rest: string } | null {
  const trimmed = rawValue.trim();

  const collectedSource = consumePhpCall(trimmed, "collect");
  if (collectedSource?.args) {
    const collectedTransform =
      consumePhpChainCall(collectedSource.rest, "map") ??
      consumePhpChainCall(collectedSource.rest, "through");
    if (collectedTransform?.args) {
      return {
        sourceExpression: collectedSource.args,
        args: collectedTransform.args,
        rest: collectedTransform.rest,
      };
    }
  }

  return consumePhpLeadingSourceChainCall(trimmed, ["map", "through"]);
}

function consumePhpCall(
  input: string,
  name: string,
): { args: string; rest: string } | null {
  const nameMatch = input.match(new RegExp(`^\\s*${name}\\s*`));
  const callPrefix = nameMatch?.[0];
  if (!callPrefix) {
    return null;
  }

  const openIndex = input.indexOf("(", callPrefix.length);
  if (openIndex < 0) {
    return null;
  }

  const call = extractBalanced(input, openIndex, "(", ")");
  if (!call) {
    return null;
  }

  return {
    args: call.slice(1, -1).trim(),
    rest: input.slice(openIndex + call.length),
  };
}

function consumePhpLeadingSourceChainCall(
  input: string,
  names: string[],
): { sourceExpression: string; args: string; rest: string } | null {
  const trimmed = input.trim();
  const chainMatch = findPhpTopLevelChainCall(trimmed, names);
  if (!chainMatch?.name) {
    return null;
  }

  const sourceExpression = trimmed.slice(0, chainMatch.index).trim();
  if (!sourceExpression) {
    return null;
  }

  const chainCall = consumePhpChainCall(trimmed.slice(chainMatch.index), chainMatch.name);
  if (!chainCall?.args) {
    return null;
  }

  return {
    sourceExpression,
    args: chainCall.args,
    rest: chainCall.rest,
  };
}

function consumePhpChainCall(
  input: string,
  name: string,
): { args: string; rest: string } | null {
  const chainMatch = input.match(new RegExp(`^\\s*->\\s*${name}\\s*`));
  const chainPrefix = chainMatch?.[0];
  if (!chainPrefix) {
    return null;
  }

  const openIndex = input.indexOf("(", chainPrefix.length);
  if (openIndex < 0) {
    return null;
  }

  const call = extractBalanced(input, openIndex, "(", ")");
  if (!call) {
    return null;
  }

  return {
    args: call.slice(1, -1).trim(),
    rest: input.slice(openIndex + call.length),
  };
}

function findPhpTopLevelChainCall(
  input: string,
  names: string[],
): { index: number; name: string } | null {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
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

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")") {
      parenDepth -= 1;
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
      continue;
    }

    if (character === "]") {
      bracketDepth -= 1;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
      continue;
    }

    if (character === "}") {
      braceDepth -= 1;
      continue;
    }

    if (parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0) {
      continue;
    }

    for (const name of names) {
      if (input.startsWith(`->${name}`, index)) {
        return { index, name };
      }
    }
  }

  return null;
}

function parseLaravelCollectionTransformCallback(
  rawCallback: string,
): { parameter: string; indexParameter?: string; expression: string } | null {
  const callback = rawCallback.trim();
  const arrowMatch = callback.match(
    /^fn\s*\(\s*([^)]*?)\s*\)\s*=>\s*([\s\S]+)$/,
  );
  const arrowSignature = arrowMatch?.[1];
  const arrowExpression = arrowMatch?.[2];
  const arrowParameters = arrowSignature
    ? extractLaravelCallbackParameters(arrowSignature)
    : [];
  if (arrowParameters[0] && arrowExpression) {
    return {
      parameter: arrowParameters[0],
      indexParameter: arrowParameters[1],
      expression: arrowExpression.trim(),
    };
  }

  const closureMatch = callback.match(
    /^function\s*\(\s*([^)]*?)\s*\)\s*(?:use\s*\([\s\S]*?\)\s*)?\{\s*return\s+([\s\S]+?);\s*\}$/,
  );
  const closureSignature = closureMatch?.[1];
  const closureExpression = closureMatch?.[2];
  const closureParameters = closureSignature
    ? extractLaravelCallbackParameters(closureSignature)
    : [];
  if (closureParameters[0] && closureExpression) {
    return {
      parameter: closureParameters[0],
      indexParameter: closureParameters[1],
      expression: closureExpression.trim(),
    };
  }

  return null;
}

function extractLaravelCallbackParameters(rawSignature: string): string[] {
  return splitTopLevel(rawSignature.trim(), ",")
    .map((parameter) => {
      const parameterMatch = parameter.trim().match(
        /^(?:[\w\\|&?]+\s+)?(?:&\s*)?(?:\.\.\.\s*)?\$([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*[\s\S]+)?$/,
      );
      return parameterMatch?.[1] ?? null;
    })
    .filter((parameter): parameter is string => Boolean(parameter));
}

function buildPhpExampleForField(
  fieldName: string,
  type:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "array"
    | "date-time" = "string",
): unknown {
  const normalized = fieldName.trim().toLowerCase();

  if (type === "integer") {
    return 1;
  }

  if (type === "number") {
    return 1.5;
  }

  if (type === "boolean") {
    return true;
  }

  if (type === "array") {
    return [buildPhpExampleForField(singularize(fieldName))];
  }

  if (type === "date-time") {
    return "2026-01-01T00:00:00Z";
  }

  if (normalized.includes("email")) {
    return "user@example.com";
  }

  if (normalized === "name") {
    return "Jane Doe";
  }

  if (normalized.includes("device")) {
    return "ios-simulator";
  }

  if (normalized.includes("token")) {
    return fieldName === fieldName.toUpperCase()
      ? `${fieldName}_VALUE`
      : "token";
  }

  if (normalized.includes("trace")) {
    return "trace_123";
  }

  if (normalized === "page" || normalized.endsWith("_page")) {
    return 1;
  }

  if (normalized === "id" || normalized.endsWith("_id")) {
    return 1;
  }

  if (
    normalized.includes("remember") ||
    normalized.startsWith("is_") ||
    normalized.startsWith("has_")
  ) {
    return true;
  }

  if (normalized.includes("scope")) {
    return "read";
  }

  if (normalized.includes("date") || normalized.endsWith("_at")) {
    return "2026-01-01T00:00:00Z";
  }

  return fieldName;
}

function stringifyPhpExampleValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stringifyPhpExampleValue(entry)).join(", ")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entryValue]) =>
        `'${key}' => ${stringifyPhpExampleValue(entryValue)}`,
    );
    return `[${entries.join(", ")}]`;
  }

  return "null";
}

function unwrapPhpParentheses(input: string): string {
  let current = input.trim();

  while (current.startsWith("(") && current.endsWith(")")) {
    const wrapped = extractBalanced(current, 0, "(", ")");
    if (wrapped !== current) {
      break;
    }

    current = current.slice(1, -1).trim();
  }

  return current;
}

function hasTopLevelArrow(input: string): boolean {
  return findTopLevelArrowIndex(input) >= 0;
}

function splitTopLevelArrow(input: string): [string, string] {
  const index = findTopLevelArrowIndex(input);
  if (index < 0) {
    return [input, ""];
  }

  return [input.slice(0, index), input.slice(index + 2)];
}

function findTopLevelArrowIndex(input: string): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < input.length - 1; index += 1) {
    const character = input[index];
    const nextCharacter = input[index + 1];

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

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")") {
      parenDepth -= 1;
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
      continue;
    }

    if (character === "]") {
      bracketDepth -= 1;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
      continue;
    }

    if (character === "}") {
      braceDepth -= 1;
      continue;
    }

    if (
      character === "=" &&
      nextCharacter === ">" &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}
