/**
 * AST-based Express.js route scanner and handler analyzer.
 * Uses @typescript-eslint/parser for proper AST parsing of JS/TS files.
 * Falls back to regex-based parsing (via legacy adapter) for unsupported syntax.
 */

import path from "node:path";
import { promises as fs } from "node:fs";

import { inferBearerAuthFromMiddleware } from "../core/auth-middleware";
import { listFiles, toPosixPath } from "../core/fs";
import { dedupeParameters, dedupeResponsesByStatusCode } from "../core/dedupe";
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

import {
  ASTRouteInfo,
  RequestAccessPattern,
  ResponseReturnPattern,
} from "../core/ast-types";

// Dynamic import — eslint is a devDependency, optional at runtime
let parserModule: typeof import("@typescript-eslint/parser") | null = null;
let ESLintParser: any = null;

async function getParser() {
  if (!parserModule) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      parserModule = await import("@typescript-eslint/parser");
      ESLintParser = parserModule.parse || (parserModule as any).parseForESLint?.parse;
    } catch {
      throw new Error(
        "AST parser unavailable. Install @typescript-eslint/parser for Express scanning."
      );
    }
  }
  return parserModule as typeof import("@typescript-eslint/parser");
}

function parseWithEslint(
  code: string,
  filePath: string,
) {
  // Try TypeScript parser first, fall back to ecmaVersion only
  const sourceType: "module" | "script" = /\.m?ts$/.test(filePath) ? "module" : "script";

  // Use parseForESLint which returns { ast, services }
  try {
    const mod = require("@typescript-eslint/parser");
    if (mod.parseForESLint) {
      const { ast } = mod.parseForESLint(code, {
        filePath,
        ecmaVersion: 2022,
        sourceType,
        comment: true,
        loc: true,
        range: true,
        tokens: true,
      });
      return ast;
    }
  } catch {
    // Fall through
  }

  throw new Error("Could not initialize TypeScript ESTree parser for Express scanning.");
}

// ─── AST Node helpers ──────────────────────────────────────────

interface LocInfo {
  line?: number;
}

function getLoc(node: any): LocInfo {
  return node?.loc?.start ? { line: node.loc.start.line } : {};
}

function getStringValue(node: any): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.quasis?.length > 0)
    return node.quasis[0].value.cooked;
  return null;
}

function getPropertyName(property: any): string | null {
  if (!property) return null;
  if (property.type === "Identifier") return property.name;
  if (property.type === "Literal") return String(property.value);
  return null;
}

// ─── Express file loading ──────────────────────────────────────

interface ExpressFile {
  filePath: string;
  content: string;
  ast: any;
}

async function loadExpressAstFiles(
  root: string,
): Promise<ExpressFile[]> {
  const filePaths = await listFiles(
    root,
    (fp) => /\.(?:[cm]?js|ts)$/.test(fp) && !fp.endsWith(".d.ts"),
    { ignoreDirectories: ["node_modules", ".git", "dist", "coverage"] },
  );

  const files: ExpressFile[] = [];
  for (const filePath of filePaths) {
    const content = await fs.readFile(filePath, "utf8");
    let ast: any;
    try {
      ast = parseWithEslint(content, filePath);
    } catch {
      // Skip files that can't be parsed
      continue;
    }
    if (ast) {
      files.push({ filePath, content, ast });
    }
  }
  return files;
}

// ─── Import / Export resolution (AST-based) ────────────────────

interface ImportBinding {
  kind: "default" | "named" | "namespace";
  sourceFile: string;
  importedName?: string;
}

interface FileExports {
  defaultExpression?: string;
  named: Map<string, string>;
}

