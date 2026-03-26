import path from "node:path";
import { promises as fs } from "node:fs";

import { detectFramework } from "./framework";
import { findConfigFile } from "./config";
import { fileExists, listFiles, readJsonFile } from "./fs";
import { generateArtifacts } from "./pipeline";
import type { BrunogenConfig } from "./model";

export interface DoctorResult {
  lines: string[];
}

export async function runDoctor(cwd: string, config: BrunogenConfig): Promise<DoctorResult> {
  const configPath = await findConfigFile(cwd);
  const projectRoot = path.resolve(cwd, config.inputRoot);
  const detection = await detectFramework(projectRoot, config.framework);

  const lines = [
    `cwd: ${cwd}`,
    `config: ${configPath ?? "not found (using defaults)"}`,
    `project root: ${projectRoot}`,
    `framework: ${detection.framework ?? "not detected"}`,
    `openapi output: ${path.resolve(projectRoot, config.output.openapiFile)}`,
    `bruno output: ${path.resolve(projectRoot, config.output.brunoDir)}`,
    `artisan: ${await fileExists(path.join(projectRoot, "artisan")) ? "yes" : "no"}`,
    `go.mod: ${await fileExists(path.join(projectRoot, "go.mod")) ? "yes" : "no"}`,
    `package.json: ${await fileExists(path.join(projectRoot, "package.json")) ? "yes" : "no"}`,
  ];

  let artifacts:
    | Awaited<ReturnType<typeof generateArtifacts>>
    | undefined;

  if (detection.framework) {
    try {
      artifacts = await generateArtifacts(projectRoot, config);
      lines.push(`endpoints scanned: ${artifacts.normalized.endpoints.length}`);
      lines.push(`inference warnings: ${artifacts.warnings.length}`);
    } catch (error) {
      lines.push(`scan error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (detection.framework === "express") {
    lines.push(...await collectExpressDoctorLines(projectRoot, artifacts));
  }

  if (detection.framework === "gin" || detection.framework === "fiber" || detection.framework === "echo") {
    lines.push(...await collectGoDoctorLines(projectRoot, artifacts));
  }

  for (const warning of detection.warnings) {
    lines.push(`warning: ${warning.message}`);
  }

  return { lines };
}

async function collectExpressDoctorLines(
  projectRoot: string,
  artifacts?: Awaited<ReturnType<typeof generateArtifacts>>,
): Promise<string[]> {
  const lines: string[] = [];
  const packageJsonPath = path.join(projectRoot, "package.json");
  let hasExpressDependency = false;

  if (await fileExists(packageJsonPath)) {
    try {
      const packageJson = await readJsonFile<{
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }>(packageJsonPath);
      hasExpressDependency = Boolean(packageJson.dependencies?.express || packageJson.devDependencies?.express);
    } catch {
      hasExpressDependency = false;
    }
  }

  const presentRouteDirs: string[] = [];
  for (const directory of ["src/routes", "routes"]) {
    if (await fileExists(path.join(projectRoot, directory))) {
      presentRouteDirs.push(directory);
    }
  }

  lines.push(`express dependency: ${hasExpressDependency ? "yes" : "no"}`);
  lines.push(`express route dirs: ${presentRouteDirs.length > 0 ? presentRouteDirs.join(", ") : "not found"}`);

  if (artifacts) {
    const skippedHandlers = artifacts.warnings.filter((warning) => warning.code === "EXPRESS_HANDLER_NOT_FOUND").length;
    lines.push(`express handlers inferred: ${Math.max(artifacts.normalized.endpoints.length - skippedHandlers, 0)}`);
    lines.push(`express handlers skipped: ${skippedHandlers}`);
  }

  return lines;
}

async function collectGoDoctorLines(
  projectRoot: string,
  artifacts?: Awaited<ReturnType<typeof generateArtifacts>>,
): Promise<string[]> {
  const lines: string[] = [];
  const goFiles = await listFiles(
    projectRoot,
    (filePath) => filePath.endsWith(".go"),
    { ignoreDirectories: ["vendor", "node_modules", ".git", "dist"] },
  );

  let ginImports = 0;
  let fiberImports = 0;
  let echoImports = 0;
  let structCount = 0;

  for (const filePath of goFiles) {
    const content = await fs.readFile(filePath, "utf8");
    if (content.includes("github.com/gin-gonic/gin")) {
      ginImports += 1;
    }
    if (content.includes("github.com/gofiber/fiber")) {
      fiberImports += 1;
    }
    if (content.includes("github.com/labstack/echo")) {
      echoImports += 1;
    }
    structCount += [...content.matchAll(/\btype\s+[A-Za-z_][A-Za-z0-9_]*\s+struct\b/g)].length;
  }

  lines.push(`go framework imports: gin=${ginImports} fiber=${fiberImports} echo=${echoImports}`);
  lines.push(`go structs detected: ${structCount}`);

  if (artifacts) {
    const inferenceWarnings = artifacts.warnings.filter((warning) => warning.code.startsWith("GO_")).length;
    lines.push(`go inference warnings: ${inferenceWarnings}`);
  }

  return lines;
}
