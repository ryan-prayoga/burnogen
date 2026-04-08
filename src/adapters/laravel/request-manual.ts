import type { NormalizedRequestBody, SchemaObject } from "../../core/model";
import { parseLaravelEnumValues } from "./enums";
import {
  type PhpFileContext,
  type PhpClassRecord,
  dedupeStrings,
  parsePhpStringList,
} from "./shared";

export async function extractLaravelManualRequestSchema(
  methodBody: string,
  classIndex: Map<string, PhpClassRecord>,
  fileContext?: PhpFileContext,
): Promise<SchemaObject | undefined> {
  const properties: Record<string, SchemaObject> = {};

  const accessorPatterns: Array<{
    regex: RegExp;
    schemaFactory: () => SchemaObject;
  }> = [
    {
      regex:
        /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:input|get|post|json|string)\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "string" }),
    },
    {
      regex:
        /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*integer\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "integer" }),
    },
    {
      regex:
        /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:float|double)\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "number" }),
    },
    {
      regex:
        /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*boolean\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "boolean" }),
    },
    {
      regex:
        /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:has|filled)\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "boolean" }),
    },
    {
      regex:
        /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*(?:array|collect)\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "array", items: { type: "string" } }),
    },
    {
      regex:
        /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*date\s*\(\s*['"]([^'"]+)['"]/g,
      schemaFactory: () => ({ type: "string", format: "date-time" }),
    },
    {
      regex: /request\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      schemaFactory: () => ({ type: "string" }),
    },
  ];

  for (const pattern of accessorPatterns) {
    for (const match of methodBody.matchAll(pattern.regex)) {
      const fieldName = match[1];
      if (!fieldName || fieldName.includes(".")) {
        continue;
      }

      properties[fieldName] = mergeSchemaObjects(
        properties[fieldName],
        pattern.schemaFactory(),
      );
    }
  }

  for (const match of methodBody.matchAll(
    /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))(?:\s*->\s*safe\s*\(\s*\))?\s*->\s*only\s*\(\s*(\[[^\]]*\])\s*\)/g,
  )) {
    const arrayLiteral = match[1];
    if (!arrayLiteral) {
      continue;
    }

    for (const fieldName of parsePhpStringList(arrayLiteral)) {
      if (!fieldName || fieldName.includes(".")) {
        continue;
      }

      properties[fieldName] = mergeSchemaObjects(properties[fieldName], {
        type: "string",
      });
    }
  }

  for (const match of methodBody.matchAll(
    /(?:\$[A-Za-z_][A-Za-z0-9_]*|request\(\))\s*->\s*enum\s*\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z0-9_\\]+)::class/g,
  )) {
    const fieldName = match[1];
    const enumType = match[2];
    if (!fieldName || !enumType || fieldName.includes(".")) {
      continue;
    }

    const enumValues = await parseLaravelEnumValues(
      enumType,
      classIndex,
      fileContext,
    );
    properties[fieldName] = mergeSchemaObjects(
      properties[fieldName],
      enumValues.length > 0
        ? {
            type: typeof enumValues[0] === "number" ? "number" : "string",
            enum: enumValues,
          }
        : { type: "string" },
    );
  }

  if (Object.keys(properties).length === 0) {
    return undefined;
  }

  return {
    type: "object",
    properties,
  };
}

export function mergeLaravelRequestBodies(
  existing: NormalizedRequestBody | undefined,
  manualSchema: SchemaObject,
): NormalizedRequestBody {
  if (!existing) {
    return {
      contentType: "application/json",
      schema: manualSchema,
    };
  }

  return {
    ...existing,
    schema: mergeSchemaObjects(existing.schema, manualSchema),
  };
}

function mergeSchemaObjects(
  left: SchemaObject | undefined,
  right: SchemaObject | undefined,
): SchemaObject {
  if (!left) {
    return right ?? {};
  }

  if (!right) {
    return left;
  }

  const mergedProperties = {
    ...(left.properties ?? {}),
    ...(right.properties ?? {}),
  };

  return {
    ...left,
    ...right,
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : undefined,
    required: dedupeStrings([
      ...(left.required ?? []),
      ...(right.required ?? []),
    ]),
  };
}
