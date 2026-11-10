import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { distill } from "../src/daemon/transcript.ts";
import { REPO_ROOT } from "./helpers.ts";

const FIXTURE = path.join(REPO_ROOT, "tests/fixtures/transcript.jsonl");
const EXPECTED = path.join(REPO_ROOT, "tests/fixtures/transcript.expected.txt");
const expectedText = fs.readFileSync(EXPECTED, "utf8");

const pos = (nn: number) => {
  const s = String(nn).padStart(2, "0");
  return { uuid: `u${s}`, timestamp: `2026-01-02T03:04:${s}.000Z` };
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-transcript-"));
  temps.push(dir);
  return dir;
}
/** Writes records as JSONL (newline-terminated), numbering uuid/timestamp from 1. */
function writeTranscript(records: object[]): string {
  const file = path.join(tempDir(), "s1.jsonl");
  const lines = records.map((r, i) => JSON.stringify({ ...pos(i + 1), ...r }));
  fs.writeFileSync(file, lines.map((l) => l + "\n").join(""));
  return file;
}
const userText = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const toolCall = (name: string, input: object, id = "toolu_x") => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const bashCall = (command: string) => toolCall("Bash", { command });

describe("distill on the fixture transcript", () => {
  test("fixtures hold no home path and the expected text is ASCII, untrailed and at least 2,000 characters", () => {
    for (const file of [FIXTURE, EXPECTED]) {
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("/home/");
    }
    expect(/^\p{ASCII}*$/u.test(expectedText)).toBe(true);
    expect(expectedText.endsWith("\n")).toBe(false);
    expect(expectedText.length).toBeGreaterThanOrEqual(2000);
  });

  test("renders the hand-written golden, counts conversation records and points next at the last whole record", () => {
    const d = distill(FIXTURE, null, 400_000);
    expect(d.text).toBe(expectedText);
    expect(d.text.length).toBeGreaterThanOrEqual(2000);
    // 28 user/assistant records, less the isCompactSummary one (u26); the attachment, system,
    // malformed and partial lines are not conversation records.
    expect(d.records).toBe(26);
    expect(d.next).toEqual(pos(29)); // the system record, last whole record
    expect(d.truncated).toBe(false);
  });

  test("a result in a delta keeps its tool name when its call came before after", () => {
    // u06 is the Read call; u07 its result.
    expect(
      distill(FIXTURE, pos(6), 400_000).text.startsWith(
        "[TOOL_RESULT Read] export function sync(opts)",
      ),
    ).toBe(true);
  });

  test("an empty file distills to nothing", () => {
    const file = path.join(tempDir(), "empty.jsonl");
    fs.writeFileSync(file, "");
    expect(distill(file, null, 400_000)).toEqual({
      text: "",
      next: null,
      truncated: false,
      records: 0,
      paths: [],
    });
  });
});

describe("redaction and caps", () => {
  test("redacts before capping, so a secret that shrinks the input under 500 is not cut", () => {
    const command = "x".repeat(460) + " password=" + "h".repeat(40);
    expect(JSON.stringify({ command }).length).toBe(524);
    const d = distill(writeTranscript([bashCall(command)]), null, 400_000);
    expect(d.text).toBe(
      "[TOOL_USE Bash] " + JSON.stringify({ command: "x".repeat(460) + " password=[redacted]" }),
    );
    expect(d.text).not.toContain("hh");
    expect(d.text).not.toContain("chars cut");
  });
});

describe("after", () => {
  const AGENT_RESULT = 18;

  test("covers only records after the saved uuid", () => {
    const d = distill(FIXTURE, pos(AGENT_RESULT), 400_000);
    expect(d.text.startsWith("[ASSISTANT]\nThe planner already returns a change list")).toBe(true);
    expect(expectedText.endsWith(d.text)).toBe(true);
    expect(d.next).toEqual(pos(29));
  });

  test("falls back to later timestamps when the uuid is gone", () => {
    const byUuid = distill(FIXTURE, pos(AGENT_RESULT), 400_000);
    const byTime = distill(
      FIXTURE,
      { uuid: "gone", timestamp: pos(AGENT_RESULT).timestamp },
      400_000,
    );
    expect(byTime).toEqual(byUuid);
  });

  test("after the last record gives nothing", () => {
    expect(distill(FIXTURE, pos(29), 400_000)).toEqual({
      text: "",
      next: null,
      truncated: false,
      records: 0,
      paths: [],
    });
  });
});

describe("maxChars", () => {
  test("cuts at a record boundary", () => {
    const texts = ["a", "b", "c"].map((c) => c.repeat(300));
    const d = distill(writeTranscript(texts.map(userText)), null, 700);
    expect(d).toEqual({
      text: `[USER]\n${texts[0]}\n\n[USER]\n${texts[1]}`,
      next: pos(2),
      truncated: true,
      records: 2,
      paths: [],
    });
  });

  test("sends a single over-limit record alone, cut with a note", () => {
    const text = "q".repeat(1000);
    const d = distill(writeTranscript([userText(text), userText("second")]), null, 500);
    expect(d.text).toBe(`[USER]\n${text}`.slice(0, 500) + "...[507 chars cut]");
    expect(d.truncated).toBe(true);
    expect(d.next).toEqual(pos(1));
  });
});

describe("paths", () => {
  test("collects the delta's tool-call paths once each, in first-seen order", () => {
    const file = writeTranscript([
      toolCall("Read", { file_path: "/r/src/a.ts" }, "t1"),
      toolCall("Grep", { pattern: "x", path: "src" }, "t2"),
      toolCall("NotebookEdit", { notebook_path: "nb.ipynb", new_source: "" }, "t3"),
      toolCall("Bash", { command: "cat src/b.ts src/c.ts" }, "t4"),
      toolCall("Read", { file_path: "/r/src/a.ts" }, "t5"),
    ]);
    expect(distill(file, null, 400_000).paths).toEqual([
      "/r/src/a.ts",
      "src",
      "nb.ipynb",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  test("leaves out paths from records at or before after, and from the record maxChars holds back", () => {
    const readOf = (p: string) => toolCall("Read", { file_path: p }, `read-${p}`);
    const file = writeTranscript([readOf("a.ts"), userText("u"), readOf("b.ts")]);
    expect(distill(file, pos(2), 400_000).paths).toEqual(["b.ts"]);
    const readText = `[TOOL_USE Read] ${JSON.stringify({ file_path: "a.ts" })}`;
    const d = distill(file, null, `${readText}\n\n[USER]\nu`.length); // admits records 1 and 2, not 3
    expect(d.next).toEqual(pos(2));
    expect(d.paths).toEqual(["a.ts"]);
  });
});

describe("subagent transcripts", () => {
  test("reads only the file it is given, never a sibling subagents/ file", () => {
    const file = writeTranscript([userText("main session prompt")]);
    // Beside the file, and in Claude Code's own layout under <session>/subagents/.
    for (const dir of ["subagents", "s1/subagents"]) {
      const sub = path.join(path.dirname(file), dir);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(
        path.join(sub, "agent-a.jsonl"),
        JSON.stringify({ ...pos(2), ...userText("ZEBRAQUOKKA") }) + "\n",
      );
    }
    const d = distill(file, null, 400_000);
    expect(d.text).toBe("[USER]\nmain session prompt");
    expect(d.text).not.toContain("ZEBRAQUOKKA");
  });
});
