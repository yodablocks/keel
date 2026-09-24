import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, realpath, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

// A consumer in plain JavaScript: no TypeScript, no type stripping, only what the tarball ships.
const CONSUMER = `
import { createEngine, migrate } from "keel";

const url = process.env.DATABASE_URL;
const queue = process.env.KEEL_QUEUE;
await migrate(url);
const engine = createEngine({ connectionString: url });
const worker = engine.createWorker({
  queue,
  tasks: {
    agent: async (payload, ctx) => {
      const plan = await ctx.step.run("plan", () => "plan for " + payload.topic);
      await ctx.wait.for("pause", 200);
      return ctx.step.run("send", () => plan + ", sent");
    },
  },
});
worker.start();
const { id } = await engine.enqueue("agent", { topic: "packaging" }, { queue });
let run;
for (let i = 0; i < 100; i++) {
  run = await engine.getRun(id);
  if (run.status === "completed") break;
  await new Promise((r) => setTimeout(r, 50));
}
await worker.stop();
await engine.close();
console.log(JSON.stringify({ status: run.status, result: run.result }));
`;

test("the packed tarball works in a plain JavaScript project: a task with steps and a wait", { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "keel-pack-"));
  await run("pnpm", ["pack", "--pack-destination", dir], { cwd: root });
  const tarball = (await readdir(dir)).find((f) => f.endsWith(".tgz"));
  assert.ok(tarball, "pnpm pack produced a tarball");

  // Unpack instead of installing: link keel and the already-installed pg into a fresh project.
  const consumer = join(dir, "consumer");
  await mkdir(join(consumer, "node_modules"), { recursive: true });
  await run("tar", ["-xzf", join(dir, tarball!), "-C", consumer]);
  await symlink(join(consumer, "package"), join(consumer, "node_modules", "keel"));
  await symlink(await realpath(join(root, "node_modules", "pg")), join(consumer, "node_modules", "pg"));
  await access(join(consumer, "package", "dist", "index.d.ts")); // types ship too
  await writeFile(join(consumer, "index.mjs"), CONSUMER);

  const { stdout } = await run(process.execPath, ["index.mjs"], {
    cwd: consumer,
    env: { ...process.env, DATABASE_URL, KEEL_QUEUE: uniqueQueue() },
  });
  assert.deepEqual(JSON.parse(stdout.trim()), { status: "completed", result: "plan for packaging, sent" });
});
