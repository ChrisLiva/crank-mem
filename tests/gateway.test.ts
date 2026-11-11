import { describe, expect, test } from "bun:test";
import { digestRequest } from "../src/daemon/digest-prompt.ts";
import { classify } from "../src/daemon/gateway.ts";
import {
  NOT_LOGGED_IN_RAW,
  invalidOutputStream,
  maxTurnsStream,
  noProviderStream,
  notLoggedInStream,
  okStream,
  otherProviderStream,
  refusalStream,
  status401Stream,
  status403Stream,
  status500Stream,
} from "./fixtures/claude-scenarios.ts";
import { SAMPLE_DIGEST } from "./fixtures/digest-output.ts";

const [first, ...others] = SAMPLE_DIGEST.observations;
const QUOTING = {
  ...SAMPLE_DIGEST,
  observations: [
    {
      ...first!,
      narrative: `${first!.narrative} The CLI printed Not logged in · Please run /login.`,
    },
    ...others,
  ],
};

describe("classify", () => {
  const { validate } = digestRequest("D", null, { cerebrum: null, existing: [] });

  test.each([
    [
      "a compliant run",
      0,
      okStream(SAMPLE_DIGEST),
      { kind: "ok", output: SAMPLE_DIGEST, model: "claude-haiku-5-5", costUsd: 0.0123 },
    ],
    [
      "a result on another provider",
      0,
      otherProviderStream(SAMPLE_DIGEST),
      { kind: "stopped", reason: "credential" },
    ],
    [
      "a result on no provider",
      0,
      noProviderStream(SAMPLE_DIGEST),
      { kind: "stopped", reason: "credential" },
    ],
    ["a Not logged in stream", 1, notLoggedInStream(), { kind: "stopped", reason: "login" }],
    [
      "plain Not logged in text",
      1,
      [NOT_LOGGED_IN_RAW.trimEnd()],
      { kind: "stopped", reason: "login" },
    ],
    ["a 401", 1, status401Stream(), { kind: "stopped", reason: "login" }],
    ["a 403", 1, status403Stream(), { kind: "stopped", reason: "login" }],
    ["a digest quoting the login error", 0, okStream(QUOTING), { kind: "ok", output: QUOTING }],
    [
      "output that fails the schema",
      0,
      invalidOutputStream(),
      { kind: "rejected", detail: "claude -p structured output failed the schema" },
    ],
    ["hitting max turns", 1, maxTurnsStream(), { kind: "rejected" }],
    ["a refusal", 0, refusalStream(), { kind: "rejected" }],
    ["an API error", 1, status500Stream(), { kind: "retry" }],
    [
      "a run with no result line",
      0,
      okStream(SAMPLE_DIGEST).filter((l) => JSON.parse(l).type !== "result"),
      { kind: "retry" },
    ],
  ] as const)("%s", (_, code, lines, expected) => {
    expect(classify({ code, stdout: lines.join("\n") + "\n" }, validate)).toMatchObject(expected);
  });
});
