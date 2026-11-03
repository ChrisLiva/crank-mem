# 0008 — The `claude -p` digest gateway (probe-verified)

Date: 2026-11-02. Status: accepted.

## Context

crank-mem 0.8.0 digests finished Claude Code sessions into a per-project memory store. The
digest job sends a distilled transcript to a model and stores the structured output it gets
back. crank-mem has no API key of its own and adds no runtime dependency to the hooks, so the job
runs the user's installed `claude` binary in print mode, on the user's own claude.ai login.

That choice raises questions that only live runs can answer:

- Which flags give one structured answer with no tools, hooks, MCP servers or session files?
- Which environment variables can switch the run off the login onto another credential?
- How does each failure show up on stdout?

`src/daemon/gateway.ts` (`askClaude`) is the only code that spawns `claude`, and it rests on
the findings below.

## Versions

- Claude Code 2.1.316 (`claude --version`) for every probe under `.crank/crank-mem-v2/research/probes/stage1/`.
- Claude Code 2.1.317 (`claude --version` printed `2.1.317 (Claude Code)`) for the live reading on 2026-11-02.
- bun 1.4.4, node 26.13.0, macOS (Darwin 27.0.0).

Probe paths below are relative to `.crank/crank-mem-v2/research/probes/stage1/`. That
directory is gitignored local evidence and is not part of this repo.

## Findings

1. **The call shape.** Every compliant run used this argv, with the transcript on stdin:
   `claude -p --model haiku --effort low --tools "" --setting-sources "" --settings '{"disableAllHooks":true}' --strict-mcp-config --no-session-persistence --max-turns 2 --system-prompt <system> --json-schema <schema> --output-format stream-json --verbose`.
   The init line then lists `tools: ["StructuredOutput"]`. The answer arrives as one
   StructuredOutput tool call, and the result line carries `num_turns: 2`,
   `terminal_reason: "completed"` and `structured_output` (`plan/live.jsonl`). Compliant runs
   behaved the same at `--max-turns` 1, 2 and 3: each made 1 API call and ended `success`
   after 2 turns (`digest-probe/table.txt`, rows `s60k_n1`, `s60k_n2`, `s60k_n3`).
2. **A denylist does not work, so the env is an allowlist.** Each of these variables moved the
   run off the claude.ai login while the init line still read `apiKeySource: "none"`:
   - `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` ended with `api_error_status: 401`.
   - `CLAUDE_CODE_USE_BEDROCK` ended with "Could not load AWS credentials".
   - `ANTHROPIC_BASE_URL` ended with "Connection refused".
   - The `helper` probe, which used an API key helper, read `apiKeySource: "apiKeyHelper"` and ended with a 401.

   Evidence: `hook-probe/logs/d/{authtoken,oauth,bedrock,baseurl,helper}.{jsonl,rc}`.
   `auth status` does not catch `ANTHROPIC_BASE_URL` either. The init line therefore cannot
   detect every credential route, and the gateway passes only `HOME`, `USER`, `PATH`,
   `TMPDIR` and `CLAUDE_CODE_MAX_RETRIES=0`.
3. **`claude auth status`** prints JSON on stdout and exits 0 only when logged in. Its
   `authMethod` is one of `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`,
   `third_party` or `none`. The builder in `~/.local/share/claude/versions/2.1.316` prints
   `{loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory}`,
   plus `apiKeySource` when one is set, as 2-space JSON. No retained probe file holds its
   output. The gateway runs `-p` only after `auth status` shows `loggedIn: true`,
   `authMethod: "claude.ai"` and `apiProvider: "firstParty"`.
4. **A bad API key** gives an init line with `apiKeySource: "ANTHROPIC_API_KEY"`, then a result
   with `subtype: "success"`, `is_error: true` and `api_error_status: 401` (`exp/c1`,
   `exp/c2`). `subtype` alone never shows failure. The gateway reads `is_error`.
5. **`--bare`** skips the login. Its result is `"Not logged in · Please run /login"` with
   `is_error: true` (`plan/bare.jsonl`). Without stream-json, stdout is that plain line
   (`exp/d.out`).
6. **A refusal** at `--max-turns 2` exits 0 with `subtype: "success"`, `is_error: false`,
   `terminal_reason: "completed"` and no `structured_output` key (`plan/refuse2-1.jsonl`,
   `plan/refuse2-2.jsonl`). At `--max-turns 1` it exits 1 with `subtype: "error_max_turns"`
   (`exp/b2`). Without the `structured_output` check, the job would store a refusal as a
   success.
7. **`provider`** appears only under `result.modelUsage["<model>"]`, for example
   `"provider": "firstParty"` (`plan/live.jsonl`). The init line does not carry it.
8. **`CLAUDE_CODE_MAX_RETRIES=0`.** Without it, a dead endpoint retries for 180 to 256 seconds
   before it fails (`hook-probe/logs/d/baseurl.rc`: `wall=180`, `helper.rc`: `wall=256`).
9. **`--max-budget-usd`** stops only after the money is spent. The budget row spent $0.0033
   and then ended `error_max_budget_usd` (`digest-probe/table.txt`, `s60k_n3_budget`).
