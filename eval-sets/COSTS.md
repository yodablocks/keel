# What a wrong classification costs

Written 2026-10-07, after two comments on the public post about keel's eval (one asked for a cost matrix with
"retried something that needed a person" as the expensive cell, the other split the misses by direction). Fixed
here before the next fresh set is harvested. The numbers live in `scripts/eval-costs.ts`.

## Why accuracy isn't enough

Kind accuracy counts every miss the same. In keel a miss matters through the action the policy takes, and those
mistakes differ a lot in cost: failing a run that would have succeeded loses it, while retrying a run that was
going to fail anyway wastes a couple of attempts.

## Units

Each cost is in units of one wasted retry, judged from what keel does today:

| Unit | Cost | Why |
|---|---|---|
| Wasted attempts | 1 | A wrongly retried run uses up its remaining attempts (2 more by default, `maxAttempts` 3) and then fails anyway. Compute and model calls, nothing else. |
| Person's time | 2 | A wrong escalation parks the run until someone reads it and decides. Minutes of a person, worth more than a couple of automated attempts. |
| Lost run | 5 | A wrongly failed run stops for good: keel could not resume a failed run when this was written (see below), so the work done so far is lost, and someone has to notice and start it again. |
| Acted without approval | 20 | A case that needed a person was retried instead, so the agent may go ahead with what should have waited, such as a refund over a limit. Possibly irreversible. |

## Matrix

Rows are the right action (from the label), columns the action keel took (from the verdict).

| Right \ chosen | retry | retry with hint | fail | escalate |
|---|---|---|---|---|
| **retry** (`transient`) | 0 | 1 | 5 | 2 |
| **retry with hint** (`bad_output`) | 2 | 0 | 5 | 2 |
| **fail** (`fatal`, `bad_input`) | 1 | 1 | 0 | 2 |
| **escalate** (`needs_human`, `over_budget`) | 20 | 20 | 5 | 0 |

- **Retry with hint when it needed only a retry: 1.** The retry still happens; the hint adds noise.
- **Plain retry when it needed a hint: 2.** The model may repeat its mistake until the attempts run out.
- **Fail when it needed a person: 5.** Nothing harmful happens, but the run is lost and nobody was asked.

## What the numbers are not

- **Judgement, not measurement.** No cost here comes from production data. The ratios matter more than the values.
- **Not neutral about the fallback.** Before writing this, one of the comments had already shown the fallback
  change wins on the fresh set when a lost run costs more than about 3 or 4 wasted retries, and 5 is above that.
  That is why cost results on `public-issues.json` and `fresh-issues.json` are exploratory only: both sets were
  seen before the costs were set.
- **The 20 assumes the classifier is the last guard.** Often it isn't: a check that raised "needs approval" will
  usually raise it again on retry, and an explicit `NeedsHumanError` skips the classifier entirely. The cost is
  for the case where it is the last guard.

## Later change to keel

After this table was committed, keel gained `engine.retryRun`: a person can retry a failed run, and it resumes after
its completed steps. A wrong `fail` is still a lost run until someone notices it, so the cost stays at 5, unchanged
before any set was scored with it. The sensitivity column at 2 covers the case where failures are reviewed and
retried quickly.

## Sensitivity

Every cost result is also reported with a lost run at 2 and 10, and acting without approval at 10 and 50. A
conclusion that flips inside that range is reported as depending on the costs.

## Decision rule for the next fresh set

For the no-signal fallback change (PR #25) on a fresh set harvested after this file is merged:

- Primary metric: total cost under the table above, change vs as shipped, summed over both passes, from the same
  Jev answers.
- **Change costs less than or the same as shipped: ship it as the default.** Otherwise keep the fallback.
- Report the sensitivity columns. If the verdict flips inside that range, the result is reported as depending on
  the costs, and the decision stands but is marked as such.
- Report kind accuracy and misses by direction too, as before.
