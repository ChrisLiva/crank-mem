import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "./helpers.ts";

// The bundled crank-mem-audit skill must stay discoverable and installable by
// the vercel-labs skills CLI: SKILL.md at the container path with the
// frontmatter fields the installer reads, plus the Codex invocation policy.

const SKILL_DIR = path.join(REPO_ROOT, "skills", "crank-mem-audit");

/** The frontmatter block's simple `key: value` pairs, no YAML dependency. */
function frontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  expect(match).not.toBeNull();
  const fields: Record<string, string> = {};
  for (const line of match![1]!.split("\n")) {
    const pair = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]!] = pair[2]!;
  }
  return fields;
}

describe("bundled crank-mem-audit skill", () => {
  test("SKILL.md frontmatter satisfies the installer's constraints", () => {
    const fields = frontmatter(fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf-8"));
    expect(fields.name).toBe("crank-mem-audit");
    expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fields.description?.length).toBeGreaterThan(0);
    expect(fields["disable-model-invocation"]).toBe("true");
  });

  test("Codex policy blocks implicit invocation", () => {
    const yaml = fs.readFileSync(path.join(SKILL_DIR, "agents", "openai.yaml"), "utf-8");
    expect(yaml).toContain("allow_implicit_invocation: false");
  });
});
