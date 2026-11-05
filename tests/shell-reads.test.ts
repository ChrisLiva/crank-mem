import { describe, expect, test } from "bun:test";
import { shellReadPaths } from "../src/hooks/lib/shell-reads.ts";

describe("shellReadPaths", () => {
  test("names the files a read-only shell command reads", () => {
    const table: Array<[string, string[]]> = [
      ["cat a.ts", ["a.ts"]],
      ["sed -n '1,200p' src/x.ts", ["src/x.ts"]],
      ["head -n 20 a.ts", ["20", "a.ts"]],
      ["tail -f log.txt", ["log.txt"]],
      ["awk '{print $1}' f.txt", ["f.txt"]],
      ["awk -F: '{print $1}' f.txt", ["f.txt"]],
      ["nl -ba a.ts", ["a.ts"]],
      ["cat a.ts | head -5", ["a.ts"]],
      ["cd src && cat a.ts; sed -n 1p b.ts", ["a.ts", "b.ts"]],
      ["cat a.ts > out.txt", ["a.ts"]],
      ['cat "my file.ts"', ["my file.ts"]],
      ["echo 'cat a.ts; cat b.ts'", []],
      ["cat <<'EOF'\ncat secret.ts\nEOF", []],
      ["grep foo a.ts", []],
      ["rg foo", []],
      ["cat", []],
      ["", []],
      ["crank-mem outline src/a.ts", ["src/a.ts"]],
      ["crank-mem outline src/a.ts --from 40", ["src/a.ts"]],
      ["crank-mem outline --from 40 src/a.ts", ["src/a.ts"]],
      ["crank-mem unfold src/a.ts f", ["src/a.ts"]],
      ["crank-mem unfold src/a.ts 12", ["src/a.ts"]],
      ["crank-mem search foo", []],
      ["crank-mem outline --help", []],
      ["crank-mem outline", []],
      ["crank-mem outline --from 40", []],
    ];
    for (const [command, paths] of table)
      expect([command, shellReadPaths(command)]).toEqual([command, paths]);
  });
});
