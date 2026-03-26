import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/core/config";
import { generateArtifacts } from "../src/core/pipeline";
import { fixturePath } from "./helpers";

describe("Laravel adapter", () => {
  it("detects routes, auth, form request rules, and inline validation", async () => {
    const artifacts = await generateArtifacts(fixturePath("laravel"), defaultConfig());

    expect(artifacts.normalized.framework).toBe("laravel");
    expect(artifacts.normalized.endpoints).toHaveLength(5);

    const login = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/login");
    expect(login?.auth.type).toBe("none");
    expect(login?.requestBody?.schema.properties?.email?.format).toBe("email");
    expect(login?.requestBody?.schema.properties?.device_name?.type).toBe("string");
    expect(login?.requestBody?.schema.properties?.remember_me?.type).toBe("boolean");
    expect(login?.requestBody?.schema.properties?.scopes?.type).toBe("array");
    expect(login?.requestBody?.schema.properties?.tenant_id?.type).toBe("string");
    expect(login?.responses[0]?.statusCode).toBe("201");
    expect(login?.responses[0]?.example).toEqual({
      message: "Logged in",
      token: "demo-token",
      device_name: "ios-simulator",
      remember_me: true,
      scopes: ["read"],
    });

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
    expect(resourceShow?.parameters).toEqual([
      expect.objectContaining({ name: "project", in: "path" }),
    ]);
    expect(resourceShow?.responses[0]?.schema?.properties?.data?.type).toBe("object");
    expect(resourceShow?.responses[0]?.example).toEqual({
      data: {
        id: 1,
        name: "Jane Doe",
        owner_email: "user@example.com",
      },
    });
  });
});
