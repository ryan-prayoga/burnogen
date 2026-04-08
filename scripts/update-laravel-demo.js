const { execFileSync } = require("node:child_process");
const { promises: fs } = require("node:fs");
const path = require("node:path");

const { parse, stringify } = require("yaml");

const repoRoot = path.resolve(__dirname, "..");
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "laravel");
const generatedRoot = path.join(fixtureRoot, ".brunogen");
const demoRoot = path.join(repoRoot, "docs", "demo", "laravel-happy-path");

async function main() {
  await fs.rm(generatedRoot, { recursive: true, force: true });

  try {
    execFileSync("node", [path.join(repoRoot, "dist", "cli.js"), "generate"], {
      cwd: fixtureRoot,
      stdio: "inherit",
    });

    await fs.mkdir(path.join(demoRoot, "bruno", "project"), { recursive: true });
    await fs.mkdir(path.join(demoRoot, "bruno", "user"), { recursive: true });

    const openApiContent = await fs.readFile(path.join(generatedRoot, "openapi.yaml"), "utf8");
    const projectRequest = await fs.readFile(
      path.join(generatedRoot, "bruno", "project", "projectcontrollerindex.bru"),
      "utf8",
    );
    const userRequest = await fs.readFile(
      path.join(generatedRoot, "bruno", "user", "usercontrollerstore.bru"),
      "utf8",
    );

    await fs.writeFile(
      path.join(demoRoot, "output-tree.txt"),
      normalizeSnapshot(await renderTree(generatedRoot)),
      "utf8",
    );
    await fs.writeFile(
      path.join(demoRoot, "openapi-snippet.yaml"),
      normalizeSnapshot(buildOpenApiSnippet(openApiContent)),
      "utf8",
    );
    await fs.writeFile(
      path.join(demoRoot, "bruno", "project", "projectcontrollerindex.bru"),
      normalizeSnapshot(projectRequest),
      "utf8",
    );
    await fs.writeFile(
      path.join(demoRoot, "bruno", "user", "usercontrollerstore.bru"),
      normalizeSnapshot(userRequest),
      "utf8",
    );
  } finally {
    await fs.rm(generatedRoot, { recursive: true, force: true });
  }
}

async function renderTree(rootPath) {
  const lines = [".brunogen/"];
  await appendTreeLines(rootPath, lines, 2);
  return `${lines.join("\n")}\n`;
}

async function appendTreeLines(directory, lines, indent) {
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

function buildOpenApiSnippet(openApiContent) {
  const openApi = parse(openApiContent);
  const userCreateOperation = openApi.paths?.["/api/users"]?.post;
  const projectListOperation = openApi.paths?.["/api/projects"]?.get;

  return stringify({
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

function normalizeSnapshot(content) {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  return `${normalized}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
