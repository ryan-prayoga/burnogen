import path from "node:path";
import { promises as fs } from "node:fs";

import { listFiles } from "../core/fs";
import type {
  GenerationWarning,
  HttpMethod,
  NormalizedAuth,
  NormalizedEndpoint,
  NormalizedParameter,
  NormalizedProject,
  NormalizedRequestBody,
  NormalizedResponse,
  SchemaObject,
  SupportedFramework,
} from "../core/model";

interface GoFile {
  filePath: string;
  content: string;
  packageName: string;
}

interface GoFunctionRecord {
  name: string;
  receiverType?: string;
  body: string;
  filePath: string;
}

interface GoFieldRecord {
  fieldName: string;
  typeName: string;
  tags: Record<string, string>;
}

interface GoStructRecord {
  name: string;
  packageName: string;
  fields: GoFieldRecord[];
}

interface GoGroupContext {
  prefix: string;
  middleware: string[];
}

interface GoHandlerAnalysis {
  requestBody?: NormalizedRequestBody;
  queryParameters: NormalizedParameter[];
  headerParameters: NormalizedParameter[];
  responses: NormalizedResponse[];
  warnings: GenerationWarning[];
}

interface GoExampleContext {
  assignments: Map<string, string>;
  cache: Map<string, unknown>;
  resolving: Set<string>;
}

const methodToResponseStatus: Record<HttpMethod, string> = {
  get: "200",
  post: "201",
  put: "200",
  patch: "200",
  delete: "204",
  head: "200",
  options: "200",
};

export async function scanGoProject(
  root: string,
  framework: Extract<SupportedFramework, "gin" | "fiber" | "echo">,
  projectName: string,
  projectVersion: string,
): Promise<NormalizedProject> {
  const files = await loadGoFiles(root);
  const functionIndex = buildGoFunctionIndex(files);
  const structIndex = buildGoStructIndex(files);
  const endpoints: NormalizedEndpoint[] = [];
  const warnings: GenerationWarning[] = [];
  const handlerCache = new Map<string, GoHandlerAnalysis>();

  for (const file of files) {
    const parsed = parseRoutesFromGoFile(file, framework, functionIndex, structIndex, handlerCache);
    endpoints.push(...parsed.endpoints);
    warnings.push(...parsed.warnings);
  }

  return {
    framework,
    projectName,
    projectVersion,
    endpoints,
    warnings,
  };
}

async function loadGoFiles(root: string): Promise<GoFile[]> {
  const filePaths = await listFiles(
    root,
    (filePath) => filePath.endsWith(".go"),
    { ignoreDirectories: ["vendor", "node_modules", ".git", "dist"] },
  );

  const files: GoFile[] = [];
  for (const filePath of filePaths) {
    files.push({
      filePath,
      content: await fs.readFile(filePath, "utf8"),
      packageName: extractGoPackageName(await fs.readFile(filePath, "utf8")),
    });
  }

  return files;
}

function buildGoFunctionIndex(files: GoFile[]): Map<string, GoFunctionRecord[]> {
  const index = new Map<string, GoFunctionRecord[]>();
  const regex = /func\s*(\(([^)]*)\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:\([^)]*\)|[A-Za-z0-9_\*\[\]\.]+)?\s*\{/g;

  for (const file of files) {
    for (const match of file.content.matchAll(regex)) {
      const fullMatch = match[0];
      const receiver = match[2];
      const functionName = match[3];
      if (!functionName) {
        continue;
      }

      const braceStart = (match.index ?? 0) + fullMatch.length - 1;
      const body = extractBalanced(file.content, braceStart, "{", "}");
      if (!body) {
        continue;
      }

      const receiverType = receiver ? normalizeGoReceiver(receiver) : undefined;
      const key = receiverType ? `${receiverType}.${functionName}` : functionName;
      const existing = index.get(key) ?? [];
      existing.push({
        name: functionName,
        receiverType,
        body,
        filePath: file.filePath,
      });
      index.set(key, existing);

      if (key !== functionName) {
        const genericBucket = index.get(functionName) ?? [];
        genericBucket.push({
          name: functionName,
          receiverType,
          body,
          filePath: file.filePath,
        });
        index.set(functionName, genericBucket);
      }
    }
  }

  return index;
}

