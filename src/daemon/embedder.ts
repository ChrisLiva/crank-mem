import * as fs from "node:fs";
import * as path from "node:path";
import { crankHome } from "../hooks/lib/user-state.ts";

// Local sentence embeddings for search by meaning. The package loads by dynamic
// import, so every command that never embeds runs without it installed.

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
];

const FETCH_TIMEOUT_MS = 60_000;

export function modelsDir(): string {
  return path.join(crankHome(), "models");
}

export function modelPresent(): boolean {
  const dir = path.join(modelsDir(), EMBED_MODEL);
  return MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f)));
}

export async function embedderReady(): Promise<boolean> {
  if (!modelPresent()) return false;
  try {
    await import("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

let originalFetch: ((input: string | URL, init?: any) => Promise<any>) | null = null;

export async function embed(
  texts: string[],
  opts: { remote: boolean; host?: string; fetchTimeoutMs?: number },
): Promise<Float32Array[]> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = modelsDir();
  env.allowRemoteModels = opts.remote;
  if (opts.host) env.remoteHost = opts.host.endsWith("/") ? opts.host : `${opts.host}/`;
  // Kept once, so a second call wraps the package's own fetch rather than our wrapper.
  const original = (originalFetch ??= env.fetch);
  if (opts.remote) {
    const timeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    env.fetch = (u, i) => original(u, { ...i, signal: AbortSignal.timeout(timeoutMs) });
  } else {
    env.fetch = original;
  }
  const extractor = await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" });
  try {
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const data = out.data;
    if (!(data instanceof Float32Array))
      throw new Error(`embedder returned ${data.constructor.name}, not Float32Array`);
    const dim = out.dims[1] ?? 0;
    return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
  } finally {
    await extractor.dispose();
  }
}
