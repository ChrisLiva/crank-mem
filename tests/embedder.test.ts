import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { EMBED_MODEL, MODEL_FILES } from "../src/daemon/embedder.ts";
import {
  makeCrankHome,
  makeCrankProject,
  makeModelHome,
  plantVector,
  realModelsDir,
  runCli,
  seedMemory,
  startModelServer,
} from "./helpers.ts";

const KEYWORD_ONLY_NOTE =
  "crank-mem: keyword search only; run `crank-mem setup` for search by meaning.";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function temp(dir: string): string {
  temps.push(dir);
  return dir;
}

describe("search by meaning (black-box)", () => {
  test("without the model, search falls back to keywords with one note on stderr", () => {
    const home = temp(makeCrankHome());
    const root = temp(makeCrankProject());
    seedMemory(root, [{ title: "alpha beta" }, { title: "beta gamma" }]);
    const run = runCli(root, ["search", "alpha", "delta"], { CRANK_HOME: home });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^#1 \S+ discovery alpha beta\n$/);
    expect(run.stderr).toBe(`${KEYWORD_ONLY_NOTE}\n`);
  }, 30_000);

  test("search skips the query embed when the store holds no vectors", () => {
    const home = temp(makeCrankHome());
    for (const file of MODEL_FILES) {
      const target = path.join(home, "models", EMBED_MODEL, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.alloc(16, 0xab));
    }
    const root = temp(makeCrankProject());
    const [id] = seedMemory(root, [{ title: "alpha beta" }]);
    expect(runCli(root, ["search", "alpha"], { CRANK_HOME: home })).toMatchObject({
      status: 0,
      stderr: "",
    });

    plantVector(root, id!);
    expect(runCli(root, ["search", "alpha"], { CRANK_HOME: home })).toMatchObject({
      status: 0,
      stderr: `${KEYWORD_ONLY_NOTE}\n`,
    });
  }, 30_000);

  test("search makes no network call, with or without the model", async () => {
    const server = await startModelServer(realModelsDir(), "ok");
    try {
      const root = temp(makeCrankProject());
      const [id] = seedMemory(root, [{ title: "Lock file writes retry on EEXIST" }]);
      plantVector(root, id!);
      for (const home of [temp(makeCrankHome()), temp(makeModelHome())]) {
        const run = runCli(root, ["search", "EEXIST", "--model-host", server.url], {
          CRANK_HOME: home,
        });
        expect(run.status).toBe(0);
        expect(run.stdout).toMatch(/ Lock file writes retry on EEXIST\n$/);
      }
      expect(server.requests()).toEqual([]);
    } finally {
      server.stop();
    }
  }, 30_000);
});
