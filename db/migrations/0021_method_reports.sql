-- Method validation, verification and transfer reports (plan 2.12; LIMS-02, LIMS-04), build step 8. The simple way: a
-- row and insert-only entries; the status is computed (shared/engine/method-validation.ts), never stored.

-- One report on one method version: kind validation (an in-house method, ICH Q2(R2)), verification (a pharmacopoeial
-- method) or transfer (a method transferred from another laboratory: sending_lab and receiving_lab). outside: a
-- validation done before LIMS, recorded with the paper report's number (reference) and no analyses; QA approves it as
-- a second person. Otherwise reference is the protocol's number, analysis_ids the reviewed analyses of validation
-- worksheets it covers, inputs their validation results as read, outputs the characteristics with their conclusion.
-- The person who prepares it signs it (object_type 'method_report', meaning 'prepared').
create table method_reports (
  id bigint generated always as identity primary key,
  report_no text not null unique check (report_no ~ '^MVR[0-9]{6}$'),
  kind text not null check (kind in ('validation', 'verification', 'transfer')),
  outside boolean not null default false,
  method_master_id bigint not null,
  method_version_id bigint not null references master_versions(id),
  method_version_no integer not null check (method_version_no >= 1),
  test_type text not null check (length(test_type) between 1 and 60),
  reference text not null check (length(trim(reference)) between 1 and 200),
  sending_lab text check (sending_lab is null or length(trim(sending_lab)) between 1 and 200),
  receiving_lab text check (receiving_lab is null or length(trim(receiving_lab)) between 1 and 200),
  analysis_ids bigint[] not null default '{}',
  inputs jsonb not null,
  outputs jsonb not null,
  conclusion text not null check (conclusion in ('met', 'not met')),
  remarks text not null default '' check (length(remarks) <= 2000),
  person_id bigint not null references users(id),
  at timestamptz not null default now(),
  check (kind <> 'transfer' or (sending_lab is not null and receiving_lab is not null)),
  check (outside or cardinality(analysis_ids) >= 1)
);
create index method_reports_master on method_reports (method_master_id, id);
create trigger method_reports_insert_only before update or delete or truncate on method_reports
  for each statement execute function refuse_change();

-- QC's review (signed 'reviewed') and QA's approval (signed 'approved'), each once; the signature's object_type is
-- 'method_report_event'.
create table method_report_events (
  id bigint generated always as identity primary key,
  report_id bigint not null references method_reports(id),
  kind text not null check (kind in ('reviewed', 'approved')),
  person_id bigint not null references users(id),
  at timestamptz not null default now(),
  unique (report_id, kind)
);
create trigger method_report_events_insert_only before update or delete or truncate on method_report_events
  for each statement execute function refuse_change();

revoke all on method_reports, method_report_events from lims_app;
revoke all on sequence method_reports_id_seq, method_report_events_id_seq from lims_app;
grant select on method_reports, method_report_events to lims_app;
grant insert (report_no, kind, outside, method_master_id, method_version_id, method_version_no, test_type, reference, sending_lab, receiving_lab,
  analysis_ids, inputs, outputs, conclusion, remarks, person_id) on method_reports to lims_app;
grant insert (report_id, kind, person_id) on method_report_events to lims_app;
