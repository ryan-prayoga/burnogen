import { promises as fs } from "node:fs";

import { dedupeResponsesByStatusCode } from "../../core/dedupe";
import { extractBalanced, splitTopLevel } from "../../core/parsing";
import type { NormalizedResponse, SchemaObject } from "../../core/model";
import {
  createPhpExampleContext,
  inferSchemaFromExample,
  parsePhpExampleValue,
  type PhpExampleContext,
} from "./examples";
import {
  type PhpFileContext,
  type LaravelResourceSchema,
  type PhpClassRecord,
  extractDirectReturnArrays,
  extractReturnArray,
  extractReturnStatements,
  findPhpMethod,
  parsePhpFileContext,
  parsePhpString,
  resolvePhpClassName,
  resolvePhpClassRecord,
} from "./shared";

export async function extractLaravelResourceResponses(
  methodBody: string,
  classIndex: Map<string, PhpClassRecord>,
  exampleContext: PhpExampleContext,
  fileContext?: PhpFileContext,
): Promise<NormalizedResponse[]> {
  const responses: NormalizedResponse[] = [];
  const returnStatements = extractReturnStatements(methodBody);

  for (const statement of returnStatements) {
    const parsedResourceReturn = parseLaravelResourceReturnStatement(
      statement,
      exampleContext,
    );
    if (!parsedResourceReturn) {
      continue;
    }

    const resourceResponse = await buildLaravelResourceResponse(
      parsedResourceReturn.resourceType,
      parsedResourceReturn.mode,
      classIndex,
      parsedResourceReturn.additional,
      parsedResourceReturn.additionalSchema,
      parsedResourceReturn.payload,
      parsedResourceReturn.statusCode,
      fileContext,
    );
    if (resourceResponse) {
      responses.push(resourceResponse);
    }
  }

  return dedupeResponsesByStatusCode(responses);
}

export async function extractLaravelWrappedJsonResourcePayload(
  payloadExpression: string,
  classIndex: Map<string, PhpClassRecord>,
  exampleContext: PhpExampleContext,
  fileContext?: PhpFileContext,
): Promise<{ schema: SchemaObject; example: unknown } | undefined> {
  const trimmed = payloadExpression.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }

  const entries = splitTopLevel(trimmed.slice(1, -1), ",");
  const exampleEntries: Array<[string, unknown]> = [];
  let foundResourceEntry = false;

  for (const entry of entries) {
    const arrowIndex = findLaravelTopLevelArrowIndex(entry);
    if (arrowIndex < 0) {
      return undefined;
    }

    const rawKey = entry.slice(0, arrowIndex).trim();
    const rawValue = entry.slice(arrowIndex + 2).trim();
    const key = parsePhpString(rawKey) ?? rawKey;

    const nestedResource = await resolveLaravelNestedResourceExample(
      rawValue,
      classIndex,
      exampleContext,
      fileContext,
    );
    if (nestedResource !== undefined) {
      foundResourceEntry = true;
      exampleEntries.push([String(key), nestedResource]);
      continue;
    }

    exampleEntries.push([
      String(key),
      parsePhpExampleValue(rawValue, exampleContext),
    ]);
  }

  if (!foundResourceEntry) {
    return undefined;
  }

  const example = Object.fromEntries(exampleEntries);
  return {
    schema: inferSchemaFromExample(example),
    example,
  };
}

