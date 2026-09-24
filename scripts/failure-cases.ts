// Hand-labelled failure cases for comparing classifiers. Synthetic, but shaped like real errors from
// model SDKs, fetch, validation libraries and agent code. Replace or extend with your own failures.
// Explicit keel error classes (BadOutputError, ...) are left out: both classifiers handle them by rule.
// Each case has the step that would have been running, and the model or tool output where there was one
// (M11). A missing handler fails before any step, so that case has none.
import type { FailureCase } from "./eval-cases.ts";

function err(message: string, fields: Record<string, unknown> = {}, name = "Error"): Error {
  const e = Object.assign(new Error(message), fields);
  e.name = name;
  return e;
}

export const FAILURE_CASES: FailureCase[] = [
  // transient
  { label: "transient", task: "summarize", error: err("Request timed out.", {}, "APIConnectionTimeoutError") , step: "summarize-call" },
  { label: "transient", task: "summarize", error: err("Rate limit reached for gpt-4o on tokens per min. Limit 30000, Used 29810.", { status: 429 }) , step: "summarize-call" },
  { label: "transient", task: "crawl", error: err("socket hang up", { code: "ECONNRESET" }) , step: "fetch-page" },
  { label: "transient", task: "draft-reply", error: err("Overloaded", { status: 529 }) , step: "draft-call" },
  { label: "transient", task: "crawl", error: new TypeError("fetch failed", { cause: err("connect ECONNREFUSED 10.0.0.5:443", { code: "ECONNREFUSED" }) }) , step: "fetch-page" },
  { label: "transient", task: "enrich-lead", error: err("Service Unavailable", { status: 503 }) , step: "lookup-company" },
  { label: "transient", task: "draft-reply", error: err("The server had an error while processing your request. Sorry about that!", {}, "InternalServerError") , step: "draft-call" },
  { label: "transient", task: "crawl", error: err("getaddrinfo EAI_AGAIN api.example.com", { code: "EAI_AGAIN" }) , step: "fetch-page" },

  // bad_input
  { label: "bad_input", task: "summarize", error: err("This model's maximum context length is 128000 tokens. However, your messages resulted in 150213 tokens.", { status: 400, code: "context_length_exceeded" }) , step: "summarize-call" },
  { label: "bad_input", task: "send-email", error: err("Invalid email address in payload.to: 'bob@'") , step: "validate-input" },
  { label: "bad_input", task: "ingest-document", error: err("Unsupported file type: .heic. Expected pdf, docx or txt") , step: "parse-upload" },
  { label: "bad_input", task: "charge", error: err("Expected number, received string at path amount", {}, "ZodError") , step: "validate-input" },
  { label: "bad_input", task: "ingest-document", error: err("Document is empty: no text could be extracted from upload.pdf") , step: "extract-text" },

  // bad_output
  { label: "bad_output", task: "extract-invoice", error: err('Unexpected token \'`\', "```json\n{"ti"... is not valid JSON', {}, "SyntaxError") , step: "extract-call", output: "```json\n{\"title\": \"Invoice 1042\", \"total\": 1200" },
  { label: "bad_output", task: "research-agent", error: err("Model requested tool `serch_web`, which is not in the provided tool list") , step: "choose-tool", output: { tool: "serch_web", arguments: { query: "durable execution" } } },
  { label: "bad_output", task: "research-agent", error: err("Tool call arguments failed validation: missing required property 'query'") , step: "choose-tool", output: { tool: "search_web", arguments: {} } },
  { label: "bad_output", task: "summarize", error: err("Model response did not match schema: field 'summary' is required") , step: "summarize-call", output: { title: "Q3 report", bullets: ["revenue up 12%"] } },
  { label: "bad_output", task: "extract-invoice", error: err("Extracted invoice total 'twelve hundred' is not a number") , step: "extract-call", output: { vendor: "Acme", total: "twelve hundred" } },

  // needs_human
  { label: "needs_human", task: "refund", error: err("Refund of $900 exceeds the $500 auto-approval limit") , step: "check-policy" },
  { label: "needs_human", task: "support-agent", error: err("Model refused: I can't help with requests to access another person's account.") , step: "answer-call", output: "I can't help with requests to access another person's account." },
  { label: "needs_human", task: "send-contract", error: err("Contract clause 7.2 conflicts with company policy; legal review required before sending") , step: "review-contract" },
  { label: "needs_human", task: "update-crm", error: err("Two customer records match 'J. Smith'; cannot decide which account to update") , step: "match-customer", output: [{ id: "cus_1", name: "J. Smith" }, { id: "cus_2", name: "Jane Smith" }] },
  { label: "needs_human", task: "sync-calendar", error: err("Missing OAuth consent: the user must reconnect their Google account") , step: "list-events" },

  // fatal
  { label: "fatal", task: "summarize", error: new TypeError("Cannot read properties of undefined (reading 'map')") , step: "format-summary" },
  { label: "fatal", task: "summarize", error: err("Incorrect API key provided: sk-...abcd", { status: 401 }) , step: "summarize-call" },
  { label: "fatal", task: "summarize", error: err("OPENAI_API_KEY environment variable is missing") , step: "summarize-call" },
  { label: "fatal", task: "summarize", error: new ReferenceError("summarize is not defined") , step: "format-summary" },
  { label: "fatal", task: "summarize", error: err("The model `gpt-5-turbo-preview` does not exist or you do not have access to it.", { status: 404 }) , step: "summarize-call" },
  { label: "fatal", task: "reserch", error: err('No handler registered for task "reserch"')  },
  { label: "fatal", task: "plan-trip", error: new RangeError("Maximum call stack size exceeded") , step: "build-itinerary" },
];