function parseImportsAst(
  file: ExpressFile,
  knownFiles: Set<string>,
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  for (const node of walkAst(file.ast)) {
    if (node.type !== "ImportDeclaration") continue;
    const source = getStringValue(node.source);
    if (!source?.startsWith(".")) continue;

    const sourceFile = resolveLocalModulePath(file.filePath, source, knownFiles) ?? source;

    for (const spec of node.specifiers ?? []) {
      if (spec.type === "ImportDefaultSpecifier") {
        bindings.set(spec.local.name, {
          kind: "default",
          sourceFile,
        });
      } else if (spec.type === "ImportNamespaceSpecifier") {
        bindings.set(spec.local.name, {
          kind: "namespace",
          sourceFile,
        });
      } else if (spec.type === "ImportSpecifier") {
        bindings.set(spec.local.name, {
          kind: "named",
          sourceFile,
          importedName: getPropertyName(spec.imported) ?? undefined,
        });
      }
    }
  }

  // Also handle require() calls: const { x } = require('./y')
  for (const node of walkAst(file.ast)) {
    if (node.type !== "VariableDeclaration") continue;
    for (const decl of node.declarations ?? []) {
      const init = decl.init;
      if (
        init?.type === "CallExpression" &&
        init.callee?.type === "Identifier" &&
        init.callee.name === "require"
      ) {
        const source = getStringValue(init.arguments?.[0]);
        if (!source?.startsWith(".")) continue;
        const sourceFile = resolveLocalModulePath(file.filePath, source, knownFiles) ?? source;

        if (decl.id?.type === "ObjectPattern") {
          for (const prop of decl.id.properties ?? []) {
            const name = getPropertyName(prop.key) ?? prop.value?.name;
            if (name) {
              bindings.set(name, { kind: "named", sourceFile });
            }
          }
        } else if (decl.id?.type === "Identifier") {
          bindings.set(decl.id.name, { kind: "default", sourceFile });
        }
      }
    }
  }

  return bindings;
}

function parseExportsAst(file: ExpressFile): FileExports {
  const named = new Map<string, string>();
  let defaultExpression: string | undefined;

  for (const node of walkAst(file.ast)) {
    // export function foo() {}
    if (node.type === "FunctionDeclaration" && node.export) {
      named.set(node.id.name, node.id.name);
    }

    // export const foo = ...
    if (node.type === "VariableDeclaration" && node.export) {
      for (const decl of node.declarations ?? []) {
        if (decl.id?.type === "Identifier") {
          named.set(decl.id.name, decl.id.name);
        }
      }
    }

    // export default ...
    if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (decl?.type === "FunctionDeclaration" && decl.id) {
        defaultExpression = decl.id.name;
        named.set(decl.id.name, decl.id.name);
      } else if (decl?.type === "Identifier") {
        defaultExpression = decl.name;
      }
    }

    // module.exports = foo
    if (node.type === "AssignmentExpression") {
      const left = node.left;
      if (left?.type === "MemberExpression") {
        const objName = getTargetName(left.object);
        if (objName === "module" && getPropertyName(left.property) === "exports") {
          defaultExpression = getTargetName(node.right) ?? undefined;
        }
        if (objName === "exports") {
          const propName = getPropertyName(left.property);
          if (propName) {
            named.set(propName, getTargetName(node.right) ?? propName);
          }
        }
      }
    }
  }

  return { defaultExpression, named };
}

// ─── Router detection (AST-based) ──────────────────────────────

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

const httpMethods: HttpMethod[] = [
  "get", "post", "put", "patch", "delete", "head", "options",
];

function isExpressAppOrRouter(node: any): boolean {
  // app.use(), express(), Router()
  if (node.type === "CallExpression") {
    const callee = node.callee;
    if (callee?.type === "Identifier") {
      return callee.name === "express" || callee.name === "Router";
    }
  }
  return false;
}

