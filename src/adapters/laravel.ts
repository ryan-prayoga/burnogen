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
} from "../core/model";

interface PhpClassRecord {
  shortName: string;
  filePath: string;
}

interface GroupContext {
  prefixes: string[];
  middleware: string[];
  controller?: string;
}

interface ControllerAnalysis {
  requestBody?: NormalizedRequestBody;
  queryParameters: NormalizedParameter[];
  headerParameters: NormalizedParameter[];
  responses: NormalizedResponse[];
  warnings: GenerationWarning[];
}

interface LaravelResourceSchema {
  schema: SchemaObject;
  example: unknown;
}

interface ParsedHandler {
  controller?: string;
  action?: string;
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

export async function scanLaravelProject(
  root: string,
  projectName: string,
  projectVersion: string,
): Promise<NormalizedProject> {
  const classIndex = await buildPhpClassIndex(root);
  const routeFiles = await listFiles(
    path.join(root, "routes"),
    (filePath) => filePath.endsWith(".php"),
  );

  const warnings: GenerationWarning[] = [];
  const endpoints: NormalizedEndpoint[] = [];
  const controllerCache = new Map<string, ControllerAnalysis>();

  for (const routeFile of routeFiles) {
    const content = await fs.readFile(routeFile, "utf8");
    const routeParse = await parseRoutesFromFile(content, routeFile, classIndex, controllerCache);
    endpoints.push(...routeParse.endpoints);
    warnings.push(...routeParse.warnings);
  }

  return {
    framework: "laravel",
    projectName,
    projectVersion,
    endpoints,
    warnings,
  };
}

async function buildPhpClassIndex(root: string): Promise<Map<string, PhpClassRecord>> {
  const phpFiles = await listFiles(
    path.join(root, "app"),
    (filePath) => filePath.endsWith(".php"),
    { ignoreDirectories: ["vendor", "node_modules", ".git"] },
  );
  const classIndex = new Map<string, PhpClassRecord>();

  for (const filePath of phpFiles) {
    const content = await fs.readFile(filePath, "utf8");
    const classMatch = content.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (!classMatch?.[1]) {
      continue;
    }

    classIndex.set(classMatch[1], {
      shortName: classMatch[1],
      filePath,
    });
  }

  return classIndex;
}

async function parseRoutesFromFile(
  content: string,
  filePath: string,
  classIndex: Map<string, PhpClassRecord>,
  controllerCache: Map<string, ControllerAnalysis>,
): Promise<{ endpoints: NormalizedEndpoint[]; warnings: GenerationWarning[]; }> {
  const lines = content.split(/\r?\n/);
  const endpoints: NormalizedEndpoint[] = [];
  const warnings: GenerationWarning[] = [];
  const groupStack: Array<{ context: GroupContext; depth: number; }> = [];

  let braceDepth = 0;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();

    if (!line || !line.includes("Route::")) {
      braceDepth += countBraceDelta(rawLine);
      while (groupStack.length && braceDepth < groupStack[groupStack.length - 1].depth) {
        groupStack.pop();
      }
      continue;
    }

    const currentContext = mergeGroupContexts(groupStack.map((entry) => entry.context));

    if (line.includes("->group(function")) {
      groupStack.push({
        context: parseGroupContext(line),
        depth: braceDepth + 1,
      });
      braceDepth += countBraceDelta(rawLine);
      continue;
    }

    if (line.includes("Route::apiResource(") || line.includes("Route::resource(")) {
      const resourceRoutes = await parseResourceRoute(
        line,
        currentContext,
        filePath,
        index + 1,
        classIndex,
        controllerCache,
      );
      endpoints.push(...resourceRoutes.endpoints);
      warnings.push(...resourceRoutes.warnings);
      braceDepth += countBraceDelta(rawLine);
      continue;
    }

    const parsedRoute = await parseConcreteRoute(
      line,
      currentContext,
      filePath,
      index + 1,
      classIndex,
      controllerCache,
    );
    if (parsedRoute.endpoint) {
      endpoints.push(parsedRoute.endpoint);
    }
    warnings.push(...parsedRoute.warnings);

    braceDepth += countBraceDelta(rawLine);
    while (groupStack.length && braceDepth < groupStack[groupStack.length - 1].depth) {
      groupStack.pop();
    }
  }

  return { endpoints, warnings };
}

function parseGroupContext(statement: string): GroupContext {
  const prefixes: string[] = [];
  const middleware: string[] = [];
  let controller: string | undefined;

  for (const chain of extractRouteChainCalls(statement)) {
    if (chain.name === "prefix") {
      const value = parsePhpString(chain.value);
      if (value) {
        prefixes.push(value);
      }
    }

    if (chain.name === "middleware") {
      middleware.push(...parsePhpStringList(chain.value));
    }

    if (chain.name === "controller") {
      controller = shortPhpClassName(chain.value);
    }
  }

  return { prefixes, middleware, controller };
}

