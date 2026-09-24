// Runs a 3-step agent whose final step never finishes, so the parent test can SIGKILL it mid-step.
import { createEngine } from "../../src/index.ts";
import { DATABASE_URL } from "../helpers/db.ts";

const engine = createEngine({ connectionString: DATABASE_URL });
const worker = engine.createWorker({
  queue: process.env.KEEL_QUEUE!,
  leaseMs: Number(process.env.KEEL_LEASE_MS),
  tasks: {
    agent: async (_payload, ctx) => {
      const plan = await ctx.step.run("plan", () => ({ by: "child" }));
      const draft = await ctx.step.run("draft", () => `draft by ${plan.by}`);
      return ctx.step.run("send", async () => {
        process.stdout.write("in-send\n");
        await new Promise(() => {});
        return draft;
      });
    },
  },
});
worker.start();
