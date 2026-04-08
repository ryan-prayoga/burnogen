export interface PublishReadmeIssue {
  kind: "markdown" | "html";
  target: string;
  line: number;
}

export interface ReadmeLengthIssue {
  actualLines: number;
  maxLines: number;
}

export const maxReadmeLines: number;
export function countReadmeLines(content: string): number;
export function findPublishReadmeIssues(content: string): PublishReadmeIssue[];
export function findReadmeLengthIssues(
  content: string,
  options?: { maxLines?: number },
): ReadmeLengthIssue[];
export function isPublishSafeTarget(target: string): boolean;