async function parseConcreteRoute(
  statement: string,
  inheritedContext: GroupContext,
  filePath: string,
  lineNumber: number,
  classIndex: Map<string, PhpClassRecord>,
  controllerCache: Map<string, ControllerAnalysis>,
): Promise<{ endpoint?: NormalizedEndpoint; warnings: GenerationWarning[]; }> {
  const routeMatch = statement.match(
    /Route::(get|post|put|patch|delete|head|options)\s*\(\s*(['"])(.*?)\2\s*,\s*(.+?)\)\s*(.*);?$/,
  );

  if (!routeMatch) {
    return {
      warnings: [{
        code: "LARAVEL_ROUTE_UNSUPPORTED",
        message: `Skipped unsupported Laravel route declaration: ${statement}`,
        location: { file: filePath, line: lineNumber },
      }],
    };
  }

  const method = routeMatch[1] as HttpMethod;
  const rawPath = routeMatch[3];
  const handlerText = routeMatch[4];
  const routeChain = routeMatch[5] ?? "";
  const routeContext = parseGroupContext(`Route::${routeChain}`);
  const context = mergeGroupContexts([inheritedContext, routeContext]);
  const handler = parseHandler(handlerText, context.controller);
  const analysis = await analyzeControllerHandler(handler, classIndex, controllerCache);
  const normalizedPath = normalizeLaravelPath(joinRoutePath(context.prefixes, rawPath));
  const inferredAuth = inferAuthFromMiddleware(context.middleware);
  const parameters = dedupeParameters([
    ...extractPathParameters(normalizedPath),
    ...analysis.queryParameters.filter((parameter) => !normalizedPath.includes(`{${parameter.name}}`)),
    ...analysis.headerParameters,
  ]);

  return {
    endpoint: {
      id: `${method}:${normalizedPath}`,
      method,
      path: normalizedPath,
      operationId: buildOperationId(method, normalizedPath, handler),
      summary: buildSummary(method, normalizedPath, handler),
      tags: [inferTag(normalizedPath, handler?.controller)],
      parameters,
      requestBody: analysis.requestBody,
      responses: analysis.responses.length > 0 ? analysis.responses : buildDefaultResponses(method),
      auth: inferredAuth,
      source: {
        file: filePath,
        line: lineNumber,
      },
      warnings: analysis.warnings,
    },
    warnings: analysis.warnings,
  };
}

async function parseResourceRoute(
  statement: string,
  inheritedContext: GroupContext,
  filePath: string,
  lineNumber: number,
  classIndex: Map<string, PhpClassRecord>,
  controllerCache: Map<string, ControllerAnalysis>,
): Promise<{ endpoints: NormalizedEndpoint[]; warnings: GenerationWarning[]; }> {
  const match = statement.match(
    /Route::(?:apiResource|resource)\s*\(\s*(['"])(.*?)\1\s*,\s*([A-Za-z0-9_\\]+)::class\s*\)(.*);?$/,
  );

  if (!match) {
    return {
      endpoints: [],
      warnings: [{
        code: "LARAVEL_RESOURCE_UNSUPPORTED",
        message: `Skipped unsupported Laravel resource declaration: ${statement}`,
        location: { file: filePath, line: lineNumber },
      }],
    };
  }

  const rawPath = match[2];
  const controller = shortPhpClassName(match[3]);
  const chain = match[4] ?? "";
  const resourceContext = parseGroupContext(`Route::${chain}`);
  const context = mergeGroupContexts([inheritedContext, resourceContext, { prefixes: [], middleware: [], controller }]);
  const only = parseResourceScope(chain, "only");
  const except = parseResourceScope(chain, "except");
  const singularSegment = singularize(rawPath.split("/").filter(Boolean).pop() ?? "item");
  const memberPath = `${rawPath.replace(/\/$/, "")}/{${singularSegment}}`;
  const resourceActions: Array<{ method: HttpMethod; action: string; path: string; }> = [
    { method: "get", action: "index", path: rawPath },
    { method: "post", action: "store", path: rawPath },
    { method: "get", action: "show", path: memberPath },
    { method: "put", action: "update", path: memberPath },
    { method: "patch", action: "update", path: memberPath },
    { method: "delete", action: "destroy", path: memberPath },
  ];

  const actions = resourceActions.filter((entry) => {
    if (only.length > 0) {
      return only.includes(entry.action);
    }

    if (except.length > 0) {
      return !except.includes(entry.action);
    }

    return true;
  });

  const endpoints: NormalizedEndpoint[] = [];
  const warnings: GenerationWarning[] = [];

  for (const action of actions) {
    const handler: ParsedHandler = { controller, action: action.action };
    const analysis = await analyzeControllerHandler(handler, classIndex, controllerCache);
    const normalizedPath = normalizeLaravelPath(joinRoutePath(context.prefixes, action.path));
    endpoints.push({
      id: `${action.method}:${normalizedPath}`,
      method: action.method,
      path: normalizedPath,
      operationId: buildOperationId(action.method, normalizedPath, handler),
      summary: buildSummary(action.method, normalizedPath, handler),
      tags: [inferTag(normalizedPath, controller)],
      parameters: dedupeParameters([
        ...extractPathParameters(normalizedPath),
        ...analysis.queryParameters.filter((parameter) => !normalizedPath.includes(`{${parameter.name}}`)),
        ...analysis.headerParameters,
      ]),
      requestBody: analysis.requestBody,
      responses: analysis.responses.length > 0 ? analysis.responses : buildDefaultResponses(action.method),
      auth: inferAuthFromMiddleware(context.middleware),
      source: {
        file: filePath,
        line: lineNumber,
      },
      warnings: analysis.warnings,
    });
    warnings.push(...analysis.warnings);
  }

  return { endpoints, warnings };
}

function parseResourceScope(chain: string, methodName: "only" | "except"): string[] {
  const match = chain.match(new RegExp(`->${methodName}\\((.*?)\\)`));
  return match ? parsePhpStringList(match[1]) : [];
}

function parseHandler(handlerText: string, fallbackController?: string): ParsedHandler | undefined {
  const controllerArray = handlerText.match(/\[\s*([A-Za-z0-9_\\]+)::class\s*,\s*['"]([A-Za-z0-9_]+)['"]\s*\]/);
  if (controllerArray?.[1] && controllerArray[2]) {
    return {
      controller: shortPhpClassName(controllerArray[1]),
      action: controllerArray[2],
    };
  }

  const invokedController = handlerText.match(/([A-Za-z0-9_\\]+)::class/);
  if (invokedController?.[1]) {
    return {
      controller: shortPhpClassName(invokedController[1]),
      action: "__invoke",
    };
  }

  const methodName = parsePhpString(handlerText);
  if (methodName) {
    return {
      controller: fallbackController,
      action: methodName,
    };
  }

  return undefined;
}

async function analyzeControllerHandler(
  handler: ParsedHandler | undefined,
  classIndex: Map<string, PhpClassRecord>,
  controllerCache: Map<string, ControllerAnalysis>,
): Promise<ControllerAnalysis> {
  if (!handler?.controller || !handler.action) {
    return { queryParameters: [], headerParameters: [], responses: [], warnings: [] };
  }

  const cacheKey = `${handler.controller}:${handler.action}`;
  const cached = controllerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const controllerRecord = classIndex.get(handler.controller);
  if (!controllerRecord) {
    const warning = {
      code: "LARAVEL_CONTROLLER_NOT_FOUND",
      message: `Could not locate controller ${handler.controller} while inferring request schema.`,
    };
    const result = { queryParameters: [], headerParameters: [], responses: [], warnings: [warning] };
    controllerCache.set(cacheKey, result);
    return result;
  }

  const content = await fs.readFile(controllerRecord.filePath, "utf8");
  const methodMatch = new RegExp(`function\\s+${handler.action}\\s*\\(([^)]*)\\)`, "m").exec(content);
  if (!methodMatch) {
    const warning = {
      code: "LARAVEL_CONTROLLER_METHOD_NOT_FOUND",
      message: `Could not locate ${handler.controller}::${handler.action} while inferring request schema.`,
      location: { file: controllerRecord.filePath },
    };
    const result = { queryParameters: [], headerParameters: [], responses: [], warnings: [warning] };
    controllerCache.set(cacheKey, result);
    return result;
  }

  const params = methodMatch[1] ?? "";
  const firstRequestType = extractFirstRequestType(params);
  const bodyStartIndex = content.indexOf("{", methodMatch.index);
  const body = bodyStartIndex >= 0 ? extractBalanced(content, bodyStartIndex, "{", "}") : null;
  const warnings: GenerationWarning[] = [];
  let requestBody: NormalizedRequestBody | undefined;
  let queryParameters: NormalizedParameter[] = [];
  let headerParameters: NormalizedParameter[] = [];
  let responses: NormalizedResponse[] = [];

  if (firstRequestType && firstRequestType !== "Request") {
    const requestSchema = await parseFormRequestSchema(firstRequestType, classIndex);
    if (requestSchema) {
      requestBody = {
        contentType: "application/json" as const,
        schema: requestSchema,
      };
    }
  }

  if (body) {
    const inlineRules = extractInlineValidationRules(body);
    if (inlineRules) {
      requestBody = {
        contentType: "application/json" as const,
        schema: buildLaravelSchemaFromRules(inlineRules),
      };
    }

    const manualRequestSchema = extractLaravelManualRequestSchema(body);
    if (manualRequestSchema) {
      requestBody = mergeLaravelRequestBodies(requestBody, manualRequestSchema);
    }

    queryParameters = extractLaravelQueryParameters(body);
    headerParameters = extractLaravelHeaderParameters(body);
    responses = await extractLaravelResponses(body, classIndex);
  }

  const result = {
    requestBody,
    queryParameters,
    headerParameters,
    responses,
    warnings,
  };
  controllerCache.set(cacheKey, result);
  return result;
}

function extractFirstRequestType(params: string): string | undefined {
  const paramMatches = params.split(",").map((entry) => entry.trim());
  for (const param of paramMatches) {
    const match = param.match(/([A-Za-z0-9_\\]+)\s+\$[A-Za-z0-9_]+/);
    if (match?.[1]) {
      return shortPhpClassName(match[1]);
    }
  }

  return undefined;
}

async function parseFormRequestSchema(
  requestType: string,
  classIndex: Map<string, PhpClassRecord>,
): Promise<SchemaObject | undefined> {
  const requestRecord = classIndex.get(requestType);
  if (!requestRecord) {
    return undefined;
  }

  const content = await fs.readFile(requestRecord.filePath, "utf8");
  const rulesMethodMatch = /function\s+rules\s*\([^)]*\)/m.exec(content);
  if (!rulesMethodMatch) {
    return undefined;
  }

  const methodBodyStart = content.indexOf("{", rulesMethodMatch.index);
  if (methodBodyStart < 0) {
    return undefined;
  }

  const methodBody = extractBalanced(content, methodBodyStart, "{", "}");
  if (!methodBody) {
    return undefined;
  }

  const rules = extractReturnArray(methodBody);
  if (!rules) {
    return undefined;
  }

  return buildLaravelSchemaFromRules(parsePhpRulesArray(rules));
}

function extractInlineValidationRules(methodBody: string): Record<string, string[]> | undefined {
  const validateCallIndex = methodBody.search(/->validate\s*\(/);
  if (validateCallIndex >= 0) {
    const arrayStart = methodBody.indexOf("[", validateCallIndex);
    if (arrayStart >= 0) {
      const arrayBody = extractBalanced(methodBody, arrayStart, "[", "]");
      if (arrayBody) {
        return parsePhpRulesArray(arrayBody);
      }
    }
  }

  const validatorCallIndex = methodBody.search(/Validator::make\s*\(/);
  if (validatorCallIndex >= 0) {
    const arrayStart = methodBody.indexOf("[", validatorCallIndex);
    if (arrayStart >= 0) {
      const arrayBody = extractBalanced(methodBody, arrayStart, "[", "]");
      if (arrayBody) {
        return parsePhpRulesArray(arrayBody);
      }
    }
  }

  return undefined;
}

function extractReturnArray(methodBody: string): string | null {
  const returnMatch = methodBody.match(/return\s+\[/);
  if (!returnMatch?.index && returnMatch?.index !== 0) {
    return null;
  }

  const startIndex = methodBody.indexOf("[", returnMatch.index);
  return startIndex >= 0 ? extractBalanced(methodBody, startIndex, "[", "]") : null;
}

function parsePhpRulesArray(arrayBody: string): Record<string, string[]> {
  const inner = arrayBody.slice(1, -1);
  const entries = splitTopLevel(inner, ",");
  const result: Record<string, string[]> = {};

  for (const entry of entries) {
    if (!entry.includes("=>")) {
      continue;
    }

    const [rawKey, rawValue] = splitOnce(entry, "=>");
    const key = parsePhpString(rawKey.trim());
    if (!key) {
      continue;
    }

    result[key] = parseRuleValue(rawValue.trim());
  }

  return result;
}

function parseRuleValue(rawValue: string): string[] {
  const singleRule = parsePhpString(rawValue);
  if (singleRule) {
    return singleRule.split("|").map((rule) => rule.trim()).filter(Boolean);
  }

  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    return parsePhpStringList(rawValue).flatMap((rule) => rule.split("|")).map((rule) => rule.trim()).filter(Boolean);
  }

  return [];
}

function buildLaravelSchemaFromRules(ruleMap: Record<string, string[]>): SchemaObject {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  for (const [fieldName, rules] of Object.entries(ruleMap)) {
    if (fieldName.includes(".")) {
      continue;
    }

    const schema: SchemaObject = {};
    let inferredType: string | undefined;

    for (const rule of rules) {
      const [name, rawArgument] = splitRule(rule);
      switch (name) {
        case "required":
          required.push(fieldName);
          break;
        case "string":
          inferredType = "string";
          break;
        case "integer":
        case "int":
          inferredType = "integer";
          break;
        case "numeric":
          inferredType = "number";
          break;
        case "boolean":
          inferredType = "boolean";
          break;
        case "array":
          inferredType = "array";
          schema.items = { type: "string" };
          break;
        case "email":
          inferredType = "string";
          schema.format = "email";
          break;
        case "uuid":
          inferredType = "string";
          schema.format = "uuid";
          break;
        case "date":
        case "date_format":
          inferredType = "string";
          schema.format = "date-time";
          break;
        case "nullable":
          schema.nullable = true;
          break;
        case "min":
          applyLaravelRange(schema, inferredType, rawArgument, "min");
          break;
        case "max":
          applyLaravelRange(schema, inferredType, rawArgument, "max");
          break;
        case "in":
          inferredType = inferredType ?? "string";
          schema.enum = rawArgument.split(",").map((value) => value.trim()).filter(Boolean);
          break;
        default:
          break;
      }
    }

    schema.type = inferredType ?? schema.type ?? "string";
    properties[fieldName] = schema;
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? [...new Set(required)] : undefined,
  };
}

function applyLaravelRange(
  schema: SchemaObject,
  inferredType: string | undefined,
  rawArgument: string,
  kind: "min" | "max",
): void {
  const numericValue = Number.parseFloat(rawArgument);
  if (Number.isNaN(numericValue)) {
    return;
  }

  if (inferredType === "integer" || inferredType === "number") {
    if (kind === "min") {
      schema.minimum = numericValue;
    } else {
      schema.maximum = numericValue;
    }
    return;
  }

  if (kind === "min") {
    schema.minLength = numericValue;
  } else {
    schema.maxLength = numericValue;
  }
}

function splitRule(rule: string): [string, string] {
  const [name, ...rest] = rule.split(":");
  return [name.trim(), rest.join(":").trim()];
}

function mergeGroupContexts(contexts: GroupContext[]): GroupContext {
  return contexts.reduce<GroupContext>((accumulator, context) => ({
    prefixes: [...accumulator.prefixes, ...context.prefixes],
    middleware: [...accumulator.middleware, ...context.middleware],
    controller: context.controller ?? accumulator.controller,
  }), { prefixes: [], middleware: [] });
}

function joinRoutePath(prefixes: string[], rawPath: string): string {
  const segments = [...prefixes, rawPath]
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);

  return `/${segments.join("/")}`.replace(/\/+/g, "/");
}

function normalizeLaravelPath(pathname: string): string {
  return pathname
    .replace(/\{([^}:]+):[^}]+\}/g, "{$1}")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function inferAuthFromMiddleware(middleware: string[]): NormalizedAuth {
  const joined = middleware.join(" ");
  if (/\bauth(?::[a-z0-9_-]+)?\b/i.test(joined) || /sanctum/i.test(joined)) {
    return { type: "bearer" };
  }

  return { type: "none" };
}

function extractPathParameters(pathname: string) {
  const matches = [...pathname.matchAll(/\{([^}]+)\}/g)];
  return matches.map((match) => ({
    name: match[1],
    in: "path" as const,
    required: true,
    schema: { type: "string" as const },
  }));
}

function buildOperationId(method: HttpMethod, pathname: string, handler?: ParsedHandler): string {
  if (handler?.controller && handler.action) {
    return `${camelCase(handler.controller)}${capitalize(handler.action)}`;
  }

  const cleanPath = pathname.replace(/[{}]/g, "").split("/").filter(Boolean).map(capitalize).join("");
  return `${method}${cleanPath || "Root"}`;
}

function buildSummary(method: HttpMethod, pathname: string, handler?: ParsedHandler): string {
  if (handler?.action && handler.controller) {
    return `${handler.controller}::${handler.action}`;
  }

  return `${method.toUpperCase()} ${pathname}`;
}

function inferTag(pathname: string, controller?: string): string {
  if (controller) {
    return controller.replace(/Controller$/, "");
  }

  return pathname.split("/").filter(Boolean)[0] ?? "default";
}

function buildDefaultResponses(method: HttpMethod): NormalizedResponse[] {
  return [{
    statusCode: methodToResponseStatus[method],
    description: "Generated default response",
  }];
}

function extractLaravelQueryParameters(methodBody: string): NormalizedParameter[] {
  const parameters = new Set<string>();

  for (const match of methodBody.matchAll(/(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*query\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1]) {
      parameters.add(match[1]);
    }
  }

  return [...parameters].map((name) => ({
    name,
    in: "query",
    required: false,
    schema: { type: "string" },
  }));
}

function extractLaravelHeaderParameters(methodBody: string): NormalizedParameter[] {
  const parameters = new Set<string>();

  for (const match of methodBody.matchAll(/(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*header\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1]) {
      parameters.add(match[1]);
    }
  }

  for (const match of methodBody.matchAll(/(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*headers\s*->\s*get\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1]) {
      parameters.add(match[1]);
    }
  }

  return [...parameters].map((name) => ({
    name,
    in: "header",
    required: false,
    schema: { type: "string" },
  }));
}

function extractLaravelManualRequestSchema(methodBody: string): SchemaObject | undefined {
  const properties: Record<string, SchemaObject> = {};

  const accessorPatterns: Array<{ regex: RegExp; schemaFactory: () => SchemaObject; }> = [
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:input|get|post|json|string)\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "string" }),
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*integer\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "integer" }),
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:float|double)\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "number" }),
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*boolean\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "boolean" }),
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:array|collect)\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "array", items: { type: "string" } }),
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*date\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "string", format: "date-time" }),
    },
    {
      regex: /request\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      schemaFactory: () => ({ type: "string" }),
    },
  ];

  for (const pattern of accessorPatterns) {
    for (const match of methodBody.matchAll(pattern.regex)) {
      const fieldName = match[1];
      if (!fieldName || fieldName.includes(".")) {
        continue;
      }

      properties[fieldName] = mergeSchemaObjects(properties[fieldName], pattern.schemaFactory());
    }
  }

  for (const match of methodBody.matchAll(/(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*only\s*\(\s*(\[[^\]]*\])\s*\)/g)) {
    const arrayLiteral = match[1];
    if (!arrayLiteral) {
      continue;
    }

    for (const fieldName of parsePhpStringList(arrayLiteral)) {
      if (!fieldName || fieldName.includes(".")) {
        continue;
      }

      properties[fieldName] = mergeSchemaObjects(properties[fieldName], { type: "string" });
    }
  }

  if (Object.keys(properties).length === 0) {
    return undefined;
  }

  return {
    type: "object",
    properties,
  };
}

