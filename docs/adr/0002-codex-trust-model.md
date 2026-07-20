# 0002 — Codex hooks trust model (probe-verified)

Date: 2026-07-16. Status: accepted. Codex 0.144.5 (codex-rs rust-v0.144.5).
Amended 2026-07-19 against rust-v0.144.6 source (byte-identical to 0.144.5 in
`hooks/`, `config/`, `features/`): the original `[features]` finding and two
hash-formula key names were wrong; corrected below, and `codex-trust.ts`
fixed to match.

## Findings

Project-layer `.codex/` config loads only when the project dir is trusted:
`[projects."<dir>"] trust_level = "trusted"` in `$CODEX_HOME/config.toml`
(Codex's own first-use flow adds it; the lookup key may also be the project
or repo root, not only the exact dir). Hooks additionally require:

1. ~~`[features] hooks = true`~~ **Correction:** the `hooks` feature is
   `Stage::Stable` and `default_enabled: true` (`features/src/lib.rs`) in
   both 0.144.5 and 0.144.6 — no opt-in is required. Crank's
   `[features]` snippet in project `.codex/config.toml` is redundant on
   these versions (kept as a harmless belt-and-suspenders; `features` is
   not on the project-layer config denylist, so the project file can
   toggle it either way once trusted).
2. Per-hook trust in the USER config.toml (only the user/session layers can
   supply trust — `hooks/src/config_rules.rs`):
   `[hooks.state."<abs hooks.json path>:<event_key>:<group_idx>:<handler_idx>"]
   trusted_hash = "sha256:<hex>"` — granted interactively via Codex's startup
   hooks review, or bypassed with `--dangerously-bypass-hook-trust`.

### Hash formula

(sources: `hooks/src/engine/discovery.rs` `command_hook_hash`,
`config/src/fingerprint.rs` `version_for_toml`)

sha256 of the compact, canonical (recursively key-sorted) JSON serialization
of the TOML value of the normalized identity, using the serde **wire** names:

```
{ event_name: <snake_case label>, matcher,
  hooks: [{ type: "command", command, timeout: <given|600, min 1>,
            async: false, statusMessage }] }
```

Absent optionals (`matcher`, `statusMessage`, `commandWindows`) are omitted
entirely — codex's TOML round-trip drops `None` fields, never serializing
null. Normalized handler always drops `command_windows`. Formatted
`sha256:<lowercase hex>`. (The original ADR recorded the Rust field names
`timeout_sec`/`status_message`; the hashed keys are the serde renames
`timeout`/`statusMessage` — `config/src/hook_config.rs`. `codex-trust.ts`
inherited the wrong key and produced hashes codex would treat as stale;
fixed 2026-07-19 with vectors pinned in `tests/codex-trust.test.ts`.)

## Decision

Default: print instructions ("open codex once, accept the hooks review").
`init --codex-trust write` opts into computing and writing `trusted_hash`
entries to `~/.codex/config.toml`; that file then joins backups, `uninstall`
removes exactly those entries, and `upgrade` recomputes hashes.
