-- Analysis-level events: the second person's review, a stop with its reason, a deviation note closed by hand, and a
-- stage closed (recorded once, for the instrument use other products read). The analysis status is computed from them
-- and the step events (shared/engine/release.ts). Insert-only, like step_events; each signed event is the object of its
-- signature (object_type 'analysis_event').
create table analysis_events (
  id bigint generated always as identity primary key,
  analysis_id bigint not null references analyses(id),
  kind text not null check (kind in ('reviewed', 'stopped', 'deviation_closed', 'stage_closed')),
  payload jsonb not null default '{}',
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create index analysis_events_analysis on analysis_events (analysis_id, id);
-- An analysis is reviewed or stopped, once and never both; each deviation note closed once; each stage closed once.
create unique index analysis_events_once on analysis_events (analysis_id) where kind in ('reviewed', 'stopped');
create unique index analysis_events_closed_once on analysis_events (analysis_id, (payload->>'note')) where kind = 'deviation_closed';
create unique index analysis_events_stage_once on analysis_events (analysis_id, (payload->>'stage')) where kind = 'stage_closed';
create trigger analysis_events_insert_only before update or delete or truncate on analysis_events
  for each statement execute function refuse_change();

revoke all on analysis_events from lims_app;   -- the platform's default grants (0000)
revoke all on sequence analysis_events_id_seq from lims_app;
grant select on analysis_events to lims_app;
grant insert (analysis_id, kind, payload, person_id) on analysis_events to lims_app;
