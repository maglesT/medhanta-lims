-- LIMS-09: a lot tested on its supplier's certificate (shared/engine/reduced.ts). QC records it on the release sample
-- (one entry, with the supplier approval and the full-test check as pulled); the tests other than identity are then
-- outside results marked `certificate`, the manufacturer named as the lab, checked by a second person against the scan.
alter table sample_events drop constraint sample_events_kind_check;
alter table sample_events add constraint sample_events_kind_check check (kind in ('checked', 'received', 'stored', 'handed_over', 'disposed', 'note',
  'approved', 'rejected', 'oot_answered', 'reduced_testing'));
create unique index sample_events_reduced_once on sample_events (sample_id) where kind = 'reduced_testing';

alter table outside_results add column certificate boolean not null default false;
grant insert (certificate) on outside_results to lims_app;
-- The second person confirms the certificate holds the required fields (IN Schedule M 19.7.4).
alter table outside_result_checks add column certificate_fields boolean not null default false;
grant insert (certificate_fields) on outside_result_checks to lims_app;
