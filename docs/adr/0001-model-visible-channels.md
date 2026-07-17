# 0001 — Model-visible hook channels (probe-verified)

Date: 2026-07-16. Status: accepted.

## Context

Which hook output channels actually reach the model differs by agent and
version, and public GitHub issues are stale. We live-probed Claude Code
2.1.212 and Codex 0.144.5 (2026-07-16) with instrumented hooks.

## Findings

- `hookSpecificOutput.additionalContext` (stdout JSON, exit 0) is
  model-visible on BOTH agents for SessionStart, PreToolUse, and PostToolUse.
- Pre/PostToolUse hints land alongside the tool result — a hint cannot avert
  the in-flight read it comments on.
- stderr on exit 0 is terminal/debug-only, never model-visible, on both.

## Decision

v1 injects only at SessionStart via `additionalContext`. PostToolUse is used
for silent re-indexing (no context emitted). stderr carries one-line FYIs for
humans only.

## Re-probe method (~5 min when agent versions drift)

Wire a hook that echoes a sentinel via each channel, start a session, ask the
model "what sentinels do you see?". Record versions here.