function parseRoutersAst(
  file: ExpressFile,
  fileMap: Map<string, ExpressFile>,
  imports: Map<string, Map<string, ImportBinding>>,
  exports: Map<string, FileExports>,
): RouterRecord[] {
  const routers: RouterRecord[] = [];
  const fileImports = imports.get(file.filePath) ?? new Map();
  const knownFiles = new Set(fileMap.keys());

  for (const node of walkAst(file.ast)) {
    // Router() / express() creation
    if (
      node.type === "VariableDeclarator" &&
      node.init?.type === "CallExpression"
    ) {
      const callee = node.init.callee;
      if (
        callee?.type === "Identifier" &&
        (callee.name === "Router" || callee.name === "express")
      ) {
        const name = node.id?.type === "Identifier" ? node.id.name : "default";
        const kind = callee.name === "express" ? "app" : "router";

        routers.push({
          key: `${file.filePath}#${name}`,
          filePath: file.filePath,
          name,
          kind,
          routes: [],
          mounts: [],
          middleware: [],
        });
      }
    }

    // app.use('/path', router) — router mounts
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (!callee) continue;
      const objName = getTargetName(callee.object);
      const propName = getPropertyName(callee.property);

      if (propName === "use") {
        const args = node.arguments ?? [];
        const mountPath = args.length > 0 ? getStringValue(args[0]) : "";
        const mountMiddleware =
          args.length > 1 ? getTargetName(args[1]) : getTargetName(args[0]);

        // Check if the mounted thing is a router (imported or local variable)
        if (mountMiddleware) {
          // Check if it comes from another file via import
          const imp = fileImports.get(mountMiddleware);
          const mountSourceFile = imp?.sourceFile;

          routers.push({
            key: mountSourceFile
              ? `${mountSourceFile}#${mountMiddleware}`
              : `${file.filePath}#${mountMiddleware}`,
            filePath: mountSourceFile ?? file.filePath,
            name: mountMiddleware,
            kind: "router",
            routes: [],
            mounts: [],
            middleware: [],
          });
        }
      }
    }
  }

  // Now find route registrations for each router
  for (const router of routers) {
    if (router.filePath !== file.filePath) continue;

    // Pre-scan: extract chain routes (router.route().get().put().delete())
    // AST nesting makes this pattern very difficult to parse properly,
    // so we use a regex pre-scan for this specific pattern.
    // Pre-scan: extract chain routes (router.route().get().put().delete())
    // We use simple text-based line scanning — avoids regex escaping hell
    const text = file.content;
    const fileLines = text.split("\n");
    for (let ln = 0; ln < fileLines.length; ln++) {
      const trimmed = fileLines[ln].trim();
      // Match: routerName.route("path") or routerName.route('path')
      const pathMatch = trimmed.match(new RegExp("^" + escapeRx(router.name) + "\\.route\\s*\\(\\s*(['\"`])([^'\"`\\s]+)\\1"));
      if (!pathMatch) continue;
      const routePath = pathMatch[2];

      // Look ahead for chained method calls on following lines
      let methodLine = ln + 1;
      while (methodLine < fileLines.length) {
        const methodTrimmed = fileLines[methodLine].trim();
        if (methodTrimmed === ";" || methodTrimmed === "") break;
        if (!methodTrimmed.startsWith(".")) break;

        const methodMatch = methodTrimmed.match(/^\.(get|post|put|patch|delete|head|options)\s*\(([^)]*)\)/);
        if (methodMatch) {
          const method = methodMatch[1];
          const argsText = methodMatch[2].trim();
          const parts = argsText.split(",").map(s => s.trim()).filter(Boolean);
          let handler = "anonymous";
          const middleware: string[] = [];
          if (parts.length > 0) {
            const hMatch = parts[parts.length - 1].match(/([a-zA-Z_$]\w*)/);
            if (hMatch) handler = hMatch[1];
            for (let i = 0; i < parts.length - 1; i++) {
              const mMatch = parts[i].match(/([a-zA-Z_$]\w*)/);
              if (mMatch) middleware.push(mMatch[1]);
            }
          }
          router.routes.push({
            filePath: file.filePath,
            line: ln + 1,
            method: method as HttpMethod,
            path: routePath,
            middleware,
            handler,
          });
        }
        methodLine++;
      }
    }

    // AST scan: direct router.get('/', handler), app.post('/', handler)
    for (const node of walkAst(file.ast)) {
      if (node.type !== "CallExpression") continue;

      const callee = node.callee;
      const objName = getTargetName(callee?.object);
      const propName = getPropertyName(callee?.property);

      // Skip nodes that are part of a chain (callee.object is a CallExpression)
      if (callee?.object?.type === "CallExpression") continue;

      if (objName === router.name && propName && httpMethods.includes(propName as HttpMethod)) {
        const args = node.arguments ?? [];
        const routePath = args.length > 0 ? getStringValue(args[0]) ?? "/" : "/";
        const handlerExpr = args.length > 1 ? args[1] : args[0];
        const handler = getTargetName(handlerExpr) ?? "anonymous";

        const middleware: string[] = [];
        if (args.length > 2) {
          for (let i = 1; i < args.length - 1; i++) {
            const mw = getTargetName(args[i]);
            if (mw) middleware.push(mw);
          }
        }

        router.routes.push({
          filePath: file.filePath,
          line: getLoc(node).line ?? 1,
          method: propName as HttpMethod,
          path: routePath,
          middleware,
          handler,
        });
      }
    }
  }

}

