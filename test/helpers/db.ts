import { randomUUID } from "node:crypto";

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel";

// Each test gets its own queue so test files can run in parallel against one database.
export function uniqueQueue(): string {
  return `test-${randomUUID()}`;
}
