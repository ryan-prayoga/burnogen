import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { ensureDirectory, removeDirectory, sanitizeFileName, writeTextFile } from "./fs";
import type { BrunogenConfig, SchemaObject } from "./model";

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: "path" | "query" | "header";
    required?: boolean;
    schema?: SchemaObject;
  }>;
  requestBody?: {
    content?: Record<string, { schema?: SchemaObject; }>;
  };
  security?: Array<Record<string, string[]>>;
}

export async function writeOpenApiFile(openApi: Record<string, unknown>, outputFile: string): Promise<void> {
  const content = stringifyYaml(openApi, {
    sortMapEntries: false,
  });
  await writeTextFile(outputFile, content);
}

export async function writeBrunoCollection(
  openApi: Record<string, unknown>,
  outputDirectory: string,
  config: BrunogenConfig,
): Promise<void> {
  await removeDirectory(outputDirectory);
  await ensureDirectory(outputDirectory);

  const collectionName = extractCollectionName(openApi);
  await writeTextFile(path.join(outputDirectory, "bruno.json"), JSON.stringify({
    version: "1",
    name: collectionName,
    type: "collection",
    ignore: ["node_modules", ".git"],
  }, null, 2) + "\n");

  const pathsObject = (openApi.paths ?? {}) as Record<string, Record<string, OpenApiOperation>>;
  let sequence = 1;

  for (const [pathname, operations] of Object.entries(pathsObject)) {
    for (const [method, rawOperation] of Object.entries(operations)) {
      const operation = rawOperation as OpenApiOperation;
      const folderName = sanitizeFileName(operation.tags?.[0] ?? pathname.split("/").filter(Boolean)[0] ?? "default");
      const folderPath = path.join(outputDirectory, folderName);
      const requestName = operation.operationId ?? operation.summary ?? `${method.toUpperCase()} ${pathname}`;
      const fileName = `${sanitizeFileName(requestName)}.bru`;

      await ensureDirectory(folderPath);
      await writeTextFile(path.join(folderPath, fileName), renderRequestFile({
        pathname,
        method,
        operation,
        sequence,
        config,
      }));
      sequence += 1;
    }
  }

  const environmentsDirectory = path.join(outputDirectory, "environments");
  await ensureDirectory(environmentsDirectory);

  for (const environment of config.environments) {
    await writeTextFile(
      path.join(environmentsDirectory, `${sanitizeFileName(environment.name)}.bru`),
      renderEnvironmentFile(environment.variables),
    );
  }
}

function renderRequestFile(input: {
  pathname: string;
  method: string;
  operation: OpenApiOperation;
  sequence: number;
  config: BrunogenConfig;
}): string {
  const { pathname, method, operation, sequence, config } = input;
  const effectiveAuth = resolveOperationAuth(operation, config);
  const contentType = extractContentType(operation);
  const requestBodySchema = extractRequestSchema(operation);
  const pathParameters = (operation.parameters ?? []).filter((parameter) => parameter.in === "path");
  const queryParameters = (operation.parameters ?? []).filter((parameter) => parameter.in === "query");
  const headerParameters = (operation.parameters ?? []).filter((parameter) => parameter.in === "header");

  const lines: string[] = [];

  lines.push("meta {");
  lines.push(`  name: ${escapeBruScalar(operation.operationId ?? operation.summary ?? `${method.toUpperCase()} ${pathname}`)}`);
  lines.push("  type: http");
  lines.push(`  seq: ${sequence}`);
  if (operation.tags?.length) {
    lines.push("  tags: [");
    for (const tag of operation.tags) {
      lines.push(`    ${escapeBruScalar(tag)}`);
    }
    lines.push("  ]");
  }
  lines.push("}");
  lines.push("");

  lines.push(`${method.toLowerCase()} {`);
  lines.push(`  url: {{baseUrl}}${toBruPath(pathname)}`);
  lines.push(`  body: ${contentType ?? "none"}`);
  lines.push(`  auth: ${effectiveAuth.mode}`);
  lines.push("}");

  if (pathParameters.length > 0) {
    lines.push("");
    lines.push("params:path {");
    for (const parameter of pathParameters) {
      lines.push(`  ${parameter.name}: ${renderPlaceholderValue(parameter.name, parameter.schema)}`);
    }
    lines.push("}");
  }

  if (queryParameters.length > 0) {
    lines.push("");
    lines.push("params:query {");
    for (const parameter of queryParameters) {
      lines.push(`  ${parameter.name}: ${renderPlaceholderValue(parameter.name, parameter.schema)}`);
    }
    lines.push("}");
  }

  const headers = buildHeaders(headerParameters, contentType);
  if (headers.length > 0) {
    lines.push("");
    lines.push("headers {");
    for (const header of headers) {
      lines.push(`  ${header.name}: ${header.value}`);
    }
    lines.push("}");
  }

  if (effectiveAuth.block) {
    lines.push("");
    lines.push(...effectiveAuth.block);
  }

  if (requestBodySchema && contentType === "json") {
    lines.push("");
    lines.push("body:json {");
    lines.push(indent(JSON.stringify(buildExampleFromSchema(requestBodySchema), null, 2), 2));
    lines.push("}");
  }

  if (requestBodySchema && contentType === "form-urlencoded") {
    lines.push("");
    lines.push("body:form-urlencoded {");
    for (const [key, value] of Object.entries(buildFlatFormExample(requestBodySchema))) {
      lines.push(`  ${key}: ${value}`);
    }
    lines.push("}");
  }

  if (requestBodySchema && contentType === "multipart-form") {
    lines.push("");
    lines.push("body:multipart-form {");
    for (const [key, value] of Object.entries(buildFlatFormExample(requestBodySchema))) {
      lines.push(`  ${key}: ${value}`);
    }
    lines.push("}");
  }

  return `${lines.join("\n")}\n`;
}

