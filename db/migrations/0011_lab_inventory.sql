-- The lab inventory (LIMS-12, LIMS-13, LIMS-14, LIMS-34, LIMS-35), the Logbook way: an item is a row (what it is and its
-- facts as received or prepared) and insert-only entries; whether it may be used now, and why not, is computed from the
-- entries (shared/engine/items.ts), never stored. Registering the row is its receipt (a bought item) or its preparation
-- (a made one); its uses are read from the analyses' step events that name it ("lab:<id>").

-- Item numbers: one counter per kind prefix and plant year, never reused (item_no is unique): RS260001, VS260002.
create table lab_item_counters (
  prefix text not null,
  year integer not null,
  last_no integer not null check (last_no >= 1),
  primary key (prefix, year)
);

-- kind: reference (primary or official standard), working (working standard), reagent, solution (prepared or test
-- solution), vs (volumetric solution), column, medium (culture medium), culture. facts: what was recorded at
-- registration (shared/engine/items.ts ItemFacts). parent_ids: what it was made from or qualified against (a working
-- standard's primary, a solution's reagents, a culture's parent culture), traced both ways.
create table lab_items (
  id bigint generated always as identity primary key,
  item_no text not null unique,
  kind text not null check (kind in ('reference', 'working', 'reagent', 'solution', 'vs', 'column', 'medium', 'culture')),
  name text not null check (length(trim(name)) between 1 and 200),
  facts jsonb not null,
  parent_ids bigint[] not null default '{}',
  registered_by bigint not null references users(id),
  registered_at timestamptz not null default now()
);
create index lab_items_kind on lab_items (kind, id);
create index lab_items_parents on lab_items using gin (parent_ids);
create trigger lab_items_insert_only before update or delete or truncate on lab_items
  for each statement execute function refuse_change();

-- The entries: opened, standardised (VS: factor, next due), qualified (working standard: potency, basis, next due),
-- growth_promotion (medium: passed, organisms), checked (a second person's check of the latest of those three:
-- payload.of), retest (new retest date), blocked, unblocked, disposed (a column: retired), note.
create table lab_item_events (
  id bigint generated always as identity primary key,
  item_id bigint not null references lab_items(id),
  kind text not null check (kind in ('opened', 'standardised', 'qualified', 'growth_promotion', 'checked', 'retest', 'blocked', 'unblocked', 'disposed', 'note')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create index lab_item_events_item on lab_item_events (item_id, id);
create unique index lab_item_events_checked_once on lab_item_events (item_id, ((payload->>'of')::bigint)) where kind = 'checked';
create unique index lab_item_events_disposed_once on lab_item_events (item_id) where kind = 'disposed';
create trigger lab_item_events_insert_only before update or delete or truncate on lab_item_events
  for each statement execute function refuse_change();

revoke all on lab_item_counters, lab_items, lab_item_events from lims_app;   -- the platform's default grants (0000)
revoke all on sequence lab_items_id_seq, lab_item_events_id_seq from lims_app;
grant select, insert, update (last_no) on lab_item_counters to lims_app;
grant select on lab_items, lab_item_events to lims_app;
grant insert (item_no, kind, name, facts, parent_ids, registered_by) on lab_items to lims_app;
grant insert (item_id, kind, payload, person_id) on lab_item_events to lims_app;