interface ChainedCallResult {
  has: (method: string) => boolean;
  get: (method: string) => any | undefined;
}

function findPropertyCalls(node: any): ChainedCallResult {
  const chainCalls = new Map<string, any>();
  let current: any = node;

  // If the node is a CallExpression with a MemberExpression callee, follow the chain
  while (current?.type === "CallExpression" && current.callee?.type === "MemberExpression") {
    const prop = getPropertyName(current.callee.property);
    if (prop && httpMethods.includes(prop as HttpMethod)) {
      chainCalls.set(prop, current);
    }
    current = current.callee.object;
  }

  return {
    has: (method: string) => chainCalls.has(method),
    get: (method: string) => chainCalls.get(method),
  };
}

function findChainedCallNode(node: any, method: string): any {
  // Walk through chained calls to find the specific method call
  let current: any = node;
  while (current?.type === "CallExpression" && current.callee?.type === "MemberExpression") {
    const prop = getPropertyName(current.callee.property);
    if (prop === method) {
      return current;
    }
    current = current.callee.object;
  }
  return null;
}

// ─── Handler analysis (AST-based) ──────────────────────────────

const defaultStatusByMethod: Record<HttpMethod, string> = {
  get: "200", post: "201", put: "200", patch: "200",
  delete: "204", head: "200", options: "200",
};

interface HandlerAnalysis {
  requestBody?: NormalizedRequestBody;
  queryParameters: NormalizedParameter[];
  headerParameters: NormalizedParameter[];
  responses: NormalizedResponse[];
  warnings: GenerationWarning[];
}

