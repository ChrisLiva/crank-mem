# Test suite timing baseline

The proof runs that fill this baseline land in a later change. Until then this file holds the method.

## How to run

- `caffeinate -i bun run test` runs the full suite, the command the full-suite gate uses. `caffeinate -i` keeps a Mac on battery from sleeping mid-run. The script runs two lanes: 4 parallel workers over every file except `*.serial.test.ts`, then the `*.serial.test.ts` files serially. It fails when either lane fails.
- `bun test <file>` runs one file.
- `bun test` runs every file serially.

For orientation, not yet the baseline: at load average about 3.4 to 4.3 the parallel lane ran in 17 to 26 s and the serial lane in 16 to 18 s, with 0 failures.

## How to read a failure

- `[5xxx ms]` on a test, or `Expected: 0, Received: -1` from a `runCli` status, is a per-test timeout, not a crash: bun kills the children of a test that passes its 5,000 ms default, and `runCli` reports each as `-1`. A test's own timeout argument beats `--timeout`. Rerun the file alone with `bun test <file>` before you call it a regression.
- After a run that hit a timeout, find leftover fake `claude` processes with `ps` and kill them: the `spawnSync` timeout in `tests/helpers.ts` → `runCli` kills only the CLI child, so a hung grandchild keeps running at ppid 1.
- Record each baseline run here with its commit, load average, lane times and pass/fail counts.
