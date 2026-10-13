# 0005 — Claude Code truncates an oversized additionalContext (probe-verified)

Date: 2026-08-09. Status: accepted. Probed against a live brew-pg install
(51 crank-mem SessionStart injections recorded).

## Findings

Claude Code caps what a hook may return through
`hookSpecificOutput.additionalContext`. Past the cap it does **not** truncate
the text and pass the rest along, and it does not error: it replaces the whole
injection with a short `<persisted-output>` notice and spills the real content
to a file the model is never asked to read.

What the model receives instead is:

```
<persisted-output>
Output too large (10.4KB). Full output saved to:
/Users/chris/.claude/projects/<project>/<session>/tool-results/hook-<id>-<n>-additionalContext.txt
```

Measured, in one project's transcripts:

| | |
| --- | --- |
| injections truncated | 24 of 51 |
| largest injection delivered intact | 9,726 B |
| smallest injection truncated | ~10,035 B (reported as `9.8KB`) |
| bytes actually delivered when truncated | 2,257–2,278 B |

So the cliff sits between 9,726 and ~10,035 bytes — consistent with a
10,000-byte limit — and the failure is silent in both directions: the hook
exits 0, stderr says nothing, and the model sees a ~2.2KB notice that nothing
prompts it to follow up on. The spill file is real and complete, but nothing
in the transcript reads it.

The unit is not tokens. (Amended 2026-10-13: this paragraph first said the cap
counts bytes of the JSON payload, so newline escaping and the envelope inflate
it. That rationale is dropped; see the next section.)

## Documented cap (amended 2026-10-13)

The Claude Code hooks reference (code.claude.com/docs/en/hooks, "JSON output"
and "Add context for Claude", read 2026-10-13) now documents the cap:

- `additionalContext`, `systemMessage` and `initialUserMessage` are each capped
  at 10,000 characters. Claude Code measures each field on its own, even when
  several hooks run for the same event; plain stdout is measured whole.
- An over-cap value is saved to a file in the session directory and replaced
  by the file path plus a preview of up to the first 2,000 characters. Claude
  can read that file, but Claude Code does not ask it to. No setting raises
  the cap.

The cap counts the field's characters, not the JSON envelope, which matches
the measured cliff above (9,726 B intact, ~10,035 B truncated, on mostly-ASCII
text) and the ~2.2 KB delivered notice (the path plus the 2,000-character
preview). `injection_budget_bytes` stays at 8,192: a string's UTF-8 byte
length is never smaller than its character count, so a byte budget under
10,000 holds for any text.

## Probe method

Every hook return is recorded in `~/.claude/projects/<project>/*.jsonl` as an
`attachment` record with `attachment.type == "hook_additional_context"`. Parse
those records and match `Output too large \(([\d.]+)KB\)` against
`attachment.content`: matching records are the truncated ones and carry the
spill path, non-matching records carry the full injected text, so both the
threshold and the delivered size are directly measurable. Re-run this after any
Claude Code upgrade, and re-read the hooks reference: the documented cap may
still move.

## Decision

Treat `injection_budget_bytes` as a hard ceiling enforced by
`composeInjection`, and keep it well under the cliff. Concretely:

- The anatomy map is never inlined, only pointed at — inlining it was 74% of
  the injection and the direct cause of the truncated sessions above.
- Every section is dropped whole rather than truncated: a half-list is worse
  than an absent one.
- The one unbounded section (the cerebrum excerpt) is trimmed to the budget
  left after the fixed sections, including a reservation for the ADR list.
- `tests/injection.test.ts` asserts the byte ceiling against a
  realistically-sized cerebrum, so the cliff cannot silently reopen.

Alternative rejected: raising the budget toward the observed cliff. A truncated
injection loses *everything* past the 2,000-character preview rather than
degrading, and the model is not prompted to read the rest — the asymmetry
argues for headroom. (Amended 2026-10-13: the cap was first described here as
undocumented and measured on one version; the hooks reference now documents
it, and the asymmetry argument stands on its own.)
