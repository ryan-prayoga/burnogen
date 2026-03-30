import path from "node:path";
import { promises as fs } from "node:fs";

import { inferBearerAuthFromMiddleware } from "../core/auth-middleware";
import { listFiles, toPosixPath } from "../core/fs";
import { dedupeParameters, dedupeResponsesByStatusCode } from "../core/dedupe";
import { escapeRegExp, extractBalanced, splitOnce, splitTopLevel } from "../core/parsing";
import type {
  BrunogenConfig,
  GenerationWarning,
  HttpMethod,
  NormalizedEndpoint,
  NormalizedParameter,
  NormalizedProject,
  NormalizedRequestBody,
  NormalizedResponse,
  SchemaObject,
} from "../core/model";

interface ExpressFile {
  filePath: string;
  content: string;
}

interface ImportBinding {
  kind: "default" | "named" | "namespace";
  sourceFile: string;
  importedName?: string;
}

interface FileExports {
  defaultExpression?: string;
  defaultObject?: Record<string, string>;
  named: Map<string, string>;
}

interface ExpressFunctionRecord {
  filePath: string;
  name: string;
  params: string[];
  body: string;
}

interface RouterRecord {
  key: string;
  filePath: string;
  name: string;
  kind: "app" | "router";
  routes: RouteRecord[];
  mounts: MountRecord[];
  middleware: string[];
}

interface RouteRecord {
  filePath: string;
  line: number;
  method: HttpMethod;
  path: string;
  middleware: string[];
  handler: string;
}

interface MountRecord {
  line: number;
  path: string;
  middleware: string[];
  routerKey: string;
}

interface HandlerAnalysis {
  requestBody?: NormalizedRequestBody;
  queryParameters: NormalizedParameter[];
  headerParameters: NormalizedParameter[];
  responses: NormalizedResponse[];
  warnings: GenerationWarning[];
}

interface JoiFieldAnalysis {
  name: string;
  required: boolean;
  schema: SchemaObject;
}

interface JsExampleContext {
  reqName: string;
  assignments: Map<string, string>;
  cache: Map<string, unknown>;
  resolving: Set<string>;
}

interface ProjectIndex {
  files: Map<string, ExpressFile>;
  imports: Map<string, Map<string, ImportBinding>>;
  exports: Map<string, FileExports>;
  functions: Map<string, ExpressFunctionRecord>;
  routers: Map<string, RouterRecord>;
}

const httpMethods: HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
];
const defaultStatusByMethod: Record<HttpMethod, string> = {
  get: "200",
  post: "201",
  put: "200",
  patch: "200",
  delete: "204",
  head: "200",
  options: "200",
};

export async function scanExpressProject(
  root: string,
  projectName: string,
  projectVersion: string,
  config: BrunogenConfig,
): Promise<NormalizedProject> {
  const files = await loadExpressFiles(root);
  const fileMap = new Map(files.map((file) => [file.filePath, file]));
  const filePaths = new Set(fileMap.keys());
  const imports = new Map<string, Map<string, ImportBinding>>();
  const exports = new Map<string, FileExports>();
  const functions = new Map<string, ExpressFunctionRecord>();
  const routers = new Map<string, RouterRecord>();

  for (const file of files) {
    imports.set(file.filePath, parseImports(file, filePaths));
    exports.set(file.filePath, parseExports(file));
    for (const record of parseFunctions(file)) {
      functions.set(createFunctionKey(file.filePath, record.name), record);
    }
  }

  const index: ProjectIndex = {
    files: fileMap,
    imports,
    exports,
    functions,
    routers,
  };

  for (const file of files) {
    for (const router of parseRouters(file, index)) {
      routers.set(router.key, router);
    }
  }

  const incomingRouters = new Set<string>();
  for (const router of routers.values()) {
    for (const mount of router.mounts) {
      incomingRouters.add(mount.routerKey);
    }
  }

  const endpoints: NormalizedEndpoint[] = [];
  const warnings: GenerationWarning[] = [];
  const seenEndpoints = new Set<string>();
  const roots = [...routers.values()].filter(
    (router) => router.kind === "app" || !incomingRouters.has(router.key),
  );

  for (const router of roots) {
    collectRouterEndpoints({
      router,
      index,
      config,
      prefix: "",
      inheritedMiddleware: [],
      visited: new Set<string>(),
      endpoints,
      warnings,
      seenEndpoints,
    });
  }

  return {
    framework: "express",
    projectName,
    projectVersion,
    endpoints,
    warnings,
  };
}

async function loadExpressFiles(root: string): Promise<ExpressFile[]> {
  const filePaths = await listFiles(
    root,
    (filePath) =>
      /\.(?:[cm]?js|ts)$/.test(filePath) && !filePath.endsWith(".d.ts"),
    { ignoreDirectories: ["node_modules", ".git", "dist", "coverage"] },
  );

  const files: ExpressFile[] = [];
  for (const filePath of filePaths) {
    files.push({
      filePath,
      content: await fs.readFile(filePath, "utf8"),
    });
  }

  return files;
}

function parseImports(
  file: ExpressFile,
  knownFiles: Set<string>,
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  for (const match of file.content.matchAll(
    /import\s+([\s\S]+?)\s+from\s+["'](.+?)["']/g,
  )) {
    const rawBindings = match[1]?.trim();
    const source = match[2];
    if (!rawBindings || !source?.startsWith(".")) {
      continue;
    }

    const sourceFile = resolveLocalModule(file.filePath, source, knownFiles);
    if (!sourceFile) {
      continue;
    }

    if (rawBindings.startsWith("{")) {
      for (const part of splitTopLevel(rawBindings.slice(1, -1), ",")) {
        const parsed = parseImportPart(part);
        if (parsed) {
          bindings.set(parsed.localName, {
            kind: "named",
            importedName: parsed.importedName,
            sourceFile,
          });
        }
      }
      continue;
    }

    if (rawBindings.startsWith("* as ")) {
      const localName = rawBindings.slice(5).trim();
      bindings.set(localName, { kind: "namespace", sourceFile });
      continue;
    }

    const pieces = splitTopLevel(rawBindings, ",");
    const defaultImport = pieces[0]?.trim();
    if (defaultImport) {
      bindings.set(defaultImport, { kind: "default", sourceFile });
    }

    const namedBlock = pieces[1]?.trim();
    if (namedBlock?.startsWith("{") && namedBlock.endsWith("}")) {
      for (const part of splitTopLevel(namedBlock.slice(1, -1), ",")) {
        const parsed = parseImportPart(part);
        if (parsed) {
          bindings.set(parsed.localName, {
            kind: "named",
            importedName: parsed.importedName,
            sourceFile,
          });
        }
      }
    }
  }

  for (const match of file.content.matchAll(
    /const\s+\{\s*([^}]+)\s*\}\s*=\s*require\(\s*["'](.+?)["']\s*\)/g,
  )) {
    const rawBindings = match[1];
    const source = match[2];
    if (!rawBindings || !source?.startsWith(".")) {
      continue;
    }

    const sourceFile = resolveLocalModule(file.filePath, source, knownFiles);
    if (!sourceFile) {
      continue;
    }

    for (const part of splitTopLevel(rawBindings, ",")) {
      const parsed = parseImportPart(part);
      if (parsed) {
        bindings.set(parsed.localName, {
          kind: "named",
          importedName: parsed.importedName,
          sourceFile,
        });
      }
    }
  }

  for (const match of file.content.matchAll(
    /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\(\s*["'](.+?)["']\s*\)/g,
  )) {
    const localName = match[1];
    const source = match[2];
    if (!localName || !source?.startsWith(".")) {
      continue;
    }

    const sourceFile = resolveLocalModule(file.filePath, source, knownFiles);
    if (!sourceFile) {
      continue;
    }

    bindings.set(localName, { kind: "default", sourceFile });
  }

  return bindings;
}

function parseImportPart(
  rawPart: string,
): { importedName: string; localName: string } | null {
  const part = rawPart.trim();
  if (!part) {
    return null;
  }

  const aliasMatch = part.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/,
  );
  if (aliasMatch?.[1] && aliasMatch[2]) {
    return {
      importedName: aliasMatch[1],
      localName: aliasMatch[2],
    };
  }

  const cjsAliasMatch = part.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)$/,
  );
  if (cjsAliasMatch?.[1] && cjsAliasMatch[2]) {
    return {
      importedName: cjsAliasMatch[1],
      localName: cjsAliasMatch[2],
    };
  }

  return {
    importedName: part,
    localName: part,
  };
}

function parseExports(file: ExpressFile): FileExports {
  const named = new Map<string, string>();

  for (const match of file.content.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
  )) {
    if (match[1]) {
      named.set(match[1], match[1]);
    }
  }

  for (const match of file.content.matchAll(
    /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g,
  )) {
    if (match[1]) {
      named.set(match[1], match[1]);
    }
  }

  for (const match of file.content.matchAll(
    /exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*)/g,
  )) {
    if (match[1] && match[2]) {
      named.set(match[1], match[2]);
    }
  }

  for (const match of file.content.matchAll(
    /exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:function(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\(|\()/g,
  )) {
    if (match[1]) {
      named.set(match[1], match[1]);
    }
  }

  let defaultExpression: string | undefined;
  let defaultObject: Record<string, string> | undefined;

  const exportDefaultFunctionMatch = file.content.match(
    /export\s+default\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  );
  if (exportDefaultFunctionMatch?.[1]) {
    defaultExpression = exportDefaultFunctionMatch[1];
  }

  const exportDefaultMatch = file.content.match(
    /export\s+default\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;?/,
  );
  if (exportDefaultMatch?.[1] && exportDefaultMatch[1] !== "function") {
    defaultExpression = exportDefaultMatch[1];
  }

  const moduleExportsMatch = file.content.match(
    /module\.exports\s*=\s*([A-Za-z_][A-Za-z0-9_.]*)\s*;?/,
  );
  if (moduleExportsMatch?.[1]) {
    defaultExpression = moduleExportsMatch[1];
  }

  const namedExportBlock = file.content.match(/export\s*\{\s*([^}]+)\s*\}/);
  if (namedExportBlock?.[1]) {
    for (const part of splitTopLevel(namedExportBlock[1], ",")) {
      const parsed = parseImportPart(part);
      if (parsed) {
        named.set(parsed.localName, parsed.importedName);
      }
    }
  }

  const exportObjectMatch = matchAssignmentObject(
    file.content,
    "module.exports",
  );
  if (exportObjectMatch) {
    const parsedObject = parseObjectExportMap(exportObjectMatch);
    defaultObject = parsedObject;
    for (const [name, expression] of Object.entries(parsedObject)) {
      named.set(name, expression);
    }
  }

  const exportDefaultObjectMatch = matchExportDefaultObject(file.content);
  if (exportDefaultObjectMatch) {
    defaultObject = parseObjectExportMap(exportDefaultObjectMatch);
  }

  return {
    defaultExpression,
    defaultObject,
    named,
  };
}

