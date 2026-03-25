import path from "node:path";
import { promises as fs } from "node:fs";

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

export async function removeDirectory(directoryPath: string): Promise<void> {
  await fs.rm(directoryPath, { recursive: true, force: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

export async function listFiles(
  rootDirectory: string,
  predicate: (filePath: string) => boolean,
  options?: {
    ignoreDirectories?: string[];
  },
): Promise<string[]> {
  const ignoreDirectories = new Set(options?.ignoreDirectories ?? []);
  const results: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        if (!ignoreDirectories.has(entry.name)) {
          await visit(absolutePath);
        }

        continue;
      }

      if (entry.isFile() && predicate(absolutePath)) {
        results.push(absolutePath);
      }
    }
  }

  if (await fileExists(rootDirectory)) {
    await visit(rootDirectory);
  }

  return results.sort();
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

export function sanitizeFileName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "item";
}
