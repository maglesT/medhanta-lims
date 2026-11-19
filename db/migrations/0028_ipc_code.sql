-- In-process tests matched by code (TrueBatch round 45: lab_request_v1 tests[].code, unique within the product,
-- '<block id>.<field>'; a request without codes matches by its field name). result_v1.ipc_field is the TrueBatch field
-- name the result fills (the request test the code matched; CU: 'results' with 10 or 30 values); ipc_code, appended at
-- the end, is the code. Columns before it unchanged.
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
  coalesce(r->>'figure', 'result') as figure, coalesce(r->>'ipcName', r->>'ipcField') as ipc_field,
  r->>'ipcField' as ipc_code
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

revoke all on result_v1 from public;
