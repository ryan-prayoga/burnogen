import { describe, expect, it } from "vitest";

import { defaultConfig } from "../src/core/config";
import { generateArtifacts } from "../src/core/pipeline";
import { fixturePath } from "./helpers";

describe("Go adapters", () => {
  it("detects Gin routes and request schemas", async () => {
    const artifacts = await generateArtifacts(fixturePath("gin"), defaultConfig());
    expect(artifacts.normalized.framework).toBe("gin");

    const createUser = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/users" && endpoint.method === "post");
    expect(createUser?.auth.type).toBe("bearer");
    expect(createUser?.requestBody?.schema.properties?.name?.type).toBe("string");
    expect(createUser?.requestBody?.schema.required).toContain("name");
    expect(createUser?.responses).toContainEqual(expect.objectContaining({
      statusCode: "201",
      example: {
        message: "user created",
        data: {
          name: "Jane Doe",
          email: "user@example.com",
          age: 1,
        },
      },
    }));

    const showUser = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/users/{id}");
    expect(showUser?.parameters).toEqual([
      expect.objectContaining({ name: "id", in: "path" }),
    ]);
    expect(showUser?.responses).toContainEqual(expect.objectContaining({
      statusCode: "200",
      example: {
        data: {
          id: 1,
          name: "Jane Doe",
        },
      },
    }));
  });

  it("detects Fiber body and query schemas", async () => {
    const artifacts = await generateArtifacts(fixturePath("fiber"), defaultConfig());
    expect(artifacts.normalized.framework).toBe("fiber");

    const createWidget = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/widgets");
    expect(createWidget?.auth.type).toBe("bearer");
    expect(createWidget?.requestBody?.schema.properties?.name?.type).toBe("string");
    expect(createWidget?.parameters).toContainEqual(expect.objectContaining({
      name: "page",
      in: "query",
    }));
    expect(createWidget?.parameters).toContainEqual(expect.objectContaining({
      name: "TTOKEN",
      in: "header",
    }));
    expect(createWidget?.responses[0]?.example).toEqual(expect.objectContaining({
      code: 200,
      message: "widget created",
    }));
    expect(artifacts.warnings).not.toContainEqual(expect.objectContaining({
      code: "GO_STRUCT_NOT_FOUND",
    }));
    expect(artifacts.warnings).not.toContainEqual(expect.objectContaining({
      code: "GO_HANDLER_NOT_FOUND",
    }));
  });

  it("detects Echo routes and bind schemas", async () => {
    const artifacts = await generateArtifacts(fixturePath("echo"), defaultConfig());
    expect(artifacts.normalized.framework).toBe("echo");

    const createOrder = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/orders");
    expect(createOrder?.auth.type).toBe("bearer");
    expect(createOrder?.requestBody?.schema.properties?.json_customer_id?.type).toBe("string");
    expect(createOrder?.requestBody?.schema.required).toContain("json_customer_id");
    expect(createOrder?.parameters).toContainEqual(expect.objectContaining({
      name: "TTOKEN",
      in: "header",
    }));
    expect(createOrder?.responses).toContainEqual(expect.objectContaining({
      statusCode: "201",
      example: {
        message: "order created",
        data: {
          total: 1,
          customerId: "customer_123",
          token: "TTOKEN_VALUE",
        },
      },
    }));
  });
});
