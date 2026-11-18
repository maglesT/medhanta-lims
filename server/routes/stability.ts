import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { usableItem } from '../master.js';
import type { BatchRead, LotRead } from '../links.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';
import { batchShown, lotShown, newSample, type SampleItem } from './samples.js';
import { plantToday } from './inventory.js';
import { sampleTestResults } from './analyses.js';
import { conditionLabel, type ProtocolDoc } from '../../shared/master/protocol.js';
import { l23Mkt } from '../../shared/templates/index.js';
import { fmt } from '../../shared/templates/core.js';
import type { SpecDoc } from '../../shared/master/spec.js';
import { PROVIDER_NAME, clauses, type Source } from '../../shared/engine/links.js';
import {
  addDays, affectedBy, capacity, checkRefusal, extraRefusal, isChecked, ongoingFlags, pointState, pullOf, pullRefusal, readingRange, schedule, stock,
  type ChamberRef, type Reading, type StudyEvent, type StudyFacts,
} from '../../shared/engine/stability.js';

// Stability studies (LIMS-26, LIMS-27, LIMS-28; plan 2.6 and 2b): an effective protocol version applied to one batch
// (TrueBatch) or lot (MMS), placed per condition in a chamber the Logbook says is fit for use; pulls on schedule make
// the stability samples through the same code as sample registration; chamber excursions with their readings; the
// on-going stability flags and the chamber capacity. The schedule, stock and what is due are computed
// (shared/engine/stability.ts).

const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';
export const STUDY_PREFIX = 'STB';

/** The mean kinetic temperature of an excursion's readings (template L23, USP <1160>): its value and worked line, or why not. */
function mkt(readings: readonly Reading[]) {
  const r = l23Mkt({ readings: readings.map((x) => `${x.temperature} °C`), times: readings.map((x) => x.at) });
  return r.ok ? { ok: true as const, value: `${fmt(r.value, 2)} °C`, shown: r.shown } : { ok: false as const, message: r.message };
}

class StabilityError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}

interface StudyRow {
  id: number; studyNo: string; protocolVersionId: number; lotNo: string; item: SampleItem; source: Source; cell: string | null; t0: string;
  createdBy: number; createdByName: string; createdAt: Date;
  protocol: ProtocolDoc; protocolVersionNo: number; protocolState: string;
}
type EventRow = StudyEvent & { personName: string; at: Date; signature: { printedName: string; signedAt: Date } | null };

const STUDY = (q: Sql | Tx) => q`
  select s.id::int, s.study_no as "studyNo", s.protocol_version_id::int as "protocolVersionId", s.lot_no as "lotNo", s.item, s.source, s.cell, s.t0::text as t0,
    s.created_by::int as "createdBy", u.full_name as "createdByName", s.created_at as "createdAt",
    v.doc as protocol, v.version_no as "protocolVersionNo", v.state as "protocolState"
  from stability_studies s join users u on u.id = s.created_by join master_versions v on v.id = s.protocol_version_id`;

async function eventsOf(q: Sql | Tx, ids: number[]): Promise<(EventRow & { studyId: number })[]> {
  if (!ids.length) return [];
  return [...await q<(EventRow & { studyId: number })[]>`
    select e.id::int, e.study_id::int as "studyId", e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at,
      (select json_build_object('printedName', g.printed_name, 'signedAt', g.signed_at) from signatures g where g.object_type = 'stability_event' and g.object_id = e.id limit 1) as signature
    from stability_events e join users u on u.id = e.person_id where e.study_id = any(${ids}) order by e.id`];
}
async function loadStudies(q: Sql | Tx, id?: number) {
  const rows = id === undefined ? await q<StudyRow[]>`${STUDY(q)} order by s.id desc limit 1000` : await q<StudyRow[]>`${STUDY(q)} where s.id = ${id}`;
  const ev = await eventsOf(q, rows.map((r) => r.id));
  return rows.map((s) => ({ s, events: ev.filter((e) => e.studyId === s.id) as EventRow[] }));
}
type Loaded = Awaited<ReturnType<typeof loadStudies>>[number];
const facts = (s: StudyRow): StudyFacts => ({ createdBy: s.createdBy, byHand: s.source.from === 'hand', t0: s.t0 });
// What QA signs when approving extra placement: the study by its last entry (refused if anything was added since).
const studyContent = (l: Loaded) => ({ study: l.s.id, studyNo: l.s.studyNo, lotNo: l.s.lotNo, lastEvent: l.events.at(-1)?.id ?? 0 });
const studyHash = (l: Loaded) => contentHash('stability_study', l.s.id, studyContent(l));
const pulledOn = (events: readonly EventRow[]) => Object.fromEntries(events.filter((e) => e.kind === 'pulled').map((e) => [e.id, plantToday(new Date(e.at))]));

