-- result_v1 gains, at its end, the result as reported (rounded half up to the decimals the limit is written with,
-- kept with the QC decision as payload.results[].reported); decisions made before this keep it null. The columns
-- before it are unchanged (a published view only ever grows at its end).
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
  now() as read_at, d.at as data_as_of, r->>'reported' as reported
from samples s
join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
cross join lateral jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) r;

revoke all on result_v1 from public;

reset search_path;
