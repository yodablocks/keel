# Eval sets

Failure cases for `pnpm eval:classifier --cases <file>`, in addition to the synthetic fixture in
`scripts/failure-cases.ts`.

## public-issues.json

76 error messages copied verbatim from public GitHub issues of agent and model SDKs: openai-node,
anthropic-sdk-typescript, vercel/ai, langchainjs, openai-agents-js, the MCP TypeScript SDK and undici.
Collected on 2026-10-07. Each case links to its issue (`source`) and keeps the reported line as written
(`reported`).

How it was built, so it can be checked:

- Error lines were taken from code blocks in issues returned by GitHub searches for common error names
  (`Error`, `AI_APICallError`, `fetch failed`, `OutputParserException`, ...) in those repositories.
- Dropped: test assertion failures, errors cut off mid-message by a line break, and near-duplicates of a kept line.
- `name` and `message` are split from the reported line. `status` is set only for SDK errors whose message
  starts with an HTTP status (the SDK sets it on the error object), and `code` only for Node and undici errors
  whose class carries it (for example `ECONNRESET`, `UND_ERR_SOCKET`). Nothing else is added.
- There is no step or output, and `task` is the neutral `"agent"`: inventing context would bring back
  the authorship problem this set exists to avoid.
- Cases are shuffled with a fixed seed, so neighbouring cases don't share a source.

What it does not fix:

- **One labeller, and it is the classifier's author.** The messages were written by other people, and the labels
  were committed (c070723) before any classifier ran on the set, so they can't have been tuned to the results.
  But they are still one person's judgement, and that person also wrote the classifier prompt.
- **Reported, not observed.** These are errors people hit and posted, mostly while developing. The labelled mix
  is 25 `fatal`, 22 `bad_output`, 20 `transient`, 7 `bad_input` and 1 `needs_human`, so the set says almost
  nothing about escalation.
- **No context.** Without step and output, the M11 step-context comparison does not apply to this set.

Labelling notes, 2026-10-07: 75 of 76 cases are labelled. **P03** (`AIUnknownError: An error has occurred`) is
left unlabelled and so excluded, because the message carries no information to judge from. For **P01** the
labeller asked for a suggestion; Claude suggested `needs_human` (with `fatal` as the alternative) and that label
was chosen. Every other label was made without suggestions.

## openroles-2026-10-07.json

The one failure from the first `pnpm openroles:sync` run (447 boards): a Lever board that answered 404. Exported
with `--blind` and labelled the same way. One case is a record, not a score.

## Labelling rules

Label with `pnpm eval:label eval-sets/public-issues.json` before any classifier has been run on the set.

- Judge from what the case shows. Don't run a classifier, and don't open the source issue unless a message is
  unreadable without it; the issue's discussion often reveals the cause.
- Pick the kind that decides what the engine should do next: retry later, fail, retry with a correction, or
  ask a person. When two kinds fit, pick the one whose action would be right more often.
- Commit the labelled file before running `pnpm eval:classifier --cases`. Don't change a label after seeing
  results; if a label turns out to be wrong, report the score with both labels.