function analyzeHandlerAst(
  handlerName: string,
  functions: Map<string, FunctionRecord>,
  config: BrunogenConfig,
): HandlerAnalysis {
  const fn = functions.get(handlerName);
  if (!fn) {
    return {
      queryParameters: [],
      headerParameters: [],
      responses: [],
      warnings: [{
        code: "EXPRESS_HANDLER_NOT_FOUND",
        message: `Handler function "${handlerName}" not found for analysis.`,
      }],
    };
  }

  const result: HandlerAnalysis = {
    queryParameters: [],
    headerParameters: [],
    responses: [],
    warnings: [],
  };

  // Find req parameter name from function signature
  const reqParamName = fn.params.find((p) => p === "req") ?? "req";
  const resParamName = fn.params.find((p) => p === "res") ?? "res";

  // Parse function body AST
  let bodyAst: any;
  try {
    bodyAst = parseWithEslint(
      `async function __analyze__() { ${fn.body} }`,
      fn.filePath,
    );
  } catch {
    result.warnings.push({
      code: "EXPRESS_HANDLER_PARSE_ERROR",
      message: `Could not parse body of handler "${handlerName}" for deeper analysis.`,
      location: { file: fn.filePath, line: fn.line },
    });
    return result;
  }

  // Find req access patterns: req.body, req.query, req.params, req.get(), req.headers
  // Find res response patterns: res.json(), res.status().json(), res.send()
  for (const node of walkAst(bodyAst)) {
    // req.body → check destructuring from req.body
    // e.g. const { name, email } = req.body
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "ObjectPattern"
    ) {
      const init = node.init;
      const accessPath = getAccessPath(init);
      if (accessPath) {
        if (accessPath.base === reqParamName && accessPath.property === "body") {
          for (const prop of node.id.properties ?? []) {
            const name = getPropertyName(prop.key) ?? prop.value?.name;
            if (!name) continue;

            let defaultValue: unknown;
            if (prop.type === "AssignmentProperty" && prop.value?.type === "Literal") {
              defaultValue = prop.value.value;
            }

            result.requestBody = result.requestBody ?? {
              contentType: "application/json",
              schema: { type: "object", properties: {}, required: [] },
            };
            const propSchema = inferSchemaFromDefault(defaultValue);
            result.requestBody.schema.properties![name] = propSchema;
          }
        }

        if (accessPath.base === reqParamName && accessPath.property === "query") {
          for (const prop of node.id.properties ?? []) {
            const name = getPropertyName(prop.key) ?? prop.value?.name;
            if (!name) continue;

            let defaultValue: unknown;
            if (prop.type === "AssignmentProperty" && prop.value?.type === "Literal") {
              defaultValue = prop.value.value;
            }

            result.queryParameters.push({
              name,
              in: "query",
              required: !defaultValue,
              schema: inferSchemaFromDefault(defaultValue),
            });
          }
        }
      }
    }

    // req.query.page, req.params.id, req.get('X-Header')
    if (
      node.type === "MemberExpression" &&
      getTargetName(node.object?.object) === reqParamName &&
      node.object?.property?.name === "query"
    ) {
      const name = getPropertyName(node.property);
      if (name) {
        result.queryParameters.push({
          name,
          in: "query",
          required: false,
          schema: { type: "string" },
        });
      }
    }

    if (
      node.type === "MemberExpression" &&
      getTargetName(node.object?.object) === reqParamName &&
      node.object?.property?.name === "params"
    ) {
      // Path parameters — will be deduped with route path params
      const name = getPropertyName(node.property);
      if (name) {
        result.queryParameters.push({
          name,
          in: "path",
          required: true,
          schema: { type: "string" },
        });
      }
    }

    if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      getTargetName(node.callee.object) === reqParamName &&
      node.callee.property?.name === "get"
    ) {
      const headerName = getStringValue(node.arguments?.[0]);
      if (headerName) {
        result.headerParameters.push({
          name: headerName,
          in: "header",
          required: true,
          schema: { type: "string" },
        });
      }
    }

    // req.headers['x-trace-id']
    if (
      node.type === "MemberExpression" &&
      getTargetName(node.object) === reqParamName &&
      node.object?.property?.name === "headers"
    ) {
      const headerName = getStringValue(node.property);
      if (headerName) {
        result.headerParameters.push({
          name: headerName,
          in: "header",
          required: true,
          schema: { type: "string" },
        });
      }
    }

    // Response inference — res.json(), res.status().json(), res.send()
    if (
      node.type === "CallExpression"
    ) {
      let resObj = node.callee;
      let statusCall: any = null;

      // res.status(201).json(...)
      if (
        resObj.type === "MemberExpression" &&
        resObj.property?.name === "json"
      ) {
        const inner = resObj.object;
        if (
          inner?.type === "CallExpression" &&
          inner.callee?.type === "MemberExpression" &&
          inner.callee.property?.name === "status" &&
          getTargetName(inner.callee.object) === resParamName
        ) {
          statusCall = inner;
          resObj = inner.callee.object;
        } else if (getTargetName(inner) === resParamName) {
          resObj = inner;
        }
      }

      // res.sendStatus(204)
      if (
        resObj.type === "MemberExpression" &&
        resObj.property?.name === "sendStatus" &&
        getTargetName(resObj.object) === resParamName
      ) {
        const statusCode = String(node.arguments?.[0]?.value ?? "204");
        result.responses.push({
          statusCode,
          description: `Response with status ${statusCode}`,
        });
      }

      // res.send("ok")
      if (
        resObj.type === "MemberExpression" &&
        resObj.property?.name === "send" &&
        getTargetName(resObj.object) === resParamName
      ) {
        const arg = node.arguments?.[0];
        const statusCode = statusCall
          ? String(statusCall.arguments?.[0]?.value ?? "200")
          : "200";
        result.responses.push({
          statusCode,
          description: "Generated response",
          contentType: "text/plain",
          example: getStringValue(arg) ?? String(arg?.value ?? ""),
        });
      }

      // res.json(...)
      if (
        resObj.type === "MemberExpression" &&
        resObj.property?.name === "json" &&
        getTargetName(resObj.object) === resParamName
      ) {
        const arg = node.arguments?.[0];
        const statusCode = statusCall
          ? String(statusCall.arguments?.[0]?.value ?? "200")
          : "200";

        let schema: SchemaObject | undefined;
        let example: unknown;

        if (arg?.type === "ObjectExpression") {
          const props = extractObjectProperties(arg);
          schema = { type: "object", properties: props, required: Object.keys(props) };
          example = buildExampleFromProperties(props);
        } else if (arg?.type === "Literal") {
          example = arg.value;
          schema = inferSchemaFromDefault(arg.value);
        } else if (arg?.type === "Identifier") {
          // Could be a variable — best effort
          example = { message: "Response data", data: {} };
        }

        result.responses.push({
          statusCode,
          description: "Generated response",
          contentType: "application/json",
          schema,
          example,
        });
      }
    }
  }

  // Dedup responses by status code
  result.responses = dedupeResponsesByStatusCode(result.responses);

  return result;
}

