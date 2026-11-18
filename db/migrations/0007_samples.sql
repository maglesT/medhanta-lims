-- Samples (LIMS-05, LIMS-07), the Logbook way: a row and insert-only entries; the status is computed from the entries
-- (shared/engine/sample.ts), never stored.

-- Sample numbers come from one counter per plant year and are never reused (sample_no is unique): LS2600001.
create table sample_counters (
  year integer primary key,
  last_no integer not null check (last_no >= 1)
);

-- A sample of one lot (MMS) or batch (TrueBatch), tested against the specification version that was effective when it
-- was registered (LIMS-01). item: what it is ({ of, itemId, code, name } as read from master data); source: where the
-- lot or batch was read (pulled, with what was shown) or { from: 'hand', link, state } while the link was absent or down.
create table samples (
  id bigint generated always as identity primary key,
  sample_no text not null unique,
  spec_version_id bigint not null references master_versions(id),
  purpose text not null default 'release' check (purpose in ('release', 'retest', 'stability', 'investigation')),
  lot_no text not null check (length(trim(lot_no)) between 1 and 60),
  item jsonb not null,
  source jsonb not null,
  quantity text not null check (length(trim(quantity)) between 1 and 60),
  containers integer check (containers >= 1),
  registered_by bigint not null references users(id),
  registered_at timestamptz not null default now()
);
create index samples_lot on samples (lot_no);
create trigger samples_insert_only before update or delete or truncate on samples
  for each statement execute function refuse_change();

-- The chain of custody (LIMS-07): each entry with its person and the server's time. A disposal is the object of its
-- signature (object_type 'sample_event', meaning 'disposed').
create table sample_events (
  id bigint generated always as identity primary key,
  sample_id bigint not null references samples(id),
  kind text not null check (kind in ('checked', 'received', 'stored', 'handed_over', 'disposed', 'note')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create index sample_events_sample on sample_events (sample_id, id);
create trigger sample_events_insert_only before update or delete or truncate on sample_events
  for each statement execute function refuse_change();

-- The signature meanings of server/signatures.ts, with 'disposed' (a sample's disposal).
alter table signatures drop constraint signatures_meaning_check;
alter table signatures add constraint signatures_meaning_check check (meaning in ('prepared', 'checked', 'approved', 'issued',
  'performed', 'verified', 'reviewed', 'stopped', 'qc_approved', 'rejected', 'disposed'));

revoke all on sample_counters, samples, sample_events from lims_app;   -- the platform's default grants (0000)
revoke all on sequence samples_id_seq, sample_events_id_seq from lims_app;
grant select, insert, update (last_no) on sample_counters to lims_app;
grant select on samples, sample_events to lims_app;
grant insert (sample_no, spec_version_id, purpose, lot_no, item, source, quantity, containers, registered_by) on samples to lims_app;
grant insert (sample_id, kind, payload, person_id) on sample_events to lims_app;
