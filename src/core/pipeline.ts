import SwaggerParser from "@apidevtools/swagger-parser";

import { scanExpressProject } from "../adapters/express";
import { scanLaravelProject } from "../adapters/laravel";
import { scanGoProject } from "../adapters/go";
import { buildOpenApi } from "./openapi";
import { writeBrunoCollection, writeOpenApiFile } from "./bruno";
import { detectFramework } from "./framework";
import type { BrunogenConfig, GenerateArtifacts, GenerationWarning, NormalizedProject, SupportedFramework } from "./model";

export async function generateArtifacts(root: string, config: BrunogenConfig): Promise<GenerateArtifacts> {
  const detection = await detectFramework(root, config.framework);

  if (!detection.framework) {
    throw new Error(detection.warnings.map((warning) => warning.message).join("\n"));
  }

  const normalized = await scanProject(root, detection.framework, detection.projectName, config.project.version);
  const openApi = buildOpenApi(normalized, config);
  const warnings = [...detection.warnings, ...normalized.warnings];

  return {
    normalized,
    openApi,
    warnings,
  };
}

export async function writeArtifacts(
  artifacts: GenerateArtifacts,
  config: BrunogenConfig,
  openApiPath: string,
  brunoDirectory: string,
): Promise<void> {
  await writeOpenApiFile(artifacts.openApi, openApiPath);
  await writeBrunoCollection(artifacts.openApi, brunoDirectory, config);
}

export async function validateOpenApi(openApi: Record<string, unknown>): Promise<void> {
  await SwaggerParser.validate(openApi as never);
}

export function collectOpenApiConsistencyWarnings(openApi: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const paths = (openApi.paths ?? {}) as Record<string, Record<string, {
    operationId?: string;
    parameters?: Array<{ name?: string; in?: string; }>;
    responses?: Record<string, { content?: Record<string, { schema?: unknown; }>; }>;
    security?: Array<Record<string, string[]>>;
  }>>;
  const securitySchemes = new Set(
    Object.keys(((openApi.components ?? {}) as { securitySchemes?: Record<string, unknown>; }).securitySchemes ?? {}),
  );
  const operationIds = new Map<string, string>();

  for (const [pathname, operations] of Object.entries(paths)) {
    const pathParams = new Set(
      [...pathname.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1])
        .filter(Boolean),
    );

    for (const [method, operation] of Object.entries(operations)) {
      const label = `${method.toUpperCase()} ${pathname}`;
      const operationId = operation.operationId;
      if (operationId) {
        const previous = operationIds.get(operationId);
        if (previous) {
          warnings.push(`[OPENAPI_DUPLICATE_OPERATION_ID] ${label} duplicates operationId '${operationId}' already used by ${previous}.`);
        } else {
          operationIds.set(operationId, label);
        }
      }

      const declaredPathParams = new Set(
        (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "path" && parameter.name)
          .map((parameter) => parameter.name as string),
      );
      for (const pathParam of pathParams) {
        if (!declaredPathParams.has(pathParam)) {
          warnings.push(`[OPENAPI_PATH_PARAM_MISSING] ${label} is missing a declared path parameter for '{${pathParam}}'.`);
        }
      }
      for (const declaredParam of declaredPathParams) {
        if (!pathParams.has(declaredParam)) {
          warnings.push(`[OPENAPI_PATH_PARAM_UNUSED] ${label} declares path parameter '${declaredParam}' that does not appear in the URL.`);
        }
      }

      for (const securityRequirement of operation.security ?? []) {
        for (const schemeName of Object.keys(securityRequirement)) {
          if (!securitySchemes.has(schemeName)) {
            warnings.push(`[OPENAPI_SECURITY_SCHEME_MISSING] ${label} references security scheme '${schemeName}' but it is not defined in components.securitySchemes.`);
          }
        }
      }

      for (const [statusCode, response] of Object.entries(operation.responses ?? {})) {
        if (statusCode === "204" || statusCode === "304") {
          continue;
        }

        const content = response.content ?? {};
        if (Object.keys(content).length === 0) {
          warnings.push(`[OPENAPI_RESPONSE_SCHEMA_EMPTY] ${label} response ${statusCode} has no response body schema.`);
        }
      }
    }
  }

  return warnings;
}

export function formatWarnings(warnings: GenerationWarning[]): string[] {
  return warnings.map((warning) => {
    const location = warning.location?.line
      ? `${warning.location.file}:${warning.location.line}`
      : warning.location?.file;
    return location
      ? `[${warning.code}] ${warning.message} (${location})`
      : `[${warning.code}] ${warning.message}`;
  });
}

async function scanProject(
  root: string,
  framework: SupportedFramework,
  projectName: string,
  projectVersion: string,
): Promise<NormalizedProject> {
  switch (framework) {
    case "laravel":
      return scanLaravelProject(root, projectName, projectVersion);
    case "gin":
    case "fiber":
    case "echo":
      return scanGoProject(root, framework, projectName, projectVersion);
    case "express":
      return scanExpressProject(root, projectName, projectVersion);
    default:
      throw new Error(`Unsupported framework: ${framework satisfies never}`);
  }
}
