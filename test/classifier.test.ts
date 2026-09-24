import { test } from "node:test";
import assert from "node:assert/strict";
import { BadOutputError, NeedsHumanError, RuleClassifier } from "../src/index.ts";

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}
function codeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}
function named(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const cases: Array<[label: string, error: unknown, kind: string]> = [
  ["503 from an upstream API", httpError(503), "transient"],
  ["429 rate limit", httpError(429), "transient"],
  ["statusCode instead of status", Object.assign(new Error("x"), { statusCode: 502 }), "transient"],
  ["socket timeout", codeError("ETIMEDOUT"), "transient"],
  ["connection reset", codeError("ECONNRESET"), "transient"],
  ["fetch timeout", named("TimeoutError"), "transient"],
  ["422 unprocessable input", httpError(422), "bad_input"],
  ["zod validation failure", named("ZodError"), "bad_input"],
  ["model returned unusable output", new BadOutputError("tool name does not exist"), "bad_output"],
  ["handler asks for a human", new NeedsHumanError("refund over limit"), "needs_human"],
  ["401 bad credentials", httpError(401), "fatal"],
  ["plain bug", new TypeError("cannot read properties of undefined"), "fatal"],
  ["thrown string", "oops", "fatal"],
];

for (const [label, error, kind] of cases) {
  test(`rule classifier: ${label} is ${kind}`, async () => {
    const verdict = await new RuleClassifier().classify({ error, task: "t", attempt: 1, maxAttempts: 3, payload: {} });
    assert.equal(verdict.kind, kind);
    assert.ok(verdict.confidence > 0 && verdict.confidence <= 1);
  });
}
