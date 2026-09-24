// A small operator dashboard: run list, run logbook, and approve/reject for pending approvals.
// No dependencies and no JavaScript: server-rendered HTML with plain forms, served by node:http.
// Meant for local or internal use. It has no login, so never expose it publicly.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Approval, Engine, Run, RunError, RunStatus, StepRecord, WaitRecord } from "./engine.ts";

export interface DashboardOptions {
  engine: Engine;
  /** Defaults to 127.0.0.1. Binding elsewhere exposes an unauthenticated dashboard to that network. */
  host?: string;
  /** Defaults to 4400. Use 0 for any free port. */
  port?: number;
  /** Seconds between automatic page refreshes; 0 disables. Defaults to 5. */
  refreshSeconds?: number;
}

export interface Dashboard {
  url: string;
  close(): Promise<void>;
}

const STATUSES: RunStatus[] = ["queued", "running", "waiting", "completed", "failed", "dead"];
const TERMINAL: RunStatus[] = ["completed", "failed", "dead"];
const MAX_FORM_BYTES = 16 * 1024;

export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const { engine } = options;
  const host = options.host ?? "127.0.0.1";
  const refreshSeconds = options.refreshSeconds ?? 5;
  // Forms carry this token; a page on another site cannot read it, so it cannot forge a decision.
  const csrfToken = randomBytes(24).toString("base64url");
  let port = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[keel dashboard]", err);
      if (!res.headersSent) send(res, 500, page("Error", html`<p class="empty">Something went wrong. See the server log.</p>`));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding guard: on loopback, only answer requests addressed to loopback.
    if (isLoopback(host) && !isLoopbackHost(req.headers.host ?? "", port)) {
      return send(res, 403, page("Forbidden", html`<p class="empty">Unexpected Host header.</p>`));
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") return send(res, 200, await listPage(url));
    const detail = /^\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === "GET" && detail) {
      const pageHtml = await runPage(detail[1]!, url.searchParams.get("flash"));
      return pageHtml ? send(res, 200, pageHtml) : send(res, 404, page("Not found", html`<p class="empty">No run with that id.</p>`));
    }
    if (req.method === "POST" && url.pathname === "/approvals") return decide(req, res);
    return send(res, 404, page("Not found", html`<p class="empty">Nothing here.</p>`));
  }

  async function decide(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) {
      return send(res, 403, page("Forbidden", html`<p class="empty">Cross-site form submission refused.</p>`));
    }
    const form = await readForm(req);
    if (!form || !sameToken(form.get("csrf") ?? "", csrfToken)) {
      return send(res, 403, page("Forbidden", html`<p class="empty">Missing or invalid form token. Reload the page and try again.</p>`));
    }
    const runId = form.get("runId") ?? "";
    const name = form.get("name") ?? "";
    const decision = form.get("decision");
    if (!/^[0-9a-f-]{36}$/.test(runId) || !name || (decision !== "approve" && decision !== "reject")) {
      return send(res, 400, page("Bad request", html`<p class="empty">Incomplete decision.</p>`));
    }
    const by = form.get("by")?.trim();
    const comment = form.get("comment")?.trim();
    const { resolved } = await engine.resolveApproval(runId, name, {
      approved: decision === "approve",
      ...(by && { by }),
      ...(comment && { comment }),
    });
    const flash = resolved ? (decision === "approve" ? "approved" : "rejected") : "already-decided";
    res.writeHead(303, { Location: `/runs/${runId}?flash=${flash}` });
    res.end();
  }

  async function listPage(url: URL): Promise<string> {
    const params = url.searchParams;
    const filter = {
      ...(isStatus(params.get("status")) && { status: params.get("status") as RunStatus }),
      ...(params.get("queue") && { queue: params.get("queue")! }),
      ...(params.get("task") && { task: params.get("task")! }),
      ...(params.get("tenant") && { tenant: params.get("tenant")! }),
      limit: Number(params.get("limit")) || 100,
    };
    const { status: _status, limit: _limit, ...scope } = filter;
    const [runs, approvals] = await Promise.all([engine.listRuns(filter), engine.listPendingApprovals({ ...scope, limit: 5000 })]);
    const counts = STATUSES.map((s) => [s, runs.filter((r) => r.status === s).length] as const);

    const body = html`
      <section class="readouts" aria-label="Runs on this page by status">
        ${counts.map(([s, n]) => html`<div class="readout ${n === 0 ? "zero" : ""}"><span class="n">${n}</span><span class="status s-${s}">${s}</span></div>`)}
      </section>

      ${approvals.length > 0
        ? html`<section class="signals" aria-labelledby="signals-h">
            <h2 id="signals-h"><span class="flag" aria-hidden="true"></span>Awaiting a decision <span class="count">${approvals.length}</span>${approvals.length > 20 ? html` <span class="dim">newest 20 shown</span>` : ""}</h2>
            <ul>${approvals.slice(-20).reverse().map(
              (a) => html`<li><a href="/runs/${a.runId}"><span class="task">${a.task}</span><span class="prompt">${a.prompt}</span><span class="mono dim">${a.name} · ${ago(a.requestedAt)}</span></a></li>`,
            )}</ul>
          </section>`
        : ""}

      <form class="filters" method="get" action="/" aria-label="Filter runs">
        <label>Status <select name="status"><option value="">any</option>${STATUSES.map(
          (s) => html`<option value="${s}" ${params.get("status") === s ? raw("selected") : ""}>${s}</option>`,
        )}</select></label>
        <label>Queue <input name="queue" value="${params.get("queue") ?? ""}" autocomplete="off"></label>
        <label>Task <input name="task" value="${params.get("task") ?? ""}" autocomplete="off"></label>
        <label>Tenant <input name="tenant" value="${params.get("tenant") ?? ""}" autocomplete="off"></label>
        <button type="submit">Filter</button>
        <a class="reset" href="/">Reset</a>
      </form>

      ${runs.length === 0
        ? html`<p class="empty">No runs match.</p>`
        : html`<table class="runs">
            <thead><tr><th>Status</th><th>Task</th><th>Queue</th><th>Tenant</th><th class="num">Attempt</th><th class="num">Spent</th><th>Updated</th><th>Run</th></tr></thead>
            <tbody>${runs.map(
              (r, i) => html`<tr style="--i:${Math.min(i, 30)}">
                <td>${statusBadge(r.status)}</td>
                <td><a href="/runs/${r.id}">${r.task}</a></td>
                <td class="mono">${r.queue}</td>
                <td class="mono dim">${r.tenant ?? "·"}</td>
                <td class="num mono">${r.attempt}</td>
                <td class="num mono">${usd(r.usage.usd)}</td>
                <td class="mono dim" title="${r.updatedAt.toISOString()}">${ago(r.updatedAt)}</td>
                <td class="mono"><a href="/runs/${r.id}">${r.id.slice(0, 8)}</a></td>
              </tr>`,
            )}</tbody>
          </table>`}`;
    return page("Runs", body, refreshSeconds);
  }

  async function runPage(id: string, flash: string | null): Promise<string | undefined> {
    const detail = await engine.getRunDetail(id);
    if (!detail) return undefined;
    const { run, steps, waits } = detail;
    const pending = waits.filter((w) => w.status === "pending" && (w.kind === "approval" || w.kind === "escalation"));
    const log = logbook(run.errors, steps, waits);

    const body = html`
      <p class="crumbs"><a href="/">Runs</a> / <span class="mono">${run.id}</span></p>
      ${flash ? html`<p class="flash" role="status">${flashText(flash)}</p>` : ""}

      <header class="run-head">
        <div>
          <h1>${run.task}</h1>
          <p class="mono dim">${run.queue}${run.tenant ? html` · tenant ${run.tenant}` : ""}</p>
        </div>
        ${statusBadge(run.status, true)}
      </header>

      <dl class="facts">
        <div><dt>Attempt</dt><dd class="mono">${run.attempt}</dd></div>
        <div><dt>Spent</dt><dd class="mono">${usd(run.usage.usd)} · ${run.usage.tokens.toLocaleString("en-US")} tok</dd></div>
        <div><dt>Created</dt><dd class="mono" title="${run.createdAt.toISOString()}">${stamp(run.createdAt)}</dd></div>
        <div><dt>Next eligible</dt><dd class="mono">${TERMINAL.includes(run.status) ? "·" : run.runAfter ? stamp(run.runAfter) : "on event"}</dd></div>
      </dl>

      ${pending.map((w) => decisionForm(run, w, csrfToken))}

      <div class="columns">
        <section aria-labelledby="log-h">
          <h2 id="log-h">Logbook</h2>
          ${log.length === 0 ? html`<p class="empty">Nothing recorded yet.</p>` : html`<ol class="log">${log}</ol>`}
        </section>
        <aside>
          <h2>Payload</h2>
          <pre>${json(run.payload)}</pre>
          ${run.status === "completed" ? html`<h2>Result</h2><pre>${json(run.result)}</pre>` : ""}
        </aside>
      </div>`;
    // Never auto-refresh a page with an open decision form: it would wipe what the reviewer is typing.
    const refresh = TERMINAL.includes(run.status) || pending.length > 0 ? 0 : refreshSeconds;
    return page(`${run.task} · ${run.id.slice(0, 8)}`, body, refresh);
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 4400, host, resolve));
  port = (server.address() as AddressInfo).port;
  const shownHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shownHost}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// ---------- logbook ----------

