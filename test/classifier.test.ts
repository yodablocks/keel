import { test } from "node:test";
import assert from "node:assert/strict";
import { BadOutputError, NeedsHumanError, NO_SIGNAL_CONFIDENCE, RuleClassifier } from "../src/index.ts";

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
  ["fetch failed, with the network code on its cause", new TypeError("fetch failed", { cause: codeError("ECONNREFUSED") }), "transient"],
  ["422 unprocessable input", httpError(422), "bad_input"],
  ["zod validation failure", named("ZodError"), "bad_input"],
  ["model returned unusable output", new BadOutputError("tool name does not exist"), "bad_output"],
  ["handler asks for a human", new NeedsHumanError("refund over limit"), "needs_human"],
  ["401 bad credentials", httpError(401), "fatal"],
  ["plain bug", new TypeError("cannot read properties of undefined"), "fatal"],
  ["fetch failed, with an unknown code on its cause", new TypeError("fetch failed", { cause: codeError("ENOTFOUND") }), "fatal"],
  ["thrown string", "oops", "fatal"],
];

for (const [label, error, kind] of cases) {
  test(`rule classifier: ${label} is ${kind}`, async () => {
    const verdict = await new RuleClassifier().classify({ error, task: "t", attempt: 1, maxAttempts: 3, payload: {} });
    assert.equal(verdict.kind, kind);
    assert.ok(verdict.confidence > 0 && verdict.confidence <= 1);
  });
}

test("rules mark a verdict without an explicit signal with NO_SIGNAL_CONFIDENCE, and only those", async () => {
  const rules = new RuleClassifier();
  const classify = (error: unknown) => rules.classify({ error, task: "t", attempt: 1, maxAttempts: 3, payload: {} });
  assert.equal((await classify(new Error("something odd happened"))).confidence, NO_SIGNAL_CONFIDENCE);
  assert.equal((await classify("oops")).confidence, NO_SIGNAL_CONFIDENCE);
  for (const [, error] of cases.filter(([label]) => label !== "plain bug" && label !== "thrown string" && !label.includes("unknown code"))) {
    assert.ok((await classify(error)).confidence > NO_SIGNAL_CONFIDENCE, `${String(error)} carries a signal`);
  }
});
