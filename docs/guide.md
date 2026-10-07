# keel guide

Reference for every keel feature. For an overview, start with the [README](../README.md).

- [Tasks, workers and runs](#tasks-workers-and-runs)
- [Durable steps](#durable-steps)
- [Waits](#waits)
- [Budgets](#budgets)
- [Jev failure classifier](#jev-failure-classifier)
- [Side effects](#side-effects)
- [Approvals and escalation](#approvals-and-escalation)
- [Control-flow errors](#control-flow-errors)
- [Serverless and cron: runOnce](#serverless-and-cron-runonce)
- [Operations: retention and sweeps](#operations-retention-and-sweeps)
- [Inspecting runs and the dashboard](#inspecting-runs-and-the-dashboard)
- [Engine options](#engine-options)
- [TypeScript notes](#typescript-notes)

## Tasks, workers and runs

```ts
import { BadOutputError, createEngine, defaultPolicy } from "./src/index.ts"; // not published to npm yet

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

- **Per-run budget:** checked before each new step. A run over its budget stops as `over_budget`, which the default policy escalates to a person, or falls back to a cheaper model (below).
- **Tenant daily budget** (UTC day): the tenant's runs are deferred, not failed. Queued runs wait, and running runs pause as `waiting` at their next step. They continue the next day, or as soon as you raise the limit.
- Budgets can overshoot by up to one step, because a step's cost is known only after it runs.

### Task budgets

```ts
await engine.setTaskBudget("research-agent", {
  usdPerRun: 0.5, // default for runs of this task enqueued without their own budget
  usdPerDay: 20, // across all runs of this task
});
```

- `usdPerRun` / `tokensPerRun` apply to runs without an explicit `budget`; an explicit budget always wins.
- `usdPerDay` / `tokensPerDay` defer the task's runs exactly like a tenant's daily budget. A run is held back while **either** its tenant or its task is at a limit.

### Falling back to a cheaper model

```ts
const worker = engine.createWorker({
  queue: "agents",
  policy: defaultPolicy({ fallback: { target: "gpt-4o-mini", extendBudget: { usd: 0.1 } } }),
  tasks: {
    agent: async (payload, ctx) => {
      const model = ctx.fallback ?? "gpt-4o"; // "gpt-4o-mini" once the run has fallen back
      return ctx.step.run("answer", () => callModel(model, payload), { usage: (r) => ({ usd: r.costUsd }) });
    },
  },
});
```

- When a run goes over its budget, the policy answers with a `fallback` action: the engine adds `extendBudget` to the run's budget, records the fallback on the run, and retries. `ctx.fallback` stays set for every later attempt.
- The default policy falls back **once**. A run that goes over budget again on the fallback escalates to a person.
- A fallback is a retry, so it counts toward `maxAttempts`.
- Custom policies can return `{ type: "fallback", target, extendBudget? }` for any failure kind, for example to switch to a stronger model after repeated `bad_output`.

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
2. Everything else is one Jev Choice question over `transient / bad_input / bad_output / needs_human / fatal`, given the task, the failing step, the attempt, the error (name, message, status, code, cause), the rejected output and a truncated payload.
3. If Jev's confidence is below `minConfidence`, or the call fails, the rule verdict is used. A TypeSafe outage never breaks failure handling.

### Give the classifier context

keel records which step's function threw. Attach what the model produced to the error, so both the classifier and the run's error history see it:

```ts
const reply = await ctx.step.run("choose-tool", async () => {
  const reply = await callModel(prompt);
  if (!TOOLS.includes(reply.tool)) {
    throw new BadOutputError(`unknown tool "${reply.tool}"`, { output: reply });
  }
  return reply;
});
```

Any error with an `output` property works the same way. Each entry in `run.errors` keeps `step`, `status`, `code`, `cause` and `output` (large outputs are stored as a truncated JSON string).

### Build an eval set from real failures

```sh
pnpm eval:export --queue agents --since 2026-09-01   # writes eval-results/exported-<date>.json
# set each case's "label" to the kind a person would choose
pnpm eval:classifier --cases eval-results/exported-<date>.json
```

Each exported case includes `recordedKind`, what keel decided at the time, for reference. Don't copy it into `label`: that would score the classifier against itself. Unlabelled cases are skipped. Engine-generated entries (`LeaseExpired`, `Released`) are not exported.

Accuracy on the synthetic set is in the [README](../README.md#failure-classification-rules-vs-jev).

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

## Serverless and cron: runOnce

A long-lived `worker.start()` is optional. Any process can resume any run, so a short-lived one can do the work in slices:

```ts
// A serverless function with a 30 second timeout, triggered every minute by a scheduler.
export async function handler() {
  const worker = engine.createWorker({ queue: "agents", tasks });
  const result = await worker.runOnce({ deadlineMs: 25_000 });
  return result; // { claimed, completed, failed, suspended, yielded, lost }
}
```

- `runOnce` runs one maintenance pass (the budget sweep, and retention if configured), then claims and executes runs one at a time until nothing is due, `maxRuns` is reached, or the deadline nears.
- `releaseMarginMs` (default 1s) before the deadline, the current run is **yielded**: released so the next call resumes it from its last stored step. `ctx.signal` aborts, so pass it to your model and API calls.
- A yield after at least one new step was stored does **not** use up an attempt. A yield without progress does, recorded as `Released`, so a single step that never fits in the deadline ends up `dead` instead of looping.
- Waits and approvals need nothing special: a waiting run holds no worker, and a later call picks it up when it is due.
- Keep each step shorter than your deadline. A step interrupted by the deadline re-runs from its start on the next call; use its idempotency key for side effects.
- A worker is either started or driven by `runOnce`, not both.

## Operations: retention and sweeps

```ts
// Delete finished runs (completed, failed, dead) with their steps, waits and idempotency keys.
await engine.purge({ olderThan: new Date(Date.now() - 30 * 24 * 3600_000), queue: "agents" });

// Or let each worker purge its own queue.
engine.createWorker({
  queue: "agents",
  tasks,
  retention: { keepMs: 30 * 24 * 3600_000, everyMs: 3600_000 },
  sweepEveryMs: 1000, // default
});
```

- `purge` never touches queued, running or waiting runs. Without a `queue`, it also deletes tenant daily spend rows older than the cutoff.
- Every `sweepEveryMs`, a worker sweeps its queue: runs whose final attempt lost its lease go `dead`, and runs of tenants over their daily budget are parked until the next UTC midnight (`run.runAfter` shows when). Raising the tenant's budget releases them at once.
- A worker stopped with `stop({ timeoutMs })` records a `Released` error on the run it gave up; that attempt counts toward `maxAttempts`.
- A failure policy that throws or returns an invalid action fails the run, with `Policy error: ...` as the reason.

## Inspecting runs and the dashboard

```ts
await engine.listRuns({ queue: "agents", status: "waiting", tenant: "acme", limit: 50 }); // newest first
await engine.getRunDetail(runId); // { run, steps, waits }: results, costs, attempts, approvals and their decisions
await engine.listPendingApprovals({ queue: "agents" }); // filters are optional
```

`pnpm dashboard [--port 4400] [--host 127.0.0.1]` serves the same data as HTML:

- **Runs:** counts by status, pending approvals (newest first, scoped to the current filters), and a filterable run list. Refreshes every 5 seconds.
- **Run logbook:** steps, failures (kind, confidence, action, step, status, output) and waits in time order, plus payload and result. A pending approval or escalation shows an Approve/Reject form; the page stops refreshing while a form is open.
- **Security:** no login, so keep it on loopback. There is no JavaScript (the Content Security Policy forbids scripts), every value is HTML-escaped by a template that escapes by default, decisions need a per-process form token and a same-origin request, and on loopback requests for other hostnames are refused (DNS rebinding). Binding to another host prints a warning.

To embed it in your own process: `const dashboard = await startDashboard({ engine, port: 4400 })`, then `dashboard.close()`.

## Engine options

```ts
createEngine({ connectionString, poolSize: 20 }); // poolSize: max Postgres connections, default 10
```

Each worker uses a connection while it claims, heartbeats and writes. Give the engine at least as many connections as it has concurrently busy workers, and keep the total across all processes under Postgres's `max_connections` (100 by default).

## TypeScript notes

In development, Node runs the `.ts` sources directly, so they must use erasable syntax only: no `enum`, no `namespace`, no constructor parameter properties. Relative imports use the `.ts` extension. `pnpm build` compiles `src/` to `dist/` for the package, rewriting those imports to `.js`; `pnpm typecheck` checks everything without emitting.
