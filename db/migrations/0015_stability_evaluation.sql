-- Stability evaluation (LIMS-29, plan 2.6 and 2b items 7, 8): the ICH Q1E evaluation QA signs is stored as it was
-- signed, insert-only (the results as read, the decision-tree answers, the outputs, the proposed shelf life or retest
-- period), so the shelf-life claim can be traced; QA's answer to a result to be reported; and the published view
-- stability_v1 (MMS reads the retest period of an API study in a later readers round).

-- One signed evaluation: a long-term condition of one protocol, over one study (scope 'study') or the product's
-- studies of that protocol (scope 'product'). The signature is a row of signatures (object_type 'stability_evaluation',
-- meaning 'qc_approved').
create table stability_evaluations (
  id bigint generated always as identity primary key,
  scope text not null check (scope in ('study', 'product')),
  item jsonb not null,
  protocol_master_id bigint not null,
  condition text not null check (length(trim(condition)) between 1 and 200),
  study_ids bigint[] not null check (cardinality(study_ids) >= 1),
  kind text not null check (kind in ('shelf life', 'retest period')),
  months integer not null check (months between 0 and 600),
  inputs jsonb not null,
  outputs jsonb not null,
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create index stability_evaluations_item on stability_evaluations ((item->>'itemId'), id);
create trigger stability_evaluations_insert_only before update or delete or truncate on stability_evaluations
  for each statement execute function refuse_change();

-- QA's answer to a stability result to be reported (a confirmed OOS, a negative trend on a marketed batch): whether a
-- regulator notice is needed, with its reference or why not. The app never sends a notice. key: 'oos:<number>' or
-- 'oot:<analysis>:<test>'.
create table stability_report_answers (
  id bigint generated always as identity primary key,
  key text not null unique check (length(key) between 1 and 200),
  item jsonb not null,
  study_id bigint not null references stability_studies(id),
  needed boolean not null,
  text text not null check (length(trim(text)) between 1 and 1000),
  person_id bigint not null references users(id),
  at timestamptz not null default now()
);
create trigger stability_report_answers_insert_only before update or delete or truncate on stability_report_answers
  for each statement execute function refuse_change();

revoke all on stability_evaluations, stability_report_answers from lims_app;
revoke all on sequence stability_evaluations_id_seq, stability_report_answers_id_seq from lims_app;
grant select on stability_evaluations, stability_report_answers to lims_app;
grant insert (scope, item, protocol_master_id, condition, study_ids, kind, months, inputs, outputs, person_id) on stability_evaluations to lims_app;
grant insert (key, item, study_id, needed, text, person_id) on stability_report_answers to lims_app;

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

-- stability_v1: one row per study. conditions: the protocol's conditions as "<code> <role>" ("30/75 long-term");
-- last_time_point_months: the latest time point pulled; status ON_STUDY or COMPLETE (every time point of its schedule
-- pulled); the latest signed evaluation that covers the study: shelf_life_months for a product, retest_period_months
-- for a material (an API: what MMS reads for its lots' retest dates), with its condition and signing time.
create view stability_v1 with (security_barrier) as
select md5('lims:stability:' || s.id)::uuid as study_id, s.study_no as study_number,
  upper(s.item->>'of') as item_kind, s.item->>'itemId' as item_master_id, s.item->>'code' as item_code, s.item->>'name' as item_name,
  s.lot_no as batch_number, v.doc->'header'->>'number' as protocol_number, v.version_no as protocol_version, v.doc->'header'->>'purpose' as purpose,
  v.doc->'header'->>'containerClosure' as container_closure,
  array(select (case when c->>'code' = 'other' then coalesce(c->>'other', 'other') else c->>'code' end) || ' ' || (c->>'role') from jsonb_array_elements(v.doc->'conditions') c) as conditions,
  s.t0 as placed_on, p.last_month as last_time_point_months,
  case when p.pulled >= coalesce(n.total, 0) then 'COMPLETE' else 'ON_STUDY' end as status,
  case when e.kind = 'shelf life' then e.months end as shelf_life_months,
  case when e.kind = 'retest period' then e.months end as retest_period_months,
  e.condition as evaluation_condition, g.signed_at as evaluation_signed_at,
  now() as read_at, greatest(s.created_at, p.last_at, g.signed_at) as data_as_of
from stability_studies s
join master_versions v on v.id = s.protocol_version_id
left join lateral (select count(*)::int as pulled, max((x.payload->>'month')::int) as last_month, max(x.at) as last_at
  from stability_events x where x.study_id = s.id and x.kind = 'pulled') p on true
left join lateral (select sum(coalesce(
    (select jsonb_array_length(m->'months') from jsonb_array_elements(v.doc->'design'->'matrix') m where m->>'cell' = s.cell and m->>'condition' = c->>'key' limit 1),
    jsonb_array_length(c->'months')))::int as total
  from jsonb_array_elements(v.doc->'conditions') c) n on true
left join lateral (select x.id, x.kind, x.months, x.condition from stability_evaluations x where s.id = any(x.study_ids) order by x.id desc limit 1) e on true
left join signatures g on g.object_type = 'stability_evaluation' and g.object_id = e.id;

revoke all on stability_v1 from public;

reset search_path;
