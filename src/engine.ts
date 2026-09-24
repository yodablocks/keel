import pg from "pg";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "dead";

export interface Run {
  id: string;
  queue: string;
  task: string;
  payload: unknown;
  status: RunStatus;
  attempt: number;
  result: unknown;
  lastError: unknown;
}

export interface EngineOptions {
  connectionString: string;
}

export interface EnqueueOptions {
  queue?: string;
}

export type TaskHandler = (payload: unknown) => Promise<unknown>;

export interface WorkerOptions {
  queue?: string;
  tasks: Record<string, TaskHandler>;
  leaseMs?: number;
  pollMs?: number;
}

export interface Worker {
  readonly id: string;
  start(): void;
  stop(): Promise<void>;
}

export interface Engine {
  enqueue(task: string, payload: unknown, opts?: EnqueueOptions): Promise<{ id: string }>;
  getRun(id: string): Promise<Run | undefined>;
  createWorker(options: WorkerOptions): Worker;
  close(): Promise<void>;
}

export function createEngine(options: EngineOptions): Engine {
  const pool = new pg.Pool({ connectionString: options.connectionString });

  return {
    async enqueue(task, payload, opts = {}) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO runs (queue, task, payload) VALUES ($1, $2, $3) RETURNING id`,
        [opts.queue ?? "default", task, JSON.stringify(payload ?? {})],
      );
      return { id: rows[0]!.id };
    },

    async getRun(id) {
      const { rows } = await pool.query(
        `SELECT id, queue, task, payload, status, attempt, result, last_error FROM runs WHERE id = $1`,
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

interface ClaimedRun {
  id: string;
  task: string;
  payload: unknown;
}

function createWorker(pool: pg.Pool, options: WorkerOptions): Worker {
  const id = `worker-${randomUUID()}`;
  const queue = options.queue ?? "default";
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  let running = false;
  let loop: Promise<void> | undefined;

  async function claim(): Promise<ClaimedRun | undefined> {
    const { rows } = await pool.query<ClaimedRun>(
      `UPDATE runs SET
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
           OR (status = 'running' AND lease_expires < now())
         )
         ORDER BY run_after
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, task, payload`,
      [queue, id, leaseMs],
    );
    return rows[0];
  }

  async function execute(run: ClaimedRun): Promise<void> {
    const handler = options.tasks[run.task];
    if (!handler) throw new Error(`No handler registered for task "${run.task}"`);
    const result = await handler(run.payload);
    await pool.query(
      `UPDATE runs SET status = 'completed', result = $3, lease_owner = NULL, lease_expires = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [run.id, id, JSON.stringify(result ?? null)],
    );
  }

  async function runLoop(): Promise<void> {
    while (running) {
      const run = await claim();
      if (run) await execute(run);
      else await sleep(pollMs);
    }
  }

  return {
    id,
    start() {
      if (running) return;
      running = true;
      loop = runLoop();
    },
    async stop() {
      running = false;
      await loop;
    },
  };
}
