export type SupportedFramework = "laravel" | "gin" | "fiber" | "echo" | "express";

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options";

export type NormalizedAuthType = "none" | "bearer" | "basic" | "apiKey";

export interface SourceLocation {
  file: string;
  line?: number;
}

export interface GenerationWarning {
  code: string;
  message: string;
  location?: SourceLocation;
}

export interface SchemaObject {
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: Array<string | number | boolean>;
  description?: string;
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  additionalProperties?: boolean | SchemaObject;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  example?: unknown;
}

export interface NormalizedParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: SchemaObject;
  description?: string;
}

export interface NormalizedRequestBody {
  contentType: "application/json" | "application/x-www-form-urlencoded" | "multipart/form-data";
  schema: SchemaObject;
}

export interface NormalizedResponse {
  statusCode: string;
  description: string;
  contentType?: string;
  schema?: SchemaObject;
  example?: unknown;
}

export interface NormalizedAuth {
  type: NormalizedAuthType;
  name?: string;
  in?: "header" | "query" | "cookie";
}

export interface NormalizedEndpoint {
  id: string;
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  parameters: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  responses: NormalizedResponse[];
  auth: NormalizedAuth;
  source: SourceLocation;
  warnings: GenerationWarning[];
}

export interface NormalizedProject {
  framework: SupportedFramework;
  projectName: string;
  projectVersion: string;
  endpoints: NormalizedEndpoint[];
  warnings: GenerationWarning[];
}

export interface EnvironmentConfig {
  name: string;
  variables: Record<string, string>;
}

export interface BrunogenConfig {
  version: 1;
  framework: SupportedFramework | "auto";
  inputRoot: string;
  output: {
    openapiFile: string;
    brunoDir: string;
  };
  project: {
    name?: string;
    version: string;
    serverUrl: string;
  };
  environments: EnvironmentConfig[];
  auth: {
    default: "auto" | NormalizedAuthType;
    bearerTokenVar: string;
    basicUsernameVar: string;
    basicPasswordVar: string;
    apiKeyVar: string;
    apiKeyName: string;
    apiKeyLocation: "header" | "query";
    middlewarePatterns: {
      bearer: string[];
    };
  };
}

export interface GenerateArtifacts {
  normalized: NormalizedProject;
  openApi: Record<string, unknown>;
  warnings: GenerationWarning[];
}
