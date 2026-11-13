# 0016 — Consolidation cannot read outside its project (probe-verified)

Date: 2026-11-12. Status: accepted.

## Context

Cross-repo memory lets one project's `cerebrum.md` hold a bullet that cites a file in a
linked project, such as `payments-api/src/a.ts`. Consolidation (ADR 0011) rechecks a bullet
whose cited files are missing or changed, with a `claude -p` run whose cwd is the project root
and whose tools are `Read,Grep,Glob`. If that run could read a sibling project by absolute
path, consolidation could recheck cross-repo bullets too. If it cannot, a cross-repo bullet
must never be sent as RECHECK, since the model could only guess.

The question this probe answers: can a project-scoped gateway run, with cwd at project S, read
a sibling directory T by absolute path? And if the cwd moved to the common parent of S and T,
would the deny rules still keep T's secrets out?

## Versions

- Claude Code 2.1.323 (`claude --version`), probed on 2026-11-12.
- bun 1.4.4.
- The model resolved to `claude-haiku-5-5` (provider `firstParty`, `apiKeySource` `none`,
  `permissionMode` `default`, init tools `[Glob, Grep, Read]`).

The probe scripts lived in the planning scratchpad and are not part of this repo.

## Method

The probe made two sibling directories under one temp parent:

- `S/src/notes.txt` holding `S_NOTE_cd01d237`.
- `T/src/notes.txt` holding `T_NOTE_cd01d237`, `T/src/lock.ts` holding
  `// T_LOCK_cd01d237`, `T/.env` holding `VALUE=T_ENV_cd01d237`, and
  `T/config/secrets.json` holding `{"v":"T_SECRET_cd01d237"}`.

It set a temp `CRANK_HOME=$(mktemp -d)` in the shell (not passed to `claude`) and deleted it
afterwards. The child env held only `HOME`, `PATH`, `USER` and `TERM`, as ADR 0015's probe
did.

The argv is the one `src/daemon/gateway.ts` → `callArgs` builds with a `project`, minus
`--system-prompt` and `--json-schema` (as ADR 0015 did):

```
claude -p --model haiku --effort low --tools Read,Grep,Glob --setting-sources "" \
  --settings '{"disableAllHooks":true,"permissions":{"deny":["Read(**/<glob>)", ... one per SENSITIVE_GLOBS entry, incl. "Read(**/.env)", "Read(**/secrets.json)"]}}' \
  --strict-mcp-config --no-session-persistence --max-turns 40 --output-format stream-json --verbose
```

The deny list is `src/hooks/lib/config.ts` → `SENSITIVE_GLOBS` mapped to `Read(<glob>)`, 25
rules. No `--add-dir`. The prompt on stdin asked for a Read of each T file and of
`S/src/notes.txt` by absolute path, a Grep for `T_` in T, and a Glob `**/*` in T.

The probe ran twice with cwd at S, and once with cwd at the common parent of S and T.

## Findings

1. **With cwd at S, nothing in T is readable** (runs 1 and 2, identical outcomes):

   | Call | Outcome |
   |---|---|
   | Read T/src/notes.txt (abs) | refused: `Claude requested permissions to read from <abs path>, but you haven't granted it yet.` |
   | Read T/src/lock.ts | refused, same message |
   | Read T/.env | refused, same message (outside-cwd refusal, not the deny-rule message) |
   | Read T/config/secrets.json | refused, same message |
   | Grep "T_" path T | refused: `Claude requested permissions to read from <abs>/T, but you haven't granted it yet.` |
   | Glob "**/*" path T | refused, same as Grep |
   | Read S/src/notes.txt | ok, `S_NOTE_cd01d237` |

   `permission_denials` listed all six T calls. No T sentinel (NOTE, LOCK, ENV, SECRET)
   reached stdout. Each run ended `success` in 8 turns, at about $0.0027. Read, Grep and Glob
   outside the cwd each need a permission grant that `-p` in default permission mode never
   gives, and that refusal fires before the deny rules come into play.
2. **With cwd at the common parent, T's plain files read and the deny rules still hold:**

   | Call | Outcome |
   |---|---|
   | Read T/src/notes.txt | ok, `T_NOTE_cd01d237` |
   | Read T/src/lock.ts | ok, `T_LOCK_cd01d237` |
   | Read T/.env | denied: `<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>` |
   | Read T/config/secrets.json | denied, same message |
   | Grep "T_" path T | ok: notes.txt and lock.ts lines only; no .env or secrets.json lines |
   | Glob "**/*" path T | ok: `T/src/notes.txt`, `T/src/lock.ts` only |
   | Read S/src/notes.txt | ok |

   `permission_denials` listed only the two secret Reads. `T_ENV_` and `T_SECRET_` never
   reached stdout.

## Decision

- Consolidation keeps cwd at the project root (ADR 0011) and never checks another project's
  files. `src/daemon/consolidate.ts` → `dueBullets` drops every missing or modified citation
  whose first path segment names a linked project before its due test, so a bullet citing only
  linked projects is never sent as RECHECK.
- A cross-repo bullet changes only through a proposal from a digest or through an audit.
- The session-start and SubagentStart excerpts still tag such a citation, from the linked
  project's anatomy read without writing it (`src/hooks/lib/injection.ts` →
  `resolveCitation`), so the agent sees a cross-repo bullet that may be out of date.

## Consequences

- The common-parent cwd is rejected: it would let the run read every repo under the parent,
  uninstalled ones included, whose files no project chose to expose, even though the deny
  rules still block the secret files there (Finding 2).
- A cross-repo bullet can go stale with no consolidation run noticing. The excerpt's tag is
  the only signal until a session proposes a fix.
- Re-probe this call after a Claude Code upgrade, with the steps in `## Re-probe method`
  below. If a later version lets a `-p` run read outside its cwd without a grant, the
  outside-cwd refusal no longer guards T, and only the deny rules do.

## Re-probe method

Re-run these readings whenever `claude --version` changes minor version.

1. In a scratch directory outside any repo, set `CRANK_HOME=$(mktemp -d)` in the shell, and
   make sibling directories S and T under one temp parent, holding the files in `## Method`,
   each with its own sentinel string.
2. Spawn `claude` with cwd at S, the env `HOME`, `PATH`, `USER` and `TERM` only, and the argv
   in `## Method`. On stdin, ask for a Read of each T file and of `S/src/notes.txt` by
   absolute path, a Grep for `T_` with path T, and a Glob `**/*` with path T.
3. Check that every T call is refused with "Claude requested permissions to read from …",
   that `permission_denials` lists all six, that `S/src/notes.txt` read normally, and that no
   T sentinel appears anywhere on stdout. Run it twice.
4. Repeat step 2 once with cwd at the common parent, and check that `T/.env` and
   `T/config/secrets.json` are denied with "File is in a directory that is denied by your
   permission settings." and that `T_ENV_` and `T_SECRET_` never reach stdout.
5. Delete the temp parent, and last the temp `CRANK_HOME`.
