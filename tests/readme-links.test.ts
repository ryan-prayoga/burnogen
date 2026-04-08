import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { repoPath } from "./helpers";

describe("README publish safety", () => {
  it("accepts the checked-in README", async () => {
    const {
      countReadmeLines,
      findPublishReadmeIssues,
      findReadmeLengthIssues,
      maxReadmeLines,
    } = await import("../scripts/check-readme-links.js");
    const readme = await fs.readFile(repoPath("README.md"), "utf8");

    expect(findPublishReadmeIssues(readme)).toEqual([]);
    expect(findReadmeLengthIssues(readme)).toEqual([]);
    expect(countReadmeLines(readme)).toBeLessThanOrEqual(maxReadmeLines);
  });

  it("flags relative links and assets that will break on npm", async () => {
    const { findPublishReadmeIssues } = await import("../scripts/check-readme-links.js");
    const content = `
[reference](docs/reference.md)
<a href="docs/demo/laravel-happy-path/README.md">demo</a>
<img src="docs/assets/preview-laravel.png" />
`.trim();

    expect(findPublishReadmeIssues(content)).toEqual([
      expect.objectContaining({ kind: "markdown", target: "docs/reference.md", line: 1 }),
      expect.objectContaining({ kind: "html", target: "docs/demo/laravel-happy-path/README.md", line: 2 }),
      expect.objectContaining({ kind: "html", target: "docs/assets/preview-laravel.png", line: 3 }),
    ]);
  });

  it("allows absolute and anchor links", async () => {
    const { findPublishReadmeIssues } = await import("../scripts/check-readme-links.js");
    const content = `
[reference](https://github.com/ryan-prayoga/brunogen/blob/main/docs/reference.md)
[section](#read-more)
<a href="mailto:maintainer@example.com">mail</a>
<img src="https://raw.githubusercontent.com/ryan-prayoga/brunogen/main/docs/assets/preview-laravel.png" />
`.trim();

    expect(findPublishReadmeIssues(content)).toEqual([]);
  });

  it("flags a README that grows too long for npm", async () => {
    const { findReadmeLengthIssues, maxReadmeLines } = await import("../scripts/check-readme-links.js");
    const content = Array.from(
      { length: maxReadmeLines + 1 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");

    expect(findReadmeLengthIssues(content)).toEqual([
      expect.objectContaining({
        actualLines: maxReadmeLines + 1,
        maxLines: maxReadmeLines,
      }),
    ]);
  });
});
