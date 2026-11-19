-- In-process samples (owner 19 Nov 2026): a TrueBatch step with in-process QC fields opens a lab request
-- (lab_request_v1); an analyst makes the in-process sample by picking it (nothing typed), purpose 'in_process'; the
-- usual analysis, review and QC approval follow, numbered as an in-process test report (IPR + plant year + 5 digits)
-- in place of a CoA. The request is kept with the sample as read (edition, request id, step, tests).
alter table samples drop constraint samples_purpose_check;
alter table samples add constraint samples_purpose_check check (purpose in ('release', 'retest', 'stability', 'investigation', 'monitoring', 'in_process'));
alter table samples add column request jsonb;
alter table samples add constraint samples_request check ((purpose = 'in_process') = (request is not null));
create unique index samples_one_per_request on samples ((request->>'edition'), (request->>'requestId')) where request is not null;
grant insert (request) on samples to lims_app;

create table ipr_counters (
  year integer primary key,
  last_no integer not null check (last_no >= 1)
);
revoke all on ipr_counters from lims_app;   -- the platform's default grants (0000)
grant select, insert, update (last_no) on ipr_counters to lims_app;

-- The turnaround target of in-process samples is hours, not days: a target is a number of days with up to 3 decimals
-- (0.125 = 3 hours).
alter table tat_targets drop constraint tat_targets_purpose_check;
alter table tat_targets add constraint tat_targets_purpose_check check (purpose in ('release', 'retest', 'stability', 'investigation', 'monitoring', 'in_process'));
alter table tat_targets alter column days type numeric(7, 3);
alter table tat_targets drop constraint tat_targets_days_check;
alter table tat_targets add constraint tat_targets_days_check check (days > 0 and days <= 365);

-- coa_v1 and result_v1 gain, at their end (result_v1 after 0025's reported_text), the in-process request (null for the other purposes); result_v1 also the
-- individual values (BU, CU, fill weights: as recorded, in order; null otherwise) and what the reported figure is
-- ('mean', 'AV' or 'result'). The columns before them are unchanged (a published view only ever grows at its end).
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create or replace view coa_v1 with (security_barrier) as
select md5('lims:sample:' || s.id)::uuid as coa_id, d.payload->>'coaNo' as coa_number, s.sample_no as sample_number,
  s.lot_no as lot_number, upper(s.item->>'of') as item_kind, s.item->>'itemId' as item_master_id, s.item->>'code' as item_code,
  s.item->>'name' as item_name, s.purpose, upper(d.kind) as decision, d.at as decided_at,
  (select g.printed_name from signatures g where g.object_type = 'sample_event' and g.object_id = d.id limit 1) as decided_by,
  v.doc->'header'->>'number' as spec_number, v.version_no as spec_version, d.payload->>'reason' as reason,
  now() as read_at, d.at as data_as_of, s.request->>'requestId' as request_id
from samples s
join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
join master_versions v on v.id = s.spec_version_id;

create or replace view result_v1 with (security_barrier) as
select md5('lims:result:' || s.id || ':' || (r->>'key'))::uuid as result_id, md5('lims:sample:' || s.id)::uuid as coa_id,
  d.payload->>'coaNo' as coa_number, s.sample_no as sample_number, s.lot_no as lot_number, s.item->>'itemId' as item_master_id,
  s.item->>'code' as item_code, r->>'key' as test_key, r->>'name' as test_name, nullif(r->>'value', '')::numeric as value,
  r->>'unit' as unit, r->>'shown' as shown, r->>'limit' as limit_text, (r->>'pass')::boolean as passed,
  r->>'method' as method_code, r->>'analysisNo' as analysis_number, upper(d.kind) as decision, d.at as decided_at,
  now() as read_at, d.at as data_as_of,
  case
    -- No number (a conforms test): its text as decided.
    when nullif(r->>'value', '') is null then coalesce(nullif(r->>'reported', ''), r->>'shown')
    -- Kept with the decision ('1.25 g/mL'): its number only.
    when r->>'reported' ~ '^\s*-?\d' then substring(r->>'reported' from '^\s*(-?\d+(?:\.\d+)?)')
    -- Decided before it was kept: rounded now as the limit is written (the same rule, server/coa.ts reportedFigure).
    when rv.v is not null then rv.v::text
    else r->>'value'
  end as reported,
  r->>'outsideLab' as outside_lab,
  case
    when nullif(r->>'value', '') is null then coalesce(nullif(r->>'reported', ''), r->>'shown')
    when nullif(r->>'reported', '') is not null then r->>'reported'
    else coalesce(rv.v::text, r->>'value') || coalesce(' ' || nullif(r->>'unit', ''), '')
  end as reported_text,
  s.request->>'requestId' as request_id, s.purpose,
  case when jsonb_typeof(r->'individual') = 'array' then array(select x::numeric from jsonb_array_elements_text(r->'individual') x) end as individual_values,
  coalesce(r->>'figure', 'result') as figure, r->>'ipcField' as ipc_field
from samples s
join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
join master_versions v on v.id = s.spec_version_id
cross join lateral jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) r
left join lateral (
  select coalesce(case when s.purpose = 'stability' then t->'shelfLifeLimit' end, t->'limit') as l
  from jsonb_array_elements(v.doc->'tests') t where t->>'key' = r->>'key' limit 1) lim on true
