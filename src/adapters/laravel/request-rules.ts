import { promises as fs } from "node:fs";

import { extractBalanced, splitTopLevel } from "../../core/parsing";
import type { SchemaObject } from "../../core/model";
import { parseLaravelEnumValues } from "./enums";
import {
  type PhpFileContext,
  type PhpClassRecord,
  dedupeStrings,
  extractReturnArray,
  findPhpMethod,
  parsePhpFileContext,
  parsePhpString,
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
  const requestFileContext = parsePhpFileContext(content);
  const rulesMethod = findPhpMethod(content, "rules");
  if (!rulesMethod) {
    return undefined;
  }

  const rules = extractReturnArray(rulesMethod.body);
  if (!rules) {
    return undefined;
  }

  return buildLaravelSchemaFromRules(
    parsePhpRulesArray(rules),
    classIndex,
    requestFileContext,
  );
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

export async function buildLaravelSchemaFromRules(
  ruleMap: Record<string, string[]>,
  classIndex?: Map<string, PhpClassRecord>,
  fileContext?: PhpFileContext,
): Promise<SchemaObject> {
  const rootSchema: SchemaObject = {
    type: "object",
    properties: {},
  };

  for (const [fieldName, rules] of Object.entries(ruleMap)) {
    const fieldSchema = await buildFieldSchema(
      fieldName,
      rules,
      classIndex,
      fileContext,
    );
    applyRuleFieldSchema(rootSchema, fieldName, fieldSchema.schema, fieldSchema.required);
  }

  return rootSchema;
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
    return splitTopLevel(rawValue.slice(1, -1), ",")
      .flatMap((rule) => normalizeRuleEntry(rule.trim()))
      .filter(Boolean);
  }

  return normalizeRuleEntry(rawValue);
}

function normalizeRuleEntry(rule: string): string[] {
  if (!rule) {
    return [];
  }

  const literalRule = parsePhpString(rule);
  if (literalRule) {
    return literalRule
      .split("|")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const inRuleMatch = rule.match(
    /^[A-Za-z_\\][A-Za-z0-9_\\]*::in\s*\(\s*(\[[\s\S]*\])\s*\)$/i,
  );
  if (inRuleMatch?.[1]) {
    const values = splitTopLevel(inRuleMatch[1].slice(1, -1), ",")
      .map((entry) => parsePhpString(entry.trim()))
      .filter((value): value is string => Boolean(value));

    return values.length > 0 ? [`in:${values.join(",")}`] : [];
  }

  const enumRuleMatch = rule.match(
    /^[A-Za-z_\\][A-Za-z0-9_\\]*::enum\s*\(\s*([A-Za-z0-9_\\]+)::class\s*\)$/i,
  );
  if (enumRuleMatch?.[1]) {
    return [`enum:${enumRuleMatch[1]}`];
  }

  return [];
}

async function buildFieldSchema(
  fieldName: string,
  rules: string[],
  classIndex?: Map<string, PhpClassRecord>,
  fileContext?: PhpFileContext,
): Promise<{ schema: SchemaObject; required: boolean }> {
  const schema: SchemaObject = {};
  let inferredType: string | undefined;
  let required = false;

  for (const rule of rules) {
    const [name, rawArgument] = splitRule(rule);
    switch (name) {
      case "required":
        required = true;
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
        inferredType =
          fieldName.includes(".") && !fieldName.includes(".*")
            ? "object"
            : "array";
        if (inferredType === "array") {
          schema.items = schema.items ?? { type: "string" };
        }
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
      case "enum":
        if (classIndex && rawArgument) {
          const enumValues = await parseLaravelEnumValues(
            rawArgument,
            classIndex,
            fileContext,
          );
          if (enumValues.length > 0) {
            inferredType =
              typeof enumValues[0] === "number" ? "number" : "string";
            schema.enum = enumValues;
          }
        }
        break;
      default:
        break;
    }
  }

  schema.type = inferredType ?? schema.type ?? "string";
  return { schema, required };
}

function applyRuleFieldSchema(
  rootSchema: SchemaObject,
  fieldName: string,
  fieldSchema: SchemaObject,
  required: boolean,
): void {
  applyRuleSegments(rootSchema, fieldName.split("."), fieldSchema, required);
}

function applyRuleSegments(
  container: SchemaObject,
  segments: string[],
  fieldSchema: SchemaObject,
  required: boolean,
): void {
  const [segment, ...rest] = segments;
  if (!segment) {
    return;
  }

  if (segment === "*") {
    ensureArraySchema(container);
    const itemSchema = ensureSchemaObject(container.items);

    if (rest.length === 0) {
      container.items = mergeSchemaObjects(itemSchema, fieldSchema);
      return;
    }

    applyRuleSegments(itemSchema, rest, fieldSchema, required);
    container.items = itemSchema;
    return;
  }

  ensureObjectSchema(container);
  const properties = container.properties ?? (container.properties = {});
  const propertySchema = ensureSchemaObject(properties[segment]);

  if (rest.length === 0) {
    properties[segment] = mergeSchemaObjects(propertySchema, fieldSchema);
    if (required) {
      container.required = dedupeStrings([...(container.required ?? []), segment]);
    }
    return;
  }

  if (rest[0] === "*") {
    ensureArraySchema(propertySchema);
  } else {
    ensureObjectSchema(propertySchema);
  }

  properties[segment] = propertySchema;
  applyRuleSegments(propertySchema, rest, fieldSchema, required);
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

  const mergedProperties: Record<string, SchemaObject> = {
    ...(left.properties ?? {}),
  };

  for (const [key, value] of Object.entries(right.properties ?? {})) {
    mergedProperties[key] = mergeSchemaObjects(mergedProperties[key], value);
  }

  const leftItems = ensureSchemaObject(left.items);
  const rightItems = ensureSchemaObject(right.items);
  const hasItemSchemas =
    Object.keys(leftItems).length > 0 || Object.keys(rightItems).length > 0;
  const mergedItems = hasItemSchemas
    ? mergeSchemaObjects(leftItems, rightItems)
    : undefined;

  return {
    ...left,
    ...right,
    items: mergedItems ?? right.items ?? left.items,
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : undefined,
    required: dedupeStrings([
      ...(left.required ?? []),
      ...(right.required ?? []),
    ]),
  };
}

function ensureSchemaObject(
  input: SchemaObject | boolean | undefined,
): SchemaObject {
  if (!input || typeof input === "boolean") {
    return {};
  }

  return input;
}

function clearScalarKeywords(schema: SchemaObject): void {
  delete schema.format;
  delete schema.enum;
  delete schema.minLength;
  delete schema.maxLength;
  delete schema.minimum;
  delete schema.maximum;
}

function ensureObjectSchema(schema: SchemaObject): void {
  if (schema.type !== "object") {
    schema.type = "object";
    delete schema.items;
    clearScalarKeywords(schema);
  }

  schema.properties = schema.properties ?? {};
}

function ensureArraySchema(schema: SchemaObject): void {
  if (schema.type !== "array") {
    schema.type = "array";
    delete schema.properties;
    delete schema.required;
    clearScalarKeywords(schema);
  }

  schema.items = ensureSchemaObject(schema.items);
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