function parseFunctions(file: ExpressFile): ExpressFunctionRecord[] {
  const records: ExpressFunctionRecord[] = [];

  for (const match of file.content.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[\s\S]*?>\s*)?\(([^)]*)\)\s*\{/g,
  )) {
    const name = match[1];
    const params = match[2];
    const fullMatch = match[0];
    if (!name || params === undefined) {
      continue;
    }

    const braceStart = (match.index ?? 0) + fullMatch.length - 1;
    const block = extractBalanced(file.content, braceStart, "{", "}");
    if (!block) {
      continue;
    }

    records.push({
      filePath: file.filePath,
      name,
      params: parseParamList(params),
      body: block,
    });
  }

  for (const match of file.content.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g,
  )) {
    const name = match[1];
    const params = match[2];
    const fullMatch = match[0];
    if (!name || params === undefined) {
      continue;
    }

    const braceStart = (match.index ?? 0) + fullMatch.length - 1;
    const block = extractBalanced(file.content, braceStart, "{", "}");
    if (!block) {
      continue;
    }

    records.push({
      filePath: file.filePath,
      name,
      params: parseParamList(params),
      body: block,
    });
  }

  for (const match of file.content.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*(?!\{)([^;]+);/g,
  )) {
    const name = match[1];
    const params = match[2];
    const expression = match[3];
    if (!name || params === undefined || !expression) {
      continue;
    }

    records.push({
      filePath: file.filePath,
      name,
      params: parseParamList(params),
      body: `{ return ${expression.trim()}; }`,
    });
  }

  for (const match of file.content.matchAll(
    /exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?function(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\(([^)]*)\)\s*\{/g,
  )) {
    const name = match[1];
    const params = match[2];
    const fullMatch = match[0];
    if (!name || params === undefined) {
      continue;
    }

    const braceStart = (match.index ?? 0) + fullMatch.length - 1;
    const block = extractBalanced(file.content, braceStart, "{", "}");
    if (!block) {
      continue;
    }

    records.push({
      filePath: file.filePath,
      name,
      params: parseParamList(params),
      body: block,
    });
  }

  for (const match of file.content.matchAll(
    /exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g,
  )) {
    const name = match[1];
    const params = match[2];
    const fullMatch = match[0];
    if (!name || params === undefined) {
      continue;
    }

    const braceStart = (match.index ?? 0) + fullMatch.length - 1;
    const block = extractBalanced(file.content, braceStart, "{", "}");
    if (!block) {
      continue;
    }

    records.push({
      filePath: file.filePath,
      name,
      params: parseParamList(params),
      body: block,
    });
  }

  return records;
}

function parseRouters(file: ExpressFile, index: ProjectIndex): RouterRecord[] {
  const routerKinds = new Map<string, "app" | "router">();
  const routers: RouterRecord[] = [];

  for (const match of file.content.matchAll(
    /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*express\s*\(\s*\)/g,
  )) {
    if (match[1]) {
      routerKinds.set(match[1], "app");
    }
  }

  for (const match of file.content.matchAll(
    /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:express\s*\.\s*Router|Router)\s*\(\s*\)/g,
  )) {
    if (match[1]) {
      routerKinds.set(match[1], "router");
    }
  }

  for (const [name, kind] of routerKinds) {
    routers.push({
      key: createRouterKey(file.filePath, name),
      filePath: file.filePath,
      name,
      kind,
      routes: parseRoutesForReceiver(file, name),
      mounts: [],
      middleware: [],
    });
  }

  const routerMap = new Map(routers.map((router) => [router.name, router]));
  const localRouterNames = new Set(routerMap.keys());
  for (const router of routers) {
    const calls = parseUseCalls(file, router.name);
    for (const call of calls) {
      const parsed = parseUseCallArguments(
        call.args,
        file.filePath,
        index,
        localRouterNames,
      );
      if (parsed.routerKeys.length > 0) {
        for (const routerKey of parsed.routerKeys) {
          router.mounts.push({
            line: call.line,
            path: parsed.path,
            middleware: parsed.middleware,
            routerKey,
          });
        }
      } else if (!parsed.path) {
        router.middleware.push(...parsed.middleware);
      }
    }
  }

  // Keep router declarations stable when parsing the same file multiple times.
  return [...routerMap.values()];
}

function parseRoutesForReceiver(
  file: ExpressFile,
  receiver: string,
): RouteRecord[] {
  const routes: RouteRecord[] = [];

  for (const method of httpMethods) {
    for (const call of findMethodCalls(file.content, receiver, method)) {
      const args = splitTopLevel(call.args, ",");
      const rawPath = parseStringLiteral(args[0] ?? "");
      const handler = args.at(-1)?.trim();
      if (!rawPath || !handler) {
        continue;
      }

      routes.push({
        filePath: file.filePath,
        line: call.line,
        method,
        path: rawPath,
        middleware: args
          .slice(1, -1)
          .map((value) => value.trim())
          .filter(Boolean),
        handler,
      });
    }
  }

  for (const routeCall of findRouteChainCalls(file.content, receiver)) {
    const routePath = parseStringLiteral(routeCall.pathArgs[0] ?? "");
    if (!routePath) {
      continue;
    }

    for (const chainedCall of routeCall.chainedCalls) {
      const args = splitTopLevel(chainedCall.args, ",");
      const handler = args.at(-1)?.trim();
      if (!handler) {
        continue;
      }

      routes.push({
        filePath: file.filePath,
        line: routeCall.line,
        method: chainedCall.method,
        path: routePath,
        middleware: args
          .slice(0, -1)
          .map((value) => value.trim())
          .filter(Boolean),
        handler,
      });
    }
  }

  return routes;
}

function parseUseCalls(
  file: ExpressFile,
  receiver: string,
): Array<{ args: string; line: number }> {
  return findMethodCalls(file.content, receiver, "use");
}

function findMethodCalls(
  content: string,
  receiver: string,
  method: string,
): Array<{ args: string; line: number; endIndex: number }> {
  const results: Array<{ args: string; line: number; endIndex: number }> = [];
  const regex = new RegExp(
    `\\b${escapeRegExp(receiver)}\\s*\\.\\s*${method}\\s*(?:<[\\s\\S]*?>\\s*)?\\(`,
    "g",
  );

  for (const match of content.matchAll(regex)) {
    const startIndex = match.index ?? 0;
    const openParenIndex = content.indexOf("(", startIndex);
    const argsBlock =
      openParenIndex >= 0
        ? extractBalanced(content, openParenIndex, "(", ")")
        : null;
    if (!argsBlock) {
      continue;
    }

    results.push({
      args: argsBlock.slice(1, -1),
      line: lineNumberAt(content, startIndex),
      endIndex: openParenIndex + argsBlock.length,
    });
  }

  return results;
}

