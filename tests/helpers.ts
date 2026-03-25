import path from "node:path";

export function fixturePath(...segments: string[]): string {
  return path.join(__dirname, "fixtures", ...segments);
}
