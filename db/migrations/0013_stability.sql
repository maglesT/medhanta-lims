-- Stability (LIMS-26, LIMS-27, LIMS-28), the Logbook way: protocols are a third kind of master version (reviewed and
-- approved as methods and specifications); a study is a row and insert-only entries, its schedule, stock and what is due
-- computed from them (shared/engine/stability.ts), never stored.

-- Stability protocols: the same table, review and approval as methods and specifications (LIMS-01, LIMS-26).
alter table master_versions drop constraint master_versions_kind_check;
alter table master_versions add constraint master_versions_kind_check check (kind in ('method', 'spec', 'protocol'));

-- Study numbers: one counter per plant year, never reused (study_no is unique): STB26001.
create table stability_counters (
  year integer primary key,
  last_no integer not null check (last_no >= 1)
);

-- A study: one approved or effective protocol version applied to one batch (TrueBatch) or lot (MMS), placed on t0 (the
-- plant date of the placement). item and source as a sample's (0007): what it is, and where the batch or lot was read
-- (or typed by hand while the link was absent or down; then a second person checks the study). cell: the matrixing cell
-- this batch is (its own time points), if the protocol is matrixed.
create table stability_studies (
  id bigint generated always as identity primary key,
  study_no text not null unique,
  protocol_version_id bigint not null references master_versions(id),
  lot_no text not null check (length(trim(lot_no)) between 1 and 60),
  item jsonb not null,
  source jsonb not null,
  cell text check (length(trim(cell)) between 1 and 120),
  t0 date not null,
  created_by bigint not null references users(id),
  created_at timestamptz not null default now()
);
create trigger stability_studies_insert_only before update or delete or truncate on stability_studies
  for each statement execute function refuse_change();

-- The entries: placed (a condition in its chamber, the units placed), extra (more placed, with the reason), extra_approved
-- (QA's approval of an extra placement: the object of its signature, object_type 'stability_event', meaning
-- 'qc_approved'), pulled (a time point, the stability sample made; a late one with its reason and deviation), checked (a
-- second person's check of an entry typed by hand: payload.entry, 0 for the study), note.
create table stability_events (
  id bigint generated always as identity primary key,
  study_id bigint not null references stability_studies(id),
  kind text not null check (kind in ('placed', 'extra', 'extra_approved', 'pulled', 'checked', 'note')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create index stability_events_study on stability_events (study_id, id);
-- One placement per condition, one pull per time point, one check and one approval per entry.
create unique index stability_events_placed_once on stability_events (study_id, (payload->>'condition')) where kind = 'placed';
create unique index stability_events_pulled_once on stability_events (study_id, (payload->>'condition'), ((payload->>'month')::int)) where kind = 'pulled';
create unique index stability_events_checked_once on stability_events (study_id, ((payload->>'entry')::bigint)) where kind in ('checked', 'extra_approved');
create trigger stability_events_insert_only before update or delete or truncate on stability_events
  for each statement execute function refuse_change();

-- A stability sample names its study and time point (null for every other sample).
alter table samples add column stability jsonb;

-- Chamber excursions (plan 2b-2): entered by QC with the readings of the period, linked to a deviation; a second person
-- checks the entry; QC assesses its impact. The mean kinetic temperature and the studies affected are computed.
create table stability_excursions (
  id bigint generated always as identity primary key,
  chamber jsonb not null,
  from_at timestamptz not null,
  to_at timestamptz not null check (to_at > from_at),
  readings jsonb not null,
  deviation text not null check (length(trim(deviation)) between 1 and 60),
  deviation_source jsonb not null,
  recorded_by bigint not null references users(id),
  recorded_at timestamptz not null default now()
);
create trigger stability_excursions_insert_only before update or delete or truncate on stability_excursions
  for each statement execute function refuse_change();
create table stability_excursion_events (
  id bigint generated always as identity primary key,
  excursion_id bigint not null references stability_excursions(id),
  kind text not null check (kind in ('checked', 'assessed')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create unique index stability_excursion_events_once on stability_excursion_events (excursion_id, kind);
create trigger stability_excursion_events_insert_only before update or delete or truncate on stability_excursion_events
  for each statement execute function refuse_change();

-- LIMS-27: QA's answer to an on-going stability flag (a product and pack with no study started that year): why not.
create table stability_ongoing_answers (
  id bigint generated always as identity primary key,
  year integer not null,
  product_code text not null,
  pack text not null,
  text text not null check (length(trim(text)) between 1 and 1000),
  person_id bigint not null references users(id),
  at timestamptz not null default now(),
  unique (year, product_code, pack)
);
create trigger stability_ongoing_answers_insert_only before update or delete or truncate on stability_ongoing_answers
  for each statement execute function refuse_change();

revoke all on stability_counters, stability_studies, stability_events, stability_excursions, stability_excursion_events, stability_ongoing_answers from lims_app;
revoke all on sequence stability_studies_id_seq, stability_events_id_seq, stability_excursions_id_seq, stability_excursion_events_id_seq,
  stability_ongoing_answers_id_seq from lims_app;
grant select, insert, update (last_no) on stability_counters to lims_app;
grant select on stability_studies, stability_events, stability_excursions, stability_excursion_events, stability_ongoing_answers to lims_app;
grant insert (study_no, protocol_version_id, lot_no, item, source, cell, t0, created_by) on stability_studies to lims_app;
grant insert (study_id, kind, payload, person_id) on stability_events to lims_app;
grant insert (chamber, from_at, to_at, readings, deviation, deviation_source, recorded_by) on stability_excursions to lims_app;
grant insert (excursion_id, kind, payload, person_id) on stability_excursion_events to lims_app;
grant insert (year, product_code, pack, text, person_id) on stability_ongoing_answers to lims_app;
grant insert (stability) on samples to lims_app;
