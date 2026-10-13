# 0007 — SubagentStart and Codex exec hook channels (probe-verified)

Date: 2026-10-13. Status: accepted.

## Context

The October 2026 crank-mem audit ("the report" below) found that subagents made 77% of
OrcaSlicer's tool calls and none of 445 subagent transcripts carried a crank
injection. It also read, in the installed Claude Code 2.1.296 binary, that SubagentStart
`additionalContexts` become a `hook_additional_context` attachment unless
`isolatedContext` is set. These probes test that channel live, and re-check the Codex
channels crank already uses.

## Versions

- Claude Code 2.1.296 (`claude --version`), run as `claude -p` with `--setting-sources project`.
- Codex CLI 0.162.1 (`codex --version`), run as `codex exec`. The hook payloads report `"model":"gpt-6-astra"`.
- macOS, Darwin 27.0.0.

In the evidence below, `$PROBE` stands for
`/private/tmp/claude-501/-Users-chris-GitHub-crank-mem/04fce5cb-bb02-44f6-bdf6-81b0d2fe19ca/scratchpad/probes`.

## Findings

### Claude Code SubagentStart

1. SubagentStart `hookSpecificOutput.additionalContext` reaches the subagent model. Four subagent types each read back their own sentinel: `general-purpose`, `Explore`, `Plan` and `workflow-subagent`.
2. It does not reach the parent. In both runs the parent reported `OWN: NONE`, and the parent transcripts hold zero `hook_additional_context` records and zero sentinel strings.
3. `$CLAUDE_PROJECT_DIR` expands in a SubagentStart command. The hook written as `"$CLAUDE_PROJECT_DIR"/.claude/hook.sh` ran and logged `CLAUDE_PROJECT_DIR=$PROBE/claude-subagent`.
4. A matcher on `agent_type` filters which hooks run. Each subagent got only the sentinel of the hook whose matcher named its type. The no-matcher hook fired once per subagent. The anchored regex `^(general-purpose|Plan)$` matched `Plan` and did not match `workflow-subagent`.
5. Workflow-tool agents fire SubagentStart with `agent_type: "workflow-subagent"`.
6. SessionStart does not fire inside subagents. Run 1 spawned two subagents and logged exactly one SessionStart, from the parent at startup. This matches the report's finding from the 445 OrcaSlicer transcripts.
7. The transcript records the injection as two attachments in the subagent's own JSONL: a `hook_success` record holding the raw stdout, then `{"type":"hook_additional_context","content":[...]}`. This is the shape the report found in the 2.1.296 binary.
8. The SubagentStart payload has no `permission_mode`, no `source` and no prompt text. `session_id` and `transcript_path` name the parent session. `agent_id` names the subagent transcript `subagents/agent-<agent_id>.jsonl`, or `subagents/workflows/wf_*/agent-<agent_id>.jsonl` for workflow agents.

### OrcaSlicer subagent mix (the agent_type matcher)

9. The report's 410 OrcaSlicer subagent transcripts are 392 `agent-*.jsonl` transcripts plus 18 workflow `journal.jsonl` files, which are not transcripts.
10. Every one of the 392 has a `.meta.json` with `agentType`. Of the 392, 384 read source code:

| agentType | Spawned by | Count | Read source | Edited files | Source `Read` calls | Source reads through Bash |
|---|---|---:|---:|---:|---:|---:|
| `workflow-subagent` | Workflow tool | 204 | 196 | 54 | 324 | 4,415 |
| `general-purpose` | Agent tool | 150 | 150 | 70 | 231 | 3,350 |
| `Explore` | Agent tool | 29 | 29 | 0 | 246 | 743 |
| `Plan` | Agent tool | 9 | 9 | 0 | 9 | 238 |

The parent transcripts' Agent tool inputs agree on the first two types. They hold 130 `subagent_type: "general-purpose"` calls plus 20 calls with no `subagent_type`, which default to general-purpose, for 150 in all. They also hold 29 `Explore` calls and 1 `Plan` call, plus 19 `Workflow` calls. The 8 other Plan transcripts have no matching Agent call in a top-level parent transcript.

