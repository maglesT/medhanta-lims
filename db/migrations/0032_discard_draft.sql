-- A draft that is not wanted (a mistake, a stale or duplicate copy) is discarded: kept as a record and retired with
-- its reason (master event 'retired', payload discarded), never removed. The trigger of 0006, with ('draft', 'retired').
create or replace function refuse_change_unless_draft() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'master version % cannot be removed', old.id using errcode = 'P0001';
  end if;
  if old.state <> 'draft' and new.doc is distinct from old.doc then
    raise exception 'master version % is % and cannot be changed', old.id, old.state using errcode = 'P0001';
  end if;
  if new.state <> old.state and (old.state, new.state) not in (('draft', 'in_review'), ('in_review', 'draft'),
      ('in_review', 'approved'), ('approved', 'effective'), ('effective', 'retired'), ('draft', 'retired')) then
    raise exception 'master version % cannot go from % to %', old.id, old.state, new.state using errcode = 'P0001';
  end if;
  if new.master_id <> old.master_id or new.version_no <> old.version_no or new.created_by <> old.created_by
     or new.created_at <> old.created_at or new.kind <> old.kind then
    raise exception 'master version % keeps its identity', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
