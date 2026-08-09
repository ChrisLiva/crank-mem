import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recentJournalBullets, trimJournal, JOURNAL_KEEP, JOURNAL_INJECT_MAX_BYTES,
} from "../src/hooks/lib/journal.ts";

const HEADER = "# Journal\n\nSession log, newest last.\n\n";

/** A crank dir holding exactly this journal text. */
function withJournal(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crank-journal-"));
  fs.writeFileSync(path.join(dir, "journal.md"), text);
  return dir;
}
const inject = (text: string): string[] => recentJournalBullets(withJournal(text));
const only = (entry: string): string => inject(HEADER + entry)[0]!;

describe("injected headlines", () => {
  test("a NEXT: clause that fits is injected whole, no ellipsis", () => {
    expect(only("- 2026-07-30: ran the sweep; NEXT: pick the unaided rule shape.\n"))
      .toBe("- 2026-07-30 — NEXT: pick the unaided rule shape.");
  });

  // The reason the journal exists: the handoff sits in the last quarter of the
  // entry and used to be dropped entirely.
  test("NEXT: is found even when it straddles a line wrap", () => {
    const line = only(
      "- 2026-07-30: rewrote the excerpt, tests green at 41980e5; NEXT: wire the\n" +
        "  drift note into session-start and re-probe brew-pg.\n"
    );
    expect(line).toBe(
      "- 2026-07-30 — NEXT: wire the drift note into session-start and re-probe brew-pg."
    );
    expect(line).not.toContain("\n");
  });

  test("an over-long NEXT: clause is capped with a trailing ellipsis", () => {
    const line = only(`- 2026-07-30: did things; NEXT: ${"item ".repeat(80)}done.\n`);
    expect(line.startsWith("- 2026-07-30 — NEXT: item item")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("done.");
    expect(Buffer.byteLength(line, "utf-8")).toBeLessThanOrEqual(
      JOURNAL_INJECT_MAX_BYTES + Buffer.byteLength("- 2026-07-30 — ", "utf-8")
    );
  });

  test("an entry without NEXT: injects its tail, with a leading ellipsis", () => {
    const line = only(`- 2026-07-30: ${"filler ".repeat(60)}board unchanged, tree clean at 41980e5.\n`);
    expect(line.startsWith("- 2026-07-30 — …")).toBe(true);
    expect(line.endsWith("board unchanged, tree clean at 41980e5.")).toBe(true);
    expect(Buffer.byteLength(line, "utf-8")).toBeLessThanOrEqual(
      JOURNAL_INJECT_MAX_BYTES + Buffer.byteLength("- 2026-07-30 — ", "utf-8")
    );
  });

  test("a short entry without NEXT: is injected whole, no ellipsis", () => {
    expect(only("- 2026-07-30: ran the sweep, board unchanged.\n"))
      .toBe("- 2026-07-30 — ran the sweep, board unchanged.");
  });

  test("a dateless entry gets no date prefix", () => {
    expect(only("- ran the sweep; NEXT: pick the rule shape.\n"))
      .toBe("- NEXT: pick the rule shape.");
    expect(only("- just a note\n")).toBe("- just a note");
  });

  test("sub-bullets and wrapped prose are folded into the one headline", () => {
    const line = only("- 2026-07-30: fixed the parser\n  - dropped sectionBody\n\n  NEXT: bump the cap.\n");
    expect(line).toBe("- 2026-07-30 — NEXT: bump the cap.");
  });

  test("the last three entries are injected, oldest first", () => {
    const bullets = inject(
      HEADER + Array.from({ length: 5 }, (_, i) => `- 2026-07-0${i + 1}: entry ${i}\n`).join("")
    );
    expect(bullets).toEqual([
      "- 2026-07-03 — entry 2",
      "- 2026-07-04 — entry 3",
      "- 2026-07-05 — entry 4",
    ]);
  });

  // The cap is spent in the same unit as the injection budget, so a non-ASCII
  // journal cannot cost 3× an ASCII one — and a cut must never land inside a
  // character.
  test("the cap is bytes and never splits a character", () => {
    for (const entry of [`- 2026-07-30: ${"中".repeat(400)}`, `- 2026-07-30: x; NEXT: ${"🚀".repeat(400)}`]) {
      const line = only(entry + "\n");
      expect(Buffer.byteLength(line, "utf-8")).toBeLessThanOrEqual(
        JOURNAL_INJECT_MAX_BYTES + Buffer.byteLength("- 2026-07-30 — ", "utf-8")
      );
      expect(line).not.toContain("�"); // no lone surrogate half
    }
  });

  test("missing or empty journal yields no bullets", () => {
    expect(recentJournalBullets(fs.mkdtempSync(path.join(os.tmpdir(), "crank-nojournal-")))).toEqual([]);
    expect(inject(HEADER)).toEqual([]);
  });
});

describe("trimJournal", () => {
  test("keeps the newest entries, the header, and a stray heading after them", () => {
    const dir = withJournal(
      HEADER +
        Array.from({ length: JOURNAL_KEEP + 5 }, (_, i) => `- 2026-07-01: entry ${i}\n  detail ${i}\n`).join("") +
        "## Notes\n\nkept verbatim\n"
    );
    const file = path.join(dir, "journal.md");
    trimJournal(dir);

    const after = fs.readFileSync(file, "utf-8");
    expect((after.match(/^- /gm) ?? []).length).toBe(JOURNAL_KEEP);
    expect(after.startsWith(HEADER)).toBe(true);
    expect(after).toContain("- 2026-07-01: entry 5");
    expect(after).toContain("  detail 5"); // continuation rides along
    expect(after).not.toContain("entry 4");
    expect(after.endsWith("## Notes\n\nkept verbatim\n")).toBe(true);
  });

  test("a journal at or under the limit is left byte-identical", () => {
    const text = HEADER + Array.from({ length: JOURNAL_KEEP }, (_, i) => `- entry ${i}\n`).join("");
    const dir = withJournal(text);
    trimJournal(dir);
    expect(fs.readFileSync(path.join(dir, "journal.md"), "utf-8")).toBe(text);
  });

  test("missing journal is a no-op", () => {
    expect(() => trimJournal(fs.mkdtempSync(path.join(os.tmpdir(), "crank-nojournal-")))).not.toThrow();
  });
});