function buildGoStructIndex(files: GoFile[]): Map<string, GoStructRecord> {
  const index = new Map<string, GoStructRecord>();
  const regex = /type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{/g;

  for (const file of files) {
    for (const match of file.content.matchAll(regex)) {
      const structName = match[1];
      if (!structName) {
        continue;
      }

      const braceStart = file.content.indexOf("{", match.index);
      const structBlock = braceStart >= 0 ? extractBalanced(file.content, braceStart, "{", "}") : null;
      if (!structBlock) {
        continue;
      }

      const record = {
        name: structName,
        packageName: file.packageName,
        fields: parseGoStructFields(structBlock),
      };

      index.set(`${file.packageName}.${structName}`, record);
      if (!index.has(structName)) {
        index.set(structName, record);
      }
    }
  }

  return index;
}

function parseGoStructFields(structBlock: string): GoFieldRecord[] {
  const lines = structBlock.slice(1, -1).split(/\r?\n/);
  const fields: GoFieldRecord[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([^\s`]+)(?:\s+`([^`]+)`)?/);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    fields.push({
      fieldName: match[1],
      typeName: match[2],
      tags: parseGoTags(match[3] ?? ""),
    });
  }

  return fields;
}

function parseGoTags(rawTags: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const match of rawTags.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]*)"/g)) {
    if (match[1] && match[2] !== undefined) {
      tags[match[1]] = match[2];
    }
  }
  return tags;
}

function parseRoutesFromGoFile(
  file: GoFile,
  framework: Extract<SupportedFramework, "gin" | "fiber" | "echo">,
  functionIndex: Map<string, GoFunctionRecord[]>,
  structIndex: Map<string, GoStructRecord>,
  handlerCache: Map<string, GoHandlerAnalysis>,
): { endpoints: NormalizedEndpoint[]; warnings: GenerationWarning[]; } {
  const endpoints: NormalizedEndpoint[] = [];
  const warnings: GenerationWarning[] = [];
  const groups = new Map<string, GoGroupContext>();
  const lines = file.content.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) {
      continue;
    }

    const groupMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z_][A-Za-z0-9_]*)\.Group\(\s*"([^"]*)"(?:\s*,\s*(.+))?\)$/);
    if (groupMatch?.[1] && groupMatch[2] && groupMatch[3] !== undefined) {
      const groupName = groupMatch[1];
      const parentName = groupMatch[2];
      const parent = groups.get(parentName) ?? { prefix: "", middleware: [] };
      groups.set(groupName, {
        prefix: joinRoutePath(parent.prefix, groupMatch[3]),
        middleware: [...parent.middleware, ...extractIdentifiers(groupMatch[4] ?? "")],
      });
      continue;
    }

    const useMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\.Use\((.+)\)$/);
    if (useMatch?.[1] && useMatch[2]) {
      const current = groups.get(useMatch[1]) ?? { prefix: "", middleware: [] };
      groups.set(useMatch[1], {
        prefix: current.prefix,
        middleware: [...current.middleware, ...extractIdentifiers(useMatch[2])],
      });
      continue;
    }

    const routeMatch = matchGoRoute(line, framework);
    if (!routeMatch) {
      continue;
    }

    const group = groups.get(routeMatch.receiver) ?? { prefix: "", middleware: [] };
    const fullPath = normalizeGoPath(joinRoutePath(group.prefix, routeMatch.path));
    const handlerAnalysis = analyzeGoHandler(routeMatch.handler, functionIndex, structIndex, handlerCache);
    const allMiddleware = [...group.middleware, ...extractIdentifiers(routeMatch.middleware)];
    const parameters = [
      ...extractPathParameters(fullPath),
      ...handlerAnalysis.queryParameters.filter((parameter) => !fullPath.includes(`{${parameter.name}}`)),
      ...handlerAnalysis.headerParameters,
    ];

    endpoints.push({
      id: `${routeMatch.method}:${fullPath}`,
      method: routeMatch.method,
      path: fullPath,
      operationId: buildGoOperationId(routeMatch, fullPath),
      summary: `${routeMatch.method.toUpperCase()} ${fullPath}`,
      tags: [inferTag(fullPath)],
      parameters,
      requestBody: handlerAnalysis.requestBody,
      responses: handlerAnalysis.responses.length > 0 ? handlerAnalysis.responses : buildDefaultResponses(routeMatch.method),
      auth: inferAuthFromMiddleware(allMiddleware),
      source: {
        file: file.filePath,
        line: index + 1,
      },
      warnings: handlerAnalysis.warnings,
    });

    warnings.push(...handlerAnalysis.warnings);
  }

  return { endpoints, warnings };
}

