import { dedupeResponsesByStatusCode } from "../../core/dedupe";
import {
  extractBalanced,
  findTopLevelTerminator,
  splitTopLevel,
} from "../../core/parsing";
import type { NormalizedResponse } from "../../core/model";
import {
  createPhpExampleContext,
  inferSchemaFromExample,
  parsePhpExampleValue,
  type PhpExampleContext,
} from "./examples";
import {
  type PhpFileContext,
  type PhpClassRecord,
  extractDirectReturnArrays,
  extractReturnStatements,
  findPhpMethod,
  parsePhpString,
} from "./shared";
import {
  extractLaravelResourceResponses,
  extractLaravelWrappedJsonResourcePayload,
  isLaravelResourceResponseExpression,
} from "./resources";

export async function extractLaravelResponses(
  methodBody: string,
  classIndex: Map<string, PhpClassRecord>,
  controllerContent: string,
  baseContext?: PhpExampleContext,
  depth = 0,
  fileContext?: PhpFileContext,
): Promise<NormalizedResponse[]> {
  const responses = new Map<string, NormalizedResponse>();
  const exampleContext = createPhpExampleContext(
    methodBody,
    baseContext?.assignments,
  );

  for (const jsonCall of extractReturnResponseJsonCalls(methodBody)) {
    const args = splitTopLevel(jsonCall.slice(1, -1), ",");
    if (args.length === 0) {
      continue;
    }

    const wrappedResourcePayload = await extractLaravelWrappedJsonResourcePayload(
      args[0] ?? "",
      classIndex,
      exampleContext,
      fileContext,
    );
    if (wrappedResourcePayload) {
      const statusCode = parseLaravelStatusCode(args[1]) ?? "200";
      responses.set(statusCode, {
        statusCode,
        description: "Inferred JSON response",
        contentType: "application/json",
        schema: wrappedResourcePayload.schema,
        example: wrappedResourcePayload.example,
      });
      continue;
    }

    if (isLaravelResourceResponseExpression(args[0] ?? "")) {
      continue;
    }

    const example = parsePhpExampleValue(args[0], exampleContext);
    const statusCode = parseLaravelStatusCode(args[1]) ?? "200";
    responses.set(statusCode, {
      statusCode,
      description: "Inferred JSON response",
      contentType: "application/json",
      schema: inferSchemaFromExample(example),
      example,
    });
  }

  if (depth < 2) {
    for (const helperResponse of await extractLaravelHelperResponses(
      methodBody,
      classIndex,
      controllerContent,
      exampleContext,
      depth,
      fileContext,
    )) {
      if (!responses.has(helperResponse.statusCode)) {
        responses.set(helperResponse.statusCode, helperResponse);
      }
    }
  }

  for (const noContentCall of extractReturnResponseNoContentCalls(methodBody)) {
    const args = splitTopLevel(noContentCall.slice(1, -1), ",");
    const statusCode = parseLaravelStatusCode(args[0]) ?? "204";
    responses.set(statusCode, {
      statusCode,
      description: "Inferred empty response",
    });
  }

  for (const abortResponse of extractLaravelAbortResponses(methodBody)) {
    if (!responses.has(abortResponse.statusCode)) {
      responses.set(abortResponse.statusCode, abortResponse);
    }
  }

  if (hasLaravelNotFoundPattern(methodBody) && !responses.has("404")) {
    responses.set("404", {
      statusCode: "404",
      description: "Inferred not found response",
      contentType: "application/json",
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
      example: {
        message: "Not Found",
      },
    });
  }

  for (const exceptionResponse of extractLaravelExceptionResponses(
    methodBody,
    exampleContext,
  )) {
    if (!responses.has(exceptionResponse.statusCode)) {
      responses.set(exceptionResponse.statusCode, exceptionResponse);
    }
  }

  for (const arrayLiteral of extractDirectReturnArrays(methodBody)) {
    const example = parsePhpExampleValue(arrayLiteral, exampleContext);
    const statusCode = "200";
    if (!responses.has(statusCode)) {
      responses.set(statusCode, {
        statusCode,
        description: "Inferred array response",
        contentType: "application/json",
        schema: inferSchemaFromExample(example),
        example,
      });
    }
  }

  const resourceResponses = await extractLaravelResourceResponses(
    methodBody,
    classIndex,
    exampleContext,
    fileContext,
  );
  for (const response of resourceResponses) {
    if (!responses.has(response.statusCode)) {
      responses.set(response.statusCode, response);
    }
  }

  return [...responses.values()];
}

