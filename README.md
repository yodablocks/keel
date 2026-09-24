# keel

> Working name, not final.

An agent-native durable execution engine for TypeScript, backed by Postgres.

Most job engines treat an AI agent as just a long-running job and retry on any error. Keel's goal is to understand *why* a step failed (transient, bad input, hallucinated output, needs a human) and act on that, and to treat tokens and dollars as a scheduling resource.

Status: **M0 (scaffold)**. See [PLAN.md](PLAN.md) for milestones and acceptance tests.

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

## TypeScript notes

Code is run by Node without a build step, so it must use erasable syntax only: no `enum`, no `namespace`, no constructor parameter properties. Relative imports use the `.ts` extension. `tsc` is used for typechecking only.
