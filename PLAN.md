# Keel milestone plan

**Goal:** a small, correct, Postgres-backed durable execution engine in TypeScript, with an identity that existing engines lack: it understands *why* an agent step failed and acts on it, and it treats money (tokens, dollars) as a scheduling resource.

**Rule:** every milestone ends with its acceptance tests passing in `pnpm test` against the real Postgres from `docker-compose.yml`. No mocks for the database.

**Ordering principle:** the differentiator (failure classification) arrives in M2, not at the end, so the project shows its identity early.

---

## M0: Scaffold (done)

- TypeScript run directly by Node (type stripping), `node:test`, `tsc --noEmit` for typechecking
- Postgres 17 in Docker on port 5433, schema draft in `db/schema.sql`

**Acceptance:** `pnpm test` passes the smoke test. `pnpm typecheck` passes once dev deps are installed.

---

## M1: Queue with leases (done)

- `enqueue(task, payload, opts)` inserts a run
- Worker loop claims runs with `FOR UPDATE SKIP LOCKED`, sets `lease_owner` and `lease_expires`
- Heartbeat extends the lease while the handler runs
- Expired leases are reclaimed by the claim query itself (no separate reaper process)
- Completion is fenced on `lease_owner`, so a zombie worker cannot overwrite a run it lost
- Graceful shutdown: `stop()` waits for the in-flight run, `stop({ timeoutMs })` releases it back to the queue
- A throwing handler marks the run `failed` with `last_error` (no retries yet, that is M2), and database errors never kill the worker loop

**Acceptance:**
- 1,000 runs, 8 concurrent workers: every run completes exactly once (no double claims, none lost)
- Kill a worker mid-run (simulated crash, no cleanup): another worker picks the run up after the lease expires
- A slow handler that heartbeats is never reclaimed

---

## M2: Retries, dead-letter, and the `FailureClassifier` seam (done)

**Migrations:** `pnpm db:migrate` applies `db/migrations/*.sql` in order and records them in `keel_migrations`. Tests run it first via `--test-global-setup`. Never edit an applied migration; add a new file.

- Exponential backoff with full jitter via `run_after`
- After `max_attempts`, run goes to `dead` with the error history kept
- Introduce the core abstraction:

```ts
type FailureKind = "transient" | "bad_input" | "bad_output" | "needs_human" | "fatal";
type FailureAction =
  | { type: "retry"; delayMs: number }
  | { type: "retry_modified"; hint: string }
  | { type: "fallback"; target: string }
  | { type: "escalate"; reason: string }
  | { type: "fail"; reason?: string };

interface FailureClassifier {
  classify(ctx: FailureContext): Promise<{ kind: FailureKind; confidence: number }>;
}
```

- Default `RuleClassifier`: HTTP 429/5xx and timeouts count as transient, schema validation errors as bad_input/bad_output, everything else as fatal
- A `FailurePolicy` maps (kind, attempt, confidence) to a `FailureAction`
- Statuses: `failed` means the policy chose not to retry. `dead` means retries ran out. The engine caps retries at `maxAttempts` even if a custom policy keeps asking to retry
- Implemented actions: `retry`, `retry_modified` (hint reaches the handler as `ctx.hint`), `fail`. `escalate` and `fallback` currently fail the run with the reason recorded; M6 and M8 give them real destinations

**Acceptance:**
- A handler that fails twice with a 503 then succeeds completes on attempt 3, with backoff delays in the expected range
- A handler throwing a validation error does **not** retry 3 times; it goes straight to the policy's action
- A custom classifier injected in tests fully controls the outcome
- **Poison pill:** reclaiming an expired lease counts toward `max_attempts`. A handler that crashes its process every time ends up `dead` instead of killing workers forever

---

## M3: Idempotency keys (done)

- `enqueue(..., { idempotencyKey, ttl })`: a duplicate within the TTL returns the existing run id
- Separate `idempotency_keys` table keyed by (task, key). Taking the key and inserting the run happen in one statement, so concurrent enqueues serialize on the key row
- `enqueue` returns `{ id, created }`. A live key returns the existing run whatever its status, including `failed` and `dead`
- Expired keys are taken over by the next enqueue, not deleted

**Acceptance:** 50 concurrent `enqueue` calls with the same key create exactly one run.

---

## M4: Durable steps (done)

- `ctx.step.run("name", fn)` stores the step result in a `steps` table keyed by (run_id, step_name)
- On retry or recovery, completed steps return their stored result without re-executing
- **Determinism caveat (documented in the README):** code *between* steps re-executes on replay. LLM calls must live inside `step.run` or replay will diverge. Duplicate step names within a run throw `DuplicateStepError`.
- Step results are JSON round-tripped on the first run too, so first run and replay see identical values
- Step writes are fenced on the lease: a worker that lost the run gets `LeaseLostError` instead of storing its result

