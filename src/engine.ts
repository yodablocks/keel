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
  /** How often a running handler extends its lease. Defaults to a third of leaseMs. */
  heartbeatMs?: number;
  pollMs?: number;
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
  const heartbeatMs = options.heartbeatMs ?? Math.floor(leaseMs / 3);
  const pollMs = options.pollMs ?? 50;
  let running = false;
  let loop: Promise<void> | undefined;
  let inFlight: { run: ClaimedRun; heartbeat: NodeJS.Timeout; released: boolean } | undefined;

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
      result = await handler(run.payload);
    } catch (err) {
      threw = true;
      error = err;
    } finally {
      clearInterval(heartbeat);
      inFlight = undefined;
    }
    // Released during shutdown: another worker may own the run now.
    if (current.released) return;
    if (threw) {
      await pool.query(
        `UPDATE runs SET status = 'failed', last_error = $3, lease_owner = NULL, lease_expires = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [run.id, id, JSON.stringify(serializeError(error))],
      );
      return;
    }
    await pool.query(
      `UPDATE runs SET status = 'completed', result = $3, lease_owner = NULL, lease_expires = NULL, updated_at = now()
       WHERE id = $1 AND lease_owner = $2`,
      [run.id, id, JSON.stringify(result ?? null)],
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