function matchGoRoute(
  line: string,
  framework: Extract<SupportedFramework, "gin" | "fiber" | "echo">,
): { receiver: string; method: HttpMethod; path: string; handler: string; middleware: string; } | null {
  const regex = framework === "fiber"
    ? /^([A-Za-z_][A-Za-z0-9_]*)\.(Get|Post|Put|Patch|Delete|Head|Options)\(\s*"([^"]+)"\s*,\s*(.+)\)$/
    : /^([A-Za-z_][A-Za-z0-9_]*)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(\s*"([^"]+)"\s*,\s*(.+)\)$/
  ;
  const match = line.match(regex);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
    return null;
  }

  const argumentsList = splitTopLevel(match[4], ",");
  if (argumentsList.length === 0) {
    return null;
  }

  const handler = framework === "echo"
    ? argumentsList[0]
    : argumentsList[argumentsList.length - 1];
  const middlewareArguments = framework === "echo"
    ? argumentsList.slice(1)
    : argumentsList.slice(0, -1);

  return {
    receiver: match[1],
    method: match[2].toLowerCase() as HttpMethod,
    path: match[3],
    handler: handler.trim(),
    middleware: middlewareArguments.join(", ").trim(),
  };
}

function analyzeGoHandler(
  handlerReference: string,
  functionIndex: Map<string, GoFunctionRecord[]>,
  structIndex: Map<string, GoStructRecord>,
  handlerCache: Map<string, GoHandlerAnalysis>,
): GoHandlerAnalysis {
  if (handlerReference.startsWith("func(")) {
    return {
      queryParameters: [],
      headerParameters: [],
      responses: [],
      warnings: [],
    };
  }

  const cacheKey = handlerReference;
  const cached = handlerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const handlerName = normalizeGoHandlerReference(handlerReference);
  const functionRecord = resolveGoFunction(handlerName, functionIndex);

  if (!functionRecord) {
    const warning = {
      code: "GO_HANDLER_NOT_FOUND",
      message: `Could not locate handler ${handlerReference} while inferring request schema.`,
    };
    const result = { queryParameters: [], headerParameters: [], responses: [], warnings: [warning] };
    handlerCache.set(cacheKey, result);
    return result;
  }

  const queryParameters = extractGoQueryParameters(functionRecord.body);
  const headerParameters = extractGoHeaderParameters(functionRecord.body);
  const responses = extractGoResponses(functionRecord.body);

  const variableTypes = new Map<string, string>();
  for (const declaration of functionRecord.body.matchAll(/var\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_\.\*\[\]]*)/g)) {
    if (declaration[1] && declaration[2]) {
      variableTypes.set(declaration[1], declaration[2].replace(/^\*/, ""));
    }
  }

  for (const declaration of functionRecord.body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z_][A-Za-z0-9_\.]*)\{\s*\}/g)) {
    if (declaration[1] && declaration[2]) {
      variableTypes.set(declaration[1], declaration[2].replace(/^\*/, ""));
    }
  }

  const bindMatch = functionRecord.body.match(/(?:ShouldBindJSON|BindJSON|ShouldBind|Bind|BodyParser)\(\s*&([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
  if (!bindMatch?.[1]) {
    const result = { queryParameters, headerParameters, responses, warnings: [] };
    handlerCache.set(cacheKey, result);
    return result;
  }

  const variableName = bindMatch[1];
  const structName = variableTypes.get(variableName);
  if (!structName) {
    const warning = {
      code: "GO_STRUCT_NOT_INFERRED",
      message: `Could not infer request struct for handler ${handlerReference}.`,
      location: { file: functionRecord.filePath },
    };
    const result = { queryParameters, headerParameters, responses, warnings: [warning] };
    handlerCache.set(cacheKey, result);
    return result;
  }

  const structInfo = resolveGoStruct(structName.replace(/^\*/, ""), structIndex);
  if (!structInfo) {
    const warning = {
      code: "GO_STRUCT_NOT_FOUND",
      message: `Could not locate struct ${structName} while inferring request schema.`,
      location: { file: functionRecord.filePath },
    };
    const result = { queryParameters, headerParameters, responses, warnings: [warning] };
    handlerCache.set(cacheKey, result);
    return result;
  }

  const built = buildSchemaFromGoStruct(structInfo.name, structIndex, new Set());
  const result: GoHandlerAnalysis = {
    requestBody: built.bodyProperties ? {
      contentType: "application/json",
      schema: {
        type: "object",
        properties: built.bodyProperties,
        required: built.bodyRequired.length > 0 ? built.bodyRequired : undefined,
      },
    } : undefined,
    queryParameters: dedupeParameters([...queryParameters, ...built.queryParameters]),
    headerParameters: dedupeParameters(headerParameters),
    responses,
    warnings: [],
  };

  handlerCache.set(cacheKey, result);
  return result;
}

function buildSchemaFromGoStruct(
  structName: string,
  structIndex: Map<string, GoStructRecord>,
  seen: Set<string>,
): { bodyProperties?: Record<string, SchemaObject>; bodyRequired: string[]; queryParameters: NormalizedParameter[]; } {
  if (seen.has(structName)) {
    return { bodyProperties: {}, bodyRequired: [], queryParameters: [] };
  }

  seen.add(structName);
  const structInfo = structIndex.get(structName);
  if (!structInfo) {
    return { bodyProperties: {}, bodyRequired: [], queryParameters: [] };
  }

  const bodyProperties: Record<string, SchemaObject> = {};
  const bodyRequired: string[] = [];
  const queryParameters: NormalizedParameter[] = [];

  for (const field of structInfo.fields) {
    const jsonTag = stripGoTagOptions(field.tags.json);
    const queryTag = stripGoTagOptions(field.tags.query);
    const formTag = stripGoTagOptions(field.tags.form);
    const uriTag = stripGoTagOptions(field.tags.uri || field.tags.param);
    const required = isGoFieldRequired(field.tags);
    const schema = schemaFromGoType(field.typeName, structIndex, seen);

    if (uriTag && uriTag !== "-") {
      queryParameters.push({
        name: uriTag,
        in: "path",
        required: true,
        schema,
      });
      continue;
    }

    if (queryTag && queryTag !== "-") {
      queryParameters.push({
        name: queryTag,
        in: "query",
        required,
        schema,
      });
      continue;
    }

    const bodyName = jsonTag && jsonTag !== "-"
      ? jsonTag
      : formTag && formTag !== "-"
        ? formTag
        : lowerFirst(field.fieldName);

    if (bodyName === "-") {
      continue;
    }

    bodyProperties[bodyName] = schema;
    if (required) {
      bodyRequired.push(bodyName);
    }
  }

  return { bodyProperties, bodyRequired, queryParameters };
}

function schemaFromGoType(
  rawType: string,
  structIndex: Map<string, GoStructRecord>,
  seen: Set<string>,
): SchemaObject {
  const typeName = rawType.replace(/^\*/, "");

  if (typeName.startsWith("[]")) {
    return {
      type: "array",
      items: schemaFromGoType(typeName.slice(2), structIndex, seen),
    };
  }

  switch (typeName) {
    case "string":
      return { type: "string" };
    case "bool":
      return { type: "boolean" };
    case "int":
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "uint":
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
      return { type: "integer" };
    case "float32":
    case "float64":
      return { type: "number" };
    case "time.Time":
      return { type: "string", format: "date-time" };
    default:
      break;
  }

  const structRecord = resolveGoStruct(typeName, structIndex);
  if (structRecord) {
    const nested = buildSchemaFromGoStruct(
      `${structRecord.packageName}.${structRecord.name}`,
      structIndex,
      new Set(seen),
    );
    return {
      type: "object",
      properties: nested.bodyProperties,
      required: nested.bodyRequired.length > 0 ? nested.bodyRequired : undefined,
    };
  }

  return { type: "string" };
}

function stripGoTagOptions(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(",")[0]?.trim();
}

function isGoFieldRequired(tags: Record<string, string>): boolean {
  const combined = [tags.binding, tags.validate].filter(Boolean).join(",");
  return /\brequired\b/i.test(combined);
}

function resolveGoFunction(
  handlerReference: string,
  functionIndex: Map<string, GoFunctionRecord[]>,
): GoFunctionRecord | undefined {
  const direct = functionIndex.get(handlerReference);
  if (direct?.[0]) {
    return direct[0];
  }

  const methodName = handlerReference.split(".").pop();
  if (!methodName) {
    return undefined;
  }

  const candidates = functionIndex.get(methodName) ?? [];
  return candidates[0];
}

function resolveGoStruct(
  typeName: string,
  structIndex: Map<string, GoStructRecord>,
): GoStructRecord | undefined {
  return structIndex.get(typeName) ?? structIndex.get(typeName.split(".").pop() ?? typeName);
}

function normalizeGoHandlerReference(input: string): string {
  return input.replace(/&/g, "").trim();
}

function normalizeGoReceiver(receiver: string): string {
  const parts = receiver.trim().split(/\s+/);
  const typeName = parts[parts.length - 1] ?? "";
  return typeName.replace(/^\*/, "");
}

function normalizeGoPath(pathname: string): string {
  return pathname
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
    .replace(/\*([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function extractPathParameters(pathname: string): NormalizedParameter[] {
  return [...pathname.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

function buildGoOperationId(
  route: { method: HttpMethod; handler: string; },
  pathname: string,
): string {
  const cleanHandler = normalizeGoHandlerReference(route.handler).replace(/[^a-zA-Z0-9.]/g, "");
  if (cleanHandler) {
    return cleanHandler.replace(/\./g, "");
  }

  const pathPart = pathname.replace(/[{}]/g, "").split("/").filter(Boolean).map(capitalize).join("");
  return `${route.method}${pathPart || "Root"}`;
}

function inferAuthFromMiddleware(middleware: string[]): NormalizedAuth {
  const joined = middleware.join(" ");
  if (/auth|jwt|token|bearer|oauth|protected/i.test(joined)) {
    return { type: "bearer" };
  }

  return { type: "none" };
}

function inferTag(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? "default";
}

function buildDefaultResponses(method: HttpMethod): NormalizedResponse[] {
  return [{
    statusCode: methodToResponseStatus[method],
    description: "Generated default response",
  }];
}

function extractGoQueryParameters(body: string): NormalizedParameter[] {
  return [...body.matchAll(/\.\s*Query\(\s*"([^"]+)"/g)].map((match) => ({
    name: match[1],
    in: "query",
    required: false,
    schema: { type: "string" },
  }));
}

function extractGoHeaderParameters(body: string): NormalizedParameter[] {
  return [...body.matchAll(/\.\s*(?:Get|GetHeader)\(\s*"([^"]+)"/g)].map((match) => ({
    name: match[1],
    in: "header",
    required: false,
    schema: { type: "string" },
  }));
}

function extractGoResponses(body: string): NormalizedResponse[] {
  const responses = new Map<string, NormalizedResponse>();
  const exampleContext = createGoExampleContext(body);

  for (const args of extractMethodCallArguments(body, "SuccessResponse")) {
    if (args.length < 3) {
      continue;
    }

    const message = parseGoStringLiteral(args[1]) ?? "Success";
    const data = buildGoExpressionExample(args[2], exampleContext);
    responses.set("200", buildResponseWrapper("200", message, data, ""));
  }

  for (const args of extractMethodCallArguments(body, "ErrorResponse")) {
    if (args.length < 5) {
      continue;
    }

    const statusCode = parseGoStatusCode(args[1]);
    if (!statusCode) {
      continue;
    }

    const message = parseGoStringLiteral(args[2]) ?? "Error";
    const data = buildGoExpressionExample(args[3], exampleContext);
    const errorDetail = parseGoStringLiteral(args[4]) ?? "Error";
    if (!responses.has(statusCode)) {
      responses.set(statusCode, buildResponseWrapper(statusCode, message, data, errorDetail));
    }
  }

  for (const args of extractMethodCallArguments(body, "InternalErrorResponse")) {
    if (args.length < 3) {
      continue;
    }

    const message = parseGoStringLiteral(args[1]) ?? "Internal server error";
    const errorDetail = parseGoStringLiteral(args[2]) ?? "Internal server error";
    if (!responses.has("500")) {
      responses.set("500", buildResponseWrapper("500", message, null, errorDetail));
    }
  }

  for (const args of extractMethodCallArguments(body, "JSON")) {
    if (args.length < 2) {
      continue;
    }

    const statusCode = parseGoStatusCode(args[0]) ?? "200";
    const example = buildGoExpressionExample(args[1], exampleContext);
    if (!responses.has(statusCode)) {
      responses.set(statusCode, {
        statusCode,
        description: "Inferred JSON response",
        contentType: "application/json",
        schema: inferSchemaFromExample(example),
        example,
      });
    }
  }

  for (const args of extractMethodCallArguments(body, "NoContent")) {
    if (args.length < 1) {
      continue;
    }

    const statusCode = parseGoStatusCode(args[0]) ?? "204";
    if (!responses.has(statusCode)) {
      responses.set(statusCode, {
        statusCode,
        description: "Inferred empty response",
      });
    }
  }

  return [...responses.values()];
}

function buildResponseWrapper(
  statusCode: string,
  message: string,
  data: unknown,
  errorDetail: string,
): NormalizedResponse {
  return {
    statusCode,
    description: message,
    contentType: "application/json",
    schema: {
      type: "object",
      properties: {
        code: { type: "integer" },
        message: { type: "string" },
        data: inferSchemaFromExample(data),
        error: { type: "string", nullable: true },
      },
      required: ["code", "message", "data", "error"],
    },
    example: {
      code: Number.parseInt(statusCode, 10),
      message,
      data,
      error: errorDetail,
    },
  };
}

function inferSchemaFromExample(example: unknown): SchemaObject {
  if (example === null || example === undefined) {
    return { nullable: true };
  }

  if (Array.isArray(example)) {
    return {
      type: "array",
      items: example.length > 0 ? inferSchemaFromExample(example[0]) : { type: "string" },
    };
  }

  switch (typeof example) {
    case "string":
      return { type: "string" };
    case "number":
      return Number.isInteger(example) ? { type: "integer" } : { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(example as Record<string, unknown>).map(([key, value]) => [key, inferSchemaFromExample(value)]),
        ),
      };
    default:
      return { type: "string" };
  }
}

function extractMethodCallArguments(body: string, methodName: string): string[][] {
  const results: string[][] = [];
  let offset = 0;

  while (offset < body.length) {
    const callIndex = body.indexOf(`${methodName}(`, offset);
    if (callIndex < 0) {
      break;
    }

    const openParenIndex = body.indexOf("(", callIndex);
    const argsBlock = openParenIndex >= 0 ? extractBalanced(body, openParenIndex, "(", ")") : null;
    if (!argsBlock) {
      break;
    }

    results.push(splitTopLevel(argsBlock.slice(1, -1), ","));
    offset = openParenIndex + argsBlock.length;
  }

  return results;
}

function parseGoStatusCode(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const statusMap: Record<string, string> = {
    "fiber.StatusOK": "200",
    "fiber.StatusBadRequest": "400",
    "fiber.StatusUnauthorized": "401",
    "fiber.StatusForbidden": "403",
    "fiber.StatusNotFound": "404",
    "fiber.StatusCreated": "201",
    "fiber.StatusInternalServerError": "500",
    "http.StatusOK": "200",
    "http.StatusCreated": "201",
    "http.StatusNoContent": "204",
    "http.StatusBadRequest": "400",
    "http.StatusUnauthorized": "401",
    "http.StatusForbidden": "403",
    "http.StatusNotFound": "404",
    "http.StatusUnprocessableEntity": "422",
    "http.StatusInternalServerError": "500",
  };

  return statusMap[trimmed];
}

function parseGoStringLiteral(expression: string): string | undefined {
  const match = expression.trim().match(/^"([\s\S]*)"$/);
  return match?.[1];
}

function buildGoExpressionExample(expression: string, context?: GoExampleContext): unknown {
  const trimmed = expression.trim();

  if (trimmed === "nil") {
    return null;
  }

  const stringLiteral = parseGoStringLiteral(trimmed);
  if (stringLiteral !== undefined) {
    return stringLiteral;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }

  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }

  const requestAccessorExample = inferGoRequestAccessorExample(trimmed);
  if (requestAccessorExample !== undefined) {
    return requestAccessorExample;
  }

  const identifierMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*$/);
  if (identifierMatch?.[0]) {
    const resolved = resolveGoVariableExample(identifierMatch[0], context);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  const selectorMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (selectorMatch?.[1]) {
    return buildGoFieldExample(selectorMatch[1]);
  }

  const mapBlock = extractGoMapLiteral(trimmed);
  if (mapBlock) {
    return parseGoMapExample(mapBlock, context);
  }

  if (/^\[\]/.test(trimmed)) {
    const literalStart = trimmed.indexOf("{");
    const arrayBlock = literalStart >= 0 ? extractBalanced(trimmed, literalStart, "{", "}") : null;
    if (!arrayBlock) {
      return [];
    }

    return splitTopLevel(arrayBlock.slice(1, -1), ",")
      .filter(Boolean)
      .map((entry) => buildGoExpressionExample(entry, context));
  }

  return {};
}

function parseGoMapExample(mapBlock: string, context?: GoExampleContext): Record<string, unknown> {
  const block = mapBlock.trim();
  if (!block.startsWith("{") || !block.endsWith("}")) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const entry of splitTopLevel(block.slice(1, -1), ",")) {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const key = parseGoStringLiteral(entry.slice(0, separatorIndex));
    if (!key) {
      continue;
    }

    result[key] = buildGoExpressionExample(entry.slice(separatorIndex + 1), context);
  }

  return result;
}

function createGoExampleContext(body: string): GoExampleContext {
  return {
    assignments: extractGoVariableAssignments(body),
    cache: new Map(),
    resolving: new Set(),
  };
}

function extractGoVariableAssignments(body: string): Map<string, string> {
  const assignments = new Map<string, string>();

  for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*/g)) {
    const variableName = match[1];
    const startIndex = match.index ?? -1;
    if (!variableName || startIndex < 0) {
      continue;
    }

    const equalsIndex = body.indexOf(":=", startIndex);
    const endIndex = findGoStatementTerminator(body, equalsIndex + 2);
    if (equalsIndex < 0 || endIndex < 0) {
      continue;
    }

    assignments.set(variableName, body.slice(equalsIndex + 2, endIndex).trim());
  }

  return assignments;
}

