# Test suite timing baseline

## Baseline

Three consecutive `caffeinate -i bun run test` runs at commit `6edd368`, 2026-11-10. Before each run, `yes > /dev/null` burners raised the one-minute load average into the 3.5 to 4.5 band when it read lower. Load columns give the one-minute average from `uptime` at the start and end of the run. Lane times are bun's own `Ran N tests across M files. [Xs]` readings; the total adds the two.

| Run | Commit | Load start | Load end | Burners | Parallel lane (s) | Serial lane (s) | Total (s) | Parallel lane pass/fail | Serial lane pass/fail |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `6edd368` | 3.69 | 4.35 | 1 | 18.00 | 17.47 | 35.47 | 805 / 0 (44 files) | 24 / 0 (2 files) |
| 2 | `6edd368` | 4.40 | 4.32 | 0 | 17.15 | 18.36 | 35.51 | 805 / 0 (44 files) | 24 / 0 (2 files) |
| 3 | `6edd368` | 4.21 | 4.76 | 0 | 17.60 | 18.30 | 35.90 | 805 / 0 (44 files) | 24 / 0 (2 files) |

Plain `caffeinate -i bun test` at `6edd368`, every file serially in one process: load 4.08 at start and 4.04 at end, 0 burners, 829 pass and 0 fail, `Ran 829 tests across 46 files. [80.02s]`. Its 829 tests and 46 files equal the two lanes' counts summed (805 + 24, 44 + 2).

For comparison, the first two-lane reading (commit `eb13262`, load 4.11) took 29.19 s for 834 tests in 42 files plus 29.44 s for 25 tests in 2 files.

## How to run

- `caffeinate -i bun run test` runs the full suite, the command the full-suite gate uses. `caffeinate -i` keeps a Mac on battery from sleeping mid-run. The script runs two lanes: 4 parallel workers over every file except `*.serial.test.ts`, then the `*.serial.test.ts` files serially. It fails when either lane fails.
- `bun test <file>` runs one file.
- `bun test` runs every file serially.

## How to read a failure

- `[5xxx ms]` on a test, or `Expected: 0, Received: -1` from a `runCli` status, is a per-test timeout, not a crash: bun kills the children of a test that passes its 5,000 ms default, and `runCli` reports each as `-1`. A test's own timeout argument beats `--timeout`. Rerun the file alone with `bun test <file>` before you call it a regression.
- After a run that hit a timeout, find leftover fake `claude` processes with `ps` and kill them: the `spawnSync` timeout in `tests/helpers.ts` → `runCli` kills only the CLI child, so a hung grandchild keeps running at ppid 1.
- Record each baseline run here with its commit, load average, lane times and pass/fail counts.
