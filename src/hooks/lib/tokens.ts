import * as path from "node:path";

// Token estimation: chars ÷ 3.5 for code, ÷ 4.0 for prose, ÷ 3.75 otherwise.

const CODE_EXTENSIONS = new Set([
  ".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".css", ".scss", ".sql", ".sh", ".yaml",
  ".yml", ".json", ".toml", ".xml", ".dart",
]);

const PROSE_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc"]);

export function estimateTokens(text: string, filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  let ratio = 3.75;
  if (CODE_EXTENSIONS.has(ext)) ratio = 3.5;
  else if (PROSE_EXTENSIONS.has(ext)) ratio = 4.0;
  return Math.ceil(text.length / ratio);
}

/** Estimate tokens for injected prose (instructions, cerebrum, anatomy lines). */
export function estimateProseTokens(text: string): number {
  return Math.ceil(text.length / 4.0);
}
