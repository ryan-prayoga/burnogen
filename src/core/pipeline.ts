import SwaggerParser from "@apidevtools/swagger-parser";

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
    default:
      throw new Error(`Unsupported framework: ${framework satisfies never}`);
  }
}
