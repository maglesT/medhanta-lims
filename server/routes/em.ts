import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { usableItem } from '../master.js';
import { batchShown, newSample, type MonitoringTaken, type SampleItem } from './samples.js';
import { shownFigure } from '../coa.js';
import { plantToday } from './inventory.js';
import { sampleTestResults } from './analyses.js';
import type { SpecDoc } from '../../shared/master/spec.js';
import { limitText } from '../../shared/master/spec.js';
import { DEVIATION_DONE } from '../../shared/engine/release.js';
import { COLONY_KINDS, PERSON_KINDS, WATER_SYSTEMS, pointWhere, type MonitoringDoc, type MonitoringPoint, type Sampling, type SamplingKind } from '../../shared/master/monitoring.js';
import {
  REPORT_LAYOUTS, dueList, excursionLevel, excursionRefusal, excursionStatus, parseReport, periodOf, rowWords,
  type ExcursionAction, type ExcursionEvent, type ExcursionFacts, type Level, type ReportKind, type ReportRow, type Take,
} from '../../shared/engine/monitoring.js';
import type { Source } from '../../shared/engine/links.js';

// Environmental monitoring and water (LIMS-36, LIMS-37; plan 2.9): the samplings the effective monitoring plans make due
// today; taking one makes an ordinary sample (purpose 'monitoring') through the sample code, so its analysis, review,
// OOS and QC decision are the existing ones; a reviewed result over its alert limit is a trend watch, over its action
// limit (grade A: any colony) an excursion investigated under a deviation; the daily summary reports of the continuous
// monitoring systems imported with their SHA-256, their alarms confirmed by a second person; the EM map and trend tables.

class EmError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}

interface Plan { id: number; masterId: number; versionNo: number; doc: MonitoringDoc; since: string }
/** The effective monitoring plans, with the plant date each became effective (what is due counts from it). */
async function effectivePlans(q: Sql | Tx): Promise<Plan[]> {
  const rows = await q<{ id: number; masterId: number; versionNo: number; doc: MonitoringDoc; since: Date | null; createdAt: Date }[]>`
    select v.id::int, v.master_id::int as "masterId", v.version_no as "versionNo", v.doc, v.created_at as "createdAt",
      (select min(e.at) from master_events e join master_versions x on x.id = e.version_id where x.master_id = v.master_id and e.kind = 'effective') as since
    from master_versions v where v.kind = 'monitoring' and v.state = 'effective' order by v.doc->'header'->>'number'`;
  return rows.map((r) => ({ id: r.id, masterId: r.masterId, versionNo: r.versionNo, doc: r.doc, since: plantToday(new Date(r.since ?? r.createdAt)) }));
}

interface Taken { id: number; sampleNo: string; specVersionId: number; item: SampleItem; m: MonitoringTaken; registeredAt: Date }
async function takenSamples(q: Sql | Tx, filter: { planMasterId?: number; point?: string; ids?: number[] } = {}, limit = 2000): Promise<Taken[]> {
  return [...await q<Taken[]>`
    select s.id::int, s.sample_no as "sampleNo", s.spec_version_id::int as "specVersionId", s.item, s.monitoring as m, s.registered_at as "registeredAt"
    from samples s where s.purpose = 'monitoring'
      ${filter.planMasterId !== undefined ? q`and s.monitoring->>'planMasterId' = ${String(filter.planMasterId)}` : q``}
      ${filter.point !== undefined ? q`and s.monitoring->>'point' = ${filter.point}` : q``}
      ${filter.ids ? q`and s.id = any(${filter.ids})` : q``}
    order by s.id desc limit ${limit}`];
}

/** A monitoring sample's latest reviewed result of its test, and its excursion level (LIMS-36, library S11). */
async function resultOf(q: Sql | Tx, t: Taken) {
  const r = (await sampleTestResults(q, t.id))[t.m.testKey]?.filter((a) => a.status === 'reviewed' && a.result).at(-1);
  if (!r?.result) return null;
  const lv = excursionLevel(r.result, t.m.limit ?? undefined, t.m.grade, t.m.kind as SamplingKind);
  return { analysisNo: r.analysisNo, value: shownFigure(r.result.value, t.m.limit as { low?: string; high?: string } | null), unit: r.result.unit, shown: r.result.shown, level: lv.level as Level, why: lv.why,
    growth: COLONY_KINDS.includes(t.m.kind as SamplingKind) && Number(r.result.value) > 0 };
}