11. The report says 104 transcripts got cerebrum through the orchestrator's prompt. On today's disk, 102 transcripts mention `cerebrum` anywhere, 24 first prompts name cerebrum, and 192 first prompts mention `.crank`. 83 transcripts mention `.crank/cerebrum.md` and contain a Read call. That last count does not check that the Read call opened cerebrum.md.

### Codex 0.162.1 under `codex exec`

12. SessionStart `additionalContext` reaches the model. The rollout records it as a developer-role message tagged `content_item_kinds: ["hooks.additional_context"]`, and the model quoted the sentinel back exactly.
13. PostToolUse fires with matcher `apply_patch` when the model edits a file. It delivers `tool_name: "apply_patch"` and `tool_input: {"command": "<patch text>"}`. The model calls the tool through Codex's code-mode `exec` custom tool (`await tools.apply_patch("...")`), and the hook still sees `apply_patch`. The PostToolUse `additionalContext` reached the model as a developer message, and the model quoted it back exactly.
14. In patch text, `*** Add File:` and `*** Update File:` now carry absolute paths. Crank already handles this: `rel()` in `src/hooks/post-write.ts` resolves absolute paths, and `tests/post-write.test.ts:88` covers the case.
15. The payload also carries `tool_response` (a string), `tool_use_id` (`exec-<uuid>`), `turn_id`, `model` and `permission_mode`. SessionStart carries `source: "startup"` and no `turn_id`. Shell reads arrive as `tool_name: "Bash"` with `{"command":"cat README.md"}`, as ADR 0003 records.
16. Codex does not set `CLAUDE_PROJECT_DIR` for hooks. The variable was unset, and the hook's working directory was the project root.
17. Run 1 framed the sentinels as "markers" and asked the model to report them. The model refused with "I can’t provide hidden instruction markers", although the rollout shows both developer messages arrived. Run 2 phrased the same channel as a shareable project fact, and the model quoted both sentinels. A Codex visibility probe needs the second phrasing.
18. Codex wrote the per-invocation override `-c projects."<dir>".trust_level="trusted"` into `~/.codex/config.toml` as a `[projects."<dir>"]` block. This probe did not separate whether the `-c` flag or `--dangerously-bypass-hook-trust` caused the write. Codex wrote no `hooks.state` entries. I removed the block, and the file's sha256 now matches its pre-probe value, `9f2e1cea…62a10`.
19. `codex exec` blocks on "Reading additional input from stdin..." when stdin is an open pipe. Run it with `< /dev/null`.

### The Sep 21 OrcaSlicer main-thread miss

20. The cause is undetermined. The established facts follow.
    - On Sep 21 the main thread and its 6 sub-agent rollouts ran Codex Desktop `0.155.0-alpha.9.2` (originator `Codex Desktop`, source `vscode`). None of the 7 rollouts holds a `hooks.additional_context` record.
    - None of the 30 OrcaSlicer Codex rollouts from Sep 2 to Sep 21 holds such a record. Those rollouts ran 0.151.0, 0.153.1, 0.153.4 and 0.155.0-alpha.9.2.
    - The first record appears on Sep 30, under Desktop 0.159.2. It is crank's `## crank-mem (project memory)` SessionStart injection.
    - `OrcaSlicer/.codex/hooks.json` dates from Sep 17, and the vendored hooks from Sep 10.
    - Today the `hooks.state` hashes in `~/.codex/config.toml` match `trustEntriesFromFile()` for that hooks.json. No record shows when those entries were written.
    - `~/.codex/logs_2.sqlite` only covers Oct 5.
    - Two hypotheses remain, and the evidence cannot separate them: hooks were untrusted on Sep 21, or the alpha Desktop build did not run hooks.
    - The 12 sub-agent misses therefore do not show a sub-agent gap.

## Method

### Probe 1: Claude SubagentStart

The temp project was `$PROBE/claude-subagent`, a git repo with `.claude/hook.sh`. That script appends stdin to `logs/<TAG>.stdin.jsonl` and logs `$0`, `$CLAUDE_PROJECT_DIR` and `pwd`. When given a sentinel, it prints:

