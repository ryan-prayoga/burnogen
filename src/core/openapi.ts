import type {
  BrunogenConfig,
  NormalizedAuth,
  NormalizedEndpoint,
  NormalizedProject,
  SchemaObject,
} from "./model";
import { defaultStatusForMethod } from "./responses";

type OpenApiObject = Record<string, unknown>;

export function buildOpenApi(project: NormalizedProject, config: BrunogenConfig): OpenApiObject {
  const paths: Record<string, Record<string, unknown>> = {};
  const securitySchemes = collectSecuritySchemes(project.endpoints, config);
  const usedOperationIds = new Set<string>();

  for (const endpoint of project.endpoints) {
    const effectiveAuth = resolveAuth(endpoint.auth, config);
    const existingPath = paths[endpoint.path] ?? {};
    const operationId = createUniqueOperationId(endpoint.operationId, endpoint.path, endpoint.method, usedOperationIds);

    existingPath[endpoint.method] = {
      operationId,
      summary: endpoint.summary,
      tags: endpoint.tags,
      parameters: endpoint.parameters.length > 0
        ? endpoint.parameters.map((parameter) => ({
          name: parameter.name,
          in: parameter.in,
          required: parameter.required,
          schema: parameter.schema,
          description: parameter.description,
        }))
        : undefined,
      requestBody: endpoint.requestBody ? {
        required: true,
        content: {
          [endpoint.requestBody.contentType]: {
            schema: endpoint.requestBody.schema,
          },
        },
      } : undefined,
      responses: buildResponses(endpoint),
      security: effectiveAuth.type === "none" ? undefined : [buildSecurityRequirement(effectiveAuth)],
      "x-brunogen-source": endpoint.source,
      "x-brunogen-warnings": endpoint.warnings.length > 0 ? endpoint.warnings : undefined,
    };

    paths[endpoint.path] = existingPath;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: config.project.name ?? project.projectName,
      version: config.project.version || project.projectVersion,
    },
    servers: [{
      url: config.project.serverUrl,
    }],
    paths,
    components: Object.keys(securitySchemes).length > 0
      ? { securitySchemes }
      : undefined,
  };
}

function createUniqueOperationId(
  baseOperationId: string,
  pathname: string,
  method: string,
  usedOperationIds: Set<string>,
): string {
  if (!usedOperationIds.has(baseOperationId)) {
    usedOperationIds.add(baseOperationId);
    return baseOperationId;
  }

  const pathSuffix = pathname
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9]+/g, " "))
    .map((part) => part.split(" ").filter(Boolean).map(capitalize).join(""))
    .join("");

  const candidate = `${baseOperationId}${capitalize(method)}${pathSuffix || "Root"}`;
  if (!usedOperationIds.has(candidate)) {
    usedOperationIds.add(candidate);
    return candidate;
  }

  let counter = 2;
  while (usedOperationIds.has(`${candidate}${counter}`)) {
    counter += 1;
  }

  const uniqueCandidate = `${candidate}${counter}`;
  usedOperationIds.add(uniqueCandidate);
  return uniqueCandidate;
}

function buildResponses(endpoint: NormalizedEndpoint): Record<string, unknown> {
  const responses = endpoint.responses.length > 0 ? endpoint.responses : [{
    statusCode: defaultStatusForMethod(endpoint.method),
    description: "Generated default response",
  }];

  return Object.fromEntries(responses.map((response) => [
    response.statusCode,
    response.schema
      ? {
        description: response.description,
        content: {
          [response.contentType ?? "application/json"]: {
            schema: response.schema,
            example: response.example,
          },
        },
      }
      : {
        description: response.description,
      },
  ]));
}

function resolveAuth(auth: NormalizedAuth, config: BrunogenConfig): NormalizedAuth {
  if (auth.type !== "none") {
    return auth;
  }

  if (config.auth.default === "auto" || config.auth.default === "none") {
    return auth;
  }

  if (config.auth.default === "apiKey") {
    return {
      type: "apiKey",
      name: config.auth.apiKeyName,
      in: config.auth.apiKeyLocation,
    };
  }

  return { type: config.auth.default };
}

function collectSecuritySchemes(
  endpoints: NormalizedEndpoint[],
  config: BrunogenConfig,
): Record<string, unknown> {
  const schemes: Record<string, unknown> = {};

  for (const endpoint of endpoints) {
    const effectiveAuth = resolveAuth(endpoint.auth, config);
    if (effectiveAuth.type === "bearer") {
      schemes.bearerAuth = {
        type: "http",
        scheme: "bearer",
      };
    }

    if (effectiveAuth.type === "basic") {
      schemes.basicAuth = {
        type: "http",
        scheme: "basic",
      };
    }

    if (effectiveAuth.type === "apiKey") {
      schemes.apiKeyAuth = {
        type: "apiKey",
        name: effectiveAuth.name ?? config.auth.apiKeyName,
        in: effectiveAuth.in ?? config.auth.apiKeyLocation,
      };
    }
  }

  return schemes;
}

function buildSecurityRequirement(auth: NormalizedAuth): Record<string, string[]> {
  if (auth.type === "bearer") {
    return { bearerAuth: [] };
  }

  if (auth.type === "basic") {
    return { basicAuth: [] };
  }

  return { apiKeyAuth: [] };
}

function capitalize(input: string): string {
  return input ? `${input[0].toUpperCase()}${input.slice(1)}` : input;
}

export function isSchemaObject(value: unknown): value is SchemaObject {
  return Boolean(value) && typeof value === "object";
}