function mergeLaravelRequestBodies(
  existing: NormalizedRequestBody | undefined,
  manualSchema: SchemaObject,
): NormalizedRequestBody {
  if (!existing) {
    return {
      contentType: "application/json",
      schema: manualSchema,
    };
  }

  return {
    ...existing,
    schema: mergeSchemaObjects(existing.schema, manualSchema),
  };
}

function mergeSchemaObjects(
  left: SchemaObject | undefined,
  right: SchemaObject | undefined,
): SchemaObject {
  if (!left) {
    return right ?? {};
  }

  if (!right) {
    return left;
  }

  const mergedProperties = {
    ...(left.properties ?? {}),
    ...(right.properties ?? {}),
  };

  return {
    ...left,
    ...right,
    properties: Object.keys(mergedProperties).length > 0 ? mergedProperties : undefined,
    required: dedupeStrings([...(left.required ?? []), ...(right.required ?? [])]),
  };
}

async function extractLaravelResponses(
  methodBody: string,
  classIndex: Map<string, PhpClassRecord>,
): Promise<NormalizedResponse[]> {
  const responses = new Map<string, NormalizedResponse>();
  const exampleContext = createPhpExampleContext(methodBody);

  for (const jsonCall of extractReturnResponseJsonCalls(methodBody)) {
    const args = splitTopLevel(jsonCall.slice(1, -1), ",");
    if (args.length === 0) {
      continue;
    }

    const example = parsePhpExampleValue(args[0], exampleContext);
    const statusCode = parseLaravelStatusCode(args[1]) ?? "200";
    responses.set(statusCode, {
      statusCode,
      description: "Inferred JSON response",
      contentType: "application/json",
      schema: inferSchemaFromExample(example),
      example,
    });
  }

  for (const noContentCall of extractReturnResponseNoContentCalls(methodBody)) {
    const args = splitTopLevel(noContentCall.slice(1, -1), ",");
    const statusCode = parseLaravelStatusCode(args[0]) ?? "204";
    responses.set(statusCode, {
      statusCode,
      description: "Inferred empty response",
    });
  }

  for (const abortResponse of extractLaravelAbortResponses(methodBody)) {
    if (!responses.has(abortResponse.statusCode)) {
      responses.set(abortResponse.statusCode, abortResponse);
    }
  }

  for (const arrayLiteral of extractDirectReturnArrays(methodBody)) {
    const example = parsePhpExampleValue(arrayLiteral, exampleContext);
    const statusCode = "200";
    if (!responses.has(statusCode)) {
      responses.set(statusCode, {
        statusCode,
        description: "Inferred array response",
        contentType: "application/json",
        schema: inferSchemaFromExample(example),
        example,
      });
    }
  }

  const resourceResponses = await extractLaravelResourceResponses(methodBody, classIndex, exampleContext);
  for (const response of resourceResponses) {
    if (!responses.has(response.statusCode)) {
      responses.set(response.statusCode, response);
    }
  }

  return [...responses.values()];
}

