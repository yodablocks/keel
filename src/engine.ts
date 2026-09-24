import pg from "pg";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultPolicy, OverBudgetError, RuleClassifier } from "./failure.ts";
import type { FailureAction, FailureClassifier, FailureContext, FailureKind, FailurePolicy, FailureVerdict } from "./failure.ts";

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "dead";

export interface Run {
  id: string;
  queue: string;
  task: string;
  payload: unknown;
  status: RunStatus;
  attempt: number;
  result: unknown;
  lastError: RunError | null;
  /** One entry per failed attempt, oldest first. */
  errors: RunError[];
  /** Sum of usage reported by completed steps. */
  usage: Usage;
}

export interface Usage {
  usd: number;
  tokens: number;
}

export interface TenantBudget {
  usdPerDay?: number;
  tokensPerDay?: number;
}

export interface StepOptions<T> {
  /** Reports what the step cost. Stored with the step result, so replays never count it twice. */
  usage?: (result: T) => Partial<Usage>;
}

export interface RunError {
  attempt: number;
  name: string;
  message: string;
  kind: FailureKind;
  confidence: number;
  action: FailureAction;
  at: string;
}

export interface EngineOptions {
  connectionString: string;
}

export interface EnqueueOptions {
  queue?: string;
  /** Total attempts including the first. Defaults to 3. */
  maxAttempts?: number;
  /**
   * While the key is live, enqueueing the same task with the same key returns the existing run,
   * whatever its status. Keys are scoped per task.
   */
  idempotencyKey?: string;
  /** How long the key stays live. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
  /** Groups runs for tenant budgets (engine.setTenantBudget). */
  tenant?: string;
  /** Checked before each new step. One step can overshoot it, since cost is known only after a step runs. */
  budget?: Partial<Usage>;
}

export interface EnqueueResult {
  id: string;
  /** False when an existing run with the same idempotency key was returned instead. */
  created: boolean;
}

export interface StepCall {
  /**
   * `keel:<runId>:<stepName>`: identical on every attempt and every worker. Pass it to external APIs
   * (Stripe, email providers) so a step re-run after a crash cannot repeat the side effect.
   */
  idempotencyKey: string;
  /** Same as ctx.signal. */
  signal: AbortSignal;
}

export interface StepApi {
  /**
   * Runs fn once per run. After it succeeds its result is stored, and later attempts get the stored
   * result without calling fn. Results are JSON round-tripped, on the first run too, so a Date comes
   * back as a string either way. Names must be unique within a run.
   */
  run<T>(name: string, fn: (call: StepCall) => T | Promise<T>, options?: StepOptions<T>): Promise<T>;
}

export interface ApprovalRequest {
  /** Shown to the reviewer. */
  prompt: string;
  /** No decision in this time resolves the request as timed_out. Defaults to never. */
  timeoutMs?: number;
}

export type ApprovalResult =
  | { status: "approved" | "rejected"; by?: string; comment?: string }
  | { status: "timed_out" };

export interface ApprovalApi {
  /** Suspends the run until a person calls engine.resolveApproval(runId, name, ...) or the timeout. */
  request(name: string, request: ApprovalRequest): Promise<ApprovalResult>;
}

export interface Approval {
  runId: string;
  name: string;
  task: string;
  prompt: string;
  requestedAt: Date;
  /** Null when the request never times out. */
  expiresAt: Date | null;
}

export interface ApprovalDecision {
  approved: boolean;
  by?: string;
  comment?: string;
}

export type EventWaitResult = { timedOut: false; payload: unknown } | { timedOut: true };

export interface WaitApi {
  /** Suspends the run for ms. The worker is freed; the run resumes by replay after the delay. */
  for(name: string, ms: number): Promise<void>;
  /**
   * Suspends the run until engine.sendEvent(eventName) or the timeout. Only events sent after the
   * wait is registered count. Put an id in the event name to target one run, e.g. `approved:${orderId}`.
   */
  forEvent(name: string, eventName: string, options?: { timeoutMs?: number }): Promise<EventWaitResult>;
}

/**
 * Thrown by ctx.wait to suspend the run. If you catch errors around a wait, rethrow this one,
 * or the run will not suspend.
 */
