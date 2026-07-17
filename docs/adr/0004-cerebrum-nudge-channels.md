# 0004 — Cerebrum-nudge delivery channels (probe-verified)

Date: 2026-07-17. Status: accepted.

## Context

Agents under-recorded to `.crank/cerebrum.md`. Beyond strengthening the
session-start reminder, we wanted an end-of-turn nudge when a session changed
code but never updated cerebrum. That needs a hook channel that reaches the
model *without* breaking the advisory-only invariant (a hook must never block
or force the session to do anything). Which Stop-hook outputs reach the model
is version- and agent-specific, so we probed (extends ADR 0001 to Stop).

## Findings

- **Claude Stop `additionalContext`** (stdout JSON, exit 0) is model-visible.
  Probed 2026-07-17 (Claude Code 2.1.212): the injected sentinel was read back
  verbatim by the model, which then produced one more response acting on it and
  stopped normally — i.e. it continues the turn but does NOT force an open-ended
  continuation the way `decision:"block"` would. On the continuation's own Stop
  event `stop_hook_active` is `true`; guarding on it prevents a loop (crank's
  `stop.ts` does, plus the nudge debounce). Used for the Claude nudge.
- **Codex Stop, probed 2026-07-17 (codex-cli 0.144.5, gpt-5.6-sol):**
  - Output containing `hookSpecificOutput` (a Claude-only field) is rejected
    wholesale — Codex logs `hook: Stop Failed` and injects nothing.
  - `{"systemMessage": "…"}` alone is accepted (`hook: Stop Completed`) but is
    **inert**: the sentinel appeared nowhere — not in the model's context, not
    persisted to the session rollout, not printed to the terminal.
  - The only Codex Stop output that reaches the model is `decision:"block"` +
    `reason`, which forces a continuation turn — an invariant break. Rejected.
- **Codex PostToolUse `additionalContext`** is model-visible and non-blocking
  (ADR 0001, re-confirmed live 2026-07-17 with crank's exact emit shape: after
  an `apply_patch` write the model read back the injected sentinel verbatim).
  Codex writes arrive as `apply_patch`, so the nudge rides the post-write hook.

## Decision

The cerebrum nudge is delivered per agent by its best non-blocking channel:
Claude at turn end via the **Stop** hook; Codex after a write via **post-write**
`additionalContext` (gated on `tool_name === "apply_patch"` so Claude isn't
double-nudged). Shared logic in `lib/cerebrum-nudge.ts` debounces via a marker
(`.crank/cerebrum-nudge.json`, `{cerebrumMtimeMs, nudgedAtChanged}`): one nudge
per cerebrum version, then again only after `NUDGE_STEP` more indexed files
change since cerebrum's mtime. Updating cerebrum resets both signals. The
advisory-only invariant is preserved — no `decision:"block"` anywhere.

## Re-probe method (~10 min when agent versions drift)

Wire a Stop hook that emits distinct sentinels via each candidate channel
(`systemMessage`, `hookSpecificOutput.additionalContext`, stderr) and NO
`decision:"block"`. Run one turn, resume/continue, ask the model which
sentinels it sees; also grep the session rollout for each. Record versions
here. (On Claude the sentinel round-trips within one turn, since Stop
`additionalContext` continues the turn — no explicit second turn needed.)
