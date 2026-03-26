import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/core/config";
import { generateArtifacts } from "../src/core/pipeline";
import { fixturePath } from "./helpers";

describe("Express adapter", () => {
  it("detects nested Express routes, request schemas, auth, and helper responses", async () => {
    const artifacts = await generateArtifacts(fixturePath("express"), defaultConfig());
    expect(artifacts.normalized.framework).toBe("express");
    expect(artifacts.normalized.projectName).toBe("acme/express-demo");
    expect(artifacts.normalized.endpoints.length).toBeGreaterThanOrEqual(10);

    const createUser = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/v1/users" && endpoint.method === "post");
    expect(createUser?.auth.type).toBe("bearer");
    expect(createUser?.requestBody?.schema.properties?.name?.type).toBe("string");
    expect(createUser?.requestBody?.schema.properties?.name?.maxLength).toBe(255);
    expect(createUser?.requestBody?.schema.properties?.email?.format).toBe("email");
    expect(createUser?.requestBody?.schema.properties?.age?.type).toBe("integer");
    expect(createUser?.requestBody?.schema.properties?.age?.minimum).toBe(18);
    expect(createUser?.requestBody?.schema.properties?.role?.enum).toEqual(["user", "admin"]);
    expect(createUser?.requestBody?.schema.properties?.status?.enum).toEqual(["active", "inactive"]);
    expect(createUser?.requestBody?.schema.properties?.price?.type).toBe("number");
    expect(createUser?.requestBody?.schema.properties?.active?.type).toBe("boolean");
    expect(createUser?.requestBody?.schema.properties?.tags?.type).toBe("array");
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
    expect(createUser?.parameters).toContainEqual(expect.objectContaining({
      name: "Authorization",
      in: "header",
    }));
    expect(createUser?.responses).toContainEqual(expect.objectContaining({
      statusCode: "201",
      example: {
        success: true,
        data: expect.objectContaining({
          id: 1,
          name: "Jane Doe",
          email: "user@example.com",
          age: 18,
          page: 1,
          limit: 10,
          price: 1.5,
          active: true,
          tags: [],
          traceId: "trace_123",
          authorization: "Bearer token",
        }),
      },
    }));
    expect(createUser?.responses.map((response) => response.statusCode).sort()).toEqual(expect.arrayContaining(["201", "409", "422"]));

    const showUser = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/v1/users/{id}" && endpoint.method === "get");
    expect(showUser?.parameters).toContainEqual(expect.objectContaining({
      name: "id",
      in: "path",
    }));
    expect(showUser?.responses).toContainEqual(expect.objectContaining({
      statusCode: "200",
      example: {
        data: expect.objectContaining({
          id: 1,
          name: "Jane Doe",
        }),
      },
    }));
    expect(showUser?.responses.map((response) => response.statusCode)).toContain("404");

    const login = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/auth/login" && endpoint.method === "post");
    expect(login?.auth.type).toBe("none");
    expect(login?.requestBody?.schema.required).toEqual(expect.arrayContaining(["email", "password"]));
    expect(login?.responses).toContainEqual(expect.objectContaining({
      statusCode: "200",
      example: {
        token: "secret-token",
        email: "user@example.com",
        password: "secret123",
      },
    }));

    const userPost = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/v1/users/{id}/posts/{postId}" && endpoint.method === "get");
    expect(userPost?.auth.type).toBe("bearer");
    expect(userPost?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", in: "path" }),
      expect.objectContaining({ name: "postId", in: "path" }),
    ]));

    const adminListUsers = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/admin/users" && endpoint.method === "get");
    expect(adminListUsers?.auth.type).toBe("bearer");

    expect(artifacts.warnings).not.toContainEqual(expect.objectContaining({
      code: "EXPRESS_HANDLER_NOT_FOUND",
    }));
  });

  it("supports configurable auth middleware hints for Express", async () => {
    const artifacts = await generateArtifacts(fixturePath("express-custom-auth"), defaultConfig());
    const reports = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/reports" && endpoint.method === "get");

    expect(reports?.auth.type).toBe("none");
    expect(artifacts.warnings).toContainEqual(expect.objectContaining({
      code: "EXPRESS_AUTH_MIDDLEWARE_UNKNOWN",
      message: expect.stringContaining("checkPermission"),
    }));

    const config = defaultConfig();
    config.auth.middlewarePatterns.bearer = ["checkPermission"];

    const configuredArtifacts = await generateArtifacts(fixturePath("express-custom-auth"), config);
    const configuredReports = configuredArtifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/reports" && endpoint.method === "get");

    expect(configuredReports?.auth.type).toBe("bearer");
    expect(configuredArtifacts.warnings).not.toContainEqual(expect.objectContaining({
      code: "EXPRESS_AUTH_MIDDLEWARE_UNKNOWN",
    }));
  });
});
