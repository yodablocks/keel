import pg from "pg";

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

export interface Engine {
  enqueue(task: string, payload: unknown, opts?: EnqueueOptions): Promise<{ id: string }>;
  getRun(id: string): Promise<Run | undefined>;
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

    close() {
      return pool.end();
    },
  };
}