type Entry = { at: Date; html: Html };

function logbook(errors: RunError[], steps: StepRecord[], waits: WaitRecord[]): Html[] {
  const entries: Entry[] = [
    ...steps.map((s) => ({
      at: s.completedAt,
      html: html`<li class="entry step">
        <time class="mono" datetime="${s.completedAt.toISOString()}">${clock(s.completedAt)}</time>
        <div><p><strong>${s.name}</strong> <span class="dim">step completed, attempt ${s.attempt}</span>
          <span class="mono cost">${usd(s.usd)}${s.tokens ? html` · ${s.tokens.toLocaleString("en-US")} tok` : ""}</span></p>
          <details><summary>result</summary><pre>${json(s.result)}</pre></details></div>
      </li>`,
    })),
    ...errors.map((e) => ({
      at: new Date(e.at),
      html: html`<li class="entry error">
        <time class="mono" datetime="${e.at}">${clock(new Date(e.at))}</time>
        <div><p><strong>${e.name}</strong>${e.step ? html` <span class="dim">in ${e.step}</span>` : ""} <span class="dim">attempt ${e.attempt}</span></p>
          <p class="message">${e.message}</p>
          <p class="verdict mono"><span class="kind k-${e.kind}">${e.kind}</span> ${e.confidence.toFixed(2)} → ${actionText(e.action)}
            ${e.status !== undefined ? html` · HTTP ${e.status}` : ""}${e.code !== undefined ? html` · ${String(e.code)}` : ""}</p>
          ${e.output !== undefined ? html`<details><summary>output</summary><pre>${json(e.output)}</pre></details>` : ""}</div>
      </li>`,
    })),
    ...waits.map((w) => ({
      at: w.createdAt,
      html: html`<li class="entry wait ${w.status === "pending" ? "open" : ""}">
        <time class="mono" datetime="${w.createdAt.toISOString()}">${clock(w.createdAt)}</time>
        <div><p><strong>${w.name}</strong> <span class="dim">${waitLabel(w)}</span> <span class="mono dim">${w.status.replace("_", " ")}</span></p>
          ${w.prompt ? html`<p class="message">${w.prompt}</p>` : ""}
          ${w.status === "resolved" && w.payload !== null ? html`<details><summary>${w.kind === "wait" ? "event" : "decision"}</summary><pre>${json(w.payload)}</pre></details>` : ""}</div>
      </li>`,
    })),
  ];
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime()).map((e) => e.html);
}

