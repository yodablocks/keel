-- M12: the fallback a run is on (sticky across attempts), and per-task budgets with daily spend.
ALTER TABLE runs ADD COLUMN fallback text;

CREATE TABLE task_budgets (
  task             text PRIMARY KEY,
  usd_per_run      double precision,
  tokens_per_run   double precision,
  usd_per_day      double precision,
  tokens_per_day   double precision,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_spend (
  task    text             NOT NULL,
  day     date             NOT NULL,
  usd     double precision NOT NULL DEFAULT 0,
  tokens  double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (task, day)
);