function findRouteChainCalls(
  content: string,
  receiver: string,
): Array<{
  pathArgs: string[];
  chainedCalls: Array<{ method: HttpMethod; args: string }>;
  line: number;
}> {
  const results: Array<{
    pathArgs: string[];
    chainedCalls: Array<{ method: HttpMethod; args: string }>;
    line: number;
  }> = [];
  const regex = new RegExp(
    `\\b${escapeRegExp(receiver)}\\s*\\.\\s*route\\s*\\(`,
    "g",
  );

  for (const match of content.matchAll(regex)) {
    const startIndex = match.index ?? 0;
    const openParenIndex = content.indexOf("(", startIndex);
    const argsBlock =
      openParenIndex >= 0
        ? extractBalanced(content, openParenIndex, "(", ")")
        : null;
    if (!argsBlock) {
      continue;
    }

    const chainedCalls: Array<{ method: HttpMethod; args: string }> = [];
    let cursor = openParenIndex + argsBlock.length;

    while (cursor < content.length) {
      const remainder = content.slice(cursor);
      const chainedMatch = remainder.match(
        /^\s*\.\s*(get|post|put|patch|delete|head|options)\s*(?:<[\s\S]*?>\s*)?\(/i,
      );
      if (!chainedMatch?.[1]) {
        break;
      }

      const method = chainedMatch[1].toLowerCase() as HttpMethod;
      const methodIndex = cursor + chainedMatch[0].lastIndexOf("(");
      const methodArgs = extractBalanced(content, methodIndex, "(", ")");
      if (!methodArgs) {
        break;
      }

      chainedCalls.push({
        method,
        args: methodArgs.slice(1, -1),
      });

      cursor = methodIndex + methodArgs.length;
    }

    if (chainedCalls.length > 0) {
      results.push({
        pathArgs: splitTopLevel(argsBlock.slice(1, -1), ","),
        chainedCalls,
        line: lineNumberAt(content, startIndex),
      });
    }
  }

  return results;
}

function parseUseCallArguments(
  argsBlock: string,
  filePath: string,
  index: ProjectIndex,
  localRouterNames: Set<string>,
): {
  path: string;
  middleware: string[];
  routerKeys: string[];
} {
  const args = splitTopLevel(argsBlock, ",")
    .map((value) => value.trim())
    .filter(Boolean);
  let pathPrefix = "";
  let offset = 0;

  const literalPath = parseStringLiteral(args[0] ?? "");
  if (literalPath) {
    pathPrefix = literalPath;
    offset = 1;
  }

  const middleware: string[] = [];
  const routerKeys: string[] = [];

  for (const expression of args.slice(offset)) {
    const routerKey = resolveRouterExpression(
      filePath,
      expression,
      index,
      localRouterNames,
    );
    if (routerKey) {
      routerKeys.push(routerKey);
    } else {
      middleware.push(expression);
    }
  }

  return {
    path: pathPrefix,
    middleware,
    routerKeys,
  };
}

function collectRouterEndpoints(input: {
  router: RouterRecord;
  index: ProjectIndex;
  config: BrunogenConfig;
  prefix: string;
  inheritedMiddleware: string[];
  visited: Set<string>;
  endpoints: NormalizedEndpoint[];
  warnings: GenerationWarning[];
  seenEndpoints: Set<string>;
}): void {
  const {
    router,
    index,
    config,
    prefix,
    inheritedMiddleware,
    visited,
    endpoints,
    warnings,
    seenEndpoints,
  } = input;

  const visitKey = `${router.key}@${prefix}`;
  if (visited.has(visitKey)) {
    return;
  }
  visited.add(visitKey);

  const currentMiddleware = dedupeValues([
    ...inheritedMiddleware,
    ...router.middleware,
  ]);

  for (const route of router.routes) {
    const fullPath = normalizeExpressPath(joinRoutePath(prefix, route.path));
    const handlerAnalysis = analyzeExpressHandler(
      route.handler,
      route.filePath,
      index,
    );
    const routeMiddleware = dedupeValues([
      ...currentMiddleware,
      ...route.middleware,
    ]);
    const authInference = inferBearerAuthFromMiddleware(
      "Express",
      routeMiddleware,
      config.auth.middlewarePatterns.bearer,
    );
    const routeWarnings = handlerAnalysis.warnings.map((warning) => ({
      ...warning,
      location: warning.location ?? { file: route.filePath, line: route.line },
    }));
    const authWarnings = authInference.warnings.map((warning) => ({
      ...warning,
      location: { file: route.filePath, line: route.line },
    }));
    const endpointId = `${route.method}:${fullPath}:${route.line}`;

    if (seenEndpoints.has(endpointId)) {
      continue;
    }
    seenEndpoints.add(endpointId);

    endpoints.push({
      id: endpointId,
      method: route.method,
      path: fullPath,
      operationId: buildExpressOperationId(route, fullPath),
      summary: `${route.method.toUpperCase()} ${fullPath}`,
      tags: [inferTag(fullPath)],
      parameters: dedupeParameters([
        ...extractPathParameters(fullPath),
        ...handlerAnalysis.queryParameters,
        ...handlerAnalysis.headerParameters,
      ]),
      requestBody: handlerAnalysis.requestBody,
      responses:
        handlerAnalysis.responses.length > 0
          ? handlerAnalysis.responses
          : buildDefaultResponses(route.method),
      auth: authInference.auth,
      source: {
        file: route.filePath,
        line: route.line,
      },
      warnings: [...routeWarnings, ...authWarnings],
    });

    warnings.push(...routeWarnings, ...authWarnings);
  }

  for (const mount of router.mounts) {
    const childRouter = index.routers.get(mount.routerKey);
    if (!childRouter) {
      continue;
    }

    collectRouterEndpoints({
      router: childRouter,
      index,
      config,
      prefix: joinRoutePath(prefix, mount.path),
      inheritedMiddleware: dedupeValues([
        ...currentMiddleware,
        ...mount.middleware,
      ]),
      visited: new Set(visited),
      endpoints,
      warnings,
      seenEndpoints,
    });
  }
}

function analyzeExpressHandler(
  handlerExpression: string,
  filePath: string,
  index: ProjectIndex,
): HandlerAnalysis {
  const inlineHandler = parseInlineHandler(handlerExpression);
  const handlerRecord = inlineHandler
    ? { ...inlineHandler, filePath }
    : resolveHandlerReference(handlerExpression, filePath, index);

  if (!handlerRecord) {
    return {
      queryParameters: [],
      headerParameters: [],
      responses: [],
      warnings: [
        {
          code: "EXPRESS_HANDLER_NOT_FOUND",
          message: `Express: skipped handler '${handlerExpression}' because the reference could not be resolved for request/response inference.`,
        },
      ],
    };
  }

  const reqName = handlerRecord.params[0] ?? "req";
  const resName = handlerRecord.params[1] ?? "res";
  const exampleContext = createJsExampleContext(handlerRecord.body, reqName);
  const bodyFields = mergeExpressRequestFields(
    extractObjectFieldsFromRequest(
      handlerRecord.body,
      reqName,
      "body",
      exampleContext,
    ),
    inferJoiFieldsForHandler(handlerRecord, reqName, "body", index),
  );
  const queryFields = mergeExpressRequestFields(
    extractObjectFieldsFromRequest(
      handlerRecord.body,
      reqName,
      "query",
      exampleContext,
    ),
    inferJoiFieldsForHandler(handlerRecord, reqName, "query", index),
  );

  return {
    requestBody:
      bodyFields.length > 0
        ? {
            contentType: "application/json",
            schema: {
              type: "object",
              properties: Object.fromEntries(
                bodyFields.map((field) => [field.name, field.schema]),
              ),
              required: bodyFields
                .filter((field) => field.required)
                .map((field) => field.name),
            },
          }
        : undefined,
    queryParameters: queryFields.map((field) => ({
      name: field.name,
      in: "query",
      required: false,
      schema: field.schema,
    })),
    headerParameters: extractExpressHeaders(handlerRecord.body, reqName),
    responses: extractExpressResponses(
      handlerRecord,
      resName,
      exampleContext,
      index,
    ),
    warnings: [],
  };
}

function mergeExpressRequestFields(
  directFields: Array<{
    name: string;
    required: boolean;
    schema: SchemaObject;
  }>,
  joiFields: JoiFieldAnalysis[],
): Array<{ name: string; required: boolean; schema: SchemaObject }> {
  const fields = new Map<
    string,
    { name: string; required: boolean; schema: SchemaObject }
  >();

  for (const field of directFields) {
    fields.set(field.name, field);
  }

  for (const field of joiFields) {
    const existing = fields.get(field.name);
    fields.set(field.name, {
      name: field.name,
      required: existing?.required || field.required,
      schema: mergeSchemaObjects(existing?.schema, field.schema),
    });
  }

  return [...fields.values()];
}

function mergeSchemaObjects(
  base: SchemaObject | undefined,
  override: SchemaObject,
): SchemaObject {
  if (!base) {
    return override;
  }

  return {
    ...base,
    ...override,
    items: override.items ?? base.items,
    properties: override.properties ?? base.properties,
    required: override.required ?? base.required,
    enum: override.enum ?? base.enum,
  };
}

function inferJoiFieldsForHandler(
  handlerRecord: ExpressFunctionRecord,
  reqName: string,
  target: "body" | "query",
  index: ProjectIndex,
): JoiFieldAnalysis[] {
  const file = index.files.get(handlerRecord.filePath);
  if (!file) {
    return [];
  }

  const schemaNames = new Set<string>();
  const validateRegex = new RegExp(
    `([A-Za-z_][A-Za-z0-9_]*)\\s*\\.\\s*validate(?:Async)?\\(\\s*${escapeRegExp(reqName)}\\.${target}\\b`,
    "g",
  );
  for (const match of handlerRecord.body.matchAll(validateRegex)) {
    if (match[1]) {
      schemaNames.add(match[1]);
    }
  }

  const fields = new Map<string, JoiFieldAnalysis>();
  for (const schemaName of schemaNames) {
    for (const field of extractJoiSchemaFields(file.content, schemaName)) {
      const existing = fields.get(field.name);
      fields.set(field.name, {
        name: field.name,
        required: existing?.required || field.required,
        schema: mergeSchemaObjects(existing?.schema, field.schema),
      });
    }
  }

  for (const field of extractInlineJoiSchemaFields(
    handlerRecord.body,
    reqName,
    target,
  )) {
    const existing = fields.get(field.name);
    fields.set(field.name, {
      name: field.name,
      required: existing?.required || field.required,
      schema: mergeSchemaObjects(existing?.schema, field.schema),
    });
  }

  return [...fields.values()];
}

function extractJoiSchemaFields(
  content: string,
  schemaName: string,
): JoiFieldAnalysis[] {
  const definitionRegex = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(schemaName)}\\s*=`,
    "g",
  );

  for (const match of content.matchAll(definitionRegex)) {
    const startIndex = match.index ?? -1;
    if (startIndex < 0) {
      continue;
    }

    const equalsIndex = content.indexOf("=", startIndex);
    const endIndex =
      equalsIndex >= 0
        ? findTopLevelStatementTerminator(content, equalsIndex + 1)
        : -1;
    if (equalsIndex < 0 || endIndex < 0) {
      continue;
    }

    const expression = content.slice(equalsIndex + 1, endIndex).trim();
    const fields = extractJoiFieldsFromSchemaExpression(expression);

    if (fields.length > 0) {
      return fields;
    }
  }

  return [];
}

function extractInlineJoiSchemaFields(
  body: string,
  reqName: string,
  target: "body" | "query",
): JoiFieldAnalysis[] {
  const statements = new Set<string>();
  const inlineRegex =
    /[A-Za-z_][A-Za-z0-9_.]*\s*\.\s*object\s*(?:<[\s\S]*?>\s*)?\(/g;
  const validateRegex = new RegExp(
    `\\.\\s*validate(?:Async)?\\(\\s*${escapeRegExp(reqName)}\\.${target}\\b`,
  );

  for (const match of body.matchAll(inlineRegex)) {
    const startIndex = match.index ?? -1;
    if (startIndex < 0) {
      continue;
    }

    const endIndex = findTopLevelStatementTerminator(body, startIndex);
    if (endIndex < 0) {
      continue;
    }

    const statement = body.slice(startIndex, endIndex).trim();
    if (!validateRegex.test(statement)) {
      continue;
    }

    statements.add(statement);
  }

  const fields = new Map<string, JoiFieldAnalysis>();
  for (const statement of statements) {
    for (const field of extractJoiFieldsFromSchemaExpression(statement)) {
      const existing = fields.get(field.name);
      fields.set(field.name, {
        name: field.name,
        required: existing?.required || field.required,
        schema: mergeSchemaObjects(existing?.schema, field.schema),
      });
    }
  }

  return [...fields.values()];
}

function extractJoiFieldsFromSchemaExpression(
  expression: string,
): JoiFieldAnalysis[] {
  const objectBlock = extractJoiObjectBlock(expression);
  if (!objectBlock) {
    return [];
  }

  const fields: JoiFieldAnalysis[] = [];
  for (const entry of splitTopLevel(objectBlock.slice(1, -1), ",")) {
    const property = parseObjectLiteralEntry(entry);
    if (!property) {
      continue;
    }

    const parsed = parseJoiFieldExpression(property.value);
    if (!parsed) {
      continue;
    }

    fields.push({
      name: property.key,
      required: parsed.required,
      schema: parsed.schema,
    });
  }

  return fields;
}

function extractJoiObjectBlock(expression: string): string | null {
  const objectMatch = expression.match(
    /[A-Za-z_][A-Za-z0-9_.]*\s*\.\s*object\s*(?:<[\s\S]*?>\s*)?\(/,
  );
  if (!objectMatch) {
    return null;
  }

  const objectCallIndex = expression.indexOf(objectMatch[0]);
  const objectOpenParenIndex = expression.indexOf("(", objectCallIndex);
  const objectArgs =
    objectOpenParenIndex >= 0
      ? extractBalanced(expression, objectOpenParenIndex, "(", ")")
      : null;

  if (objectArgs) {
    const directObject = splitTopLevel(objectArgs.slice(1, -1), ",")[0]?.trim();
    if (directObject?.startsWith("{")) {
      const directBlock = extractBalanced(directObject, 0, "{", "}");
      if (directBlock) {
        return directBlock;
      }
    }
  }

  const keysMatch = expression.match(/\.\s*keys\s*\(/);
  if (!keysMatch) {
    return null;
  }

  const keysOpenParenIndex = expression.indexOf(
    "(",
    expression.indexOf(keysMatch[0]),
  );
  const keysArgs =
    keysOpenParenIndex >= 0
      ? extractBalanced(expression, keysOpenParenIndex, "(", ")")
      : null;
  if (!keysArgs) {
    return null;
  }

  const keysObject = splitTopLevel(keysArgs.slice(1, -1), ",")[0]?.trim();
  if (!keysObject?.startsWith("{")) {
    return null;
  }

  return extractBalanced(keysObject, 0, "{", "}");
}

function parseJoiFieldExpression(
  expression: string,
): { required: boolean; schema: SchemaObject } | null {
  const trimmed = expression.trim();
  if (!trimmed) {
    return null;
  }

  const schema: SchemaObject = {};
  let required = false;
  let baseType: SchemaObject["type"] = "string";
  const typeMatch = trimmed.match(
    /^[A-Za-z_][A-Za-z0-9_.]*\s*\.\s*(array|boolean|number|object|string)\s*\(/,
  );
  if (typeMatch?.[1]) {
    baseType = typeMatch[1] as SchemaObject["type"];
  }

  schema.type = baseType;

  if (/\.integer\s*\(/.test(trimmed)) {
    schema.type = "integer";
  }

  if (schema.type === "object") {
    const nestedFields = extractJoiFieldsFromSchemaExpression(trimmed);
    if (nestedFields.length > 0) {
      schema.properties = Object.fromEntries(
        nestedFields.map((field) => [field.name, field.schema]),
      );
      const requiredFields = nestedFields
        .filter((field) => field.required)
        .map((field) => field.name);
      schema.required = requiredFields.length > 0 ? requiredFields : undefined;
    }
  }

  if (/\.email\s*\(/.test(trimmed)) {
    schema.format = "email";
  }

  const minMatch = trimmed.match(/\.min\(\s*(-?\d+)\s*\)/);
  if (minMatch?.[1]) {
    const minValue = Number.parseInt(minMatch[1], 10);
    if (schema.type === "string") {
      schema.minLength = minValue;
    } else {
      schema.minimum = minValue;
    }
  }

  const maxMatch = trimmed.match(/\.max\(\s*(-?\d+)\s*\)/);
  if (maxMatch?.[1]) {
    const maxValue = Number.parseInt(maxMatch[1], 10);
    if (schema.type === "string") {
      schema.maxLength = maxValue;
    } else {
      schema.maximum = maxValue;
    }
  }

  const defaultMatch = trimmed.match(/\.default\(\s*([\s\S]+?)\s*\)(?:\.|$)/);
  if (defaultMatch?.[1]) {
    const defaultExample = buildExampleFromJsExpression(defaultMatch[1]);
    schema.default = defaultExample;
  }

  const validMatch = trimmed.match(/\.valid\(([\s\S]+?)\)(?:\.|$)/);
  if (validMatch?.[1]) {
    schema.enum = splitTopLevel(validMatch[1], ",")
      .map((value) => buildExampleFromJsExpression(value))
      .filter((value) => value !== undefined) as Array<
      string | number | boolean
    >;
  }

  const itemsMatch = trimmed.match(/\.items\(\s*([\s\S]+?)\s*\)(?:\.|$)/);
  if (schema.type === "array" && itemsMatch?.[1]) {
    schema.items = parseJoiFieldExpression(itemsMatch[1])?.schema ?? {
      type: "string",
    };
  }

  if (/\.required\s*\(/.test(trimmed)) {
    required = true;
  }

  if (/\.optional\s*\(/.test(trimmed)) {
    required = false;
  }

  return {
    required,
    schema,
  };
}

function parseInlineHandler(expression: string): ExpressFunctionRecord | null {
  const trimmed = expression.trim();
  const functionMatch = trimmed.match(
    /^(?:async\s+)?function(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\(([^)]*)\)\s*\{/,
  );
  if (functionMatch?.[1] !== undefined) {
    const braceStart = trimmed.indexOf("{");
    const block =
      braceStart >= 0 ? extractBalanced(trimmed, braceStart, "{", "}") : null;
    if (!block) {
      return null;
    }

    return {
      filePath: "",
      name: "inlineHandler",
      params: parseParamList(functionMatch[1]),
      body: block,
    };
  }

  const arrowMatch = trimmed.match(/^(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/);
  if (arrowMatch?.[1] !== undefined) {
    const braceStart = trimmed.indexOf("{");
    const block =
      braceStart >= 0 ? extractBalanced(trimmed, braceStart, "{", "}") : null;
    if (!block) {
      return null;
    }

    return {
      filePath: "",
      name: "inlineHandler",
      params: parseParamList(arrowMatch[1]),
      body: block,
    };
  }

  return null;
}

function resolveHandlerReference(
  expression: string,
  filePath: string,
  index: ProjectIndex,
): ExpressFunctionRecord | null {
  const trimmed = expression.trim().replace(/^await\s+/, "");

  const direct = index.functions.get(createFunctionKey(filePath, trimmed));
  if (direct) {
    return direct;
  }

  const memberMatch = trimmed.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/,
  );
  if (memberMatch?.[1] && memberMatch[2]) {
    const importedRecord = resolveImportedMember(
      filePath,
      memberMatch[1],
      memberMatch[2],
      index,
    );
    if (importedRecord) {
      return importedRecord;
    }
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    const importedRecord = resolveImportedIdentifier(filePath, trimmed, index);
    if (importedRecord) {
      return importedRecord;
    }

    const globalCandidates = [...index.functions.entries()]
      .filter(([key]) => key.endsWith(`::${trimmed}`))
      .map(([, record]) => record);
    if (globalCandidates.length === 1) {
      return globalCandidates[0];
    }
  }

  return null;
}

function resolveImportedIdentifier(
  filePath: string,
  identifier: string,
  index: ProjectIndex,
): ExpressFunctionRecord | null {
  const binding = index.imports.get(filePath)?.get(identifier);
  if (!binding) {
    return null;
  }

  if (binding.kind === "named") {
    const expression = index.exports
      .get(binding.sourceFile)
      ?.named.get(binding.importedName ?? identifier);
    return expression
      ? (index.functions.get(
          createFunctionKey(binding.sourceFile, expression),
        ) ?? null)
      : null;
  }

  if (binding.kind === "default") {
    const expression = index.exports.get(binding.sourceFile)?.defaultExpression;
    return expression
      ? (index.functions.get(
          createFunctionKey(binding.sourceFile, expression),
        ) ?? null)
      : null;
  }

  return null;
}

function resolveImportedMember(
  filePath: string,
  identifier: string,
  property: string,
  index: ProjectIndex,
): ExpressFunctionRecord | null {
  const binding = index.imports.get(filePath)?.get(identifier);
  if (!binding) {
    return null;
  }

  const targetExports = index.exports.get(binding.sourceFile);
  if (!targetExports) {
    return null;
  }

  const expression =
    targetExports.defaultObject?.[property] ??
    targetExports.named.get(property);
  if (!expression) {
    return null;
  }

  return (
    index.functions.get(createFunctionKey(binding.sourceFile, expression)) ??
    null
  );
}

function resolveRouterExpression(
  filePath: string,
  expression: string,
  index: ProjectIndex,
  localRouterNames: Set<string>,
): string | null {
  const trimmed = expression.trim();
  const memberMatch = trimmed.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/,
  );

  if (memberMatch?.[1] && memberMatch[2]) {
    const binding = index.imports.get(filePath)?.get(memberMatch[1]);
    const targetExports = binding
      ? index.exports.get(binding.sourceFile)
      : undefined;
    const exportedExpression =
      targetExports?.defaultObject?.[memberMatch[2]] ??
      targetExports?.named.get(memberMatch[2]);
    if (
      binding?.sourceFile &&
      exportedExpression &&
      fileDeclaresRouter(
        index.files.get(binding.sourceFile),
        exportedExpression,
      )
    ) {
      return createRouterKey(binding.sourceFile, exportedExpression);
    }
  }

  const binding = index.imports.get(filePath)?.get(trimmed);
  if (binding?.kind === "default") {
    const exportedExpression = index.exports.get(
      binding.sourceFile,
    )?.defaultExpression;
    if (
      !exportedExpression ||
      !fileDeclaresRouter(
        index.files.get(binding.sourceFile),
        exportedExpression,
      )
    ) {
      return null;
    }

    return createRouterKey(binding.sourceFile, exportedExpression);
  }

  if (binding?.kind === "named") {
    const exportedExpression =
      index.exports
        .get(binding.sourceFile)
        ?.named.get(binding.importedName ?? trimmed) ?? binding.importedName;
    if (
      !exportedExpression ||
      !fileDeclaresRouter(
        index.files.get(binding.sourceFile),
        exportedExpression,
      )
    ) {
      return null;
    }

    return createRouterKey(binding.sourceFile, exportedExpression);
  }

  if (localRouterNames.has(trimmed)) {
    return createRouterKey(filePath, trimmed);
  }

  return null;
}

function extractObjectFieldsFromRequest(
  body: string,
  reqName: string,
  target: "body" | "query",
  exampleContext: JsExampleContext,
): Array<{ name: string; required: boolean; schema: SchemaObject }> {
  const fields = new Map<string, { required: boolean; schema: SchemaObject }>();

  for (const match of body.matchAll(
    new RegExp(
      `${escapeRegExp(reqName)}\\.${target}(?:\\?\\.|\\.)\\s*([A-Za-z_][A-Za-z0-9_]*)`,
      "g",
    ),
  )) {
    if (match[1]) {
      fields.set(match[1], {
        required: false,
        schema: inferExpressRequestFieldSchema(
          match[1],
          reqName,
          target,
          exampleContext,
        ),
      });
    }
  }

  for (const match of body.matchAll(
    new RegExp(
      `${escapeRegExp(reqName)}\\.${target}\\[\\s*["'\`]([^"'\\\`]+)["'\`]\\s*\\]`,
      "g",
    ),
  )) {
    if (match[1]) {
      fields.set(match[1], {
        required: false,
        schema: inferExpressRequestFieldSchema(
          match[1],
          reqName,
          target,
          exampleContext,
        ),
      });
    }
  }

  for (const match of body.matchAll(
    new RegExp(
      `(?:const|let|var)\\s+\\{\\s*([^}]+)\\s*\\}\\s*=\\s*${escapeRegExp(reqName)}\\.${target}\\b`,
      "g",
    ),
  )) {
    const destructured = match[1];
    if (!destructured) {
      continue;
    }

    for (const part of splitTopLevel(destructured, ",")) {
      const field = parseDestructuredField(part);
      if (!field) {
        continue;
      }

      fields.set(field.sourceName, {
        required: field.required && target === "body",
        schema: inferExpressRequestFieldSchema(
          field.sourceName,
          reqName,
          target,
          exampleContext,
          field.defaultExpression,
        ),
      });
    }
  }

  return [...fields.entries()].map(([name, value]) => ({
    name,
    required: value.required,
    schema: value.schema,
  }));
}