**Acceptance:** a 3-step run that crashes during step 3 resumes and executes steps 1 and 2 zero additional times (counted with side-effect counters).

---

## M5: Waits

- `ctx.wait.for(duration)` and `ctx.wait.forEvent(name, { timeout })`
- The run releases its worker while waiting (it stores a wake condition and returns to `queued` with a future `run_after`)
- `sendEvent(name, payload)` wakes matching waiters

**Acceptance:** 100 runs each waiting 1 hour hold zero workers. A wait with a timeout resumes with a timeout result if no event arrives.

---

## M6: Token and cost budgets

- Budgets per run, per task, and per tenant (for example "$2 per run, $50 per tenant per day")
- Steps report usage (`ctx.step.run("llm", fn, { reportUsage })`), and the engine accounts it
- Budget exceeded counts as a `FailureKind` handled by the same policy (escalate, fallback to a cheaper model, or stop)
- Concurrency limited by spend, not only by slot count

**Acceptance:** a tenant at its daily budget has further runs deferred, not failed. A run crossing its per-run budget mid-way stops at the next step boundary with its state preserved.

---

## M7: Jev classifier adapter

- `JevClassifier implements FailureClassifier`, using the error, step name, input, and output to produce a typed judgment and confidence
- Low-confidence judgments fall back to the `RuleClassifier`
- **Before starting:** load the `typesafe:typesafe-ai` skill and read the live Jev docs. Do not guess the SDK package or API. `../jev_projects/jev_projects.md` may have useful prior notes.

**Acceptance:** a labelled fixture set of ~30 real failure cases (rate limit, hallucinated tool name, malformed JSON, policy refusal, bad user input) where the Jev classifier beats the rule classifier on accuracy. Record the numbers in the README.

---

## M8: Safe tool calls and human-in-the-loop

- `ctx.tool(name, fn, { sideEffect: true })` derives an idempotency key from (run_id, step, args) and passes it to the tool, so replays never double-charge or double-send
- `ctx.approval.request({ channel, prompt, timeout })` pauses the run (built on M5 waits) until approved, rejected, or timed out
- The `escalate` action from M2 routes into the same approval mechanism

**Acceptance:** a run that crashes right after a side-effecting tool call replays without calling the tool again. An approval that times out follows the configured policy.

---

## M9: Agent demo

A multi-step agent workflow (research, draft, tool call, send) that shows the whole engine:

1. Kill the worker mid-run, and it resumes from the last completed step
2. The model hallucinates a tool name, and the classifier marks it `bad_output`, so the engine retries with a corrective hint instead of retrying blindly
3. A rate limit is classified `transient`, so it backs off and succeeds
4. The run hits its cost budget and escalates to a human approval

**Acceptance:** a recorded terminal demo plus a README section explaining each moment.

---

## Explicitly out of scope (for now)

- Process checkpoint/restore (CRIU) and serverless deployment
- Dashboard UI (run history comes from SQL queries and structured logs)
- Multi-language SDKs
- Horizontal sharding beyond what a single Postgres handles

## Known risks

- The `steps` table is never cleaned up. Add retention (for example delete steps of runs completed more than N days ago) alongside the idempotency key purge.
- Only step *results* are durable. Side effects inside a step that crashes before its result is stored will run again on replay. M8's tool-call idempotency keys address this for external calls.

- Expired idempotency keys are never cleaned up, so `idempotency_keys` grows by one row per distinct key. Add a periodic purge of rows past `expires_at` before production use.

- `stop({ timeoutMs })` requeues a released run without checking `maxAttempts` and without an error entry, so a run released on its final attempt gets one extra execution. Fix together with the AbortSignal item below.
- Each idle poll now runs two queries (poison-pill sweep, then claim). Fine at 50ms polling for a few workers; revisit if idle load matters (for example sweep every N polls).
- A custom policy that throws, or returns an invalid `delayMs`, leaves the run `running` until its lease expires. It then recovers through the `LeaseExpired` path, but slowly. Classifier errors are already caught; policy errors are not.

- After `stop({ timeoutMs })` releases a run, the abandoned handler keeps running in memory while another worker runs the same run. Handlers should get an `AbortSignal` that fires on release. This must be solved by M8, when tool calls have side effects.
- Incumbents (Trigger.dev, Inngest, Temporal) are adding agent features quickly. Keel's edge is focus on M2, M6, and M7, not breadth.
- Postgres-as-queue has a throughput ceiling (roughly thousands of jobs/sec). Fine for the target use; say so in the README.
- M7's value depends on Jev beating rules on real failure data. If it doesn't, that is a finding worth publishing, not hiding.