async function buildLaravelResourceResponse(
  resourceType: string,
  mode: "single" | "collection",
  classIndex: Map<string, PhpClassRecord>,
  additional?: unknown,
  additionalSchemaHint?: SchemaObject,
  payload?: unknown,
  statusCode = "200",
  fileContext?: PhpFileContext,
): Promise<NormalizedResponse | undefined> {
  const resourceSchema = await parseLaravelResourceSchema(
    resourceType,
    classIndex,
    payload,
    fileContext,
  );
  if (!resourceSchema) {
    return undefined;
  }

  const additionalProperties =
    additional && typeof additional === "object" && !Array.isArray(additional)
      ? (additional as Record<string, unknown>)
      : undefined;
  const explicitAdditionalSchema = additionalProperties
    ? inferSchemaFromExample(additionalProperties)
    : undefined;
  const additionalSchema = mergeLaravelSchemaObjects(
    additionalSchemaHint,
    explicitAdditionalSchema,
  );
  const resolvedMode = resourceSchema.modeHint ?? mode;
  const baseSchema: SchemaObject =
    resourceSchema.responseSchema ??
    (resolvedMode === "collection"
      ? {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: resourceSchema.schema,
            },
          },
        }
      : {
          type: "object",
          properties: {
            data: resourceSchema.schema,
          },
        });
  const wrappedSchema = mergeLaravelSchemaObjects(baseSchema, additionalSchema) ?? baseSchema;
  const baseExample =
    resourceSchema.responseExample ??
    (resolvedMode === "collection"
      ? {
          data: resourceSchema.collectionExample ?? [resourceSchema.example],
        }
      : { data: resourceSchema.example });
  const wrappedExample =
    additionalProperties && isPlainLaravelResourceObject(baseExample)
      ? mergeLaravelResourceAdditional(baseExample, additionalProperties) ?? baseExample
      : baseExample;

  return {
    statusCode,
    description: "Inferred Laravel resource response",
    contentType: "application/json",
    schema: wrappedSchema,
    example: wrappedExample,
  };
}

async function resolveLaravelNestedResourceExample(
  expression: string,
  classIndex: Map<string, PhpClassRecord>,
  exampleContext: PhpExampleContext,
  fileContext?: PhpFileContext,
): Promise<unknown | undefined> {
  const parsedResource = parseLaravelResourceReturnStatement(
    `return ${expression};`,
    exampleContext,
  );
  if (!parsedResource) {
    return undefined;
  }

  const resourceSchema = await parseLaravelResourceSchema(
    parsedResource.resourceType,
    classIndex,
    parsedResource.payload,
    fileContext,
  );
  if (!resourceSchema) {
    return undefined;
  }

  return parsedResource.mode === "collection"
    ? resourceSchema.collectionExample ?? [resourceSchema.example]
    : resourceSchema.example;
}

async function parseLaravelResourceSchema(
  resourceType: string,
  classIndex: Map<string, PhpClassRecord>,
  payload?: unknown,
  fileContext?: PhpFileContext,
  seenResourceTypes = new Set<string>(),
): Promise<LaravelResourceSchema | undefined> {
  const resourceRecord = resolvePhpClassRecord(
    classIndex,
    resourceType,
    fileContext,
  );
  if (!resourceRecord) {
    return undefined;
  }

  if (seenResourceTypes.has(resourceRecord.fullName)) {
    return undefined;
  }

  const nextSeenResourceTypes = new Set(seenResourceTypes);
  nextSeenResourceTypes.add(resourceRecord.fullName);

  const content = await fs.readFile(resourceRecord.filePath, "utf8");
  const resourceFileContext = parsePhpFileContext(content);
  if (isLaravelResourceCollectionClass(content, resourceFileContext)) {
    return parseLaravelResourceCollectionSchema(
      content,
      resourceFileContext,
      classIndex,
      resourceRecord.fullName,
      payload,
      nextSeenResourceTypes,
    );
  }

  const toArrayMethod = findPhpMethod(content, "toArray");
  if (!toArrayMethod) {
    return undefined;
  }

  const arrayLiteral =
    extractDirectReturnArrays(toArrayMethod.body)[0] ??
    extractReturnArray(toArrayMethod.body);
  if (!arrayLiteral) {
    return undefined;
  }

  const example = parsePhpExampleValue(
    arrayLiteral,
    createPhpExampleContext(toArrayMethod.body, undefined, extractResourceSelfExample(payload)),
  );

  const collectionExample = Array.isArray(payload)
    ? payload
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
        .map((item) =>
          parsePhpExampleValue(
            arrayLiteral,
            createPhpExampleContext(toArrayMethod.body, undefined, item),
          ),
        )
    : undefined;

  return {
    schema: inferSchemaFromExample(example),
    example,
    collectionExample:
      collectionExample && collectionExample.length > 0
        ? collectionExample
        : undefined,
  };
}