function parseDestructuredField(
  part: string,
): {
  sourceName: string;
  localName: string;
  required: boolean;
  defaultExpression?: string;
} | null {
  const cleaned = part.trim();
  if (!cleaned || cleaned.startsWith("...")) {
    return null;
  }

  const [rawBinding, rawDefault] = splitOnce(cleaned, "=");
  const withoutDefault = rawBinding.trim();
  if (!withoutDefault) {
    return null;
  }

  const pieces = withoutDefault
    .split(":")
    .map((value: string) => value.trim())
    .filter(Boolean);
  const sourceName = pieces[0];
  const localName = pieces[1] ?? sourceName;
  if (
    !sourceName ||
    !localName ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceName)
  ) {
    return null;
  }

  return {
    sourceName,
    localName,
    required: !cleaned.includes("="),
    defaultExpression: rawDefault ? rawDefault.trim() : undefined,
  };
}

function extractExpressHeaders(
  body: string,
  reqName: string,
): NormalizedParameter[] {
  const headers = new Map<string, string>();

  for (const match of body.matchAll(
    new RegExp(
      `${escapeRegExp(reqName)}\\.(?:get|header)\\(\\s*["'\`]([^"'\\\`]+)["'\`]`,
      "g",
    ),
  )) {
    if (match[1]) {
      headers.set(match[1].toLowerCase(), match[1]);
    }
  }

  for (const match of body.matchAll(
    new RegExp(
      `${escapeRegExp(reqName)}\\.headers\\[\\s*["'\`]([^"'\\\`]+)["'\`]\\s*\\]`,
      "g",
    ),
  )) {
    if (match[1]) {
      headers.set(
        match[1].toLowerCase(),
        headers.get(match[1].toLowerCase()) ?? match[1],
      );
    }
  }

  for (const match of body.matchAll(
    new RegExp(
      `${escapeRegExp(reqName)}\\.headers\\.([A-Za-z_][A-Za-z0-9_-]*)`,
      "g",
    ),
  )) {
    if (match[1]) {
      headers.set(
        match[1].toLowerCase(),
        headers.get(match[1].toLowerCase()) ?? match[1],
      );
    }
  }

  for (const match of body.matchAll(
    new RegExp(
      `(?:const|let|var)\\s+\\{\\s*([^}]+)\\s*\\}\\s*=\\s*${escapeRegExp(reqName)}\\.headers\\b`,
      "g",
    ),
  )) {
    const destructured = match[1];
    if (!destructured) {
      continue;
    }

    for (const part of splitTopLevel(destructured, ",")) {
      const field = parseDestructuredField(part);
      if (field) {
        headers.set(
          field.sourceName.toLowerCase(),
          headers.get(field.sourceName.toLowerCase()) ?? field.sourceName,
        );
      }
    }
  }

  return [...headers.values()].map((name) => ({
    name,
    in: "header",
    required: false,
    schema: { type: "string" },
  }));
}

