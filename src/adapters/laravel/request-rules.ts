import { promises as fs } from "node:fs";

import { extractBalanced, splitTopLevel } from "../../core/parsing";
import type { SchemaObject } from "../../core/model";
import {
  type PhpFileContext,
  type PhpClassRecord,
  extractReturnArray,
  findPhpMethod,
  parsePhpString,
  parsePhpStringList,
  resolvePhpClassRecord,
  splitOnce,
} from "./shared";

export async function parseFormRequestSchema(
  requestType: string,
  classIndex: Map<string, PhpClassRecord>,
  fileContext?: PhpFileContext,
): Promise<SchemaObject | undefined> {
  const requestRecord = resolvePhpClassRecord(classIndex, requestType, fileContext);
  if (!requestRecord) {
    return undefined;
  }

  const content = await fs.readFile(requestRecord.filePath, "utf8");
  const rulesMethod = findPhpMethod(content, "rules");
  if (!rulesMethod) {
    return undefined;
  }

  const rules = extractReturnArray(rulesMethod.body);
  if (!rules) {
    return undefined;
  }

  return buildLaravelSchemaFromRules(parsePhpRulesArray(rules));
}

export function extractInlineValidationRules(
  methodBody: string,
): Record<string, string[]> | undefined {
  const validateCallIndex = methodBody.search(/->validate\s*\(/);
  if (validateCallIndex >= 0) {
    const arrayStart = methodBody.indexOf("[", validateCallIndex);
    if (arrayStart >= 0) {
      const arrayBody = extractBalanced(methodBody, arrayStart, "[", "]");
      if (arrayBody) {
        return parsePhpRulesArray(arrayBody);
      }
    }
  }

  const validatorCallIndex = methodBody.search(/Validator::make\s*\(/);
  if (validatorCallIndex >= 0) {
    const arrayStart = methodBody.indexOf("[", validatorCallIndex);
    if (arrayStart >= 0) {
      const arrayBody = extractBalanced(methodBody, arrayStart, "[", "]");
      if (arrayBody) {
        return parsePhpRulesArray(arrayBody);
      }
    }
  }

  return undefined;
}

export function buildLaravelSchemaFromRules(
  ruleMap: Record<string, string[]>,
): SchemaObject {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  for (const [fieldName, rules] of Object.entries(ruleMap)) {
    if (fieldName.includes(".")) {
      continue;
    }

    const schema: SchemaObject = {};
    let inferredType: string | undefined;

    for (const rule of rules) {
      const [name, rawArgument] = splitRule(rule);
      switch (name) {
        case "required":
          required.push(fieldName);
          break;
        case "string":
          inferredType = "string";
          break;
        case "integer":
        case "int":
          inferredType = "integer";
          break;
        case "numeric":
          inferredType = "number";
          break;
        case "boolean":
          inferredType = "boolean";
          break;
        case "array":
          inferredType = "array";
          schema.items = { type: "string" };
          break;
        case "email":
          inferredType = "string";
          schema.format = "email";
          break;
        case "uuid":
          inferredType = "string";
          schema.format = "uuid";
          break;
        case "date":
        case "date_format":
          inferredType = "string";
          schema.format = "date-time";
          break;
        case "nullable":
          schema.nullable = true;
          break;
        case "min":
          applyLaravelRange(schema, inferredType, rawArgument, "min");
          break;
        case "max":
          applyLaravelRange(schema, inferredType, rawArgument, "max");
          break;
        case "in":
          inferredType = inferredType ?? "string";
          schema.enum = rawArgument
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          break;
        default:
          break;
      }
    }

    schema.type = inferredType ?? schema.type ?? "string";
    properties[fieldName] = schema;
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? [...new Set(required)] : undefined,
  };
}

function parsePhpRulesArray(arrayBody: string): Record<string, string[]> {
  const inner = arrayBody.slice(1, -1);
  const entries = splitTopLevel(inner, ",");
  const result: Record<string, string[]> = {};

  for (const entry of entries) {
    if (!entry.includes("=>")) {
      continue;
    }

    const [rawKey, rawValue] = splitOnce(entry, "=>");
    const key = parsePhpString(rawKey.trim());
    if (!key) {
      continue;
    }

    result[key] = parseRuleValue(rawValue.trim());
  }

  return result;
}

function parseRuleValue(rawValue: string): string[] {
  const singleRule = parsePhpString(rawValue);
  if (singleRule) {
    return singleRule
      .split("|")
      .map((rule) => rule.trim())
      .filter(Boolean);
  }

  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    return parsePhpStringList(rawValue)
      .flatMap((rule) => rule.split("|"))
      .map((rule) => rule.trim())
      .filter(Boolean);
  }

  return [];
}

function applyLaravelRange(
  schema: SchemaObject,
  inferredType: string | undefined,
  rawArgument: string,
  kind: "min" | "max",
): void {
  const numericValue = Number.parseFloat(rawArgument);
  if (Number.isNaN(numericValue)) {
    return;
  }

  if (inferredType === "integer" || inferredType === "number") {
    if (kind === "min") {
      schema.minimum = numericValue;
    } else {
      schema.maximum = numericValue;
    }
    return;
  }

  if (kind === "min") {
    schema.minLength = numericValue;
  } else {
    schema.maxLength = numericValue;
  }
}

function splitRule(rule: string): [string, string] {
  const [name, ...rest] = rule.split(":");
  return [name.trim(), rest.join(":").trim()];
}
