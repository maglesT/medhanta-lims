import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import type { LinkState } from '../../shared/engine/links.js';
import type { SpecDoc } from '../../shared/master/spec.js';
import {
  FINDINGS, KEEP_RULES, KEEP_RULE_NAMES, RESERVE_ACTIONS, RESERVE_ACTION_NAMES, addYears, parseQty, reserveLogProblems, reserveRefusal, reserveStatus, reserveWaitingCheck,
  type KeepRule, type Qty, type ReserveAction, type ReserveEvent, type ReserveFacts, type ReserveNeed, type ReservePayload, type ReserveState,
} from '../../shared/engine/reserve.js';
import { plantToday } from './inventory.js';
import { effectiveSpecs, lotShown, type SampleItem } from './samples.js';

// Reserve (retention) samples (LIMS-30) and the retest of stored materials (LIMS-31).
// A reserve sample is logged from a lot's or batch's release sample (one per lot), then insert-only entries follow: the
// yearly visual inspection, withdrawals and the destruction (each checked by a second person), notes. Its status is
// computed (shared/engine/reserve.ts). QC approval of a release sample waits for it when the specification names a
// reserve quantity (samples.ts, approvalProblems). The retest-due list reads MMS's released lots by their retest date
// live; a retest sample is registered as any sample (purpose 'retest', samples.ts) and decided and published as any.

const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';

export interface ReserveRow {
  id: number; sampleId: number; sampleNo: string; lotNo: string; item: SampleItem; specNumber: string; specVersionNo: number; reserveQuantity: string | null;
  amount: string; unit: string; location: string; rule: KeepRule; fromDate: string; keptUntil: string;
  loggedBy: number; loggedByName: string; loggedAt: Date; day: string;
}
export type ReserveEventRow = ReserveEvent & { personName: string; at: Date };
export interface LoadedReserve { row: ReserveRow; events: ReserveEventRow[]; required: Qty | null; state: ReserveState }

class ReserveError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}
const facts = (r: ReserveRow): ReserveFacts => ({ amount: r.amount, unit: r.unit, location: r.location, rule: r.rule, fromDate: r.fromDate, keptUntil: r.keptUntil, loggedBy: r.loggedBy, day: r.day });

/** Reserve samples (all, these ids, or the one of a sample) with their entries and their status today. */
export async function loadReserves(q: Sql | Tx, today: string, by: { ids?: number[]; sampleId?: number } = {}): Promise<LoadedReserve[]> {
  const rows = await q<ReserveRow[]>`
    select r.id::int, r.sample_id::int as "sampleId", s.sample_no as "sampleNo", s.lot_no as "lotNo", s.item, v.doc->'header'->>'number' as "specNumber",
      v.version_no as "specVersionNo", v.doc->'header'->>'reserveQuantity' as "reserveQuantity", r.amount::text as amount, r.unit, r.location, r.rule,
      r.from_date::text as "fromDate", r.kept_until::text as "keptUntil", r.logged_by::int as "loggedBy", u.full_name as "loggedByName", r.logged_at as "loggedAt",
      (r.logged_at at time zone ${PLANT_TZ})::date::text as day
    from reserve_samples r join samples s on s.id = r.sample_id join master_versions v on v.id = s.spec_version_id join users u on u.id = r.logged_by
    where (${by.ids ?? null}::bigint[] is null or r.id = any(${by.ids ?? null}::bigint[])) and (${by.sampleId ?? null}::bigint is null or r.sample_id = ${by.sampleId ?? null})
    order by r.id desc limit 2000`;
  if (!rows.length) return [];
  const events = await q<(ReserveEventRow & { reserveId: number })[]>`
    select e.id::int, e.reserve_id::int as "reserveId", e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at,
      (e.at at time zone ${PLANT_TZ})::date::text as day
    from reserve_sample_events e join users u on u.id = e.person_id where e.reserve_id = any(${rows.map((r) => r.id)}) order by e.id`;
  return rows.map((row) => {
    const mine = events.filter((e) => e.reserveId === row.id).map(({ reserveId: _, ...e }) => e);
    const required = parseQty(row.reserveQuantity);
    return { row, events: mine, required, state: reserveStatus(facts(row), mine, required, today) };
  });
}

/** LIMS-30: what QC's decision on a release sample needs about its lot's reserve sample. */
export async function reserveNeed(q: Sql | Tx, sampleId: number, spec: SpecDoc): Promise<ReserveNeed> {
  const required = parseQty(spec.header.reserveQuantity);
  const [r] = required ? await loadReserves(q, plantToday(new Date()), { sampleId }) : [];
  return { required, reserve: r ? { left: r.state.left, unit: r.row.unit, destroyed: r.state.status === 'destroyed' } : null };
}