function extractLaravelAbortResponses(
  methodBody: string,
): NormalizedResponse[] {
  const responses = new Map<string, NormalizedResponse>();

  for (const abortCall of extractLaravelAbortCalls(methodBody)) {
    const args = splitTopLevel(abortCall.slice(1, -1), ",");
    const statusCode = parseLaravelStatusCode(args[0]) ?? "500";
    const message =
      parsePhpString(args[1] ?? "") ?? defaultAbortMessage(statusCode);
    responses.set(statusCode, {
      statusCode,
      description: "Inferred abort response",
      contentType: "application/json",
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
      example: {
        message,
      },
    });
  }

  return [...responses.values()];
}

function extractLaravelExceptionResponses(
  methodBody: string,
  exampleContext: PhpExampleContext,
): NormalizedResponse[] {
  const responses = new Map<string, NormalizedResponse>();

  for (const validationErrors of extractLaravelValidationExceptionExamples(
    methodBody,
    exampleContext,
  )) {
    responses.set("422", {
      statusCode: "422",
      description: "Inferred validation exception response",
      contentType: "application/json",
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          errors: inferSchemaFromExample(validationErrors),
        },
      },
      example: {
        message: "The given data was invalid.",
        errors: validationErrors,
      },
    });
  }

  return [...responses.values()];
}

function extractReturnResponseJsonCalls(methodBody: string): string[] {
  const results: string[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const returnIndex = methodBody.indexOf("return response()->json(", offset);
    if (returnIndex < 0) {
      break;
    }

    const openParenIndex = methodBody.indexOf(
      "(",
      returnIndex + "return response()->json".length,
    );
    const argsBlock =
      openParenIndex >= 0
        ? extractBalanced(methodBody, openParenIndex, "(", ")")
        : null;
    if (!argsBlock) {
      break;
    }

    results.push(argsBlock);
    offset = openParenIndex + argsBlock.length;
  }

  return results;
}

function extractLaravelAbortCalls(methodBody: string): string[] {
  const results: string[] = [];
  const patterns = ["abort(", "abort_if(", "abort_unless("];

  for (const pattern of patterns) {
    let offset = 0;
    while (offset < methodBody.length) {
      const callIndex = methodBody.indexOf(pattern, offset);
      if (callIndex < 0) {
        break;
      }

      const openParenIndex = methodBody.indexOf(
        "(",
        callIndex + pattern.length - 1,
      );
      const argsBlock =
        openParenIndex >= 0
          ? extractBalanced(methodBody, openParenIndex, "(", ")")
          : null;
      if (!argsBlock) {
        break;
      }

      if (pattern === "abort(") {
        results.push(argsBlock);
      } else {
        const args = splitTopLevel(argsBlock.slice(1, -1), ",");
        if (args.length >= 2) {
          results.push(`(${args.slice(1).join(",")})`);
        }
      }

      offset = openParenIndex + argsBlock.length;
    }
  }

  return results;
}

function extractLaravelValidationExceptionExamples(
  methodBody: string,
  exampleContext: PhpExampleContext,
): Record<string, unknown>[] {
  const examples: Record<string, unknown>[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const callIndex = methodBody.indexOf(
      "ValidationException::withMessages(",
      offset,
    );
    if (callIndex < 0) {
      break;
    }

    const openParenIndex = methodBody.indexOf(
      "(",
      callIndex + "ValidationException::withMessages".length,
    );
    const argsBlock =
      openParenIndex >= 0
        ? extractBalanced(methodBody, openParenIndex, "(", ")")
        : null;
    if (!argsBlock) {
      break;
    }

    const firstArg = splitTopLevel(argsBlock.slice(1, -1), ",")[0]?.trim();
    if (firstArg) {
      const parsed = parsePhpExampleValue(firstArg, exampleContext);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        examples.push(parsed as Record<string, unknown>);
      }
    }

    offset = openParenIndex + argsBlock.length;
  }

  return examples;
}

