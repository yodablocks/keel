// Eval case format shared by the synthetic fixture, `pnpm eval:export` and `pnpm eval:classifier --cases`.
import pg from "pg";
import { readFile } from "node:fs/promises";
import type { FailureKind, RunError } from "../src/index.ts";

export interface FailureCase {
  label: FailureKind;
  task: string;
  error: unknown;
  step?: string;
  output?: unknown;
}

/** One exported failure, as written to disk. `label` stays null until a person fills it in. */
export interface ExportedCase {
  label: FailureKind | null;
  /** What keel classified it as at the time. For reference only: copying it into `label` makes the eval circular. */
  recordedKind: FailureKind;
  task: string;
  step?: string;
  error: Pick<RunError, "name" | "message" | "status" | "code" | "cause">;
  output?: unknown;
  runId: string;
  attempt: number;
}

// Engine-generated entries are not handler failures, so there is nothing to classify.
const ENGINE_ENTRIES = ["LeaseExpired", "Released"];

export async function exportFailures(
  connectionString: string,
  { queue, since, limit = 500 }: { queue?: string; since?: Date; limit?: number } = {},
): Promise<ExportedCase[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; task: string; e: RunError }>(
      `SELECT r.id, r.task, e
       FROM runs r, jsonb_array_elements(r.errors) e
       WHERE ($1::text IS NULL OR r.queue = $1)
         AND ($2::timestamptz IS NULL OR (e->>'at')::timestamptz >= $2)
         AND NOT (e->>'name' = ANY($3))
       ORDER BY (e->>'at')::timestamptz DESC
       LIMIT $4`,
      [queue ?? null, since ?? null, ENGINE_ENTRIES, limit],
    );
    return rows.map(({ id, task, e }) => ({
      label: null,
      recordedKind: e.kind,
      task,
      ...(e.step !== undefined && { step: e.step }),
      error: {
        name: e.name,
        message: e.message,
        ...(e.status !== undefined && { status: e.status }),
        ...(e.code !== undefined && { code: e.code }),
        ...(e.cause !== undefined && { cause: e.cause }),
      },
      ...(e.output !== undefined && { output: e.output }),
      runId: id,
      attempt: e.attempt,
    }));
  } finally {
    await client.end();
  }
}

/** Loads an exported file. Cases without a label are skipped and counted. */
export async function loadCases(file: string): Promise<{ cases: FailureCase[]; skipped: number }> {
  const exported = JSON.parse(await readFile(file, "utf8")) as ExportedCase[];
  const labelled = exported.filter((c) => c.label !== null);
  return {
    cases: labelled.map((c) => ({
      label: c.label!,
      task: c.task,
      error: rebuildError(c.error),
      ...(c.step !== undefined && { step: c.step }),
      ...(c.output !== undefined && { output: c.output }),
    })),
    skipped: exported.length - labelled.length,
  };
}

// Rebuilds an Error with the same fields rules and Jev read live: name, message, status, code, cause.
function rebuildError(e: ExportedCase["error"]): Error {
  const error = new Error(e.message, e.cause === undefined ? undefined : { cause: new Error(e.cause) });
  error.name = e.name;
  return Object.assign(error, {
    ...(e.status !== undefined && { status: e.status }),
    ...(e.code !== undefined && { code: e.code }),
  });
}