/** LIMS-31: the retest samples of a lot, newest first, with QC's decision (null: not decided yet) and whether disposed. */
async function retestSamples(q: Sql | Tx, lotNo: string) {
  return q<{ id: number; sampleNo: string; decision: 'approved' | 'rejected' | null; disposed: boolean; registeredAt: Date }[]>`
    select s.id::int, s.sample_no as "sampleNo", s.registered_at as "registeredAt",
      (select e.kind from sample_events e where e.sample_id = s.id and e.kind in ('approved', 'rejected') limit 1) as decision,
      exists (select 1 from sample_events e where e.sample_id = s.id and e.kind = 'disposed') as disposed
    from samples s where s.lot_no = ${lotNo} and s.item->>'of' = 'material' and s.purpose = 'retest' order by s.id desc`;
}
/** The retest sample of a lot still waiting for QC's decision, if any (one at a time). */
export async function openRetestSample(q: Sql | Tx, lotNo: string): Promise<string | null> {
  return (await retestSamples(q, lotNo)).find((s) => !s.decision && !s.disposed)?.sampleNo ?? null;
}

const text = (max = 200) => z.string().trim().min(1).max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'give a date, e.g. 2028-03-31');
const logBody = z.object({
  quantity: text(60), location: text(200), rule: z.enum(KEEP_RULE_NAMES as [KeepRule, ...KeepRule[]]), fromDate: day, keptUntil: day,
}).strict();
const ACTION_BODIES: Record<ReserveAction, z.ZodTypeAny> = {
  inspect: z.object({ finding: z.enum(FINDINGS), reason: text(500).optional() }).strict(),
  withdraw: z.object({ amount: z.string().trim().max(20), reason: text(500) }).strict(),
  destroy: z.object({ reason: text(500) }).strict(),
  check: z.object({}).strict(),
  note: z.object({ text: text(1000) }).strict(),
};