function extractExpressResponses(
  handlerRecord: ExpressFunctionRecord,
  resName: string,
  exampleContext: JsExampleContext,
  index: ProjectIndex,
  depth = 0,
): NormalizedResponse[] {
  const body = handlerRecord.body;
  const responses = new Map<string, NormalizedResponse>();

  const statusRegex = new RegExp(
    `\\b${escapeRegExp(resName)}\\s*\\.\\s*status\\s*\\(`,
    "g",
  );
  for (const match of body.matchAll(statusRegex)) {
    const statusStart = match.index ?? 0;
    const statusOpenParen = body.indexOf("(", statusStart);
    const statusArgs =
      statusOpenParen >= 0
        ? extractBalanced(body, statusOpenParen, "(", ")")
        : null;
    if (!statusArgs) {
      continue;
    }

    const statusCode = normalizeExpressStatusCodeExpression(
      statusArgs.slice(1, -1),
      exampleContext,
    );
    if (!statusCode) {
      continue;
    }

    const cursor = statusOpenParen + statusArgs.length;
    const remainder = body.slice(cursor);
    const responseMatch = remainder.match(/^\s*\.\s*(json|send)\s*\(/);
    if (!responseMatch?.[1]) {
      continue;
    }

    const method = responseMatch[1];
    const responseOpenParen = body.indexOf("(", cursor);
    const responseArgs =
      responseOpenParen >= 0
        ? extractBalanced(body, responseOpenParen, "(", ")")
        : null;
    if (!responseArgs) {
      continue;
    }

    responses.set(
      statusCode,
      buildExpressResponse(
        statusCode,
        responseArgs.slice(1, -1),
        method,
        exampleContext,
      ),
    );
  }

  const defaultRegex = new RegExp(
    `\\b${escapeRegExp(resName)}\\s*\\.\\s*(json|send)\\s*\\(`,
    "g",
  );
  for (const match of body.matchAll(defaultRegex)) {
    const method = match[1];
    const startIndex = match.index ?? 0;
    const prefix = body.slice(Math.max(0, startIndex - 20), startIndex);
    if (/status\s*\(\s*\d{3}\s*\)\s*\.$/.test(prefix)) {
      continue;
    }

    const openParenIndex = body.indexOf("(", startIndex + match[0].length - 1);
    const argsBlock =
      openParenIndex >= 0
        ? extractBalanced(body, openParenIndex, "(", ")")
        : null;
    if (!method || !argsBlock || responses.has("200")) {
      continue;
    }

    responses.set(
      "200",
      buildExpressResponse(
        "200",
        argsBlock.slice(1, -1),
        method,
        exampleContext,
      ),
    );
  }

  const sendStatusRegex = new RegExp(
    `\\b${escapeRegExp(resName)}\\s*\\.\\s*sendStatus\\s*\\(\\s*(\\d{3})\\s*\\)`,
    "g",
  );
  for (const match of body.matchAll(sendStatusRegex)) {
    const statusCode = match[1];
    if (statusCode && !responses.has(statusCode)) {
      responses.set(statusCode, {
        statusCode,
        description: "Express sendStatus response",
      });
    }
  }

  if (depth < 2) {
    for (const helperResponse of extractExpressHelperResponses(
      handlerRecord,
      resName,
      exampleContext,
      index,
      depth,
    )) {
      if (!responses.has(helperResponse.statusCode)) {
        responses.set(helperResponse.statusCode, helperResponse);
      }
    }
  }

  return [...responses.values()];
}

function buildExpressResponse(
  statusCode: string,
  rawArgs: string,
  method: string,
  exampleContext: JsExampleContext,
): NormalizedResponse {
  const firstArg = splitTopLevel(rawArgs, ",")[0]?.trim();
  const example = firstArg
    ? buildExampleFromJsExpression(firstArg, exampleContext)
    : undefined;
  const schema =
    example !== undefined
      ? inferSchemaFromJsExample(example)
      : firstArg
        ? inferSchemaFromJsExpression(firstArg)
        : undefined;

  return {
    statusCode,
    description:
      method === "json" ? "Inferred JSON response" : "Inferred response",
    contentType: method === "json" ? "application/json" : "text/plain",
    schema,
    example,
  };
}

function extractExpressHelperResponses(
  handlerRecord: ExpressFunctionRecord,
  resName: string,
  exampleContext: JsExampleContext,
  index: ProjectIndex,
  depth: number,
): NormalizedResponse[] {
  const responses: NormalizedResponse[] = [];

  for (const statement of extractReturnStatements(handlerRecord.body)) {
    const helperCall = parseExpressHelperReturnStatement(statement);
    if (!helperCall) {
      continue;
    }

    const conventionalResponse = inferExpressConventionalHelperResponse(
      helperCall,
      exampleContext,
    );
    if (conventionalResponse) {
      responses.push(conventionalResponse);
    }

    const helperRecord =
      resolveHandlerReference(
        helperCall.expression,
        handlerRecord.filePath,
        index,
      ) ??
      index.functions.get(
        createFunctionKey(handlerRecord.filePath, helperCall.expression),
      );
    if (!helperRecord) {
      continue;
    }

    const seedAssignments = new Map(exampleContext.assignments);
    helperRecord.params.forEach((paramName, index) => {
      const argExpression = helperCall.args[index];
      if (paramName && argExpression) {
        seedAssignments.set(
          paramName,
          materializeJsArgumentExpression(argExpression, exampleContext),
        );
      }
    });

    const helperReqName =
      helperRecord.params.find(
        (paramName, index) =>
          helperCall.args[index]?.trim() === exampleContext.reqName,
      ) ?? exampleContext.reqName;
    const helperResName =
      helperRecord.params.find(
        (paramName, index) => helperCall.args[index]?.trim() === resName,
      ) ?? resName;
    const helperContext = createJsExampleContext(
      helperRecord.body,
      helperReqName,
      seedAssignments,
    );
    responses.push(
      ...extractExpressResponses(
        helperRecord,
        helperResName,
        helperContext,
        index,
        depth + 1,
      ),
    );
  }

  return dedupeResponsesByStatusCode(responses);
}

function inferExpressConventionalHelperResponse(
  helperCall: { expression: string; args: string[] },
  exampleContext: JsExampleContext,
): NormalizedResponse | undefined {
  const helperName =
    helperCall.expression.split(".").pop()?.toLowerCase() ?? "";
  if (!helperName) {
    return undefined;
  }

  if (helperName.includes("validation")) {
    const errors = helperCall.args[1]
      ? buildExampleFromJsExpression(helperCall.args[1], exampleContext)
      : {};
    return buildExpressResponseFromExample("422", {
      errors,
    });
  }

  if (helperName.includes("conflict")) {
    const error = helperCall.args[1]
      ? buildExampleFromJsExpression(helperCall.args[1], exampleContext)
      : "Conflict";
    return buildExpressResponseFromExample("409", {
      success: false,
      error,
    });
  }

  if (helperName.includes("notfound")) {
    const error = helperCall.args[1]
      ? buildExampleFromJsExpression(helperCall.args[1], exampleContext)
      : "Not found";
    return buildExpressResponseFromExample("404", {
      success: false,
      error,
    });
  }

  if (helperName.includes("created")) {
    const data = helperCall.args[1]
      ? buildExampleFromJsExpression(helperCall.args[1], exampleContext)
      : {};
    return buildExpressResponseFromExample("201", {
      success: true,
      data,
    });
  }

  if (helperName.includes("success")) {
    const data = helperCall.args[1]
      ? buildExampleFromJsExpression(helperCall.args[1], exampleContext)
      : {};
    const statusCode = helperCall.args[2]
      ? normalizeExpressStatusCodeExpression(helperCall.args[2], exampleContext)
      : "200";
    return buildExpressResponseFromExample(statusCode ?? "200", {
      success: true,
      data,
    });
  }

  if (helperName.includes("error")) {
    const error = helperCall.args[1]
      ? buildExampleFromJsExpression(helperCall.args[1], exampleContext)
      : "Error";
    const statusCode = helperCall.args[2]
      ? normalizeExpressStatusCodeExpression(helperCall.args[2], exampleContext)
      : "400";
    return buildExpressResponseFromExample(statusCode ?? "400", {
      success: false,
      error,
    });
  }

  return undefined;
}

function buildExpressResponseFromExample(
  statusCode: string,
  example: unknown,
): NormalizedResponse {
  return {
    statusCode,
    description: "Inferred helper response",
    contentType: "application/json",
    schema: inferSchemaFromJsExample(example),
    example,
  };
}

function parseExpressHelperReturnStatement(
  statement: string,
): { expression: string; args: string[] } | undefined {
  const match = statement.match(
    /^return\s+(?:await\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\(/,
  );
  if (!match?.[1]) {
    return undefined;
  }

  const openParenIndex = statement.indexOf("(", match[0].length - 1);
  const argsBlock =
    openParenIndex >= 0
      ? extractBalanced(statement, openParenIndex, "(", ")")
      : null;
  if (!argsBlock) {
    return undefined;
  }

  return {
    expression: match[1],
    args: splitTopLevel(argsBlock.slice(1, -1), ","),
  };
}

function extractReturnStatements(body: string): string[] {
  const statements: string[] = [];
  let offset = 0;

  while (offset < body.length) {
    const returnIndex = body.indexOf("return", offset);
    if (returnIndex < 0) {
      break;
    }

    const statementEnd = findTopLevelStatementTerminator(body, returnIndex);
    if (statementEnd < 0) {
      break;
    }

    statements.push(body.slice(returnIndex, statementEnd + 1).trim());
    offset = statementEnd + 1;
  }

  return statements;
}

function inferSchemaFromJsExpression(
  expression: string,
): SchemaObject | undefined {
  const trimmed = expression.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed === "null") {
    return { nullable: true };
  }

  if (trimmed === "true" || trimmed === "false") {
    return { type: "boolean" };
  }

  if (/^-?\d+$/.test(trimmed)) {
    return { type: "integer" };
  }

  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return { type: "number" };
  }

  if (parseStringLiteral(trimmed) !== undefined) {
    return { type: "string" };
  }

  if (trimmed.startsWith("[")) {
    const block = extractBalanced(trimmed, 0, "[", "]");
    const firstItem = block
      ? splitTopLevel(block.slice(1, -1), ",")[0]
      : undefined;
    return {
      type: "array",
      items: firstItem
        ? (inferSchemaFromJsExpression(firstItem) ?? { type: "string" })
        : { type: "string" },
    };
  }

  if (trimmed.startsWith("{")) {
    const block = extractBalanced(trimmed, 0, "{", "}");
    if (!block) {
      return { type: "object" };
    }

    const properties: Record<string, SchemaObject> = {};
    for (const entry of splitTopLevel(block.slice(1, -1), ",")) {
      const property = parseObjectLiteralEntry(entry);
      if (!property) {
        continue;
      }

      properties[property.key] = inferSchemaFromJsExpression(
        property.value,
      ) ?? { type: "string" };
    }

    return {
      type: "object",
      properties,
    };
  }

  return { type: "string" };
}

function buildExampleFromJsExpression(
  expression: string,
  context?: JsExampleContext,
): unknown {
  const trimmed = expression.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsedInteger = trimmed.match(
    /^(?:Number\.)?parseInt\((.+?)(?:,\s*\d+)?\)$/,
  );
  if (parsedInteger?.[1]) {
    const resolved = buildExampleFromJsExpression(parsedInteger[1], context);
    return typeof resolved === "number" ? Math.trunc(resolved) : 1;
  }

  const parsedFloat = trimmed.match(/^(?:Number\.)?parseFloat\((.+)\)$/);
  if (parsedFloat?.[1]) {
    const resolved = buildExampleFromJsExpression(parsedFloat[1], context);
    return typeof resolved === "number" ? resolved : 1.5;
  }

  const numericCast = trimmed.match(/^Number\((.+)\)$/);
  if (numericCast?.[1]) {
    const resolved = buildExampleFromJsExpression(numericCast[1], context);
    return typeof resolved === "number" ? resolved : 1;
  }

  const booleanCast = trimmed.match(/^Boolean\((.+)\)$/);
  if (booleanCast?.[1]) {
    return Boolean(buildExampleFromJsExpression(booleanCast[1], context));
  }

  if (isBooleanComparisonExpression(trimmed)) {
    const normalized = trimmed.toLowerCase();
    if (normalized.includes("false")) {
      return false;
    }

    return true;
  }

  const nullishOperands = splitTopLevelSequence(trimmed, "??");
  if (nullishOperands.length > 1) {
    const structuralFallback = selectStructuredFallbackOperand(
      nullishOperands,
      context,
    );
    if (structuralFallback) {
      return buildExampleFromJsExpression(structuralFallback, context);
    }

    for (const operand of nullishOperands) {
      const resolved = buildExampleFromJsExpression(operand, context);
      if (resolved !== undefined && resolved !== null && resolved !== "") {
        return resolved;
      }
    }
    return undefined;
  }

  const fallbackOperands = splitTopLevelSequence(trimmed, "||");
  if (fallbackOperands.length > 1) {
    const structuralFallback = selectStructuredFallbackOperand(
      fallbackOperands,
      context,
    );
    if (structuralFallback) {
      return buildExampleFromJsExpression(structuralFallback, context);
    }

    for (const operand of fallbackOperands) {
      const resolved = buildExampleFromJsExpression(operand, context);
      if (resolved !== undefined && resolved !== null && resolved !== "") {
        return resolved;
      }
    }
    return undefined;
  }

  if (trimmed === "null") {
    return null;
  }

  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }

  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }

  const stringLiteral = parseStringLiteral(trimmed);
  if (stringLiteral !== undefined) {
    return stringLiteral;
  }

  const requestAccessorExample = inferJsRequestAccessorExample(
    trimmed,
    context,
  );
  if (requestAccessorExample !== undefined) {
    return requestAccessorExample;
  }

  if (trimmed.startsWith("[")) {
    const block = extractBalanced(trimmed, 0, "[", "]");
    if (!block) {
      return [];
    }

    return splitTopLevel(block.slice(1, -1), ",").map((item) =>
      buildExampleFromJsExpression(item, context),
    );
  }

  if (trimmed.startsWith("{")) {
    const block = extractBalanced(trimmed, 0, "{", "}");
    if (!block) {
      return {};
    }

    const result: Record<string, unknown> = {};
    for (const entry of splitTopLevel(block.slice(1, -1), ",")) {
      const property = parseObjectLiteralEntry(entry);
      if (!property) {
        continue;
      }

      result[property.key] = buildExampleFromJsExpression(
        property.value,
        context,
      );
    }
    return result;
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    const resolved = resolveJsVariableExample(trimmed, context);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  return "";
}