```
{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"Hook marker for this agent: <SENTINEL>"}}
```

Run 1 used this `.claude/settings.json`:

```json
{ "hooks": {
  "SubagentStart": [
    { "matcher": "general-purpose", "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hook.sh GP SENT_GP_7731" } ] },
    { "matcher": "Explore", "hooks": [ { "type": "command", "command": "$PROBE/claude-subagent/.claude/hook.sh EXPLORE SENT_EXPLORE_4409" } ] },
    { "hooks": [ { "type": "command", "command": "$PROBE/claude-subagent/.claude/hook.sh ALL" } ] } ],
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "$PROBE/claude-subagent/.claude/hook.sh SESSIONSTART" } ] } ] } }
```

The run 1 command was `claude -p --setting-sources project --allowedTools "Agent,Task,Read,Glob,Grep" --output-format json "<prompt>"`.

- The prompt told the parent to spawn one `general-purpose` subagent and one `Explore` subagent, each with the instruction "find strings beginning with SENT_ in your context, call no tools, reply with each written BACKWARDS".
- It then told the parent to list every SENT_ string in its own context, excluding subagent results.
- Reversal makes the two sources distinguishable. A forward sentinel in the parent's answer could only come from the parent's own context.

Run 2 replaced the SubagentStart hooks with three entries:
- `"matcher": "workflow-subagent"`, which emits `SENT_WF_5150`;
- `"matcher": "^(general-purpose|Plan)$"`, which emits `SENT_RX_8080`;
- a no-matcher logger.

The run 2 prompt spawned one `Plan` subagent through the Agent tool and one agent through a one-step `Workflow`. It also added `Workflow,Skill,Write` to `--allowedTools`.

I then grepped every transcript under `~/.claude/projects/-private-tmp-...-probes-claude-subagent/` for each sentinel.

### Probe 2: OrcaSlicer subagent census

The census script is `$PROBE/orca/types.py`. It walks `~/.claude/projects/-Users-chris-GitHub-OrcaSlicer/**/agent-*.jsonl` and takes `agentType` from each sibling `.meta.json`. It counts a transcript as reading source when it has:
- a `Read` whose `file_path` ends in a source extension (`.c/.cpp/.h/.hpp/.py/.ts/.js/.cmake/...` or `CMakeLists.txt`); or
- a `Bash` call that runs `cat/sed/head/tail/rg/grep/awk/nl` on such a path or under `src/`.

A second pass counted `Agent`/`Task` tool_use `subagent_type` values and `Workflow` calls in the parent transcripts.

### Probe 3: Codex hooks

The temp project was `$PROBE/codex-hooks`, a git repo with one commit of `README.md`. Its `.codex/hooks.json` follows:

```json
{ "hooks": {
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "$PROBE/codex-hooks/.codex/hook.sh SS SessionStart SENT_CX_SS_3141", "timeout": 10 } ] } ],
  "PostToolUse": [
    { "matcher": "apply_patch", "hooks": [ { "type": "command", "command": "$PROBE/codex-hooks/.codex/hook.sh PT_AP PostToolUse SENT_CX_PT_2718", "timeout": 10 } ] },
    { "hooks": [ { "type": "command", "command": "$PROBE/codex-hooks/.codex/hook.sh PT_ALL PostToolUse", "timeout": 10 } ] } ] } }
```

The command was:

```
codex exec -C "$PROBE/codex-hooks" -c 'projects."$PROBE/codex-hooks".trust_level="trusted"' \
  --dangerously-bypass-hook-trust -s workspace-write --json -o logs/lastN.txt "<prompt>" < /dev/null
```

- Two per-invocation flags supplied trust, so the probe did not have to hand-edit `~/.codex/config.toml`. `-c projects."<dir>".trust_level="trusted"` covers project trust, and `--dangerously-bypass-hook-trust` covers hook trust.
- I hashed `config.toml` before the runs and after, and found the change recorded in finding 18.
- Run 1 asked for the "SENT_ markers" reversed, then for creating `hello.txt` with apply_patch.
- Run 2 replaced the hook text with shareable facts:
  - SessionStart: "Project memory (shareable with the user): this repository's build codename is SENT_CX_SS_3141."
  - PostToolUse: "...the file you just wrote was filed under index ticket SENT_CX_PT_2718."
