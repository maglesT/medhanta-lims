-- OOS and OOT (LIMS-23, LIMS-24, LIMS-25, LIMS-48), build step 4. FDA guidance "Investigating OOS test results"
-- (2022), the simple way: a row and insert-only entries; the status is computed (shared/engine/oos.ts), never stored.

-- OOS numbers come from one counter per plant year and are never reused (oos_no is unique): OOS260001.
create table oos_counters (
  year integer primary key,
  last_no integer not null check (last_no >= 1)
);

-- An OOS opens at once, in the transaction of the signature that gave the out-of-limit result: one per analysis and
-- spec test. result: the result as recorded ({ name, value, unit, shown, limit, step }); opened_by: who signed it.
create table oos (
  id bigint generated always as identity primary key,
  oos_no text not null unique,
  sample_id bigint not null references samples(id),
  analysis_id bigint not null references analyses(id),
  test_key text not null,
  result jsonb not null,
  opened_by bigint not null references users(id),
  opened_at timestamptz not null default now(),
  unique (analysis_id, test_key)
);
create index oos_sample on oos (sample_id);
create trigger oos_insert_only before update or delete or truncate on oos
  for each statement execute function refuse_change();

-- The investigation, entry by entry: phase Ia checklist, phase Ib plans and their re-measurements, the phase I
-- conclusion, its review (signed 'reviewed') or return, the phase II deviation number and its second-person check, QA's
-- conclusion (signed 'oos_approved'), and each retest started. A signed entry is the object of its signature
-- (object_type 'oos_event').
create table oos_events (
  id bigint generated always as identity primary key,
  oos_id bigint not null references oos(id),
  kind text not null check (kind in ('checklist', 'plan', 'remeasured', 'phase1_concluded', 'phase1_returned', 'phase1_reviewed',
    'phase2', 'phase2_checked', 'concluded', 'retest')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create index oos_events_oos on oos_events (oos_id, id);
-- Concluded once; each plan's re-measurement once; each analysis a retest of one OOS once.
create unique index oos_events_concluded_once on oos_events (oos_id) where kind = 'concluded';
create unique index oos_events_remeasured_once on oos_events (oos_id, (payload->>'plan')) where kind = 'remeasured';
create unique index oos_events_retest_once on oos_events ((payload->>'analysis')) where kind = 'retest';
create trigger oos_events_insert_only before update or delete or truncate on oos_events
  for each statement execute function refuse_change();

-- LIMS-24, LIMS-48: an analysis invalidated by an OOS keeps its record, marked (analysis event 'invalidated', once).
alter table analysis_events drop constraint analysis_events_kind_check;
alter table analysis_events add constraint analysis_events_kind_check check (kind in ('reviewed', 'stopped', 'deviation_closed', 'stage_closed', 'invalidated'));
create unique index analysis_events_invalidated_once on analysis_events (analysis_id) where kind = 'invalidated';

-- LIMS-25: QC's answer to an out-of-trend flag (no action, or investigation, with the reason).
alter table sample_events drop constraint sample_events_kind_check;
alter table sample_events add constraint sample_events_kind_check check (kind in ('checked', 'received', 'stored', 'handed_over', 'disposed', 'note',
  'approved', 'rejected', 'oot_answered'));

-- The signature meanings of server/signatures.ts, with 'oos_approved' (QA's conclusion of an OOS).
alter table signatures drop constraint signatures_meaning_check;
alter table signatures add constraint signatures_meaning_check check (meaning in ('prepared', 'checked', 'approved', 'issued',
  'performed', 'verified', 'reviewed', 'stopped', 'qc_approved', 'rejected', 'disposed', 'oos_approved'));

revoke all on oos_counters, oos, oos_events from lims_app;   -- the platform's default grants (0000)
revoke all on sequence oos_id_seq, oos_events_id_seq from lims_app;
grant select, insert, update (last_no) on oos_counters to lims_app;
grant select on oos, oos_events to lims_app;
grant insert (oos_no, sample_id, analysis_id, test_key, result, opened_by) on oos to lims_app;
grant insert (oos_id, kind, payload, person_id) on oos_events to lims_app;

-- Published view (platform PL-08, PL-13) for Deviations: phase II of an OOS is filed there from this row.
do $$
declare
  base text := current_schema();
  rep text := case when current_schema() = 'public' then 'report' else current_schema() || '_report' end;
begin
  perform set_config('search_path', format('%I, %I', rep, base), true);
end $$;

-- oos_v1: one row per OOS. status OPEN, CONFIRMED or INVALIDATED; phase_ii_needed: phase I found no laboratory error
-- (reviewed) and the OOS is not concluded; deviation_number: the phase II deviation (picked from Deviations, or typed
-- by hand while it was not reachable).
create view oos_v1 with (security_barrier) as
select md5('lims:oos:' || o.id)::uuid as oos_id, o.oos_no as oos_number, s.sample_no as sample_number, s.lot_no as lot_number,
  upper(s.item->>'of') as item_kind, s.item->>'itemId' as item_master_id, s.item->>'code' as item_code, s.item->>'name' as item_name,
  a.analysis_no as analysis_number, o.test_key, o.result->>'name' as test_name, nullif(o.result->>'value', '')::numeric as value,
  o.result->>'unit' as unit, o.result->>'shown' as shown, o.result->>'limit' as limit_text,
  coalesce(upper(c.payload->>'outcome'), 'OPEN') as status,
  (c.id is null and r.kind = 'phase1_reviewed' and (p.payload->>'labError')::boolean is false) as phase_ii_needed,
  d.payload->>'reference' as deviation_number, o.opened_at, c.at as closed_at,
  now() as read_at, greatest(o.opened_at, (select max(e.at) from oos_events e where e.oos_id = o.id)) as data_as_of
from oos o
join samples s on s.id = o.sample_id
join analyses a on a.id = o.analysis_id
left join oos_events c on c.oos_id = o.id and c.kind = 'concluded'
left join lateral (select e.kind from oos_events e where e.oos_id = o.id and e.kind in ('phase1_reviewed', 'phase1_returned') order by e.id desc limit 1) r on true
left join lateral (select e.payload from oos_events e where e.oos_id = o.id and e.kind = 'phase1_concluded' order by e.id desc limit 1) p on true
left join lateral (select e.payload from oos_events e where e.oos_id = o.id and e.kind = 'phase2' order by e.id desc limit 1) d on true;

revoke all on oos_v1 from public;

reset search_path;
