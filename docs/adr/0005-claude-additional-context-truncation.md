# 0005 — Claude Code truncates an oversized additionalContext (probe-verified)

Date: 2026-08-09. Status: accepted. Probed against a live brew-pg install
(51 crank-mem SessionStart injections recorded).

## Findings

Claude Code caps what a hook may return through
`hookSpecificOutput.additionalContext`. Past the cap it does **not** truncate
the text and pass the rest along, and it does not error: it replaces the whole
injection with a short `<persisted-output>` notice and spills the real content
to a file the model is never shown.

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
exits 0, stderr says nothing, and the model sees a ~2.2KB notice it has no
tool to follow up on. The spill file is real and complete, but nothing in the
transcript reads it.

The unit is **bytes of hook stdout**, not tokens, and the cap applies to the
JSON payload, not the raw context — newline escaping and the envelope inflate
it. `injection_budget_bytes` defaults to 8,192 to leave room for both.

## Probe method

Every hook return is recorded in `~/.claude/projects/<project>/*.jsonl` as an
`attachment` record with `attachment.type == "hook_additional_context"`. Parse
those records and match `Output too large \(([\d.]+)KB\)` against
`attachment.content`: matching records are the truncated ones and carry the
spill path, non-matching records carry the full injected text, so both the
threshold and the delivered size are directly measurable. Re-run this after any
Claude Code upgrade — the cap is undocumented and may move.

## Decision

Treat `injection_budget_bytes` as a hard ceiling enforced by
`buildInjection`, and keep it well under the cliff. Concretely:

- The anatomy map is never inlined, only pointed at — inlining it was 74% of
  the injection and the direct cause of the truncated sessions above.
- Every section is dropped whole rather than truncated: a half-list is worse
  than an absent one.
- The one unbounded section (the cerebrum excerpt) is trimmed to the budget
  left after the fixed sections, including a reservation for the ADR list.
- `tests/injection.test.ts` asserts the byte ceiling against a
  realistically-sized cerebrum, so the cliff cannot silently reopen.

Alternative rejected: raising the budget toward the observed cliff. The cap is
undocumented, was measured on one version, and a truncated injection loses
*everything* rather than degrading — the asymmetry argues for headroom.
