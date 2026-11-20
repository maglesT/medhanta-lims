-- trend_v1.test_key is the same for a test across all samples of an item: '<spec number>:<spec test key>'. Before it
-- was the spec test's key alone ('test-2'), which is unique only inside one specification: an item with a release and an
-- in-process specification (FG-INJ-EXF25: Assay in one, Density in the other) mixed two tests under one key in a
-- trend (Operations CPV picks a QC test by item and test_key). A new version of a specification keeps its tests' keys,
-- so a test keeps its trend across versions. Column names and order unchanged.
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create or replace view trend_v1 with (security_barrier) as
select md5('lims:trend:' || s.id || ':' || (r->>'key'))::uuid as trend_id, s.sample_no as sample_number, s.purpose,
  upper(s.item->>'of') as item_kind, s.item->>'itemId' as item_master_id, s.item->>'code' as item_code, s.item->>'name' as item_name,
  s.lot_no as lot_number, s.monitoring->>'pointCode' as point_code, s.stability->>'studyNo' as study_number,
  (s.stability->>'month')::int as time_point_months, s.stability->>'label' as condition,
  (v.doc->'header'->>'number') || ':' || (r->>'key') as test_key, r->>'name' as test_name, nullif(r->>'value', '')::numeric as value, r->>'unit' as unit, r->>'reported' as reported,
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


reset search_path;