- Run 2 asked for the codename, then an apply_patch edit of `README.md`, then the ticket.
- I read the rollouts named by each payload's `transcript_path`.

## Raw evidence

### Claude: SubagentStart stdin, verbatim (run 1, general-purpose)

```json
{"session_id":"5195319c-93a4-4a7b-844d-51fbe9874f39","transcript_path":"/Users/chris/.claude/projects/-private-tmp-claude-501--Users-chris-GitHub-crank-mem-04fce5cb-bb02-44f6-bdf6-81b0d2fe19ca-scratchpad-probes-claude-subagent/5195319c-93a4-4a7b-844d-51fbe9874f39.jsonl","cwd":"/private/tmp/claude-501/-Users-chris-GitHub-crank-mem/04fce5cb-bb02-44f6-bdf6-81b0d2fe19ca/scratchpad/probes/claude-subagent","prompt_id":"1e84aeb8-be70-42e6-8892-48625ab6934b","agent_id":"aad3ad910b75b309e","agent_type":"general-purpose","hook_event_name":"SubagentStart"}
```

The other payloads had the same shape and differed only in `agent_id` and `agent_type`:
- run 1: `"agent_id":"a8331c61cc8510d8a","agent_type":"Explore"`;
- run 2: `"agent_id":"ac1ec690ce0779eec","agent_type":"Plan"` and `"agent_id":"a1a999ecea566967c","agent_type":"workflow-subagent"`.

### Claude: the model's answers

Run 1 parent (session `5195319c-93a4-4a7b-844d-51fbe9874f39`):

```
- general-purpose: `1377_PG_TNES`
- Explore: `9044_EROLPXE_TNES`
**(b) My own context:** OWN: NONE.
```

Run 2 parent (session `64a9a733-9a39-4cc5-8082-e6dc309aa273`):

```
- **Plan:** `0808_XR_TNES`
- **Workflow:** `0515_FW_TNES`
**(b) OWN: NONE.**
```

### Claude: hook invocation counts and environment

| Run | Hook | Invocations | agent_type |
|---|---|---:|---|
| 1 | ALL (no matcher) | 2 | general-purpose, Explore |
| 1 | GP (`general-purpose`) | 1 | general-purpose |
| 1 | EXPLORE (`Explore`) | 1 | Explore |
| 1 | SESSIONSTART | 1 | parent startup only |
| 2 | ALL (no matcher) | 2 | Plan, workflow-subagent |
| 2 | RX (`^(general-purpose\|Plan)$`) | 1 | Plan |
| 2 | WF (`workflow-subagent`) | 1 | workflow-subagent |

`GP.env.txt` from the `"$CLAUDE_PROJECT_DIR"/...` hook: `CLAUDE_PROJECT_DIR=$PROBE/claude-subagent pwd=$PROBE/claude-subagent`.

### Claude: transcript records

Each sentinel appears only in its own subagent transcript, in this pair of records from `5195319c-.../subagents/agent-aad3ad910b75b309e.jsonl`:

```json
{"type":"attachment","attachment":{"type":"hook_success","hookName":"SubagentStart:general-purpose","hookEvent":"SubagentStart","stdout":"{\"hookSpecificOutput\":{\"hookEventName\":\"SubagentStart\",\"additionalContext\":\"Hook marker for this agent: SENT_GP_7731\"}}\n","exitCode":0,"command":"\"$CLAUDE_PROJECT_DIR\"/.claude/hook.sh GP SENT_GP_7731","durationMs":19}}
{"type":"attachment","attachment":{"type":"hook_additional_context","content":["Hook marker for this agent: SENT_GP_7731"],"hookName":"SubagentStart","hookEvent":"SubagentStart"}}
```

Sentinel counts per file:

