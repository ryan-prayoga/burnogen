import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { writeBrunoCollection } from "../src/core/bruno";
import { defaultConfig } from "../src/core/config";
import { fileExists } from "../src/core/fs";
import { generateArtifacts, validateOpenApi, writeArtifacts } from "../src/core/pipeline";
import { fixturePath } from "./helpers";

describe("Generation pipeline", () => {
  it("writes OpenAPI and Bruno artifacts", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "brunogen-"));
    const config = defaultConfig();
    config.output.openapiFile = "out/openapi.yaml";
    config.output.brunoDir = "out/bruno";

    const artifacts = await generateArtifacts(fixturePath("laravel"), config);
    await validateOpenApi(artifacts.openApi);
    await writeArtifacts(
      artifacts,
      config,
      path.join(workspace, config.output.openapiFile),
      path.join(workspace, config.output.brunoDir),
    );
    const userRequestFiles = await fs.readdir(path.join(workspace, "out/bruno/user"));
    const projectRequestFiles = await fs.readdir(path.join(workspace, "out/bruno/project"));
    const loginRequest = await fs.readFile(path.join(workspace, "out/bruno/session/sessioncontrollerstore.bru"), "utf8");

    expect(await fileExists(path.join(workspace, "out/openapi.yaml"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/bruno.json"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/environments/local.bru"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/session/sessioncontrollerstore.bru"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/user/usercontrollerindex.bru"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/project/projectcontrollerindex.bru"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/project/projectcontrollershow.bru"))).toBe(true);
    expect(userRequestFiles.filter((file) => file.endsWith(".bru"))).toHaveLength(2);
    expect(projectRequestFiles.filter((file) => file.endsWith(".bru"))).toHaveLength(2);
    expect(loginRequest).toContain("example {");
    expect(loginRequest).toContain("code: 201");
    expect(loginRequest).toContain("\"device_name\": \"ios-simulator\"");
  });

  it("refuses to clear a non-empty directory that is not a Bruno collection", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "brunogen-unsafe-"));
    try {
      const unsafeOutput = path.join(workspace, "existing-output");
      await fs.mkdir(unsafeOutput, { recursive: true });
      await fs.writeFile(path.join(unsafeOutput, "keep.txt"), "keep\n", "utf8");

      const config = defaultConfig();
      const artifacts = await generateArtifacts(fixturePath("laravel"), config);

      await expect(
        writeBrunoCollection(artifacts.openApi, unsafeOutput, config),
      ).rejects.toThrow(/does not look like a Brunogen collection/);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("supports the experimental Express AST pipeline with a relative project root", async () => {
    const previousAstFlag = process.env.BRUNOGEN_EXPERIMENTAL_EXPRESS_AST;
    process.env.BRUNOGEN_EXPERIMENTAL_EXPRESS_AST = "1";

    try {
      const relativeRoot = path.relative(process.cwd(), fixturePath("express"));
      const artifacts = await generateArtifacts(relativeRoot, defaultConfig());

      expect(artifacts.normalized.framework).toBe("express");
      expect(artifacts.normalized.endpoints).toContainEqual(expect.objectContaining({
        method: "post",
        path: "/api/v1/users",
        operationId: "createUser",
      }));
      expect(artifacts.normalized.endpoints).toContainEqual(expect.objectContaining({
        method: "post",
        path: "/api/v1/users/impersonate",
        operationId: "impersonateUser",
      }));
    } finally {
      if (previousAstFlag === undefined) {
        delete process.env.BRUNOGEN_EXPERIMENTAL_EXPRESS_AST;
      } else {
        process.env.BRUNOGEN_EXPERIMENTAL_EXPRESS_AST = previousAstFlag;
      }
    }
  });
});
