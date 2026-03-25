import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

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
    const requestFiles = await fs.readdir(path.join(workspace, "out/bruno/user"));

    expect(await fileExists(path.join(workspace, "out/openapi.yaml"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/bruno.json"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/environments/local.bru"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/user/usercontrollerindex.bru"))).toBe(true);
    expect(await fileExists(path.join(workspace, "out/bruno/user/usercontrollerindexgetapiprojects.bru"))).toBe(true);
    expect(requestFiles.filter((file) => file.endsWith(".bru"))).toHaveLength(4);
  });
});