| Sentinel | Parent transcript | Own subagent transcript | Other subagent transcript |
|---|---:|---:|---:|
| SENT_GP_7731 | 0 | 2 | 0 |
| SENT_EXPLORE_4409 | 0 | 2 | 0 |
| SENT_RX_8080 | 0 | 1 (Plan) | 0 |
| SENT_WF_5150 | 0 | 1 (`subagents/workflows/wf_ec9f76e8-b31/agent-a1a999ecea566967c.jsonl`) | 0 |

`hook_additional_context` records in the parent transcripts: 0 in `5195319c-....jsonl` and 0 in `64a9a733-....jsonl`.

### Codex: PostToolUse stdin, verbatim (run 2, matcher `apply_patch`)

```json
{"session_id":"01a13615-d687-7521-a2b6-495f2008ca34","turn_id":"01a13615-d8ce-7fd0-865f-6ccd43fb7cd9","transcript_path":"/Users/chris/.codex/sessions/2026/10/13/rollout-2026-10-13T11-26-03-01a13615-d687-7521-a2b6-495f2008ca34.jsonl","cwd":"/private/tmp/claude-501/-Users-chris-GitHub-crank-mem/04fce5cb-bb02-44f6-bdf6-81b0d2fe19ca/scratchpad/probes/codex-hooks","hook_event_name":"PostToolUse","model":"gpt-6-astra","permission_mode":"bypassPermissions","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: /private/tmp/claude-501/-Users-chris-GitHub-crank-mem/04fce5cb-bb02-44f6-bdf6-81b0d2fe19ca/scratchpad/probes/codex-hooks/README.md\n@@\n-seed\n+seeded\n*** End Patch"},"tool_response":"Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM /private/tmp/claude-501/-Users-chris-GitHub-crank-mem/04fce5cb-bb02-44f6-bdf6-81b0d2fe19ca/scratchpad/probes/codex-hooks/README.md\n","tool_use_id":"exec-936ae7e3-0e90-4085-ac40-8b986a7fa6ff"}
```

Run 1's apply_patch payload had the same shape with `*** Add File: <abs>/hello.txt\n+hi`.

### Codex: SessionStart stdin, verbatim (run 1)

```json
{"session_id":"01a1360b-adec-7642-bebd-1043077ee6c4","transcript_path":"/Users/chris/.codex/sessions/2026/10/13/rollout-2026-10-13T11-14-58-01a1360b-adec-7642-bebd-1043077ee6c4.jsonl","cwd":"/private/tmp/claude-501/-Users-chris-GitHub-crank-mem/04fce5cb-bb02-44f6-bdf6-81b0d2fe19ca/scratchpad/probes/codex-hooks","hook_event_name":"SessionStart","model":"gpt-6-astra","permission_mode":"bypassPermissions","source":"startup"}
```

### Codex: catch-all PostToolUse tool names

The catch-all hook saw three tool names across the two runs:
- run 1: `apply_patch` (Add File);
- run 2: `Bash` (`cat README.md`), then `apply_patch` (Update File), then `Bash` (`cat README.md`).

### Codex: rollout records (run 2, `rollout-2026-10-13T11-26-03-01a13615-...jsonl`)

```
HOOKCTX developer Project memory (shareable with the user): this repository's build codename is SENT_CX_SS_3141.
CALL exec text(await tools.exec_command({cmd:"cat README.md","max_output_tokens":1000}));
CALL exec text(await tools.apply_patch("*** Begin Patch\n*** Update File: <abs>/README.md\n@@\n-seed\n+seeded\n*** End Patch"));
HOOKCTX developer Project index note (shareable with the user): the file you just wrote was filed under index ticket SENT_CX_PT_2718.
```

The run 1 rollout shows the same developer messages at ordinals 8 and 18, each with `"content_item_kinds": ["hooks.additional_context"]`.

### Codex: the model's answers

Run 1 (`-o logs1/last1.txt` and rollout ordinal 14):

```
BEFORE: I can’t provide hidden instruction markers.
AFTER: I can’t provide hidden instruction markers.
```

Run 2 (`-o logs/last2.txt`):