left join lateral (
  select round(nullif(r->>'value', '')::numeric, greatest(
    coalesce(length(nullif(split_part(lim.l->>'low', '.', 2), '')), 0),
    coalesce(length(nullif(split_part(lim.l->>'high', '.', 2), '')), 0))) as v
  where lim.l is not null and (lim.l ? 'low' or lim.l ? 'high') and nullif(r->>'value', '') ~ '^-?\d+(\.\d+)?$') rv on true;

revoke all on coa_v1, result_v1 from public;

-- sample_v1 (MMS D-77, owner's no-duplicates rule: while LIMS is linked, sampling of a received lot is LIMS's and MMS
-- shows it and takes the quantity off stock once): one row per sample of a material or product. quantity and unit
-- split from the quantity as registered ("120 g": always a number, then its unit); containers the number sampled, the
-- container numbers (LIMS-05) appended; sampled_by and sampled_at the registration (the sampler records the sampling);
-- status registered / received / decided / disposed (a sample is never cancelled: it is disposed of, with its reason).
create view sample_v1 with (security_barrier) as
select md5('lims:sample:' || s.id)::uuid as sample_id, s.sample_no as sample_number, s.lot_no as lot_number, upper(s.item->>'of') as item_kind,
  case when s.item->>'itemId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (s.item->>'itemId')::uuid end as item_master_id,
  s.purpose, substring(s.quantity from '^\s*(\d+(?:\.\d+)?)')::numeric as quantity, nullif(trim(substring(s.quantity from '^\s*\d+(?:\.\d+)?\s*(.*)$')), '') as unit,
  s.containers, u.full_name as sampled_by, s.registered_at as sampled_at,
  case when exists (select 1 from sample_events e where e.sample_id = s.id and e.kind = 'disposed') then 'disposed'
    when exists (select 1 from sample_events e where e.sample_id = s.id and e.kind in ('approved', 'rejected')) then 'decided'
    when exists (select 1 from sample_events e where e.sample_id = s.id and e.kind = 'received') then 'received'
    else 'registered' end as status,
  now() as read_at, greatest(s.registered_at, (select max(e.at) from sample_events e where e.sample_id = s.id)) as data_as_of,
  array(select jsonb_array_elements_text(s.sampling->'numbers')::int) as container_numbers, s.request->>'requestId' as request_id
from samples s join users u on u.id = s.registered_by
where s.item->>'of' in ('material', 'product');

revoke all on sample_v1 from public;
