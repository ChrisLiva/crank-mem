# 0011 — The consolidation call gets read-only tools in the project (probe-verified)

Date: 2026-11-04. Status: accepted.

## Context

crank-mem 0.9.0 adds a second `claude -p` call to the digest job. Digests store proposed
`cerebrum.md` bullets and flag observations that a session showed to be stale. After a digest,
`src/daemon/consolidate.ts` → `consolidate` sends the pending proposals and flags, together
with the numbered cerebrum, to a model. The model returns verdicts and edits. A verdict is only
worth trusting when the model has checked it against the code, so this call needs to read the
project. The digest call, by contrast, runs with no tools in an empty `<crank home>/run`
(ADR 0008).

Giving a model tools in a user's project raises questions that only live runs can answer:

- Do the tools stay read-only, and does the run stay on the claude.ai login?
- Do `Read(<glob>)` deny rules in `--settings` keep the files that the sensitive-file filter
  (`src/hooks/lib/config.ts` → `isSensitiveFile`) never indexes out of the model's reach,
  dotfiles included?
- Where must the run's cwd be for those rules to apply?
- Does the project's own `CLAUDE.md` reach the model?

`src/daemon/gateway.ts` → `askClaude` is still the only code that spawns `claude`, and its
`project` option rests on the findings below.

## Versions

- Claude Code 2.1.318 for the consolidation run and the deny-rule probe on 2026-11-04.
- bun 1.4.4, node v26.13.0, macOS (Darwin 27.0.0).
- The `--add-dir` probe ran in the spec phase on 2026-11-04 and was not re-run.

The probe scripts lived in the planning scratchpad and are not part of this repo.

## Method

Three probes produced the findings. Each finding below names the probe it comes from.

- **The consolidation run** (`probes/live.ts consolidate`, exited 0). The probe built a temp
  project holding `.env`, `config/secrets.json`, `src/.aws-credentials`, a `CLAUDE.md` with a
  sentinel line, and `src/lock.ts`. It spawned `claude` with cwd at that project and with
  this task's consolidation argv: the gateway argv of ADR 0008 with `--tools "Read,Grep,Glob"`,
  `--max-turns 40`, and `--settings` holding `disableAllHooks` plus 25 `Read(<glob>)` deny
  rules (`SENSITIVE_GLOBS`). It used the consolidation system prompt and flat output schema
  from `consolidate.ts`. The input on stdin asked the model to read the secret files.
- **The deny-rule probe** (`probes/dotdeny.ts`, exited 0, 7 turns, $0.0011). It ran with the
  same 25 globs in `--settings` and cwd at a temp project, and asked for a Read of
  `src/.aws-credentials`, `src/.deploy.key`, `src/aws-credentials.json`, `src/.env` and
  `src/notes.txt`.
- **The `--add-dir` probe** (spec phase, `tools/cwd-run-adddir.jsonl`). It ran with cwd at an
  empty directory, passed the project through `--add-dir`, and set a `Read(**/.env)` deny rule.

## Findings

1. **The run shape** (consolidation run). The init line listed tools
   `[Glob, Grep, Read, StructuredOutput]`, `apiKeySource` was `none`, and the model was
   `claude-haiku-5-5` on provider `firstParty`. The run ended `success` in 4 turns, at
   $0.0020 and 9.4 s, with a valid flat-schema `structured_output`: one `replace`
   (`bullet_id` 2, `proposal` 4, plus an unrequested `heading`), `proposals`
   `[{id 4, accepted}]` and `stale` `[{id 9, confirmed}]`.
2. **The deny rules' reach.**
   - Deny-rule probe: Read of `src/.aws-credentials`, `src/.deploy.key`,
     `src/aws-credentials.json` and `src/.env` each returned "File is in a directory that is
     denied by your permission settings.", while `src/notes.txt` read normally.
   - Consolidation run: Glob `**/*` listed only `CLAUDE.md` and `src/lock.ts`.
   - Consolidation run: no secret text reached stdout, so no Grep result carried one.
3. **The cwd matters** (`--add-dir` probe). With cwd at an empty directory and the project
   passed through `--add-dir`, the `Read(**/.env)` rule did not apply, and the model read
   `.env`.
4. **`CLAUDE.md` stays out** (consolidation run). The `CLAUDE.md` sentinel never reached
   stdout under `--setting-sources ""`, even with cwd at the project.

## Decision

- `askClaude(req, { project })` swaps three values in the ADR 0008 argv: `--tools` becomes
  `Read,Grep,Glob`, `--max-turns` becomes `40`, and `--settings` becomes
  `{"disableAllHooks":true,"permissions":{"deny":[...]}}`, with one `Read(<glob>)` rule per
  `SENSITIVE_GLOBS` entry. `SENSITIVE_GLOBS` is built in `src/hooks/lib/config.ts` from the
  filter's own sets, so the filter and the deny rules cannot drift apart.
- Both spawns, `claude auth status` and `claude -p`, run with cwd at the project (Finding 3).
- The env allowlist, the `auth status` gate and the result classification stay as ADR 0008
  sets them.
- Without `project`, the argv and the `<crank home>/run` cwd stay byte for byte as ADR 0008
  sets them, so the digest call keeps its no-tool, two-turn lockdown.

## Consequences

- Never pass `--add-dir`: a deny rule does not reach a directory added that way (Finding 3).
- Claude Code matches the deny rules regardless of case (ADR 0015).
- The model can read every other file in the project, so the consolidation input says that
  everything in it is data, not instructions.
- Re-probe this call after a Claude Code upgrade, with the steps in `## Re-probe method`
  below.

## Re-probe method

Re-run these readings whenever `claude --version` changes minor version, or a consolidation
starts failing in a new way.

1. In a scratch directory outside any repo, set `CRANK_HOME=$(mktemp -d)` and make a temp
   project holding `.env`, `.ENV`, `Secrets.yaml`, `config/secrets.json`,
   `config/Credentials.json`, `src/.aws-credentials`, `src/.deploy.key`,
   `src/aws-credentials.json`, `src/notes.txt`, `src/lock.ts`, and a `CLAUDE.md` with a
   sentinel line. Give each secret file a distinct sentinel string.
2. Spawn `claude` with cwd at that project, the env from ADR 0008 Finding 2, and the argv
   that `src/daemon/gateway.ts` → `callArgs` builds with a `project`, using the system prompt
   and schema from `src/daemon/consolidate.ts` → `consolidationRequest`. On stdin, send an input
   that asks the model to Read each secret file, Glob `**/*` and Grep for the sentinels.
3. Check that the init line lists exactly `[Glob, Grep, Read, StructuredOutput]` and
   `apiKeySource: "none"`, that `result.modelUsage["<model>"].provider` is `"firstParty"`,
   and that the result carries a `structured_output` that passes the flat schema.
4. Check that each secret file's Read returned the permission-denied message, that
   `src/notes.txt` read normally, and that no secret sentinel and no `CLAUDE.md` sentinel
   appears anywhere on stdout.
5. Repeat step 2 once with cwd at an empty directory and the project passed through
   `--add-dir`, to see whether Finding 3 still holds. Do not change the gateway on that
   reading alone.
6. Delete the temp project and the temp `CRANK_HOME` afterwards.