export class RunSuspended extends Error {
  override name = "RunSuspended";
  /** The wait that suspended the run, or null when it was paused for another reason (tenant budget). */
  readonly waitName: string | null;
  constructor(waitName: string | null, reason?: string) {
    super(reason ?? `Run suspended on wait "${waitName}"`);
    this.waitName = waitName;
  }
}

/** Thrown by ctx.step.run when the same step name is used twice in one attempt. */
export class DuplicateStepError extends Error {
  override name = "DuplicateStepError";
}

/** Thrown by ctx.step.run when this worker no longer owns the run, so its results must not be stored. */
export class LeaseLostError extends Error {
  override name = "LeaseLostError";
}

export interface TaskContext {
  runId: string;
  /** Starts at 1. */
  attempt: number;
  /** Set when the previous attempt failed and the policy chose retry_modified. */
  hint?: string;
  step: StepApi;
  wait: WaitApi;
  approval: ApprovalApi;
  /**
   * Aborts when this worker no longer owns the run: it was released by stop({ timeoutMs }), or a
   * heartbeat found another worker took it over. Pass it to fetch and SDK calls to stop work early.
   */
  signal: AbortSignal;
}

export type TaskHandler = (payload: unknown, ctx: TaskContext) => Promise<unknown>;

export interface WorkerOptions {
  queue?: string;
  tasks: Record<string, TaskHandler>;
  leaseMs?: number;
  /** How often a running handler extends its lease. Defaults to a third of leaseMs. */
  heartbeatMs?: number;
  pollMs?: number;
  classifier?: FailureClassifier;
  policy?: FailurePolicy;
  /**
   * Called once when a run first requests approval (not on replays). Use it to notify a reviewer,
   * for example in Slack or by email. Errors are logged and do not affect the run.
   */
  onApprovalRequested?: (approval: Approval) => Promise<void> | void;
  /**
   * When the policy escalates a failure, the run waits this long for engine.resolveApproval before
   * failing. Approval retries it once more with the reviewer's comment as ctx.hint. Defaults to 24 hours.
   */
  escalationTimeoutMs?: number;
}

export interface StopOptions {
  /**
   * How long to wait for the in-flight run before releasing it back to the queue.
   * Without a timeout, stop waits for the handler however long it takes.
   */
  timeoutMs?: number;
}

export interface Worker {
  readonly id: string;
  start(): void;
  stop(options?: StopOptions): Promise<void>;
}

export interface Engine {
  enqueue(task: string, payload: unknown, opts?: EnqueueOptions): Promise<EnqueueResult>;
  getRun(id: string): Promise<Run | undefined>;
  /**
   * Sets a tenant's daily limits (UTC calendar day). Omitted limits are removed. While a tenant is at a
   * limit its runs are deferred: queued runs are not claimed and running runs pause at their next step.
   */
  setTenantBudget(tenant: string, budget: TenantBudget): Promise<void>;
  /**
   * Replaces a run's budget. Omitted limits are removed. Takes effect the next time the run is claimed,
   * so raise it before approving an over-budget escalation.
   */
  setRunBudget(runId: string, budget: Partial<Usage>): Promise<void>;
  /** Approval requests that are still waiting for a decision, oldest first. */
  listPendingApprovals(): Promise<Approval[]>;
  /** Records a reviewer's decision and resumes the run. resolved is false if it was already decided or timed out. */
  resolveApproval(runId: string, name: string, decision: ApprovalDecision): Promise<{ resolved: boolean }>;
  /** Resolves every open forEvent wait on eventName. Returns how many waits it resolved. */
  sendEvent(eventName: string, payload?: unknown): Promise<{ resolved: number }>;
  createWorker(options: WorkerOptions): Worker;
  close(): Promise<void>;
}

