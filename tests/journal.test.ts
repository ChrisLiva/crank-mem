import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  recentJournalBullets, trimJournal, JOURNAL_KEEP, JOURNAL_NEWEST_MAX_BYTES, JOURNAL_OLDER_MAX_BYTES,
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
/** The `- 2026-07-30 — ` lead-in, which the per-entry caps do not count. */
const PREFIX_BYTES = Buffer.byteLength("- 2026-07-30 — ", "utf-8");

describe("injected headlines", () => {
  test("the newest entry injects what it did and its NEXT: clause, whole", () => {
    expect(only("- 2026-07-30: ran the sweep; NEXT: pick the unaided rule shape.\n"))
      .toBe("- 2026-07-30 — ran the sweep; NEXT: pick the unaided rule shape.");
  });

  test("NEXT: is found even when it straddles a line wrap", () => {
    const line = only(
      "- 2026-07-30: rewrote the excerpt, tests green at 41980e5; NEXT: wire the\n" +
        "  drift note into session-start and re-probe brew-pg.\n"
    );
    expect(line).toBe(
      "- 2026-07-30 — rewrote the excerpt, tests green at 41980e5; " +
        "NEXT: wire the drift note into session-start and re-probe brew-pg."
    );
    expect(line).not.toContain("\n");
  });

  // Shaped after brew-pg 2026-09-23: the handoff alone reached the next
  // session, which then told the user the critique recorded beside it had
  // never been run.
  test("older entries inject what they did, not their stale NEXT: clauses", () => {
    const bullets = inject(
      HEADER +
        "- 2026-09-21: wired the rails; NEXT: run impeccable critique.\n" +
        "- 2026-09-22: impeccable critique (30/40); NEXT: fix the contrast findings.\n" +
        "- 2026-09-23: fixed contrast; NEXT: Chris smoke-checks rails.\n"
    );
    expect(bullets).toEqual([
      "- 2026-09-21 — wired the rails",
      "- 2026-09-22 — impeccable critique (30/40)",
      "- 2026-09-23 — fixed contrast; NEXT: Chris smoke-checks rails.",
    ]);
  });

  test("an over-long NEXT: clause is capped at a word, keeping what the entry did", () => {
    const line = only(`- 2026-07-30: did things; NEXT: ${"item ".repeat(80)}done.\n`);
    expect(line.startsWith("- 2026-07-30 — did things; NEXT: item item")).toBe(true);
    expect(line.endsWith(" item…")).toBe(true);
    expect(line).not.toContain("done.");
    expect(Buffer.byteLength(line, "utf-8")).toBeLessThanOrEqual(JOURNAL_NEWEST_MAX_BYTES + PREFIX_BYTES);
  });

  test("when both clauses are long, each is cut and the handoff still arrives", () => {
    const line = only(`- 2026-07-30: ${"did ".repeat(100)}; NEXT: ${"then ".repeat(100)}\n`);
    expect(line).toMatch(/^- 2026-07-30 — did( did)*…; NEXT: then( then)*…$/);
    // Neither clause crowds the other out.
    for (const part of line.split("; NEXT:")) expect(Buffer.byteLength(part, "utf-8")).toBeGreaterThan(120);
    expect(Buffer.byteLength(line, "utf-8")).toBeLessThanOrEqual(JOURNAL_NEWEST_MAX_BYTES + PREFIX_BYTES);
  });

  test("an entry without NEXT: injects its head, cut at a word", () => {
    const entry = `- 2026-07-30: ${"filler ".repeat(80)}tree clean at 41980e5.\n`;
    const [older, newest] = inject(HEADER + entry + entry);
    for (const [line, cap] of [[older!, JOURNAL_OLDER_MAX_BYTES], [newest!, JOURNAL_NEWEST_MAX_BYTES]] as const) {
      expect(line).toMatch(/^- 2026-07-30 — filler( filler)*…$/);
      expect(Buffer.byteLength(line, "utf-8")).toBeLessThanOrEqual(cap + PREFIX_BYTES);
    }
    expect(Buffer.byteLength(newest!, "utf-8")).toBeGreaterThan(JOURNAL_OLDER_MAX_BYTES + PREFIX_BYTES);
  });

  test("a short entry without NEXT: is injected whole, no ellipsis", () => {
    expect(only("- 2026-07-30: ran the sweep, board unchanged.\n"))
      .toBe("- 2026-07-30 — ran the sweep, board unchanged.");
  });

  test("a dateless entry gets no date prefix", () => {
    expect(only("- ran the sweep; NEXT: pick the rule shape.\n"))
      .toBe("- ran the sweep; NEXT: pick the rule shape.");
    expect(only("- just a note\n")).toBe("- just a note");
  });

  test("an older entry that is only a handoff still injects it", () => {
    expect(inject(HEADER + "- 2026-07-29: NEXT: bump the cap.\n- 2026-07-30: bumped it.\n"))
      .toEqual(["- 2026-07-29 — NEXT: bump the cap.", "- 2026-07-30 — bumped it."]);
  });

  test("sub-bullets and wrapped prose are folded into the one headline", () => {
    const line = only("- 2026-07-30: fixed the parser\n  - dropped sectionBody\n\n  NEXT: bump the cap.\n");
    expect(line).toBe("- 2026-07-30 — fixed the parser - dropped sectionBody; NEXT: bump the cap.");
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
  test("the caps are bytes and never split a character", () => {
    const [older, newest] = inject(
      HEADER + `- 2026-07-29: ${"中".repeat(400)}\n- 2026-07-30: ${"中".repeat(400)}; NEXT: ${"🚀".repeat(400)}\n`
    );
    expect(Buffer.byteLength(older!, "utf-8")).toBeLessThanOrEqual(JOURNAL_OLDER_MAX_BYTES + PREFIX_BYTES);
    expect(Buffer.byteLength(newest!, "utf-8")).toBeLessThanOrEqual(JOURNAL_NEWEST_MAX_BYTES + PREFIX_BYTES);
    expect(newest).toContain("中…; NEXT: 🚀");
    for (const line of [older!, newest!]) expect(line).not.toContain("�"); // no lone surrogate half
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