/** The study's time points with their state today, and the next one to pull. */
function points(l: Loaded, today: string) {
  return schedule(l.s.protocol, l.s.t0, l.s.cell).map((p) => {
    const pull = pullOf(l.events, p.condition, p.month);
    return { ...p, state: pointState(p, l.events, today), sampleId: pull?.payload.sampleId ?? null, sampleNo: pull?.payload.sampleNo ?? null, late: pull?.payload.late ?? null };
  });
}

/** A chamber (master-data equipment) and whether it may hold samples now: the Logbook decides (LIMS-28). */
async function chamberStatus(app: FastifyInstance, itemId: string) {
  const r = await app.links.logbook.status(itemId);
  if (r.state !== 'ok' || r.value === 'stale') return { link: r.state === 'ok' ? 'down' as const : r.state, fit: null, why: null };
  if (!r.value) return { link: 'ok' as const, fit: false, why: 'is not in the Logbook, so it cannot hold stability samples' };
  const s = r.value;
  return { link: 'ok' as const, fit: s.fitForUse, why: s.fitForUse ? null : clauses(s.blockers.length ? s.blockers : [`${s.state.replaceAll('_', ' ')} in the Logbook`]) };
}

const text = (max = 200) => z.string().trim().min(1).max(max);
const quantity = z.string().trim().regex(/^\d+(\.\d{1,3})?$/, 'a number');
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'a date and time');
const BODIES = {
  study: z.object({
    protocolVersionId: z.number().int().positive(),
    batchNumber: text(60),
    // Typed by hand while TrueBatch (or MMS) is absent or down; then a second person checks the study.
    byHand: z.boolean().default(false),
    cell: text(120).optional(),
    placements: z.array(z.object({ condition: z.string().min(1).max(40), chamberItemId: z.string().min(1).max(100), quantity }).strict()).min(1).max(10),
  }).strict(),
  pull: z.object({ condition: z.string().min(1).max(40), month: z.number().int().min(0).max(120), late: z.object({ reason: text(1000), deviation: text(60) }).strict().optional() }).strict(),
  extra: z.object({ condition: z.string().min(1).max(40), quantity, reason: text(1000) }).strict(),
  'approve-extra': signBody.extend({ entry: z.number().int().positive() }),
  check: z.object({ entry: z.number().int().min(0) }).strict(),
  note: z.object({ text: text(1000) }).strict(),
};

