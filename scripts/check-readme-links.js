const path = require("node:path");
const { readFileSync } = require("node:fs");

const repoRoot = path.resolve(__dirname, "..");
const readmePath = path.join(repoRoot, "README.md");

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

function main() {
  const content = readFileSync(readmePath, "utf8");
  const issues = findPublishReadmeIssues(content);

  if (issues.length > 0) {
    const summary = issues
      .map((issue) => `README.md:${issue.line} ${issue.kind} link is not publish-safe: ${issue.target}`)
      .join("\n");
    throw new Error(
      `README contains links or assets that will not resolve reliably on npm.\n${summary}`
    );
  }

  console.log("README publish links look safe for npm.");
}

if (require.main === module) {
  main();
}

module.exports = {
  findPublishReadmeIssues,
  isPublishSafeTarget,
};
