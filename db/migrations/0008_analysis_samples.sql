-- An analysis is made for a sample (build step 3, round 4): it carries the sample and the keys of the specification's
-- tests it covers (the tests of the sample's effective specification done by its method). An analysis without a sample
-- is trial or method work (LIMS-48: kept, never a result of a sample).
alter table analyses add column sample_id bigint references samples(id);
alter table analyses add column tests text[] not null default '{}';
create index analyses_sample on analyses (sample_id);
grant insert (sample_id, tests) on analyses to lims_app;
