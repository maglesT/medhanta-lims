-- Instruments (LIMS-12), build step 4: the use of a lab instrument, published for the Logbook (its usage entries), in
-- the style of TrueBatch's equipment_use_v1 and with its column names, so the Logbook reads LIMS as it reads TrueBatch.
-- Read-only, in the schema `report` (tests: <schema>_report); the platform's set_link grants SELECT to a linked reader.
-- Columns are only ever added at the end.
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  execute format('create schema if not exists %I', rep);
  execute format('revoke all on schema %I from public', rep);
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- instrument_use_v1: one row per analysis and instrument (a machine field of a step: a value with an itemId and a
-- room, not a room itself nor a lab inventory item). batch_number is the analysis number. A use starts when the
-- instrument was first recorded on a step and ends when every step round that names it is signed done or not
-- applicable after its last recording (sent back or recorded again: open again), or when the analysis is stopped or
-- reviewed. A weighing instrument (a balance, by type) is shared by the analyses weighing on it: its use is the
-- weighing itself, ended when recorded (it is never held "in use" by an analysis). step / step_name: the step that
-- names it last ("stage/step" keys; "Stage › Step" as kept with the step's start). equipment_master_id: the
-- master-data id. use_id: md5 of the LIMS ids.
create view instrument_use_v1 with (security_barrier) as
with named as (
  select e.id, e.analysis_id, e.stage, e.sub, e.step, e.round, e.at, f.value
  from step_events e cross join lateral jsonb_each(e.payload->'values') f(key, value)
  where e.kind in ('value', 'corrected') and jsonb_typeof(f.value) = 'object' and f.value ? 'itemId' and f.value ? 'room'
    and (f.value->>'room') is distinct from (f.value->>'code')
), rounds as (
  select n.analysis_id, n.value->>'code' as code, n.stage, n.sub, n.step, n.round, min(n.at) as first_at, max(n.at) as last_at,
    (array_agg(n.value order by n.id desc))[1] as value,
    (select max(z.at) from step_events z where z.analysis_id = n.analysis_id and z.stage = n.stage and z.sub = n.sub and z.step = n.step
       and z.round = n.round and z.kind in ('done', 'not_applicable')) as done_at,
    (select max(z.at) from step_events z where z.analysis_id = n.analysis_id and z.stage = n.stage and z.sub = n.sub and z.step = n.step
       and z.round = n.round and z.kind in ('value', 'corrected', 'sent_back')) as busy_at,
    (select z.payload->>'where' from step_events z where z.analysis_id = n.analysis_id and z.stage = n.stage and z.sub = n.sub and z.step = n.step
       and z.round = n.round and z.kind = 'started' order by z.id limit 1) as place
  from named n
  group by n.analysis_id, n.value->>'code', n.stage, n.sub, n.step, n.round
), uses as (
  select r.analysis_id, r.code,
    (array_agg(r.value order by r.last_at desc, r.stage desc, r.sub desc, r.step desc, r.round desc))[1] as value,
    (array_agg(r.stage order by r.last_at desc, r.stage desc, r.sub desc, r.step desc, r.round desc))[1] as stage,
    (array_agg(r.step order by r.last_at desc, r.stage desc, r.sub desc, r.step desc, r.round desc))[1] as step,
    (array_agg(r.place order by r.last_at desc, r.stage desc, r.sub desc, r.step desc, r.round desc))[1] as place,
    min(r.first_at) as started_at, max(r.last_at) as last_at,
    bool_and(r.done_at is not null and r.done_at >= r.busy_at) as all_done, max(r.done_at) as done_at
  from rounds r
  group by r.analysis_id, r.code
)
select a.analysis_no as batch_number, u.code as equipment_code, u.value->>'type' as equipment_type,
  u.value->>'room' as room_code,
  (v.doc->'stages'->u.stage->>'key') || '/' || (v.doc->'stages'->u.stage->'steps'->u.step->>'key') as step,
  u.started_at,
  case when lower(coalesce(u.value->>'type', '')) like '%balance%' then u.last_at
    when u.all_done then u.done_at
    else x.at end as ended_at,
  now() as read_at,
  greatest(u.last_at, u.done_at, x.at) as data_as_of,
  coalesce(u.place, (v.doc->'stages'->u.stage->>'name') || ' › ' || (v.doc->'stages'->u.stage->'steps'->u.step->>'key')) as step_name,
  md5('lims:instrument_use:' || u.analysis_id || ':' || u.code)::uuid as use_id,
  u.value->>'itemId' as equipment_master_id
from uses u
join analyses a on a.id = u.analysis_id
join master_versions v on v.id = a.master_version_id
left join lateral (select min(z.at) as at from analysis_events z where z.analysis_id = u.analysis_id and z.kind in ('stopped', 'reviewed')) x on true;

revoke all on instrument_use_v1 from public;

reset search_path;
