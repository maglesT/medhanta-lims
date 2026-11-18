-- Specifications (LIMS-01) are versioned, checked and approved exactly as methods: the same table and review
-- workflow, told apart by their kind. A version keeps its kind for ever (the lock trigger keeps its identity).
alter table master_versions add column kind text not null default 'method' check (kind in ('method', 'spec'));
create index master_versions_kind on master_versions (kind, master_id);

create or replace function refuse_change_unless_draft() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'master version % cannot be removed', old.id using errcode = 'P0001';
  end if;
  if old.state <> 'draft' and new.doc is distinct from old.doc then
    raise exception 'master version % is % and cannot be changed', old.id, old.state using errcode = 'P0001';
  end if;
  if new.state <> old.state and (old.state, new.state) not in (('draft', 'in_review'), ('in_review', 'draft'),
      ('in_review', 'approved'), ('approved', 'effective'), ('effective', 'retired')) then
    raise exception 'master version % cannot go from % to %', old.id, old.state, new.state using errcode = 'P0001';
  end if;
  if new.master_id <> old.master_id or new.version_no <> old.version_no or new.created_by <> old.created_by
     or new.created_at <> old.created_at or new.kind <> old.kind then
    raise exception 'master version % keeps its identity', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;

grant insert (kind) on master_versions to lims_app;