interface ExcursionRow {
  id: number; origin: 'result' | 'import'; sampleId: number | null; sampleNo: string | null; testKey: string | null; importId: number | null; rowNo: number | null;
  level: 'alert' | 'action'; point: { code: string; name: string; of: 'room' | 'water'; where: string; grade: string | null; kind?: string; identify?: string };
  result: { shown: string; value?: string; unit?: string; limit?: string; growth?: boolean; analysisNo?: string };
  recordedBy: number; recordedByName: string; recordedAt: Date;
}
type Entry = ExcursionEvent & { personName: string; at: Date };
async function loadExcursions(q: Sql | Tx, id?: number) {
  const rows = await q<ExcursionRow[]>`
    select x.id::int, x.origin, x.sample_id::int as "sampleId", s.sample_no as "sampleNo", x.test_key as "testKey", x.import_id::int as "importId", x.row_no as "rowNo",
      x.level, x.point, x.result, x.recorded_by::int as "recordedBy", u.full_name as "recordedByName", x.recorded_at as "recordedAt"
    from em_excursions x join users u on u.id = x.recorded_by left join samples s on s.id = x.sample_id
    ${id === undefined ? q`` : q`where x.id = ${id}`} order by x.id desc limit 500`;
  const ev = rows.length ? await q<(Entry & { excursionId: number })[]>`
    select e.id::int, e.excursion_id::int as "excursionId", e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at
    from em_excursion_events e join users u on u.id = e.person_id where e.excursion_id = any(${rows.map((r) => r.id)}) order by e.id` : [];
  return rows.map((row) => {
    const events = ev.filter((e) => e.excursionId === row.id) as Entry[];
    const facts: ExcursionFacts = { origin: row.origin, level: row.level, recordedBy: row.recordedBy, identify: (row.point.identify ?? 'no') as ExcursionFacts['identify'], growth: !!row.result.growth };
    return { row, events, facts, status: excursionStatus(facts, events) };
  });
}
type Loaded = Awaited<ReturnType<typeof loadExcursions>>[number];

const text = (max = 200) => z.string().trim().min(1).max(max);
const BODIES = {
  take: z.object({
    planVersionId: z.number().int().positive(), point: z.string().min(1).max(40), sampling: z.string().min(1).max(40),
    shift: z.number().int().min(1).max(4).optional(), batch: text(60).optional(), person: text(120).optional(),
    // A sampling already taken in its period is taken again only with a reason (a resampling after an excursion).
    reason: text(500).optional(),
  }).strict(),
  open: z.object({ sampleId: z.number().int().positive(), deviation: text(60).optional() }).strict(),
  confirm: z.object({}).strict(),
  deviation: z.object({ number: text(60) }).strict(),
  check: z.object({}).strict(),
  isolate: z.object({ genus: text(80).regex(/^[A-Z][a-z]+$/, 'a genus, e.g. Staphylococcus'), species: text(80), methodMasterId: z.number().int().positive(), report: text(120) }).strict(),
  close: z.object({ text: text(2000) }).strict(),
  note: z.object({ text: text(1000) }).strict(),
  import: z.object({ kind: z.enum(['particle', 'water']), fileName: text(200), content: z.string().min(1).max(1_000_000) }).strict(),
};
const ACTIONS = ['confirm', 'deviation', 'check', 'isolate', 'close', 'note'] as const;
const EVENT_OF = { confirm: 'confirmed', deviation: 'deviation', check: 'checked', isolate: 'isolate', close: 'closed', note: 'note' } as const;

/** Deviations' word on a deviation: closed (true), open (false), not read (null: absent or down), or unknown. */
async function deviationNow(app: FastifyInstance, number: string) {
  const r = await app.links.deviations.byNumbers([number]);
  if (r.state !== 'ok') return { link: r.state, known: null, closed: null, shown: null };
  const d = r.value.get(number);
  if (!d) return { link: 'ok' as const, known: false, closed: null, shown: null };
  return { link: 'ok' as const, known: true, closed: d.closedAt !== null || DEVIATION_DONE.includes(d.status.toLowerCase()), shown: `${d.number}: ${d.title ?? ''} (${d.status})` };
}

