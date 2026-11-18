-- QC's decision on a sample and its certificate of analysis (LIMS-20, LIMS-21), build step 3, round 5.
-- The decision is a sample entry 'approved' or 'rejected', the object of its e-signature (meaning qc_approved or
-- rejected). Its payload keeps the results decided on, as reviewed (payload.results), and an approval's CoA number
-- (payload.coaNo, COA + plant year + 5 digits, never reused). One decision per sample.
alter table sample_events drop constraint sample_events_kind_check;
alter table sample_events add constraint sample_events_kind_check check (kind in ('checked', 'received', 'stored', 'handed_over', 'disposed', 'note',
  'approved', 'rejected'));
create unique index sample_events_decided_once on sample_events (sample_id) where kind in ('approved', 'rejected');

create table coa_counters (
  year integer primary key,
  last_no integer not null check (last_no >= 1)
);
revoke all on coa_counters from lims_app;   -- the platform's default grants (0000)
grant select, insert, update (last_no) on coa_counters to lims_app;

-- Published views (platform PL-08, PL-13), read by MMS and TrueBatch through platform links, read-only, in the schema
-- `report` (tests: <schema>_report). The platform's set_link grants SELECT to a linked reader; nobody else gets
-- anything. Columns are only ever added at the end. Ids are made from LIMS ids with the product's own prefix.
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  execute format('create schema if not exists %I', rep);
  execute format('revoke all on schema %I from public', rep);
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- coa_v1: one row per decided sample. decision APPROVED (with its CoA number) or REJECTED; item_kind MATERIAL or
-- PRODUCT; lot_number is the lot (MMS) or batch (TrueBatch) number as the sample names it.
create view coa_v1 with (security_barrier) as
select md5('lims:sample:' || s.id)::uuid as coa_id, d.payload->>'coaNo' as coa_number, s.sample_no as sample_number,
  s.lot_no as lot_number, upper(s.item->>'of') as item_kind, s.item->>'itemId' as item_master_id, s.item->>'code' as item_code,
  s.item->>'name' as item_name, s.purpose, upper(d.kind) as decision, d.at as decided_at,
  (select g.printed_name from signatures g where g.object_type = 'sample_event' and g.object_id = d.id limit 1) as decided_by,
  v.doc->'header'->>'number' as spec_number, v.version_no as spec_version, d.payload->>'reason' as reason,
  now() as read_at, d.at as data_as_of
from samples s
join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
join master_versions v on v.id = s.spec_version_id;

-- result_v1: one row per test result of a decided sample, as decided on (reviewed results only, LIMS-21). value and
-- unit as worked out (full precision), shown as the analysis shows it; passed is the check against the test's limit
-- (null when the test has no limit).
create view result_v1 with (security_barrier) as
select md5('lims:result:' || s.id || ':' || (r->>'key'))::uuid as result_id, md5('lims:sample:' || s.id)::uuid as coa_id,
  d.payload->>'coaNo' as coa_number, s.sample_no as sample_number, s.lot_no as lot_number, s.item->>'itemId' as item_master_id,
  s.item->>'code' as item_code, r->>'key' as test_key, r->>'name' as test_name, nullif(r->>'value', '')::numeric as value,
  r->>'unit' as unit, r->>'shown' as shown, r->>'limit' as limit_text, (r->>'pass')::boolean as passed,
  r->>'method' as method_code, r->>'analysisNo' as analysis_number, upper(d.kind) as decision, d.at as decided_at,
  now() as read_at, d.at as data_as_of
from samples s
join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
cross join lateral jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) r;

revoke all on coa_v1, result_v1 from public;

reset search_path;