function decisionForm(run: Run, w: WaitRecord, csrf: string): Html {
  return html`<section class="decision" aria-labelledby="d-${w.name}">
    <h2 id="d-${w.name}"><span class="flag" aria-hidden="true"></span>${w.kind === "escalation" ? "Escalated to you" : "Approval requested"}</h2>
    <p class="prompt">${w.prompt ?? ""}</p>
    ${w.kind === "escalation" ? html`<p class="dim">Approving retries the run once more with your comment as its hint. Rejecting fails it.</p>` : ""}
    <form method="post" action="/approvals">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="runId" value="${run.id}">
      <input type="hidden" name="name" value="${w.name}">
      <label>Your name <input name="by" autocomplete="name" maxlength="120"></label>
      <label class="wide">Comment <textarea name="comment" rows="2" maxlength="2000" placeholder="${w.kind === "escalation" ? "Becomes the run's hint on retry" : "Optional"}"></textarea></label>
      <div class="buttons">
        <button type="submit" name="decision" value="approve" class="approve">Approve</button>
        <button type="submit" name="decision" value="reject" class="reject">Reject</button>
      </div>
    </form>
  </section>`;
}

// ---------- safe HTML ----------

class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

function raw(value: string): Html {
  return new Html(value);
}

/** Tagged template that escapes every interpolated value unless it is already Html. */
function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new Html(out);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(String(v));
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- helpers ----------

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    // No scripts at all; inline styles only; forms may only post back here.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return undefined;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isLoopbackHost(hostHeader: string, port: number): boolean {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader.toLowerCase());
}

