import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { stepLabel } from '../../shared/engine/analysis.js';
import type { MasterDoc } from '../../shared/master/schema.js';
import {
  BASES, CHECK_ACTIONS, ITEM_ACTIONS, ITEM_ACTION_NAMES, ITEM_KINDS, ITEM_PREFIX, itemRefusal, itemStatus, labItemId, registerProblems, waitingCheck,
  type Item, type ItemAction, type ItemEvent, type ItemFacts, type ItemKind, type ItemPayload, type ItemStatus, type Parent,
} from '../../shared/engine/items.js';

// The lab inventory (LIMS-12, LIMS-13, LIMS-14, LIMS-34, LIMS-35), the Logbook way: an item is registered when it is
// received or prepared, and insert-only entries follow (opened, standardised, qualified, growth promotion, a second
// person's check, retest, blocked, unblocked, disposed, note). Whether it may be used now, and why not, is computed
// (shared/engine/items.ts) and the worksheet's item field offers only usable items (server/pull.ts pullLabItem).

// Plant time zone: the item number's year and the dates compared are the plant's.
const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';
export const plantToday = (now: Date) => now.toLocaleDateString('en-CA', { timeZone: PLANT_TZ });

export interface ItemRow { id: number; itemNo: string; kind: ItemKind; name: string; facts: ItemFacts; parentIds: number[]; registeredBy: number; registeredByName: string; registeredAt: Date; day: string }
export type ItemEventRow = ItemEvent & { personName: string; at: Date };
export interface LoadedItem { row: ItemRow; events: ItemEventRow[]; status: ItemStatus }

class ItemError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}

const asItem = (r: ItemRow): Item => ({ kind: r.kind, facts: r.facts, registeredBy: r.registeredBy, day: r.day });

/** Items (all, or these ids) with their entries and their status today. */
export async function loadItems(q: Sql | Tx, today: string, ids?: number[], kinds?: readonly ItemKind[]): Promise<LoadedItem[]> {
  const rows = await q<ItemRow[]>`
    select i.id::int, i.item_no as "itemNo", i.kind, i.name, i.facts, i.parent_ids::int[] as "parentIds", i.registered_by::int as "registeredBy",
      u.full_name as "registeredByName", i.registered_at as "registeredAt", (i.registered_at at time zone ${PLANT_TZ})::date::text as day
    from lab_items i join users u on u.id = i.registered_by
    where (${ids ?? null}::bigint[] is null or i.id = any(${ids ?? null}::bigint[]))
      and (${kinds ? [...kinds] : null}::text[] is null or i.kind = any(${kinds ? [...kinds] : null}::text[]))
    order by i.id desc limit 2000`;
  if (!rows.length) return [];
  const events = await q<(ItemEventRow & { itemId: number })[]>`
    select e.id::int, e.item_id::int as "itemId", e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at,
      (e.at at time zone ${PLANT_TZ})::date::text as day
    from lab_item_events e join users u on u.id = e.person_id where e.item_id = any(${rows.map((r) => r.id)}) order by e.id`;
  return rows.map((row) => {
    const mine = events.filter((e) => e.itemId === row.id).map(({ itemId: _, ...e }) => e);
    return { row, events: mine, status: itemStatus(asItem(row), mine, today) };
  });
}
export async function loadItem(q: Sql | Tx, id: number, today: string): Promise<LoadedItem | null> {
  return (await loadItems(q, today, [id]))[0] ?? null;
}
const parentOf = (l: LoadedItem): Parent => ({ kind: l.row.kind, itemNo: l.row.itemNo, name: l.row.name, status: l.status });

/**
 * LIMS-14 look-back: every analysis step that recorded this item (its value "lab:<id>"), oldest first, with the
 * analysis, its sample and who recorded it; a column's runs are counted from it (LIMS-12).
 */
export async function itemUses(q: Sql | Tx, id: number) {
  const rows = await q<{ analysisId: number; analysisNo: string; sampleNo: string | null; stage: number; sub: number; step: number; round: number; at: Date; personName: string | null; doc: MasterDoc }[]>`
    select distinct on (e.analysis_id, e.stage, e.sub, e.step, e.round) e.analysis_id::int as "analysisId", a.analysis_no as "analysisNo", s.sample_no as "sampleNo",
      e.stage, e.sub, e.step, e.round, e.at, u.full_name as "personName", v.doc
    from step_events e join analyses a on a.id = e.analysis_id join master_versions v on v.id = a.master_version_id
      left join samples s on s.id = a.sample_id left join users u on u.id = e.person_id
    where e.kind in ('value', 'corrected')
      and exists (select 1 from jsonb_each(e.payload->'values') f where jsonb_typeof(f.value) = 'object' and f.value->>'itemId' = ${labItemId(id)})
    order by e.analysis_id, e.stage, e.sub, e.step, e.round, e.id`;
  return rows.map(({ doc, ...r }) => ({ ...r, method: doc.header.code, where: stepLabel(doc, r) })).sort((a, b) => a.at.getTime() - b.at.getTime());
}