function renderEnvironmentFile(variables: Record<string, string>): string {
  const lines = ["vars {"];
  for (const [key, value] of Object.entries(variables)) {
    lines.push(`  ${key}: ${escapeBruScalar(value)}`);
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function extractCollectionName(openApi: Record<string, unknown>): string {
  const info = (openApi.info ?? {}) as Record<string, unknown>;
  return String(info.title ?? "Brunogen Collection");
}

function resolveOperationAuth(operation: OpenApiOperation, config: BrunogenConfig): { mode: string; block?: string[]; } {
  const security = operation.security?.[0];
  if (!security) {
    return { mode: "none" };
  }

  if ("bearerAuth" in security) {
    return {
      mode: "bearer",
      block: [
        "auth:bearer {",
        `  token: {{${config.auth.bearerTokenVar}}}`,
        "}",
      ],
    };
  }

  if ("basicAuth" in security) {
    return {
      mode: "basic",
      block: [
        "auth:basic {",
        `  username: {{${config.auth.basicUsernameVar}}}`,
        `  password: {{${config.auth.basicPasswordVar}}}`,
        "}",
      ],
    };
  }

  if ("apiKeyAuth" in security) {
    return {
      mode: "apikey",
      block: [
        "auth:apikey {",
        `  key: ${config.auth.apiKeyName}`,
        `  value: {{${config.auth.apiKeyVar}}}`,
        `  placement: ${config.auth.apiKeyLocation === "query" ? "queryParams" : "header"}`,
        "}",
      ],
    };
  }

  return { mode: "none" };
}

function extractContentType(operation: OpenApiOperation): "json" | "form-urlencoded" | "multipart-form" | undefined {
  const contentTypes = Object.keys(operation.requestBody?.content ?? {});
  if (contentTypes.includes("application/json")) {
    return "json";
  }

  if (contentTypes.includes("application/x-www-form-urlencoded")) {
    return "form-urlencoded";
  }

  if (contentTypes.includes("multipart/form-data")) {
    return "multipart-form";
  }

  return undefined;
}

function extractRequestSchema(operation: OpenApiOperation): SchemaObject | undefined {
  const content = operation.requestBody?.content ?? {};
  return content["application/json"]?.schema
    ?? content["application/x-www-form-urlencoded"]?.schema
    ?? content["multipart/form-data"]?.schema;
}

function buildHeaders(
  headerParameters: Array<{ name: string; schema?: SchemaObject; }>,
  contentType?: string,
): Array<{ name: string; value: string; }> {
  const headers: Array<{ name: string; value: string; }> = [{
    name: "accept",
    value: "application/json",
  }];

  if (contentType === "json") {
    headers.push({ name: "content-type", value: "application/json" });
  }

  if (contentType === "form-urlencoded") {
    headers.push({ name: "content-type", value: "application/x-www-form-urlencoded" });
  }

  if (contentType === "multipart-form") {
    headers.push({ name: "content-type", value: "multipart/form-data" });
  }

  for (const parameter of headerParameters) {
    headers.push({
      name: parameter.name,
      value: renderPlaceholderValue(parameter.name, parameter.schema),
    });
  }

  return headers;
}

function buildExampleFromSchema(schema: SchemaObject): unknown {
  if (schema.example !== undefined) {
    return schema.example;
  }

  if (schema.default !== undefined) {
    return schema.default;
  }

  if (schema.enum?.length) {
    return schema.enum[0];
  }

  switch (schema.type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [
        key,
        buildExampleFromSchema(value),
      ]));
    case "array":
      return schema.items ? [buildExampleFromSchema(schema.items)] : [];
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "string":
    default:
      if (schema.format === "email") {
        return "user@example.com";
      }
      if (schema.format === "uuid") {
        return "00000000-0000-0000-0000-000000000000";
      }
      if (schema.format === "date-time") {
        return "2026-01-01T00:00:00Z";
      }
      return "";
  }
}

function buildFlatFormExample(schema: SchemaObject): Record<string, string> {
  const example = buildExampleFromSchema(schema);
  if (!example || typeof example !== "object" || Array.isArray(example)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(example as Record<string, unknown>).map(([key, value]) => [
      key,
      formatBruValue(value),
    ]),
  );
}

function renderPlaceholderValue(name: string, schema?: SchemaObject): string {
  if (!schema) {
    return `{{${name}}}`;
  }

  if (schema.type === "integer" || schema.type === "number") {
    return "1";
  }

  if (schema.type === "boolean") {
    return "true";
  }

  return `{{${name}}}`;
}

function toBruPath(pathname: string): string {
  return pathname.replace(/\{([^}]+)\}/g, ":$1");
}

function escapeBruScalar(value: string): string {
  if (value === "" || /\s/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function formatBruValue(value: unknown): string {
  if (typeof value === "string") {
    return escapeBruScalar(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function indent(input: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return input.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
