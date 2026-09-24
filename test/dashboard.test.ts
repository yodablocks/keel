import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createEngine, NeedsHumanError, startDashboard } from "../src/index.ts";
import { DATABASE_URL, uniqueQueue } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

async function setup(t: import("node:test").TestContext) {
  const engine = createEngine({ connectionString: DATABASE_URL });
  const queue = uniqueQueue();
  const worker = engine.createWorker({
    queue,
    tasks: {
      refund: async (_payload, ctx) => {
        await ctx.step.run("load-order", () => ({ orderId: 42 }), { usage: () => ({ usd: 0.02 }) });
        if (!ctx.hint) throw new NeedsHumanError("refund of $900 is over the $500 limit");
        return `refunded (${ctx.hint})`;
      },
    },
  });
  const dashboard = await startDashboard({ engine, port: 0, refreshSeconds: 0 });
  t.after(async () => {
    await worker.stop();
    await dashboard.close();
    await engine.close();
  });
  worker.start();
  return { engine, queue, dashboard };
}

async function escalatedRun(engine: ReturnType<typeof createEngine>, queue: string, payload: unknown = { orderId: 42 }) {
  const { id } = await engine.enqueue("refund", payload, { queue });
  await waitFor(async () => (await engine.getRun(id))?.status === "waiting", 5000, "run to be escalated");
  return id;
}

function formToken(page: string): string {
  return /name="csrf" value="([^"]+)"/.exec(page)![1]!;
}

async function post(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

test("the run list shows a queue's runs and filters by status", async (t) => {
  const { engine, queue, dashboard } = await setup(t);
  const id = await escalatedRun(engine, queue);

  const all = await (await fetch(`${dashboard.url}/?queue=${queue}`)).text();
  assert.match(all, new RegExp(`href="/runs/${id}"`));
  assert.match(all, /refund of \$900 is over the \$500 limit/, "the pending escalation is listed at the top");

  // The run leaves the table; the approvals panel still links to it, since it still needs a decision.
  const completedOnly = await (await fetch(`${dashboard.url}/?queue=${queue}&status=completed`)).text();
  assert.match(completedOnly, /No runs match\./);
  const waitingOnly = await (await fetch(`${dashboard.url}/?queue=${queue}&status=waiting`)).text();
  assert.match(waitingOnly.slice(waitingOnly.indexOf('<table class="runs">')), new RegExp(`/runs/${id}`));
});

test("a run's page shows its steps, errors and the decision form", async (t) => {
  const { engine, queue, dashboard } = await setup(t);
  const id = await escalatedRun(engine, queue);

  const page = await (await fetch(`${dashboard.url}/runs/${id}`)).text();
  assert.match(page, /load-order/);
  assert.match(page, /NeedsHumanError/);
  assert.match(page, /needs_human/);
  assert.match(page, /Escalated to you/);
  assert.equal((await fetch(`${dashboard.url}/runs/00000000-0000-0000-0000-000000000000`)).status, 404);
});

test("approving an escalation from the dashboard resumes the run with the comment as its hint", async (t) => {
  const { engine, queue, dashboard } = await setup(t);
  const id = await escalatedRun(engine, queue);
  const page = await (await fetch(`${dashboard.url}/runs/${id}`)).text();
  const name = /name="name" value="([^"]+)"/.exec(page)![1]!;

  const res = await post(`${dashboard.url}/approvals`, { csrf: formToken(page), runId: id, name, decision: "approve", by: "alice", comment: "limit raised" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/runs/${id}?flash=approved`);

  await waitFor(async () => (await engine.getRun(id))?.status === "completed", 5000, "run to complete");
  assert.equal((await engine.getRun(id))?.result, "refunded (limit raised)");
});

test("rejecting an escalation fails the run", async (t) => {
  const { engine, queue, dashboard } = await setup(t);
  const id = await escalatedRun(engine, queue);
  const page = await (await fetch(`${dashboard.url}/runs/${id}`)).text();
  const name = /name="name" value="([^"]+)"/.exec(page)![1]!;

  await post(`${dashboard.url}/approvals`, { csrf: formToken(page), runId: id, name, decision: "reject" });
  await waitFor(async () => (await engine.getRun(id))?.status === "failed", 5000, "run to fail");
});

test("run data is escaped, never rendered as HTML", async (t) => {
  const { engine, queue, dashboard } = await setup(t);
  const id = await escalatedRun(engine, queue, { note: "<script>alert(1)</script>", quote: '"><img src=x>' });

  const page = await (await fetch(`${dashboard.url}/runs/${id}`)).text();
  assert.doesNotMatch(page, /<script>alert/);
  assert.doesNotMatch(page, /<img src=x>/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("pages forbid scripts and framing", async (t) => {
  const { dashboard } = await setup(t);
  const csp = (await fetch(dashboard.url)).headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("a decision without the page's token, or from another origin, is refused", async (t) => {
  const { engine, queue, dashboard } = await setup(t);
  const id = await escalatedRun(engine, queue);
  const page = await (await fetch(`${dashboard.url}/runs/${id}`)).text();
  const name = /name="name" value="([^"]+)"/.exec(page)![1]!;
  const fields = { runId: id, name, decision: "approve" };

  assert.equal((await post(`${dashboard.url}/approvals`, fields)).status, 403, "no token");
  assert.equal((await post(`${dashboard.url}/approvals`, { ...fields, csrf: "forged" })).status, 403, "wrong token");
  assert.equal(
    (await post(`${dashboard.url}/approvals`, { ...fields, csrf: formToken(page) }, { origin: "https://evil.example" })).status,
    403,
    "other origin",
  );
  assert.equal((await engine.getRun(id))?.status, "waiting", "the run was not approved");
});

test("requests addressed to another host are refused (DNS rebinding)", async (t) => {
  const { dashboard } = await setup(t);
  const { port } = new URL(dashboard.url);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers: { host: `evil.example:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});
