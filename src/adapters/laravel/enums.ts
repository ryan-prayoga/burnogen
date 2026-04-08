import { promises as fs } from "node:fs";

import { parsePhpExampleValue } from "./examples";
import {
  type PhpClassRecord,
  type PhpFileContext,
  resolvePhpClassRecord,
} from "./shared";

export async function parseLaravelEnumValues(
  enumType: string,
  classIndex: Map<string, PhpClassRecord>,
  fileContext?: PhpFileContext,
): Promise<Array<string | number>> {
  const enumRecord = resolvePhpClassRecord(classIndex, enumType, fileContext);
  if (!enumRecord) {
    return [];
  }

  const content = await fs.readFile(enumRecord.filePath, "utf8");
  const values: Array<string | number> = [];

  for (const match of content.matchAll(
    /\bcase\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:=\s*([^;]+))?;/g,
  )) {
    const rawValue = match[1]?.trim();
    if (!rawValue) {
      continue;
    }

    const parsed = parsePhpExampleValue(rawValue);
    if (typeof parsed === "string" || typeof parsed === "number") {
      values.push(parsed);
    }
  }

  return values;
}