```
1) The build codename is “SENT_CX_SS_3141”.
2) I used apply_patch to change README.md and verified its single line reads `seeded`.
3) The index ticket is “SENT_CX_PT_2718”.
```

### Codex: `~/.codex/config.toml`

- Before the runs: `9f2e1ceac038803b2948acffdef948ca92bd72ce4d446be47a5bd7423d362a10`.
- After the runs: `6c659f80dfeb30c6d501b5c72bce775f4c816a65886dc6471e6366e64cdf3d0a`, with mtime 11:14, the time of run 1.
- The diff was exactly this block:

```
[projects."/private/tmp/claude-501/-Users-chris-GitHub-crank-mem/04fce5cb-bb02-44f6-bdf6-81b0d2fe19ca/scratchpad/probes/codex-hooks"]
trust_level = "trusted"
```

- I removed that block, and the hash is back to `9f2e1cea...62a10`.

## Conclusions

1. Crank can inject memory into Claude subagents through SubagentStart `additionalContext`.
   - The parent does not see the injection, so it does not double up with SessionStart.
   - SessionStart never fires in subagents, so SubagentStart is the only hook channel into them.
   - `$CLAUDE_PROJECT_DIR` expands, so crank's existing `"$CLAUDE_PROJECT_DIR"/.crank/hooks/...` command form (`commandParts` in `src/cli/settings.ts`) works for this event.
2. The recommended matcher is `^(general-purpose|Explore|Plan|workflow-subagent)$`.
   - These four types are every type that appears in OrcaSlicer's 392 subagent transcripts.
   - 384 of the 392 read source code. Explore and Plan read source in every transcript (29/29 and 9/9) and never edit, so they gain most from a map of the code.
   - The anchored allowlist rejects any other type. This probe did not enumerate other types; examples would be custom agents from `.claude/agents` or plugin agents.
   - On OrcaSlicer's month the filter excludes 0 of 392 spawns, so it does not cut volume there. At 2 KB per spawn the cost is about 784 KB of injected context across those 392 spawns.
   - If the injection needs to cut volume, the type filter cannot do it. A per-session cap or a smaller excerpt would.
3. Nested subagents (`spawnDepth` 2 and above) were not probed.
4. On Codex 0.162.1 under `codex exec`, SessionStart and PostToolUse `additionalContext` both reach the model as developer messages. PostToolUse fires for `apply_patch` with the ADR 0003 payload shape, including when the call goes through code-mode `exec`. Crank's current Codex wiring needs no change.
5. Two Codex probe-method notes for future re-probes.
   - Phrase sentinels as shareable facts, not hidden markers.
   - Expect `-c projects."<dir>".trust_level` to persist into the user `config.toml`. Hash the file before the run, and remove the block afterwards.
6. The Sep 21 OrcaSlicer miss belongs to all of that day's Codex Desktop alpha sessions, not to sub-agents. It needs no sub-agent-specific Codex work. Desktop 0.159.2 delivered the injection on Sep 30.

## Decision

- Claude: `crank-mem init` and `upgrade` wire `SubagentStart` to `.crank/hooks/subagent-start.ts`
  with the matcher `^(general-purpose|Explore|Plan|workflow-subagent)$`
  (`SUBAGENT_MATCHER` in `src/cli/settings.ts`). The hook injects `cerebrumExcerpt` at a
  2,048-byte budget plus a pointer to `cerebrum.md` and `journal.md`. It does not refresh
  the index, because the parent's SessionStart already did.
- The excerpt keeps its own priority, user preferences ahead of memory. At 2,048 bytes the
  2026-10-13 cerebrums of OrcaSlicer and takeoff-poc yield preferences only, 4 of 7 and 5
  of 5, and no memory bullets; brew-pg yields 10 preferences and 2 memory bullets.
- Codex: no change.

## Re-probe method (~15 min)

- Claude: rerun the two `claude -p` runs above against a temp project. Then grep the parent transcript and the subagent transcripts for each sentinel.
- Codex: rerun `codex exec ... < /dev/null` with the shareable-fact hook text, and read the rollout named in `transcript_path`.
- Record the versions here, and check `config.toml`'s sha256 before and after.
