const path = require("node:path");
const { existsSync, readFileSync } = require("node:fs");

const repoRoot = path.resolve(__dirname, "..");
const readmePath = path.join(repoRoot, "README.md");
const maxReadmeLines = 160;
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function getRepositorySlug() {
  const repositoryUrl = typeof packageJson.repository === "string"
    ? packageJson.repository
    : packageJson.repository?.url;

  if (!repositoryUrl) {
    throw new Error("package.json is missing repository.url");
  }

  return repositoryUrl
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "");
}

const repositorySlug = getRepositorySlug();

function lineNumberAt(content, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (content[position] === "\n") {
      line += 1;
    }
  }
  return line;
}

function normalizeTarget(target) {
  const trimmed = target.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPublishSafeTarget(target) {
  return (
    target.startsWith("https://")
    || target.startsWith("http://")
    || target.startsWith("mailto:")
    || target.startsWith("tel:")
    || target.startsWith("#")
  );
}

function collectMatches(content, pattern, kind, targetIndex = 1) {
  const matches = [];
  for (const match of content.matchAll(pattern)) {
    const rawTarget = match[targetIndex];
    if (!rawTarget) continue;

    const target = normalizeTarget(rawTarget);
    matches.push({
      kind,
      target,
      line: lineNumberAt(content, match.index ?? 0),
    });
  }
  return matches;
}

function findPublishReadmeIssues(content) {
  const markdownLinkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const htmlLinkPattern = /\b(?:href|src)="([^"]+)"/g;
  const matches = [
    ...collectMatches(content, markdownLinkPattern, "markdown"),
    ...collectMatches(content, htmlLinkPattern, "html"),
  ];

  return matches.filter((match) => !isPublishSafeTarget(match.target));
}

function resolveRepoHostedPath(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }

  const pathnameParts = parsed.pathname.replace(/^\/+/, "").split("/");
  const targetSlug = pathnameParts.slice(0, 2).join("/");

  if (parsed.hostname === "github.com" && targetSlug === repositorySlug) {
    const mode = pathnameParts[2];
    if ((mode === "blob" || mode === "tree") && pathnameParts.length >= 5) {
      return decodeURIComponent(pathnameParts.slice(4).join("/"));
    }
  }

  if (parsed.hostname === "raw.githubusercontent.com" && targetSlug === repositorySlug) {
    if (pathnameParts.length >= 4) {
      return decodeURIComponent(pathnameParts.slice(3).join("/"));
    }
  }

  return null;
}

function resolveRepoPath(repoRelativePath) {
  const resolvedPath = path.resolve(repoRoot, repoRelativePath);
  if (resolvedPath === repoRoot || resolvedPath.startsWith(`${repoRoot}${path.sep}`)) {
    return resolvedPath;
  }
  return null;
}

function findRepoHostedPathIssues(content) {
  const markdownLinkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const htmlLinkPattern = /\b(?:href|src)="([^"]+)"/g;
  const matches = [
    ...collectMatches(content, markdownLinkPattern, "markdown"),
    ...collectMatches(content, htmlLinkPattern, "html"),
  ];

  return matches.flatMap((match) => {
    const repoRelativePath = resolveRepoHostedPath(match.target);
    if (!repoRelativePath) {
      return [];
    }

    const resolvedPath = resolveRepoPath(repoRelativePath);
    if (resolvedPath && existsSync(resolvedPath)) {
      return [];
    }

    return [{
      kind: match.kind,
      line: match.line,
      target: match.target,
      repoPath: repoRelativePath,
    }];
  });
}

function countReadmeLines(content) {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  if (normalized.length === 0) {
    return 0;
  }
  return normalized.split("\n").length;
}

function findReadmeLengthIssues(content, options = {}) {
  const limit = options.maxLines ?? maxReadmeLines;
  const actualLines = countReadmeLines(content);

  if (actualLines <= limit) {
    return [];
  }

  return [{
    actualLines,
    maxLines: limit,
  }];
}

function main() {
  const content = readFileSync(readmePath, "utf8");
  const linkIssues = findPublishReadmeIssues(content);
  const repoPathIssues = findRepoHostedPathIssues(content);
  const lengthIssues = findReadmeLengthIssues(content);

  if (linkIssues.length > 0) {
    const summary = linkIssues
      .map((issue) => `README.md:${issue.line} ${issue.kind} link is not publish-safe: ${issue.target}`)
      .join("\n");
    throw new Error(
      `README contains links or assets that will not resolve reliably on npm.\n${summary}`
    );
  }

  if (repoPathIssues.length > 0) {
    const summary = repoPathIssues
      .map((issue) => `README.md:${issue.line} repo link points to a missing path: ${issue.repoPath}`)
      .join("\n");
    throw new Error(
      `README contains GitHub links to files that do not exist in this repository.\n${summary}`
    );
  }

  if (lengthIssues.length > 0) {
    const [{ actualLines, maxLines }] = lengthIssues;
    throw new Error(
      `README is too long for the npm package page: ${actualLines} lines (max ${maxLines}).`
    );
  }

  console.log(`README publish checks passed (${countReadmeLines(content)} lines).`);
}

if (require.main === module) {
  main();
}

module.exports = {
  countReadmeLines,
  findPublishReadmeIssues,
  findRepoHostedPathIssues,
  findReadmeLengthIssues,
  isPublishSafeTarget,
  maxReadmeLines,
  repositorySlug,
  resolveRepoHostedPath,
};
