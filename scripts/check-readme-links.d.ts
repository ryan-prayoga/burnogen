export interface PublishReadmeIssue {
  kind: "markdown" | "html";
  target: string;
  line: number;
}

export interface ReadmeLengthIssue {
  actualLines: number;
  maxLines: number;
}

export interface RepoHostedPathIssue {
  kind: "markdown" | "html";
  target: string;
  line: number;
  repoPath: string;
}

export const maxReadmeLines: number;
export const repositorySlug: string;
export function countReadmeLines(content: string): number;
export function findPublishReadmeIssues(content: string): PublishReadmeIssue[];
export function findRepoHostedPathIssues(content: string): RepoHostedPathIssue[];
export function findReadmeLengthIssues(
  content: string,
  options?: { maxLines?: number },
): ReadmeLengthIssue[];
export function isPublishSafeTarget(target: string): boolean;
export function resolveRepoHostedPath(target: string): string | null;
