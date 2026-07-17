# 0002 — Codex hooks trust model (probe-verified)

Date: 2026-07-16. Status: accepted. Codex 0.144.5 (codex-rs rust-v0.144.5).

## Findings

Project-layer `.codex/` config loads only when the project dir is trusted:
`[projects."<dir>"] trust_level = "trusted"` in `$CODEX_HOME/config.toml`
(Codex's own first-use flow adds it). Hooks additionally require:

1. `[features] hooks = true` — project-level `.codex/config.toml` suffices
   once the dir is trusted.
2. Per-hook trust in the USER config.toml:
   `[hooks.state."<abs hooks.json path>:<event_key>:<group_idx>:<handler_idx>"]
   trusted_hash = "sha256:<hex>"` — granted interactively via Codex's startup
   hooks review, or bypassed with `--dangerously-bypass-hook-trust`.

### Hash formula

(sources: `hooks/src/engine/discovery.rs` `command_hook_hash`,
`config/src/fingerprint.rs` `version_for_toml`)

sha256 of the canonical (recursively key-sorted) JSON serialization of the
TOML value of:

```
{ event_name: <snake_case label>, matcher,
  hooks: [{ type: "command", command, timeout_sec: <given|600>,
            async: false, status_message }] }
```

Normalized handler drops `command_windows`. Formatted `sha256:<lowercase hex>`.

## Decision

Default: print instructions ("open codex once, accept the hooks review").
`init --codex-trust write` opts into computing and writing `trusted_hash`
entries to `~/.codex/config.toml`; that file then joins backups, `uninstall`
removes exactly those entries, and `upgrade` recomputes hashes.
