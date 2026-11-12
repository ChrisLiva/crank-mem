# 0015 — Claude Code's deny rules ignore case (probe-verified)

Date: 2026-11-12. Status: accepted.

## Context

ADR 0011 gives the consolidation call `Read(<glob>)` deny rules, one per `SENSITIVE_GLOBS`
entry in `src/hooks/lib/config.ts`. Its Consequences claimed that those rules are
case-sensitive, because bun's `path.matchesGlob` matches the same globs case-sensitively,
while `isSensitiveFile` lowercases the name first. On that reading, an uppercase variant such
as `.ENV` or `Secrets.yaml` would escape the deny rules, and only the redaction of the model's
output (`src/daemon/redact.ts`) would guard it.

That claim came from bun's matcher, not from Claude Code. Only a live run can show how Claude
Code itself applies the rules, to mixed-case names and to a case alias on a case-insensitive
file system.

## Versions

- Claude Code 2.1.322 on 2026-11-12.
- bun 1.4.4, macOS on APFS (case-insensitive).

The probe script lived in the planning scratchpad and is not part of this repo.

## Method

The probe `caseprobe.ts` ran from the planning scratchpad. It spawned `claude` with the argv
that `src/daemon/gateway.ts` → `callArgs` builds with a `project`, minus `--system-prompt` and
`--json-schema`, so its deny rules are `Read(<glob>)` for each `SENSITIVE_GLOBS` entry. The
env held only `HOME`, `PATH`, `USER` and `TERM`.

The cwd was a temp project holding `.ENV`, `Secrets.yaml`, `ID_RSA`, `config/Credentials.json`,
`Server.PEM`, `lower/.env` and `src/notes.txt`, each as `VALUE=<its own sentinel>`. The input
asked the model to Read each of those files and `lower/.ENV`, an APFS case alias of
`lower/.env`, then Grep `SENT_` and Glob `**/*`.

## Findings

Exited 0. Init tools `[Glob, Grep, Read]`, apiKeySource `none`. Reads of `.ENV`,
`Secrets.yaml`, `ID_RSA`, `config/Credentials.json`, `Server.PEM`, `lower/.ENV` and
`lower/.env` each returned "File is in a directory that is denied by your permission
settings."; `src/notes.txt` read. Grep `SENT_` returned only `src/notes.txt:1`, Glob `**/*`
only `src/notes.txt`. Every secret sentinel was absent from stdout; 11 turns, $0.0019.

## Decision

- No code change. The deny rules cover mixed-case names and APFS case aliases for Read, Grep
  and Glob, so `SENSITIVE_GLOBS` keeps its lowercase entries.

## Consequences

- Re-probe after a minor Claude Code upgrade, with ADR 0011's `## Re-probe method`.
- That method's temp project now holds the mixed-case files `.ENV`, `Secrets.yaml` and
  `config/Credentials.json`, so each re-probe also checks this finding.
