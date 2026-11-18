-- Environmental monitoring and water (LIMS-36, LIMS-37; plan 2.9), the Logbook way: the monitoring plan is a fourth
-- kind of master version (reviewed and approved as methods, specifications and protocols); a sampling taken from the
-- plan is an ordinary sample (purpose 'monitoring') naming its point; an excursion is a row and insert-only entries;
-- the daily summary report of a continuous monitoring system is kept as read with its SHA-256. What is due, the
-- excursion levels and statuses are computed (shared/engine/monitoring.ts), never stored.

alter table master_versions drop constraint master_versions_kind_check;
alter table master_versions add constraint master_versions_kind_check check (kind in ('method', 'spec', 'protocol', 'monitoring'));

alter table samples drop constraint samples_purpose_check;
alter table samples add constraint samples_purpose_check check (purpose in ('release', 'retest', 'stability', 'investigation', 'monitoring'));
-- A monitoring sample names its plan version, point, sampling, state and when it was taken (null for every other sample).
alter table samples add column monitoring jsonb;
create index samples_monitoring on samples ((monitoring->>'planMasterId'), (monitoring->>'point'), (monitoring->>'sampling')) where monitoring is not null;

-- The daily summary report of a particle counter or an online water monitor (owner, 18 Nov 2026): the file's name,
-- size and SHA-256 (the monitoring system keeps the file), the plant date it reports, and its rows as read.
create table em_imports (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('particle', 'water')),
  file_name text not null check (length(trim(file_name)) between 1 and 200),
  size integer not null check (size > 0),
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  report_date date not null,
  rows jsonb not null,
  imported_by bigint not null references users(id),
  imported_at timestamptz not null default now()
);
create trigger em_imports_insert_only before update or delete or truncate on em_imports
  for each statement execute function refuse_change();

-- An excursion: a reviewed result of a monitoring sample over its alert or action limit (origin 'result', recorded when
-- its investigation is opened), or an alarm in an imported report (origin 'import', confirmed by a second person).
-- point: the plan's point as taken ({ code, name, of, room, system }); result: the value, its unit, the limit as shown.
create table em_excursions (
  id bigint generated always as identity primary key,
  origin text not null check (origin in ('result', 'import')),
  sample_id bigint references samples(id),
  test_key text,
  import_id bigint references em_imports(id),
  row_no integer,
  level text not null check (level in ('alert', 'action')),
  point jsonb not null,
  result jsonb not null,
  recorded_by bigint not null references users(id),
  recorded_at timestamptz not null default now(),
  check ((origin = 'result' and sample_id is not null and test_key is not null and import_id is null)
      or (origin = 'import' and import_id is not null and row_no is not null and sample_id is null))
);
create unique index em_excursions_result_once on em_excursions (sample_id, test_key) where origin = 'result';
create unique index em_excursions_import_once on em_excursions (import_id, row_no) where origin = 'import';
create trigger em_excursions_insert_only before update or delete or truncate on em_excursions
  for each statement execute function refuse_change();

-- Its entries: confirmed (a second person, an imported alarm), deviation (the investigation's number, picked from
-- Deviations or typed by hand), checked (a second person checks a number typed by hand), isolate (genus and species
-- from the identification method's report), closed (QA's conclusion), note.
create table em_excursion_events (
  id bigint generated always as identity primary key,
  excursion_id bigint not null references em_excursions(id),
  kind text not null check (kind in ('confirmed', 'deviation', 'checked', 'isolate', 'closed', 'note')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create index em_excursion_events_excursion on em_excursion_events (excursion_id, id);
create unique index em_excursion_events_once on em_excursion_events (excursion_id, kind) where kind in ('confirmed', 'deviation', 'checked', 'closed');
create trigger em_excursion_events_insert_only before update or delete or truncate on em_excursion_events
  for each statement execute function refuse_change();

revoke all on em_imports, em_excursions, em_excursion_events from lims_app;   -- the platform's default grants (0000)
revoke all on sequence em_imports_id_seq, em_excursions_id_seq, em_excursion_events_id_seq from lims_app;
grant select on em_imports, em_excursions, em_excursion_events to lims_app;
grant insert (kind, file_name, size, sha256, report_date, rows, imported_by) on em_imports to lims_app;
grant insert (origin, sample_id, test_key, import_id, row_no, level, point, result, recorded_by) on em_excursions to lims_app;
grant insert (excursion_id, kind, payload, person_id) on em_excursion_events to lims_app;
grant insert (monitoring) on samples to lims_app;

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

-- em_v1: one row per monitoring sample (a sampling of a point). point_kind ROOM or WATER; room code and grade, or the
-- water system; the sampling's kind, state and frequency; the plant date it was taken; the result as QC decided on it
-- (null until decided; LIMS-21: reviewed results only) with its limit and the alert and action limits; level NONE,
-- ALERT or ACTION (a colony in grade A is ACTION); the excursion's status (NONE, OPEN, CLOSED) and deviation number.
create view em_v1 with (security_barrier) as
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
  upper(d.kind) as decision, now() as read_at, greatest(s.registered_at, d.at, x.at) as data_as_of
from samples s
left join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
left join lateral (select j from jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) j where j->>'key' = s.monitoring->>'testKey' limit 1) rr(r) on true
left join lateral (select e.id, exists (select 1 from em_excursion_events c where c.excursion_id = e.id and c.kind = 'closed') as closed,
    (select c.payload->>'number' from em_excursion_events c where c.excursion_id = e.id and c.kind = 'deviation' limit 1) as deviation,
    (select max(c.at) from em_excursion_events c where c.excursion_id = e.id) as at
  from em_excursions e where e.origin = 'result' and e.sample_id = s.id order by e.id desc limit 1) x on true
where s.purpose = 'monitoring';

revoke all on em_v1 from public;

reset search_path;