function resolveGoVariableExample(name: string, context?: GoExampleContext): unknown {
  if (!context) {
    return undefined;
  }

  if (context.cache.has(name)) {
    return context.cache.get(name);
  }

  if (context.resolving.has(name)) {
    return undefined;
  }

  const expression = context.assignments.get(name);
  if (!expression) {
    return undefined;
  }

  context.resolving.add(name);
  const resolved = buildGoExpressionExample(expression, context);
  context.resolving.delete(name);
  context.cache.set(name, resolved);
  return resolved;
}

function inferGoRequestAccessorExample(expression: string): unknown {
  const queryMatch = expression.match(/\.\s*Query\(\s*"([^"]+)"/);
  if (queryMatch?.[1]) {
    return buildGoFieldExample(queryMatch[1]);
  }

  const paramMatch = expression.match(/\.\s*Param\(\s*"([^"]+)"/);
  if (paramMatch?.[1]) {
    return buildGoFieldExample(paramMatch[1]);
  }

  const headerMatch = expression.match(/\.\s*(?:Get|GetHeader)\(\s*"([^"]+)"/);
  if (headerMatch?.[1]) {
    return buildGoFieldExample(headerMatch[1]);
  }

  return undefined;
}

function buildGoFieldExample(fieldName: string): unknown {
  const normalized = fieldName.trim().toLowerCase();

  if (normalized.includes("email")) {
    return "user@example.com";
  }

  if (normalized === "name") {
    return "Jane Doe";
  }

  if (normalized.includes("customer")) {
    return "customer_123";
  }

  if (normalized === "age" || normalized.endsWith("_age") || normalized === "total") {
    return 1;
  }

  if (normalized === "page" || normalized.endsWith("_page")) {
    return 1;
  }

  if (normalized === "id" || normalized.endsWith("_id")) {
    return 1;
  }

  if (normalized.includes("token")) {
    return fieldName === fieldName.toUpperCase() ? `${fieldName}_VALUE` : "token";
  }

  if (normalized.startsWith("is_") || normalized.startsWith("has_")) {
    return true;
  }

  return fieldName;
}