async function parseLaravelResourceCollectionSchema(
  content: string,
  resourceFileContext: PhpFileContext,
  classIndex: Map<string, PhpClassRecord>,
  collectionType: string,
  payload: unknown,
  seenResourceTypes: Set<string>,
): Promise<LaravelResourceSchema | undefined> {
  const collectedResourceType = extractLaravelCollectedResourceType(
    content,
    resourceFileContext,
    classIndex,
    collectionType,
  );
  const collectedResourceSchema = collectedResourceType
    ? await parseLaravelResourceSchema(
      collectedResourceType,
      classIndex,
      payload,
      resourceFileContext,
      seenResourceTypes,
    )
    : undefined;
  const itemSchema = collectedResourceSchema?.schema ?? { type: "object" };
  const itemExample = collectedResourceSchema?.example ?? {};
  const collectionExample =
    collectedResourceSchema?.collectionExample &&
    collectedResourceSchema.collectionExample.length > 0
      ? collectedResourceSchema.collectionExample
      : [itemExample];
  const toArrayMethod = findPhpMethod(content, "toArray");
  const arrayLiteral = toArrayMethod
    ? extractDirectReturnArrays(toArrayMethod.body)[0] ??
      extractReturnArray(toArrayMethod.body)
    : null;

  if (!toArrayMethod || !arrayLiteral) {
    return {
      schema: itemSchema,
      example: itemExample,
      collectionExample,
      modeHint: "collection",
    };
  }

  const responseExample = parsePhpExampleValue(
    arrayLiteral,
    createPhpExampleContext(
      toArrayMethod.body,
      undefined,
      undefined,
      collectionExample,
    ),
  );

  return {
    schema: itemSchema,
    example: itemExample,
    collectionExample,
    modeHint: "collection",
    responseSchema: inferSchemaFromExample(responseExample),
    responseExample,
  };
}

function isLaravelResourceCollectionClass(
  content: string,
  fileContext: PhpFileContext,
): boolean {
  const extendsMatch = content.match(
    /class\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+([A-Za-z0-9_\\]+)/,
  );
  if (!extendsMatch?.[1]) {
    return false;
  }

  const resolvedParent = resolvePhpClassName(extendsMatch[1], fileContext);
  return resolvedParent === "Illuminate\\Http\\Resources\\Json\\ResourceCollection" ||
    resolvedParent.endsWith("\\ResourceCollection") ||
    resolvedParent === "ResourceCollection";
}

function extractLaravelCollectedResourceType(
  content: string,
  fileContext: PhpFileContext,
  classIndex: Map<string, PhpClassRecord>,
  collectionType: string,
): string | undefined {
  const collectsMatch = content.match(
    /(?:public|protected|private)\s+(?:[A-Za-z_][A-Za-z0-9_\\|?]+\s+)?\$collects\s*=\s*([^;]+);/,
  );
  if (collectsMatch?.[1]) {
    const rawCollects = collectsMatch[1].trim();
    const classLikeValue = rawCollects.match(/^([A-Za-z0-9_\\]+)(?:::class)?$/)?.[1];
    if (classLikeValue) {
      return resolvePhpClassName(classLikeValue, fileContext);
    }
  }

  const collectsMethod = findPhpMethod(content, "collects");
  if (collectsMethod) {
    const returnExpression = collectsMethod.body.match(/return\s+([^;]+);/)?.[1]?.trim();
    const classLikeValue = returnExpression?.match(/^([A-Za-z0-9_\\]+)(?:::class)?$/)?.[1];
    if (classLikeValue) {
      return resolvePhpClassName(classLikeValue, fileContext);
    }
  }

  return inferLaravelCollectedResourceTypeFromName(classIndex, collectionType);
}

