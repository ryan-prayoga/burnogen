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

    const createUser = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/users" && endpoint.method === "post");
    expect(createUser?.auth.type).toBe("bearer");
    expect(createUser?.requestBody?.schema.properties?.name?.type).toBe("string");
    expect(createUser?.requestBody?.schema.required).toContain("name");

    const resourceShow = artifacts.normalized.endpoints.find((endpoint) => endpoint.path === "/api/projects/{project}" && endpoint.method === "get");
    expect(resourceShow?.parameters).toEqual([
      expect.objectContaining({ name: "project", in: "path" }),
    ]);
  });
});
