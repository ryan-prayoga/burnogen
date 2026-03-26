import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/core/config";
import { generateArtifacts } from "../src/core/pipeline";
import { fixturePath } from "./helpers";

describe("Express adapter", () => {
  it("detects Express routes and request schemas", async () => {
    const artifacts = await generateArtifacts(fixturePath("express"), defaultConfig());
    expect(artifacts.normalized.framework).toBe("express");
    expect(artifacts.normalized.projectName).toBe("acme/express-demo");

    const createUser = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/users" && endpoint.method === "post");
    expect(createUser?.auth.type).toBe("bearer");
    expect(createUser?.requestBody?.schema.properties?.name?.type).toBe("string");
    expect(createUser?.requestBody?.schema.properties?.age?.type).toBe("integer");
    expect(createUser?.requestBody?.schema.required).toEqual(expect.arrayContaining(["name", "email"]));
    expect(createUser?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
      schema: expect.objectContaining({ type: "integer" }),
    }));
    expect(createUser?.parameters).toContainEqual(expect.objectContaining({
      name: "X-Trace-Id",
      in: "header",
    }));
    expect(createUser?.parameters.filter((parameter) => parameter.in === "header")).toHaveLength(1);
    expect(createUser?.responses).toContainEqual(expect.objectContaining({
      statusCode: "201",
      example: {
        message: "user created",
        data: {
          id: 1,
          name: "Jane Doe",
          email: "user@example.com",
          age: 18,
          page: 1,
          traceId: "trace_123",
        },
      },
    }));

    const showUser = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/users/{id}" && endpoint.method === "get");
    expect(showUser?.parameters).toContainEqual(expect.objectContaining({
      name: "id",
      in: "path",
    }));
    expect(showUser?.responses).toContainEqual(expect.objectContaining({
      statusCode: "200",
      example: {
        data: {
          id: 1,
          name: "Jane Doe",
        },
      },
    }));

    const login = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/sessions" && endpoint.method === "post");
    expect(login?.requestBody?.schema.required).toEqual(expect.arrayContaining(["email", "password"]));
    expect(login?.responses).toContainEqual(expect.objectContaining({
      statusCode: "200",
      example: {
        token: "secret-token",
        email: "user@example.com",
        password: "secret123",
      },
    }));
    expect(artifacts.warnings).not.toContainEqual(expect.objectContaining({
      code: "EXPRESS_HANDLER_NOT_FOUND",
    }));
  });
});