function inferLaravelCollectedResourceTypeFromName(
  classIndex: Map<string, PhpClassRecord>,
  collectionType: string,
): string | undefined {
  if (!collectionType.endsWith("Collection")) {
    return undefined;
  }

  const baseCandidate = collectionType.slice(0, -("Collection".length));
  const resourceCandidate = `${baseCandidate}Resource`;

  return classIndex.has(baseCandidate)
    ? baseCandidate
    : classIndex.has(resourceCandidate)
      ? resourceCandidate
      : undefined;
}

function parseLaravelResourceReturnStatement(
  statement: string,
  exampleContext: PhpExampleContext,
):
  | {
      resourceType: string;
      mode: "single" | "collection";
      additional?: unknown;
      additionalSchema?: SchemaObject;
      payload?: unknown;
      statusCode?: string;
    }
  | undefined {
  const wrappedJsonCall = parseLaravelResponseJsonResourceStatement(
    statement,
    exampleContext,
  );
  if (wrappedJsonCall) {
    return wrappedJsonCall;
  }

  const responseChainCall = parseLaravelResourceResponseChainStatement(
    statement,
    exampleContext,
  );
  if (responseChainCall) {
    return responseChainCall;
  }

  const newResourceMatch = statement.match(
    /^return\s+new\s+([A-Za-z0-9_\\]+)\s*\(/,
  );
  if (newResourceMatch?.[1]) {
    const rawPayload = extractLaravelResourcePayloadExpression(statement);
    const inferredCollection = rawPayload
      ? inferLaravelPaginatorCollection(rawPayload, exampleContext)
      : undefined;
    const explicitAdditional = extractLaravelResourceAdditional(
      statement,
      exampleContext,
    );
    return {
      resourceType: newResourceMatch[1],
      mode: "single",
      additional: mergeLaravelResourceAdditional(
        inferredCollection?.additional,
        explicitAdditional,
      ),
      additionalSchema: inferredCollection?.additionalSchema,
      statusCode: "200",
      payload: inferredCollection?.payload ?? (rawPayload
        ? parsePhpExampleValue(rawPayload, exampleContext)
        : undefined),
    };
  }

  const factoryMatch = statement.match(
    /^return\s+([A-Za-z0-9_\\]+)::(make|collection)\s*\(/,
  );
  if (factoryMatch?.[1] && factoryMatch[2]) {
    const mode = factoryMatch[2] === "collection" ? "collection" : "single";
    const rawPayload = extractLaravelResourcePayloadExpression(statement);
    const explicitAdditional = extractLaravelResourceAdditional(
      statement,
      exampleContext,
    );
    const inferredCollection = mode === "collection" && rawPayload
      ? inferLaravelPaginatorCollection(rawPayload, exampleContext)
      : undefined;

    return {
      resourceType: factoryMatch[1],
      mode,
      additional: mergeLaravelResourceAdditional(
        inferredCollection?.additional,
        explicitAdditional,
      ),
      additionalSchema: inferredCollection?.additionalSchema,
      statusCode: "200",
      payload: inferredCollection?.payload ??
        (rawPayload ? parsePhpExampleValue(rawPayload, exampleContext) : undefined),
    };
  }

  return undefined;
}

export function isLaravelResourceResponseExpression(expression: string): boolean {
  return Boolean(
    expression.trim().match(
      /^(?:new\s+[A-Za-z0-9_\\]+|[A-Za-z0-9_\\]+::(?:make|collection))\s*\(/,
    ),
  );
}

function parseLaravelResponseJsonResourceStatement(
  statement: string,
  exampleContext: PhpExampleContext,
):
  | {
      resourceType: string;
      mode: "single" | "collection";
      additional?: unknown;
      additionalSchema?: SchemaObject;
      payload?: unknown;
      statusCode?: string;
    }
  | undefined {
  const wrappedMatch = statement.match(/^return\s+response\(\)->json\s*\(/);
  if (!wrappedMatch) {
    return undefined;
  }

  const openParenIndex = statement.indexOf("(", wrappedMatch[0].length - 1);
  const argsBlock =
    openParenIndex >= 0
      ? extractBalanced(statement, openParenIndex, "(", ")")
      : null;
  if (!argsBlock) {
    return undefined;
  }

  const args = splitTopLevel(argsBlock.slice(1, -1), ",");
  const payloadExpression = args[0]?.trim();
  if (!payloadExpression || !isLaravelResourceResponseExpression(payloadExpression)) {
    return undefined;
  }

  const parsedResourceExpression = parseLaravelResourceReturnStatement(
    `return ${payloadExpression};`,
    exampleContext,
  );
  if (!parsedResourceExpression) {
    return undefined;
  }

  return {
    ...parsedResourceExpression,
    statusCode: inferLaravelResourceStatusCode(args[1], exampleContext) ?? "200",
  };
}

function parseLaravelResourceResponseChainStatement(
  statement: string,
  exampleContext: PhpExampleContext,
):
  | {
      resourceType: string;
      mode: "single" | "collection";
      additional?: unknown;
      additionalSchema?: SchemaObject;
      payload?: unknown;
      statusCode?: string;
    }
  | undefined {
  const statementBody = statement.trim().replace(/;\s*$/, "");
  const responseIndex = statementBody.indexOf("->response(");
  if (!statementBody.startsWith("return ") || responseIndex < 0) {
    return undefined;
  }

  const resourceExpression = statementBody
    .slice("return ".length, responseIndex)
    .trim();
  if (!isLaravelResourceResponseExpression(resourceExpression)) {
    return undefined;
  }

  const responseOpenParenIndex = statementBody.indexOf(
    "(",
    responseIndex + "->response".length,
  );
  const responseArgsBlock =
    responseOpenParenIndex >= 0
      ? extractBalanced(statementBody, responseOpenParenIndex, "(", ")")
      : null;
  if (!responseArgsBlock) {
    return undefined;
  }

  let rest = statementBody
    .slice(responseOpenParenIndex + responseArgsBlock.length)
    .trim();
  let statusCode = "200";

  while (rest) {
    if (rest.startsWith("->setStatusCode(")) {
      const statusOpenParenIndex = rest.indexOf("(");
      const statusArgsBlock =
        statusOpenParenIndex >= 0
          ? extractBalanced(rest, statusOpenParenIndex, "(", ")")
          : null;
      if (!statusArgsBlock) {
        return undefined;
      }

      const statusArgs = splitTopLevel(statusArgsBlock.slice(1, -1), ",");
      statusCode =
        inferLaravelResourceStatusCode(statusArgs[0], exampleContext) ?? statusCode;
      rest = rest.slice(statusOpenParenIndex + statusArgsBlock.length).trim();
      continue;
    }

    if (rest.startsWith("->header(") || rest.startsWith("->withHeaders(")) {
      const headerOpenParenIndex = rest.indexOf("(");
      const headerArgsBlock =
        headerOpenParenIndex >= 0
          ? extractBalanced(rest, headerOpenParenIndex, "(", ")")
          : null;
      if (!headerArgsBlock) {
        return undefined;
      }

      rest = rest.slice(headerOpenParenIndex + headerArgsBlock.length).trim();
      continue;
    }

    return undefined;
  }

  const parsedResourceExpression = parseLaravelResourceReturnStatement(
    `return ${resourceExpression};`,
    exampleContext,
  );
  if (!parsedResourceExpression) {
    return undefined;
  }

  return {
    ...parsedResourceExpression,
    statusCode,
  };
}

function inferLaravelResourceStatusCode(
  rawStatus: string | undefined,
  exampleContext: PhpExampleContext,
): string | undefined {
  if (!rawStatus) {
    return undefined;
  }

  const parsed = parsePhpExampleValue(rawStatus, exampleContext);
  if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
    return String(parsed);
  }

  const literal = parsePhpString(rawStatus.trim());
  if (literal && /^\d+$/.test(literal)) {
    return literal;
  }

  return rawStatus.trim().match(/^\d{3}$/)?.[0] || undefined;
}

function findLaravelTopLevelArrowIndex(input: string): number {
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
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      character === "=" &&
      nextCharacter === ">"
    ) {
      return index;
    }
  }

  return -1;
}

function extractLaravelResourceAdditional(
  statement: string,
  exampleContext: PhpExampleContext,
): Record<string, unknown> | undefined {
  const additionalIndex = statement.indexOf("->additional(");
  if (additionalIndex < 0) {
    return undefined;
  }

  const openParenIndex = statement.indexOf(
    "(",
    additionalIndex + "->additional".length,
  );
  const argsBlock =
    openParenIndex >= 0
      ? extractBalanced(statement, openParenIndex, "(", ")")
      : null;
  if (!argsBlock) {
    return undefined;
  }

  const firstArg = splitTopLevel(argsBlock.slice(1, -1), ",")[0]?.trim();
  if (!firstArg) {
    return undefined;
  }

  const additional = parsePhpExampleValue(firstArg, exampleContext);
  return additional &&
    typeof additional === "object" &&
    !Array.isArray(additional)
    ? (additional as Record<string, unknown>)
    : undefined;
}

function extractLaravelResourcePayloadExpression(
  statement: string,
): string | undefined {
  const resourceIndex = statement.search(
    /return\s+(?:new\s+[A-Za-z0-9_\\]+|[A-Za-z0-9_\\]+::(?:make|collection))\s*\(/,
  );
  if (resourceIndex < 0) {
    return undefined;
  }

  const openParenIndex = statement.indexOf("(", resourceIndex);
  const argsBlock =
    openParenIndex >= 0
      ? extractBalanced(statement, openParenIndex, "(", ")")
      : null;
  if (!argsBlock) {
    return undefined;
  }

  const firstArg = splitTopLevel(argsBlock.slice(1, -1), ",")[0]?.trim();
  return firstArg || undefined;
}

function extractResourceSelfExample(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  if (Array.isArray(payload)) {
    const firstItem = payload.find(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    );
    return firstItem as Record<string, unknown> | undefined;
  }

  return undefined;
}

function inferLaravelPaginatorCollection(
  rawPayload: string,
  exampleContext: PhpExampleContext,
):
  | {
      payload: unknown[];
      additional: Record<string, unknown>;
      additionalSchema: SchemaObject;
    }
  | undefined {
  const resolvedExpression = resolveLaravelPayloadExpression(
    rawPayload,
    exampleContext,
  );
  if (!resolvedExpression) {
    return undefined;
  }

  const paginatorCall = extractLaravelPaginatorCall(resolvedExpression);
  if (!paginatorCall) {
    return undefined;
  }

  const args = splitTopLevel(paginatorCall.argsBlock.slice(1, -1), ",");
  const perPage = coercePositiveInteger(
    parsePhpExampleValue(args[0] ?? "", exampleContext),
  ) ?? 15;

  switch (paginatorCall.method) {
    case "paginate":
      return {
        payload: [],
        additional: buildLengthAwarePaginationExample(
          perPage,
          args[2],
          args[3],
          exampleContext,
        ),
        additionalSchema: buildLengthAwarePaginationSchema(),
      };
    case "simplePaginate":
      return {
        payload: [],
        additional: buildSimplePaginationExample(
          perPage,
          args[2],
          args[3],
          exampleContext,
        ),
        additionalSchema: buildSimplePaginationSchema(),
      };
    case "cursorPaginate":
      return {
        payload: [],
        additional: buildCursorPaginationExample(
          perPage,
          args[2],
          args[3],
          exampleContext,
        ),
        additionalSchema: buildCursorPaginationSchema(),
      };
    default:
      return undefined;
  }
}

function resolveLaravelPayloadExpression(
  rawPayload: string,
  exampleContext: PhpExampleContext,
  seenVariables = new Set<string>(),
): string | undefined {
  const trimmed = rawPayload.trim();
  if (!trimmed) {
    return undefined;
  }

  const variableMatch = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!variableMatch?.[1]) {
    return trimmed;
  }

  if (seenVariables.has(variableMatch[1])) {
    return undefined;
  }

  seenVariables.add(variableMatch[1]);
  const assignedExpression = exampleContext.assignments.get(variableMatch[1]);
  if (!assignedExpression) {
    return undefined;
  }

  return resolveLaravelPayloadExpression(
    assignedExpression,
    exampleContext,
    seenVariables,
  ) ?? assignedExpression.trim();
}

function extractLaravelPaginatorCall(
  expression: string,
):
  | {
      method: "paginate" | "simplePaginate" | "cursorPaginate";
      argsBlock: string;
    }
  | undefined {
  const paginatorMatches = [
    ...expression.matchAll(/->(paginate|simplePaginate|cursorPaginate)\s*\(/g),
  ];
  const lastMatch = paginatorMatches.at(-1);
  if (!lastMatch?.[1] || lastMatch.index === undefined) {
    return undefined;
  }

  const method = lastMatch[1] as
    | "paginate"
    | "simplePaginate"
    | "cursorPaginate";

  const openParenIndex = expression.indexOf(
    "(",
    lastMatch.index + lastMatch[0].length - 1,
  );
  const argsBlock =
    openParenIndex >= 0
      ? extractBalanced(expression, openParenIndex, "(", ")")
      : null;
  if (!argsBlock) {
    return undefined;
  }

  return {
    method,
    argsBlock,
  };
}

function buildLengthAwarePaginationExample(
  perPage: number,
  rawPageName: string | undefined,
  rawPageValue: string | undefined,
  exampleContext: PhpExampleContext,
): Record<string, unknown> {
  const currentPage = parsePaginatorPosition(rawPageValue, exampleContext, 1);
  const pageName = parsePhpString(rawPageName ?? "") ?? "page";
  const total = 1;
  const lastPage = Math.max(currentPage, Math.ceil(total / perPage));

  return {
    meta: {
      current_page: currentPage,
      from: 1,
      last_page: lastPage,
      per_page: perPage,
      to: total,
      total,
    },
    links: {
      first: buildPaginatorLink(pageName, 1),
      last: buildPaginatorLink(pageName, lastPage),
      prev: currentPage > 1
        ? buildPaginatorLink(pageName, currentPage - 1)
        : null,
      next: currentPage < lastPage
        ? buildPaginatorLink(pageName, currentPage + 1)
        : null,
    },
  };
}

function buildSimplePaginationExample(
  perPage: number,
  rawPageName: string | undefined,
  rawPageValue: string | undefined,
  exampleContext: PhpExampleContext,
): Record<string, unknown> {
  const currentPage = parsePaginatorPosition(rawPageValue, exampleContext, 1);
  const pageName = parsePhpString(rawPageName ?? "") ?? "page";

  return {
    meta: {
      current_page: currentPage,
      from: 1,
      per_page: perPage,
      to: 1,
    },
    links: {
      prev: currentPage > 1
        ? buildPaginatorLink(pageName, currentPage - 1)
        : null,
      next: buildPaginatorLink(pageName, currentPage + 1),
    },
  };
}

function buildCursorPaginationExample(
  perPage: number,
  rawCursorName: string | undefined,
  rawCursorValue: string | undefined,
  exampleContext: PhpExampleContext,
): Record<string, unknown> {
  const cursorName = parsePhpString(rawCursorName ?? "") ?? "cursor";
  const currentCursor = rawCursorValue
    ? parsePhpExampleValue(rawCursorValue, exampleContext)
    : undefined;

  return {
    meta: {
      per_page: perPage,
    },
    links: {
      prev: currentCursor ? `?${cursorName}=prev_cursor` : null,
      next: `?${cursorName}=next_cursor`,
    },
  };
}

function buildLengthAwarePaginationSchema(): SchemaObject {
  return {
    type: "object",
    properties: {
      meta: {
        type: "object",
        properties: {
          current_page: { type: "integer" },
          from: { type: "integer" },
          last_page: { type: "integer" },
          per_page: { type: "integer" },
          to: { type: "integer" },
          total: { type: "integer" },
        },
      },
      links: {
        type: "object",
        properties: {
          first: { type: "string" },
          last: { type: "string" },
          prev: { type: "string", nullable: true },
          next: { type: "string", nullable: true },
        },
      },
    },
  };
}

function buildSimplePaginationSchema(): SchemaObject {
  return {
    type: "object",
    properties: {
      meta: {
        type: "object",
        properties: {
          current_page: { type: "integer" },
          from: { type: "integer" },
          per_page: { type: "integer" },
          to: { type: "integer" },
        },
      },
      links: {
        type: "object",
        properties: {
          prev: { type: "string", nullable: true },
          next: { type: "string", nullable: true },
        },
      },
    },
  };
}

function buildCursorPaginationSchema(): SchemaObject {
  return {
    type: "object",
    properties: {
      meta: {
        type: "object",
        properties: {
          per_page: { type: "integer" },
        },
      },
      links: {
        type: "object",
        properties: {
          prev: { type: "string", nullable: true },
          next: { type: "string", nullable: true },
        },
      },
    },
  };
}

function parsePaginatorPosition(
  rawValue: string | undefined,
  exampleContext: PhpExampleContext,
  fallback: number,
): number {
  const parsedValue = coercePositiveInteger(
    parsePhpExampleValue(rawValue ?? "", exampleContext),
  );
  return parsedValue ?? fallback;
}

function buildPaginatorLink(name: string, value: number): string {
  return `?${name}=${value}`;
}

function coercePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function mergeLaravelResourceAdditional(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  const merged = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (
      isPlainLaravelResourceObject(merged[key]) &&
      isPlainLaravelResourceObject(value)
    ) {
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...value,
      };
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function isPlainLaravelResourceObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeLaravelSchemaObjects(
  base: SchemaObject | undefined,
  override: SchemaObject | undefined,
): SchemaObject | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  const merged: SchemaObject = {
    ...base,
    ...override,
    type: override.type ?? base.type,
    format: override.format ?? base.format,
    nullable: override.nullable ?? base.nullable,
    enum: override.enum ?? base.enum,
    description: override.description ?? base.description,
    required: override.required ?? base.required,
    items: override.items
      ? mergeLaravelSchemaObjects(base.items, override.items)
      : base.items,
    additionalProperties:
      typeof override.additionalProperties === "object" &&
      !Array.isArray(override.additionalProperties)
        ? mergeLaravelSchemaObjects(
          typeof base.additionalProperties === "object" &&
            !Array.isArray(base.additionalProperties)
            ? base.additionalProperties
            : undefined,
          override.additionalProperties,
        )
        : override.additionalProperties ?? base.additionalProperties,
  };

  if (base.properties || override.properties) {
    merged.properties = mergeLaravelSchemaPropertyMaps(
      base.properties,
      override.properties,
    );
  }

  return merged;
}

function mergeLaravelSchemaPropertyMaps(
  base: Record<string, SchemaObject> | undefined,
  override: Record<string, SchemaObject> | undefined,
): Record<string, SchemaObject> | undefined {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  const mergedEntries = new Map<string, SchemaObject>();

  for (const [key, value] of Object.entries(base)) {
    mergedEntries.set(key, value);
  }

  for (const [key, value] of Object.entries(override)) {
    mergedEntries.set(
      key,
      mergeLaravelSchemaObjects(mergedEntries.get(key), value) ?? value,
    );
  }

  return Object.fromEntries(mergedEntries);
}
