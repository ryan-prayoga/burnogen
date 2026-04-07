import { promises as fs } from "node:fs";

import { dedupeResponsesByStatusCode } from "../../core/dedupe";
import { extractBalanced, splitTopLevel } from "../../core/parsing";
import type { NormalizedResponse, SchemaObject } from "../../core/model";
import {
  createPhpExampleContext,
  inferSchemaFromExample,
  parsePhpExampleValue,
  type PhpExampleContext,
} from "./examples";
import {
  type PhpFileContext,
  type LaravelResourceSchema,
  type PhpClassRecord,
  extractDirectReturnArrays,
  extractReturnArray,
  extractReturnStatements,
  findPhpMethod,
  resolvePhpClassRecord,
} from "./shared";

export async function extractLaravelResourceResponses(
  methodBody: string,
  classIndex: Map<string, PhpClassRecord>,
  exampleContext: PhpExampleContext,
  fileContext?: PhpFileContext,
): Promise<NormalizedResponse[]> {
  const responses: NormalizedResponse[] = [];
  const returnStatements = extractReturnStatements(methodBody);

  for (const statement of returnStatements) {
    const parsedResourceReturn = parseLaravelResourceReturnStatement(
      statement,
      exampleContext,
    );
    if (!parsedResourceReturn) {
      continue;
    }

    const resourceResponse = await buildLaravelResourceResponse(
      parsedResourceReturn.resourceType,
      parsedResourceReturn.mode,
      classIndex,
      parsedResourceReturn.additional,
      fileContext,
    );
    if (resourceResponse) {
      responses.push(resourceResponse);
    }
  }

  return dedupeResponsesByStatusCode(responses);
}

async function buildLaravelResourceResponse(
  resourceType: string,
  mode: "single" | "collection",
  classIndex: Map<string, PhpClassRecord>,
  additional?: unknown,
  fileContext?: PhpFileContext,
): Promise<NormalizedResponse | undefined> {
  const resourceSchema = await parseLaravelResourceSchema(
    resourceType,
    classIndex,
    fileContext,
  );
  if (!resourceSchema) {
    return undefined;
  }

  const additionalProperties =
    additional && typeof additional === "object" && !Array.isArray(additional)
      ? (additional as Record<string, unknown>)
      : undefined;
  const additionalSchema = additionalProperties
    ? inferSchemaFromExample(additionalProperties)
    : undefined;
  const wrappedSchema: SchemaObject =
    mode === "collection"
      ? {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: resourceSchema.schema,
            },
            ...(additionalSchema?.properties ?? {}),
          },
        }
      : {
          type: "object",
          properties: {
            data: resourceSchema.schema,
            ...(additionalSchema?.properties ?? {}),
          },
        };
  const wrappedExample =
    mode === "collection"
      ? { data: [resourceSchema.example], ...(additionalProperties ?? {}) }
      : { data: resourceSchema.example, ...(additionalProperties ?? {}) };

  return {
    statusCode: "200",
    description: "Inferred Laravel resource response",
    contentType: "application/json",
    schema: wrappedSchema,
    example: wrappedExample,
  };
}

async function parseLaravelResourceSchema(
  resourceType: string,
  classIndex: Map<string, PhpClassRecord>,
  fileContext?: PhpFileContext,
): Promise<LaravelResourceSchema | undefined> {
  const resourceRecord = resolvePhpClassRecord(
    classIndex,
    resourceType,
    fileContext,
  );
  if (!resourceRecord) {
    return undefined;
  }

  const content = await fs.readFile(resourceRecord.filePath, "utf8");
  const toArrayMethod = findPhpMethod(content, "toArray");
  if (!toArrayMethod) {
    return undefined;
  }

  const arrayLiteral =
    extractDirectReturnArrays(toArrayMethod.body)[0] ??
    extractReturnArray(toArrayMethod.body);
  if (!arrayLiteral) {
    return undefined;
  }

  const example = parsePhpExampleValue(
    arrayLiteral,
    createPhpExampleContext(toArrayMethod.body),
  );
  return {
    schema: inferSchemaFromExample(example),
    example,
  };
}

function parseLaravelResourceReturnStatement(
  statement: string,
  exampleContext: PhpExampleContext,
):
  | {
      resourceType: string;
      mode: "single" | "collection";
      additional?: unknown;
    }
  | undefined {
  const newResourceMatch = statement.match(
    /^return\s+new\s+([A-Za-z0-9_\\]+)\s*\(/,
  );
  if (newResourceMatch?.[1]) {
    return {
      resourceType: newResourceMatch[1],
      mode: "single",
      additional: extractLaravelResourceAdditional(statement, exampleContext),
    };
  }

  const factoryMatch = statement.match(
    /^return\s+([A-Za-z0-9_\\]+)::(make|collection)\s*\(/,
  );
  if (factoryMatch?.[1] && factoryMatch[2]) {
    return {
      resourceType: factoryMatch[1],
      mode: factoryMatch[2] === "collection" ? "collection" : "single",
      additional: extractLaravelResourceAdditional(statement, exampleContext),
    };
  }

  return undefined;
}

function extractLaravelResourceAdditional(
  statement: string,
  exampleContext: PhpExampleContext,
): unknown | undefined {
  const additionalIndex = statement.indexOf("->additional(");
  if (additionalIndex < 0) {
    return undefined;
  }

  const openParenIndex = statement.indexOf(
    "(",
    additionalIndex + "->additional".length,
  );
  const argsBlock =
    openParenIndex >= 0
      ? extractBalanced(statement, openParenIndex, "(", ")")
      : null;
  if (!argsBlock) {
    return undefined;
  }

  const firstArg = splitTopLevel(argsBlock.slice(1, -1), ",")[0]?.trim();
  if (!firstArg) {
    return undefined;
  }

  const additional = parsePhpExampleValue(firstArg, exampleContext);
  return additional &&
    typeof additional === "object" &&
    !Array.isArray(additional)
    ? additional
    : undefined;
}
