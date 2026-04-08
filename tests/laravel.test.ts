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
    expect(createUser?.requestBody?.schema.properties?.status?.enum).toEqual([
      "draft",
      "active",
    ]);
    expect(createUser?.requestBody?.schema.properties?.members?.type).toBe("array");
    expect(createUser?.requestBody?.schema.required).toContain("members");
    expect(
      createUser?.requestBody?.schema.properties?.members?.items?.type,
    ).toBe("object");
    expect(
      createUser?.requestBody?.schema.properties?.members?.items?.required,
    ).toEqual(expect.arrayContaining(["email", "role"]));
    expect(
      createUser?.requestBody?.schema.properties?.members?.items?.properties?.email?.format,
    ).toBe("email");
    expect(
      createUser?.requestBody?.schema.properties?.members?.items?.properties?.role?.enum,
    ).toEqual(["owner", "member"]);
    expect(
      createUser?.requestBody?.schema.properties?.members?.items?.properties?.permissions?.type,
    ).toBe("array");
    expect(
      createUser?.requestBody?.schema.properties?.members?.items?.properties?.permissions?.items?.enum,
    ).toEqual(["read", "write"]);
    expect(createUser?.requestBody?.schema.properties?.profile?.type).toBe("object");
    expect(createUser?.requestBody?.schema.properties?.profile?.nullable).toBe(true);
    expect(
      createUser?.requestBody?.schema.properties?.profile?.required,
    ).toContain("name");
    expect(
      createUser?.requestBody?.schema.properties?.profile?.properties?.timezone?.nullable,
    ).toBe(true);
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

    const listProjects = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/projects" && endpoint.method === "get");
    const listProjectsSuccess = listProjects?.responses.find((response) => response.statusCode === "200");
    expect(listProjects?.tags).toEqual(["Project"]);
    expect(listProjects?.summary).toBe("ProjectController::index");
    expect(listProjects?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(listProjectsSuccess?.schema?.properties?.data?.type).toBe("array");
    expect(listProjectsSuccess?.schema?.properties?.data?.items?.type).toBe("object");
    expect(listProjectsSuccess?.schema?.properties?.meta?.type).toBe("object");
    expect(listProjectsSuccess?.schema?.properties?.links?.type).toBe("object");
    expect(listProjectsSuccess?.schema?.properties?.links?.properties?.first?.type).toBe("string");
    expect(listProjectsSuccess?.schema?.properties?.links?.properties?.last?.type).toBe("string");
    expect(listProjectsSuccess?.schema?.properties?.links?.properties?.prev).toEqual({
      type: "string",
      nullable: true,
    });
    expect(listProjectsSuccess?.schema?.properties?.links?.properties?.next).toEqual({
      type: "string",
      nullable: true,
    });
    expect(listProjectsSuccess?.example).toEqual({
      data: [
        {
          id: 1,
          name: "Jane Doe",
          owner_email: "user@example.com",
        },
      ],
      meta: {
        current_page: 1,
        from: 1,
        last_page: 1,
        per_page: 15,
        to: 1,
        total: 1,
      },
      links: {
        first: "?page=1",
        last: "?page=1",
        next: null,
        prev: null,
      },
    });

    const resourceShow = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/projects/{project}" && endpoint.method === "get");
    const resourceShowSuccess = resourceShow?.responses.find((response) => response.statusCode === "200");
    expect(resourceShow?.parameters).toEqual([
      expect.objectContaining({ name: "project", in: "path" }),
    ]);
    expect(resourceShow?.tags).toEqual(["Project"]);
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

  it("infers simple and cursor paginator resource envelopes", async () => {
    const artifacts = await generateArtifacts(
      fixturePath("laravel-pagination-modes"),
      defaultConfig(),
    );

    expect(artifacts.normalized.framework).toBe("laravel");
    expect(artifacts.normalized.endpoints).toHaveLength(7);

    const simple = artifacts.normalized.endpoints.find(
      (endpoint) => endpoint.path === "/api/projects/simple" && endpoint.method === "get",
    );
    const simpleSuccess = simple?.responses.find((response) => response.statusCode === "200");
    expect(simple?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(simpleSuccess?.schema?.properties?.meta?.properties?.per_page?.type).toBe("integer");
    expect(simpleSuccess?.schema?.properties?.links?.properties?.prev).toEqual({
      type: "string",
      nullable: true,
    });
    expect(simpleSuccess?.schema?.properties?.links?.properties?.next).toEqual({
      type: "string",
      nullable: true,
    });
    expect(simpleSuccess?.example).toEqual({
      data: [
        {
          id: 1,
          name: "Jane Doe",
          owner_email: "user@example.com",
        },
      ],
      meta: {
        current_page: 1,
        from: 1,
        per_page: 10,
        to: 1,
      },
      links: {
        prev: null,
        next: "?page=2",
      },
    });

    const cursor = artifacts.normalized.endpoints.find(
      (endpoint) => endpoint.path === "/api/projects/cursor" && endpoint.method === "get",
    );
    const cursorSuccess = cursor?.responses.find((response) => response.statusCode === "200");
    expect(cursor?.parameters).toContainEqual(expect.objectContaining({
      name: "cursor",
      in: "query",
    }));
    expect(cursorSuccess?.schema?.properties?.meta?.properties?.per_page?.type).toBe("integer");
    expect(cursorSuccess?.schema?.properties?.links?.properties?.prev).toEqual({
      type: "string",
      nullable: true,
    });
    expect(cursorSuccess?.schema?.properties?.links?.properties?.next).toEqual({
      type: "string",
      nullable: true,
    });
    expect(cursorSuccess?.example).toEqual({
      data: [
        {
          id: 1,
          name: "Jane Doe",
          owner_email: "user@example.com",
        },
      ],
      meta: {
        per_page: 5,
      },
      links: {
        prev: "?cursor=prev_cursor",
        next: "?cursor=next_cursor",
      },
    });

    const merged = artifacts.normalized.endpoints.find(
      (endpoint) => endpoint.path === "/api/projects/merged" && endpoint.method === "get",
    );
    const mergedSuccess = merged?.responses.find((response) => response.statusCode === "200");
    expect(merged?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(mergedSuccess?.schema?.properties?.meta?.properties?.current_page?.type).toBe("integer");
    expect(mergedSuccess?.schema?.properties?.meta?.properties?.per_page?.type).toBe("integer");
    expect(mergedSuccess?.schema?.properties?.meta?.properties?.source?.type).toBe("string");
    expect(mergedSuccess?.schema?.properties?.links?.properties?.first?.type).toBe("string");
    expect(mergedSuccess?.schema?.properties?.links?.properties?.last?.type).toBe("string");
    expect(mergedSuccess?.schema?.properties?.links?.properties?.prev).toEqual({
      type: "string",
      nullable: true,
    });
    expect(mergedSuccess?.schema?.properties?.links?.properties?.next).toEqual({
      type: "string",
      nullable: true,
    });
    expect(mergedSuccess?.schema?.properties?.links?.properties?.docs?.type).toBe("string");
    expect(mergedSuccess?.example).toEqual({
      data: [
        {
          id: 1,
          name: "Jane Doe",
          owner_email: "user@example.com",
        },
      ],
      meta: {
        current_page: 1,
        from: 1,
        last_page: 1,
        per_page: 99,
        to: 1,
        total: 1,
        source: "manual",
      },
      links: {
        first: "?page=1",
        last: "?page=1",
        prev: null,
        next: "https://example.test/projects?page=2",
        docs: "https://example.test/docs/pagination",
      },
    });

    const collectionClass = artifacts.normalized.endpoints.find(
      (endpoint) =>
        endpoint.path === "/api/projects/collection-class" && endpoint.method === "get",
    );
    const collectionClassSuccess = collectionClass?.responses.find(
      (response) => response.statusCode === "200",
    );
    expect(collectionClass?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(collectionClassSuccess?.schema?.properties?.data?.type).toBe("array");
    expect(
      collectionClassSuccess?.schema?.properties?.data?.items?.properties?.owner_email?.type,
    ).toBe("string");
    expect(collectionClassSuccess?.schema?.properties?.meta?.properties?.source?.type).toBe("string");
    expect(
      collectionClassSuccess?.schema?.properties?.meta?.properties?.current_page?.type,
    ).toBe("integer");
    expect(collectionClassSuccess?.schema?.properties?.links?.properties?.first?.type).toBe("string");
    expect(collectionClassSuccess?.schema?.properties?.links?.properties?.prev).toEqual({
      type: "string",
      nullable: true,
    });
    expect(collectionClassSuccess?.example).toEqual({
      data: [
        {
          id: 1,
          name: "Jane Doe",
          owner_email: "user@example.com",
        },
      ],
      meta: {
        source: "resource_collection",
        current_page: 1,
        from: 1,
        last_page: 1,
        per_page: 12,
        to: 1,
        total: 1,
      },
      links: {
        first: "?page=1",
        last: "?page=1",
        prev: null,
        next: null,
      },
    });

    const collectionAuto = artifacts.normalized.endpoints.find(
      (endpoint) =>
        endpoint.path === "/api/projects/collection-auto" && endpoint.method === "get",
    );
    const collectionAutoSuccess = collectionAuto?.responses.find(
      (response) => response.statusCode === "200",
    );
    expect(collectionAuto?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(collectionAutoSuccess?.schema?.properties?.data?.type).toBe("array");
    expect(
      collectionAutoSuccess?.schema?.properties?.data?.items?.properties?.slug?.type,
    ).toBe("string");
    expect(
      collectionAutoSuccess?.schema?.properties?.data?.items?.properties?.owner_email?.type,
    ).toBe("string");
    expect(collectionAutoSuccess?.schema?.properties?.meta?.properties?.source?.type).toBe("string");
    expect(
      collectionAutoSuccess?.schema?.properties?.meta?.properties?.per_page?.type,
    ).toBe("integer");
    expect(collectionAutoSuccess?.example).toEqual({
      data: [
        {
          id: 1,
          slug: "project-auto",
          owner_email: "user@example.com",
        },
      ],
      meta: {
        source: "auto_collection",
        current_page: 1,
        from: 1,
        last_page: 1,
        per_page: 8,
        to: 1,
        total: 1,
      },
      links: {
        first: "?page=1",
        last: "?page=1",
        prev: null,
        next: null,
      },
    });

    const collectionMethod = artifacts.normalized.endpoints.find(
      (endpoint) =>
        endpoint.path === "/api/projects/collection-method" && endpoint.method === "get",
    );
    const collectionMethodSuccess = collectionMethod?.responses.find(
      (response) => response.statusCode === "200",
    );
    expect(collectionMethod?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(collectionMethodSuccess?.schema?.properties?.data?.type).toBe("array");
    expect(
      collectionMethodSuccess?.schema?.properties?.data?.items?.properties?.uuid?.type,
    ).toBe("string");
    expect(
      collectionMethodSuccess?.schema?.properties?.data?.items?.properties?.owner_email?.type,
    ).toBe("string");
    expect(collectionMethodSuccess?.schema?.properties?.meta?.properties?.source?.type).toBe("string");
    expect(collectionMethodSuccess?.example).toEqual({
      data: [
        {
          uuid: "project-method-1",
          name: "Jane Doe",
          owner_email: "user@example.com",
        },
      ],
      meta: {
        source: "method_collection",
        current_page: 1,
        from: 1,
        last_page: 1,
        per_page: 6,
        to: 1,
        total: 1,
      },
      links: {
        first: "?page=1",
        last: "?page=1",
        prev: null,
        next: null,
      },
    });

    const collectionWrapped = artifacts.normalized.endpoints.find(
      (endpoint) =>
        endpoint.path === "/api/projects/collection-wrapped" && endpoint.method === "get",
    );
    const collectionWrappedSuccess = collectionWrapped?.responses.find(
      (response) => response.statusCode === "200",
    );
    expect(collectionWrapped?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(collectionWrappedSuccess?.schema?.properties?.data).toBeUndefined();
    expect(collectionWrappedSuccess?.schema?.properties?.items?.type).toBe("array");
    expect(
      collectionWrappedSuccess?.schema?.properties?.items?.items?.properties?.code?.type,
    ).toBe("string");
    expect(
      collectionWrappedSuccess?.schema?.properties?.items?.items?.properties?.owner_email?.type,
    ).toBe("string");
    expect(
      collectionWrappedSuccess?.schema?.properties?.pagination?.properties?.source?.type,
    ).toBe("string");
    expect(collectionWrappedSuccess?.schema?.properties?.meta?.properties?.per_page?.type).toBe("integer");
    expect(collectionWrappedSuccess?.schema?.properties?.links?.properties?.first?.type).toBe("string");
    expect(collectionWrappedSuccess?.example).toEqual({
      items: [
        {
          code: "PRJ-1",
          owner_email: "user@example.com",
        },
      ],
      pagination: {
        source: "wrapped_collection",
      },
      meta: {
        current_page: 1,
        from: 1,
        last_page: 1,
        per_page: 4,
        to: 1,
        total: 1,
      },
      links: {
        first: "?page=1",
        last: "?page=1",
        prev: null,
        next: null,
      },
    });
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
