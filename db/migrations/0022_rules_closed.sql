-- Build step 8c: the register rules still open (docs/rules.md). Each record the Logbook way: a row and insert-only
-- entries, what it means computed in the app (shared/engine/outside.ts, shared/engine/forms.ts), never stored.

-- LIMS-08: an identity analysis of a starting material names the container it tested (1 to the sample's containers);
-- null for every other analysis. Each container of a starting material's release sample is identified.
alter table analyses add column container integer check (container >= 1);
grant insert (container) on analyses to lims_app;
-- LIMS-52: an analysis row is a record like its events: insert-only for everybody (the app role already had no update
-- or delete; the owner now cannot change it either).
create trigger analyses_insert_only before update or delete or truncate on analyses
  for each statement execute function refuse_change();

-- LIMS-22: a test done by an outside (contract) lab. The lab's report is not kept here: its file name, size and SHA-256
-- are (as a CDS file, LIMS-49); the result is typed from the report (value and unit, or whether it conforms) and checked
-- by a second person before it counts for QC's decision.
create table outside_results (
  id bigint generated always as identity primary key,
  sample_id bigint not null references samples(id),
  test_key text not null check (length(test_key) between 1 and 60),
  lab text not null check (length(trim(lab)) between 1 and 200),
  report_no text not null check (length(trim(report_no)) between 1 and 60),
  file_name text not null check (length(file_name) between 1 and 255),
  size integer not null check (size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  value text check (value ~ '^-?\d+(\.\d+)?$'),
  unit text not null default '' check (length(unit) <= 20),
  conforms boolean,
  entered_by bigint not null references users(id),
  entered_at timestamptz not null default now(),
  check ((value is null) <> (conforms is null))
);
create index outside_results_sample on outside_results (sample_id, id);
create trigger outside_results_insert_only before update or delete or truncate on outside_results
  for each statement execute function refuse_change();
-- The second person's check, once per result.
create table outside_result_checks (
  result_id bigint primary key references outside_results(id),
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create trigger outside_result_checks_insert_only before update or delete or truncate on outside_result_checks
  for each statement execute function refuse_change();

-- LIMS-54: blank worksheets issued for paper (a link or the system down): numbered LF + plant year + 5 digits, never
-- reused, for one sample and method version; each is returned (used: transcribed into an analysis of the sample;
-- unused) or voided with a reason, once. The forms not yet back are the reconciliation list.
create table issued_form_counters (
  year integer primary key,
  last_no integer not null check (last_no >= 1)
);
create table issued_forms (
  id bigint generated always as identity primary key,
  form_no text not null unique,
  sample_id bigint not null references samples(id),
  method_version_id bigint not null references master_versions(id),
  reason text not null check (length(trim(reason)) between 1 and 500),
  issued_by bigint not null references users(id),
  issued_at timestamptz not null default now()
);
create trigger issued_forms_insert_only before update or delete or truncate on issued_forms
  for each statement execute function refuse_change();
create table issued_form_events (
  id bigint generated always as identity primary key,
  form_id bigint not null unique references issued_forms(id),
  kind text not null check (kind in ('returned', 'voided')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create trigger issued_form_events_insert_only before update or delete or truncate on issued_form_events
  for each statement execute function refuse_change();

-- LIMS-39: lab animals (where a site uses them) are lab items of their own kind: identified, kept suitable (entries,
-- blocked when not), with their use history (entries).
alter table lab_items drop constraint lab_items_kind_check;
alter table lab_items add constraint lab_items_kind_check check (kind in ('reference', 'working', 'reagent', 'solution', 'vs', 'column', 'medium', 'culture', 'animal'));

revoke all on outside_results, outside_result_checks, issued_form_counters, issued_forms, issued_form_events from lims_app;   -- the platform's default grants (0000)
revoke all on sequence outside_results_id_seq, issued_forms_id_seq, issued_form_events_id_seq from lims_app;
grant select on outside_results, outside_result_checks, issued_forms, issued_form_events to lims_app;
grant insert (sample_id, test_key, lab, report_no, file_name, size, sha256, value, unit, conforms, entered_by) on outside_results to lims_app;
grant insert (result_id, person_id) on outside_result_checks to lims_app;
grant select, insert, update (last_no) on issued_form_counters to lims_app;
grant insert (form_no, sample_id, method_version_id, reason, issued_by) on issued_forms to lims_app;
grant insert (form_id, kind, payload, person_id) on issued_form_events to lims_app;

-- result_v1 gains, at its end, the outside lab that did the test (null when the lab's own analysis did it, LIMS-22).
-- The columns before it are unchanged (a published view only ever grows at its end).
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create or replace view result_v1 with (security_barrier) as
select md5('lims:result:' || s.id || ':' || (r->>'key'))::uuid as result_id, md5('lims:sample:' || s.id)::uuid as coa_id,
  d.payload->>'coaNo' as coa_number, s.sample_no as sample_number, s.lot_no as lot_number, s.item->>'itemId' as item_master_id,
  s.item->>'code' as item_code, r->>'key' as test_key, r->>'name' as test_name, nullif(r->>'value', '')::numeric as value,
  r->>'unit' as unit, r->>'shown' as shown, r->>'limit' as limit_text, (r->>'pass')::boolean as passed,
  r->>'method' as method_code, r->>'analysisNo' as analysis_number, upper(d.kind) as decision, d.at as decided_at,
  now() as read_at, d.at as data_as_of, r->>'reported' as reported, r->>'outsideLab' as outside_lab
from samples s
join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
cross join lateral jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) r;

revoke all on result_v1 from public;

reset search_path;
