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
