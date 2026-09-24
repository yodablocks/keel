// Hand-labelled failure cases for comparing classifiers. Synthetic, but shaped like real errors from
// model SDKs, fetch, validation libraries and agent code. Replace or extend with your own failures.
// Explicit keel error classes (BadOutputError, ...) are left out: both classifiers handle them by rule.
import type { FailureKind } from "../src/index.ts";

export interface FailureCase {
  label: FailureKind;
  task: string;
  error: unknown;
}

function err(message: string, fields: Record<string, unknown> = {}, name = "Error"): Error {
  const e = Object.assign(new Error(message), fields);
  e.name = name;
  return e;
}

export const FAILURE_CASES: FailureCase[] = [
  // transient
  { label: "transient", task: "summarize", error: err("Request timed out.", {}, "APIConnectionTimeoutError") },
  { label: "transient", task: "summarize", error: err("Rate limit reached for gpt-4o on tokens per min. Limit 30000, Used 29810.", { status: 429 }) },
  { label: "transient", task: "crawl", error: err("socket hang up", { code: "ECONNRESET" }) },
  { label: "transient", task: "draft-reply", error: err("Overloaded", { status: 529 }) },
  { label: "transient", task: "crawl", error: new TypeError("fetch failed", { cause: err("connect ECONNREFUSED 10.0.0.5:443", { code: "ECONNREFUSED" }) }) },
  { label: "transient", task: "enrich-lead", error: err("Service Unavailable", { status: 503 }) },
  { label: "transient", task: "draft-reply", error: err("The server had an error while processing your request. Sorry about that!", {}, "InternalServerError") },
  { label: "transient", task: "crawl", error: err("getaddrinfo EAI_AGAIN api.example.com", { code: "EAI_AGAIN" }) },

  // bad_input
  { label: "bad_input", task: "summarize", error: err("This model's maximum context length is 128000 tokens. However, your messages resulted in 150213 tokens.", { status: 400, code: "context_length_exceeded" }) },
  { label: "bad_input", task: "send-email", error: err("Invalid email address in payload.to: 'bob@'") },
  { label: "bad_input", task: "ingest-document", error: err("Unsupported file type: .heic. Expected pdf, docx or txt") },
  { label: "bad_input", task: "charge", error: err("Expected number, received string at path amount", {}, "ZodError") },
  { label: "bad_input", task: "ingest-document", error: err("Document is empty: no text could be extracted from upload.pdf") },

  // bad_output
  { label: "bad_output", task: "extract-invoice", error: err('Unexpected token \'`\', "```json\n{"ti"... is not valid JSON', {}, "SyntaxError") },
  { label: "bad_output", task: "research-agent", error: err("Model requested tool `serch_web`, which is not in the provided tool list") },
  { label: "bad_output", task: "research-agent", error: err("Tool call arguments failed validation: missing required property 'query'") },
  { label: "bad_output", task: "summarize", error: err("Model response did not match schema: field 'summary' is required") },
  { label: "bad_output", task: "extract-invoice", error: err("Extracted invoice total 'twelve hundred' is not a number") },

  // needs_human
  { label: "needs_human", task: "refund", error: err("Refund of $900 exceeds the $500 auto-approval limit") },
  { label: "needs_human", task: "support-agent", error: err("Model refused: I can't help with requests to access another person's account.") },
  { label: "needs_human", task: "send-contract", error: err("Contract clause 7.2 conflicts with company policy; legal review required before sending") },
  { label: "needs_human", task: "update-crm", error: err("Two customer records match 'J. Smith'; cannot decide which account to update") },
  { label: "needs_human", task: "sync-calendar", error: err("Missing OAuth consent: the user must reconnect their Google account") },

  // fatal
  { label: "fatal", task: "summarize", error: new TypeError("Cannot read properties of undefined (reading 'map')") },
  { label: "fatal", task: "summarize", error: err("Incorrect API key provided: sk-...abcd", { status: 401 }) },
  { label: "fatal", task: "summarize", error: err("OPENAI_API_KEY environment variable is missing") },
  { label: "fatal", task: "summarize", error: new ReferenceError("summarize is not defined") },
  { label: "fatal", task: "summarize", error: err("The model `gpt-5-turbo-preview` does not exist or you do not have access to it.", { status: 404 }) },
  { label: "fatal", task: "reserch", error: err('No handler registered for task "reserch"') },
  { label: "fatal", task: "plan-trip", error: new RangeError("Maximum call stack size exceeded") },
];