// ─── Helper functions ──────────────────────────────────────────

interface FunctionRecord {
  name: string;
  filePath: string;
  line: number;
  params: string[];
  body: string;
}

function parseFunctionsAst(file: ExpressFile): Map<string, FunctionRecord> {
  const functions = new Map<string, FunctionRecord>();

  for (const node of walkAst(file.ast)) {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "ArrowFunctionExpression" &&
      node.type !== "FunctionExpression"
    ) continue;

    if (!node.id && node.type !== "FunctionDeclaration") continue;

    const name = node.type === "FunctionDeclaration"
      ? node.id?.name
      : null;

    if (!name) continue;

    const bodyRange = node.body?.range;
    let body = "";
    if (bodyRange && file.content) {
      // Body range includes `{}` — strip them
      body = file.content.slice(bodyRange[0] + 1, bodyRange[1] - 1).trim();
    }

    functions.set(name, {
      name,
      filePath: file.filePath,
      line: getLoc(node).line ?? 1,
      params: (node.params ?? []).map(extractParamName).filter(Boolean),
      body,
    });
  }

  // Also capture const foo = (req, res) => {} and const foo = function(req, res) {}
  for (const node of walkAst(file.ast)) {
    if (node.type === "VariableDeclarator") {
      const init = node.init;
      if (
        (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression")
      ) {
        if (node.id?.type === "Identifier") {
          const name = node.id.name;

          const bodyRange = init.body?.range;
          let body = "";
          if (bodyRange && file.content) {
            body = file.content.slice(bodyRange[0] + (init.body.type === "BlockStatement" ? 1 : 0), bodyRange[1] - (init.body.type === "BlockStatement" ? 1 : 0)).trim();
          }

          functions.set(name, {
            name,
            filePath: file.filePath,
            line: getLoc(node).line ?? 1,
            params: (init.params ?? []).map(extractParamName).filter(Boolean),
            body,
          });
        }
      }
    }
  }

  return functions;
}

// ─── Module resolution ─────────────────────────────────────────

function resolveLocalModulePath(
  fromFile: string,
  moduleName: string,
  knownFiles: Set<string>,
): string | null {
  const dir = path.dirname(fromFile);
  const candidates = [
    path.resolve(dir, moduleName),
    path.resolve(dir, moduleName) + ".ts",
    path.resolve(dir, moduleName) + ".js",
    path.resolve(dir, moduleName, "index.ts"),
    path.resolve(dir, moduleName, "index.js"),
  ];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

// ─── AST walking ───────────────────────────────────────────────

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function* walkAst(node: any, depth = 0): Generator<any> {
  if (!node || typeof node !== "object") return;

  yield node;

  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        yield* walkAst(item, depth + 1);
      }
    } else if (typeof child === "object" && child !== null) {
      yield* walkAst(child, depth + 1);
    }
  }
}

// ─── Utility functions ─────────────────────────────────────────

function getTargetName(node: any): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    const obj = getTargetName(node.object);
    const prop = getPropertyName(node.property);
    return obj && prop ? `${obj}.${prop}` : obj;
  }
  if (node.type === "CallExpression") return getTargetName(node.callee);
  return null;
}

function extractParamName(node: any): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "AssignmentPattern") return extractParamName(node.left);
  if (node.type === "ObjectPattern" || node.type === "ArrayPattern") return null;
  return null;
}

function getAccessPath(node: any): { base: string; property: string } | null {
  if (!node) return null;
  if (node.type === "MemberExpression") {
    const base = getTargetName(node.object);
    const prop = getPropertyName(node.property);
    if (base && prop) return { base, property: prop };
  }
  return null;
}

