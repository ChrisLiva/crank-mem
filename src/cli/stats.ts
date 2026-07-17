import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, CRANK_DIR } from "../hooks/lib/config.ts";
import { loadIndex, INDEX_FILE } from "../hooks/lib/store.ts";
import { walkProject } from "../hooks/lib/scanner.ts";

function age(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export async function run(_args: string[]): Promise<number> {
  const root = process.cwd();
  const crankDir = path.join(root, CRANK_DIR);
  if (!fs.existsSync(path.join(crankDir, "config.json"))) {
    console.error("crank-mem: not initialized here — run `crank-mem init` first.");
    return 1;
  }
  const config = loadConfig(crankDir);
  const index = loadIndex(crankDir);
  const walked = walkProject(root, config);
  const indexed = Object.keys(index.files).length;
  const coverage = walked.length === 0 ? 100 : Math.round((100 * indexed) / walked.length);
  let indexSize = 0;
  try {
    indexSize = fs.statSync(path.join(crankDir, INDEX_FILE)).size;
  } catch {}

  console.log(`crank-mem stats`);
  console.log(`  files indexed:    ${indexed}`);
  console.log(`  files on disk:    ${walked.length} (coverage ${coverage}%)`);
  console.log(`  last scan:        ${age(index.meta.lastScanned)}${index.meta.partial ? " (partial)" : ""}`);
  console.log(`  index size:       ${(indexSize / 1024).toFixed(1)} KB`);
  console.log(`  runtime:          ${config.runtime} (vendored ${config.vendored_version})`);
  console.log(`  injection budget: ${config.injection_budget_tokens} tokens`);
  return 0;
}
