import path from "node:path";
import { promises as fs } from "node:fs";

import { inferBearerAuthFromMiddleware } from "../../core/auth-middleware";
import { dedupeParameters } from "../../core/dedupe";
import { listFiles } from "../../core/fs";
import type {
  BrunogenConfig,
  GenerationWarning,
  HttpMethod,
  NormalizedEndpoint,
} from "../../core/model";
import { analyzeControllerHandler } from "./requests";
import {
  type ControllerAnalysis,
  type GroupContext,
  type PhpFileContext,
  type ParsedHandler,
  type PhpClassRecord,
  buildDefaultResponses,
  buildOperationId,
  buildSummary,
  collectLaravelRouteStatement,
  extractPathParameters,
  extractRouteChainCalls,
  inferTag,
  joinRoutePath,
  mergeGroupContexts,
  normalizeLaravelPath,
  parsePhpString,
  parsePhpStringList,
  parsePhpFileContext,
  resolvePhpClassName,
  singularize,
} from "./shared";

export async function scanLaravelRoutes(
  root: string,
  config: BrunogenConfig,
): Promise<{ endpoints: NormalizedEndpoint[]; warnings: GenerationWarning[] }> {
  const classIndex = await buildPhpClassIndex(root);
  const routeFiles = await listFiles(path.join(root, "routes"), (filePath) =>
    filePath.endsWith(".php"),
  );
  const warnings: GenerationWarning[] = [];
  const endpoints: NormalizedEndpoint[] = [];
  const controllerCache = new Map<string, ControllerAnalysis>();

  for (const routeFile of routeFiles) {
    const content = await fs.readFile(routeFile, "utf8");
    const routeParse = await parseRoutesFromFile(
      content,
      routeFile,
      classIndex,
      controllerCache,
      config,
    );
    endpoints.push(...routeParse.endpoints);
    warnings.push(...routeParse.warnings);
  }

  return { endpoints, warnings };
}

async function buildPhpClassIndex(
  root: string,
): Promise<Map<string, PhpClassRecord>> {
  const phpFiles = await listFiles(
    path.join(root, "app"),
    (filePath) => filePath.endsWith(".php"),
    { ignoreDirectories: ["vendor", "node_modules", ".git"] },
  );
  const records: PhpClassRecord[] = [];

  for (const filePath of phpFiles) {
    const content = await fs.readFile(filePath, "utf8");
    const namespace = parsePhpFileContext(content).namespace;
    const classMatch = content.match(
      /\b(?:class|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
    );
    if (!classMatch?.[1]) {
      continue;
    }

    const shortName = classMatch[1];
    const fullName = namespace ? `${namespace}\\${shortName}` : shortName;
    records.push({
      shortName: classMatch[1],
      fullName,
      filePath,
    });
  }

  const classIndex = new Map<string, PhpClassRecord>();
  const recordsByShortName = new Map<string, PhpClassRecord[]>();

  for (const record of records) {
    classIndex.set(record.fullName, record);
    const matchingRecords = recordsByShortName.get(record.shortName) ?? [];
    matchingRecords.push(record);
    recordsByShortName.set(record.shortName, matchingRecords);
  }

  for (const [shortName, matchingRecords] of recordsByShortName) {
    if (matchingRecords.length === 1) {
      classIndex.set(shortName, matchingRecords[0]);
    }
  }

  return classIndex;
}

async function parseRoutesFromFile(
  content: string,
  filePath: string,
  classIndex: Map<string, PhpClassRecord>,
  controllerCache: Map<string, ControllerAnalysis>,
  config: BrunogenConfig,
): Promise<{ endpoints: NormalizedEndpoint[]; warnings: GenerationWarning[] }> {
  const lines = content.split(/\r?\n/);
  const endpoints: NormalizedEndpoint[] = [];
  const warnings: GenerationWarning[] = [];
  const groupStack: Array<{ context: GroupContext; depth: number }> = [];
  const fileContext = parsePhpFileContext(content);

  let braceDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line || !line.includes("Route::")) {
      braceDepth += countBraceDelta(rawLine);
      while (
        groupStack.length &&
        braceDepth < groupStack[groupStack.length - 1].depth
      ) {
        groupStack.pop();
      }
      continue;
    }

    const statement = collectLaravelRouteStatement(lines, index);
    const currentContext = mergeGroupContexts(
      groupStack.map((entry) => entry.context),
    );

    if (statement.value.includes("->group(function")) {
      groupStack.push({
        context: parseGroupContext(statement.value, fileContext),
        depth: braceDepth + 1,
      });
      braceDepth += statement.braceDelta;
      index = statement.lastLine;
      continue;
    }

    if (
      statement.value.includes("Route::apiResource(") ||
      statement.value.includes("Route::resource(")
    ) {
      const resourceRoutes = await parseResourceRoute(
        statement.value,
        currentContext,
        filePath,
        index + 1,
        classIndex,
        controllerCache,
        config,
        fileContext,
      );
      endpoints.push(...resourceRoutes.endpoints);
      warnings.push(...resourceRoutes.warnings);
      braceDepth += statement.braceDelta;
      index = statement.lastLine;
      continue;
    }

    const parsedRoute = await parseConcreteRoute(
      statement.value,
      currentContext,
      filePath,
      index + 1,
      classIndex,
      controllerCache,
      config,
      fileContext,
    );
    if (parsedRoute.endpoint) {
      endpoints.push(parsedRoute.endpoint);
    }
    warnings.push(...parsedRoute.warnings);

    braceDepth += statement.braceDelta;
    index = statement.lastLine;
    while (
      groupStack.length &&
      braceDepth < groupStack[groupStack.length - 1].depth
    ) {
      groupStack.pop();
    }
  }

  return { endpoints, warnings };
}

