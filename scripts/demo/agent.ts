// The demo agent: research -> plan -> draft -> send -> follow-up, with a scripted fake model and
// tools that misbehave on cue. Every model and tool call is a durable step with its cost reported.
import { setTimeout as sleep } from "node:timers/promises";
import type { TaskHandler } from "../../src/index.ts";

export const TASK = "research-agent";
export const TOOLS = ["search_web", "read_page"];

let emailCalls = 0;

export function agent(log: (line: string) => void, draftMs: number): TaskHandler {
  return async (payload, ctx) => {
    const { topic } = payload as { topic: string };

    const research = await ctx.step.run(
      "research",
      async () => {
        log("calling model for research");
        await sleep(200);
        return { notes: [`${topic} keeps state in a database`, "steps are replayed after a crash"] };
      },
      { usage: () => ({ usd: 0.04, tokens: 1800 }) },
    );

    const plan = await ctx.step.run(
      "plan",
      async () => {
        if (!ctx.hint) {
          log("calling model for plan");
          // The model hallucinates a tool name on its first try.
          const call = { tool: "serch_web", query: topic };
          if (!TOOLS.includes(call.tool)) {
            throw new Error(`Model requested tool \`${call.tool}\`, which is not in the provided tool list`);
          }
          return call;
        }
        log("calling model for plan (with hint)");
        return { tool: "search_web", query: topic };
      },
      { usage: () => ({ usd: 0.03, tokens: 900 }) },
    );

    const draft = await ctx.step.run(
      "draft",
      async () => {
        log("calling model for draft");
        await sleep(draftMs);
        return `A short brief on ${topic}, from ${research.notes.length} notes and a ${plan.tool} for "${plan.query}".`;
      },
      { usage: () => ({ usd: 0.05, tokens: 2600 }) },
    );

    const sent = await ctx.step.run(
      "send",
      async ({ idempotencyKey }) => {
        emailCalls++;
        log(`sending email (idempotency key ${idempotencyKey})`);
        if (emailCalls === 1) throw Object.assign(new Error("429 Too Many Requests: email API rate limit"), { status: 429 });
        return { messageId: `msg-${idempotencyKey.split(":")[1]!.slice(0, 8)}` };
      },
      { usage: () => ({ usd: 0.01, tokens: 0 }) },
    );

    const followUp = await ctx.step.run(
      "follow-up",
      async () => {
        log("calling model for follow-up");
        return "Scheduled a follow-up question for next week.";
      },
      { usage: () => ({ usd: 0.02, tokens: 700 }) },
    );

    return { draft, messageId: sent.messageId, followUp };
  };
}