function materializeJsArgumentExpression(
  expression: string,
  context?: JsExampleContext,
): string {
  const example = buildExampleFromJsExpression(expression, context);
  if (example === undefined || example === "") {
    return expression;
  }

  return serializeJsExample(example);
}

function inferSchemaFromJsExample(example: unknown): SchemaObject | undefined {
  if (example === undefined) {
    return undefined;
  }

  if (example === null) {
    return { nullable: true };
  }

  if (Array.isArray(example)) {
    return {
      type: "array",
      items:
        example.length > 0
          ? (inferSchemaFromJsExample(example[0]) ?? { type: "string" })
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
            ([key, value]) => [
              key,
              inferSchemaFromJsExample(value) ?? { type: "string" },
            ],
          ),
        ),
      };
    default:
      return { type: "string" };
  }
}

function serializeJsExample(example: unknown): string {
  if (example === null) {
    return "null";
  }

  if (typeof example === "string") {
    return JSON.stringify(example);
  }

  if (typeof example === "number" || typeof example === "boolean") {
    return String(example);
  }

  if (Array.isArray(example) || typeof example === "object") {
    return JSON.stringify(example);
  }

  return '""';
}

function parseObjectLiteralEntry(
  entry: string,
): { key: string; value: string } | null {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.startsWith("...")) {
    return null;
  }

  const separatorIndex = findTopLevelSeparator(trimmed, ":");
  if (separatorIndex < 0) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      return { key: trimmed, value: trimmed };
    }
    return null;
  }

  const rawKey = trimmed.slice(0, separatorIndex).trim();
  const key = parseStringLiteral(rawKey) ?? rawKey;
  if (!key) {
    return null;
  }

  return {
    key,
    value: trimmed.slice(separatorIndex + 1).trim(),
  };
}