function extractObjectProperties(node: any): Record<string, SchemaObject> {
  const props: Record<string, SchemaObject> = {};
  for (const prop of node.properties ?? []) {
    const name = getPropertyName(prop.key);
    if (!name) continue;
    const value = prop.value;
    props[name] = inferSchemaFromValue(value);
  }
  return props;
}

function inferSchemaFromValue(node: any): SchemaObject {
  if (!node) return { type: "string" };
  if (node.type === "Literal") return inferSchemaFromDefault(node.value);
  if (node.type === "ObjectExpression") {
    return { type: "object", properties: extractObjectProperties(node) };
  }
  if (node.type === "ArrayExpression") {
    return {
      type: "array",
      items: node.elements[0] ? inferSchemaFromValue(node.elements[0]) : { type: "object" },
    };
  }
  return { type: "string" };
}

function inferSchemaFromDefault(value: unknown): SchemaObject {
  if (value === null || value === undefined) return { type: "string", nullable: true };
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number") {
    const rounded = Math.round(value);
    return value === rounded ? { type: "integer" } : { type: "number" };
  }
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "object") return { type: "object" };
  return { type: "string" };
}

function inferTag(path: string, controller?: string): string {
  if (controller) {
    return controller.replace(/Controller$/, "");
  }
  const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
  return parts.length > 0 ? capitalize(parts[0].replace(/[{}]/g, "")) : "Default";
}

function capitalize(s: string): string {
  return s ? `${s[0].toUpperCase()}${s.slice(1)}` : s;
}

function buildExampleFromProperties(
  props: Record<string, SchemaObject>,
): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    example[key] = exampleValue(schema);
  }
  return example;
}

function exampleValue(schema: SchemaObject): unknown {
  switch (schema.type) {
    case "string": return "example";
    case "integer": return 1;
    case "number": return 1.0;
    case "boolean": return true;
    case "array": return schema.items ? [exampleValue(schema.items)] : [];
    case "object": return schema.properties ? buildExampleFromProperties(schema.properties) : {};
    default: return "example";
  }
}

function buildOperationId(method: string, path: string, handlerName: string): string {
  const pathSuffix = path
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9]+/g, " "))
    .map((part) => part.split(" ").filter(Boolean).map(capitalize).join(""))
    .join("");
  return `${handlerName}${capitalize(method)}${pathSuffix || "Root"}`;
}

function buildSummary(method: string, path: string, handlerName?: string): string {
  return handlerName
    ? `${handlerName} — ${method.toUpperCase()} ${path}`
    : `${method.toUpperCase()} ${path}`;
}

function normalizePath(p: string): string {
  return "/" + p.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join("/"));
}

// ─── Main export ───────────────────────────────────────────────

/**
 * Scan an Express.js project using AST-based parsing.
 * Detects framework automatically, resolves imports/exports, traces routes,
 * and analyzes handlers for request/response patterns.
 */
export async function scanExpressProjectAst(
  root: string,
  projectName: string,
  projectVersion: string,
  config: BrunogenConfig,
): Promise<NormalizedProject> {
  const files = await loadExpressAstFiles(root);
  if (files.length === 0) {
    throw new Error(
      `No parsable Express.js files found under ${root}. ` +
      "Ensure .js/.ts/.mjs/.cjs files exist and are valid JavaScript/TypeScript."
    );
  }

  const fileMap = new Map(files.map((f) => [f.filePath, f]));
  const filePaths = new Set(fileMap.keys());
  const imports = new Map<string, Map<string, ImportBinding>>();
  const exportsMap = new Map<string, FileExports>();
  const functions = new Map<string, FunctionRecord>();

  for (const file of files) {
    imports.set(file.filePath, parseImportsAst(file, filePaths));
    exportsMap.set(file.filePath, parseExportsAst(file));

    for (const [name, fn] of parseFunctionsAst(file)) {
      functions.set(name, fn);
    }
  }

  // Discover routers
  const routers: RouterRecord[] = [];
  for (const file of files) {
    const fileRouters = parseRoutersAst(file, fileMap, imports, exportsMap);
    routers.push(...fileRouters);
  }

  // Deduplicate and resolve mounts
  const routerByKey = new Map<string, RouterRecord>();
  for (const router of routers) {
    const existing = routerByKey.get(router.key);
    if (!existing) {
      routerByKey.set(router.key, router);
    } else {
      // Merge routes
      existing.routes.push(...router.routes);
      existing.mounts.push(...router.mounts);
    }
  }

  // Find root routers (apps and routers not mounted by others)
  const mountedKeys = new Set<string>();
  for (const router of routerByKey.values()) {
    for (const mount of router.mounts) {
      mountedKeys.add(mount.routerKey);
    }
  }

  const rootRouters = [...routerByKey.values()].filter(
    (r) => r.kind === "app" || !mountedKeys.has(r.key),
  );

  const endpoints: NormalizedEndpoint[] = [];
  const warnings: GenerationWarning[] = [];
  const seenEndpoints = new Set<string>();

  // Collect endpoints from root routers, following mounts
  for (const router of rootRouters) {
    collectRouterEndpointsAst({
      router,
      allRouters: routerByKey,
      functions,
      config,
      prefix: "",
      inheritedMiddleware: [],
      visited: new Set(),
      endpoints,
      warnings,
      seenEndpoints,
    });
  }

  return {
    framework: "express" as any,
    projectName,
    projectVersion,
    endpoints,
    warnings,
  };
}

