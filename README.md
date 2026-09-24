# keel

> Working name, not final.

An agent-native durable execution engine for TypeScript, backed by Postgres.

Most job engines treat an AI agent as just a long-running job and retry on any error. Keel's goal is to understand *why* a step failed (transient, bad input, hallucinated output, needs a human) and act on that, and to treat tokens and dollars as a scheduling resource.

Status: **M8 done** (queue with leases, retries, failure classification, idempotency keys, durable steps, waits, budgets, Jev classifier, safe side effects, approvals). See [PLAN.md](PLAN.md) for milestones and acceptance tests.

## Requirements

- Node 24+ (runs `.ts` files directly via type stripping)
- pnpm 10+
- Docker (for Postgres)

## Setup

```sh
pnpm add pg
pnpm add -D typescript @types/node @types/pg
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm test
pnpm typecheck
```

Postgres listens on `localhost:5433` to avoid clashing with a local install.

## Usage

```ts
import { BadOutputError, createEngine, defaultPolicy } from "./src/index.ts";

const engine = createEngine({ connectionString: process.env.DATABASE_URL! });

const worker = engine.createWorker({
  queue: "agents",
  policy: defaultPolicy({ baseMs: 1000, maxMs: 60_000 }),
  tasks: {
    research: async (payload, ctx) => {
      // ctx.attempt starts at 1. ctx.hint is set when the last attempt produced bad output.
      const answer = await callModel(payload, ctx.hint);
      if (!isValidToolCall(answer)) throw new BadOutputError(`unknown tool "${answer.tool}"`);
      return answer;
    },
  },
});
worker.start();

const { id } = await engine.enqueue("research", { topic: "durable execution" }, { queue: "agents", maxAttempts: 5 });
const run = await engine.getRun(id); // status, attempt, result, errors[] (one entry per failed attempt)

// Idempotency: while the key is live (default 24h), the same task and key return the existing run.
const { id: chargeId, created } = await engine.enqueue("charge", { orderId: 42 }, { idempotencyKey: "order-42" });
```

How failures are handled by default (`RuleClassifier` + `defaultPolicy`):