export function stabilityRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.sample.register', 'lims.qc.approve', 'lims.view') };
  const sampler = { preHandler: requirePermission('lims.sample.register') };
  const qa = { preHandler: requirePermission('lims.qc.approve') };
  const today = () => plantToday(new Date());
  const fail = (e: unknown, reply: import('fastify').FastifyReply) => {
    if (e instanceof StabilityError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
    if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
    throw e;
  };

  // The effective protocols a study can be started from.
  app.get('/api/stability/protocols', reader, async () => sql`
    select id::int, master_id::int as "masterId", version_no as "versionNo", doc from master_versions where kind = 'protocol' and state = 'effective'
    order by doc->'header'->>'number'`);

  // The batches (TrueBatch) or lots (MMS) of a protocol's product or material that can be put on study, as read now.
  app.get<{ Querystring: { protocol?: string } }>('/api/stability/batches', sampler, async (req, reply) => {
    const id = parseId(String(req.query.protocol ?? ''));
    const [v] = id === null ? [] : await sql<{ doc: ProtocolDoc }[]>`select doc from master_versions where id = ${id} and kind = 'protocol'`;
    if (!v) return reply.code(404).send({ error: 'not_found' });
    const h = v.doc.header;
    if (h.of === 'product') {
      const r = await app.links.truebatch.ofProduct(h.code);
      return { from: 'truebatch', link: r.state, batches: r.state === 'ok' ? r.value.map((b) => ({ number: b.batchNumber, shown: batchShown(b) })) : [] };
    }
    const r = await app.links.mms.usable(h.itemId, '1900-01-01');
    return { from: 'mms', link: r.state, batches: r.state === 'ok' ? r.value.map((l) => ({ number: l.lotNumber, shown: lotShown(l) })) : [] };
  });

  // The chambers (master-data equipment named a chamber) and whether each may hold samples now (the Logbook decides).
  app.get('/api/stability/chambers', reader, async () => {
    const list = (await app.master.equipment()).filter((e) => e.active && /chamber/i.test(`${e.type ?? ''} ${e.name}`));
    return Promise.all(list.map(async (e) => ({ itemId: e.itemId, code: e.code, name: e.name, ...await chamberStatus(app, e.itemId) })));
  });

  // Start a study (plan 2.6): the protocol's every condition placed in a chamber the Logbook says is fit, T0 today.
  app.post('/api/stability/studies', sampler, async (req, reply) => {
    const parsed = BODIES.study.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    const b = parsed.data;
    const user = req.user!;
    try {
      const [v] = await sql<{ id: number; state: string; doc: ProtocolDoc }[]>`select id::int, state, doc from master_versions where id = ${b.protocolVersionId} and kind = 'protocol'`;
      if (!v) throw new StabilityError(404, 'not_found', ['There is no such protocol.']);
      if (v.state !== 'effective') throw new StabilityError(409, 'not_effective', [`Protocol ${v.doc.header.number} version is ${v.state.replace('_', ' ')}: a study follows the effective version only.`]);
      const doc = v.doc;
      const h = doc.header;
      if (b.cell && !doc.design.matrix.some((m) => m.cell === b.cell)) throw new StabilityError(409, 'no_cell', [`The protocol's matrix has no cell ${b.cell}.`]);
      if (doc.design.type === 'matrixing' && !b.cell) throw new StabilityError(400, 'invalid', ['Say which cell of the matrix this batch is.']);
      // 1. the batch or lot, read now (pull, don't type)
      const from = h.of === 'product' ? 'truebatch' : 'mms';
      const name = PROVIDER_NAME[from];
      const read = from === 'truebatch' ? await app.links.truebatch.batch(b.batchNumber) : await app.links.mms.lot(b.batchNumber);
      let source: Source;
      if (b.byHand) {
        if (read.state === 'ok') throw new StabilityError(409, 'link_ok', [`${name} answers: pick the ${from === 'mms' ? 'lot' : 'batch'} from its list.`]);
        source = { from: 'hand', link: from, state: read.state };
      } else {
        if (read.state !== 'ok') throw new StabilityError(409, 'link_off', [`${name} ${read.state === 'down' ? 'does not answer' : 'is not linked'} now: type the ${from === 'mms' ? 'lot' : 'batch'} by hand; a second person checks the study.`]);
        if (from === 'truebatch') {
          const t = read.value as BatchRead | null;
          if (!t) throw new StabilityError(409, 'not_found', [`Batch ${b.batchNumber} is not in TrueBatch.`]);
          if (t.productCode !== h.code) throw new StabilityError(409, 'other_product', [`Batch ${b.batchNumber} is of ${t.productCode ?? '—'}, not of ${h.code}.`]);
          if (!t.completedAt || t.status === 'REJECTED') throw new StabilityError(409, 'not_made', [`Batch ${b.batchNumber} is ${t.status.replaceAll('_', ' ').toLowerCase()} in TrueBatch: only a completed batch goes on study.`]);
          source = { from: 'truebatch', asOf: t.dataAsOf, shown: batchShown(t) };
        } else {
          const l = read.value as LotRead | null;
          if (!l) throw new StabilityError(409, 'not_found', [`Lot ${b.batchNumber} is not in MMS.`]);
          if (l.materialMasterId !== h.itemId) throw new StabilityError(409, 'other_material', [`Lot ${b.batchNumber} is of ${l.materialCode ?? '—'}, not of ${h.code}.`]);
          source = { from: 'mms', asOf: l.dataAsOf, shown: lotShown(l) };
        }
      }
      const item = h.of === 'product' ? usableItem(await app.master.products(), h.itemId, 'product') : usableItem(await app.master.materials(), h.itemId, 'material');
      // 2. each condition in a chamber the Logbook says is fit (LIMS-28), with enough units for its time points
      const t0 = today();
      const per = Number(doc.quantity.amount);
      const placed: { condition: string; chamber: ChamberRef; chamberByHand: boolean; quantity: string }[] = [];
      const equipment = await app.master.equipment();
      for (const c of doc.conditions) {
        const p = b.placements.find((x) => x.condition === c.key);
        if (!p) throw new StabilityError(409, 'not_placed', [`Place the samples for ${conditionLabel(c)} too.`]);
        const ch = usableItem(equipment, p.chamberItemId, 'chamber');
        const st = await chamberStatus(app, ch.itemId);
        if (st.link === 'ok' && !st.fit) throw new StabilityError(409, 'chamber_not_fit', [`${ch.code} ${st.why}.`]);
        // Fewer than the time points need may be placed (what the batch allows): the pull that would leave a later time
        // point short is refused until QA approves more placement (plan 2b-5). Less than one pull is refused now.
        if (Number(p.quantity) < per) throw new StabilityError(409, 'too_few', [`${conditionLabel(c)}: place at least one pull's quantity (${per} ${doc.quantity.unit}).`]);
        placed.push({ condition: c.key, chamber: { itemId: ch.itemId, code: ch.code, name: ch.name }, chamberByHand: st.link !== 'ok', quantity: p.quantity });
      }
      const stray = b.placements.find((p) => !doc.conditions.some((c) => c.key === p.condition));
      if (stray) throw new StabilityError(409, 'no_condition', [`The protocol has no condition ${stray.condition}.`]);
      return await sql.begin(async (tx) => {
        const [c] = await tx<{ n: number; yy: string }[]>`
          insert into stability_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
          on conflict (year) do update set last_no = stability_counters.last_no + 1 returning last_no as n, right(year::text, 2) as yy`;
        const studyNo = `${STUDY_PREFIX}${c!.yy}${String(c!.n).padStart(3, '0')}`;
        const studyItem: SampleItem = { of: h.of, itemId: item.itemId, code: item.code, name: item.name };
        const [s] = await tx<{ id: number }[]>`
          insert into stability_studies (study_no, protocol_version_id, lot_no, item, source, cell, t0, created_by)
          values (${studyNo}, ${v.id}, ${b.batchNumber}, ${tx.json(studyItem as never)}, ${tx.json(source as never)}, ${b.cell ?? null}, ${t0}, ${user.id}) returning id::int`;
        for (const p of placed) {
          await tx`insert into stability_events (study_id, kind, payload, person_id) values (${s!.id}, 'placed', ${tx.json(p as never)}, ${user.id})`;
        }
        await audit(tx, { actorId: user.id, action: 'stability.study_started', objectType: 'stability_study', objectId: s!.id,
          new: { studyNo, protocol: v.id, lotNo: b.batchNumber, item: studyItem, source, cell: b.cell ?? null, t0, placed } });
        return { id: s!.id, studyNo };
      });
    } catch (e) { return fail(e, reply); }
  });

  // The studies with their next pull, what is due this week and what is overdue (LIMS-28).
  app.get('/api/stability/studies', reader, async () => {
    const now = today();
    const week = addDays(now, 7);
    const all = await loadStudies(sql);
    const due: object[] = [];
    const studies = all.map((l) => {
      const ps = points(l, now);
      for (const p of ps) {
        if (p.state === 'overdue' || (p.state !== 'pulled' && p.from <= week)) due.push({ studyId: l.s.id, studyNo: l.s.studyNo, lotNo: l.s.lotNo, item: l.s.item, ...p });
      }
      const next = ps.filter((p) => p.state !== 'pulled').sort((a, b) => a.due.localeCompare(b.due))[0] ?? null;
      return { id: l.s.id, studyNo: l.s.studyNo, lotNo: l.s.lotNo, item: l.s.item, t0: l.s.t0, byHand: l.s.source.from === 'hand', protocolNumber: l.s.protocol.header.number,
        protocolVersionNo: l.s.protocolVersionNo, purpose: l.s.protocol.header.purpose, pack: l.s.protocol.header.containerClosure, next,
        pulled: ps.filter((p) => p.state === 'pulled').length, total: ps.length, overdue: ps.filter((p) => p.state === 'overdue').length };
    });
    return { today: now, studies, due: due.sort((a, b) => String((a as { due: string }).due).localeCompare(String((b as { due: string }).due))) };
  });

  // One study: its schedule, stock, entries, results per time point, the excursions that touched it, and what this person may do.
  app.get<{ Params: { id: string } }>('/api/stability/studies/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const [l] = id === null ? [] : await loadStudies(sql, id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const now = today();
    const user = req.user!;
    const ps = points(l, now);
    // Results per time point: each stability sample's analyses for the specification's stability tests.
    const [spec] = l.s.protocol.spec ? await sql<{ doc: SpecDoc }[]>`select doc from master_versions where id = ${l.s.protocol.spec.versionId}` : [];
    const tests = (spec?.doc.tests ?? []).filter((t) => t.use !== 'release');
    const results = [];
    for (const p of ps.filter((x) => x.sampleId)) {
      const r = await sampleTestResults(sql, p.sampleId!, app);
      results.push({ condition: p.condition, label: p.label, month: p.month, sampleId: p.sampleId, sampleNo: p.sampleNo,
        tests: Object.fromEntries(tests.map((t) => { const a = (r[t.key] ?? []).at(-1); return [t.key, a ? { analysisNo: a.analysisNo, status: a.status, shown: a.result?.shown ?? null, pass: a.result?.pass ?? null } : null]; })) });
    }
    const excursions = (await loadExcursions(sql)).filter((x) => affectedBy(x.at, [{ ...l.s, doc: l.s.protocol, events: l.events, pulledOn: pulledOn(l.events) }]).length)
      .map((x) => ({ id: x.row.id, chamber: x.row.chamber, from: x.row.fromAt, to: x.row.toAt, deviation: x.row.deviation, range: readingRange(x.row.readings), mkt: mkt(x.row.readings) }));
    const may = user.permissions.includes('lims.sample.register');
    // Typed by hand, waiting for a second person: the study's batch (entry 0), a chamber without the Logbook, a late pull's deviation.
    const typed = [...(l.s.source.from === 'hand' ? [0] : []), ...l.events.filter((e) => (e.kind === 'placed' && e.payload.chamberByHand) || (e.kind === 'pulled' && e.payload.late?.byHand)).map((e) => e.id)];
    return {
      study: { ...l.s, protocol: undefined }, protocol: l.s.protocol, events: l.events, today: now,
      // Why each time point may not be pulled now (an overdue one: whether it may be, given its reason and deviation).
      points: ps.map((p) => ({ ...p, refusal: !may ? 'Pulls need the sample register permission.' : p.state === 'pulled' ? null
        : pullRefusal(l.s.protocol, facts(l.s), l.events, p.condition, p.month, now, p.state === 'overdue' ? { reason: 'given', deviation: 'given' } : undefined, l.s.cell) })),
      stock: stock(l.s.protocol, l.s.t0, l.events, l.s.cell), tests: tests.map((t) => ({ key: t.key, name: t.name, limit: t.limitType })), results, excursions,
      // Entries typed by hand waiting for a second person (0: the study), with why this person may not check each.
      toCheck: typed.filter((e) => !isChecked(l.events, e)).map((e) => ({ entry: e, refusal: may ? checkRefusal(facts(l.s), l.events, e, user.id) : 'Checks need the sample register permission.' })),
      extras: l.events.filter((e) => e.kind === 'extra').map((e) => ({ entry: e.id, condition: e.payload.condition, quantity: e.payload.quantity, reason: e.payload.reason, personName: e.personName,
        approved: l.events.some((x) => x.kind === 'extra_approved' && x.payload.entry === e.id),
        refusal: user.permissions.includes('lims.qc.approve') ? extraRefusal(l.events, e.id, user.id) : 'QA approves extra placement (the QC approval permission).' })),
      contentHash: studyHash(l),
    };
  });

  // A pull (LIMS-28): within its window, or late with the reason and a deviation; it makes the stability sample.
  app.post<{ Params: { id: string } }>('/api/stability/studies/:id/pull', sampler, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = BODIES.pull.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    const b = body.data;
    const user = req.user!;
    try {
      // The deviation of a late pull: one of Deviations' while it answers; typed by hand (then checked) while it does not.
      const dev = b.late ? await app.links.deviations.byNumbers([b.late.deviation]) : null;
      if (dev?.state === 'ok' && !dev.value.get(b.late!.deviation)) throw new StabilityError(409, 'unknown_deviation', [`${b.late!.deviation} is not in the Deviations system: check the number.`]);
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`stability:${id}`}))`;
        const [l] = await loadStudies(tx, id);
        if (!l) throw new StabilityError(404, 'not_found');
        const now = today();
        const p = schedule(l.s.protocol, l.s.t0, l.s.cell).find((x) => x.condition === b.condition && x.month === b.month);
        const late = p && now > p.to;
        const no = pullRefusal(l.s.protocol, facts(l.s), l.events, b.condition, b.month, now, b.late, l.s.cell);
        if (no) throw new StabilityError(409, 'not_allowed_now', [no]);
        if (b.late && !late) throw new StabilityError(409, 'not_late', [`The ${b.month}-month pull is within its window: no late reason is needed.`]);
        const spec = l.s.protocol.spec!;
        const sample = await newSample(tx, user.id, { specVersionId: spec.versionId, purpose: 'stability', lotNo: l.s.lotNo, item: l.s.item, source: l.s.source,
          quantity: `${l.s.protocol.quantity.amount} ${l.s.protocol.quantity.unit}`, containers: null,
          stability: { studyId: l.s.id, studyNo: l.s.studyNo, condition: b.condition, label: p!.label, month: b.month } });
        const payload = { condition: b.condition, month: b.month, due: p!.due, sampleId: sample.id, sampleNo: sample.sampleNo,
          ...(b.late ? { late: { reason: b.late.reason, deviation: b.late.deviation, byHand: dev!.state !== 'ok' } } : {}) };
        const [ev] = await tx<{ id: number }[]>`insert into stability_events (study_id, kind, payload, person_id) values (${l.s.id}, 'pulled', ${tx.json(payload)}, ${user.id}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'stability.pulled', objectType: 'stability_study', objectId: l.s.id, new: { event: ev!.id, ...payload }, reason: b.late?.reason ?? null });
        return { ok: true, eventId: ev!.id, sampleId: sample.id, sampleNo: sample.sampleNo };
      });
    } catch (e) { return fail(e, reply); }
  });

  // More placed for a condition (plan 2b-5): counts once QA approves it.
  app.post<{ Params: { id: string } }>('/api/stability/studies/:id/extra', sampler, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = BODIES.extra.safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    try {
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`stability:${id}`}))`;
        const [l] = await loadStudies(tx, id);
        if (!l) throw new StabilityError(404, 'not_found');
        if (!l.s.protocol.conditions.some((c) => c.key === body.data.condition)) throw new StabilityError(409, 'no_condition', ['The protocol has no such condition.']);
        const [ev] = await tx<{ id: number }[]>`insert into stability_events (study_id, kind, payload, person_id) values (${l.s.id}, 'extra', ${tx.json(body.data)}, ${req.user!.id}) returning id::int`;
        await audit(tx, { actorId: req.user!.id, action: 'stability.extra_placed', objectType: 'stability_study', objectId: l.s.id, new: { event: ev!.id, ...body.data }, reason: body.data.reason });
        return { ok: true, eventId: ev!.id };
      });
    } catch (e) { return fail(e, reply); }
  });

  // QA approves an extra placement (e-signature "QC approved"): a person other than the one who placed it.
  app.post<{ Params: { id: string } }>('/api/stability/studies/:id/approve-extra', qa, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = BODIES['approve-extra'].safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    const user = req.user!;
    try {
      const signer = await authenticateSigner(sql, app.proofKey, user, { proof: body.data.proof }, { objectType: 'stability_study', objectId: id, meaning: 'qc_approved' });
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`stability:${id}`}))`;
        const [l] = await loadStudies(tx, id);
        if (!l) throw new StabilityError(404, 'not_found');
        const no = extraRefusal(l.events, body.data.entry, user.id);
        if (no) throw new StabilityError(no.startsWith('You placed') ? 403 : 409, 'not_allowed_now', [no]);
        if (body.data.contentHash !== studyHash(l)) throw new StabilityError(409, 'content_changed', ['The study changed since you opened it.']);
        const extra = l.events.find((e) => e.id === body.data.entry)!;
        const payload = { entry: body.data.entry, condition: extra.payload.condition, quantity: extra.payload.quantity };
        const [ev] = await tx<{ id: number }[]>`insert into stability_events (study_id, kind, payload, person_id) values (${l.s.id}, 'extra_approved', ${tx.json(payload)}, ${user.id}) returning id::int`;
        const content = { ...studyContent(l), action: 'approve-extra', ...payload };
        await sign(tx, { signer, objectType: 'stability_event', objectId: ev!.id, meaning: 'qc_approved', content, shownHash: contentHash('stability_event', ev!.id, content) });
        await audit(tx, { actorId: user.id, action: 'stability.extra_approved', objectType: 'stability_study', objectId: l.s.id, new: { event: ev!.id, ...payload } });
        return { ok: true, eventId: ev!.id };
      });
    } catch (e) { return fail(e, reply); }
  });

  // A second person's check of what was typed by hand: the study's batch (entry 0), a chamber without the Logbook, a
  // late pull's deviation typed without Deviations (LIMS-50).
  for (const action of ['check', 'note'] as const) {
    app.post<{ Params: { id: string } }>(`/api/stability/studies/:id/${action}`, sampler, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = BODIES[action].safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
      const user = req.user!;
      try {
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`stability:${id}`}))`;
          const [l] = await loadStudies(tx, id);
          if (!l) throw new StabilityError(404, 'not_found');
          if (action === 'check') {
            const no = checkRefusal(facts(l.s), l.events, (body.data as { entry: number }).entry, user.id);
            if (no) throw new StabilityError(no.startsWith('The person') || no.startsWith('You typed') ? 403 : 409, 'not_allowed_now', [no]);
          }
          const kind = action === 'check' ? 'checked' : 'note';
          const [ev] = await tx<{ id: number }[]>`insert into stability_events (study_id, kind, payload, person_id) values (${l.s.id}, ${kind}, ${tx.json(body.data)}, ${user.id}) returning id::int`;
          await audit(tx, { actorId: user.id, action: `stability.${kind}`, objectType: 'stability_study', objectId: l.s.id, new: { event: ev!.id, ...body.data } });
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) { return fail(e, reply); }
    });
  }

  // ---- Excursions (plan 2b-2, LIMS-28) ----
  async function loadExcursions(q: Sql | Tx) {
    const rows = await q<{ id: number; chamber: ChamberRef; fromAt: Date; toAt: Date; readings: Reading[]; deviation: string; deviationSource: Source; recordedBy: number;
      recordedByName: string; recordedAt: Date }[]>`
      select x.id::int, x.chamber, x.from_at as "fromAt", x.to_at as "toAt", x.readings, x.deviation, x.deviation_source as "deviationSource",
        x.recorded_by::int as "recordedBy", u.full_name as "recordedByName", x.recorded_at as "recordedAt"
      from stability_excursions x join users u on u.id = x.recorded_by order by x.id desc limit 500`;
    const ev = rows.length ? await q<{ excursionId: number; kind: 'checked' | 'assessed'; payload: { text?: string }; person: number; personName: string; at: Date }[]>`
      select e.excursion_id::int as "excursionId", e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at
      from stability_excursion_events e join users u on u.id = e.person_id where e.excursion_id = any(${rows.map((r) => r.id)}) order by e.id` : [];
    return rows.map((row) => ({ row, events: ev.filter((e) => e.excursionId === row.id),
      at: { chamberItemId: row.chamber.itemId, fromDate: plantToday(new Date(row.fromAt)), toDate: plantToday(new Date(row.toAt)) } }));
  }

  app.get('/api/stability/excursions', reader, async (req) => {
    const studies = (await loadStudies(sql)).map((l) => ({ ...l.s, doc: l.s.protocol, events: l.events, pulledOn: pulledOn(l.events) }));
    const user = req.user!;
    return (await loadExcursions(sql)).map((x) => {
      const checked = x.events.find((e) => e.kind === 'checked');
      const assessed = x.events.find((e) => e.kind === 'assessed');
      return { ...x.row, range: readingRange(x.row.readings), mkt: mkt(x.row.readings), checked: checked ?? null, assessed: assessed ?? null, affected: affectedBy(x.at, studies),
        checkRefusal: checked ? 'A second person has already checked it.' : x.row.recordedBy === user.id ? 'You entered it: a second person checks it.'
          : user.permissions.includes('lims.sample.register') ? null : 'Checks need the sample register permission.',
        assessRefusal: assessed ? 'Its impact is already assessed.' : !checked ? 'A second person checks the readings first.' : user.permissions.includes('lims.qc.approve') ? null : 'QC assesses the impact (the QC approval permission).' };
    });
  });

  // An excursion entered by QC (until the Logbook publishes them): the chamber, the period, its readings, the deviation.
  app.post('/api/stability/excursions', sampler, async (req, reply) => {
    const body = z.object({
      chamberItemId: z.string().min(1).max(100), from: localTime, to: localTime, deviation: text(60),
      readings: z.array(z.object({ at: localTime, temperature: z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'a temperature in °C'), humidity: z.string().regex(/^\d+(\.\d)?$/).optional() }).strict()).min(1).max(2000),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', problems: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const b = body.data;
    const user = req.user!;
    try {
      const ch = usableItem(await app.master.equipment(), b.chamberItemId, 'chamber');
      // Times typed from the chamber's record are plant time.
      const at = (x: string) => `${x}:00+05:30`;
      if (b.to <= b.from) throw new StabilityError(400, 'invalid', ['The excursion ends after it begins.']);
      const outside = b.readings.find((r) => r.at < b.from || r.at > b.to);
      if (outside) throw new StabilityError(400, 'invalid', [`The reading of ${outside.at.replace('T', ' ')} is outside the excursion's period.`]);
      if (new Date(at(b.to)) > new Date()) throw new StabilityError(400, 'invalid', ['The excursion cannot end in the future.']);
      const dev = await app.links.deviations.byNumbers([b.deviation]);
      if (dev.state === 'ok' && !dev.value.get(b.deviation)) throw new StabilityError(409, 'unknown_deviation', [`${b.deviation} is not in the Deviations system: check the number.`]);
      const devSource: Source = dev.state === 'ok' ? { from: 'deviations', asOf: null, shown: `${b.deviation}: ${dev.value.get(b.deviation)!.title ?? ''} (${dev.value.get(b.deviation)!.status})` } : { from: 'hand', link: 'deviations', state: dev.state };
      const readings = [...b.readings].sort((x, y) => x.at.localeCompare(y.at)).map((r) => ({ ...r, at: at(r.at) }));
      // The readings must give a mean kinetic temperature (L23: at least two, at equal intervals).
      const m = mkt(readings);
      if (!m.ok) throw new StabilityError(400, 'invalid', [`${m.message}.`]);
      return await sql.begin(async (tx) => {
        const chamber: ChamberRef = { itemId: ch.itemId, code: ch.code, name: ch.name };
        const [x] = await tx<{ id: number }[]>`
          insert into stability_excursions (chamber, from_at, to_at, readings, deviation, deviation_source, recorded_by)
          values (${tx.json(chamber as never)}, ${at(b.from)}, ${at(b.to)}, ${tx.json(readings as never)}, ${b.deviation}, ${tx.json(devSource as never)}, ${user.id}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'stability.excursion_recorded', objectType: 'stability_excursion', objectId: x!.id, new: { chamber, from: at(b.from), to: at(b.to), readings, deviation: b.deviation, devSource } });
        return { id: x!.id };
      });
    } catch (e) { return fail(e, reply); }
  });

  for (const action of ['check', 'assess'] as const) {
    app.post<{ Params: { id: string } }>(`/api/stability/excursions/:id/${action}`, action === 'check' ? sampler : qa, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = (action === 'check' ? z.object({}).strict() : z.object({ text: text(2000) }).strict()).safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
      const user = req.user!;
      try {
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`excursion:${id}`}))`;
          const x = (await loadExcursions(tx)).find((r) => r.row.id === id);
          if (!x) throw new StabilityError(404, 'not_found');
          const checked = x.events.some((e) => e.kind === 'checked');
          if (action === 'check') {
            if (checked) throw new StabilityError(409, 'not_allowed_now', ['A second person has already checked it.']);
            if (x.row.recordedBy === user.id) throw new StabilityError(403, 'not_allowed_now', ['You entered it: a second person checks it.']);
          } else {
            if (!checked) throw new StabilityError(409, 'not_allowed_now', ['A second person checks the readings first.']);
            if (x.events.some((e) => e.kind === 'assessed')) throw new StabilityError(409, 'not_allowed_now', ['Its impact is already assessed.']);
          }
          const kind = action === 'check' ? 'checked' : 'assessed';
          const [ev] = await tx<{ id: number }[]>`insert into stability_excursion_events (excursion_id, kind, payload, person_id) values (${id}, ${kind}, ${tx.json(body.data)}, ${user.id}) returning id::int`;
          await audit(tx, { actorId: user.id, action: `stability.excursion_${kind}`, objectType: 'stability_excursion', objectId: id, new: { event: ev!.id, ...body.data } });
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) { return fail(e, reply); }
    });
  }

  // ---- On-going stability (LIMS-27) ----
  app.get('/api/stability/ongoing', reader, async () => {
    const year = Number(today().slice(0, 4));
    const r = await app.links.truebatch.releasedSince(`${year}-01-01`);
    const protocols = await sql<{ productCode: string; pack: string }[]>`
      select doc->'header'->>'code' as "productCode", doc->'header'->>'containerClosure' as pack from master_versions
      where kind = 'protocol' and state = 'effective' and doc->'header'->>'of' = 'product' and doc->'header'->>'purpose' = 'ongoing'`;
    const studies = await sql<{ productCode: string; pack: string; studyNo: string }[]>`
      select s.item->>'code' as "productCode", v.doc->'header'->>'containerClosure' as pack, s.study_no as "studyNo"
      from stability_studies s join master_versions v on v.id = s.protocol_version_id
      where v.doc->'header'->>'purpose' = 'ongoing' and s.t0 >= ${`${year}-01-01`}::date`;
    const answers = await sql<{ productCode: string; pack: string; text: string; by: string }[]>`
      select a.product_code as "productCode", a.pack, a.text, u.full_name as by from stability_ongoing_answers a join users u on u.id = a.person_id where a.year = ${year}`;
    const released = r.state === 'ok' ? r.value.filter((b) => b.productCode).map((b) => ({ productCode: b.productCode!, productName: b.productName ?? '', batch: b.batchNumber })) : [];
    return { year, link: r.state, flags: ongoingFlags(released, protocols, studies, answers) };
  });

  // QA records why no on-going study was started this year for a product and pack (LIMS-27).
  app.post('/api/stability/ongoing', qa, async (req, reply) => {
    const body = z.object({ productCode: text(60), pack: text(200), text: text(1000) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', problems: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const year = Number(today().slice(0, 4));
    try {
      return await sql.begin(async (tx) => {
        const [a] = await tx<{ id: number }[]>`
          insert into stability_ongoing_answers (year, product_code, pack, text, person_id) values (${year}, ${body.data.productCode}, ${body.data.pack}, ${body.data.text}, ${req.user!.id})
          on conflict (year, product_code, pack) do nothing returning id::int`;
        if (!a) throw new StabilityError(409, 'already_answered', ['QA has already answered this flag for this year.']);
        await audit(tx, { actorId: req.user!.id, action: 'stability.ongoing_answered', objectType: 'stability_ongoing', objectId: a.id, new: { year, ...body.data } });
        return { ok: true, id: a.id };
      });
    } catch (e) { return fail(e, reply); }
  });

  // ---- Chamber capacity (plan 2b-6) ----
  app.get('/api/stability/capacity', reader, async () => {
    const now = today();
    const year = Number(now.slice(0, 4));
    const years = [1, 2, 3, 4, 5].map((n) => year + n);
    const studies = (await loadStudies(sql)).map((l) => ({ studyNo: l.s.studyNo, doc: l.s.protocol, t0: l.s.t0, cell: l.s.cell, events: l.events }));
    return { today: now, years, rows: capacity(studies, now, years) };
  });
}
