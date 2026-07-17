import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isExcluded, isSensitiveFile, loadConfig, defaultConfig, DEFAULT_EXCLUDES, CONFIG_FILE,
} from "../src/hooks/lib/config.ts";

function dirWithConfig(json: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-config-"));
  fs.writeFileSync(path.join(dir, CONFIG_FILE), json);
  return dir;
}

describe("loadConfig sanitization", () => {
  test("wrong-typed fields fall back to defaults, valid fields kept", () => {
    const dir = dirWithConfig(JSON.stringify({
      excludes: "oops", max_files: "many", injection_budget_tokens: 2000, adr_path: "adr",
    }));
    const config = loadConfig(dir);
    expect(config.excludes).toEqual(DEFAULT_EXCLUDES);
    expect(config.max_files).toBe(defaultConfig().max_files);
    expect(config.injection_budget_tokens).toBe(2000);
    expect(config.adr_path).toBe("adr");
  });

  test("non-finite numbers rejected", () => {
    const dir = dirWithConfig(`{"max_files": 1e999}`);
    expect(loadConfig(dir).max_files).toBe(defaultConfig().max_files);
  });

  test("enum fields reject unknown values", () => {
    const dir = dirWithConfig(JSON.stringify({ git: "rebase", runtime: "deno" }));
    const config = loadConfig(dir);
    expect(config.git).toBe("exclude");
    expect(config.runtime).toBe("bun");
  });

  test("excludes must be an array of strings", () => {
    const dir = dirWithConfig(JSON.stringify({ excludes: ["dist", 42] }));
    expect(loadConfig(dir).excludes).toEqual(DEFAULT_EXCLUDES);
  });

  test("non-object config falls back entirely", () => {
    expect(loadConfig(dirWithConfig(`"just a string"`))).toEqual(defaultConfig());
  });
});

describe("isSensitiveFile", () => {
  test("flags env files, keys, credentials", () => {
    for (const f of [".env", ".env.local", "server.pem", "id_rsa", "id_ed25519.pub",
      "aws-credentials.json", "secrets.yaml", ".npmrc", "app.key", "terraform.tfstate"]) {
      expect(isSensitiveFile(f)).toBe(true);
    }
  });
  test("passes normal files", () => {
    for (const f of ["index.ts", "README.md", "environment.ts", "keyboard.ts"]) {
      expect(isSensitiveFile(f)).toBe(false);
    }
  });
});

describe("isExcluded", () => {
  test("directory segment match", () => {
    expect(isExcluded("node_modules/x/index.js", DEFAULT_EXCLUDES)).toBe(true);
    expect(isExcluded("src/node_modules_helper.ts", DEFAULT_EXCLUDES)).toBe(false);
  });
  test("crank dir always excluded by defaults", () => {
    expect(isExcluded("crank/anatomy.md", DEFAULT_EXCLUDES)).toBe(true);
  });
  test("glob extension match", () => {
    expect(isExcluded("dist2/app.min.js", DEFAULT_EXCLUDES)).toBe(true);
  });
  test("sensitive always excluded even with empty excludes", () => {
    expect(isExcluded("config/.env.production", [])).toBe(true);
  });
});