export function emRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.sample.register', 'lims.qc.approve', 'lims.view') };
  const sampler = { preHandler: requirePermission('lims.sample.register') };
  const today = () => plantToday(new Date());
  const fail = (e: unknown, reply: FastifyReply) => {
    if (e instanceof EmError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
    throw e;
  };
  const invalid = (reply: FastifyReply, issues: z.ZodIssue[] = []) => reply.code(400).send({ error: 'invalid', problems: issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`), message: issues[0]?.message });

  // ---- The schedule (LIMS-36, LIMS-37) ----

  // The TrueBatch batches an EM sampling may be taken during (owner 19 Nov 2026: picked, never typed): those in
  // production or waiting for release, of every edition; the link's state (absent or down: typed, then checked).
  app.get('/api/em/batches', reader, async () => {
    const r = await app.links.truebatch.waiting();
    return { link: r.state, batches: r.state === 'ok' ? r.value.map((b) => ({ batchNumber: b.batchNumber, productCode: b.productCode, status: b.status, edition: b.edition ?? 'truebatch' })) : [] };
  });

  // What the effective plans make due today, overdue (the previous period missed), and the per-batch samplings.
  app.get('/api/em/due', reader, async () => {
    const plans = await effectivePlans(sql);
    const now = today();
    const due = [];
    const perBatch = [];
    for (const p of plans) {
      const taken = await takenSamples(sql, { planMasterId: p.masterId });
      const takes: Take[] = taken.map((t) => ({ point: t.m.point, sampling: t.m.sampling, on: t.m.takenOn }));
      const info = (pt: MonitoringPoint, s: Sampling) => {
        const last = taken.find((t) => t.m.point === pt.key && t.m.sampling === s.key);
        return { planVersionId: p.id, planNumber: p.doc.header.number, planVersionNo: p.versionNo, point: pt.key, code: pt.code, name: pt.name, where: pointWhere(pt), of: pt.of,
          grade: pt.room?.grade ?? null, critical: pt.critical, sampling: s.key, kind: s.kind, state: s.state ?? null, frequency: s.frequency, quantity: s.quantity,
          spec: s.spec, person: PERSON_KINDS.includes(s.kind), last: last ? { sampleId: last.id, sampleNo: last.sampleNo, on: last.m.takenOn } : null };
      };
      for (const { state: dueState, ...r } of dueList(p.doc, takes, now, p.since)) {
        const pt = p.doc.points.find((x) => x.key === r.point)!;
        // state: the room's (at rest, in operation); due: done, due or overdue.
        due.push({ ...info(pt, pt.samplings.find((x) => x.key === r.sampling)!), ...r, due: dueState, shifts: p.doc.header.shifts,
          shiftsTaken: taken.filter((t) => t.m.point === r.point && t.m.sampling === r.sampling && t.m.takenOn === now && t.m.shift !== null).map((t) => t.m.shift) });
      }
      for (const pt of p.doc.points) for (const s of pt.samplings) if (s.frequency === 'per batch') perBatch.push(info(pt, s));
    }
    return { today: now, due, perBatch, plans: plans.map((p) => ({ id: p.id, masterId: p.masterId, versionNo: p.versionNo, number: p.doc.header.number, name: p.doc.header.name, since: p.since, points: p.doc.points.length })) };
  });

  // A sampling taken (LIMS-36, LIMS-37): an ordinary sample of the room or water system, purpose 'monitoring', tested to
  // the effective version of the plan's specification for the sampling's test only.
  app.post('/api/em/take', sampler, async (req, reply) => {
    const body = BODIES.take.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues);
    const b = body.data;
    const user = req.user!;
    try {
      const plan = (await effectivePlans(sql)).find((p) => p.id === b.planVersionId);
      if (!plan) throw new EmError(409, 'not_effective', ['That plan version is not effective: samplings are taken from the effective plan.']);
      const pt = plan.doc.points.find((x) => x.key === b.point);
      const s = pt?.samplings.find((x) => x.key === b.sampling);
      if (!pt || !s) throw new EmError(404, 'not_found', ['The plan has no such point or sampling.']);
      const what = `${pt.code}, ${s.kind}`;
      if (s.frequency === 'per shift' && (b.shift === undefined || b.shift > plan.doc.header.shifts)) throw new EmError(400, 'invalid', [`${what} is taken per shift: say which shift (1 to ${plan.doc.header.shifts}).`]);
      if (s.frequency !== 'per shift' && b.shift !== undefined) throw new EmError(400, 'invalid', [`${what} is not taken per shift.`]);
      if (s.frequency === 'per batch' && !b.batch) throw new EmError(400, 'invalid', [`${what} is taken per batch: give the batch number.`]);
      if (PERSON_KINDS.includes(s.kind) && !b.person) throw new EmError(400, 'invalid', [`${what}: name the person sampled.`]);
      // The room as master data has it now (PL-08); a water system is the plan's.
      let item: SampleItem;
      if (pt.of === 'room') {
        const r = usableItem(await app.master.rooms(), pt.room!.itemId, 'room');
        item = { of: 'room', itemId: r.itemId, code: r.code, name: r.name };
      } else item = { of: 'water', itemId: `water:${pt.system}`, code: pt.system!, name: WATER_SYSTEMS[pt.system!] };
      // The batch of a per-batch sampling: TrueBatch's while it answers; typed by hand (then checked) while not.
      let source: Source = { from: 'plan', asOf: null, shown: `Monitoring plan ${plan.doc.header.number} version ${plan.versionNo}: point ${pt.code} (${pointWhere(pt)}), ${s.kind}${s.state ? `, ${s.state}` : ''}` };
      if (b.batch) {
        const read = await app.links.truebatch.batch(b.batch);
        if (read.state === 'ok') {
          if (!read.value) throw new EmError(409, 'not_found', [`Batch ${b.batch} is not in TrueBatch.`]);
          source = { ...source, shown: `${source.shown}; ${batchShown(read.value)}` };
        } else source = { from: 'hand', link: 'truebatch', state: read.state };
      }
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`em:${plan.masterId}:${pt.key}:${s.key}`}))`;
        const now = today();
        // Taken already in its period: again only with a reason; one sample per shift.
        const taken = (await takenSamples(tx, { planMasterId: plan.masterId, point: pt.key })).filter((t) => t.m.sampling === s.key);
        const period = periodOf(s.frequency, now);
        if (s.frequency === 'per shift') {
          const same = taken.find((t) => t.m.takenOn === now && t.m.shift === b.shift);
          if (same && !b.reason) throw new EmError(409, 'already_taken', [`${what}, shift ${b.shift} is already taken today (${same.sampleNo}): give the reason to take it again.`]);
        } else if (s.frequency === 'per batch') {
          const same = b.batch ? taken.find((t) => t.m.batch === b.batch) : undefined;
          if (same && !b.reason) throw new EmError(409, 'already_taken', [`${what} is already taken for batch ${b.batch} (${same.sampleNo}): give the reason to take it again (re-sample: why?).`]);
        } else if (period) {
          const same = taken.find((t) => t.m.takenOn >= period.from && t.m.takenOn <= period.to);
          if (same && !b.reason) throw new EmError(409, 'already_taken', [`${what} is already taken this ${s.frequency === 'daily' ? 'day' : s.frequency === 'weekly' ? 'week' : 'month'} (${same.sampleNo}): give the reason to take it again.`]);
        }
        // LIMS-01: the specification version effective now, with the sampling's test.
        const [spec] = await tx<{ id: number; doc: SpecDoc }[]>`select id::int, doc from master_versions where kind = 'spec' and state = 'effective' and master_id = ${s.spec!.masterId}`;
        const test = spec?.doc.tests.find((t) => t.key === s.spec!.testKey);
        if (!spec || !test) throw new EmError(409, 'no_spec', [`${what}: specification ${s.spec!.number} has no effective version with the test ${s.spec!.testName}: a sample is tested against the effective version only.`]);
        const monitoring: MonitoringTaken = {
          planVersionId: plan.id, planMasterId: plan.masterId, planNumber: plan.doc.header.number, planVersionNo: plan.versionNo, point: pt.key, pointCode: pt.code, pointName: pt.name,
          sampling: s.key, kind: s.kind, frequency: s.frequency, state: s.state ?? null, grade: pt.room?.grade ?? null, critical: pt.critical, identify: s.identify,
          testKey: test.key, limit: test.limit ?? null, takenOn: now, shift: b.shift ?? null, batch: b.batch ?? null, person: b.person ?? null,
        };
        const sample = await newSample(tx, user.id, { specVersionId: spec.id, purpose: 'monitoring', lotNo: pt.code, item, source, quantity: s.quantity, containers: null, monitoring });
        if (b.reason) {
          await tx`insert into sample_events (sample_id, kind, payload, person_id) values (${sample.id}, 'note', ${tx.json({ text: `Taken again: ${b.reason}` })}, ${user.id})`;
        }
        return { ok: true, sampleId: sample.id, sampleNo: sample.sampleNo, byHand: source.from === 'hand' };
      });
    } catch (e) { return fail(e, reply); }
  });

  // ---- Results, the EM map and trends ----

  // Per room and water system: its points, each sampling's latest reviewed results with the limits and levels (the map),
  // and the last results per sampling (the trend table, ?point=<plan master>:<point key>&n=).
  app.get<{ Querystring: { point?: string; n?: string } }>('/api/em/map', reader, async (req) => {
    const plans = await effectivePlans(sql);
    const n = Math.min(Math.max(Number(req.query.n) || 10, 1), 50);
    const [pm, pk] = (req.query.point ?? '').split(':');
    const groups = new Map<string, { key: string; of: 'room' | 'water'; code: string; name: string; grade: string | null; points: unknown[] }>();
    for (const p of plans) {
      for (const pt of p.doc.points) {
        if (pm && (String(p.masterId) !== pm || pt.key !== pk)) continue;
        const taken = await takenSamples(sql, { planMasterId: p.masterId, point: pt.key }, 200);
        const samplings = [];
        for (const s of pt.samplings) {
          const rows = [];
          for (const t of taken.filter((x) => x.m.sampling === s.key)) {
            if (rows.length >= n) break;
            const r = await resultOf(sql, t);
            rows.push({ sampleId: t.id, sampleNo: t.sampleNo, on: t.m.takenOn, shift: t.m.shift, state: t.m.state, result: r });
          }
          samplings.push({ key: s.key, kind: s.kind, state: s.state ?? null, frequency: s.frequency, limit: s.spec?.limit ?? '', spec: s.spec, results: rows,
            latest: rows.find((x) => x.result) ?? null });
        }
        const gk = pt.of === 'room' ? `room:${pt.room?.code}` : `water:${pt.system}`;
        if (!groups.has(gk)) groups.set(gk, { key: gk, of: pt.of, code: pt.of === 'room' ? pt.room!.code : pt.system!, name: pt.of === 'room' ? pt.room!.name : WATER_SYSTEMS[pt.system!], grade: pt.room?.grade ?? null, points: [] });
        groups.get(gk)!.points.push({ planMasterId: p.masterId, planNumber: p.doc.header.number, key: pt.key, code: pt.code, name: pt.name, critical: pt.critical, samplings });
      }
    }
    return { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  });

  // ---- Excursions (LIMS-36) ----

  // The reviewed results over a limit not yet recorded (action: an investigation to open; alert: a trend watch), and
  // the excursions with their status and what this person may do next.
  app.get('/api/em/excursions', reader, async (req) => {
    const user = req.user!;
    const loaded = await loadExcursions(sql);
    const recorded = new Set(loaded.filter((x) => x.row.origin === 'result').map((x) => x.row.sampleId));
    const pending = [];
    for (const t of await takenSamples(sql, {}, 500)) {
      if (recorded.has(t.id)) continue;
      const r = await resultOf(sql, t);
      if (!r || r.level === 'none') continue;
      pending.push({ sampleId: t.id, sampleNo: t.sampleNo, on: t.m.takenOn, point: { code: t.m.pointCode, name: t.m.pointName, where: t.item.of === 'room' ? `${t.item.code} ${t.item.name}${t.m.grade ? ` (grade ${t.m.grade})` : ''}` : t.item.name },
        kind: t.m.kind, state: t.m.state, level: r.level, shown: r.shown, why: r.why, analysisNo: r.analysisNo });
    }
    return {
      pending, mayOpen: user.permissions.includes('lims.sample.register'),
      excursions: loaded.map((x) => ({ ...x.row, status: x.status, deviation: x.events.filter((e) => e.kind === 'deviation').at(-1)?.payload.number ?? null })),
    };
  });

  // An excursion of a reviewed result (LIMS-36): action opens its investigation with the deviation (picked from
  // Deviations while it answers; typed by hand, then checked, while not); an alert is recorded as a trend watch.
  app.post('/api/em/excursions', sampler, async (req, reply) => {
    const body = BODIES.open.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues);
    const b = body.data;
    const user = req.user!;
    try {
      const dev = b.deviation ? await deviationNow(app, b.deviation) : null;
      if (dev?.known === false) throw new EmError(409, 'unknown_deviation', [`${b.deviation} is not in the DIVE system: pick the deviation filed for this excursion, or check the number.`]);
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`em-sample:${b.sampleId}`}))`;
        const [t] = await takenSamples(tx, { ids: [b.sampleId] });
        if (!t) throw new EmError(404, 'not_found', ['No such monitoring sample.']);
        const r = await resultOf(tx, t);
        if (!r) throw new EmError(409, 'no_result', [`${t.sampleNo} has no reviewed result yet.`]);
        if (r.level === 'none') throw new EmError(409, 'within_limits', [`${t.sampleNo}: ${r.shown}: no excursion.`]);
        if (r.level === 'action' && !b.deviation) throw new EmError(400, 'invalid', [`${t.sampleNo} is over its action limit: give the deviation number of its investigation.`]);
        if (r.level === 'alert' && b.deviation) throw new EmError(400, 'invalid', [`${t.sampleNo} is over its alert limit only: a trend watch, no investigation.`]);
        const [spec] = await tx<{ doc: SpecDoc }[]>`select doc from master_versions where id = ${t.specVersionId}`;
        const test = spec?.doc.tests.find((x) => x.key === t.m.testKey);
        const point = { code: t.m.pointCode, name: t.m.pointName, of: t.item.of, where: t.item.of === 'room' ? `${t.item.code} ${t.item.name}` : t.item.name, grade: t.m.grade,
          kind: t.m.kind, state: t.m.state, identify: t.m.identify, plan: t.m.planNumber };
        const result = { shown: r.shown, value: r.value, unit: r.unit, limit: test ? limitText(test) : '', growth: r.growth, analysisNo: r.analysisNo, why: r.why };
        const [x] = await tx<{ id: number }[]>`
          insert into em_excursions (origin, sample_id, test_key, level, point, result, recorded_by)
          values ('result', ${t.id}, ${t.m.testKey}, ${r.level}, ${tx.json(point as never)}, ${tx.json(result as never)}, ${user.id}) returning id::int`;
        if (b.deviation) {
          await tx`insert into em_excursion_events (excursion_id, kind, payload, person_id) values (${x!.id}, 'deviation', ${tx.json({ number: b.deviation, byHand: dev!.link !== 'ok', ...(dev!.shown ? { shown: dev!.shown } : {}) })}, ${user.id})`;
        }
        await audit(tx, { actorId: user.id, action: 'em.excursion_opened', objectType: 'em_excursion', objectId: x!.id, new: { sampleNo: t.sampleNo, level: r.level, point, result, deviation: b.deviation ?? null } });
        return { id: x!.id };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'already_open', message: 'This result already has its excursion.' });
      return fail(e, reply);
    }
  });

  // One excursion: its point, result, investigation (read live from Deviations), isolates, entries and what this person may do.
  app.get<{ Params: { id: string } }>('/api/em/excursions/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const [x] = id === null ? [] : await loadExcursions(sql, id);
    if (!x) return reply.code(404).send({ error: 'not_found' });
    const user = req.user!;
    const dev = x.events.filter((e) => e.kind === 'deviation').at(-1);
    const now = dev?.payload.number ? await deviationNow(app, dev.payload.number) : null;
    const picks = await app.links.deviations.byBatch(...[x.row.sampleNo ?? '', x.row.point.code].filter(Boolean));
    const may = (a: ExcursionAction) => {
      const need = a === 'close' ? 'lims.qc.approve' : 'lims.sample.register';
      return user.permissions.includes(need) ? excursionRefusal(a, x.facts, x.events, user.id, now?.closed ?? null)
        : a === 'close' ? 'QA closes an excursion (the QC approval permission).' : 'This needs the sample register permission.';
    };
    const methods = await sql<{ masterId: number; code: string; name: string }[]>`
      select master_id::int as "masterId", doc->'header'->>'code' as code, doc->'header'->>'name' as name from master_versions
      where kind = 'method' and state = 'effective' order by doc->'header'->>'code'`;
    return {
      excursion: { ...x.row, status: x.status }, events: x.events,
      deviation: dev ? { number: dev.payload.number, byHand: !!dev.payload.byHand, link: now?.link ?? 'absent', shown: now?.shown ?? null, closed: now?.closed ?? null } : null,
      deviations: { link: picks.state, list: picks.state === 'ok' ? picks.value : [] },
      refusals: Object.fromEntries((['confirm', 'deviation', 'check', 'isolate', 'close'] as const).map((a) => [a, may(a)])),
      methods: [...methods],
    };
  });

  for (const action of ACTIONS) {
    app.post<{ Params: { id: string } }>(`/api/em/excursions/:id/${action}`, { preHandler: requirePermission(action === 'close' ? 'lims.qc.approve' : 'lims.sample.register') }, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = BODIES[action].safeParse(req.body);
      if (id === null || !body.success) return invalid(reply, body.error?.issues);
      const b = body.data as Record<string, unknown>;
      const user = req.user!;
      try {
        // Read before the transaction: the deviation in Deviations (a number given, or the one to close under).
        const [pre] = await loadExcursions(sql, id);
        if (!pre) throw new EmError(404, 'not_found');
        const devNo = action === 'deviation' ? String(b.number) : pre.events.filter((e) => e.kind === 'deviation').at(-1)?.payload.number;
        const dev = devNo && (action === 'deviation' || action === 'close') ? await deviationNow(app, devNo) : null;
        if (action === 'deviation' && dev?.known === false) throw new EmError(409, 'unknown_deviation', [`${devNo} is not in the DIVE system: pick the deviation filed for this excursion, or check the number.`]);
        let payload: ExcursionEvent['payload'] & { shown?: string; methodMasterId?: number } = {};
        if (action === 'isolate') {
          const [m] = await sql<{ code: string; name: string }[]>`select doc->'header'->>'code' as code, doc->'header'->>'name' as name from master_versions
            where kind = 'method' and state = 'effective' and master_id = ${b.methodMasterId as number}`;
          if (!m) throw new EmError(409, 'no_method', ['Pick the identification method from the effective methods.']);
          payload = { genus: b.genus as string, species: b.species as string, method: `${m.code} ${m.name}`, methodMasterId: b.methodMasterId as number, report: b.report as string };
        } else if (action === 'deviation') payload = { number: devNo!, byHand: dev!.link !== 'ok', ...(dev!.shown ? { shown: dev!.shown } : {}) };
        else if (action === 'close' || action === 'note') payload = { text: b.text as string };
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`em-excursion:${id}`}))`;
          const [x] = await loadExcursions(tx, id);
          if (action === 'check') payload = { entry: x!.events.filter((e) => e.kind === 'deviation').at(-1)?.id ?? 0 };
          if (action !== 'note') {
            const no = excursionRefusal(action, x!.facts, x!.events, user.id, dev?.closed ?? null);
            if (no) throw new EmError(409, 'not_allowed_now', [no]);
          } else if (x!.status === 'closed') throw new EmError(409, 'not_allowed_now', ['The excursion is closed.']);
          const [ev] = await tx<{ id: number }[]>`insert into em_excursion_events (excursion_id, kind, payload, person_id) values (${id}, ${EVENT_OF[action]}, ${tx.json(payload as never)}, ${user.id}) returning id::int`;
          await audit(tx, { actorId: user.id, action: `em.excursion_${EVENT_OF[action]}`, objectType: 'em_excursion', objectId: id!, new: { event: ev!.id, ...payload } });
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) { return fail(e, reply); }
    });
  }

  // ---- Continuous monitoring: the daily summary reports (owner, 18 Nov 2026) ----

  app.get('/api/em/imports', reader, async () => ({
    layouts: REPORT_LAYOUTS,
    imports: await sql`select i.id::int, i.kind, i.file_name as "fileName", i.size, i.sha256, i.report_date::text as "reportDate", i.rows, u.full_name as "importedByName", i.imported_at as "importedAt",
        (select count(*)::int from em_excursions x where x.import_id = i.id) as alarms
      from em_imports i join users u on u.id = i.imported_by order by i.id desc limit 200`,
  }));

  // A report imported: read by its fixed layout, its rooms (master data) or water points (the effective plans) known; the
  // file's SHA-256 kept (the same file twice is refused) and the values stored as read; each alarm an excursion that a
  // second person confirms.
  app.post('/api/em/imports', sampler, async (req, reply) => {
    const body = BODIES.import.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues);
    const b = body.data;
    const user = req.user!;
    try {
      const parsed = parseReport(b.kind as ReportKind, b.content);
      if (!parsed.ok) throw new EmError(400, 'bad_file', [parsed.message]);
      if (parsed.date > today()) throw new EmError(400, 'bad_file', [`The report is of ${parsed.date}, a day still to come.`]);
      const bytes = Buffer.from(b.content, 'utf8');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // Where each row is: a room of master data (particle counters), or a water point of an effective plan.
      const points = new Map<string, ExcursionRow['point']>();
      if (b.kind === 'particle') {
        const rooms = await app.master.rooms();
        for (const r of parsed.rows) {
          const room = rooms.find((x) => x.code === r.where);
          if (!room) throw new EmError(409, 'unknown_room', [`Room ${r.where} is not in master data.`]);
          points.set(r.where, { code: room.code, name: room.name, of: 'room', where: `${room.code} ${room.name}`, grade: room.grade, kind: 'particles', identify: 'no' });
        }
      } else {
        const plans = await effectivePlans(sql);
        for (const r of parsed.rows) {
          const pt = plans.flatMap((p) => p.doc.points).find((x) => x.of === 'water' && x.code === r.where);
          if (!pt) throw new EmError(409, 'unknown_point', [`Water point ${r.where} is not in an effective monitoring plan.`]);
          points.set(r.where, { code: pt.code, name: pt.name, of: 'water', where: pointWhere(pt), grade: null, kind: 'online TOC and conductivity', identify: 'no' });
        }
      }
      return await sql.begin(async (tx) => {
        const [dup] = await tx<{ id: number; fileName: string }[]>`select id::int, file_name as "fileName" from em_imports where sha256 = ${sha256}`;
        if (dup) throw new EmError(409, 'already_imported', [`This file was imported already (${dup.fileName}): the same SHA-256.`]);
        const [imp] = await tx<{ id: number }[]>`
          insert into em_imports (kind, file_name, size, sha256, report_date, rows, imported_by)
          values (${b.kind}, ${b.fileName}, ${bytes.length}, ${sha256}, ${parsed.date}, ${tx.json(parsed.rows as never)}, ${user.id}) returning id::int`;
        const alarms = parsed.rows.map((r, i) => ({ r, i })).filter((x) => x.r.alarm);
        for (const { r, i } of alarms) {
          await tx`insert into em_excursions (origin, import_id, row_no, level, point, result, recorded_by)
            values ('import', ${imp!.id}, ${i + 1}, ${r.alarm === 'ACTION' ? 'action' : 'alert'}, ${tx.json(points.get(r.where)! as never)},
              ${tx.json({ shown: `${parsed.date}: ${rowWords(b.kind as ReportKind, r as ReportRow)}: ${r.alarm} alarm`, values: r.values, ...(r.channel ? { channel: r.channel } : {}) } as never)}, ${user.id})`;
        }
        await audit(tx, { actorId: user.id, action: 'em.report_imported', objectType: 'em_import', objectId: imp!.id, new: { kind: b.kind, fileName: b.fileName, size: bytes.length, sha256, date: parsed.date, rows: parsed.rows.length, alarms: alarms.length } });
        return { id: imp!.id, sha256, date: parsed.date, rows: parsed.rows.length, alarms: alarms.length };
      });
    } catch (e) { return fail(e, reply); }
  });
}
