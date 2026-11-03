# 0010 — Agents stay unaware of memory upkeep while digests run

Date: 2026-11-03. Status: accepted.

## Context

Before 0.8.0, agents kept crank-mem's memory themselves. The session-start injection carried
the cerebrum, journal and telegram-style protocols, the cerebrum excerpt labelled each section
"append at its end", SubagentStart pointed at `journal.md`, and Stop nudged the agent to record
what it learned (ADR 0004). Digests now write `.crank/memory.db` from the transcript with no
agent effort. The user set the rule for that path:

> "this process should be automatic and the agents using it should be unaware outside of
> searching memories or the injections"

## Decision

- **One gate.** `digestRunning(config, codex, root)` in `src/hooks/lib/spool.ts` is true when
  `config.digest` is true, `<crank home>/digest-state.json` holds no stop state, the
  session is not Codex, and no spool entry for this project has an `updatedAt` and a
  transcript mtime that both lie more than `CAPTURE_STALL_MS` (2 hours) back.
  `readStopState` reads a file whose `reason` is neither `credential` nor `login`, or that
  does not parse, as no stop state.
- **While it is true, nothing model-visible asks an agent to maintain memory.**
  - Session start (`src/hooks/lib/injection.ts` → `composeInjection`) leaves out the
    cerebrum, journal and telegram-style protocols, uses a lead that names no session log
    and no "agent-maintained" memory, and drops the journal section. `injectionSources` does
    not read the journal.
  - The cerebrum excerpt (`excerptOf`) labels its sections by name alone, with no "append at
    its end", and drops the "consolidate" line.
  - SubagentStart (`src/hooks/subagent-start.ts`) drops the journal pointer and calls the
    excerpt "this project's memory", not "agent-kept memory".
  - Stop (`src/hooks/stop.ts`) emits nothing: no cerebrum nudge and no overlap note. It still
    writes the session's spool entry.
- **It overrides ADR 0004 and ADR 0007 while true.** Those govern when it is false, and for
  Codex in every case: Codex has no digests, so its post-write nudge and its full injection
  stay.
- **Reads and upkeep are separate switches.** A readable `memory.db` alone controls the
  `## Recent memory` section, the recall pointer to `search`, `timeline` and `get`, and file
  history (ADR 0009). `## Next steps (last digested session)` takes the newest digest's next
  steps in place of the journal's `NEXT:` handoff, so it shows only while the gate is true,
  the store is readable, and no spool entry for this project waits. While one waits, the
  newest digest belongs to an older session or to another worktree sharing the store.
  `recallApplies(running, status)` also shows the pointer while digests run and no store
  exists yet, since digests will fill it. A project with digests off but a
  store still on disk keeps its recall.
- The protocol text stays byte-identical when the gate is false, so v1 installs see no change.

## Consequences

- The cost: `cerebrum.md` gets no new bullets and `journal.md` stops growing while digests
  run, until consolidation ships. Session start still injects the existing cerebrum excerpt,
  and `src/hooks/lib/journal.ts` → `trimJournal` still trims the journal, since it writes
  nothing to the model.
- A stopped digest (`credential` or `login`) turns the gate false, so the protocols and
  nudges come back until `crank-mem digest resume` clears the stop state.
- A stalled capture turns the gate false, so the protocols and nudges come back until the
  spool drains, and the session-start note says so.
- `src/templates/cerebrum.md` and `src/templates/journal.md` keep their protocol text: an
  agent sees it only by opening the seeded file.