function createJsExampleContext(
  body: string,
  reqName: string,
  seedAssignments?: Map<string, string>,
): JsExampleContext {
  const assignments = new Map(seedAssignments ?? []);

  for (const [name, expression] of extractJsVariableAssignments(
    body,
    reqName,
  )) {
    assignments.set(name, expression);
  }

  return {
    reqName,
    assignments,
    cache: new Map(),
    resolving: new Set(),
  };
}

function extractJsVariableAssignments(
  body: string,
  reqName: string,
): Map<string, string> {
  const assignments = new Map<string, string>();

  for (const match of body.matchAll(
    /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g,
  )) {
    const variableName = match[1];
    const startIndex = match.index ?? -1;
    if (!variableName || startIndex < 0) {
      continue;
    }

    const equalsIndex = body.indexOf("=", startIndex);
    const endIndex = findTopLevelStatementTerminator(body, equalsIndex + 1);
    if (equalsIndex < 0 || endIndex < 0) {
      continue;
    }

    assignments.set(variableName, body.slice(equalsIndex + 1, endIndex).trim());
  }

  for (const target of ["body", "query", "params", "headers"] as const) {
    const regex = new RegExp(
      `(?:const|let|var)\\s+\\{\\s*([^}]+)\\s*\\}\\s*=\\s*${escapeRegExp(reqName)}\\.${target}\\b`,
      "g",
    );
    for (const match of body.matchAll(regex)) {
      const destructured = match[1];
      if (!destructured) {
        continue;
      }

      for (const part of splitTopLevel(destructured, ",")) {
        const parsed = parseJsDestructuredAssignment(part);
        if (!parsed) {
          continue;
        }

        const accessor =
          target === "headers"
            ? `${reqName}.headers[${JSON.stringify(parsed.sourceName)}]`
            : `${reqName}.${target}.${parsed.sourceName}`;
        assignments.set(
          parsed.localName,
          parsed.defaultExpression
            ? `${accessor} ?? ${parsed.defaultExpression}`
            : accessor,
        );
      }
    }
  }

  return assignments;
}

function parseJsDestructuredAssignment(
  part: string,
): {
  sourceName: string;
  localName: string;
  defaultExpression?: string;
} | null {
  const cleaned = part.trim();
  if (!cleaned || cleaned.startsWith("...")) {
    return null;
  }

  const [rawBinding, rawDefault] = splitOnce(cleaned, "=");
  const withoutDefault = rawBinding.trim();
  if (!withoutDefault) {
    return null;
  }

  const pieces = withoutDefault
    .split(":")
    .map((value: string) => value.trim())
    .filter(Boolean);
  const sourceName = pieces[0];
  const localName = pieces[1] ?? sourceName;
  if (!sourceName || !localName) {
    return null;
  }

  return {
    sourceName,
    localName,
    defaultExpression: rawDefault ? rawDefault.trim() : undefined,
  };
}

function resolveJsVariableExample(
  name: string,
  context?: JsExampleContext,
): unknown {
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
  const resolved = buildExampleFromJsExpression(expression, context);
  context.resolving.delete(name);
  context.cache.set(name, resolved);
  return resolved;
}

function inferExpressRequestFieldSchema(
  fieldName: string,
  reqName: string,
  target: "body" | "query",
  context: JsExampleContext,
  defaultExpression?: string,
): SchemaObject {
  if (defaultExpression) {
    const defaultExample = buildExampleFromJsExpression(
      defaultExpression,
      context,
    );
    const inferred = inferSchemaFromJsExample(defaultExample);
    if (inferred) {
      return inferred;
    }
  }

  for (const expression of context.assignments.values()) {
    if (
      !expressionReferencesRequestField(expression, reqName, target, fieldName)
    ) {
      continue;
    }

    const inferred = inferSchemaFromJsExample(
      buildExampleFromJsExpression(expression, context),
    );
    if (inferred) {
      return inferred;
    }
  }

  return { type: "string" };
}

function expressionReferencesRequestField(
  expression: string,
  reqName: string,
  target: "body" | "query",
  fieldName: string,
): boolean {
  const patterns = [
    new RegExp(
      `${escapeRegExp(reqName)}\\.${target}\\.(${escapeRegExp(fieldName)})\\b`,
    ),
    new RegExp(
      `${escapeRegExp(reqName)}\\.${target}\\[\\s*["'\`]${escapeRegExp(fieldName)}["'\`]\\s*\\]`,
    ),
  ];

  return patterns.some((pattern) => pattern.test(expression));
}

