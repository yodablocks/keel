# keel

**A durable execution engine for AI agents, in TypeScript on Postgres.**

keel runs background jobs and multi-step agent workflows so they survive crashes, retry intelligently, stay within budget, and hand off to a person when they should.

[![CI](https://github.com/yodablocks/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/yodablocks/keel/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-experimental-orange)

---

## Why keel

Most job engines treat an AI agent as just another long-running job: when a step fails, they retry it. Agents fail in ways that make blind retries wrong:

- A **hallucinated tool call** won't fix itself on retry. The model needs to be told what it got wrong.
- A **refund over an approval limit** shouldn't be retried at all. A person has to decide.
- A **runaway agent** can burn through an LLM budget faster than any rate limit notices.

keel works out *why* a step failed and acts on it. It treats tokens and dollars as a scheduling resource, and makes human approval a normal part of a workflow.

## Features

| | |
|---|---|
| **Durable steps** | `ctx.step.run()` stores each step's result. After a crash or retry, completed steps replay from storage instead of running again. |
| **Failure classification** | Every failure is classified as `transient`, `bad_input`, `bad_output`, `needs_human`, `over_budget` or `fatal`, and a policy picks the action: back off, retry with a corrective hint, fail, or escalate. |
| **Jev classifier** | An optional classifier that reads error *messages*, not just status codes, using [TypeSafe's Jev](https://docs.typesafe.ai) model, with a rule-based fallback. |
| **Budgets** | Per-run budgets stop a run before its next step. Tenant daily budgets defer runs instead of failing them. |
| **Human in the loop** | Approvals inside workflows, and escalated failures that wait for a reviewer's decision. |
| **Safe side effects** | Each step gets a stable idempotency key, so a step re-run after a crash can't charge a card twice. |
| **Waits and events** | Durable sleeps and waits for external events that free the worker in the meantime. |
| **Crash safety** | Postgres `SKIP LOCKED` claims, leases with heartbeats, fenced writes, and dead-lettering of runs that keep crashing their workers. |

## Quick start

Requires Node.js 24+, pnpm 10+ and Docker.

```sh
git clone git@github.com:yodablocks/keel.git && cd keel
pnpm install
cp .env.example .env          # optionally add TYPESAFE_API_KEY for the Jev classifier
pnpm db:up && pnpm db:migrate # Postgres 17 on localhost:5433
pnpm demo --offline           # the end-to-end agent demo, no API key needed
```

## Example

```ts
import { createEngine } from "./src/index.ts"; // not published to npm yet

const engine = createEngine({ connectionString: process.env.DATABASE_URL! });

const worker = engine.createWorker({
  queue: "agents",
  tasks: {
    refund: async ({ orderId, amount }, ctx) => {
      const order = await ctx.step.run("load-order", () => orders.get(orderId));

      if (amount > 500) {
        const decision = await ctx.approval.request("manager-ok", {
          prompt: `Refund $${amount} for order ${orderId}?`,
          timeoutMs: 24 * 3600_000,
        });
        if (decision.status !== "approved") return decision.status;
      }

      return ctx.step.run("refund", ({ idempotencyKey }) =>
        payments.refund(order.chargeId, amount, { idempotencyKey }),
      );
    },
  },
});
worker.start();

await engine.enqueue("refund", { orderId: 42, amount: 900 }, { queue: "agents", budget: { usd: 2 } });
```

If the worker crashes after `load-order`, another worker resumes the run without loading the order again. While the run waits for approval it holds no worker at all.

See the **[guide](docs/guide.md)** for every feature: steps, waits, budgets, the classifier, approvals, and the rules that keep replay correct.

## How it works

Runs are rows in Postgres. Workers claim them with `FOR UPDATE SKIP LOCKED` and hold a lease that heartbeats extend. Completed steps, waits and usage are stored per run, so any worker can resume any run by replaying its handler.

```mermaid
stateDiagram-v2
    [*] --> queued: enqueue
    queued --> running: worker claims (lease)
    running --> completed: handler returns
    running --> queued: transient failure, backoff
    running --> waiting: wait, approval, escalation, tenant over budget
    waiting --> running: timer due, event, decision, budget allows
    running --> running: lease expired, another worker resumes
    running --> failed: policy stops (bad input, bug, rejected)
    running --> dead: maxAttempts exhausted
    completed --> [*]
    failed --> [*]
    dead --> [*]
```

When a handler throws, the error goes through a **classifier** (what kind of failure is this?) and then a **policy** (what should happen?):

| Failure | Kind | Default action |
|---|---|---|
| HTTP 408/429/5xx, timeouts, connection resets | `transient` | retry with exponential backoff and full jitter |
| Model output that can't be used (invalid JSON, unknown tool) | `bad_output` | retry at once, with the error passed to the handler as `ctx.hint` |
| Invalid input (HTTP 400/422, validation errors) | `bad_input` | fail |
| Approval limits, refusals, missing permissions | `needs_human` | escalate to a reviewer |
| Run over its budget | `over_budget` | escalate to a reviewer |
| Anything else | `fatal` | fail |

## Demo

`pnpm demo` runs one agent (research, plan, draft, send, follow-up) across two worker processes, with a scripted fake model and tools that misbehave on cue. In a single run:

1. **Hallucinated tool.** The model calls `serch_web`. Jev classifies the plain error as `bad_output` (confidence 0.96), and the retry's hint fixes the plan.
2. **Crash.** Worker A is `SIGKILL`ed mid-draft. Worker B resumes, and the earlier steps are replayed from storage, not called again.
3. **Rate limit.** The email API returns 429. The run backs off and retries with the same idempotency key.
4. **Over budget.** The run has spent $0.13 of its $0.125 budget, so it escalates instead of failing.
5. **Approval.** A reviewer raises the budget and approves, and the run completes.

The full recording, made with real Jev, is in [docs/demo-transcript.txt](docs/demo-transcript.txt). `pnpm test` runs the offline version and checks every moment.

## Failure classification: rules vs Jev

`pnpm eval:classifier` on 30 hand-labelled agent failures (`jev-latest`, September 2026):

| Classifier | Accuracy |
|---|---|
| Rules only (status codes, error codes, error classes) | 14 / 30 (47%) |
| Jev | 29 / 30 (97%) |
| keel cascade (rules for explicit signals, Jev for the rest, rules below 0.5 confidence) | 29 / 30 (97%) |

Rules can only read status and error codes; Jev also reads the message. The single miss is a genuinely ambiguous tool-argument error.

**Caveat:** the eval set is synthetic, and it was written and labelled by the same author as the classifier prompt. It shows the mechanism works, not how it will perform on your production failures. Full results are in [`eval-results/`](eval-results/).

## Status and limitations

keel is an **experimental project**, and the name is not final. All planned milestones are implemented and tested ([PLAN.md](PLAN.md)), but it hasn't been used in production. Known limitations include:

- Budgets can overshoot by one step, because a step's cost is known only after it runs.
- Idempotency keys protect external calls only for services that accept them.
- Steps, idempotency keys and spend records are never cleaned up; there is no retention job yet.
- A single Postgres instance is the throughput ceiling (thousands of jobs per second).
- There is no dashboard. Run state is available through `getRun` and SQL.

The full list is under [Known risks](PLAN.md#known-risks), each tagged with the milestone that addresses it.

**Roadmap:** phase 2 (hardening, classification with step context, budget fallbacks, a dashboard, a serverless mode, a benchmark and packaging) is planned in [PLAN.md](PLAN.md#phase-2-production-readiness-planned), along with the deliberate [non-goals](PLAN.md#non-goals).

## Development

```sh
pnpm test        # node:test against the real Postgres from docker-compose (no database mocks)
pnpm typecheck   # tsc --noEmit
pnpm db:migrate  # applies db/migrations/*.sql in order
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the type check and the full test suite against Postgres 17 on every pull request and every push to `main`.

Node runs the TypeScript sources directly, so there is no build step. Tests include real crash recovery: worker processes are killed with `SIGKILL` mid-run.

```
src/          engine, failure classification, Jev classifier, migrations
db/           SQL migrations
test/         unit, integration and crash tests
scripts/      demo, classifier eval, migrate
docs/         guide and demo transcript
PLAN.md       milestones, acceptance criteria, known risks
```

## License

[MIT](LICENSE)
