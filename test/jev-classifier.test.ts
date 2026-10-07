import { test } from "node:test";
import assert from "node:assert/strict";
import { BadOutputError, JevClassifier } from "../src/index.ts";
import type { FailureContext, SystemOneClient } from "../src/index.ts";

type Probabilities = Record<string, number>;

// Stands in for TypeSafeClient: records requests and answers with a fixed distribution.
function fakeClient(probabilities: Probabilities, confidence: number) {
  const requests: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
  const client: SystemOneClient = {
    async systemOne(request) {
      requests.push(request);
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
      return { answers: { failure_kind: { type: "choice", choice, probabilities, confidence } } };
    },
  };
  return { client, requests };
}

function ctx(error: unknown): FailureContext {
  return { error, task: "research-agent", payload: { topic: "durable execution" }, attempt: 1, maxAttempts: 3 };
}

test("an explicit error class is classified by rules without calling Jev", async () => {
  const { client, requests } = fakeClient({ transient: 1 }, 1);

  const verdict = await new JevClassifier({ client }).classify(ctx(new BadOutputError('unknown tool "serch_web"')));

  assert.deepEqual(verdict, { kind: "bad_output", confidence: 1 });
  assert.equal(requests.length, 0);
});

test("an ambiguous failure is classified by Jev from the error and run context", async () => {
  const { client, requests } = fakeClient({ transient: 0.03, bad_input: 0.02, bad_output: 0.9, needs_human: 0.02, fatal: 0.03 }, 0.87);

  const verdict = await new JevClassifier({ client }).classify(
    ctx(new Error("Model requested tool `serch_web`, which is not in the provided tool list")),
  );

  assert.deepEqual(verdict, { kind: "bad_output", confidence: 0.87 });
  assert.equal(requests.length, 1);
  const sent = JSON.stringify(requests[0]!.state);
  assert.match(sent, /serch_web/);
  assert.match(sent, /research-agent/);
  const question = requests[0]!.questions.failure_kind as { type: string; criteria: Record<string, unknown> };
  assert.equal(question.type, "choice");
  assert.deepEqual(Object.keys(question.criteria).sort(), ["bad_input", "bad_output", "fatal", "needs_human", "transient"]);
});

test("a low-confidence Jev answer falls back to the rule verdict", async () => {
  const { client } = fakeClient({ transient: 0.4, bad_input: 0.1, bad_output: 0.1, needs_human: 0.1, fatal: 0.3 }, 0.25);
  const rateLimited = Object.assign(new Error("Rate limit reached"), { status: 429 });

  const verdict = await new JevClassifier({ client, minConfidence: 0.5 }).classify(ctx(rateLimited));

  assert.deepEqual(verdict, { kind: "transient", confidence: 0.9 }, "the rule verdict, not Jev's");
});

test("when Jev is unavailable the rule verdict is used instead of failing the classification", async () => {
  const client: SystemOneClient = {
    async systemOne() {
      throw Object.assign(new Error("TypeSafe is overloaded"), { status: 529 });
    },
  };

  const verdict = await new JevClassifier({ client }).classify(ctx(new TypeError("cannot read properties of undefined")));

  assert.deepEqual(verdict, { kind: "fatal", confidence: 0.5 });
});

test("the error's cause is sent to Jev, since fetch hides network errors behind it", async () => {
  const { client, requests } = fakeClient({ transient: 0.95, fatal: 0.05 }, 0.9);
  const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:443"), { code: "ECONNREFUSED" });

  await new JevClassifier({ client }).classify(ctx(new TypeError("fetch failed", { cause: refused })));

  assert.match(JSON.stringify(requests[0]!.state), /ECONNREFUSED 10\.0\.0\.5:443/);
});

test("Jev is told which step failed and what the model produced", async () => {
  const { client, requests } = fakeClient({ bad_output: 0.9, bad_input: 0.1 }, 0.8);

  await new JevClassifier({ client }).classify({
    ...ctx(new Error("Tool call arguments failed validation: missing required property 'query'")),
    step: "choose-tool",
    output: { tool: "search_web", arguments: {} },
  });

  const state = requests[0]!.state as { step?: unknown; output?: unknown };
  assert.equal(state.step, "choose-tool");
  assert.match(String(state.output), /"tool":"search_web"/);
});
