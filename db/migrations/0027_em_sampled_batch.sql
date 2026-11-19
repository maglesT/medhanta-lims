-- em_v1 gains at its end (owner's ownership rule: LIMS owns EM; Injectables pulls it into a batch's QC approval):
-- sampled_at, the time the sample was taken (taken_on is the plant day only; two batches filled in one room on one day
-- are told apart by it), and batch_number, the TrueBatch batch it was taken during (picked from TrueBatch; null when
-- none). Columns before them unchanged.
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

create or replace view em_v1 with (security_barrier) as
select md5('lims:em:' || s.id)::uuid as em_id, s.sample_no as sample_number,
  s.monitoring->>'planNumber' as plan_number, (s.monitoring->>'planVersionNo')::int as plan_version,
  s.monitoring->>'pointCode' as point_code, s.monitoring->>'pointName' as point_name, upper(s.item->>'of') as point_kind,
  case when s.item->>'of' = 'room' then s.item->>'code' end as room_code, s.monitoring->>'grade' as room_grade,
  case when s.item->>'of' = 'water' then s.item->>'code' end as water_system,
  s.monitoring->>'kind' as sampling_kind, s.monitoring->>'state' as state, s.monitoring->>'frequency' as frequency,
  (s.monitoring->>'takenOn')::date as taken_on,
  s.monitoring->>'testKey' as test_key, nullif(r->>'value', '')::numeric as value, r->>'unit' as unit, r->>'shown' as shown,
  r->>'limit' as limit_text, s.monitoring->'limit'->>'alertHigh' as alert_limit, s.monitoring->'limit'->>'high' as action_limit,
  case when r is null then null
    when s.monitoring->>'grade' = 'A' and s.monitoring->>'kind' in ('settle plate', 'contact plate', 'active air', 'glove print', 'personnel', 'micro')
      and nullif(r->>'value', '')::numeric > 0 then 'ACTION'
    when (r->>'pass')::boolean is false then 'ACTION'
    when s.monitoring->'limit'->>'alertHigh' ~ '^\d+(\.\d+)?$' and nullif(r->>'value', '')::numeric > (s.monitoring->'limit'->>'alertHigh')::numeric then 'ALERT'
    else 'NONE' end as level,
  case when x.id is null then 'NONE' when x.closed then 'CLOSED' else 'OPEN' end as excursion_status, x.deviation as deviation_number,
  upper(d.kind) as decision, now() as read_at, greatest(s.registered_at, d.at, x.at) as data_as_of,
  s.registered_at as sampled_at, nullif(s.monitoring->>'batch', '') as batch_number
from samples s
left join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
left join lateral (select j from jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) j where j->>'key' = s.monitoring->>'testKey' limit 1) rr(r) on true
left join lateral (select e.id, exists (select 1 from em_excursion_events c where c.excursion_id = e.id and c.kind = 'closed') as closed,
    (select c.payload->>'number' from em_excursion_events c where c.excursion_id = e.id and c.kind = 'deviation' limit 1) as deviation,
    (select max(c.at) from em_excursion_events c where c.excursion_id = e.id) as at
  from em_excursions e where e.origin = 'result' and e.sample_id = s.id order by e.id desc limit 1) x on true
where s.purpose = 'monitoring';

revoke all on em_v1 from public;
