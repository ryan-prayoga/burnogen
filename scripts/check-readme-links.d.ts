export interface PublishReadmeIssue {
  kind: "markdown" | "html";
  target: string;
  line: number;
}

export function findPublishReadmeIssues(content: string): PublishReadmeIssue[];
export function isPublishSafeTarget(target: string): boolean;
