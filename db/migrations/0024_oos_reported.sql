-- LIMS-15 on the OOS (found on the demo: OOS260001 published 0.8991008991… % where the analysis shows 0.9 %): oos_v1
-- publishes the result as reported, rounded half up to the decimals its limit is written with (the specification's
-- limit of the test; a stability sample's shelf-life limit), value and shown, the CoA's rule (server/coa.ts
-- reportedFigure). The full value stays in the OOS record and its worked line. Columns unchanged.
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create or replace view oos_v1 with (security_barrier) as
select md5('lims:oos:' || o.id)::uuid as oos_id, o.oos_no as oos_number, s.sample_no as sample_number, s.lot_no as lot_number,
  upper(s.item->>'of') as item_kind, s.item->>'itemId' as item_master_id, s.item->>'code' as item_code, s.item->>'name' as item_name,
  coalesce(a.analysis_no, x.report_no) as analysis_number, o.test_key, o.result->>'name' as test_name,
  coalesce(rv.v, nullif(o.result->>'value', '')::numeric) as value,
  o.result->>'unit' as unit,
  coalesce(rv.v::text || coalesce(' ' || nullif(o.result->>'unit', ''), ''), o.result->>'shown') as shown,
  o.result->>'limit' as limit_text,
  coalesce(upper(c.payload->>'outcome'), 'OPEN') as status,
  (c.id is null and r.kind = 'phase1_reviewed' and (p.payload->>'labError')::boolean is false) as phase_ii_needed,
  d.payload->>'reference' as deviation_number, o.opened_at, c.at as closed_at,
  now() as read_at, greatest(o.opened_at, (select max(e.at) from oos_events e where e.oos_id = o.id)) as data_as_of,
  x.lab as outside_lab
from oos o
join samples s on s.id = o.sample_id
join master_versions v on v.id = s.spec_version_id
left join analyses a on a.id = o.analysis_id
left join outside_results x on x.id = o.outside_result_id
left join oos_events c on c.oos_id = o.id and c.kind = 'concluded'
left join lateral (select e.kind from oos_events e where e.oos_id = o.id and e.kind in ('phase1_reviewed', 'phase1_returned') order by e.id desc limit 1) r on true
left join lateral (select e.payload from oos_events e where e.oos_id = o.id and e.kind = 'phase1_concluded' order by e.id desc limit 1) p on true
left join lateral (select e.payload from oos_events e where e.oos_id = o.id and e.kind = 'phase2' order by e.id desc limit 1) d on true
-- The limit of the test, and the value rounded to the decimals it is written with (the finer of its two bounds).
left join lateral (
  select coalesce(case when s.purpose = 'stability' then t->'shelfLifeLimit' end, t->'limit') as l
  from jsonb_array_elements(v.doc->'tests') t where t->>'key' = o.test_key limit 1) lim on true
left join lateral (
  select round(nullif(o.result->>'value', '')::numeric, greatest(
    coalesce(length(nullif(split_part(lim.l->>'low', '.', 2), '')), 0),
    coalesce(length(nullif(split_part(lim.l->>'high', '.', 2), '')), 0))) as v
  where lim.l is not null and (lim.l ? 'low' or lim.l ? 'high') and nullif(o.result->>'value', '') is not null) rv on true;

revoke all on oos_v1 from public;
