# keel plan

**Goal:** a small, correct, Postgres-backed durable execution engine in TypeScript, with an identity that existing engines lack: it understands *why* an agent step failed and acts on it, and it treats money (tokens, dollars) as a scheduling resource.

**Rule:** every milestone ends with its acceptance tests passing in `pnpm test` against the real Postgres from `docker-compose.yml`. No mocks for the database.

**Ordering principle:** the differentiator (failure classification) arrives in M2, not at the end, so the project shows its identity early.

## Status

| Phase | Milestones | Status |
|---|---|---|
| 1. Core engine | M0 to M9: queue, retries and classification, idempotency, durable steps, waits, budgets, Jev classifier, side effects and approvals, demo | Done |
| 2. Production readiness | M10 hardening, M11 classification context, M12 budget completeness, M13 dashboard, M14 serverless mode, M15 benchmark and packaging | Done |

See also [Non-goals](#non-goals) and [Known risks](#known-risks).

---

# Phase 1: core engine (done)

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
- Implemented actions: `retry`, `retry_modified` (hint reaches the handler as `ctx.hint`), `fail`, and since M8 `escalate` (routes to a person). `fallback` still fails the run with the target recorded

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

## M5: Waits (done)

- `ctx.wait.for(name, ms)` and `ctx.wait.forEvent(name, eventName, { timeoutMs })`, named and unique per run like steps
- A wait throws `RunSuspended`: the run moves to a new `waiting` status and frees its worker. It resumes by replay, and resuming is not a new attempt
- `engine.sendEvent(eventName, payload)` resolves open waits on that event name. Events are not buffered: only waits registered before the event count
- The claim query treats a waiting run as ready when its timer is due or its event has arrived, so an event landing between "wait registered" and "run suspended" is not lost

**Acceptance:** 100 runs each waiting 1 hour hold zero workers. A wait with a timeout resumes with a timeout result if no event arrives.

---

## M6: Token and cost budgets (done)

- Per-run budgets (`enqueue(..., { budget: { usd, tokens } })`) and per-tenant daily budgets (`engine.setTenantBudget`, UTC calendar day)
- Steps report usage (`ctx.step.run("llm", fn, { usage: (result) => ({ usd, tokens }) })`). Usage is stored with the step, so replays never count it twice, and tenant daily spend is updated in the same statement
- Per-run budget: checked before each new step. Crossing it raises `OverBudgetError`, classified `over_budget`, which the default policy escalates. Completed steps stay stored
- Tenant budget: runs are deferred, not failed. Queued runs are not claimed, and a running run pauses as `waiting` at its next step. Both continue once the budget allows (next UTC day or a raised limit). Pausing is not a new attempt
- **Deferred:** per-task budgets and the "fallback to a cheaper model" action. Both fit the same seams (a task-level budget table, and `fallback` routing in the policy). Planned in [M12](#m12-budget-completeness)

**Acceptance:** a tenant at its daily budget has further runs deferred, not failed. A run crossing its per-run budget mid-way stops at the next step boundary with its state preserved.

---

## M7: Jev classifier adapter (done)

- `JevClassifier implements FailureClassifier` as a cascade: explicit signals stay on rules (no call), everything else is one Jev Choice question, and answers below `minConfidence` (default 0.5) or a failed call fall back to the `RuleClassifier`
- State sent to Jev: task, attempt, error (name, message, status, code, cause) and the payload truncated to 2,000 characters
- **Not yet sent:** the failing step's name and the model's raw output. `FailureContext` does not carry them; adding them would likely resolve cases like the one eval miss (tool-call arguments). Planned in [M11](#m11-classification-with-step-context)
- keel has no runtime dependency on `@typesafe-ai/sdk`; `SystemOneClient` is a structural type, checked against the real client by `test/types/typesafe-client.ts`
- **Result:** rules 14/30 (47%), Jev 29/30 (97%), cascade 29/30 (97%). Details and caveats in the README

**Acceptance:** a labelled fixture set of ~30 real failure cases (rate limit, hallucinated tool name, malformed JSON, policy refusal, bad user input) where the Jev classifier beats the rule classifier on accuracy. Record the numbers in the README.

---

## M8: Safe tool calls and human-in-the-loop (done)

- No separate `ctx.tool`: `ctx.step.run` passes `{ idempotencyKey, signal }` to its function. The key is `keel:<runId>:<stepName>`, identical across attempts and workers. Keyed on the step name, not the arguments, because arguments can differ between replays
- `ctx.signal` aborts when the worker releases the run (`stop({ timeoutMs })`) or a heartbeat finds another worker took it
- `ctx.approval.request(name, { prompt, timeoutMs })` pauses the run (built on M5 waits) and returns `approved`, `rejected` or `timed_out` with the reviewer and comment. `engine.listPendingApprovals()` and `engine.resolveApproval()` are the reviewer side; `onApprovalRequested` fires once per request for Slack or email
- The `escalate` action parks the run as an escalation approval. Approval retries it once more (even past `maxAttempts`) with the reviewer's comment as `ctx.hint`; rejection or `escalationTimeoutMs` (default 24h) fails it

**Acceptance:** a run that crashes right after a side-effecting tool call replays without calling the tool again. An approval that times out follows the configured policy.

**How it was met:** keel cannot know whether a call that crashed mid-step reached the service, so the step does run again, with the same idempotency key. The test uses a payment service that deduplicates by key, like Stripe: two calls, one charge. Services without idempotency keys are still at risk.

---

## M9: Agent demo (done)

A multi-step agent workflow (research, draft, tool call, send) that shows the whole engine:

1. Kill the worker mid-run, and it resumes from the last completed step
2. The model hallucinates a tool name, and the classifier marks it `bad_output`, so the engine retries with a corrective hint instead of retrying blindly
3. A rate limit is classified `transient`, so it backs off and succeeds
4. The run hits its cost budget and escalates to a human approval

**Acceptance:** a recorded terminal demo plus a README section explaining each moment.

**How it was met:** `pnpm demo` (scripts/demo.ts) runs the story with two worker processes and a scripted fake model; the recording is `docs/demo-transcript.txt` (real Jev), explained in the README. Added `engine.setRunBudget` so a reviewer can raise the budget before approving an over-budget escalation. `test/demo.test.ts` runs the offline variant on every test run.

---

# Phase 2: production readiness (done)

Same rules as phase 1: acceptance tests first, real Postgres, one PR per milestone. New npm packages are named before they are installed and installed by the maintainer through `sfw`.

## M10: Hardening (done)

Close the correctness bugs and unbounded growth found during phase 1.

- A run released by `stop({ timeoutMs })` records a `Released` error entry and counts toward `maxAttempts`, instead of silently getting an extra execution
- A policy that throws or returns an invalid `delayMs` fails the run at once, with the policy error recorded, instead of stranding it until the lease expires
- Retention: `engine.purge({ olderThan })` removes steps, waits and usage of runs finished before the cutoff, expired idempotency keys, and old `tenant_spend` rows. An optional worker setting runs it periodically
- Deferred runs of an over-budget tenant get a `deferred_until`, so the claim query stops re-evaluating them on every poll
- The poison-pill sweep runs every N polls instead of before every claim

**Acceptance:**
- A run released on its final attempt ends `dead`, with the release in its error history
- A throwing policy fails the run within one poll
- `purge` removes only data of finished runs older than the cutoff; a running or waiting run still replays correctly afterwards
- With 10,000 deferred runs for one over-budget tenant, claims for other tenants stay as fast as with none (measured, numbers in the PR)

**How it was met:**
- Released runs record a `Released` error and go `dead` on their final attempt. Policy errors and invalid actions fail the run immediately with `Policy error: ...` as the reason
- `engine.purge({ olderThan, queue? })` deletes whole finished runs (the maintainer chose this over keeping run rows), and `retention: { keepMs, everyMs }` on a worker purges its own queue
- A periodic sweep (`sweepEveryMs`, default 1s) replaces the per-claim poison-pill query and parks over-budget tenants' runs at the next UTC midnight; `setTenantBudget` releases them
- `pnpm bench:deferred`, 4 workers, 300 runs of another tenant, three runs each: no deferred runs 125 to 139 ms; 10,000 deferred with parking off 189 to 190 ms (about 37% slower); parked 136 to 186 ms, with the 186 an outlier on the first run and 136 to 144 ms after. The old risk was real but milder than feared at 10,000 runs

## M11: Classification with step context (done)

The one M7 eval miss was ambiguous because the classifier could not see which step failed or what the model produced.

- `FailureContext` gains `step` (the name of the failing step, tracked by the engine) and `output` (the rejected model output, when the handler attaches it to the error)
- `JevClassifier` sends both to Jev
- `pnpm eval:export` turns real failures from the `runs.errors` history into the eval case format, ready for labelling, so the eval set can move from synthetic to real

**Acceptance:**
- A unit test shows the step name and output reach the classifier state
- With step context, the eval classifies the tool-argument case correctly, and overall accuracy does not drop (numbers recorded in the README)
- An exported file is accepted by `pnpm eval:classifier` unchanged

**How it was met:**
- The engine tags the error thrown by a step function with the step's name; errors carry `output` via `KeelError` options or an `output` property. Both reach `FailureContext`, the Jev state and the error history, which now also keeps `status`, `code` and `cause`
- `pnpm eval:export` and `pnpm eval:classifier --cases`, with a round-trip test from a real failed run
- The fixture gained a step for all 30 cases and model output for 7 (not just the missed case). Eval, 60 Jev calls: rules 14/30; Jev and the cascade 30/30 both **with and without** step context. The tool-argument case is now correct, but also without context, so the fix can't be credited to context; the M7 run did not record the concrete model version, so a model update can't be ruled out. Context raised confidence on that case from 0.60 to 0.75 and on every `bad_output` case (mean 0.90 to 0.92)

## M12: Budget completeness (done)

The two budget features deferred in M6.

- `fallback` action: the policy can answer `over_budget` (or any kind) with `{ type: "fallback", target }`, and the next attempt receives `ctx.fallback`, for example a cheaper model name. The default policy falls back when a worker has `fallbackModel` configured, and escalates otherwise
- Per-task budgets: `engine.setTaskBudget(task, { usdPerRun, usdPerDay })`. A per-run default for runs enqueued without a budget, plus a daily limit that defers runs like a tenant budget does

**Acceptance:**
- An over-budget run with a fallback configured finishes on the cheaper model without a person
- A task at its daily budget has further runs deferred, not failed, while other tasks keep running

**How it was met:**
- The `fallback` action carries `extendBudget` (chosen over a separate fallback budget or ignoring the budget), which the engine adds to the run's effective budget before retrying. `ctx.fallback` is sticky. The default policy's `fallback` option falls back once, then escalates
- `engine.setTaskBudget`: `usdPerRun` is a default read at claim time (an explicit run budget wins); `usdPerDay` is enforced by one combined "tenant or task blocked" condition in the claim, the per-step pause and the parking sweep. Task spend is updated in the same statement as the step
- **Performance finding:** the parking sweep had no usable index and scanned the whole `runs` table (about 170ms per sweep at 72,000 rows in the dev database), blocking claims meanwhile. It showed up as a 2x to 16x benchmark regression during M12. The M10 sweep most likely had the same problem at a smaller table size. Fixed by the `runs_sweepable` partial index: 0.6ms per sweep, benchmark back to its M10 level

## M13: Dashboard (done)

A small web UI that makes run state and approvals visible without SQL.

- Run list with filters (status, queue, task, tenant)
- Run detail: steps with results and usage, error timeline with kind, confidence and action, current wait or approval
- Pending approvals with Approve and Reject, calling `engine.resolveApproval`
- Served by `pnpm dashboard` for local and internal use. No authentication in this milestone; the README must say not to expose it publicly
- The stack is chosen at the start of the milestone, preferring as few new dependencies as possible

**Acceptance:** an end-to-end test lists a run, shows its steps and errors, and approving an escalation from the UI resumes the run.

**How it was met:**
- Zero dependencies (chosen over Hono + htmx and React): `node:http`, server-rendered HTML, plain forms, no JavaScript. New engine APIs `listRuns`, `getRunDetail`, and filters on `listPendingApprovals`
- Security: an HTML template that escapes by default, a CSP without scripts, a per-process form token, an Origin check and a Host check against DNS rebinding. Each guard has a test, and each test was shown to fail with its guard removed
- Process note: the dashboard was written before its HTTP tests (the engine APIs were test-first); the mutation checks above stand in for the missing red step
- Checked visually with headless Chrome in light and dark mode, which caught a row animation that replayed on every auto-refresh; screenshots are in `docs/images/`

## M14: Serverless mode (done)

Replay-based durability means any process can resume any run, so a long-lived worker is optional.

- `worker.runOnce({ maxRuns, deadlineMs })`: claim up to `maxRuns` runs, execute each until it completes, suspends or the deadline nears, then release anything unfinished and return
- Suits cron jobs and serverless functions (Lambda, Vercel, Cloudflare), where a process lives for seconds

**Acceptance:**
- A run with a wait and three steps completes across several `runOnce` calls with no long-lived worker
- A deadline that falls inside a step releases the run cleanly, and the next call resumes it from the last stored step

**How it was met:**
- `worker.runOnce({ maxRuns, deadlineMs, releaseMarginMs })` returns counts (`claimed`, `completed`, `failed`, `suspended`, `yielded`, `lost`) and runs one maintenance pass per call
- Deadline releases are **progress-aware** (chosen by the maintainer): with at least one new step stored, the run is paused without using up an attempt; without progress it counts as a `Released` attempt, so a step longer than any deadline ends `dead` instead of looping
- Tests for both acceptance criteria plus the no-progress guard, `maxRuns` and the started-worker guard; each rule was shown to fail its test when broken

## M15: Benchmark and packaging (done)

- `pnpm bench`: enqueue-to-complete throughput and latency (p50, p99) for 1 to 32 workers on one Postgres, with the hardware noted. The numbers replace "roughly thousands of jobs per second" in the README
- Packaging: a build step that emits JavaScript and type declarations to `dist/`, an `exports` map and a `files` list, so keel installs from git or a tarball. Publishing to npm stays a separate decision

**Acceptance:**
- Benchmark results are recorded in the README and reproducible with one command
- A fresh project installs the `pnpm pack` tarball and runs a task with steps and a wait

**How it was met:**
- `pnpm build` (tsc with `rewriteRelativeImportExtensions`) emits `dist/`; `exports`, `main`, `types` and `files` (dist, src for source maps, migrations, README, LICENSE). The package stays private
- `test/package.test.ts` packs the tarball, unpacks it into a temp project (linking the already-installed `pg` instead of installing), and runs a plain JavaScript task with two steps and a wait. Shown to fail without the migrations or without an entry point
- `pnpm bench`: throughput for 1 to 32 workers and latency on idle workers, with the environment recorded. Added `createEngine({ poolSize })`
- **Finding:** throughput plateaued at 8 workers. Node was under half a core busy; removing the task spend update restored scaling, so the cause was the single daily spend row per task that every step updated. Tenant and task spend are now sharded over 16 rows (the maintainer's choice over skipping untracked spend): 32 workers went from about 1,600 to about 2,000 runs per second, and 4 to 8 workers lost about 12 to 15%

---

## Non-goals

These are deliberate design decisions, not gaps.

- **Process checkpoint/restore (CRIU).** keel resumes runs by replaying the handler against stored steps, so any worker can continue any run without snapshotting a process. Checkpointing needs Linux kernel features and control over the container runtime, which is a platform's job, not an engine library's.
- **Multi-language SDKs.** keel is TypeScript-only by design. Replay semantics live in the handler's language, so every additional SDK is a rewrite of the step, wait and approval runtime, and it splits focus away from what makes keel different.
- **Horizontal sharding.** One Postgres database is the whole infrastructure, and that simplicity is the point. M15 measures the ceiling. Beyond it, run independent keel deployments per queue or per tenant group on separate databases, or choose an engine built for that scale.

## Known risks

Each risk is tagged with the milestone that addresses it, or **accepted** when it is a documented trade-off.

### Correctness

- ~~A run released by `stop({ timeoutMs })` on its final attempt gets one extra execution, with no error entry.~~ Fixed in M10
- ~~A custom policy that throws, or returns an invalid `delayMs`, leaves the run `running` until its lease expires.~~ Fixed in M10
- A handler that wraps a step or wait in `try/catch` and swallows `RunSuspended` or `LeaseLostError` breaks suspension: a budget-paused run can complete with steps skipped. Documented in the guide; a lint rule or a non-Error signal could enforce it. **Accepted**
- Parallel waits in one handler (`Promise.all` of two waits) are not supported: the run suspends on whichever throws first. **Accepted**
- A released or superseded handler that ignores `ctx.signal` keeps running alongside the new owner. Its step writes are fenced, but its side effects are only safe if they use the step's idempotency key. **Accepted**
- Only step *results* are durable. A step that crashes before its result is stored runs again, side effects included; idempotency keys make this safe only for services that accept them. **Accepted**
- `onApprovalRequested` fires after the approval is stored; a crash between the two means nobody is notified, although the approval still appears in `listPendingApprovals`. Poll the list as a backstop. **Accepted**

### Budgets

- Runs whose task has a daily budget cost one extra query per new step (the tenant/task limit check), like tenant runs already did. **Accepted**

- Budgets can overshoot by one step, since a step's cost is known only after it runs. A single very expensive step is not prevented. **Accepted**
- Tenant budget checks are not atomic across workers: each concurrently running run of a tenant can overshoot by one step. **Accepted**
- USD is stored as double precision: fine for limits, not for billing, which needs integer cents or `numeric`. **Accepted**

### Performance

- ~~Deferred runs of an over-budget tenant are re-evaluated on every claim.~~ Fixed in M10 by parking them (measured: 10,000 deferred runs slowed other tenants by about 37% before, none after)
- ~~Each idle poll runs two queries (poison-pill sweep, then claim).~~ Fixed in M10: the sweep runs every `sweepEveryMs`
- Extra queries per claim (decided escalations) and per new step of a tenant's run (tenant budget), and an `EXISTS` check per waiting run. Included in the M15 benchmark numbers. **Accepted**
- One Postgres is the throughput ceiling: about 2,000 runs per second on the benchmark machine. **Measured in M15; sharding is a non-goal**
- Sharded spend costs about 12 to 15% throughput at 4 to 8 workers compared with a single row. **Accepted**
- The benchmark runs all workers in one Node process with Postgres on the same machine; production numbers will differ. **Accepted**

### Operations

- A deadline yield with progress leaves no trace in the run's error history, so the logbook doesn't show how many invocations a run took. **Accepted**
- A deadline that hits in the short window between claiming a run and starting its handler waits for the handler instead of releasing it. **Accepted**
- After a yield, the abandoned handler keeps running in the same process until it notices `ctx.signal`. In a serverless function the platform usually freezes or ends the process, so later side effects are unlikely but possible; use step idempotency keys. **Accepted**

- ~~Steps, waits, expired idempotency keys and `tenant_spend` rows are never cleaned up.~~ Fixed in M10 by `engine.purge` and worker `retention`. Retention is opt-in: without it, tables still grow
- `purge` deletes in a single statement; purging millions of rows at once holds locks for a long time. Run it often with a short `everyMs` rather than rarely. **Accepted**
- The parking test compares against the next UTC midnight, so it can fail if it runs across midnight. **Accepted**
- ~~There is no UI.~~ Done in M13
- The dashboard has no authentication. It is safe on loopback only; binding it elsewhere lets anyone who can reach it approve runs. **Accepted: local and internal use only**
- The dashboard refreshes with a meta refresh every 5 seconds, which reloads the whole page. **Accepted**

### Classification

- The eval set is synthetic and labelled by the classifier's author, and at 100% it is too easy to show gains. M11 added the tooling to build a real set (`pnpm eval:export`); the set itself needs real failures and a person to label them. **Open: needs real data**
- Jev adds one API round trip to each failure without an explicit signal, about 650 input tokens per call on the eval set. **Accepted**

### Strategy

- Incumbents (Trigger.dev, Inngest, Temporal) are adding agent features quickly. keel's edge is depth in failure classification, budgets and human approval, not breadth.
- If Jev does not beat rules on real failure data (M11), that is a finding worth publishing, not hiding.
