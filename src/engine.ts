import pg from "pg";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultPolicy, RuleClassifier } from "./failure.ts";
import type { FailureAction, FailureClassifier, FailureContext, FailureKind, FailurePolicy, FailureVerdict } from "./failure.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "dead";

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
}

export interface EnqueueResult {
  id: string;
  /** False when an existing run with the same idempotency key was returned instead. */
  created: boolean;
}

export interface StepApi {
  /**
   * Runs fn once per run. After it succeeds its result is stored, and later attempts get the stored
   * result without calling fn. Results are JSON round-tripped, on the first run too, so a Date comes
   * back as a string either way. Names must be unique within a run.
   */
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
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
  createWorker(options: WorkerOptions): Worker;
  close(): Promise<void>;
}

export function createEngine(options: EngineOptions): Engine {
  const pool = new pg.Pool({ connectionString: options.connectionString });

  return {
    async enqueue(task, payload, opts = {}) {
      const values = [opts.queue ?? "default", task, JSON.stringify(payload ?? {}), opts.maxAttempts ?? 3];
      if (opts.idempotencyKey === undefined) {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO runs (queue, task, payload, max_attempts) VALUES ($1, $2, $3, $4) RETURNING id`,
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
           VALUES ($2, $5, gen_random_uuid(), now() + make_interval(secs => $6::double precision / 1000))
           ON CONFLICT (task, key) DO UPDATE
             SET run_id = EXCLUDED.run_id, expires_at = EXCLUDED.expires_at
             WHERE idempotency_keys.expires_at <= now()
           RETURNING run_id
         )
         INSERT INTO runs (id, queue, task, payload, max_attempts)
         SELECT run_id, $1, $2, $3, $4 FROM taken
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
        `SELECT id, queue, task, payload, status, attempt, result, last_error, errors FROM runs WHERE id = $1`,
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
      };
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

interface ClaimedRun {
  id: string;
  task: string;
  payload: unknown;
  attempt: number;
  max_attempts: number;
  hint: string | null;
}

function createWorker(pool: pg.Pool, options: WorkerOptions): Worker {
  const id = `worker-${randomUUID()}`;
  const queue = options.queue ?? "default";
  const leaseMs = options.leaseMs ?? 30_000;
  const heartbeatMs = options.heartbeatMs ?? Math.floor(leaseMs / 3);
  const pollMs = options.pollMs ?? 50;
  const classifier = options.classifier ?? new RuleClassifier();
  const policy = options.policy ?? defaultPolicy();
  let running = false;
  let loop: Promise<void> | undefined;
  let inFlight: { run: ClaimedRun; heartbeat: NodeJS.Timeout; released: boolean } | undefined;

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
         attempt = attempt + 1,
         lease_owner = $2,
         lease_expires = now() + make_interval(secs => $3::double precision / 1000),
         updated_at = now()
       WHERE id = (
         SELECT id FROM runs
         WHERE queue = $1 AND (
           (status = 'queued' AND run_after <= now())
           -- Expired lease: the owning worker crashed or stalled, so the run is reclaimable.
           OR (status = 'running' AND lease_expires < now() AND attempt < max_attempts)
         )
         ORDER BY run_after
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, task, payload, attempt, max_attempts, hint`,
      [queue, id, leaseMs],
    );
    return rows[0];
  }

  async function execute(run: ClaimedRun): Promise<void> {
    const handler = options.tasks[run.task];
    const heartbeat = setInterval(() => {
      pool
        .query(
          `UPDATE runs SET lease_expires = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
           WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
          [run.id, id, leaseMs],
        )
        .catch(() => {
          // A missed heartbeat is survivable: the next one may land before the lease expires.
        });
    }, heartbeatMs);
    heartbeat.unref();
    const current = { run, heartbeat, released: false };
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
        step: await createStepApi(run),
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

  async function createStepApi(run: ClaimedRun): Promise<StepApi> {
    const { rows } = await pool.query<{ name: string; result: unknown }>(
      `SELECT name, result FROM steps WHERE run_id = $1`,
      [run.id],
    );
    const stored = new Map(rows.map((r) => [r.name, r.result]));
    const seen = new Set<string>();

    return {
      async run<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
        if (seen.has(name)) throw new DuplicateStepError(`Step "${name}" ran twice in run ${run.id}; step names must be unique`);
        seen.add(name);
        if (stored.has(name)) return stored.get(name) as T;

        const json = JSON.stringify((await fn()) ?? null);
        // Fenced on the lease so a zombie worker cannot store results for a run it lost.
        const { rowCount } = await pool.query(
          `INSERT INTO steps (run_id, name, result, attempt)
           SELECT $1, $2, $3::jsonb, $4
           WHERE EXISTS (SELECT 1 FROM runs WHERE id = $1 AND lease_owner = $5 AND status = 'running')
           ON CONFLICT (run_id, name) DO NOTHING`,
          [run.id, name, json, run.attempt, id],
        );
        if (rowCount === 0) throw new LeaseLostError(`Worker ${id} lost the lease on run ${run.id} during step "${name}"`);
        return JSON.parse(json) as T;
      },
    };
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
    const action = policy(verdict, ctx);
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
      await pool.query(
        `UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [stuck.run.id, id],
      );
    },
  };
}

function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "NonError", message: String(err) };
}
