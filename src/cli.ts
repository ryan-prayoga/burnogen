#!/usr/bin/env node

import path from "node:path";

import { Command } from "commander";
import packageJson from "../package.json";

import { loadConfig, renderDefaultConfigFile, resolveFromConfigRoot } from "./core/config";
import { fileExists, writeTextFile } from "./core/fs";
import { runDoctor } from "./core/doctor";
import { collectOpenApiConsistencyWarnings, formatWarnings, generateArtifacts, validateOpenApi, writeArtifacts } from "./core/pipeline";

const program = new Command();

program
  .name("brunogen")
  .description("Generate Bruno collections from Laravel, Express.js, and Go API source code.")
  .version(packageJson.version);

program.command("init")
  .description("Create a brunogen config file in the current directory.")
  .option("-f, --force", "overwrite an existing config file")
  .action(async (options: { force?: boolean; }) => {
    const cwd = process.cwd();
    const configFile = path.join(cwd, "brunogen.config.json");
    const exists = await fileExists(configFile);

    if (exists && !options.force) {
      console.error(`Config already exists at ${configFile}. Use --force to overwrite it.`);
      process.exitCode = 1;
      return;
    }

    await writeTextFile(configFile, renderDefaultConfigFile());
    console.log(`Created ${configFile}`);
  });

program.command("generate")
  .description("Scan the current project and generate OpenAPI plus a Bruno collection.")
  .option("-c, --config <path>", "path to brunogen config")
  .action(async (options: { config?: string; }) => {
    await runGenerate(options.config);
  });

program.command("watch")
  .description("Watch the current project and regenerate on source changes.")
  .option("-c, --config <path>", "path to brunogen config")
  .action(async (options: { config?: string; }) => {
    const chokidar = await import("chokidar");
    const cwd = process.cwd();
    const { config, configPath } = await loadConfig(cwd, options.config);
    const projectRoot = resolveFromConfigRoot(configPath, config.inputRoot, cwd);
    const openApiPath = resolveFromConfigRoot(configPath, config.output.openapiFile, cwd);
    const brunoDir = resolveFromConfigRoot(configPath, config.output.brunoDir, cwd);
    const watchPaths = [
      path.join(projectRoot, "**/*.php"),
      path.join(projectRoot, "**/*.go"),
      path.join(projectRoot, "**/*.js"),
      path.join(projectRoot, "**/*.cjs"),
      path.join(projectRoot, "**/*.mjs"),
      path.join(projectRoot, "**/*.ts"),
    ];
    if (configPath) {
      watchPaths.push(configPath);
    }

    let timer: NodeJS.Timeout | undefined;

    const rerun = async () => {
      try {
        const artifacts = await generateArtifacts(projectRoot, config);
        const validationWarnings = await collectValidationWarnings(artifacts.openApi);
        await writeArtifacts(artifacts, config, openApiPath, brunoDir);
        console.log(`[${new Date().toISOString()}] generated ${artifacts.normalized.endpoints.length} endpoints`);
        for (const line of [...formatWarnings(artifacts.warnings), ...validationWarnings]) {
          console.warn(line);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    };

    await rerun();

    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      ignored: [openApiPath, `${brunoDir}/**`],
    });

    const schedule = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void rerun();
      }, 200);
    };

    watcher.on("add", schedule);
    watcher.on("change", schedule);
    watcher.on("unlink", schedule);

    console.log("Watching for changes...");
  });

program.command("validate")
  .description("Validate generated OpenAPI output for the current project.")
  .option("-c, --config <path>", "path to brunogen config")
  .action(async (options: { config?: string; }) => {
    const cwd = process.cwd();
    const { config, configPath } = await loadConfig(cwd, options.config);
    const projectRoot = resolveFromConfigRoot(configPath, config.inputRoot, cwd);

    try {
      const artifacts = await generateArtifacts(projectRoot, config);
      await validateOpenApi(artifacts.openApi);
      const consistencyWarnings = collectOpenApiConsistencyWarnings(artifacts.openApi);
      if (consistencyWarnings.length > 0) {
        for (const line of consistencyWarnings) {
          console.error(line);
        }
        process.exitCode = 1;
        return;
      }
      console.log(`OpenAPI valid. ${artifacts.normalized.endpoints.length} endpoints scanned.`);
      for (const line of formatWarnings(artifacts.warnings)) {
        console.warn(line);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program.command("doctor")
  .description("Show brunogen environment and framework detection details.")
  .option("-c, --config <path>", "path to brunogen config")
  .action(async (options: { config?: string; }) => {
    const cwd = process.cwd();
    const { config } = await loadConfig(cwd, options.config);
    const result = await runDoctor(cwd, config);
    for (const line of result.lines) {
      console.log(line);
    }
  });

program.parse(process.argv);

async function runGenerate(configFile?: string): Promise<void> {
  const cwd = process.cwd();
  const { config, configPath } = await loadConfig(cwd, configFile);
  const projectRoot = resolveFromConfigRoot(configPath, config.inputRoot, cwd);
  const openApiPath = resolveFromConfigRoot(configPath, config.output.openapiFile, cwd);
  const brunoDir = resolveFromConfigRoot(configPath, config.output.brunoDir, cwd);

  try {
    const artifacts = await generateArtifacts(projectRoot, config);
    const validationWarnings = await collectValidationWarnings(artifacts.openApi);
    await writeArtifacts(artifacts, config, openApiPath, brunoDir);

    console.log(`Generated ${artifacts.normalized.endpoints.length} endpoints.`);
    console.log(`OpenAPI: ${openApiPath}`);
    console.log(`Bruno: ${brunoDir}`);

    for (const line of [...formatWarnings(artifacts.warnings), ...validationWarnings]) {
      console.warn(line);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function collectValidationWarnings(openApi: Record<string, unknown>): Promise<string[]> {
  try {
    await validateOpenApi(openApi);
    return collectOpenApiConsistencyWarnings(openApi);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`[OPENAPI_VALIDATION_FAILED] OpenAPI validation failed, but partial artifacts were still written. ${message}`];
  }
}