const text = (max = 200) => z.string().trim().min(1).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'give a date, e.g. 2027-03-31');
const factsBody = z.object({
  name: text(200), storage: text().optional(), source: text(100).optional(), lot: text(60).optional(), supplier: text(100).optional(),
  potency: z.string().trim().max(12).optional(), basis: z.enum(BASES).optional(), expiry: date.optional(), retestOn: date.optional(),
  useDays: z.number().int().optional(), procedure: text().optional(), molarity: z.string().trim().max(20).optional(), serial: text(60).optional(),
  columnType: text().optional(), sterilisation: text().optional(), organism: text(100).optional(), strain: text(60).optional(), tag: text(60).optional(),
}).strict();
const registerBody = z.object({ kind: z.enum(ITEM_KINDS), facts: factsBody, parentIds: z.array(z.number().int().positive()).max(20).default([]) }).strict();
const ACTION_BODIES: Record<ItemAction, z.ZodTypeAny> = {
  open: z.object({}),
  standardise: z.object({ factor: z.string().trim().max(12), nextDue: z.string().max(10), against: text().optional() }),
  qualify: z.object({ potency: z.string().trim().max(12), basis: z.enum(BASES), nextDue: z.string().max(10) }),
  'growth-promotion': z.object({ passed: z.boolean(), organisms: text(500) }),
  check: z.object({ of: z.number().int().positive().optional() }),
  retest: z.object({ retestOn: z.string().max(10) }),
  block: z.object({ reason: text(500) }),
  unblock: z.object({ reason: text(500) }),
  dispose: z.object({ reason: text(500) }),
  note: z.object({ text: text(1000) }),
};

