import { migrate } from "../src/migrate.ts";

const url = process.env.DATABASE_URL ?? "postgres://keel:keel@localhost:5433/keel";
const applied = await migrate(url);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