function isStatus(value: string | null): boolean {
  return value !== null && (STATUSES as string[]).includes(value);
}

function statusBadge(status: RunStatus, large = false): Html {
  return html`<span class="status s-${status} ${large ? "large" : ""}"><span class="dot" aria-hidden="true"></span>${status}</span>`;
}

function waitLabel(w: WaitRecord): string {
  if (w.kind === "escalation") return "escalated to a person";
  if (w.kind === "approval") return "approval requested";
  return w.eventName ? `waiting for event ${w.eventName}` : `sleeping${w.wakeAt ? ` until ${clock(w.wakeAt)}` : ""}`;
}

function actionText(a: RunError["action"]): string {
  switch (a.type) {
    case "retry":
      return `retry in ${a.delayMs} ms`;
    case "retry_modified":
      return `retry with hint`;
    case "fallback":
      return `fall back to ${a.target}`;
    case "escalate":
      return "escalate";
    case "fail":
      return "fail";
  }
}

function flashText(flash: string): string {
  if (flash === "approved") return "Approved. The run will resume shortly.";
  if (flash === "rejected") return "Rejected.";
  return "This request was already decided or has timed out.";
}

function json(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n... (truncated)` : text;
}

function usd(n: number): string {
  return `$${n.toFixed(n !== 0 && n < 0.01 ? 4 : 2)}`;
}

function clock(d: Date): string {
  return d.toISOString().slice(11, 23);
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ") + "Z";
}

function ago(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------- page ----------

function page(title: string, body: Html, refreshSeconds = 0): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds > 0 ? html`<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${title} · keel</title>
<style>${raw(STYLES)}</style>
</head>
<body>
<header class="masthead">
  <a href="/" class="mark"><span class="glyph" aria-hidden="true"></span>keel</a>
  <span class="dim">logbook</span>
  <span class="warn">No login. Keep this dashboard on localhost.</span>
</header>
<main>${body}</main>
</body>
</html>`.value;
}

const STYLES = `
:root {
  --paper: #f3efe6; --paper-2: #ebe5d8; --rule: #d9d1bf; --ink: #1d2733; --ink-2: #4b5664; --ink-3: #7c8591;
  --signal: #cf4f1c; --signal-bg: #fbe7dc;
  --s-queued: #6f7885; --s-running: #1f5f9c; --s-waiting: #a86a07; --s-completed: #22704f; --s-failed: #a33a26; --s-dead: #3b3f46;
  --serif: "Iowan Old Style", "Charter", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  --mono: "Berkeley Mono", "JetBrains Mono", "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0e1620; --paper-2: #142130; --rule: #24344a; --ink: #e8e2d4; --ink-2: #b3b0a6; --ink-3: #7d8796;
    --signal: #ff8a4c; --signal-bg: #3a1f12;
    --s-queued: #8e97a4; --s-running: #6aa9e6; --s-waiting: #e0a53c; --s-completed: #5cc49a; --s-failed: #ef7a62; --s-dead: #9aa0a8;
  }
}
* { box-sizing: border-box; }
html { background: var(--paper); }
body { margin: 0; color: var(--ink); font: 16px/1.5 var(--serif); font-variant-numeric: tabular-nums;
  background-image: linear-gradient(var(--paper) 0 0), repeating-linear-gradient(0deg, transparent 0 27px, color-mix(in srgb, var(--rule) 35%, transparent) 27px 28px);
  background-size: 100% 132px, 100% 100%; background-repeat: no-repeat, repeat; min-height: 100vh; }
