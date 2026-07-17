import { describe, expect, test } from "bun:test";
import { isExcluded, isSensitiveFile, DEFAULT_EXCLUDES } from "../src/hooks/lib/config.ts";

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