interface CollectContext {
  router: RouterRecord;
  allRouters: Map<string, RouterRecord>;
  functions: Map<string, FunctionRecord>;
  config: BrunogenConfig;
  prefix: string;
  inheritedMiddleware: string[];
  visited: Set<string>;
  endpoints: NormalizedEndpoint[];
  warnings: GenerationWarning[];
  seenEndpoints: Set<string>;
}

function collectRouterEndpointsAst(ctx: CollectContext): void {
  if (ctx.visited.has(ctx.router.key)) return;
  ctx.visited.add(ctx.router.key);

  const fullMiddleware = [...ctx.inheritedMiddleware, ...(ctx.router.middleware ?? [])];

  // Process direct routes
  for (const route of ctx.router.routes) {
    const fullPath = joinPath(ctx.prefix, route.path);
    const endpointKey = `${route.method}:${fullPath}`;

    if (ctx.seenEndpoints.has(endpointKey)) continue;
    ctx.seenEndpoints.add(endpointKey);

    const analysis = analyzeHandlerAst(route.handler, ctx.functions, ctx.config);
    const authInference = inferBearerAuthFromMiddleware(
      "Express",
      [...fullMiddleware, ...route.middleware],
      ctx.config.auth.middlewarePatterns.bearer,
    );

    const pathParams = extractPathParams(fullPath);
    const parameters = dedupeParameters([
      ...pathParams,
      ...analysis.queryParameters.filter(
        (p) => p.in !== "path" || !pathParams.some(pp => pp.name === p.name),
      ),
      ...analysis.headerParameters,
    ]);

    const defaultStatus = defaultStatusByMethod[route.method] ?? "200";

    ctx.endpoints.push({
      id: endpointKey,
      method: route.method,
      path: fullPath,
      operationId: buildOperationId(route.method, fullPath, route.handler),
      summary: buildSummary(route.method, fullPath, route.handler),
      tags: [inferTag(fullPath, route.handler)],
      parameters,
      requestBody: analysis.requestBody,
      responses: analysis.responses.length > 0 ? analysis.responses : [{
        statusCode: defaultStatus,
        description: "Inferred response",
        contentType: "application/json",
      }],
      auth: authInference.auth,
      source: { file: route.filePath, line: route.line },
      warnings: analysis.warnings,
    });

    ctx.warnings.push(...analysis.warnings);
  }

  // Follow mounts
  for (const mount of ctx.router.mounts) {
    const mountPrefix = joinPath(ctx.prefix, mount.path);
    const mountKey = mount.routerKey;
    const mountedRouter = ctx.allRouters.get(mountKey);

    if (mountedRouter) {
      collectRouterEndpointsAst({
        ...ctx,
        router: mountedRouter,
        prefix: mountPrefix,
        inheritedMiddleware: [...fullMiddleware, ...mount.middleware],
      });
    }
  }
}

function extractPathParams(routePath: string): NormalizedParameter[] {
  const params: NormalizedParameter[] = [];
  for (const match of routePath.matchAll(/:([^/]+)/g)) {
    params.push({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}