a { color: inherit; text-decoration-color: var(--rule); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--signal); }
:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.mono { font-family: var(--mono); font-size: 0.8125rem; }
.dim { color: var(--ink-3); }
.masthead { display: flex; align-items: baseline; gap: 0.75rem; padding: 1.25rem clamp(1rem, 4vw, 3rem); border-bottom: 3px double var(--rule); }
.mark { font-size: 1.5rem; font-weight: 700; letter-spacing: 0.02em; text-decoration: none; display: inline-flex; align-items: center; gap: 0.5rem; }
.glyph { width: 0.9rem; height: 0.9rem; border: 2px solid var(--ink); border-top: none; border-radius: 0 0 50% 50%; transform: translateY(-2px); }
.warn { margin-left: auto; font-family: var(--mono); font-size: 0.72rem; color: var(--ink-3); }
main { padding: 1.5rem clamp(1rem, 4vw, 3rem) 4rem; max-width: 1280px; }
h1 { font-size: 2rem; line-height: 1.1; margin: 0 0 0.25rem; font-weight: 700; }
h2 { font-size: 0.8rem; font-family: var(--mono); font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-2); margin: 0 0 0.75rem; }
.readouts { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); margin-bottom: 1.5rem; }
.readout { background: var(--paper); padding: 0.6rem 0.9rem; display: flex; flex-direction: column; }
.readout .n { font-family: var(--mono); font-size: 1.6rem; line-height: 1.1; }
.readout.zero { opacity: 0.45; }
.status { display: inline-flex; align-items: center; gap: 0.4rem; font-family: var(--mono); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; }
.status .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: currentColor; }
.status.large { font-size: 0.9rem; padding: 0.35rem 0.8rem; border: 1px solid currentColor; border-radius: 999px; }
.s-queued { color: var(--s-queued); } .s-running { color: var(--s-running); } .s-waiting { color: var(--s-waiting); }
.s-completed { color: var(--s-completed); } .s-failed { color: var(--s-failed); } .s-dead { color: var(--s-dead); }
.s-running .dot { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
.signals, .decision { border: 1px solid var(--signal); border-left-width: 6px; background: var(--signal-bg); padding: 1rem 1.25rem; margin-bottom: 1.5rem; }
.signals h2, .decision h2 { color: var(--signal); display: flex; align-items: center; gap: 0.5rem; }
.flag { width: 0.8rem; height: 0.8rem; background: linear-gradient(135deg, var(--signal) 50%, transparent 50%), linear-gradient(315deg, var(--signal) 50%, var(--paper) 50%); border: 1px solid var(--signal); }
.count { font-family: var(--mono); background: var(--signal); color: var(--paper); border-radius: 999px; padding: 0 0.5rem; }
.signals ul { list-style: none; margin: 0; padding: 0; }
.signals li a { display: grid; grid-template-columns: 12rem 1fr auto; gap: 1rem; padding: 0.45rem 0; border-top: 1px dashed color-mix(in srgb, var(--signal) 35%, transparent); text-decoration: none; }
.signals .task { font-weight: 700; }
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 0.75rem 1rem; margin-bottom: 1rem; font-family: var(--mono); font-size: 0.75rem; color: var(--ink-2); }
.filters label { display: flex; flex-direction: column; gap: 0.2rem; text-transform: uppercase; letter-spacing: 0.08em; }
input, select, textarea { font: 0.875rem var(--mono); color: var(--ink); background: var(--paper); border: 1px solid var(--rule); border-radius: 3px; padding: 0.4rem 0.5rem; min-width: 10rem; }
textarea { width: 100%; resize: vertical; }
button { font: 600 0.8rem var(--mono); text-transform: uppercase; letter-spacing: 0.08em; padding: 0.5rem 1rem; border-radius: 3px; border: 1px solid var(--ink); background: var(--ink); color: var(--paper); cursor: pointer; }
button:hover { background: var(--ink-2); }
.reset { font-family: var(--mono); font-size: 0.75rem; padding-bottom: 0.5rem; }
table.runs { width: 100%; border-collapse: collapse; }
.runs th { text-align: left; font: 600 0.7rem var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); padding: 0.4rem 0.6rem; border-bottom: 2px solid var(--ink); }
.runs td { padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--rule); vertical-align: baseline; }
.runs tbody tr { animation: rise 0.35s ease-out both; animation-delay: calc(var(--i) * 18ms); }
.runs tbody tr:hover { background: var(--paper-2); }
.num { text-align: right; }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }
.empty { color: var(--ink-3); font-style: italic; padding: 2rem 0; }
.crumbs { font-size: 0.9rem; color: var(--ink-3); margin: 0 0 1rem; }
.flash { font-family: var(--mono); font-size: 0.8rem; border-left: 3px solid var(--s-completed); padding: 0.4rem 0.8rem; background: var(--paper-2); }
.run-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); margin: 0 0 1.5rem; }
.facts div { background: var(--paper); padding: 0.6rem 0.9rem; }
.facts dt { font: 600 0.7rem var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); }
.facts dd { margin: 0.15rem 0 0; }
.decision .prompt { font-size: 1.15rem; margin: 0 0 0.5rem; }
.decision form { display: grid; grid-template-columns: 14rem 1fr; gap: 0.75rem 1rem; align-items: end; margin-top: 0.75rem; }
.decision label { display: flex; flex-direction: column; gap: 0.2rem; font: 0.72rem var(--mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-2); }
.decision .buttons { grid-column: 1 / -1; display: flex; gap: 0.6rem; }
button.approve { background: var(--s-completed); border-color: var(--s-completed); }
button.reject { background: transparent; color: var(--s-failed); border-color: var(--s-failed); }
.columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem); gap: 2rem; }
@media (max-width: 900px) { .columns { grid-template-columns: 1fr; } .signals li a { grid-template-columns: 1fr; gap: 0.1rem; } .decision form { grid-template-columns: 1fr; } }
.log { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--rule); }
.entry { display: grid; grid-template-columns: 7.5rem 1fr; gap: 1rem; padding: 0.5rem 0 0.75rem 1rem; position: relative; }
.entry::before { content: ""; position: absolute; left: -0.4rem; top: 0.85rem; width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--paper); border: 2px solid var(--ink-3); }
.entry.step::before { border-color: var(--s-completed); background: var(--s-completed); }
.entry.error::before { border-color: var(--s-failed); }
.entry.wait::before { border-color: var(--s-waiting); }
.entry.wait.open::before { background: var(--signal); border-color: var(--signal); }
.entry time { color: var(--ink-3); padding-top: 0.15rem; }
.entry p { margin: 0; }
.entry .message { margin-top: 0.15rem; }
.entry .cost { color: var(--ink-3); margin-left: 0.4rem; }
.verdict { margin-top: 0.25rem !important; color: var(--ink-2); }
.kind { padding: 0 0.35rem; border-radius: 3px; background: var(--paper-2); border: 1px solid var(--rule); }
.k-transient { color: var(--s-running); } .k-bad_output, .k-over_budget { color: var(--s-waiting); } .k-needs_human { color: var(--signal); }
.k-bad_input, .k-fatal { color: var(--s-failed); }
details summary { cursor: pointer; font: 0.72rem var(--mono); color: var(--ink-3); margin-top: 0.25rem; }
pre { font: 0.78rem/1.45 var(--mono); background: var(--paper-2); border: 1px solid var(--rule); border-radius: 3px; padding: 0.6rem 0.75rem; overflow-x: auto; margin: 0.35rem 0 1rem; white-space: pre-wrap; word-break: break-word; }
@media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; } }
`;
