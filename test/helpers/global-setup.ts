import { migrate } from "../../src/migrate.ts";
import { DATABASE_URL } from "./db.ts";

export async function globalSetup() {
  await migrate(DATABASE_URL);
}