function inferJsRequestAccessorExample(
  expression: string,
  context?: JsExampleContext,
): unknown {
  const reqName = context?.reqName ?? "req";
  const directBody = expression.match(
    new RegExp(`^${escapeRegExp(reqName)}\\.body\\.([A-Za-z_][A-Za-z0-9_]*)$`),
  );
  if (directBody?.[1]) {
    return buildJsFieldExample(directBody[1], "body");
  }

  const directQuery = expression.match(
    new RegExp(`^${escapeRegExp(reqName)}\\.query\\.([A-Za-z_][A-Za-z0-9_]*)$`),
  );
  if (directQuery?.[1]) {
    return buildJsFieldExample(directQuery[1], "query");
  }

  const directParam = expression.match(
    new RegExp(
      `^${escapeRegExp(reqName)}\\.params\\.([A-Za-z_][A-Za-z0-9_]*)$`,
    ),
  );
  if (directParam?.[1]) {
    return buildJsFieldExample(directParam[1], "params");
  }

  const bodyBracket = expression.match(
    new RegExp(
      `^${escapeRegExp(reqName)}\\.body\\[(["'\`])([^"'\\\`]+)\\1\\]$`,
    ),
  );
  if (bodyBracket?.[2]) {
    return buildJsFieldExample(bodyBracket[2], "body");
  }

  const queryBracket = expression.match(
    new RegExp(
      `^${escapeRegExp(reqName)}\\.query\\[(["'\`])([^"'\\\`]+)\\1\\]$`,
    ),
  );
  if (queryBracket?.[2]) {
    return buildJsFieldExample(queryBracket[2], "query");
  }

  const paramBracket = expression.match(
    new RegExp(
      `^${escapeRegExp(reqName)}\\.params\\[(["'\`])([^"'\\\`]+)\\1\\]$`,
    ),
  );
  if (paramBracket?.[2]) {
    return buildJsFieldExample(paramBracket[2], "params");
  }

  const headerBracket = expression.match(
    new RegExp(
      `^${escapeRegExp(reqName)}\\.headers\\[(["'\`])([^"'\\\`]+)\\1\\]$`,
    ),
  );
  if (headerBracket?.[2]) {
    return buildJsFieldExample(headerBracket[2], "headers");
  }

  const headerDot = expression.match(
    new RegExp(
      `^${escapeRegExp(reqName)}\\.headers\\.([A-Za-z_][A-Za-z0-9_-]*)$`,
    ),
  );
  if (headerDot?.[1]) {
    return buildJsFieldExample(headerDot[1], "headers");
  }

  const getHeader = expression.match(
    new RegExp(
      `^${escapeRegExp(reqName)}\\.(?:get|header)\\((["'\`])([^"'\\\`]+)\\1\\)$`,
    ),
  );
  if (getHeader?.[2]) {
    return buildJsFieldExample(getHeader[2], "headers");
  }

  return undefined;
}

function buildJsFieldExample(
  fieldName: string,
  source: "body" | "query" | "params" | "headers",
): unknown {
  const normalized = fieldName.trim().toLowerCase();

  if (source === "headers") {
    if (normalized.includes("authorization")) {
      return "Bearer token";
    }

    if (normalized.includes("trace")) {
      return "trace_123";
    }

    if (normalized.includes("token")) {
      return fieldName === fieldName.toUpperCase()
        ? `${fieldName}_VALUE`
        : "token";
    }

    return `${fieldName}_VALUE`;
  }

  if (source === "params") {
    if (normalized === "id" || normalized.endsWith("_id")) {
      return 1;
    }

    return fieldName;
  }

  if (normalized.includes("email")) {
    return "user@example.com";
  }

  if (normalized === "name") {
    return "Jane Doe";
  }

  if (normalized === "age" || normalized.endsWith("_age")) {
    return 18;
  }

  if (normalized === "page" || normalized.endsWith("_page")) {
    return 1;
  }

  if (normalized === "limit" || normalized.endsWith("_limit")) {
    return 10;
  }

  if (normalized.includes("password")) {
    return "secret123";
  }

  if (normalized === "role") {
    return "user";
  }

  if (source === "query" && normalized === "order") {
    return "asc";
  }

  if (normalized.includes("token")) {
    return "token";
  }

  if (normalized.includes("trace")) {
    return "trace_123";
  }

  if (normalized.startsWith("is_") || normalized.startsWith("has_")) {
    return true;
  }

  return fieldName;
}

function buildExpressOperationId(route: RouteRecord, pathname: string): string {
  const handlerPart = route.handler
    .replace(/[^a-zA-Z0-9.]/g, "")
    .replace(/\./g, "");

  if (handlerPart && handlerPart !== "inlineHandler") {
    return handlerPart;
  }

  const pathPart = pathname
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .map(capitalize)
    .join("");

  return `${route.method}${pathPart || "Root"}`;
}

function buildDefaultResponses(method: HttpMethod): NormalizedResponse[] {
  return [
    {
      statusCode: defaultStatusByMethod[method],
      description: "Generated default response",
    },
  ];
}

function normalizeExpressPath(pathname: string): string {
  return (
    pathname
      .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
      .replace(/\*([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "") || "/"
  );
}

function extractPathParameters(pathname: string): NormalizedParameter[] {
  return [...pathname.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

function inferTag(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? "default";
}

function joinRoutePath(prefix: string, rawPath: string): string {
  const segments = [prefix, rawPath]
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return `/${segments.join("/")}`.replace(/\/+/g, "/");
}

function parseParamList(rawParams: string): string[] {
  return splitTopLevel(rawParams, ",")
    .map((parameter) => parameter.trim().replace(/^\.\.\./, ""))
    .filter(Boolean)
    .map((parameter) => {
      const withoutDefault = splitOnce(parameter, "=")[0]?.trim() ?? parameter;
      const separatorIndex = findTopLevelSeparator(withoutDefault, ":");
      const candidate =
        separatorIndex >= 0
          ? withoutDefault.slice(0, separatorIndex)
          : withoutDefault;
      return candidate.replace(/^[{[]|[}\]]$/g, "").trim();
    })
    .filter((parameter) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter));
}

function normalizeExpressStatusCodeExpression(
  expression: string,
  context: JsExampleContext,
): string | undefined {
  const trimmed = expression.trim();
  if (/^\d{3}$/.test(trimmed)) {
    return trimmed;
  }

  const resolved = buildExampleFromJsExpression(trimmed, context);
  if (
    typeof resolved === "number" &&
    Number.isInteger(resolved) &&
    resolved >= 100 &&
    resolved <= 599
  ) {
    return String(resolved);
  }

  return undefined;
}

function isBooleanComparisonExpression(expression: string): boolean {
  return (
    /===\s*(?:true|false|["'`](?:true|false)["'`])/.test(expression) ||
    /!==\s*(?:true|false|["'`](?:true|false)["'`])/.test(expression)
  );
}

function selectStructuredFallbackOperand(
  operands: string[],
  context?: JsExampleContext,
): string | undefined {
  const hasRequestOperand = operands.some(
    (operand) =>
      inferJsRequestAccessorExample(operand.trim(), context) !== undefined,
  );
  if (!hasRequestOperand) {
    return undefined;
  }

  return operands.find((operand) => /^[\[{]/.test(operand.trim()));
}

function resolveLocalModule(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.mjs"),
    path.join(basePath, "index.cjs"),
  ];

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function fileDeclaresRouter(
  file: ExpressFile | undefined,
  symbolName: string,
): boolean {
  if (!file) {
    return false;
  }

  const appRegex = new RegExp(
    `(?:const|let|var)\\s+${escapeRegExp(symbolName)}\\s*=\\s*express\\s*\\(\\s*\\)`,
  );
  const routerRegex = new RegExp(
    `(?:const|let|var)\\s+${escapeRegExp(symbolName)}\\s*=\\s*(?:express\\s*\\.\\s*Router|Router)\\s*\\(\\s*\\)`,
  );
  return appRegex.test(file.content) || routerRegex.test(file.content);
}

function matchAssignmentObject(
  content: string,
  assignment: string,
): string | null {
  const regex = new RegExp(`${escapeRegExp(assignment)}\\s*=\\s*\\{`, "g");
  const match = regex.exec(content);
  if (!match) {
    return null;
  }

  const braceStart = content.indexOf("{", match.index);
  return braceStart >= 0
    ? extractBalanced(content, braceStart, "{", "}")
    : null;
}

function matchExportDefaultObject(content: string): string | null {
  const regex = /export\s+default\s+\{/g;
  const match = regex.exec(content);
  if (!match) {
    return null;
  }

  const braceStart = content.indexOf("{", match.index);
  return braceStart >= 0
    ? extractBalanced(content, braceStart, "{", "}")
    : null;
}

function parseObjectExportMap(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of splitTopLevel(block.slice(1, -1), ",")) {
    const entry = parseObjectLiteralEntry(part);
    if (!entry) {
      const bare = part.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) {
        result[bare] = bare;
      }
      continue;
    }

    result[entry.key] = entry.value;
  }
  return result;
}

function parseStringLiteral(value: string): string | undefined {
  const match = value.trim().match(/^(["'`])([\s\S]*)\1$/);
  return match?.[2];
}

function createFunctionKey(filePath: string, expression: string): string {
  return `${toPosixPath(filePath)}::${expression}`;
}

function createRouterKey(filePath: string, name: string): string {
  return `${toPosixPath(filePath)}::${name}`;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function findTopLevelSeparator(input: string, separator: string): number {
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
      return index;
    }
  }

  return -1;
}

function splitTopLevelSequence(input: string, sequence: string): string[] {
  const results: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
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

    if (character === "'" || character === '"' || character === "`") {
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

function findTopLevelStatementTerminator(
  input: string,
  startIndex: number,
): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
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
      character === ";" &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

function dedupeValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function capitalize(input: string): string {
  return input ? `${input[0].toUpperCase()}${input.slice(1)}` : input;
}
