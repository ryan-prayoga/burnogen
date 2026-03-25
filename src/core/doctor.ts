import path from "node:path";

import { detectFramework } from "./framework";
import { findConfigFile } from "./config";
import { fileExists } from "./fs";
import type { BrunogenConfig } from "./model";

export interface DoctorResult {
  lines: string[];
}

export async function runDoctor(cwd: string, config: BrunogenConfig): Promise<DoctorResult> {
  const configPath = await findConfigFile(cwd);
  const detection = await detectFramework(cwd, config.framework);

  const lines = [
    `cwd: ${cwd}`,
    `config: ${configPath ?? "not found (using defaults)"}`,
    `framework: ${detection.framework ?? "not detected"}`,
    `openapi output: ${path.resolve(cwd, config.output.openapiFile)}`,
    `bruno output: ${path.resolve(cwd, config.output.brunoDir)}`,
    `artisan: ${await fileExists(path.join(cwd, "artisan")) ? "yes" : "no"}`,
    `go.mod: ${await fileExists(path.join(cwd, "go.mod")) ? "yes" : "no"}`,
  ];

  for (const warning of detection.warnings) {
    lines.push(`warning: ${warning.message}`);
  }

  return { lines };
}
