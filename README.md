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
| **Failure classification** | Every failure is classified as `transient`, `bad_input`, `bad_output`, `needs_human`, `over_budget` or `fatal`, and a policy picks the action: back off, retry with a corrective hint, fall back to a cheaper model, fail, or escalate. |
| **Jev classifier** | An optional classifier that reads error *messages*, the failing step and the rejected model output, not just status codes, using [TypeSafe's Jev](https://docs.typesafe.ai) model, with a rule-based fallback. |
| **Budgets** | Per-run budgets stop a run before its next step, and can fall back to a cheaper model instead of stopping. Tenant and per-task daily budgets defer runs instead of failing them. |
| **Human in the loop** | Approvals inside workflows, and escalated failures that wait for a reviewer's decision. |
| **Safe side effects** | Each step gets a stable idempotency key, so a step re-run after a crash can't charge a card twice. |
| **Waits and events** | Durable sleeps and waits for external events that free the worker in the meantime. |
| **Dashboard** | `pnpm dashboard`: a run list, a logbook of each run (steps, costs, errors, decisions), and Approve/Reject for pending approvals. No dependencies, no JavaScript. |
| **Serverless mode** | `worker.runOnce({ deadlineMs })` works through due runs and returns, for cron jobs and serverless functions. A run cut off by the deadline resumes from its last stored step on the next call. |
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
import { createEngine } from "keel"; // see "Use it in your project" below

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

No long-lived process? Call `await worker.runOnce({ deadlineMs: 25_000 })` from a cron job or a serverless function instead of `worker.start()`.

See the **[guide](docs/guide.md)** for every feature: steps, waits, budgets, the classifier, approvals, and the rules that keep replay correct.

## Use it in your project

keel is not published to npm. Build a tarball and add it to your project:

```sh
cd keel && pnpm pack                        # builds dist/ and writes keel-0.0.0.tgz
cd ../your-app && pnpm add ../keel/keel-0.0.0.tgz pg
```

The package ships compiled JavaScript with type declarations, the SQL migrations, and the TypeScript sources for source maps. Run `migrate(connectionString)` once at startup, or `pnpm db:migrate` from the keel checkout.

## Dashboard

```sh
pnpm dashboard   # http://127.0.0.1:4400
```

![Run list with a pending approval](docs/images/dashboard-runs.png)

Each run has a logbook: steps with their cost, failures with how they were classified and what the policy did, and waits and decisions, in the order they happened. Pending approvals and escalations can be decided right there.

![A run waiting for approval](docs/images/dashboard-approval.png)

The dashboard has **no login**. It listens on `127.0.0.1` by default; don't expose it to a network. Pages allow no scripts, forms carry a per-process token, and requests for other hostnames are refused.

## Performance

`pnpm bench` on an Apple M4 (10 cores, 32 GB), Node 25, Postgres 17 in Docker on the same machine. Each run executes one durable step; 2,000 runs per configuration; all workers in **one Node process**:

| Workers | Runs per second |
|---|---|
| 1 | 445 to 471 |
| 2 | 861 to 873 |
| 4 | 1,365 to 1,442 |
| 8 | 1,618 to 1,683 |
| 16 | 1,897 to 1,904 |
| 32 | 1,974 to 2,023 |

Enqueue to completion on idle workers: **p50 26 ms, p99 51 to 55 ms**. That is mostly the default 50 ms polling interval.

- Throughput scales to 32 workers. An earlier version plateaued at 8 workers and dipped at 32. Profiling showed Node using under half of one core, and the cause was every step updating the same daily spend row per task. Spend is now sharded over 16 rows, which lifted 32 workers from about 1,600 to 2,000 runs per second, at the cost of about 12 to 15% at 4 to 8 workers.
- These are single-machine numbers with the database next to the workers, from a small number of runs each. Network latency to a managed Postgres, more workers per process, or heavier steps change them. Rerun `pnpm bench` on your own setup; raw results are in [`bench-results/`](bench-results/).

## How it works

Runs are rows in Postgres. Workers claim them with `FOR UPDATE SKIP LOCKED` and hold a lease that heartbeats extend. Completed steps, waits and usage are stored per run, so any worker can resume any run by replaying its handler.

```mermaid
stateDiagram-v2
    [*] --> queued: enqueue
    queued --> running: worker claims (lease)
    running --> completed: handler returns
    running --> queued: transient failure, backoff
    running --> waiting: wait, approval, escalation, tenant or task over budget
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
| Run over its budget | `over_budget` | fall back to a cheaper model once, if configured; otherwise escalate to a reviewer |
| Anything else | `fatal` | fail |

## Demo

`pnpm demo` runs one agent (research, plan, draft, send, follow-up) across two worker processes, with a scripted fake model and tools that misbehave on cue. In a single run:

1. **Hallucinated tool.** The model calls `serch_web`. Jev classifies the plain error as `bad_output` (confidence 0.97), and the retry's hint fixes the plan.
2. **Crash.** Worker A is `SIGKILL`ed mid-draft. Worker B resumes, and the earlier steps are replayed from storage, not called again.
3. **Rate limit.** The email API returns 429. The run backs off and retries with the same idempotency key.
4. **Over budget.** The run has spent $0.13 of its $0.125 budget, so it escalates instead of failing.
5. **Approval.** A reviewer raises the budget and approves, and the run completes.

The full recording, made with real Jev (`jev-1.13.0`, October 2026), is in [docs/demo-transcript.txt](docs/demo-transcript.txt); the September recording is kept as [docs/demo-transcript-2026-09.txt](docs/demo-transcript-2026-09.txt). `pnpm test` runs the offline version and checks every moment.

## Real use

`pnpm openroles:sync` runs a workload of mine through keel: it reads every job board that openroles, my own job
search tool, tracks, one run per board, against the live Ashby, Greenhouse and Lever APIs. First run, October 2026:

- 447 runs, 8,287 jobs read, 6 minutes at one request per second per host
- 446 completed, 1 failed: a Lever board that answered 404, which keel failed without retrying
- The first offline test of this workload found a bug: rules marked `fetch` network errors as `fatal`, because
  `fetch` puts the code on `error.cause`. Fixed before any eval was run

It is real work, but it is not an agent: there are no model steps, and nothing crashed. It shows the engine running
something other than the demo, not how classification performs in production.

## Failure classification: rules vs Jev

### 75 error messages from public issues

[`eval-sets/public-issues.json`](eval-sets/public-issues.json): error messages copied from GitHub issues of agent
and model SDKs (openai-node, anthropic-sdk-typescript, vercel/ai, langchainjs, openai-agents-js, the MCP SDK,
undici), each linked to its issue. I labelled them and committed the labels before any classifier ran.
`pnpm eval:classifier --cases eval-sets/public-issues.json`, `jev-1.13.0`, October 2026:

| Classifier | Right kind | Right action |
|---|---|---|
| Rules only | 28 / 75 (37%) | 38 / 75 (51%) |
| Jev alone | 50 to 51 / 75 (67 to 68%) | 63 to 64 / 75 (84 to 85%) |
| keel cascade (`JevClassifier`: rules for explicit signals, Jev for the rest, rules below 0.5 confidence) | 46 to 47 / 75 (61 to 63%) | 59 to 60 / 75 (79 to 80%) |

- Ranges are two passes over identical input in one run, so a difference of one case is run-to-run noise.
- **Right action** counts a verdict as right when keel's default policy would do the same thing as for the label:
  `bad_input` and `fatal` both fail. I chose this measure after seeing the results, so the kind column is the
  headline. 13 of Jev's 25 misses are between `fatal` and `bad_input`.
- Rules are wrong in the costly direction: 36 of their 37 wrong actions fail a run that should have been retried
  (14) or retried with a correction (22).
- **The cascade did worse than Jev alone.** Below 0.5 confidence it uses the rule verdict, and rules answer
  `fatal` when they see no explicit signal. That changed 7 verdicts here: 1 for the better, 4 for the worse, and 2
  wrong either way. Changing the fallback on the strength of this set would be tuning on the test set, so it is
  recorded under [Known risks](PLAN.md#classification) until a fresh set can check it.

**Caveats:** the messages were written by other people, but the labels are one person's, and that person wrote
the classifier prompt. Most errors were posted while developing, not hit in production. The mix has 1
`needs_human` case, so the set says almost nothing about escalation, and there is no step context. Details, and
the two labelling notes, are in [`eval-sets/README.md`](eval-sets/README.md).

### 30 synthetic cases

`pnpm eval:classifier` on 30 hand-labelled agent failures written for keel:

| Classifier | M7 (Sep 2026) | M11 (Sep 2026) | Oct 2026 (`jev-1.13.0`) |
|---|---|---|---|
| Rules only (status codes, error codes, error classes) | 14 / 30 (47%) | 14 / 30 (47%) | 15 / 30 (50%) |
| Jev, error and task only | 29 / 30 (97%) | 30 / 30 (100%) | 30 / 30 (100%) |
| Jev with the failing step and model output | | 30 / 30 (100%) | 30 / 30 (100%) |
| keel cascade | 29 / 30 (97%) | 30 / 30 (100%) | 30 / 30 (100%) |

- Rules gained one case in October because they now read the network code on `error.cause` (the `fetch failed` case).
- The M7 miss, an ambiguous tool-argument error, is classified correctly in the later runs even **without** step context, so the fix can't be credited to context alone. The M7 run did not record the concrete model version behind `jev-latest`, so a model update can't be ruled out; runs now record it.
- Step context raised confidence: on that ambiguous case from 0.60 to 0.75, and the mean across all 30 from 0.90 to 0.92 (up on 9 cases, down on 4). The public set above shows Jev varies by about one case in 75 between identical calls, so shifts this small may be noise.

This set was written and labelled by the classifier's author, and at 100% it is too easy to show anything more; the public set above is the harder test. To build a set from your own runs, `pnpm eval:export --blind` writes their failures to a file, `pnpm eval:label` labels it, and `pnpm eval:classifier --cases <file>` scores it. Full results are in [`eval-results/`](eval-results/).

## Status and limitations

keel is an **experimental project**, and the name is not final. All planned milestones are implemented and tested ([PLAN.md](PLAN.md)). Apart from [one real workload of mine](#real-use), it hasn't been used, and never in production. Known limitations include:

- Budgets can overshoot by one step, because a step's cost is known only after it runs.
- Idempotency keys protect external calls only for services that accept them.
- Retention is opt-in: without `retention` on a worker or calls to `engine.purge`, finished runs are kept forever.
- A single Postgres instance is the throughput ceiling: about 2,000 runs per second in the benchmark above.
- The dashboard has no authentication, so it is for local or internal use only.
- On error messages from public issues, the shipped classifier picks the right kind about 6 times in 10, and the right action about 8 times in 10 ([results](#failure-classification-rules-vs-jev)).

The full list is under [Known risks](PLAN.md#known-risks), each tagged with the milestone that addresses it.

**Roadmap:** phases 1 and 2 are complete; see [PLAN.md](PLAN.md) for what was built, the measured results, and the deliberate [non-goals](PLAN.md#non-goals).

## Development

```sh
pnpm test        # node:test against the real Postgres from docker-compose (no database mocks)
pnpm typecheck   # tsc --noEmit
pnpm db:migrate  # applies db/migrations/*.sql in order
pnpm build       # compiles src/ to dist/ (JavaScript and type declarations)
pnpm bench       # throughput and latency, results in bench-results/
pnpm openroles:sync  # the real workload (needs an openroles database)
pnpm eval:classifier [--cases file]  # classifier eval; needs TYPESAFE_API_KEY
pnpm eval:export --blind / pnpm eval:label <file>  # build and label an eval set
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the type check and the full test suite against Postgres 17, on Node 24 and Node 26, on every pull request and every push to `main`.

Node runs the TypeScript sources directly, so there is no build step. Tests include real crash recovery: worker processes are killed with `SIGKILL` mid-run.

```
src/          engine, failure classification, Jev classifier, migrations
db/           SQL migrations
test/         unit, integration and crash tests
scripts/      demo, classifier eval and labelling, real workload, migrate
eval-sets/    labelled eval sets beyond the synthetic one
docs/         guide and demo transcript
PLAN.md       milestones, acceptance criteria, known risks
```

## License

[MIT](LICENSE)