export function inventoryRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.analysis.perform', 'lims.analysis.review', 'lims.view') };
  const perform = { preHandler: requirePermission('lims.analysis.perform') };
  const today = () => plantToday(new Date());

  // The items, newest first, each with whether it may be used now and why not.
  app.get('/api/inventory', reader, async () => (await loadItems(sql, today())).map(({ row, status, events }) => ({ ...row, status, waitingCheck: !!waitingCheck(events) })));

  // For the worksheet's item field: the usable items of these kinds, and those left out with why (LIMS-12, 13, 14).
  app.get<{ Querystring: { kinds?: string } }>('/api/inventory/picks', reader, async (req) => {
    const kinds = String(req.query.kinds ?? '').split(',').filter((k): k is ItemKind => (ITEM_KINDS as readonly string[]).includes(k));
    const items = kinds.length ? await loadItems(sql, today(), undefined, kinds) : [];
    return {
      items: items.filter((l) => l.status.usable).map((l) => ({ itemId: labItemId(l.row.id), code: l.row.itemNo, name: l.row.name, active: true, type: l.row.kind, due: l.status.due })),
      leftOut: items.filter((l) => !l.status.usable && !l.events.some((e) => e.kind === 'disposed')).map((l) => ({ code: l.row.itemNo, name: l.row.name, why: l.status.why })),
    };
  });

  // One item: its facts, status, entries, what it was made from and what was made from it, and its uses (LIMS-14).
  app.get<{ Params: { id: string } }>('/api/inventory/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadItem(sql, id, today());
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const parents = l.row.parentIds.length ? await loadItems(sql, today(), l.row.parentIds) : [];
    const children = await sql<{ id: number; itemNo: string; kind: ItemKind; name: string }[]>`
      select id::int, item_no as "itemNo", kind, name from lab_items where ${id} = any(parent_ids) order by id`;
    const user = req.user!;
    const primary = parents[0] && l.row.kind === 'working' ? parentOf(parents[0]) : undefined;
    const refusals = Object.fromEntries(ITEM_ACTION_NAMES.map((a) => {
      const may = CHECK_ACTIONS.includes(a) ? user.permissions.includes('lims.analysis.review') : user.permissions.includes('lims.analysis.perform');
      // Entries with values are refused only for their kind and state here; their values are checked when sent.
      const probe: ItemPayload = { factor: '1.000', nextDue: '9999-12-31', potency: '99', basis: 'as is', passed: true, organisms: 'x', retestOn: '9999-12-31' };
      return [a, may ? itemRefusal(a, asItem(l.row), l.events, user.id, probe, today(), primary) : 'You do not have the right to record this entry.'];
    }));
    return {
      item: l.row, status: l.status, events: l.events, waitingCheck: waitingCheck(l.events),
      parents: parents.map((p) => ({ id: p.row.id, itemNo: p.row.itemNo, kind: p.row.kind, name: p.row.name, status: p.status })), children,
      uses: await itemUses(sql, l.row.id),
      actions: ITEM_ACTION_NAMES.filter((a) => refusals[a] === null), refusals,
    };
  });

  // Register an item as received or prepared: its kind's facts, and what it was made from or qualified against, each
  // usable now (LIMS-13, LIMS-14, LIMS-35). A culture's passage is its parent's plus one (0: a reference culture).
  app.post('/api/inventory', perform, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    const b = parsed.data;
    const user = req.user!;
    try {
      return await sql.begin(async (tx) => {
        const day = today();
        const ids = [...new Set(b.parentIds)];
        const parents = ids.length ? await loadItems(tx, day, ids) : [];
        if (parents.length !== ids.length) throw new ItemError(404, 'not_found', ['An item it was made from is not in the inventory.']);
        const facts: ItemFacts = Object.fromEntries(Object.entries(b.facts).filter(([, v]) => v !== '' && v !== undefined)) as unknown as ItemFacts;
        const problems = registerProblems(b.kind, facts, parents.map(parentOf), day);
        if (problems.length) throw new ItemError(409, 'not_registered', problems);
        if (b.kind === 'culture') facts.passage = parents[0] ? (parents[0].status.passage ?? 0) + 1 : 0;
        const prefix = ITEM_PREFIX[b.kind];
        const [c] = await tx<{ n: number; yy: string }[]>`
          insert into lab_item_counters (prefix, year, last_no) values (${prefix}, extract(year from now() at time zone ${PLANT_TZ})::int, 1)
          on conflict (prefix, year) do update set last_no = lab_item_counters.last_no + 1
          returning last_no as n, right(year::text, 2) as yy`;
        const itemNo = `${prefix}${c!.yy}${String(c!.n).padStart(4, '0')}`;
        const [r] = await tx<{ id: number }[]>`
          insert into lab_items (item_no, kind, name, facts, parent_ids, registered_by)
          values (${itemNo}, ${b.kind}, ${facts.name}, ${tx.json(facts as never)}, ${ids}, ${user.id}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'lab_item.registered', objectType: 'lab_item', objectId: r!.id, new: { itemNo, kind: b.kind, facts, parents: parents.map((p) => p.row.itemNo) } });
        return { id: r!.id, itemNo };
      });
    } catch (e) {
      if (e instanceof ItemError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
      throw e;
    }
  });

  // One route per entry, each in the same steps: read the item and its entries, check the entry and the person, insert
  // it, audit. A second person's check needs the review permission; every other entry the analyst's.
  for (const action of ITEM_ACTION_NAMES) {
    const kind = ITEM_ACTIONS[action];
    const rights = { preHandler: requirePermission(CHECK_ACTIONS.includes(action) ? 'lims.analysis.review' : 'lims.analysis.perform') };
    app.post<{ Params: { id: string } }>(`/api/inventory/:id/${action}`, rights, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = ACTION_BODIES[action].safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
      const user = req.user!;
      try {
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`lab-item:${id}`}))`;
          const day = today();
          const l = await loadItem(tx, id, day);
          if (!l) throw new ItemError(404, 'not_found');
          const payload = { ...(body.data as ItemPayload) };
          // A check names the entry it checks (the latest waiting one).
          if (action === 'check') payload.of = payload.of ?? waitingCheck(l.events)?.id;
          const primary = action === 'qualify' && l.row.parentIds[0] ? await loadItem(tx, l.row.parentIds[0], day) : null;
          const no = itemRefusal(action, asItem(l.row), l.events, user.id, payload, day, primary ? parentOf(primary) : undefined);
          if (no) throw new ItemError(action === 'check' && no.startsWith('The person') ? 403 : 409, 'not_allowed_now', [no]);
          if (primary) payload.against = primary.row.itemNo;
          const [ev] = await tx<{ id: number }[]>`
            insert into lab_item_events (item_id, kind, payload, person_id) values (${id}, ${kind}, ${tx.json(payload as never)}, ${user.id}) returning id::int`;
          await audit(tx, { actorId: user.id, action: `lab_item.${kind}`, objectType: 'lab_item', objectId: id,
            old: { usable: l.status.usable, why: l.status.why }, new: { event: ev!.id, ...payload }, reason: payload.reason ?? null });
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) {
        if (e instanceof ItemError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
        throw e;
      }
    });
  }
}
