-- Trends, KPIs, workload and APQR data (plan 2.10, 2.11; LIMS-25, LIMS-42), build step 8. Charts, KPIs and the APQR
-- summary are computed when read (shared/engine/trends.ts, template L18); only two small things are stored, both
-- insert-only: QC's turnaround target per sample purpose, and the assignment of a sample's method to an analyst.

-- Turnaround target (calendar days from receipt in QC to QC's decision) per sample purpose: the latest row of a purpose
-- applies; until QC sets one, the product default (shared/engine/trends.ts TAT_DEFAULT_DAYS).
create table tat_targets (
  id bigint generated always as identity primary key,
  purpose text not null check (purpose in ('release', 'retest', 'stability', 'investigation', 'monitoring')),
  days integer not null check (days between 1 and 365),
  set_by bigint not null references users(id),
  at timestamptz not null default now()
);
create trigger tat_targets_insert_only before update or delete or truncate on tat_targets
  for each statement execute function refuse_change();

-- The workload planner: who tests a sample's tests done by one method. The latest row of a sample and method applies
-- (assigned again: a new row). training: the analyst's training in the method's skills as Recruitment answered, or why
-- it was not checked.
create table lab_assignments (
  id bigint generated always as identity primary key,
  sample_id bigint not null references samples(id),
  method_master_id bigint not null,
  analyst_id bigint not null references users(id),
  training jsonb not null default '{}',
  assigned_by bigint not null references users(id),
  at timestamptz not null default now()
);
create index lab_assignments_sample on lab_assignments (sample_id, method_master_id, id);
create index lab_assignments_analyst on lab_assignments (analyst_id, id);
create trigger lab_assignments_insert_only before update or delete or truncate on lab_assignments
  for each statement execute function refuse_change();

-- LIMS-36 (EU Annex 1): QC's acknowledgement of an EM adverse trend (repeated alerts at a point, alerts across a room in
-- a week, a new organism; found by shared/engine/em-trends.ts, never stored): once per trend key, with the reason.
create table em_trend_answers (
  id bigint generated always as identity primary key,
  key text not null unique check (length(key) between 1 and 200),
  kind text not null check (kind in ('repeated alerts', 'alerts across a room', 'new organism')),
  what text not null check (length(trim(what)) between 1 and 1000),
  reason text not null check (length(trim(reason)) between 1 and 1000),
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create trigger em_trend_answers_insert_only before update or delete or truncate on em_trend_answers
  for each statement execute function refuse_change();

revoke all on tat_targets, lab_assignments, em_trend_answers from lims_app;   -- the platform's default grants (0000)
revoke all on sequence tat_targets_id_seq, lab_assignments_id_seq, em_trend_answers_id_seq from lims_app;
grant select on tat_targets, lab_assignments, em_trend_answers to lims_app;
grant insert (key, kind, what, reason, person_id) on em_trend_answers to lims_app;
grant insert (purpose, days, set_by) on tat_targets to lims_app;
grant insert (sample_id, method_master_id, analyst_id, training, assigned_by) on lab_assignments to lims_app;

-- Published view (platform PL-08), read-only in the schema `report` (tests: <schema>_report). Columns are only ever
-- added at the end.
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  execute format('create schema if not exists %I', rep);
  execute format('revoke all on schema %I from public', rep);
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- trend_v1 (LIMS-42, for QMS's annual product quality review): one row per decided result of a sample (any purpose), as
-- QC decided on it: the product or material (or the EM or water point), the lot or batch, the test, the value, the
-- limit as written (and its bounds as written, the shelf-life limit for a stability sample), PASS/FAIL, the OOS number
-- if the analysis opened one, and OOT with QC's answer if the result was flagged out of trend. QMS picks its period by
-- decided_at.
create view trend_v1 with (security_barrier) as
select md5('lims:trend:' || s.id || ':' || (r->>'key'))::uuid as trend_id, s.sample_no as sample_number, s.purpose,
  upper(s.item->>'of') as item_kind, s.item->>'itemId' as item_master_id, s.item->>'code' as item_code, s.item->>'name' as item_name,
  s.lot_no as lot_number, s.monitoring->>'pointCode' as point_code, s.stability->>'studyNo' as study_number,
  (s.stability->>'month')::int as time_point_months, s.stability->>'label' as condition,
  r->>'key' as test_key, r->>'name' as test_name, nullif(r->>'value', '')::numeric as value, r->>'unit' as unit, r->>'reported' as reported,
  r->>'limit' as limit_text, lim->>'low' as limit_low, lim->>'high' as limit_high,
  case when (r->>'pass')::boolean is true then 'PASS' when (r->>'pass')::boolean is false then 'FAIL' end as result_status,
  r->>'method' as method_code, r->>'analysisNo' as analysis_number,
  (select o.oos_no from oos o join analyses a on a.id = o.analysis_id where o.sample_id = s.id and o.test_key = r->>'key'
     and a.analysis_no = r->>'analysisNo' order by o.id limit 1) as oos_number,
  oot.payload is not null as out_of_trend, upper(oot.payload->>'answer') as oot_answer,
  v.doc->'header'->>'number' as spec_number, v.version_no as spec_version,
  upper(d.kind) as decision, d.at as decided_at, now() as read_at, d.at as data_as_of
from samples s
join master_versions v on v.id = s.spec_version_id
join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
cross join lateral jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) r
left join lateral (select case when s.purpose = 'stability' and t->>'limitType' = 'release and shelf life' then t->'shelfLifeLimit' else t->'limit' end
  from jsonb_array_elements(v.doc->'tests') t where t->>'key' = r->>'key' limit 1) l(lim) on true
left join lateral (select e.payload from sample_events e where e.sample_id = s.id and e.kind = 'oot_answered' and e.payload->>'test' = r->>'key'
  and e.payload->>'analysisNo' = r->>'analysisNo' order by e.id desc limit 1) oot on true;

revoke all on trend_v1 from public;

reset search_path;