async function extractLaravelHelperResponses(
  methodBody: string,
  classIndex: Map<string, PhpClassRecord>,
  controllerContent: string,
  exampleContext: PhpExampleContext,
  depth: number,
  fileContext?: PhpFileContext,
): Promise<NormalizedResponse[]> {
  const responses: NormalizedResponse[] = [];

  for (const statement of extractReturnStatements(methodBody)) {
    const helperCall = parseLaravelHelperReturnStatement(statement);
    if (!helperCall) {
      continue;
    }

    const helperMethod = findPhpMethod(
      controllerContent,
      helperCall.methodName,
    );
    if (!helperMethod) {
      continue;
    }

    const seedAssignments = new Map(exampleContext.assignments);
    helperMethod.params.forEach((paramName, index) => {
      const argExpression = helperCall.args[index];
      if (argExpression) {
        seedAssignments.set(paramName, argExpression);
      }
    });

    responses.push(
      ...(await extractLaravelResponses(
        helperMethod.body,
        classIndex,
        controllerContent,
        createPhpExampleContext(helperMethod.body, seedAssignments),
        depth + 1,
        fileContext,
      )),
    );
  }

  return dedupeResponsesByStatusCode(responses);
}

function parseLaravelHelperReturnStatement(
  statement: string,
): { methodName: string; args: string[] } | undefined {
  const helperMatch = statement.match(
    /^return\s+(?:\$this->|self::)([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  );
  if (!helperMatch?.[1]) {
    return undefined;
  }

  const openParenIndex = statement.indexOf("(", helperMatch[0].length - 1);
  const argsBlock =
    openParenIndex >= 0
      ? extractBalanced(statement, openParenIndex, "(", ")")
      : null;
  if (!argsBlock) {
    return undefined;
  }

  return {
    methodName: helperMatch[1],
    args: splitTopLevel(argsBlock.slice(1, -1), ","),
  };
}

function hasLaravelNotFoundPattern(methodBody: string): boolean {
  return /\b(?:findOrFail|firstOrFail)\s*\(/.test(methodBody);
}

function extractReturnResponseNoContentCalls(methodBody: string): string[] {
  const results: string[] = [];
  let offset = 0;

  while (offset < methodBody.length) {
    const returnIndex = methodBody.indexOf(
      "return response()->noContent(",
      offset,
    );
    if (returnIndex < 0) {
      break;
    }

    const openParenIndex = methodBody.indexOf(
      "(",
      returnIndex + "return response()->noContent".length,
    );
    const argsBlock =
      openParenIndex >= 0
        ? extractBalanced(methodBody, openParenIndex, "(", ")")
        : null;
    if (!argsBlock) {
      break;
    }

    results.push(argsBlock);
    offset = openParenIndex + argsBlock.length;
  }

  return results;
}

function parseLaravelStatusCode(rawValue?: string): string | undefined {
  if (!rawValue) {
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const statusMap: Record<string, string> = {
    "Response::HTTP_OK": "200",
    "Response::HTTP_CREATED": "201",
    "Response::HTTP_NO_CONTENT": "204",
    "Response::HTTP_BAD_REQUEST": "400",
    "Response::HTTP_UNAUTHORIZED": "401",
    "Response::HTTP_FORBIDDEN": "403",
    "Response::HTTP_NOT_FOUND": "404",
    "Response::HTTP_UNPROCESSABLE_ENTITY": "422",
    "Response::HTTP_INTERNAL_SERVER_ERROR": "500",
  };

  return statusMap[trimmed];
}

function defaultAbortMessage(statusCode: string): string {
  const statusText = defaultStatusTextMap[statusCode];
  return statusText ?? "Request failed";
}

const defaultStatusTextMap: Record<string, string> = {
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "409": "Conflict",
  "422": "Unprocessable Entity",
  "500": "Internal Server Error",
};