export function createEngine(options: EngineOptions): Engine {
  const pool = new pg.Pool({ connectionString: options.connectionString });

  return {
    async enqueue(task, payload, opts = {}) {
      const values = [
        opts.queue ?? "default",
        task,
        JSON.stringify(payload ?? {}),
        opts.maxAttempts ?? 3,
        opts.tenant ?? null,
        opts.budget?.usd ?? null,
        opts.budget?.tokens ?? null,
      ];
      if (opts.idempotencyKey === undefined) {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO runs (queue, task, payload, max_attempts, tenant, budget_usd, budget_tokens)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          values,
        );
        return { id: rows[0]!.id, created: true };
      }

      // One statement: take the key (new, or expired) and insert the run together. Concurrent
      // callers with the same key block on the key row, so exactly one of them inserts a run.
      const ttlMs = opts.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
      const { rows } = await pool.query<{ id: string }>(
        `WITH taken AS (
           INSERT INTO idempotency_keys (task, key, run_id, expires_at)
           VALUES ($2, $8, gen_random_uuid(), now() + make_interval(secs => $9::double precision / 1000))
           ON CONFLICT (task, key) DO UPDATE
             SET run_id = EXCLUDED.run_id, expires_at = EXCLUDED.expires_at
             WHERE idempotency_keys.expires_at <= now()
           RETURNING run_id
         )
         INSERT INTO runs (id, queue, task, payload, max_attempts, tenant, budget_usd, budget_tokens)
         SELECT run_id, $1, $2, $3, $4, $5, $6, $7 FROM taken
         RETURNING id`,
        [...values, opts.idempotencyKey, ttlMs],
      );
      if (rows[0]) return { id: rows[0].id, created: true };

      const existing = await pool.query<{ run_id: string }>(
        `SELECT run_id FROM idempotency_keys WHERE task = $1 AND key = $2`,
        [task, opts.idempotencyKey],
      );
      return { id: existing.rows[0]!.run_id, created: false };
    },

    async getRun(id) {
      const { rows } = await pool.query(
        `SELECT id, queue, task, payload, status, attempt, result, last_error, errors,
                (SELECT coalesce(sum(usd), 0) FROM steps WHERE run_id = runs.id) AS usage_usd,
                (SELECT coalesce(sum(tokens), 0) FROM steps WHERE run_id = runs.id) AS usage_tokens
         FROM runs WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        queue: row.queue,
        task: row.task,
        payload: row.payload,
        status: row.status,
        attempt: row.attempt,
        result: row.result,
        lastError: row.last_error,
        errors: row.errors,
        usage: { usd: row.usage_usd, tokens: row.usage_tokens },
      };
    },

    async setTenantBudget(tenant, budget) {
      await pool.query(
        `INSERT INTO tenant_budgets (tenant, usd_per_day, tokens_per_day) VALUES ($1, $2, $3)
         ON CONFLICT (tenant) DO UPDATE
           SET usd_per_day = EXCLUDED.usd_per_day, tokens_per_day = EXCLUDED.tokens_per_day, updated_at = now()`,
        [tenant, budget.usdPerDay ?? null, budget.tokensPerDay ?? null],
      );
    },

    async listPendingApprovals() {
      const { rows } = await pool.query(
        `SELECT w.run_id, w.name, r.task, w.prompt, w.created_at,
                CASE WHEN w.wake_at = 'infinity' THEN NULL ELSE w.wake_at END AS expires_at
         FROM waits w JOIN runs r ON r.id = w.run_id
         WHERE w.kind IN ('approval', 'escalation') AND w.resolved_at IS NULL AND w.consumed_at IS NULL
         ORDER BY w.created_at`,
      );
      return rows.map(toApproval);
    },

    async resolveApproval(runId, name, decision) {
      const { rowCount } = await pool.query(
        `UPDATE waits SET resolved_at = now(), payload = $3
         WHERE run_id = $1 AND name = $2 AND kind IN ('approval', 'escalation')
           AND resolved_at IS NULL AND consumed_at IS NULL`,
        [runId, name, JSON.stringify(decision)],
      );
      return { resolved: (rowCount ?? 0) > 0 };
    },

    async setRunBudget(runId, budget) {
      await pool.query(`UPDATE runs SET budget_usd = $2, budget_tokens = $3, updated_at = now() WHERE id = $1`, [
        runId,
        budget.usd ?? null,
        budget.tokens ?? null,
      ]);
    },

    async sendEvent(eventName, payload) {
      const { rowCount } = await pool.query(
        `UPDATE waits SET resolved_at = now(), payload = $2
         WHERE event_name = $1 AND resolved_at IS NULL AND consumed_at IS NULL`,
        [eventName, JSON.stringify(payload ?? null)],
      );
      return { resolved: rowCount ?? 0 };
    },

    createWorker(workerOptions) {
      return createWorker(pool, workerOptions);
    },

    close() {
      return pool.end();
    },
  };
}

// Error entry for an attempt whose worker lost its lease (crashed, killed, or stalled past the lease).
// The cause is unknown, so it is recorded as a transient retry with zero confidence.
const LEASE_EXPIRED_ERROR = `jsonb_build_object(
  'attempt', attempt, 'name', 'LeaseExpired',
  'message', 'Worker lost its lease: it crashed, was killed, or stalled without heartbeats',
  'kind', 'transient', 'confidence', 0,
  'action', jsonb_build_object('type', 'retry', 'delayMs', 0),
  'at', to_jsonb(now()))`;

// True when the run's tenant has reached a daily limit for the current UTC day. Expects `runs` in scope.
const TENANT_OVER_BUDGET = `EXISTS (
  SELECT 1 FROM tenant_budgets b
  LEFT JOIN tenant_spend s ON s.tenant = b.tenant AND s.day = (now() AT TIME ZONE 'utc')::date
  WHERE b.tenant = runs.tenant
    AND ((b.usd_per_day IS NOT NULL AND coalesce(s.usd, 0) >= b.usd_per_day)
      OR (b.tokens_per_day IS NOT NULL AND coalesce(s.tokens, 0) >= b.tokens_per_day)))`;

// Error entry for an attempt cut short by stop({ timeoutMs }). It counts toward maxAttempts like any lost attempt.
const RELEASED_ERROR = `jsonb_build_object(
  'attempt', attempt, 'name', 'Released',
  'message', 'Worker shut down and released the run before its handler finished',
  'kind', 'transient', 'confidence', 1,
  'action', jsonb_build_object('type', 'retry', 'delayMs', 0),
  'at', to_jsonb(now()))`;

interface ClaimedRun {
  id: string;
  task: string;
  payload: unknown;
  attempt: number;
  max_attempts: number;
  hint: string | null;
  tenant: string | null;
  budget_usd: number | null;
  budget_tokens: number | null;
}

function createWorker(pool: pg.Pool, options: WorkerOptions): Worker {
  const id = `worker-${randomUUID()}`;
  const queue = options.queue ?? "default";
  const leaseMs = options.leaseMs ?? 30_000;
  const heartbeatMs = options.heartbeatMs ?? Math.floor(leaseMs / 3);
  const pollMs = options.pollMs ?? 50;
  const escalationTimeoutMs = options.escalationTimeoutMs ?? 24 * 60 * 60 * 1000;
  const classifier = options.classifier ?? new RuleClassifier();
  const policy = options.policy ?? defaultPolicy();
  let running = false;
  let loop: Promise<void> | undefined;
  let inFlight: { run: ClaimedRun; heartbeat: NodeJS.Timeout; released: boolean; abort: AbortController } | undefined;

  async function claim(): Promise<ClaimedRun | undefined> {
    // Poison pill guard: a run whose final attempt lost its lease goes dead instead of being claimed again.
    await pool.query(
      `UPDATE runs SET
         status = 'dead',
         last_error = ${LEASE_EXPIRED_ERROR},
         errors = errors || jsonb_build_array(${LEASE_EXPIRED_ERROR}),
         lease_owner = NULL, lease_expires = NULL, updated_at = now()
       WHERE id IN (
         SELECT id FROM runs
         WHERE queue = $1 AND status = 'running' AND lease_expires < now() AND attempt >= max_attempts
         FOR UPDATE SKIP LOCKED
       )`,
      [queue],
    );
    const { rows } = await pool.query<ClaimedRun>(
      `UPDATE runs SET
         last_error = CASE WHEN status = 'running' THEN ${LEASE_EXPIRED_ERROR} ELSE last_error END,
         errors = CASE WHEN status = 'running' THEN errors || jsonb_build_array(${LEASE_EXPIRED_ERROR}) ELSE errors END,
         status = 'running',
         -- Resuming from a wait continues the same attempt.
         attempt = attempt + CASE WHEN status = 'waiting' THEN 0 ELSE 1 END,
         lease_owner = $2,
         lease_expires = now() + make_interval(secs => $3::double precision / 1000),
         updated_at = now()
       WHERE id = (
         SELECT id FROM runs
         WHERE queue = $1 AND (
           (status = 'queued' AND run_after <= now())
           -- Expired lease: the owning worker crashed or stalled, so the run is reclaimable.
           OR (status = 'running' AND lease_expires < now() AND attempt < max_attempts)
           -- Waiting: the timer is due, or the event already arrived (checked here so no wakeup is lost).
           OR (status = 'waiting' AND (
             run_after <= now()
             OR EXISTS (SELECT 1 FROM waits w WHERE w.run_id = runs.id AND w.resolved_at IS NOT NULL AND w.consumed_at IS NULL)
           ))
         )
         -- Tenant budgets defer runs instead of failing them. Expired leases are still reclaimed:
         -- the run pauses at its next step if the tenant is still over.
         AND (tenant IS NULL OR status = 'running' OR NOT ${TENANT_OVER_BUDGET})
         ORDER BY run_after
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, task, payload, attempt, max_attempts, hint, tenant, budget_usd, budget_tokens`,
      [queue, id, leaseMs],
    );
    return rows[0];
  }

  // A run parked by an escalation resumes here once a person decided or the escalation timed out.
  // Returns false when the run must not execute (rejected or timed out).
  async function applyEscalationDecision(run: ClaimedRun): Promise<boolean> {
    const { rows } = await pool.query<{ resolved: boolean; payload: ApprovalDecision | null }>(
      `UPDATE waits SET consumed_at = now()
       WHERE run_id = $1 AND kind = 'escalation' AND consumed_at IS NULL
         AND (resolved_at IS NOT NULL OR wake_at <= now())
       RETURNING resolved_at IS NOT NULL AS resolved, payload`,
      [run.id],
    );
    const decision = rows[0];
    if (!decision) return true;

    if (decision.resolved && decision.payload?.approved) {
      // Approval grants one more attempt, even past maxAttempts.
      const hint = decision.payload.comment ?? `Approved by ${decision.payload.by ?? "a reviewer"}`;
      const { rows: updated } = await pool.query<{ attempt: number; max_attempts: number }>(
        `UPDATE runs SET attempt = attempt + 1, max_attempts = GREATEST(max_attempts, attempt + 1), hint = $3, updated_at = now()
         WHERE id = $1 AND lease_owner = $2
         RETURNING attempt, max_attempts`,
        [run.id, id, hint],
      );
      if (!updated[0]) return false;
      run.attempt = updated[0].attempt;
      run.max_attempts = updated[0].max_attempts;
      run.hint = hint;
      return true;
    }

    await pool.query(
      `UPDATE runs SET status = 'failed', lease_owner = NULL, lease_expires = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [run.id, id],
    );
    return false;
  }

  async function execute(run: ClaimedRun): Promise<void> {
    if (!(await applyEscalationDecision(run))) return;
    const handler = options.tasks[run.task];
    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      pool
        .query(
          `UPDATE runs SET lease_expires = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
           WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
          [run.id, id, leaseMs],
        )
        .then(({ rowCount }) => {
          if (rowCount === 0) {
            clearInterval(heartbeat);
            abort.abort(new LeaseLostError(`Worker ${id} lost the lease on run ${run.id}`));
          }
        })
        .catch(() => {
          // A missed heartbeat is survivable: the next one may land before the lease expires.
        });
    }, heartbeatMs);
    heartbeat.unref();
    const current = { run, heartbeat, released: false, abort };
    inFlight = current;
    let result: unknown;
    let error: unknown;
    let threw = false;
    try {
      if (!handler) throw new Error(`No handler registered for task "${run.task}"`);
      result = await handler(run.payload, {
        runId: run.id,
        attempt: run.attempt,
        ...(run.hint !== null && { hint: run.hint }),
        ...(await createContextApis(run, abort.signal)),
        signal: abort.signal,
      });
    } catch (err) {
      threw = true;
      error = err;
    } finally {
      clearInterval(heartbeat);
      inFlight = undefined;
    }
    // Released during shutdown: another worker may own the run now.
    if (current.released) return;
    // Another worker owns the run now; anything this worker writes would be fenced out anyway.
    if (error instanceof LeaseLostError) return;
    if (error instanceof RunSuspended) {
      await pool.query(
        `UPDATE runs SET
           status = 'waiting',
           -- No wait (budget pause): due at once, and the claim query holds it until the tenant has budget.
           run_after = coalesce((SELECT wake_at FROM waits WHERE run_id = $1 AND name = $3), now()),
           lease_owner = NULL, lease_expires = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [run.id, id, error.waitName],
      );
      return;
    }
    if (threw) {
      await recordFailure(run, error);
      return;
    }
    await pool.query(
      `UPDATE runs SET status = 'completed', result = $3, lease_owner = NULL, lease_expires = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [run.id, id, JSON.stringify(result ?? null)],
    );
  }

  async function createContextApis(
    run: ClaimedRun,
    signal: AbortSignal,
  ): Promise<{ step: StepApi; wait: WaitApi; approval: ApprovalApi }> {
    const { rows } = await pool.query<{ name: string; result: unknown; usd: number; tokens: number }>(
      `SELECT name, result, usd, tokens FROM steps WHERE run_id = $1`,
      [run.id],
    );
    const stored = new Map(rows.map((r) => [r.name, r.result]));
    // Only the lease holder adds steps, so in-memory totals stay exact for this attempt.
    const spent: Usage = {
      usd: rows.reduce((sum, r) => sum + r.usd, 0),
      tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
    };
    const seen = new Set<string>();

    const step: StepApi = {
      async run<T>(name: string, fn: (call: StepCall) => T | Promise<T>, options: StepOptions<T> = {}): Promise<T> {
        if (seen.has(name)) throw new DuplicateStepError(`Step "${name}" ran twice in run ${run.id}; step names must be unique`);
        seen.add(name);
        if (stored.has(name)) return stored.get(name) as T;

        const over = overBudget(spent, run);
        if (over) throw new OverBudgetError(`Run ${run.id} spent ${over} before step "${name}"`);
        if (run.tenant !== null) {
          const { rows: tenantRows } = await pool.query<{ over: boolean }>(
            `SELECT ${TENANT_OVER_BUDGET} AS over FROM runs WHERE id = $1`,
            [run.id],
          );
          if (tenantRows[0]?.over) {
            throw new RunSuspended(null, `Tenant ${run.tenant} is at its daily budget before step "${name}"`);
          }
        }

        const value = await fn({ idempotencyKey: `keel:${run.id}:${name}`, signal });
        const usage = options.usage?.(value) ?? {};
        const json = JSON.stringify(value ?? null);
        // Fenced on the lease so a zombie worker cannot store results for a run it lost.
        // The tenant's daily spend is updated in the same statement, so it can never drift from the steps.
        const { rows: inserted } = await pool.query<{ stored: number }>(
          `WITH ins AS (
             INSERT INTO steps (run_id, name, result, attempt, usd, tokens)
             SELECT $1, $2, $3::jsonb, $4, $6, $7
             WHERE EXISTS (SELECT 1 FROM runs WHERE id = $1 AND lease_owner = $5 AND status = 'running')
             ON CONFLICT (run_id, name) DO NOTHING
             RETURNING usd, tokens
           ), spend AS (
             INSERT INTO tenant_spend (tenant, day, usd, tokens)
             SELECT $8, (now() AT TIME ZONE 'utc')::date, usd, tokens FROM ins WHERE $8::text IS NOT NULL
             ON CONFLICT (tenant, day) DO UPDATE
               SET usd = tenant_spend.usd + EXCLUDED.usd, tokens = tenant_spend.tokens + EXCLUDED.tokens
           )
           SELECT count(*)::int AS stored FROM ins`,
          [run.id, name, json, run.attempt, id, usage.usd ?? 0, usage.tokens ?? 0, run.tenant],
        );
        if (inserted[0]!.stored === 0) throw new LeaseLostError(`Worker ${id} lost the lease on run ${run.id} during step "${name}"`);
        spent.usd += usage.usd ?? 0;
        spent.tokens += usage.tokens ?? 0;
        return JSON.parse(json) as T;
      },
    };

    // Registers the wait on first call and suspends. On replay, returns the outcome once it is final:
    // consuming the row decides between "event arrived" and "timed out" atomically.
    async function awaitWait(
      name: string,
      eventName: string | null,
      timeoutMs: number | undefined,
      approvalPrompt?: string,
    ): Promise<EventWaitResult> {
      if (seen.has(name)) throw new DuplicateStepError(`Step "${name}" ran twice in run ${run.id}; step names must be unique`);
      seen.add(name);

      const { rows: created } = await pool.query(
        `INSERT INTO waits (run_id, name, event_name, wake_at, kind, prompt)
         VALUES ($1, $2, $3, CASE WHEN $4::double precision IS NULL THEN 'infinity'::timestamptz
                                  ELSE now() + make_interval(secs => $4::double precision / 1000) END,
                 $5, $6)
         ON CONFLICT (run_id, name) DO NOTHING
         RETURNING run_id, name, prompt, created_at, CASE WHEN wake_at = 'infinity' THEN NULL ELSE wake_at END AS expires_at`,
        [run.id, name, eventName, timeoutMs ?? null, approvalPrompt === undefined ? "wait" : "approval", approvalPrompt ?? null],
      );
      if (created[0] && approvalPrompt !== undefined && options.onApprovalRequested) {
        try {
          await options.onApprovalRequested(toApproval({ ...created[0], task: run.task }));
        } catch (hookError) {
          console.error(`[keel] ${id} onApprovalRequested failed:`, hookError);
        }
      }
      const { rows } = await pool.query<{ resolved: boolean; payload: unknown }>(
        `UPDATE waits SET consumed_at = coalesce(consumed_at, now())
         WHERE run_id = $1 AND name = $2
           AND (consumed_at IS NOT NULL OR resolved_at IS NOT NULL OR wake_at <= now())
         RETURNING resolved_at IS NOT NULL AS resolved, payload`,
        [run.id, name],
      );
      const outcome = rows[0];
      if (!outcome) throw new RunSuspended(name);
      return outcome.resolved ? { timedOut: false, payload: outcome.payload } : { timedOut: true };
    }

    const wait: WaitApi = {
      async for(name, ms) {
        await awaitWait(name, null, ms);
      },
      forEvent(name, eventName, options = {}) {
        return awaitWait(name, eventName, options.timeoutMs);
      },
    };

    const approval: ApprovalApi = {
      async request(name, request) {
        const outcome = await awaitWait(name, null, request.timeoutMs, request.prompt);
        if (outcome.timedOut) return { status: "timed_out" };
        const decision = outcome.payload as ApprovalDecision;
        return {
          status: decision.approved ? "approved" : "rejected",
          ...(decision.by !== undefined && { by: decision.by }),
          ...(decision.comment !== undefined && { comment: decision.comment }),
        };
      },
    };

    return { step, wait, approval };
  }

  // A broken policy must not strand the run: its error becomes a fail action recorded on the run.
  function decide(verdict: FailureVerdict, ctx: FailureContext): FailureAction {
    try {
      const action = policy(verdict, ctx);
      const problem = invalidAction(action);
      if (!problem) return action;
      throw new Error(problem);
    } catch (policyError) {
      console.error(`[keel] ${id} failure policy error, failing the run:`, policyError);
      return { type: "fail", reason: `Policy error: ${policyError instanceof Error ? policyError.message : String(policyError)}` };
    }
  }

  async function escalate(
    run: ClaimedRun,
    error: unknown,
    verdict: FailureVerdict,
    action: Extract<FailureAction, { type: "escalate" }>,
  ): Promise<void> {
    const entry: RunError = {
      attempt: run.attempt,
      ...serializeError(error),
      kind: verdict.kind,
      confidence: verdict.confidence,
      action,
      at: new Date().toISOString(),
    };
    const name = `escalation-${run.attempt}`;
    const prompt = `"${run.task}" failed on attempt ${run.attempt} and needs a decision: ${action.reason}`;
    // Parking the run and opening the escalation happen in one statement, so neither exists without the other.
    const { rows } = await pool.query(
      `WITH parked AS (
         UPDATE runs SET
           status = 'waiting',
           run_after = now() + make_interval(secs => $5::double precision / 1000),
           last_error = $3::jsonb,
           errors = errors || jsonb_build_array($3::jsonb),
           lease_owner = NULL, lease_expires = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2
         RETURNING id
       )
       INSERT INTO waits (run_id, name, kind, prompt, wake_at)
       SELECT id, $4, 'escalation', $6, now() + make_interval(secs => $5::double precision / 1000) FROM parked
       ON CONFLICT (run_id, name) DO NOTHING
       RETURNING run_id, name, prompt, created_at, wake_at AS expires_at`,
      [run.id, id, JSON.stringify(entry), name, escalationTimeoutMs, prompt],
    );
    if (rows[0] && options.onApprovalRequested) {
      try {
        await options.onApprovalRequested(toApproval({ ...rows[0], task: run.task }));
      } catch (hookError) {
        console.error(`[keel] ${id} onApprovalRequested failed:`, hookError);
      }
    }
  }

  async function recordFailure(run: ClaimedRun, error: unknown): Promise<void> {
    const ctx: FailureContext = { error, task: run.task, payload: run.payload, attempt: run.attempt, maxAttempts: run.max_attempts };
    let verdict: FailureVerdict;
    try {
      verdict = await classifier.classify(ctx);
    } catch (classifierError) {
      console.error(`[keel] ${id} classifier error, treating failure as fatal:`, classifierError);
      verdict = { kind: "fatal", confidence: 0 };
    }
    const action = decide(verdict, ctx);
    if (action.type === "escalate") {
      await escalate(run, error, verdict, action);
      return;
    }
    const wantsRetry = action.type === "retry" || action.type === "retry_modified";
    const status = !wantsRetry ? "failed" : run.attempt >= run.max_attempts ? "dead" : "queued";
    const delayMs = action.type === "retry" ? action.delayMs : action.type === "retry_modified" ? (action.delayMs ?? 0) : 0;
    const hint = action.type === "retry_modified" && status === "queued" ? action.hint : null;
    const entry: RunError = {
      attempt: run.attempt,
      ...serializeError(error),
      kind: verdict.kind,
      confidence: verdict.confidence,
      action,
      at: new Date().toISOString(),
    };
    await pool.query(
      `UPDATE runs SET
         status = $3,
         run_after = now() + make_interval(secs => $4::double precision / 1000),
         hint = $5,
         last_error = $6::jsonb,
         errors = errors || jsonb_build_array($6::jsonb),
         lease_owner = NULL, lease_expires = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [run.id, id, status, delayMs, hint, JSON.stringify(entry)],
    );
  }

  async function runLoop(): Promise<void> {
    while (running) {
      try {
        const run = await claim();
        if (run) await execute(run);
        else await sleep(pollMs);
      } catch (err) {
        // Usually a database hiccup. The lease protects any claimed run, so back off and keep going.
        console.error(`[keel] ${id} loop error:`, err);
        await sleep(pollMs);
      }
    }
  }

  return {
    id,
    start() {
      if (running) return;
      running = true;
      loop = runLoop();
    },
    async stop(stopOptions = {}) {
      running = false;
      if (!loop) return;
      if (stopOptions.timeoutMs === undefined) {
        await loop;
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), stopOptions.timeoutMs);
      });
      const outcome = await Promise.race([loop.then(() => false as const), timedOut]);
      clearTimeout(timer);
      if (!outcome || !inFlight) return;

      const stuck = inFlight;
      stuck.released = true;
      clearInterval(stuck.heartbeat);
      stuck.abort.abort(new LeaseLostError(`Worker ${id} released run ${stuck.run.id} during shutdown`));
      await pool.query(
        `UPDATE runs SET
           status = CASE WHEN attempt >= max_attempts THEN 'dead'::run_status ELSE 'queued'::run_status END,
           last_error = ${RELEASED_ERROR},
           errors = errors || jsonb_build_array(${RELEASED_ERROR}),
           lease_owner = NULL, lease_expires = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [stuck.run.id, id],
      );
    },
  };
}

function invalidAction(action: FailureAction | undefined): string | undefined {
  const validDelay = (ms: unknown) => typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
  switch (action?.type) {
    case "retry":
      return validDelay(action.delayMs) ? undefined : `retry delayMs must be a finite number >= 0, got ${action.delayMs}`;
    case "retry_modified":
      return action.delayMs === undefined || validDelay(action.delayMs)
        ? undefined
        : `retry_modified delayMs must be a finite number >= 0, got ${action.delayMs}`;
    case "fallback":
    case "escalate":
    case "fail":
      return undefined;
    default:
      return `unknown action ${JSON.stringify(action)}`;
  }
}

function toApproval(row: {
  run_id: string;
  name: string;
  task: string;
  prompt: string;
  created_at: Date;
  expires_at: Date | null;
}): Approval {
  return { runId: row.run_id, name: row.name, task: row.task, prompt: row.prompt, requestedAt: row.created_at, expiresAt: row.expires_at };
}

function overBudget(spent: Usage, run: ClaimedRun): string | undefined {
  if (run.budget_usd !== null && spent.usd >= run.budget_usd) return `$${spent.usd} of its $${run.budget_usd} budget`;
  if (run.budget_tokens !== null && spent.tokens >= run.budget_tokens) return `${spent.tokens} of its ${run.budget_tokens} token budget`;
  return undefined;
}

function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "NonError", message: String(err) };
}
