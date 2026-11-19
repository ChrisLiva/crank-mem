import { describe, expect, test } from "bun:test";
import { shellGrepNames, shellHistoryPaths, shellReadPaths } from "../src/hooks/lib/shell-reads.ts";

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
      ["cat a.ts 2> err.txt", ["a.ts"]],
      ["cat a.ts >> out.txt", ["a.ts"]],
      ["cat a.ts &> out.txt", ["a.ts"]],
      ["cat < a.ts", ["a.ts"]],
      ["cat << EOF", []],
      ["cat a.ts >out.txt", ["a.ts"]],
      ["cat a.ts 2>/dev/null", ["a.ts"]],
      ["sed -n 1p a.ts 2>&1", ["a.ts"]],
      ["cat a.ts &>out.txt", ["a.ts"]],
      ["cat a.ts 1>> out.txt", ["a.ts"]],
      ['cat "my file.ts"', ["my file.ts"]],
      ["echo 'cat a.ts; cat b.ts'", []],
      ["cat <<'EOF'\ncat secret.ts\nEOF", []],
      ['cat <<< "x"\ncat src/foo.ts\nhead bar.ts', ["src/foo.ts", "bar.ts"]],
      ['cat a.ts <<<"v"\ncat src/foo.ts', ["a.ts", "src/foo.ts"]],
      ["cat <<-EOF\n\tbody\n\tEOF\ncat src/foo.ts", ["src/foo.ts"]],
      ["cat <<-EOF\nbody\nEOF\ncat src/foo.ts", ["src/foo.ts"]],
      ["cat <<- EOF\n\tbody\n\tEOF\ncat src/foo.ts", ["src/foo.ts"]],
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
      ["git log -- src/a.ts", []],
      ["git show HEAD:src/a.ts", []],
      ["git blame src/a.ts", []],
    ];
    for (const [command, paths] of table)
      expect([command, shellReadPaths(command)]).toEqual([command, paths]);
  });
});

describe("shellGrepNames", () => {
  test("names the identifiers each grep searches for, when its pattern holds nothing else", () => {
    const table: Array<[string, string[][]]> = [
      ['rg -n "subagentInjection" src', [["subagentInjection"]]],
      ["grep -rn 'subagentInjection(' src", [["subagentInjection"]]],
      ["grep -rn 'subagentInjection\\(' src", [["subagentInjection"]]],
      ["git grep -n subagentInjection", [["subagentInjection"]]],
      ["rg \"\\bfooBar\\b|bazQux\" -g '*.ts'", [["fooBar", "bazQux"]]],
      ["grep -n 'fooBar\\|bazQux\\|read_store' src", [["fooBar", "bazQux", "read_store"]]],
      ["rg -t ts -e subagentInjection", [["subagentInjection"]]],
      ["rg -g '*.ts' -A 3 --max-count 5 subagentInjection src", [["subagentInjection"]]],
      ["rg '^fooBar$'", [["fooBar"]]],
      ["grep -r fooBar src", [["fooBar"]]],
      ["cd src && rg fooBar; grep -n bazQux a.ts", [["fooBar"], ["bazQux"]]],
      ["rg fooBar | head -5", [["fooBar"]]],
      ["bun test | grep subagentInjection", []],
      ["cat a.ts | rg fooBar", []],
      ["bun test || rg fooBar", [["fooBar"]]],
      ['rg "function subagentInjection"', []],
      ["rg main", []],
      ["rg found src", []],
      ["rg a1B", []],
      ["rg 'fooBar|plain'", []],
      ["rg 'aaBb|ccDd|eeFf|ggHh'", []],
      ["rg 'fooBar.*bazQux'", []],
      ["rg -g fooBar", []],
      ["rg", []],
      ["git log --grep fooBar", []],
      ["echo 'rg fooBar'", []],
      ["cat <<'EOF'\nrg fooBar\nEOF", []],
      ["crank-mem callers fooBar", []],
      ["", []],
    ];
    for (const [command, names] of table)
      expect([command, shellGrepNames(command)]).toEqual([command, names]);
  });
});

describe("shellHistoryPaths", () => {
  test("names the files a git log, show or blame asks about", () => {
    const table: Array<[string, string[]]> = [
      ["git log --oneline -5 -- src/a.ts", ["src/a.ts"]],
      [
        "git log --oneline 340aca0..HEAD -- src/a.ts src/b.ts 2>/dev/null",
        ["src/a.ts", "src/b.ts"],
      ],
      ['git log --oneline -S"agent_id" -- src/a.ts', ["src/a.ts"]],
      ["git log -3 -- src/a.ts > out.txt", ["src/a.ts"]],
      ["git show HEAD~1:src/a.ts", ["src/a.ts"]],
      ["git show 1299cc0 -- src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
      ["git show HEAD:src/a.ts > src/b.ts", ["src/a.ts"]],
      ["git show --stat HEAD:src/a.ts 1299cc0:src/b.ts", ["src/a.ts", "src/b.ts"]],
      ["git blame -L 10,20 src/a.ts", ["src/a.ts"]],
      ["git blame --date short -w src/a.ts", ["src/a.ts"]],
      ["git blame 1299cc0 -- src/a.ts", ["1299cc0", "src/a.ts"]],
      ["cd src && git log -3 -- a.ts; git blame b.ts", ["a.ts", "b.ts"]],
      ["git log --oneline -5", []],
      ["git log --oneline src/a.ts", []],
      ["git log --grep fix", []],
      ["git log --", []],
      ["git show 1299cc0 --stat", []],
      ["git show --format=%h:%s 1299cc0", []],
      ["git show", []],
      ["git blame", []],
      ["git diff -- src/a.ts", []],
      ["git status", []],
      ["git -C sub log -- src/a.ts", []],
      ["echo x | git log -- src/a.ts", []],
      ["echo 'git log -- src/a.ts'", []],
      ["cat <<'EOF'\ngit log -- src/a.ts\nEOF", []],
      ["cat src/a.ts", []],
      ["", []],
    ];
    for (const [command, paths] of table)
      expect([command, shellHistoryPaths(command)]).toEqual([command, paths]);
  });
});