export function reserveRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.sample.register', 'lims.view') };
  const register = { preHandler: requirePermission('lims.sample.register') };
  const today = () => plantToday(new Date());
  const send = (reply: import('fastify').FastifyReply, e: unknown) => {
    if (e instanceof ReserveError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
    throw e;
  };

  // The reserve samples, newest first, with their status.
  app.get('/api/reserves', reader, async () => (await loadReserves(sql, today())).map(({ row, state, events }) => ({ ...row, state, waitingCheck: !!reserveWaitingCheck(events) })));

  // One reserve sample: its facts, its status, its entries, and the entries this person may add now.
  app.get<{ Params: { id: string } }>('/api/reserves/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const [l] = id === null ? [] : await loadReserves(sql, today(), { ids: [id] });
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const user = req.user!;
    const may = user.permissions.includes('lims.sample.register');
    // Entries with values are refused only for their kind and state here; their values are checked when sent.
    const probe: ReservePayload = { finding: 'no deterioration', amount: '0.000001', reason: 'x', text: 'x' };
    const refusals = Object.fromEntries(RESERVE_ACTION_NAMES.map((a) => [a, may ? reserveRefusal(a, facts(l.row), l.events, user.id, probe, today()) : 'You do not have the right to record reserve sample entries.']));
    return { reserve: l.row, required: l.required, state: l.state, events: l.events, waitingCheck: reserveWaitingCheck(l.events),
      actions: RESERVE_ACTION_NAMES.filter((a) => refusals[a] === null), refusals };
  });

  // Log the reserve sample of a release sample's lot or batch (LIMS-30): the quantity kept (in the specification's unit),
  // the storage location, and how long it is kept (the rule, the date it counts from, the kept-until date, checked).
  app.post<{ Params: { id: string } }>('/api/samples/:id/reserve', register, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = logBody.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) ?? [] });
    const b = body.data;
    const user = req.user!;
    try {
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`reserve:${id}`}))`;
        const [s] = await tx<{ id: number; sampleNo: string; purpose: string; lotNo: string; doc: SpecDoc }[]>`
          select s.id::int, s.sample_no as "sampleNo", s.purpose, s.lot_no as "lotNo", v.doc from samples s join master_versions v on v.id = s.spec_version_id where s.id = ${id}`;
        if (!s) throw new ReserveError(404, 'not_found');
        if (s.purpose !== 'release') throw new ReserveError(409, 'not_release', ['A reserve sample is kept from the release sample of a lot or batch.']);
        const [had] = await tx<{ id: number }[]>`select id::int from reserve_samples where sample_id = ${id}`;
        if (had) throw new ReserveError(409, 'already_logged', [`The reserve sample of ${s.lotNo} is already logged.`]);
        const required = parseQty(s.doc.header.reserveQuantity);
        const problems = reserveLogProblems(b, required, today());
        if (problems.length) throw new ReserveError(409, 'not_logged', problems);
        const q = parseQty(b.quantity)!;
        const [r] = await tx<{ id: number }[]>`
          insert into reserve_samples (sample_id, amount, unit, location, rule, from_date, kept_until, logged_by)
          values (${id}, ${q.amount}, ${q.unit}, ${b.location}, ${b.rule}, ${b.fromDate}, ${b.keptUntil}, ${user.id}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'reserve.logged', objectType: 'reserve_sample', objectId: r!.id,
          new: { sampleNo: s.sampleNo, lotNo: s.lotNo, amount: q.amount, unit: q.unit, location: b.location, rule: b.rule, fromDate: b.fromDate, keptUntil: b.keptUntil,
            minimum: addYears(b.fromDate, KEEP_RULES[b.rule].years), required: s.doc.header.reserveQuantity ?? null } });
        return { id: r!.id };
      });
    } catch (e) { return send(reply, e); }
  });

  // One route per entry, each in the same steps: read the reserve sample and its entries, check the entry and the person,
  // insert it, audit. A check names the withdrawal or destruction waiting for it.
  for (const action of RESERVE_ACTION_NAMES) {
    const kind = RESERVE_ACTIONS[action];
    app.post<{ Params: { id: string } }>(`/api/reserves/:id/${action}`, register, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = ACTION_BODIES[action].safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) ?? [] });
      const user = req.user!;
      try {
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`reserve-entry:${id}`}))`;
          const d = today();
          const [l] = await loadReserves(tx, d, { ids: [id] });
          if (!l) throw new ReserveError(404, 'not_found');
          const payload = { ...(body.data as ReservePayload) };
          const no = reserveRefusal(action, facts(l.row), l.events, user.id, payload, d);
          if (no) throw new ReserveError(action === 'check' && no.startsWith('The person') ? 403 : 409, 'not_allowed_now', [no]);
          if (action === 'check') payload.of = reserveWaitingCheck(l.events)!.id;
          const [ev] = await tx<{ id: number }[]>`
            insert into reserve_sample_events (reserve_id, kind, payload, person_id) values (${id}, ${kind}, ${tx.json(payload as never)}, ${user.id}) returning id::int`;
          await audit(tx, { actorId: user.id, action: `reserve.${kind}`, objectType: 'reserve_sample', objectId: id,
            old: { status: l.state.status, left: l.state.left }, new: { event: ev!.id, ...payload }, reason: payload.reason ?? null });
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) { return send(reply, e); }
    });
  }

  // LIMS-31: the released MMS lots whose retest date is within the next N days or past, read live; each with its
  // effective specification, its retest sample waiting for QC (if any) and its last decided one.
  app.get<{ Querystring: { days?: string } }>('/api/retest-due', register, async (req) => {
    const days = Math.min(365, Math.max(0, Number.parseInt(String(req.query.days ?? '30'), 10) || 0));
    const d = today();
    const until = new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const lots = await app.links.mms.retestDue(until);
    const rows = [];
    if (lots.state === 'ok') for (const l of lots.value) {
      const specs = l.materialMasterId ? await effectiveSpecs(sql, 'material', l.materialMasterId) : [];
      const retests = await retestSamples(sql, l.lotNumber);
      const open = retests.find((s) => !s.decision && !s.disposed);
      const last = retests.find((s) => s.decision);
      rows.push({ source: 'mms' as const, lotNo: l.lotNumber, of: 'material' as const, itemId: l.materialMasterId ?? '', code: l.materialCode ?? '',
        name: specs[0]?.header.name ?? null, status: l.status, shown: lotShown(l), asOf: l.dataAsOf, stock: l.stock ? `${l.stock} ${l.unit ?? ''}`.trim() : null,
        specs: specs.map(({ header, ...x }) => ({ ...x, number: header.number, type: header.type, market: header.market ?? null })),
        noSpec: specs.length ? null : `No effective specification for ${l.materialCode ?? 'this material'}.`,
        retestDate: l.retestDate!, past: l.retestDate! < d, sampleNo: open?.sampleNo ?? null, sampleId: open?.id ?? null,
        lastRetest: last ? { sampleNo: last.sampleNo, decision: last.decision } : null });
    }
    return { link: lots.state satisfies LinkState, days, until, rows,
      // The lots past their retest date with no retest sample yet: they are not used until retested (MMS keeps them from issue).
      pastWithout: rows.filter((r) => r.past && !r.sampleNo).map((r) => r.lotNo) };
  });
}