10. **Thinking cannot be turned off.** `--thinking disabled` and `--max-thinking-tokens 0`
    still produced thinking tokens: 1,327 and 2,257 (`digest-probe/table.txt`,
    `s60k_n3_nothink`, `s160k_n3_think0`).
11. **Timing.** The slowest real digest took 46 seconds, on a 163,000-character input
    (`digest-probe/table.txt`, `s160k_n3_rep2`). The gateway's run timer is 300 seconds
    (`RUN_TIMEOUT_MS`).
12. **The prompt.** The 12 unforced probe runs in `digest-probe/table.txt` (every row but
    `s60k_n3_budget` and `s10k_n3_refuse`) used the system prompt without two parts: the last
    bullet under "Record durable technical signal" ("user-stated preferences and corrections,
    filed as type decision") and the last paragraph (the `[PRIOR SUMMARY]` rule). The live
    reading below used the full text in `src/daemon/digest-prompt.ts`.

### Live reading, 2026-11-02, Claude Code 2.1.317

The reading had two runs, made from a scratch directory outside the repo with `CRANK_HOME`
set to a fresh temp directory. Both sent the text of `tests/fixtures/transcript.expected.txt`
(6,300 characters) on stdin.

- **Run 1** called `askClaude(digestRequest(<text>, null))` through `src/daemon/gateway.ts`.
  It returned kind `ok` with model `claude-haiku-5-5`, `costUsd` 0.0012896, a 4.9-second wall
  time and 1 observation.
- **Run 2** spawned `claude` directly with the Finding 1 argv, the Finding 2 env and cwd
  `<crank home>/run`. It exited 0 after 9.5 seconds.
  - Line types: `system/init`, four `system/thinking_tokens`, two `assistant`, `user`,
    `rate_limit_event`, `result/success`.
  - The init line held `apiKeySource: "none"`, `tools: ["StructuredOutput"]`,
    `model: "claude-haiku-5-5"` and `claude_code_version: "2.1.317"`.
  - The result held `subtype: "success"`, `is_error: false`, `api_error_status: null`,
    `num_turns: 2`, `terminal_reason: "completed"`, a `structured_output` key and
    `total_cost_usd` 0.00086887. `modelUsage["claude-haiku-5-5"]` held
    `provider: "firstParty"`, `costBasis: "list"`, `contextWindow: 1000000` and
    `maxOutputTokens: 128000`.
  - `<crank home>/run/` was still empty after both runs.

Both runs met the bar the plan set: kind `ok`, `apiKeySource` `"none"`, provider
`"firstParty"`, cost at most $0.05 and wall time at most 60 seconds.

## Decision

- The gateway spawns `claude` with the fixed argv from Finding 1. The system prompt and
  schema go in argv, and the transcript goes on stdin only.
- The cwd is an empty `<crank home>/run/` directory, so the run sits outside every project.
- The environment is exactly `HOME`, `USER`, `PATH`, `TMPDIR` (each when set) plus
  `CLAUDE_CODE_MAX_RETRIES=0`. The same env goes to `claude auth status`.
- `auth status` gates every `-p` run on `loggedIn: true`, `authMethod: "claude.ai"` and
  `apiProvider: "firstParty"`.
- The gateway reads the last stdout line with `type: "result"`. It returns `ok` only when
  `is_error` is false and `structured_output` passes the hand-written `validate`. The model
  is the first key of `modelUsage`, and the cost is `total_cost_usd`. Every other outcome is
  `retry` for now. Task 11 splits out credential, login and rejection classes on the
  findings above.
- crank-mem does not use `--max-budget-usd` or the thinking flags, because neither does what
  its name says (Findings 9 and 10).

## Re-probe method

Re-run this reading whenever `claude --version` changes minor version, or a digest starts
failing in a new way.

1. In a scratch directory outside any repo, set `CRANK_HOME=$(mktemp -d)`.
2. Run `bun -e` with a script that imports `src/daemon/gateway.ts` and
   `src/daemon/digest-prompt.ts` from the clone, and calls
   `askClaude(digestRequest(<tests/fixtures/transcript.expected.txt>, null))`. Print `kind`,
   `model`, `costUsd` and the wall time.
3. In a second `bun -e`, spawn `claude` with the argv from Finding 1, the env from Finding 2
   and cwd `$CRANK_HOME/run`. Write the same text to stdin, then print the first stdout line
   and the `type: "result"` line.
4. Check that the init line still reads `apiKeySource: "none"`, that
   `result.modelUsage["<model>"].provider` is `"firstParty"`, and that the result keys the
   gateway reads still exist: `is_error`, `structured_output`, `total_cost_usd` and
   `modelUsage`.
5. For the credential findings, repeat step 3 once per variable in Finding 2, with only that
   variable added to the env. Use `ANTHROPIC_BASE_URL=http://127.0.0.1:9` for the dead
   endpoint, and drop `CLAUDE_CODE_MAX_RETRIES=0` to time the retries.
6. Delete the temp `CRANK_HOME` afterwards.
