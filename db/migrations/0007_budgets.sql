-- M6 budgets: usage is recorded per step (so replays never double count), rolled up per tenant per UTC day.
ALTER TABLE steps ADD COLUMN usd double precision NOT NULL DEFAULT 0;
ALTER TABLE steps ADD COLUMN tokens double precision NOT NULL DEFAULT 0;

ALTER TABLE runs ADD COLUMN tenant text;
ALTER TABLE runs ADD COLUMN budget_usd double precision;
ALTER TABLE runs ADD COLUMN budget_tokens double precision;

CREATE TABLE tenant_budgets (
  tenant          text PRIMARY KEY,
  usd_per_day     double precision,
  tokens_per_day  double precision,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_spend (
  tenant  text             NOT NULL,
  day     date             NOT NULL,
  usd     double precision NOT NULL DEFAULT 0,
  tokens  double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, day)
);
