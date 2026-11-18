-- Reserve (retention) samples (LIMS-30), the Logbook way: a row and insert-only entries; the status (kept, visual
-- inspection overdue, below the required quantity, destroyed) is computed from them (shared/engine/reserve.ts), never
-- stored. One reserve sample per lot or batch, kept from its release sample.

-- sample_id: the release sample of the lot or batch (its item, lot and specification version). amount and unit: the
-- quantity kept (the unit the specification's reserveQuantity names). rule and from_date: how long it is kept (1 year
-- after expiry; 3 years after complete distribution; 2 years after release) and the date that counts from, typed from
-- the batch record or MMS; kept_until: typed, checked to be at least from_date plus the rule's years.
create table reserve_samples (
  id bigint generated always as identity primary key,
  sample_id bigint not null unique references samples(id),
  amount numeric not null check (amount > 0),
  unit text not null check (length(trim(unit)) between 1 and 40),
  location text not null check (length(trim(location)) between 1 and 200),
  rule text not null check (rule in ('expiry', 'distribution', 'starting material')),
  from_date date not null,
  kept_until date not null,
  logged_by bigint not null references users(id),
  logged_at timestamptz not null default now()
);
create trigger reserve_samples_insert_only before update or delete or truncate on reserve_samples
  for each statement execute function refuse_change();

-- The entries: inspected (the yearly visual inspection: payload.finding, a deterioration with its reason), withdrawn
-- (payload.amount in the reserve's unit, reason), destroyed (reason), checked (a second person's check of a withdrawal or
-- the destruction: payload.of), note.
create table reserve_sample_events (
  id bigint generated always as identity primary key,
  reserve_id bigint not null references reserve_samples(id),
  kind text not null check (kind in ('inspected', 'withdrawn', 'destroyed', 'checked', 'note')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create index reserve_sample_events_reserve on reserve_sample_events (reserve_id, id);
create unique index reserve_sample_events_checked_once on reserve_sample_events (reserve_id, ((payload->>'of')::bigint)) where kind = 'checked';
create unique index reserve_sample_events_destroyed_once on reserve_sample_events (reserve_id) where kind = 'destroyed';
create trigger reserve_sample_events_insert_only before update or delete or truncate on reserve_sample_events
  for each statement execute function refuse_change();

revoke all on reserve_samples, reserve_sample_events from lims_app;   -- the platform's default grants (0000)
revoke all on sequence reserve_samples_id_seq, reserve_sample_events_id_seq from lims_app;
grant select on reserve_samples, reserve_sample_events to lims_app;
grant insert (sample_id, amount, unit, location, rule, from_date, kept_until, logged_by) on reserve_samples to lims_app;
grant insert (reserve_id, kind, payload, person_id) on reserve_sample_events to lims_app;
