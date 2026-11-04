// Episodic memory: `.crank/journal.md`, one dated bullet per entry, newest
// last. Session start no longer reads it; these names remain for the callers
// that still do.

/**
 * The handoff marker. Matched literal-uppercase: the protocol asks for `NEXT:`
 * in exactly this form, and a case-insensitive match would fire on any prose
 * mentioning "next:".
 */
export const NEXT_MARKER = "NEXT:";

export const JOURNAL_FILE = "journal.md";
