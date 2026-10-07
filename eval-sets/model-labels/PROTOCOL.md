# Model labellers on fresh-issues.json: protocol

Written 2026-10-07, after the fresh-set result (PR #25) and before any model labelled a case.

## Question

The no-signal fallback change lost on `fresh-issues.json` under one person's labels (cascade 43 and 44 of 60 after
the change, 49 and 48 before). Does that conclusion depend on who labels?

## Method

- Four model labellers, one per available model: `fable`, `opus`, `sonnet`, `haiku`. Each runs as a separate
  agent and sees only a text file with what `pnpm eval:label` showed the human labeller: id, task, error name and
  message, and `status` or `code` where present. No labels, no classifier answers, no source links, and an
  instruction not to open any other file or the web.
- The kind definitions given are the ones `pnpm eval:label` shows. Every case must get exactly one kind.
- Scoring uses the Jev answers already recorded in `eval-results/classifier-2026-10-07T07-57-20.json`: no new Jev
  calls. For each labeller: cascade before and after the change, by kind and by action, in both passes.
- Also reported: each labeller's agreement with the human labels and with each other.

## How the result will be read (fixed now)

- Primary metric, as in the original rule: kind accuracy, after vs before, summed over both passes.
- After < before under at least 3 of 4 labellers: **the conclusion holds across labellers.**
- After ≥ before under at least 3 of 4: **the conclusion depends on the labeller.** That gets reported in the
  README.
- Otherwise: **inconclusive.**
- In no case does this change the shipped decision. The human labels and the rule were fixed before the result.
  Switching to labels that favour a different answer after seeing it would be choosing labels by outcome.
  Reopening the change needs a new set with its labelling plan fixed in advance.

## Known bias

The labellers are language models, like Jev. They may agree with Jev more than a person does, which favours the
change, since the change uses Jev's answer more often. So a loss under model labels is stronger evidence than a
win. Four models from one vendor are also not four independent labellers.
