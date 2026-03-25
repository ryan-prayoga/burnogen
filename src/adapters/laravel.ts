import path from "node:path";
import { promises as fs } from "node:fs";

import { listFiles } from "../core/fs";
import type {
  GenerationWarning,
  HttpMethod,
  NormalizedAuth,
  NormalizedEndpoint,
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
  warnings: GenerationWarning[];
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
  const parameters = extractPathParameters(normalizedPath);

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
      responses: buildDefaultResponses(method),
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
      parameters: extractPathParameters(normalizedPath),
      requestBody: analysis.requestBody,
      responses: buildDefaultResponses(action.method),
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
    return { warnings: [] };
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
    const result = { warnings: [warning] };
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
    const result = { warnings: [warning] };
    controllerCache.set(cacheKey, result);
    return result;
  }

  const params = methodMatch[1] ?? "";
  const firstRequestType = extractFirstRequestType(params);
  const bodyStartIndex = content.indexOf("{", methodMatch.index);
  const body = bodyStartIndex >= 0 ? extractBalanced(content, bodyStartIndex, "{", "}") : null;
  const warnings: GenerationWarning[] = [];

  if (firstRequestType && firstRequestType !== "Request") {
    const requestSchema = await parseFormRequestSchema(firstRequestType, classIndex);
    if (requestSchema) {
      const result = {
        requestBody: {
          contentType: "application/json" as const,
          schema: requestSchema,
        },
        warnings,
      };
      controllerCache.set(cacheKey, result);
      return result;
    }
  }

  if (body) {
    const inlineRules = extractInlineValidationRules(body);
    if (inlineRules) {
      const result = {
        requestBody: {
          contentType: "application/json" as const,
          schema: buildLaravelSchemaFromRules(inlineRules),
        },
        warnings,
      };
      controllerCache.set(cacheKey, result);
      return result;
    }
  }

  const result = { warnings };
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
