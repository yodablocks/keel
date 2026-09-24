# keel

> Working name, not final.

An agent-native durable execution engine for TypeScript, backed by Postgres.

Most job engines treat an AI agent as just a long-running job and retry on any error. Keel's goal is to understand *why* a step failed (transient, bad input, hallucinated output, needs a human) and act on that, and to treat tokens and dollars as a scheduling resource.

Status: **M3 done** (queue with leases, retries, failure classification, idempotency keys). See [PLAN.md](PLAN.md) for milestones and acceptance tests.

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
| `NeedsHumanError` | needs_human | escalate (for now: fail with the reason recorded) |
| anything else | fatal | fail, no retry |
| worker crashed or lost its lease | transient | retry, recorded as `LeaseExpired` |

Statuses: `failed` means the policy chose not to retry. `dead` means `maxAttempts` ran out. Pass your own `classifier` or `policy` to `createWorker` to change any of this.

## TypeScript notes

Code is run by Node without a build step, so it must use erasable syntax only: no `enum`, no `namespace`, no constructor parameter properties. Relative imports use the `.ts` extension. `tsc` is used for typechecking only.
