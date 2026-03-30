import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { defaultConfig, loadConfig } from "../src/core/config";
import { runDoctor } from "../src/core/doctor";
import { fixturePath } from "./helpers";

describe("Doctor command", () => {
  it("reports unknown Express auth middleware and configured bearer hints", async () => {
    const result = await runDoctor(
      fixturePath("express-custom-auth"),
      defaultConfig(),
    );

    expect(result.lines).toContain("configured bearer middleware hints: none");
    expect(result.lines).toContain("express auth middleware warnings: 1");
    expect(result.lines).toContain(
      "express unknown auth middleware: checkPermission",
    );

    const configured = defaultConfig();
    configured.auth.middlewarePatterns.bearer = ["checkPermission"];

    const configuredResult = await runDoctor(
      fixturePath("express-custom-auth"),
      configured,
    );
    expect(configuredResult.lines).toContain(
      "configured bearer middleware hints: checkPermission",
    );
    expect(configuredResult.lines).toContain(
      "express auth middleware warnings: 0",
    );
    expect(configuredResult.lines).toContain(
      "express unknown auth middleware: none",
    );
  });

  it("reports unknown Go auth middleware and configured bearer hints", async () => {
    const result = await runDoctor(
      fixturePath("gin-custom-auth"),
      defaultConfig(),
    );

    expect(result.lines).toContain("configured bearer middleware hints: none");
    expect(result.lines).toContain("go auth middleware warnings: 1");
    expect(result.lines).toContain(
      "go unknown auth middleware: CheckPermission",
    );

    const configured = defaultConfig();
    configured.auth.middlewarePatterns.bearer = ["CheckPermission"];

    const configuredResult = await runDoctor(
      fixturePath("gin-custom-auth"),
      configured,
    );
    expect(configuredResult.lines).toContain(
      "configured bearer middleware hints: CheckPermission",
    );
    expect(configuredResult.lines).toContain("go auth middleware warnings: 0");
    expect(configuredResult.lines).toContain(
      "go unknown auth middleware: none",
    );
  });

  it("resolves doctor paths from explicit config location", async () => {
    const sandbox = await fs.mkdtemp(
      path.join(os.tmpdir(), "brunogen-doctor-"),
    );

    try {
      const workspaceRoot = path.join(sandbox, "workspace");
      const configRoot = path.join(workspaceRoot, "configs");
      const projectRoot = path.join(
        workspaceRoot,
        "apps",
        "express-custom-auth",
      );
      await fs.mkdir(configRoot, { recursive: true });
      await fs.mkdir(path.dirname(projectRoot), { recursive: true });
      await fs.cp(fixturePath("express-custom-auth"), projectRoot, {
        recursive: true,
      });

      const configPath = path.join(configRoot, "custom.json");
      const config = defaultConfig();
      config.framework = "express";
      config.inputRoot = "../apps/express-custom-auth";
      config.output.openapiFile = "../generated/openapi.yaml";
      config.output.brunoDir = "../generated/bruno";

      await fs.writeFile(
        configPath,
        `${JSON.stringify(config, null, 2)}\n`,
        "utf8",
      );

      const loaded = await loadConfig(workspaceRoot, "configs/custom.json");
      const result = await runDoctor(
        workspaceRoot,
        loaded.config,
        loaded.configPath,
      );

      expect(result.lines).toContain(`config: ${configPath}`);
      expect(result.lines).toContain(
        `project root: ${path.resolve(configRoot, config.inputRoot)}`,
      );
      expect(result.lines).toContain(
        `openapi output: ${path.resolve(configRoot, config.output.openapiFile)}`,
      );
      expect(result.lines).toContain(
        `bruno output: ${path.resolve(configRoot, config.output.brunoDir)}`,
      );
      expect(result.lines).toContain("framework: express");
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
});