function extractGoMapLiteral(expression: string): string | null {
  const trimmed = expression.trim();

  const mapPrefixes = [
    "fiber.Map",
    "gin.H",
    "map[string]any",
    "map[string]interface{}",
  ];

  for (const prefix of mapPrefixes) {
    if (!trimmed.startsWith(prefix)) {
      continue;
    }

    const literalStart = trimmed.indexOf("{", prefix.length);
    if (literalStart < 0) {
      continue;
    }

    return extractBalanced(trimmed, literalStart, "{", "}");
  }

  return null;
}

function dedupeParameters(parameters: NormalizedParameter[]): NormalizedParameter[] {
  const seen = new Set<string>();
  return parameters.filter((parameter) => {
    const key = `${parameter.in}:${parameter.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function joinRoutePath(prefix: string, rawPath: string): string {
  const segments = [prefix, rawPath]
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return `/${segments.join("/")}`.replace(/\/+/g, "/");
}

function extractIdentifiers(input: string): string[] {
  return [...input.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)]
    .map((match) => match[0])
    .filter((identifier) => !["func", "return", "nil", "error"].includes(identifier));
}

function extractGoPackageName(content: string): string {
  const match = content.match(/^package\s+([A-Za-z_][A-Za-z0-9_]*)/m);
  return match?.[1] ?? "main";
}

function lowerFirst(input: string): string {
  return input ? `${input[0].toLowerCase()}${input.slice(1)}` : input;
}

function capitalize(input: string): string {
  return input ? `${input[0].toUpperCase()}${input.slice(1)}` : input;
}

function extractBalanced(input: string, startIndex: number, open: string, close: string): string | null {
  let depth = 0;
  let quote: "'" | "\"" | "`" | null = null;
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

    if (character === "'" || character === "\"" || character === "`") {
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

    if (character === open) {
      depth += 1;
    }

    if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return input.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function splitTopLevel(input: string, separator: string): string[] {
  const results: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;

  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }

    if (character === "'" || character === "\"" || character === "`") {
      if (quote === character) {
        quote = null;
      } else if (!quote) {
        quote = character;
      }
      current += character;
      continue;
    }

    if (!quote) {
      if (character === "(") {
        parenDepth += 1;
      } else if (character === ")") {
        parenDepth -= 1;
      } else if (character === "[") {
        bracketDepth += 1;
      } else if (character === "]") {
        bracketDepth -= 1;
      } else if (character === "{") {
        braceDepth += 1;
      } else if (character === "}") {
        braceDepth -= 1;
      } else if (
        character === separator &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        if (current.trim()) {
          results.push(current.trim());
        }
        current = "";
        continue;
      }
    }

    current += character;
  }

  if (current.trim()) {
    results.push(current.trim());
  }

  return results;
}

function findTopLevelStatementTerminator(input: string, startIndex: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | "\"" | "`" | null = null;
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

    if (character === "'" || character === "\"" || character === "`") {
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
    } else if (character === ")") {
      parenDepth -= 1;
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth -= 1;
    } else if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth -= 1;
    } else if (
      character === ";"
      && parenDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

function findGoStatementTerminator(input: string, startIndex: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | "\"" | "`" | null = null;
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

    if (character === "'" || character === "\"" || character === "`") {
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
    } else if (character === ")") {
      parenDepth -= 1;
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth -= 1;
    } else if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth -= 1;
    } else if (
      (character === "\n" || character === ";")
      && parenDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
    ) {
      return index;
    }
  }

  return input.length;
}
