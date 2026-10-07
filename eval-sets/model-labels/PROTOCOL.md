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

## Result, 2026-10-07

Labels in this directory, one file per model, written blind (each agent reported opening only the case file).
`node scripts/eval-rescore.ts --result eval-results/classifier-2026-10-07T07-57-20.json --cases
eval-sets/fresh-issues.json eval-sets/model-labels/{fable,opus,sonnet,haiku}.json`:

| Labeller | Kind, after / before | Action, after / before | Labels that mean "fail" (`fatal` + `bad_input`) |
|---|---|---|---|
| Human (committed labels) | 87 / 97 | 105 / 110 | 48 |
| fable | 91 / 94 | 107 / 110 | 48 |
| opus | 91 / 94 | 107 / 110 | 48 |
| sonnet | 84 / 93 | 102 / 106 | 46 |
| haiku | 81 / 85 | 99 / 106 | 46 |

Out of 120 (60 cases, two passes).

- **The conclusion holds across labellers.** The change loses under every model labelling, by kind and by
  action.
- **Only three models ran, not four.** The agent logs record the model each one ran on: `fable` ran on
  `claude-opus-5-5`, the same as `opus`; `sonnet` on `claude-sonnet-5-5`; `haiku` on `claude-haiku-4-5`. The
  `fable` request was accepted without an error but not honoured, and this was found only after the run. That is
  why `fable.json` and `opus.json` are byte-identical: one model, the same prompt, run twice. They count as one
  labeller, Opus 5.5. The three labellers are all from one vendor. `fable.json` is kept as the record of the
  second run.
- Agreement with the human labels on kind: 52 (fable, opus), 51 (sonnet), 37 (haiku) of 60. Haiku labels 21
  cases `bad_input` where the others mostly say `fatal`. Both kinds fail a run, and the change still loses on
  action under haiku's labels.
- The label mix was offered as the likely reason the two sets disagree. Every labeller marks 46 to 48 of these 60
  as errors that should fail the run, against 32 of 75 in the public set (human labels). So the difference is in
  the errors, not in one labeller's habits. Most errors here are configuration and API misuse, which a fallback to
  `fatal` gets right.
