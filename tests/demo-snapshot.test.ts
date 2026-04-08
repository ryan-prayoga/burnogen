import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/core/config";
import { generateArtifacts, writeArtifacts } from "../src/core/pipeline";
import { fixturePath, repoPath } from "./helpers";

describe("Laravel demo snapshots", () => {
  it("matches the checked-in happy path output", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brunogen-laravel-demo-"));

    try {
      const fixtureRoot = fixturePath("laravel");
      const workingRoot = path.join(sandboxRoot, "laravel");
      await fs.cp(fixtureRoot, workingRoot, { recursive: true });

      const config = defaultConfig();
      const artifacts = await generateArtifacts(workingRoot, config);
      const generatedRoot = path.join(workingRoot, ".brunogen");
      await writeArtifacts(
        artifacts,
        config,
        path.join(generatedRoot, "openapi.yaml"),
        path.join(generatedRoot, "bruno"),
      );

      const actualTree = normalizeSnapshot(await renderTree(generatedRoot));
      const expectedTree = await readDemoSnapshot("output-tree.txt");
      expect(actualTree).toBe(expectedTree);

      const openApiContent = await fs.readFile(path.join(generatedRoot, "openapi.yaml"), "utf8");
      const actualOpenApiSnippet = normalizeSnapshot(buildOpenApiSnippet(openApiContent));
      const expectedOpenApiSnippet = await readDemoSnapshot("openapi-snippet.yaml");
      expect(actualOpenApiSnippet).toBe(expectedOpenApiSnippet);

      const actualBrunoRequest = normalizeSnapshot(await fs.readFile(
        path.join(generatedRoot, "bruno", "user", "usercontrollerstore.bru"),
        "utf8",
      ));
      const expectedBrunoRequest = await readDemoSnapshot("bruno", "user", "usercontrollerstore.bru");
      expect(actualBrunoRequest).toBe(expectedBrunoRequest);

      const actualProjectRequest = normalizeSnapshot(await fs.readFile(
        path.join(generatedRoot, "bruno", "project", "projectcontrollerindex.bru"),
        "utf8",
      ));
      const expectedProjectRequest = await readDemoSnapshot("bruno", "project", "projectcontrollerindex.bru");
      expect(actualProjectRequest).toBe(expectedProjectRequest);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });
});

async function readDemoSnapshot(...segments: string[]): Promise<string> {
  const content = await fs.readFile(
    repoPath("docs", "demo", "laravel-happy-path", ...segments),
    "utf8",
  );
  return normalizeSnapshot(content);
}

async function renderTree(rootPath: string): Promise<string> {
  const lines = [".brunogen/"];
  await appendTreeLines(rootPath, lines, 2);
  return `${lines.join("\n")}\n`;
}

async function appendTreeLines(directory: string, lines: string[], indent: number): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? 1 : -1;
    }

    return left.name.localeCompare(right.name);
  });

  for (const entry of entries) {
    const prefix = " ".repeat(indent);
    const label = entry.isDirectory() ? `${entry.name}/` : entry.name;
    lines.push(`${prefix}${label}`);

    if (entry.isDirectory()) {
      await appendTreeLines(path.join(directory, entry.name), lines, indent + 2);
    }
  }
}

function buildOpenApiSnippet(openApiContent: string): string {
  const openApi = parseYaml(openApiContent) as {
    openapi?: string;
    paths?: Record<string, Record<string, unknown>>;
  };
  const userCreateOperation = openApi.paths?.["/api/users"]?.post as {
    operationId?: string;
    summary?: string;
    tags?: string[];
    requestBody?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    security?: Array<Record<string, string[]>>;
  } | undefined;
  const projectListOperation = openApi.paths?.["/api/projects"]?.get as {
    operationId?: string;
    summary?: string;
    tags?: string[];
    parameters?: Array<Record<string, unknown>>;
    responses?: Record<string, unknown>;
  } | undefined;

  return stringifyYaml({
    openapi: openApi.openapi,
    paths: {
      "/api/users": {
        post: userCreateOperation
          ? {
            operationId: userCreateOperation.operationId,
            summary: userCreateOperation.summary,
            tags: userCreateOperation.tags,
            requestBody: userCreateOperation.requestBody,
            responses: userCreateOperation.responses,
            security: userCreateOperation.security,
          }
          : undefined,
      },
      "/api/projects": {
        get: projectListOperation
          ? {
            operationId: projectListOperation.operationId,
            summary: projectListOperation.summary,
            tags: projectListOperation.tags,
            parameters: projectListOperation.parameters,
            responses: projectListOperation.responses,
          }
          : undefined,
      },
    },
  }, {
    sortMapEntries: false,
  });
}

function normalizeSnapshot(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  return `${normalized}\n`;
}
