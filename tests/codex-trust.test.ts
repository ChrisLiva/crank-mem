import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { crankHooks, mergeHooksIntoFile } from "../src/cli/settings.ts";
import { trustEntries, trustEntriesFromFile, writeTrustEntries, removeTrustEntries } from "../src/cli/codex-trust.ts";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crank-trust-")), "config.toml");
}

describe("trustEntries", () => {
  const hooks = crankHooks("bun", "codex");
  const entries = trustEntries("/proj/.codex/hooks.json", hooks);

  test("one entry per handler with positional key", () => {
    expect(entries.map((e) => e.key).sort()).toEqual([
      "/proj/.codex/hooks.json:PostToolUse:0:0",
      "/proj/.codex/hooks.json:SessionStart:0:0",
    ]);
  });

  test("hashes are sha256-formatted and deterministic", () => {
    for (const e of entries) expect(e.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(trustEntries("/proj/.codex/hooks.json", hooks)).toEqual(entries);
  });

  test("hash changes when the command changes", () => {
    const other = trustEntries("/proj/.codex/hooks.json", crankHooks("node", "codex"));
    expect(other[0]!.hash).not.toBe(entries[0]!.hash);
  });

  // Pinned against codex-rs rust-v0.144.6 (ADR 0002): sha256 of the compact,
  // recursively key-sorted JSON of the normalized identity, using codex's serde
  // wire names — e.g. for PostToolUse:
  //   {"event_name":"post_tool_use","hooks":[{"async":false,"command":"echo hi",
  //    "timeout":10,"type":"command"}],"matcher":"apply_patch"}
  // A drift here means codex will treat crank's written trusted_hash as stale.
  test("matches codex's exact hash for a known identity", () => {
    const vec = trustEntries("/p/hooks.json", {
      PostToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "echo hi", timeout: 10 }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }], // no timeout ⇒ default 600
    }, () => true);
    expect(vec.find((e) => e.key.includes("PostToolUse"))!.hash)
      .toBe("sha256:7c55a9ad5e95bcfad72bedc1d3c6a75c42ed13550cba8520b9faf4e63017333a");
    expect(vec.find((e) => e.key.includes("SessionStart"))!.hash)
      .toBe("sha256:a245b9b8493f2be82aea06c373ef42709b417c1b701a54e5ab76ab728777f4ad");
  });
});

describe("trustEntriesFromFile", () => {
  test("crank group merged after a pre-existing user group gets its real index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-trust-"));
    const hooksJson = path.join(dir, "hooks.json");
    fs.writeFileSync(hooksJson, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] },
    }, null, 2));
    mergeHooksIntoFile(hooksJson, crankHooks("bun", "codex"));
    const entries = trustEntriesFromFile(hooksJson);
    expect(entries.map((e) => e.key).sort()).toEqual([
      `${hooksJson}:PostToolUse:0:0`,
      `${hooksJson}:SessionStart:1:0`, // after the user's group
    ]);
  });
  test("missing file yields no entries", () => {
    expect(trustEntriesFromFile("/nonexistent/hooks.json")).toEqual([]);
  });
});

describe("write/removeTrustEntries", () => {
  test("appends blocks and removes exactly them", () => {
    const f = tmpFile();
    const original = '[projects."/x"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(f, original);
    const entries = trustEntries("/proj/.codex/hooks.json", crankHooks("bun", "codex"));
    writeTrustEntries(f, entries);
    const written = fs.readFileSync(f, "utf-8");
    expect(written).toContain('[hooks.state."/proj/.codex/hooks.json:SessionStart:0:0"]');
    expect(written).toContain(`trusted_hash = "${entries[0]!.hash}"`);
    removeTrustEntries(f, entries.map((e) => e.key));
    expect(fs.readFileSync(f, "utf-8")).toBe(original);
  });

  test("re-write replaces stale entries for same keys", () => {
    const f = tmpFile();
    const e1 = trustEntries("/proj/.codex/hooks.json", crankHooks("bun", "codex"));
    const e2 = trustEntries("/proj/.codex/hooks.json", crankHooks("node", "codex"));
    writeTrustEntries(f, e1);
    writeTrustEntries(f, e2);
    const content = fs.readFileSync(f, "utf-8");
    expect(content.match(/SessionStart:0:0/g)!.length).toBe(1);
    expect(content).toContain(e2[0]!.hash.startsWith("sha256:") ? e2.find((e) => e.key.includes("SessionStart"))!.hash : "");
  });
});