| Failure | Kind | Action |
|---|---|---|
| HTTP 408/429/5xx, network timeouts and resets | transient | retry with exponential backoff and full jitter |
| `BadOutputError` | bad_output | retry at once, with the error passed as `ctx.hint` |
| HTTP 400/422, `ZodError`, `BadInputError` | bad_input | fail, no retry |
| `NeedsHumanError` | needs_human | escalate to a person (see [Approvals and escalation](#approvals-and-escalation)) |
| anything else | fatal | fail, no retry |
| worker crashed or lost its lease | transient | retry, recorded as `LeaseExpired` |

Statuses: `failed` means the policy chose not to retry. `dead` means `maxAttempts` ran out. Pass your own `classifier` or `policy` to `createWorker` to change any of this.

## Durable steps

```ts
tasks: {
  agent: async (payload, ctx) => {
    const plan = await ctx.step.run("plan", () => callModel(payload));
    const draft = await ctx.step.run("draft", () => writeDraft(plan));
    return ctx.step.run("send", () => sendEmail(draft));
  },
}
```

If the run retries or its worker crashes during `send`, the next attempt gets `plan` and `draft` from storage without calling them again.

Rules that keep replay correct:

- **Put every non-deterministic call inside a step**: LLM calls, API calls, `Date.now()`, `Math.random()`. Code between steps runs again on every attempt, so it must produce the same step sequence each time.
- **Step names must be unique within a run.** In loops, include the index: `` ctx.step.run(`fetch-${i}`, ...) ``. A repeated name throws `DuplicateStepError`.
- **Results must be JSON-serializable.** They are JSON round-tripped on the first run too, so a `Date` is a string both times and `undefined` becomes `null`.
- **A step that crashes before finishing runs again**, including its side effects. Make external calls idempotent where you can.

## Waits

```ts
tasks: {
  refund: async ({ orderId }, ctx) => {
    await ctx.wait.for("cool-off", 60 * 60_000); // worker is freed for the hour
    const approval = await ctx.wait.forEvent("approval", `approved:${orderId}`, { timeoutMs: 24 * 3600_000 });
    if (approval.timedOut) return "expired";
    return ctx.step.run("refund", () => issueRefund(orderId, approval.payload));
  },
}

await engine.sendEvent("approved:42", { by: "alice" });
```

- A waiting run has status `waiting` and holds no worker. It resumes by replay, so the durable step rules apply.
- Events wake only waits that already exist. An event sent before the run reaches `forEvent` is not delivered; use a timeout.
- Waits suspend the run by throwing `RunSuspended`. See [Control-flow errors](#control-flow-errors).

## Budgets

```ts
await engine.setTenantBudget("acme", { usdPerDay: 50 });
await engine.enqueue("agent", payload, { tenant: "acme", budget: { usd: 2 } });

tasks: {
  agent: async (payload, ctx) => {
    const answer = await ctx.step.run("llm", () => callModel(payload), {
      usage: (r) => ({ usd: r.costUsd, tokens: r.totalTokens }),
    });
    // ...
  },
}

(await engine.getRun(id)).usage; // { usd, tokens }
```

- **Per-run budget:** checked before each new step. A run over its budget stops as `over_budget`, which the default policy escalates to a person.
- **Tenant daily budget** (UTC day): the tenant's runs are deferred, not failed. Queued runs wait, and running runs pause as `waiting` at their next step. They continue the next day, or as soon as you raise the limit.
- Budgets can overshoot by up to one step, because a step's cost is known only after it runs.

## Jev failure classifier

`JevClassifier` reads the error message, not just status codes, using [TypeSafe's Jev](https://docs.typesafe.ai) model. keel does not depend on the SDK; you pass the client in.

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk"; // reads TYPESAFE_API_KEY

const worker = engine.createWorker({
  queue: "agents",
  classifier: new JevClassifier({ client: new TypeSafeClient(), minConfidence: 0.5 }),
  tasks: { /* ... */ },
});
```

It is a cascade:

1. Explicit signals (keel error classes like `BadOutputError`, `OverBudgetError`) are classified by rules. No API call.
2. Everything else is one Jev Choice question over `transient / bad_input / bad_output / needs_human / fatal`, given the task, attempt, error (name, message, status, code, cause) and a truncated payload.
3. If Jev's confidence is below `minConfidence`, or the call fails, the rule verdict is used. A TypeSafe outage never breaks failure handling.

### Eval: rules vs Jev

`pnpm eval:classifier` on 30 hand-labelled failures (`scripts/failure-cases.ts`), `jev-latest`, run 2026-09-24:

| Classifier | Correct | Accuracy |
|---|---|---|
| `RuleClassifier` | 14 / 30 | 47% |
| Jev, raw answer | 29 / 30 | 97% |
| `JevClassifier` cascade (threshold 0.5) | 29 / 30 | 97% |

- Rules get the cases with a status or error code right and call everything else `fatal`. Jev also classifies the ones whose meaning is only in the message: "Request timed out", invalid JSON from a model, a hallucinated tool name, a refund over an approval limit, a model refusal.
- The one miss: "Tool call arguments failed validation: missing required property 'query'" (labelled `bad_output`). Jev said `bad_input` with confidence 0.38, below the threshold, so the cascade used the rule verdict (`fatal`), also wrong. The case is genuinely ambiguous without knowing who produced the arguments.
- 3 of 30 answers were below the 0.5 threshold. The other two were `fatal` cases where rules agreed.
- Cost: 30 calls, 19,613 input and 1,768 output tokens in total.
- **Caveat:** the cases are synthetic and were written and labelled by the same author as the classifier question, and 16 of 30 carry their meaning only in the message text, where rules cannot win. This shows the mechanism works; measure it on your own production failures before relying on the numbers. Full results: `eval-results/classifier-2026-09-24T06-04-37.json`.

## Side effects

Every step function receives an idempotency key that is the same on every attempt and every worker:

```ts
await ctx.step.run("charge", ({ idempotencyKey, signal }) =>
  stripe.paymentIntents.create({ amount: 90000, currency: "usd" }, { idempotencyKey }),
);
```

If a worker crashes after the charge but before keel stores the result, the step runs again, with the same key, and the payment API returns the first charge instead of making a second. keel cannot tell whether the first call arrived, so this only protects services that accept idempotency keys.

`ctx.signal` (also passed to steps) aborts when this worker no longer owns the run. Pass it to `fetch` and SDK calls.

## Approvals and escalation

```ts
tasks: {
  refund: async ({ orderId, amount }, ctx) => {
    const decision = await ctx.approval.request("refund-ok", {
      prompt: `Approve a refund of $${amount} for order ${orderId}?`,
      timeoutMs: 24 * 3600_000,
    });
    if (decision.status !== "approved") return decision.status; // "rejected" or "timed_out"
    return ctx.step.run("refund", ({ idempotencyKey }) => issueRefund(orderId, amount, idempotencyKey));
  },
}

const worker = engine.createWorker({
  queue: "payments",
  tasks,
  onApprovalRequested: (a) => slack.post(`#approvals`, `${a.prompt} (run ${a.runId})`),
});

// reviewer side
const pending = await engine.listPendingApprovals();
await engine.resolveApproval(runId, "refund-ok", { approved: true, by: "alice", comment: "VIP customer" });
```

**Escalation:** when the failure policy escalates (by default `NeedsHumanError` and `OverBudgetError`), the run waits for a person the same way, as an approval named `escalation-<attempt>`. Approving retries it once more, even past `maxAttempts`, with the reviewer's comment as `ctx.hint`. Rejecting it, or no answer within `escalationTimeoutMs` (default 24 hours), fails the run.

## Control-flow errors

`ctx.step.run` and `ctx.wait.*` can throw two errors that are signals to the engine, not failures:

- `RunSuspended`: the run is pausing (a wait, or its tenant hit a budget mid-run)
- `LeaseLostError`: another worker owns the run now

If you catch errors around a step or a wait, rethrow these:

```ts
try {
  return await ctx.step.run("llm", () => callModel(prompt));
} catch (err) {
  if (err instanceof RunSuspended || err instanceof LeaseLostError) throw err;
  return fallbackAnswer();
}
```

Swallowing them lets the handler carry on, so a paused run can complete with steps skipped.

## TypeScript notes

Code is run by Node without a build step, so it must use erasable syntax only: no `enum`, no `namespace`, no constructor parameter properties. Relative imports use the `.ts` extension. `tsc` is used for typechecking only.
