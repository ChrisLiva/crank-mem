import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { redact, stripBlocks } from "../src/daemon/redact.ts";
import { REPO_ROOT } from "./helpers.ts";

describe("stripBlocks", () => {
  test.each([
    ["a <private>x</private> b", "a  b"],
    ["a <system-reminder>\nline\n</system-reminder>b", "a b"],
    ["keep <private>open to the end\nmore", "keep "],
    ["keep <system-reminder>open", "keep "],
    ["<private>all of it</private>", ""],
    ["no tags", "no tags"],
    ["", ""],
    ["<private>a</private> mid <private>b</private>", " mid "],
  ])("%j", (input, expected) => {
    expect(stripBlocks(input)).toBe(expected);
  });
});

// Samples are built by concatenation so no literal real-shaped token sits in this public repo.
const VENDOR_SAMPLES: [string, string][] = [
  ["AWS access key", "AKIA" + "IOSFODNN7EXAMPL" + "E"],
  ["AWS temporary key", "ASIA" + "IOSFODNN7EXAMPL" + "E"],
  ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((p): [string, string] => [`GitHub ${p}`, p + "a1".repeat(18)]),
  ["GitHub fine-grained", "github_" + "pat_" + "11A".repeat(10)],
  ["Anthropic", "sk-" + "ant-api03-" + "a1".repeat(20)],
  ["OpenAI project", "sk-" + "proj-" + "a1".repeat(20)],
  ["OpenAI legacy", "sk-" + "a1".repeat(20)],
  ...["b", "a", "p", "r", "s"].map((k): [string, string] => [`Slack xox${k}-`, "xox" + k + "-" + "1234567890-" + "abcdefghijkl"]),
  ["Slack webhook", "https://hooks.slack.com/" + "services/T0000/B0000/" + "a1".repeat(12)],
  ["JWT", "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxIn0" + "." + "a1".repeat(10)],
  ["Stripe secret", "sk_" + "live_" + "a1".repeat(12)],
  ["Stripe restricted", "rk_" + "test_" + "a1".repeat(12)],
  ["Google API key", "AIza" + "a1".repeat(17) + "b"],
  ["GitLab", "glpat-" + "a1".repeat(10)],
  ["Hugging Face", "hf_" + "a1".repeat(17)],
  ["npm", "npm_" + "a1".repeat(18)],
  ["Docker", "dckr_" + "pat_" + "a1".repeat(14)],
  ["SendGrid", "SG." + "a1".repeat(11) + "." + "b2".repeat(21) + "c"],
  ...["dop_", "doo_", "dor_"].map((p): [string, string] => [`DigitalOcean ${p}`, p + "v1_" + "a1".repeat(32)]),
  ...["shpat_", "shpss_", "shpca_", "shppa_"].map((p): [string, string] => [`Shopify ${p}`, p + "a1".repeat(16)]),
  ["PyPI", "pypi-" + "AgEIcHlwaS5vcmc" + "a1".repeat(20)],
  ["Discord webhook", "https://discord.com/api/" + "webhooks/123456789012345678/" + "a1".repeat(30)],
];

describe("redact vendor tokens", () => {
  test.each(VENDOR_SAMPLES)("%s", (_vendor, sample) => {
    expect(redact(`x ${sample} y`)).toBe("x [redacted] y");
  });
});

const KEYED_ROWS: [string, string][] = [
  ["password=hunter2hunter2", "password=[redacted]"],
  ['{"api_key": "abc123def"}', '{"api_key": "[redacted]"}'],
  ['{\\"password\\": \\"hunter2\\"}', '{\\"password\\": \\"[redacted]\\"}'],
  ["aws_secret_access_key = " + "wJalrXUtnFEMI" + "K7MDENGbPxRfiCY" + "EXAMPLEKEY", "aws_secret_access_key = [redacted]"],
  ["AWS_SESSION_TOKEN=" + "FwoGZXIvYXdz" + "a1".repeat(20), "AWS_SESSION_TOKEN=[redacted]"],
  ["TOKEN: abc", "TOKEN: [redacted]"],
  ["postgres://app:hunter2@db.example.com/x", "postgres://app:[redacted]@db.example.com/x"],
  ["Authorization: Bearer abc.def.ghi", "Authorization: Bearer [redacted]"],
  ["authorization: basic dXNlcjpwYXNz", "authorization: basic [redacted]"],
  ["-----BEGIN RSA " + "PRIVATE KEY-----\nMIIabc\n-----END RSA " + "PRIVATE KEY-----", "[redacted]"],
  ["-----BEGIN " + "PRIVATE KEY-----\nMIIabc\n-----END " + "PRIVATE KEY-----", "[redacted]"],
  ["a -----BEGIN " + "PRIVATE KEY-----\nMIIabc\nMIIdef", "a [redacted]"],
  ["password=", "password="],
  ['{"api_key": ""}', '{"api_key": ""}'],
];

describe("redact keyed values", () => {
  test.each(KEYED_ROWS)("%j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });
});

describe("redact leaves near-misses alone", () => {
  test.each([
    "max_tokens: 4096",
    "token_count = 5",
    "sk-short",
    "the password is wrong",
    "eyJhbGci",
    "https://example.com/a:b@c",
    "AKIA",
    "secretary: Bob",
    "ghp_short",
    "",
  ])("%j", (input) => {
    expect(redact(input)).toBe(input);
  });

  test.each([...VENDOR_SAMPLES.map(([, sample]) => `x ${sample} y`), ...KEYED_ROWS.map(([input]) => input)])(
    "is idempotent on %j",
    (input) => {
      const once = redact(input);
      expect(redact(once)).toBe(once);
    },
  );
});

describe("redaction has no switch", () => {
  test("redact takes one argument and ignores any extra one", () => {
    expect(redact.length).toBe(1);
    expect(Reflect.apply(redact, undefined, ["password=hunter2hunter2", false])).toBe("password=[redacted]");
  });

  test("src/daemon/redact.ts imports nothing and reads no environment", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "src/daemon/redact.ts"), "utf-8");
    expect(source).not.toMatch(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']/m);
    expect(source).not.toMatch(/^\s*import\s*["']/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\bprocess\.env\b/);
  });
});