function extractLaravelAbortResponses(methodBody: string): NormalizedResponse[] {
  const responses = new Map<string, NormalizedResponse>();

  for (const abortCall of extractLaravelAbortCalls(methodBody)) {
    const args = splitTopLevel(abortCall.slice(1, -1), ",");
    const statusCode = parseLaravelStatusCode(args[0]) ?? "500";
    const message = parsePhpString(args[1] ?? "") ?? defaultAbortMessage(statusCode);
    responses.set(statusCode, {
      statusCode,
      description: "Inferred abort response",
      contentType: "application/json",
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
      example: {
        message,
      },
    });
  }

  return [...responses.values()];
}

async function extractLaravelResourceResponses(
  methodBody: string,
  classIndex: Map<string, PhpClassRecord>,
  exampleContext: PhpExampleContext,
): Promise<NormalizedResponse[]> {
  const responses: NormalizedResponse[] = [];
  const returnStatements = extractReturnStatements(methodBody);

  for (const statement of returnStatements) {
    const parsedResourceReturn = parseLaravelResourceReturnStatement(statement, exampleContext);
    if (!parsedResourceReturn) {
      continue;
    }

    const resourceResponse = await buildLaravelResourceResponse(
      parsedResourceReturn.resourceType,
      parsedResourceReturn.mode,
      classIndex,
      parsedResourceReturn.additional,
    );
    if (resourceResponse) {
      responses.push(resourceResponse);
    }
  }

  return dedupeResponsesByStatusCode(responses);
}

