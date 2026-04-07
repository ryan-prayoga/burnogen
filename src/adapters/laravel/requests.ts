import { promises as fs } from "node:fs";

import type {
  GenerationWarning,
  NormalizedParameter,
  NormalizedRequestBody,
  NormalizedResponse,
} from "../../core/model";
import {
  buildLaravelSchemaFromRules,
  extractFirstRequestType,
  extractInlineValidationRules,
  extractLaravelManualRequestSchema,
  mergeLaravelRequestBodies,
  parseFormRequestSchema,
} from "./request-bodies";
import {
  extractLaravelHeaderParameters,
  extractLaravelQueryParameters,
} from "./request-parameters";
import { extractLaravelResponses } from "./responses";
import {
  type ControllerAnalysis,
  parsePhpFileContext,
  type ParsedHandler,
  type PhpClassRecord,
  findPhpMethod,
  resolvePhpClassRecord,
  shortPhpClassName,
} from "./shared";

export async function analyzeControllerHandler(
  handler: ParsedHandler | undefined,
  classIndex: Map<string, PhpClassRecord>,
  controllerCache: Map<string, ControllerAnalysis>,
): Promise<ControllerAnalysis> {
  if (!handler?.controller || !handler.action) {
    return {
      queryParameters: [],
      headerParameters: [],
      responses: [],
      warnings: [],
    };
  }

  const cacheKey = `${handler.controller}:${handler.action}`;
  const cached = controllerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const controllerRecord = resolvePhpClassRecord(classIndex, handler.controller);
  if (!controllerRecord) {
    const warning = {
      code: "LARAVEL_CONTROLLER_NOT_FOUND",
      message: `Could not locate controller ${handler.controller} while inferring request schema.`,
    };
    const result = {
      queryParameters: [],
      headerParameters: [],
      responses: [],
      warnings: [warning],
    };
    controllerCache.set(cacheKey, result);
    return result;
  }

  const content = await fs.readFile(controllerRecord.filePath, "utf8");
  const fileContext = parsePhpFileContext(content);
  const method = findPhpMethod(content, handler.action);
  if (!method) {
    const warning = {
      code: "LARAVEL_CONTROLLER_METHOD_NOT_FOUND",
      message: `Could not locate ${handler.controller}::${handler.action} while inferring request schema.`,
      location: { file: controllerRecord.filePath },
    };
    const result = {
      queryParameters: [],
      headerParameters: [],
      responses: [],
      warnings: [warning],
    };
    controllerCache.set(cacheKey, result);
    return result;
  }

  const firstRequestType = extractFirstRequestType(method.rawParams);
  const body = method.body;
  const warnings: GenerationWarning[] = [];
  let requestBody: NormalizedRequestBody | undefined;
  let queryParameters: NormalizedParameter[] = [];
  let headerParameters: NormalizedParameter[] = [];
  let responses: NormalizedResponse[] = [];

  if (
    firstRequestType &&
    shortPhpClassName(firstRequestType) !== "Request"
  ) {
    const requestSchema = await parseFormRequestSchema(
      firstRequestType,
      classIndex,
      fileContext,
    );
    if (requestSchema) {
      requestBody = {
        contentType: "application/json" as const,
        schema: requestSchema,
      };
    }
  }

  if (body) {
    const inlineRules = extractInlineValidationRules(body);
    if (inlineRules) {
      requestBody = {
        contentType: "application/json" as const,
        schema: buildLaravelSchemaFromRules(inlineRules),
      };
    }

    const manualRequestSchema = await extractLaravelManualRequestSchema(
      body,
      classIndex,
      fileContext,
    );
    if (manualRequestSchema) {
      requestBody = mergeLaravelRequestBodies(requestBody, manualRequestSchema);
    }

    queryParameters = extractLaravelQueryParameters(body);
    headerParameters = extractLaravelHeaderParameters(body);
    responses = await extractLaravelResponses(
      body,
      classIndex,
      content,
      undefined,
      0,
      fileContext,
    );
  }

  const result = {
    requestBody,
    queryParameters,
    headerParameters,
    responses,
    warnings,
  };
  controllerCache.set(cacheKey, result);
  return result;
}