function parseGroupContext(
  statement: string,
  fileContext: PhpFileContext,
): GroupContext {
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
      controller = resolvePhpClassName(chain.value, fileContext);
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
  config: BrunogenConfig,
  fileContext: PhpFileContext,
): Promise<{ endpoint?: NormalizedEndpoint; warnings: GenerationWarning[] }> {
  const routeMatch = statement.match(
    /Route::(get|post|put|patch|delete|head|options)\s*\(\s*(['"])(.*?)\2\s*,\s*([\s\S]+?)\)\s*([\s\S]*);?$/,
  );

  if (!routeMatch) {
    return {
      warnings: [
        {
          code: "LARAVEL_ROUTE_UNSUPPORTED",
          message: `Skipped unsupported Laravel route declaration: ${statement}`,
          location: { file: filePath, line: lineNumber },
        },
      ],
    };
  }

  const method = routeMatch[1] as HttpMethod;
  const rawPath = routeMatch[3];
  const handlerText = routeMatch[4];
  const routeChain = routeMatch[5] ?? "";
  const routeContext = parseGroupContext(`Route::${routeChain}`, fileContext);
  const context = mergeGroupContexts([inheritedContext, routeContext]);
  const handler = parseHandler(handlerText, context.controller, fileContext);
  const analysis = await analyzeControllerHandler(
    handler,
    classIndex,
    controllerCache,
  );
  const normalizedPath = normalizeLaravelPath(
    joinRoutePath(context.prefixes, rawPath),
  );
  const authInference = inferBearerAuthFromMiddleware(
    "Laravel",
    context.middleware,
    config.auth.middlewarePatterns.bearer,
  );
  const routeWarnings = [
    ...analysis.warnings,
    ...authInference.warnings.map((warning) => ({
      ...warning,
      location: { file: filePath, line: lineNumber },
    })),
  ];
  const parameters = dedupeParameters([
    ...extractPathParameters(normalizedPath),
    ...analysis.queryParameters.filter(
      (parameter) => !normalizedPath.includes(`{${parameter.name}}`),
    ),
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
      responses:
        analysis.responses.length > 0
          ? analysis.responses
          : buildDefaultResponses(method),
      auth: authInference.auth,
      source: {
        file: filePath,
        line: lineNumber,
      },
      warnings: routeWarnings,
    },
    warnings: routeWarnings,
  };
}

async function parseResourceRoute(
  statement: string,
  inheritedContext: GroupContext,
  filePath: string,
  lineNumber: number,
  classIndex: Map<string, PhpClassRecord>,
  controllerCache: Map<string, ControllerAnalysis>,
  config: BrunogenConfig,
  fileContext: PhpFileContext,
): Promise<{ endpoints: NormalizedEndpoint[]; warnings: GenerationWarning[] }> {
  const match = statement.match(
    /Route::(?:apiResource|resource)\s*\(\s*(['"])(.*?)\1\s*,\s*([A-Za-z0-9_\\]+)::class\s*\)([\s\S]*);?$/,
  );

  if (!match) {
    return {
      endpoints: [],
      warnings: [
        {
          code: "LARAVEL_RESOURCE_UNSUPPORTED",
          message: `Skipped unsupported Laravel resource declaration: ${statement}`,
          location: { file: filePath, line: lineNumber },
        },
      ],
    };
  }

  const rawPath = match[2];
  const controller = resolvePhpClassName(match[3], fileContext);
  const chain = match[4] ?? "";
  const resourceContext = parseGroupContext(`Route::${chain}`, fileContext);
  const context = mergeGroupContexts([
    inheritedContext,
    resourceContext,
    { prefixes: [], middleware: [], controller },
  ]);
  const only = parseResourceScope(chain, "only");
  const except = parseResourceScope(chain, "except");
  const singularSegment = singularize(
    rawPath.split("/").filter(Boolean).pop() ?? "item",
  );
  const memberPath = `${rawPath.replace(/\/$/, "")}/{${singularSegment}}`;
  const resourceActions: Array<{
    method: HttpMethod;
    action: string;
    path: string;
  }> = [
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
  const authInference = inferBearerAuthFromMiddleware(
    "Laravel",
    context.middleware,
    config.auth.middlewarePatterns.bearer,
  );
  const authWarnings = authInference.warnings.map((warning) => ({
    ...warning,
    location: { file: filePath, line: lineNumber },
  }));

  for (const action of actions) {
    const handler: ParsedHandler = { controller, action: action.action };
    const analysis = await analyzeControllerHandler(
      handler,
      classIndex,
      controllerCache,
    );
    const normalizedPath = normalizeLaravelPath(
      joinRoutePath(context.prefixes, action.path),
    );
    endpoints.push({
      id: `${action.method}:${normalizedPath}`,
      method: action.method,
      path: normalizedPath,
      operationId: buildOperationId(action.method, normalizedPath, handler),
      summary: buildSummary(action.method, normalizedPath, handler),
      tags: [inferTag(normalizedPath, controller)],
      parameters: dedupeParameters([
        ...extractPathParameters(normalizedPath),
        ...analysis.queryParameters.filter(
          (parameter) => !normalizedPath.includes(`{${parameter.name}}`),
        ),
        ...analysis.headerParameters,
      ]),
      requestBody: analysis.requestBody,
      responses:
        analysis.responses.length > 0
          ? analysis.responses
          : buildDefaultResponses(action.method),
      auth: authInference.auth,
      source: {
        file: filePath,
        line: lineNumber,
      },
      warnings: [...analysis.warnings, ...authWarnings],
    });
    warnings.push(...analysis.warnings, ...authWarnings);
  }

  return { endpoints, warnings };
}

function parseResourceScope(
  chain: string,
  methodName: "only" | "except",
): string[] {
  const match = chain.match(new RegExp(`->${methodName}\\((.*?)\\)`));
  return match ? parsePhpStringList(match[1]) : [];
}

function parseHandler(
  handlerText: string,
  fallbackController?: string,
  fileContext?: PhpFileContext,
): ParsedHandler | undefined {
  const controllerArray = handlerText.match(
    /\[\s*([A-Za-z0-9_\\]+)::class\s*,\s*['"]([A-Za-z0-9_]+)['"]\s*\]/,
  );
  if (controllerArray?.[1] && controllerArray[2]) {
    return {
      controller: resolveControllerName(controllerArray[1], fileContext),
      action: controllerArray[2],
    };
  }

  const invokedController = handlerText.match(/([A-Za-z0-9_\\]+)::class/);
  if (invokedController?.[1]) {
    return {
      controller: resolveControllerName(invokedController[1], fileContext),
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

function resolveControllerName(
  input: string,
  fileContext?: PhpFileContext,
): string {
  return resolvePhpClassName(input, fileContext);
}

function countBraceDelta(input: string): number {
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