async function buildLaravelResourceResponse(
  resourceType: string,
  mode: "single" | "collection",
  classIndex: Map<string, PhpClassRecord>,
  additional?: unknown,
): Promise<NormalizedResponse | undefined> {
  const resourceSchema = await parseLaravelResourceSchema(resourceType, classIndex);
  if (!resourceSchema) {
    return undefined;
  }

  const additionalProperties = additional && typeof additional === "object" && !Array.isArray(additional)
    ? additional as Record<string, unknown>
    : undefined;
  const additionalSchema = additionalProperties ? inferSchemaFromExample(additionalProperties) : undefined;
  const wrappedSchema: SchemaObject = mode === "collection"
    ? {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: resourceSchema.schema,
        },
        ...(additionalSchema?.properties ?? {}),
      },
    }
    : {
      type: "object",
      properties: {
        data: resourceSchema.schema,
        ...(additionalSchema?.properties ?? {}),
      },
    };
  const wrappedExample = mode === "collection"
    ? { data: [resourceSchema.example], ...(additionalProperties ?? {}) }
    : { data: resourceSchema.example, ...(additionalProperties ?? {}) };

  return {
    statusCode: "200",
    description: "Inferred Laravel resource response",
    contentType: "application/json",
    schema: wrappedSchema,
    example: wrappedExample,
  };
}

