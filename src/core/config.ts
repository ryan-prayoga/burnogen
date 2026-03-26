import path from "node:path";
import { promises as fs } from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { BrunogenConfig } from "./model";

const configSchema = z.object({
  version: z.literal(1).default(1),
  framework: z.enum(["auto", "laravel", "gin", "fiber", "echo", "express"]).default("auto"),
  inputRoot: z.string().default("."),
  output: z.object({
    openapiFile: z.string().default(".brunogen/openapi.yaml"),
    brunoDir: z.string().default(".brunogen/bruno"),
  }).default({
    openapiFile: ".brunogen/openapi.yaml",
    brunoDir: ".brunogen/bruno",
  }),
  project: z.object({
    name: z.string().optional(),
    version: z.string().default("1.0.0"),
    serverUrl: z.string().default("{{baseUrl}}"),
  }).default({
    version: "1.0.0",
    serverUrl: "{{baseUrl}}",
  }),
  environments: z.array(z.object({
    name: z.string().min(1),
    variables: z.record(z.string(), z.string()),
  })).default([
    {
      name: "local",
      variables: {
        baseUrl: "http://localhost:8000",
        authToken: "",
      },
    },
  ]),
  auth: z.object({
    default: z.enum(["auto", "none", "bearer", "basic", "apiKey"]).default("auto"),
    bearerTokenVar: z.string().default("authToken"),
    basicUsernameVar: z.string().default("username"),
    basicPasswordVar: z.string().default("password"),
    apiKeyVar: z.string().default("apiKey"),
    apiKeyName: z.string().default("X-API-Key"),
    apiKeyLocation: z.enum(["header", "query"]).default("header"),
    middlewarePatterns: z.object({
      bearer: z.array(z.string().min(1)).default([]),
    }).default({
      bearer: [],
    }),
  }).default({
    default: "auto",
    bearerTokenVar: "authToken",
    basicUsernameVar: "username",
    basicPasswordVar: "password",
    apiKeyVar: "apiKey",
    apiKeyName: "X-API-Key",
    apiKeyLocation: "header",
    middlewarePatterns: {
      bearer: [],
    },
  }),
});

const configFiles = [
  "brunogen.config.json",
  "brunogen.config.yaml",
  "brunogen.config.yml",
];

export function defaultConfig(): BrunogenConfig {
  return configSchema.parse({});
}

export async function findConfigFile(cwd: string): Promise<string | null> {
  for (const candidate of configFiles) {
    const absolutePath = path.join(cwd, candidate);
    try {
      await fs.access(absolutePath);
      return absolutePath;
    } catch {
      continue;
    }
  }

  return null;
}

export async function loadConfig(cwd: string, explicitPath?: string): Promise<{ config: BrunogenConfig; configPath: string | null; }> {
  const configPath = explicitPath ? path.resolve(cwd, explicitPath) : await findConfigFile(cwd);

  if (!configPath) {
    return {
      config: defaultConfig(),
      configPath: null,
    };
  }

  const rawContent = await fs.readFile(configPath, "utf8");
  const parsed = configPath.endsWith(".json")
    ? JSON.parse(rawContent)
    : parseYaml(rawContent);

  return {
    config: configSchema.parse(parsed),
    configPath,
  };
}

export function resolveFromConfigRoot(configPath: string | null, value: string, cwd: string): string {
  const baseDirectory = configPath ? path.dirname(configPath) : cwd;
  return path.resolve(baseDirectory, value);
}

export function renderDefaultConfigFile(): string {
  return `${JSON.stringify(defaultConfig(), null, 2)}\n`;
}
