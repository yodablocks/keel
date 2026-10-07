import { test } from "node:test";
import assert from "node:assert/strict";
import { cost, PRIMARY, score } from "../scripts/eval-costs.ts";
import type { Action } from "../scripts/eval-costs.ts";

test("the cost matrix matches the table in eval-sets/COSTS.md", () => {
  const actions: Action[] = ["retry", "retry_modified", "fail", "escalate"];
  const table = actions.map((right) => actions.map((chosen) => cost(right, chosen)));
  assert.deepEqual(table, [
    [0, 1, 5, 2],
    [2, 0, 5, 2],
    [1, 1, 0, 2],
    [20, 20, 5, 0],
  ]);
});

test("score adds costs by action, so two kinds with the same action are not a miss", () => {
  const result = score([
    ["fatal", "bad_input"], // both fail
    ["transient", "fatal"], // lost run
    ["needs_human", "transient"], // acted without approval
    ["fatal", "bad_output"], // wasted attempts
  ]);
  assert.equal(result.cost, PRIMARY.lostRun + PRIMARY.actedWithoutApproval + PRIMARY.wastedAttempts);
  assert.deepEqual(result.misses, { "retry->fail": 1, "escalate->retry": 1, "fail->retry_modified": 1 });
});