async function parseLaravelResourceSchema(
  resourceType: string,
  classIndex: Map<string, PhpClassRecord>,
): Promise<LaravelResourceSchema | undefined> {
  const resourceRecord = classIndex.get(shortPhpClassName(resourceType));
  if (!resourceRecord) {
    return undefined;
  }

  const content = await fs.readFile(resourceRecord.filePath, "utf8");
  const methodMatch = /function\s+toArray\s*\(([^)]*)\)/m.exec(content);
  if (!methodMatch) {
    return undefined;
  }

  const bodyStartIndex = content.indexOf("{", methodMatch.index);
  const body = bodyStartIndex >= 0 ? extractBalanced(content, bodyStartIndex, "{", "}") : null;
  if (!body) {
    return undefined;
  }

  const arrayLiteral = extractDirectReturnArrays(body)[0] ?? extractReturnArray(body);
  if (!arrayLiteral) {
    return undefined;
  }

  const example = parsePhpExampleValue(arrayLiteral, createPhpExampleContext(body));
  return {
    schema: inferSchemaFromExample(example),
    example,
  };
}

function parseLaravelResourceReturnStatement(
  statement: string,
  exampleContext: PhpExampleContext,
): { resourceType: string; mode: "single" | "collection"; additional?: unknown; } | undefined {
  const newResourceMatch = statement.match(/^return\s+new\s+([A-Za-z0-9_\\]+)\s*\(/);
  if (newResourceMatch?.[1]) {
    return {
      resourceType: newResourceMatch[1],
      mode: "single",
      additional: extractLaravelResourceAdditional(statement, exampleContext),
    };
  }

  const factoryMatch = statement.match(/^return\s+([A-Za-z0-9_\\]+)::(make|collection)\s*\(/);
  if (factoryMatch?.[1] && factoryMatch[2]) {
    return {
      resourceType: factoryMatch[1],
      mode: factoryMatch[2] === "collection" ? "collection" : "single",
      additional: extractLaravelResourceAdditional(statement, exampleContext),
    };
  }

  return undefined;
}

function extractLaravelResourceAdditional(
  statement: string,
  exampleContext: PhpExampleContext,
): unknown | undefined {
  const additionalIndex = statement.indexOf("->additional(");
  if (additionalIndex < 0) {
    return undefined;
  }

  const openParenIndex = statement.indexOf("(", additionalIndex + "->additional".length);
  const argsBlock = openParenIndex >= 0 ? extractBalanced(statement, openParenIndex, "(", ")") : null;
  if (!argsBlock) {
    return undefined;
  }

  const firstArg = splitTopLevel(argsBlock.slice(1, -1), ",")[0]?.trim();
  if (!firstArg) {
    return undefined;
  }

  const additional = parsePhpExampleValue(firstArg, exampleContext);
  return additional && typeof additional === "object" && !Array.isArray(additional)
    ? additional
    : undefined;
}

function extractReturnStatements(methodBody: string): string[] {
  const statements: string[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const returnIndex = methodBody.indexOf("return", offset);
    if (returnIndex < 0) {
      break;
    }

    const statementEnd = findTopLevelStatementTerminator(methodBody, returnIndex);
    if (statementEnd < 0) {
      break;
    }

    statements.push(methodBody.slice(returnIndex, statementEnd + 1).trim());
    offset = statementEnd + 1;
  }

  return statements;
}

const unresolvedPhpExample = Symbol("unresolved-php-example");

interface PhpExampleContext {
  assignments: Map<string, string>;
  cache: Map<string, unknown | typeof unresolvedPhpExample>;
  resolving: Set<string>;
}

function createPhpExampleContext(methodBody: string): PhpExampleContext {
  return {
    assignments: extractPhpVariableAssignments(methodBody),
    cache: new Map(),
    resolving: new Set(),
  };
}

function extractPhpVariableAssignments(methodBody: string): Map<string, string> {
  const assignments = new Map<string, string>();

  for (const match of methodBody.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g)) {
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

    const statementEnd = findTopLevelStatementTerminator(methodBody, equalsIndex + 1);
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

function extractReturnResponseJsonCalls(methodBody: string): string[] {
  const results: string[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const returnIndex = methodBody.indexOf("return response()->json(", offset);
    if (returnIndex < 0) {
      break;
    }

    const openParenIndex = methodBody.indexOf("(", returnIndex + "return response()->json".length);
    const argsBlock = openParenIndex >= 0 ? extractBalanced(methodBody, openParenIndex, "(", ")") : null;
    if (!argsBlock) {
      break;
    }

    results.push(argsBlock);
    offset = openParenIndex + argsBlock.length;
  }

  return results;
}

function extractLaravelAbortCalls(methodBody: string): string[] {
  const results: string[] = [];
  const patterns = [
    "abort(",
    "abort_if(",
    "abort_unless(",
  ];

  for (const pattern of patterns) {
    let offset = 0;
    while (offset < methodBody.length) {
      const callIndex = methodBody.indexOf(pattern, offset);
      if (callIndex < 0) {
        break;
      }

      const openParenIndex = methodBody.indexOf("(", callIndex + pattern.length - 1);
      const argsBlock = openParenIndex >= 0 ? extractBalanced(methodBody, openParenIndex, "(", ")") : null;
      if (!argsBlock) {
        break;
      }

      if (pattern === "abort(") {
        results.push(argsBlock);
      } else {
        const args = splitTopLevel(argsBlock.slice(1, -1), ",");
        if (args.length >= 2) {
          results.push(`(${args.slice(1).join(",")})`);
        }
      }

      offset = openParenIndex + argsBlock.length;
    }
  }

  return results;
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

function dedupeResponsesByStatusCode(responses: NormalizedResponse[]): NormalizedResponse[] {
  const seen = new Set<string>();
  return responses.filter((response) => {
    if (seen.has(response.statusCode)) {
      return false;
    }

    seen.add(response.statusCode);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] | undefined {
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function extractReturnResponseNoContentCalls(methodBody: string): string[] {
  const results: string[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const returnIndex = methodBody.indexOf("return response()->noContent(", offset);
    if (returnIndex < 0) {
      break;
    }

    const openParenIndex = methodBody.indexOf("(", returnIndex + "return response()->noContent".length);
    const argsBlock = openParenIndex >= 0 ? extractBalanced(methodBody, openParenIndex, "(", ")") : null;
    if (!argsBlock) {
      break;
    }

    results.push(argsBlock);
    offset = openParenIndex + argsBlock.length;
  }

  return results;
}

function extractDirectReturnArrays(methodBody: string): string[] {
  const results: string[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const returnIndex = methodBody.indexOf("return [", offset);
    if (returnIndex < 0) {
      break;
    }

    const openBracketIndex = methodBody.indexOf("[", returnIndex);
    const arrayBlock = openBracketIndex >= 0 ? extractBalanced(methodBody, openBracketIndex, "[", "]") : null;
    if (!arrayBlock) {
      break;
    }

    results.push(arrayBlock);
    offset = openBracketIndex + arrayBlock.length;
  }

  return results;
}

function parseLaravelStatusCode(rawValue?: string): string | undefined {
  if (!rawValue) {
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const statusMap: Record<string, string> = {
    "Response::HTTP_OK": "200",
    "Response::HTTP_CREATED": "201",
    "Response::HTTP_NO_CONTENT": "204",
    "Response::HTTP_BAD_REQUEST": "400",
    "Response::HTTP_UNAUTHORIZED": "401",
    "Response::HTTP_FORBIDDEN": "403",
    "Response::HTTP_NOT_FOUND": "404",
    "Response::HTTP_UNPROCESSABLE_ENTITY": "422",
    "Response::HTTP_INTERNAL_SERVER_ERROR": "500",
  };

  return statusMap[trimmed];
}

function defaultAbortMessage(statusCode: string): string {
  const statusText = defaultStatusTextMap[statusCode];
  return statusText ?? "Request failed";
}

const defaultStatusTextMap: Record<string, string> = {
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "409": "Conflict",
  "422": "Unprocessable Entity",
  "500": "Internal Server Error",
};

function parsePhpExampleValue(rawValue: string, context?: PhpExampleContext): unknown {
  const value = resolvePhpExampleValue(rawValue, context);
  return value === unresolvedPhpExample ? {} : value;
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
      if (resolvedOperand !== unresolvedPhpExample && resolvedOperand !== null) {
        return resolvedOperand;
      }
    }

    return null;
  }

  const requestAccessorExample = inferLaravelRequestAccessorExample(value);
  if (requestAccessorExample !== unresolvedPhpExample) {
    return requestAccessorExample;
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

  if (value.startsWith("[") && value.endsWith("]")) {
    const entries = splitTopLevel(value.slice(1, -1), ",");
    const isAssoc = entries.some((entry) => hasTopLevelArrow(entry));

    if (!isAssoc) {
      return entries.filter(Boolean).map((entry) => parsePhpExampleValue(entry, context));
    }

    return Object.fromEntries(entries
      .filter((entry) => hasTopLevelArrow(entry))
      .map((entry) => {
        const [rawKey, rawEntryValue] = splitTopLevelArrow(entry);
        const parsedKey = parsePhpString(rawKey.trim()) ?? rawKey.trim();
        return [String(parsedKey), parsePhpExampleValue(rawEntryValue, context)];
      }));
  }

  const directVariableMatch = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (directVariableMatch?.[1]) {
    return resolvePhpVariableExample(directVariableMatch[1], context);
  }

  const propertyAccessMatch = value.match(/^\$[A-Za-z_][A-Za-z0-9_]*->([A-Za-z_][A-Za-z0-9_]*)$/);
  if (propertyAccessMatch?.[1]) {
    return buildPhpExampleForField(propertyAccessMatch[1]);
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

function inferLaravelRequestAccessorExample(rawValue: string): unknown | typeof unresolvedPhpExample {
  const value = rawValue.trim();
  const typedPatterns: Array<{ regex: RegExp; type: "string" | "integer" | "number" | "boolean" | "array" | "date-time"; }> = [
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:input|get|post|json|string|query|header)\s*\(\s*['"]([^'"]+)['"]/,
      type: "string",
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*integer\s*\(\s*['"]([^'"]+)['"]/,
      type: "integer",
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:float|double)\s*\(\s*['"]([^'"]+)['"]/,
      type: "number",
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*boolean\s*\(\s*['"]([^'"]+)['"]/,
      type: "boolean",
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:array|collect)\s*\(\s*['"]([^'"]+)['"]/,
      type: "array",
    },
    {
      regex: /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*date\s*\(\s*['"]([^'"]+)['"]/,
      type: "date-time",
    },
    {
      regex: /request\s*\(\s*['"]([^'"]+)['"]\s*\)/,
      type: "string",
    },
  ];

  for (const pattern of typedPatterns) {
    const match = value.match(pattern.regex);
    if (match?.[1]) {
      return buildPhpExampleForField(match[1], pattern.type);
    }
  }

  const onlyMatch = value.match(/(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*only\s*\(\s*(\[[^\]]*\])\s*\)/);
  if (onlyMatch?.[1]) {
    return Object.fromEntries(
      parsePhpStringList(onlyMatch[1]).map((fieldName) => [fieldName, buildPhpExampleForField(fieldName)]),
    );
  }

  return unresolvedPhpExample;
}

function buildPhpExampleForField(
  fieldName: string,
  type: "string" | "integer" | "number" | "boolean" | "array" | "date-time" = "string",
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
    return fieldName === fieldName.toUpperCase() ? `${fieldName}_VALUE` : "token";
  }

  if (normalized === "page" || normalized.endsWith("_page")) {
    return 1;
  }

  if (normalized === "id" || normalized.endsWith("_id")) {
    return 1;
  }

  if (normalized.includes("remember") || normalized.startsWith("is_") || normalized.startsWith("has_")) {
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
  let quote: "'" | "\"" | null = null;
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

    if (character === "'" || character === "\"") {
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

function extractRouteChainCalls(statement: string): Array<{ name: string; value: string; }> {
  const results: Array<{ name: string; value: string; }> = [];
  const regex = /(?:Route::|->)(prefix|middleware|controller|name)\(([^)]*)\)/g;

  for (const match of statement.matchAll(regex)) {
    if (match[1] && match[2] !== undefined) {
      results.push({ name: match[1], value: match[2] });
    }
  }

  return results;
}

function parsePhpStringList(input: string): string[] {
  const matches = [...input.matchAll(/['"]([^'"]+)['"]/g)];
  return matches.map((match) => match[1]).filter(Boolean);
}

function parsePhpString(input: string): string | undefined {
  const match = input.trim().match(/^['"](.+?)['"]$/);
  return match?.[1];
}

function shortPhpClassName(input: string): string {
  const cleaned = input.trim().replace(/::class$/, "");
  const parts = cleaned.split("\\");
  return parts[parts.length - 1];
}

function countBraceDelta(input: string): number {
  let delta = 0;
  let quote: "'" | "\"" | null = null;
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

    if ((character === "'" || character === "\"")) {
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

function extractBalanced(input: string, startIndex: number, open: string, close: string): string | null {
  let depth = 0;
  let quote: "'" | "\"" | null = null;
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

    if (character === "'" || character === "\"") {
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

function findTopLevelStatementTerminator(input: string, startIndex: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | "\"" | null = null;
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

    if (character === "'" || character === "\"") {
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

    if (character === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return index;
    }
  }

  return -1;
}

function splitTopLevel(input: string, separator: string): string[] {
  const results: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | "\"" | null = null;
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

    if ((character === "'" || character === "\"")) {
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

function splitTopLevelSequence(input: string, sequence: string): string[] {
  const results: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

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

    if (character === "'" || character === "\"") {
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
        input.startsWith(sequence, index) &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        if (current.trim()) {
          results.push(current.trim());
        }
        current = "";
        index += sequence.length - 1;
        continue;
      }
    }

    current += character;
  }

  if (current.trim()) {
    results.push(current.trim());
  }

  return results.length > 0 ? results : [input.trim()];
}

function splitOnce(input: string, delimiter: string): [string, string] {
  const index = input.indexOf(delimiter);
  if (index < 0) {
    return [input, ""];
  }

  return [input.slice(0, index), input.slice(index + delimiter.length)];
}

function singularize(input: string): string {
  if (input.endsWith("ies")) {
    return `${input.slice(0, -3)}y`;
  }

  if (input.endsWith("s") && input.length > 1) {
    return input.slice(0, -1);
  }

  return input;
}

function camelCase(input: string): string {
  const clean = input.replace(/[^a-zA-Z0-9]+/g, " ");
  return clean
    .split(" ")
    .filter(Boolean)
    .map((part, index) => index === 0 ? part.toLowerCase() : capitalize(part.toLowerCase()))
    .join("");
}

function capitalize(input: string): string {
  return input ? `${input[0].toUpperCase()}${input.slice(1)}` : input;
}
