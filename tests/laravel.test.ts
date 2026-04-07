import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/core/config";
import { generateArtifacts } from "../src/core/pipeline";
import { fixturePath } from "./helpers";

describe("Laravel adapter", () => {
  it("detects routes, auth, form request rules, and inline validation", async () => {
    const artifacts = await generateArtifacts(fixturePath("laravel"), defaultConfig());

    expect(artifacts.normalized.framework).toBe("laravel");
    expect(artifacts.normalized.endpoints).toHaveLength(6);

    const login = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/login");
    expect(login?.auth.type).toBe("none");
    expect(login?.requestBody?.schema.properties?.email?.format).toBe("email");
    expect(login?.requestBody?.schema.properties?.device_name?.type).toBe("string");
    expect(login?.requestBody?.schema.properties?.remember_me?.type).toBe("boolean");
    expect(login?.requestBody?.schema.properties?.scopes?.type).toBe("array");
    expect(login?.requestBody?.schema.properties?.profile_photo?.type).toBe("boolean");
    expect(login?.requestBody?.schema.properties?.nickname?.type).toBe("boolean");
    expect(login?.requestBody?.schema.properties?.locale?.type).toBe("string");
    expect(login?.requestBody?.schema.properties?.role?.enum).toEqual(["owner", "member"]);
    expect(login?.requestBody?.schema.properties?.tenant_id?.type).toBe("string");
    expect(login?.responses[0]?.statusCode).toBe("201");
    expect(login?.responses[0]?.example).toEqual({
      message: "Logged in",
      token: "demo-token",
      device_name: "ios-simulator",
      remember_me: true,
      scopes: ["read"],
    });

    const loginCheck = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/login/check");
    expect(loginCheck?.requestBody?.schema.properties?.enabled?.type).toBe("boolean");
    expect(loginCheck?.responses).toContainEqual(expect.objectContaining({
      statusCode: "403",
      example: {
        message: "Feature disabled",
      },
    }));
    expect(loginCheck?.responses).toContainEqual(expect.objectContaining({
      statusCode: "422",
      example: {
        message: "The given data was invalid.",
        errors: {
          email: ["The email field is required."],
        },
      },
    }));

    const createUser = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/users" && endpoint.method === "post");
    expect(createUser?.auth.type).toBe("bearer");
    expect(createUser?.requestBody?.schema.properties?.name?.type).toBe("string");
    expect(createUser?.requestBody?.schema.required).toContain("name");
    expect(createUser?.responses[0]?.statusCode).toBe("201");
    expect(createUser?.responses[0]?.schema?.properties?.data?.type).toBe("object");
    expect(createUser?.responses[0]?.example).toEqual({
      message: "User created",
      data: {
        id: 1,
        name: "Jane Doe",
        email: "jane@example.com",
      },
    });

    const listUsers = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/users" && endpoint.method === "get");
    expect(listUsers?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(listUsers?.parameters).toContainEqual(expect.objectContaining({
      name: "TTOKEN",
      in: "header",
    }));
    expect(listUsers?.responses[0]?.example).toEqual({
      data: [
        {
          id: 1,
          name: "Jane Doe",
        },
      ],
      meta: {
        page: 1,
        token: "TTOKEN_VALUE",
      },
    });

    const resourceShow = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/projects/{project}" && endpoint.method === "get");
    const resourceShowSuccess = resourceShow?.responses.find((response) => response.statusCode === "200");
    expect(resourceShow?.parameters).toEqual([
      expect.objectContaining({ name: "project", in: "path" }),
    ]);
    expect(resourceShowSuccess?.schema?.properties?.data?.type).toBe("object");
    expect(resourceShowSuccess?.example).toEqual({
      data: {
        id: 1,
        name: "Launchpad",
        owner_email: "owner@example.com",
      },
      meta: {
        trace_id: "trace_123",
      },
    });
    expect(resourceShowSuccess?.schema?.properties?.meta?.type).toBe("object");
    expect(resourceShow?.responses).toContainEqual(expect.objectContaining({
      statusCode: "404",
      example: {
        message: "Not Found",
      },
    }));
  });

  it("supports multi-line routes and configurable auth middleware hints for Laravel", async () => {
    const artifacts = await generateArtifacts(
      fixturePath("laravel-custom-auth-multiline"),
      defaultConfig(),
    );
    const reports = artifacts.normalized.endpoints.find(
      (endpoint) => endpoint.path === "/api/reports" && endpoint.method === "get",
    );

    expect(reports?.auth.type).toBe("none");
    expect(reports?.responses).toContainEqual(
      expect.objectContaining({
        statusCode: "200",
        example: {
          data: [
            {
              id: 1,
              name: "Daily report",
            },
          ],
        },
      }),
    );
    expect(artifacts.warnings).toContainEqual(
      expect.objectContaining({
        code: "LARAVEL_AUTH_MIDDLEWARE_UNKNOWN",
        message: expect.stringContaining("checkPermission"),
      }),
    );

    const config = defaultConfig();
    config.auth.middlewarePatterns.bearer = ["checkPermission"];

    const configuredArtifacts = await generateArtifacts(
      fixturePath("laravel-custom-auth-multiline"),
      config,
    );
    const configuredReports = configuredArtifacts.normalized.endpoints.find(
      (endpoint) => endpoint.path === "/api/reports" && endpoint.method === "get",
    );

    expect(configuredReports?.auth.type).toBe("bearer");
    expect(configuredArtifacts.warnings).not.toContainEqual(
      expect.objectContaining({
        code: "LARAVEL_AUTH_MIDDLEWARE_UNKNOWN",
      }),
    );
  });

  it("resolves namespaced Laravel controller groups with duplicate short class names", async () => {
    const artifacts = await generateArtifacts(
      fixturePath("laravel-namespaced-groups"),
      defaultConfig(),
    );

    expect(artifacts.normalized.endpoints).toHaveLength(5);

    const apiUsers = artifacts.normalized.endpoints.find(
      (endpoint) => endpoint.path === "/api/users" && endpoint.method === "get",
    );
    expect(apiUsers?.auth.type).toBe("bearer");
    expect(apiUsers?.operationId).toBe("apiUsercontrollerIndex");
    expect(apiUsers?.tags).toEqual(["ApiUser"]);
    expect(apiUsers?.summary).toBe("Api\\UserController::index");
    expect(apiUsers?.responses).toContainEqual(
      expect.objectContaining({
        statusCode: "200",
        example: {
          data: [
            {
              id: 1,
              name: "API Jane",
              email: "api@example.com",
              role: "member",
            },
          ],
        },
      }),
    );

    const apiStoreUser = artifacts.normalized.endpoints.find(
      (endpoint) => endpoint.path === "/api/users" && endpoint.method === "post",
    );
    expect(apiStoreUser?.operationId).toBe("apiUsercontrollerStore");
    expect(apiStoreUser?.requestBody?.schema.properties?.email?.format).toBe("email");
    expect(apiStoreUser?.requestBody?.schema.properties?.role?.enum).toEqual([
      "member",
      "owner",
    ]);
    expect(apiStoreUser?.responses).toContainEqual(
      expect.objectContaining({
        statusCode: "200",
        example: {
          data: {
            id: 2,
            name: "API Owner",
            email: "owner@example.com",
            role: "owner",
          },
          meta: {
            source: "api",
          },
        },
      }),
    );

    const adminStoreUser = artifacts.normalized.endpoints.find(
      (endpoint) =>
        endpoint.path === "/api/admin/users" && endpoint.method === "post",
    );
    expect(adminStoreUser?.operationId).toBe("adminUsercontrollerStore");
    expect(adminStoreUser?.tags).toEqual(["AdminUser"]);
    expect(adminStoreUser?.summary).toBe("Admin\\UserController::store");
    expect(
      adminStoreUser?.requestBody?.schema.properties?.permissions?.type,
    ).toBe("array");
    expect(adminStoreUser?.requestBody?.schema.properties?.role?.enum).toEqual([
      "super-admin",
      "auditor",
    ]);
    expect(adminStoreUser?.responses).toContainEqual(
      expect.objectContaining({
        statusCode: "200",
        example: {
          data: {
            id: 100,
            name: "Security Admin",
            permissions: ["manage-users", "audit-logs"],
          },
        },
      }),
    );

    const status = artifacts.normalized.endpoints.find(
      (endpoint) => endpoint.path === "/api/status" && endpoint.method === "get",
    );
    expect(status?.auth.type).toBe("bearer");
    expect(status?.parameters).toContainEqual(
      expect.objectContaining({
        name: "X-Trace-Id",
        in: "header",
      }),
    );
    expect(status?.responses).toContainEqual(
      expect.objectContaining({
        statusCode: "200",
        example: {
          ok: true,
          trace_id: "trace_123",
        },
      }),
    );
    expect(artifacts.warnings).toEqual([]);
  });
});
