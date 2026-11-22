import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { usableItem } from '../master.js';
import { LOT_USABLE, LOT_WAITING, batchWaiting, type BatchRead, type LotRead } from '../links.js';
import { EDITION_NAME } from '../../shared/engine/links.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';
import { SAMPLING_DETAILS, identityContainers, limitFor, sampledProblem, samplingPlan, limitText, limitWords, outOfTrend, purposeLimits, sampleOnly, testApplies, type SpecDoc, type SpecTest } from '../../shared/master/spec.js';
import { OOT_ANSWERS, approvalProblems, ootRefusal, rejectionRefusal, sampleDecision, type TestState } from '../../shared/engine/sample.js';
import { oosOfSample } from './oos.js';
import { reducedState } from '../reduced.js';
import { loadReserves, openRetestSample, reserveNeed } from './reserve.js';
import { coaDoc } from '../coa.js';
import { render, sendPdf } from '../pdf.js';
import { sampleTestResults, type TestResult } from './analyses.js';
import { sampleTrend } from './trends.js';
import { loadForms } from './forms.js';
import {
  PROVIDER_NAME, SAMPLE_ACTIONS, SAMPLE_ACTION_NAMES, SAMPLE_PURPOSES, isHand, sampleRefusal, sampleStatus,
  type LinkState, type SampleAction, type SampleEvent, type SamplePurpose, type Source,
} from '../../shared/engine/index.js';
import { plantDate, plantTimesIn } from '../../shared/plant-time.js';
import { plantToday } from './inventory.js';

// Samples (LIMS-05, LIMS-07): registered from an MMS lot or a TrueBatch batch waiting to be sampled (pull, don't type),
// or by hand while that link is absent or down (then checked by a second person, LIMS-50); then received, stored or
// handed over, and disposed of, each an insert-only entry. The status is computed (shared/engine/sample.ts).

// Plant time zone: the sample number's year is the plant's year.
const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';
export const SAMPLE_PREFIX = 'LS';

type Of = 'material' | 'product';
// A monitoring sample (server/routes/em.ts) is of a room of master data or a water system (its itemId 'water:PW').
type From = 'mms' | 'truebatch';
const OF: Record<From, Of> = { mms: 'material', truebatch: 'product' };
export interface SampleItem { of: Of | 'room' | 'water'; itemId: string; code: string; name: string }
/** A monitoring sample: the plan version, point and sampling it was taken for, as taken (server/routes/em.ts). */
export interface MonitoringTaken {
  planVersionId: number; planMasterId: number; planNumber: string; planVersionNo: number; point: string; pointCode: string; pointName: string;
  sampling: string; kind: string; frequency: string; state: string | null; grade: string | null; critical: boolean; identify: string;
  testKey: string; limit: import('../../shared/master/schema.js').Limit | null; takenOn: string; shift: number | null; batch: string | null; person: string | null;
}
export interface SampleRow {
  id: number; sampleNo: string; specVersionId: number; purpose: SamplePurpose; lotNo: string; item: SampleItem; source: Source;
  quantity: string; containers: number | null; registeredBy: number; registeredByName: string; registeredAt: Date;
  // A stability sample: its study and time point (server/routes/stability.ts).
  stability?: { studyId: number; studyNo: string; condition: string; label: string; month: number } | null;
  monitoring?: MonitoringTaken | null;
  // LIMS-05: the sampling plan as applied (null: the specification names none).
  sampling?: SamplingTaken | null;
  // In-process: the TrueBatch lab request it was made from (server/routes/in-process.ts).
  request?: SampleRequest | null;
}
export interface SampleRequest { edition: string; requestId: string; batchNo: string; stageTitle: string | null; stepKey: string; stepTitle: string | null;
  tests: { name: string; label: string; unit: string | null; individual: number | null; code?: string | null }[]; requestedAt: string }
export interface SamplingTaken { received: number; plan: 'square root' | 'every container'; line: string; numbers: number[]; details: Record<string, string> }
export type EventRow = SampleEvent & { id: number; personName: string; at: Date; signature: { printedName: string; signedAt: Date; meaning: string } | null };

class SampleError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}

/** The effective specifications of a material (by its master-data id) or a product (by its code) (LIMS-01). */
export async function effectiveSpecs(q: Sql | Tx, of: Of, key: string) {
  return q<{ id: number; masterId: number; versionNo: number; header: SpecDoc['header'] }[]>`
    select id::int, master_id::int as "masterId", version_no as "versionNo", doc->'header' as header,
      jsonb_path_exists(doc, '$.tests[*] ? (@.identity == true)') as identity from master_versions
    where kind = 'spec' and state = 'effective' and doc->'header'->>'of' = ${of}
      and (case when ${of} = 'material' then doc->'header'->>'itemId' else doc->'header'->>'code' end) = ${key}
    order by doc->'header'->>'number', master_id`;
}
const specKey = (item: { of: Of; itemId: string; code: string }) => (item.of === 'material' ? item.itemId : item.code);

/** The release sample already registered for a lot or batch, if any. */
async function releaseSample(q: Sql | Tx, of: Of, lotNo: string) {
  const [r] = await q<{ sampleNo: string }[]>`
    select sample_no as "sampleNo" from samples where lot_no = ${lotNo} and item->>'of' = ${of} and purpose = 'release' order by id limit 1`;
  return r?.sampleNo ?? null;
}

/**
 * A material lot still waiting in MMS whose release sample QC has decided: MMS sent it back to QC (a new QC cycle), so it
 * is offered for a retest sample (LIMS-31); with the retest sample already registered and waiting for QC, if any.
 */
async function sentBack(q: Sql | Tx, lotNo: string): Promise<{ releaseDecided: boolean; retestNo: string | null }> {
  const [r] = await q<{ decided: boolean }[]>`
    select exists (select 1 from samples s join sample_events e on e.sample_id = s.id and e.kind in ('approved', 'rejected')
      where s.lot_no = ${lotNo} and s.item->>'of' = 'material' and s.purpose = 'release') as decided`;
  return { releaseDecided: !!r?.decided, retestNo: await openRetestSample(q, lotNo) };
}

export const lotShown = (l: LotRead) => `MMS lot ${l.lotNumber}: ${l.materialCode ?? '—'}, ${l.status.replaceAll('_', ' ')}, expiry ${l.expiryDate ? plantDate(l.expiryDate) : '—'}, retest ${l.retestDate ? plantDate(l.retestDate) : '—'}${l.stock ? `, ${l.stock} ${l.unit ?? ''} in stock`.trimEnd() : ''}`;
/** The analyses of the sample not yet reviewed, stopped or invalidated: they stand in the way of QC's decision. */
const openOf = (results: Awaited<ReturnType<typeof sampleTestResults>>): string[] =>
  [...new Set(Object.values(results).flat().filter((a) => 'analysisId' in a && (a.status === 'in progress' || a.status === 'complete')).map((a) => a.analysisNo))];
const reportedOn = (t: SpecTest, purpose: string, x: { value: string }): string => { try { return shownFigure(x.value, limitFor(t, purposeLimits(purpose))); } catch { return x.value; } };
export const batchShown = (b: BatchRead) => `${b.edition ? EDITION_NAME[b.edition] : 'TrueBatch'} batch ${b.batchNumber}: ${b.productCode ?? '—'}${b.productName ? ` ${b.productName}` : ''}, ${b.status.replaceAll('_', ' ').toLowerCase()}${b.completedAt ? `, completed ${plantTimesIn(b.completedAt)}` : ''}${b.quantity ? `, ${String(b.quantity).replace(/^\d{4,}/, (n) => Number(n).toLocaleString('en-US'))} made` : ''}`;

async function loadSample(q: Sql | Tx, id: number): Promise<{ s: SampleRow; events: EventRow[] } | null> {
  const [s] = await q<SampleRow[]>`
    select s.id::int, s.sample_no as "sampleNo", s.spec_version_id::int as "specVersionId", s.purpose, s.lot_no as "lotNo", s.item, s.source,
      s.quantity, s.containers, s.registered_by::int as "registeredBy", u.full_name as "registeredByName", s.registered_at as "registeredAt", s.stability, s.monitoring, s.sampling, s.request
    from samples s join users u on u.id = s.registered_by where s.id = ${id}`;
  if (!s) return null;
  const events = await q<EventRow[]>`
    select e.id::int, e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at,
      (select json_build_object('printedName', g.printed_name, 'signedAt', g.signed_at, 'meaning', g.meaning) from signatures g where g.object_type = 'sample_event' and g.object_id = e.id limit 1) as signature
    from sample_events e join users u on u.id = e.person_id where e.sample_id = ${id} order by e.id`;
  return { s, events: [...events] };
}
/** A sample's row as registered (labels, blank worksheets: server/routes/forms.ts). */
export const loadSampleRow = async (q: Sql | Tx, id: number) => (await loadSample(q, id))?.s ?? null;
const facts = (s: SampleRow) => ({ registeredBy: s.registeredBy, byHand: isHand(s.source) });
// What the signer of a disposal is shown: the sample as it stands, by its last entry (refused if anything was added since).
const sampleContent = (s: SampleRow, events: EventRow[]) => ({ sample: s.id, sampleNo: s.sampleNo, lotNo: s.lotNo, item: s.item.code, status: sampleStatus(facts(s), events), lastEvent: events.at(-1)?.id ?? 0 });
const sampleHash = (s: SampleRow, events: EventRow[]) => contentHash('sample', s.id, sampleContent(s, events));
// What QC signs at the decision: the sample by its last entry, and the results decided on (refused if any changed).
const decisionContent = (s: SampleRow, events: EventRow[], tests: ReturnType<typeof testStates>) =>
  ({ ...sampleContent(s, events), results: tests.filter((t) => t.applies).map((t) => t.decided) });
const decisionHash = (s: SampleRow, events: EventRow[], tests: ReturnType<typeof testStates>) => contentHash('sample_decision', s.id, decisionContent(s, events, tests));

const text = (max = 200) => z.string().trim().min(1).max(max);
const registerBody = z.object({
  source: z.enum(['mms', 'truebatch']),
  // The lot (MMS) or batch (TrueBatch) number.
  lotNumber: text(60).optional(),
  batchNumber: text(60).optional(),
  // Typed by hand while the link is absent or down: the item is then picked from master data.
  byHand: z.boolean().default(false),
  itemId: z.string().min(1).max(100).optional(),
  specVersionId: z.number().int().positive(),
  quantity: text(60).regex(/^\d+(\.\d+)?\s*\S.*$/, 'give the quantity with its unit, e.g. 120 g'),
  containers: z.number().int().min(1).max(100000).optional(),
  // LIMS-05: where the specification names a sampling plan: the containers received and the numbers of those sampled.
  received: z.number().int().min(1).max(100000).optional(),
  sampled: z.array(z.number().int()).max(100000).optional(),
  // A monitoring sample is taken from its plan (server/routes/em.ts), not registered.
  purpose: z.enum(SAMPLE_PURPOSES).default('release').refine((p) => p !== 'monitoring', 'an EM or water sample is taken from its monitoring plan')
    .refine((p) => p !== 'in_process', 'an in-process sample is made by picking its TrueBatch lab request'),
}).strict();
const ACTION_BODIES: Record<SampleAction, z.ZodTypeAny> = {
  check: z.object({}),
  receive: z.object({ condition: text(500) }),
  store: z.object({ where: text(200) }),
  'hand-over': z.object({ to: text(200) }),
  dispose: signBody.extend({ reason: text(500), method: text(200) }),
  note: z.object({ text: text(1000) }),
};

/**
 * The tests QC decides on (LIMS-11): each test of the sample's specification, whether it applies to the sample's
 * purpose, and its latest reviewed analysis with its result.
 */
import { reportedFigure, shownFigure } from '../coa.js';
export { reportedFigure };

export function testStates(spec: SpecDoc, purpose: string, results: Record<string, TestResult[]>, trend: Record<string, string> = {}, only?: readonly string[],
  containers: number | null = null): (TestState & { decided: Record<string, unknown> | null })[] {
  const on = purposeLimits(purpose);
  // LIMS-08: a starting material's identity, container by container (identityContainers).
  const perContainer = identityContainers(spec, purpose, containers);
  return spec.tests.map((t) => {
    const reviewed = (results[t.key] ?? []).filter((a) => a.status === 'reviewed');
    const each = perContainer !== null && t.identity
      ? Array.from({ length: perContainer }, (_, i) => reviewed.filter((a) => a.container === i + 1).at(-1)) : null;
    // Per container: the first that fails, else the last; the people and open deviations of all of them.
    const used = each?.filter((a): a is TestResult => !!a);
    const r0 = each ? used!.find((a) => a.result?.pass === false) ?? used!.at(-1) : reviewed.at(-1);
    const r = r0 && used?.length ? { ...r0, analysisNo: used.map((a) => a.analysisNo).join(', '), people: [...new Set(used.flatMap((a) => a.people))],
      openDeviations: used.reduce((n, a) => n + a.openDeviations, 0) } : r0;
    // As reported (rounded as the limit is written, like the certificate); a judgement is its word.
    const roundedOf = (x: NonNullable<TestResult['result']>) => { try { return x.value ? reportedFigure(x.value, x.unit, limitFor(t, on)) : x.shown; } catch { return `${x.value} ${x.unit}`.trim(); } };
    const shown = r?.result ? roundedOf(r.result) : undefined;
    // LIMS-25: within the limit but outside the spec's trend limit, or (a stability result, plan 2b-3) outside the
    // prediction interval of the earlier results (template L22), or breaking a Nelson rule on the control chart of the
    // earlier decided results (template L18): flagged (`trend`, from sampleTrend in server/routes/trends.ts).
    const oot = r?.result && r.result.pass !== false
      ? [t.trendLimit && outOfTrend(t, r.result.value, r.result.unit) ? `trend limit ${limitWords(t.trendLimit)}` : '', trend[t.key] ?? ''].filter(Boolean).join('; ') : '';
    return {
      // A monitoring sample is of one test of its specification: the one its plan's sampling names (LIMS-36).
      key: t.key, name: t.name, applies: testApplies(t, purpose, only),
      ...(each ? { containers: { of: perContainer!, missing: each.flatMap((a, i) => (a ? [] : [i + 1])) } } : {}),
      reviewed: r ? { analysisNo: r.analysisNo, hasResult: !!r.result, ...(r.result?.pass !== undefined ? { pass: r.result.pass } : {}), ...(shown ? { shown } : {}),
        people: r.people, openDeviations: r.openDeviations,
        ...(oot ? { outOfTrend: oot } : {}) } : null,
      // The result as it goes on the certificate and into result_v1.
      decided: r?.result ? { key: t.key, name: t.name, value: r.result.value, unit: r.result.unit, shown: r.result.shown, reported: r.result.value ? reportedFigure(r.result.value, r.result.unit, limitFor(t, on)) : r.result.shown, ...(r.result.pass !== undefined ? { pass: r.result.pass } : {}),
        limit: limitText(t, on), method: r.method, analysisNo: r.analysisNo, reviewedAt: r.reviewedAt,
        // result_v1's end: the units' results (BU, CU), what the figure is, the TrueBatch in-process field answered.
        ...(r.result.individual ? { individual: r.result.individual } : {}), ...(r.result.figure && r.result.figure !== 'result' ? { figure: r.result.figure } : {}),
        ...(t.ipcField ? { ipcField: t.ipcField } : {}),
        ...(each ? { containers: perContainer } : {}), ...(r.outside ? { outsideLab: r.outside.certificate ? `supplier's certificate (${r.outside.lab})` : r.outside.lab, report: { file: r.outside.fileName, sha256: r.outside.sha256 },
          ...(r.outside.certificate ? { certificate: { manufacturer: r.outside.lab } } : {}) } : {}) } : null,
    };
  });
}

/**
 * A new sample row with the next number of the plant year (never reused), audited: the one way a sample is made, by
 * registration, by a stability pull (server/routes/stability.ts, which names the study and time point) and by a
 * sampling of a monitoring plan (server/routes/em.ts, which names the plan, point and sampling).
 */
export async function newSample(tx: Tx, person: number, row: { specVersionId: number; purpose: SamplePurpose; lotNo: string; item: SampleItem; source: Source;
  quantity: string; containers: number | null; stability?: { studyId: number; studyNo: string; condition: string; label: string; month: number }; monitoring?: MonitoringTaken; sampling?: SamplingTaken;
  request?: SampleRequest }): Promise<{ id: number; sampleNo: string }> {
  const [c] = await tx<{ n: number; yy: string }[]>`
    insert into sample_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
    on conflict (year) do update set last_no = sample_counters.last_no + 1
    returning last_no as n, right(year::text, 2) as yy`;
  const sampleNo = `${SAMPLE_PREFIX}${c!.yy}${String(c!.n).padStart(5, '0')}`;
  const [s] = await tx<{ id: number }[]>`
    insert into samples (sample_no, spec_version_id, purpose, lot_no, item, source, quantity, containers, registered_by, stability, monitoring, sampling, request)
    values (${sampleNo}, ${row.specVersionId}, ${row.purpose}, ${row.lotNo}, ${tx.json(row.item as never)}, ${tx.json(row.source as never)}, ${row.quantity}, ${row.containers},
      ${person}, ${row.stability ? tx.json(row.stability as never) : null}, ${row.monitoring ? tx.json(row.monitoring as never) : null}, ${row.sampling ? tx.json(row.sampling as never) : null},
      ${row.request ? tx.json(row.request as never) : null})
    returning id::int`;
  await audit(tx, { actorId: person, action: 'sample.registered', objectType: 'sample', objectId: s!.id, new: { sampleNo, ...row } });
  return { id: s!.id, sampleNo };
}

export function sampleRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.sample.register', 'lims.view') };
  const register = { preHandler: requirePermission('lims.sample.register') };

  // The lots and batches waiting to be sampled, each with its effective specification (or why none) and its release
  // sample if one is registered; and each link's state.
  app.get('/api/sample-requests', register, async () => {
    const [lots, batches] = await Promise.all([app.links.mms.waiting(), app.links.truebatch.waiting()]);
    const requests = [];
    if (lots.state === 'ok') for (const l of lots.value) {
      const item = { of: 'material' as const, itemId: l.materialMasterId ?? '', code: l.materialCode ?? '' };
      const specs = l.materialMasterId ? await effectiveSpecs(sql, 'material', l.materialMasterId) : [];
      requests.push({ source: 'mms' as const, lotNo: l.lotNumber, ...item, name: specs[0]?.header.name ?? null, status: l.status, shown: lotShown(l), asOf: l.dataAsOf,
        stock: l.stock ? `${l.stock} ${l.unit ?? ''}`.trim() : null, specs: specs.map(({ header, ...x }) => ({ ...x, number: header.number, type: header.type, market: header.market ?? null, sampling: header.sampling ?? null })),
        noSpec: specs.length ? null : `No effective specification for ${l.materialCode ?? 'this material'}.`, sampleNo: await releaseSample(sql, 'material', l.lotNumber),
        // LIMS-31: a lot MMS sent back to QC (quarantine again after QC decided its release sample) is sampled again for retest.
        ...(await sentBack(sql, l.lotNumber)) });
    }
    if (batches.state === 'ok') for (const b of batches.value) {
      const specs = b.productCode ? await effectiveSpecs(sql, 'product', b.productCode) : [];
      requests.push({ source: 'truebatch' as const, lotNo: b.batchNumber, of: 'product' as const, itemId: null, code: b.productCode ?? '', name: b.productName ?? specs[0]?.header.name ?? null,
        status: b.status, shown: batchShown(b), asOf: b.dataAsOf, stock: b.quantity,
        specs: specs.map(({ header, ...x }) => ({ ...x, number: header.number, type: header.type, market: header.market ?? null, sampling: header.sampling ?? null })),
        noSpec: specs.length ? null : `No effective specification for ${b.productCode ?? 'this product'}.`, sampleNo: await releaseSample(sql, 'product', b.batchNumber) });
    }
    return { links: { mms: lots.state, truebatch: batches.state } satisfies Record<From, LinkState>, requests };
  });

  // The effective specifications of a material or product, for registering by hand.
  app.get<{ Querystring: { of?: string; itemId?: string } }>('/api/sample-specs', register, async (req) => {
    const of: Of = req.query.of === 'product' ? 'product' : 'material';
    const id = String(req.query.itemId ?? '');
    const item = of === 'product' ? (await app.master.products()).find((p) => p.itemId === id) : (await app.master.materials()).find((m) => m.itemId === id);
    if (!item) return [];
    return (await effectiveSpecs(sql, of, of === 'material' ? item.itemId : item.code)).map(({ header, ...x }) => ({ ...x, number: header.number, type: header.type, market: header.market ?? null, sampling: header.sampling ?? null }));
  });

  // Register a sample (LIMS-05): from a lot or batch waiting now, or by hand while its link is absent or down.
  app.post('/api/samples', register, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    const b = parsed.data;
    const user = req.user!;
    const lotNo = b.source === 'mms' ? b.lotNumber : b.batchNumber;
    const of = OF[b.source];
    const name = PROVIDER_NAME[b.source];
    const what = b.source === 'mms' ? 'lot' : 'batch';
    try {
      if (!lotNo) throw new SampleError(400, 'invalid', [`Give the ${what} number.`]);
      // 1. the lot or batch, read now through its link
      const read = b.source === 'mms' ? await app.links.mms.lot(lotNo) : await app.links.truebatch.batch(lotNo);
      let item: SampleItem & { of: Of };
      let source: Source;
      if (b.byHand) {
        if (read.state === 'ok') throw new SampleError(409, 'link_ok', [`${name} answers: register the ${what} from the list of those waiting to be sampled.`]);
        if (!b.itemId) throw new SampleError(400, 'invalid', [`Pick the ${of} from master data.`]);
        const m = of === 'material' ? usableItem(await app.master.materials(), b.itemId, 'material') : usableItem(await app.master.products(), b.itemId, 'product');
        item = { of, itemId: m.itemId, code: m.code, name: m.name };
        source = { from: 'hand', link: b.source, state: read.state };
      } else {
        if (read.state !== 'ok') throw new SampleError(409, 'link_off', [`${name} ${read.state === 'down' ? 'does not answer' : 'is not linked'} now: register the sample by hand; a second person checks it.`]);
        if (b.source === 'mms') {
          const l = read.value as LotRead | null;
          if (!l) throw new SampleError(409, 'not_found', [`Lot ${lotNo} is not in MMS.`]);
          // LIMS-31: a retest sample may also be of a released lot (by its retest date); any other only of a lot waiting to be sampled.
          if (!LOT_WAITING.includes(l.status) && !(b.purpose === 'retest' && LOT_USABLE.includes(l.status))) throw new SampleError(409, 'not_waiting', [b.purpose === 'retest'
            ? `Lot ${lotNo} is ${l.status.replaceAll('_', ' ')} in MMS: only a released lot, or one waiting to be sampled, is retested.`
            : `Lot ${lotNo} is ${l.status.replaceAll('_', ' ')} in MMS: only a lot in quarantine or under test waits to be sampled.`]);
          if (!l.materialMasterId) throw new SampleError(409, 'not_found', [`MMS names no material for lot ${lotNo}.`]);
          const m = usableItem(await app.master.materials(), l.materialMasterId, 'material');
          item = { of, itemId: m.itemId, code: m.code, name: m.name };
          source = { from: 'mms', asOf: l.dataAsOf, shown: lotShown(l) };
        } else {
          const t = read.value as BatchRead | null;
          if (!t) throw new SampleError(409, 'not_found', [`Batch ${lotNo} is not in TrueBatch.`]);
          if (!batchWaiting(t)) throw new SampleError(409, 'not_waiting', [`Batch ${lotNo} is ${t.released ? 'already released' : t.status.toLowerCase().replaceAll('_', ' ')} in TrueBatch: a batch is sampled from production until it is released, never when rejected.`]);
          const m = (await app.master.products()).find((p) => p.code === t.productCode);
          if (!m) throw new SampleError(409, 'unknown_item', [`Product ${t.productCode ?? '—'} of batch ${lotNo} is not in master data.`]);
          const ok = usableItem([m], m.itemId, 'product');
          item = { of, itemId: ok.itemId, code: ok.code, name: ok.name };
          source = { from: 'truebatch', asOf: t.dataAsOf, shown: batchShown(t) };
        }
      }
      return await sql.begin(async (tx) => {
        // One registration of a lot or batch at a time.
        await tx`select pg_advisory_xact_lock(hashtext(${`sample:${of}:${lotNo}`}))`;
        // 2. LIMS-01: the specification version effective now for this item
        const specs = await effectiveSpecs(tx, of, specKey(item));
        if (!specs.length) throw new SampleError(409, 'no_spec', [`No effective specification for ${item.code}: a sample is tested against the effective version only.`]);
        if (!specs.some((x) => x.id === b.specVersionId)) throw new SampleError(409, 'not_effective', [`That specification version is not the effective one for ${item.code}: pick ${specs.map((x) => `${x.header.number} version ${x.versionNo}`).join(' or ')}.`]);
        // 3. one release sample per lot or batch
        const twice = b.purpose === 'release' ? await releaseSample(tx, of, lotNo) : null;
        if (twice) throw new SampleError(409, 'already_sampled', [`${what === 'lot' ? 'Lot' : 'Batch'} ${lotNo} already has its release sample ${twice}.`]);
        // LIMS-31: one retest sample of a lot at a time, until QC decides on it
        const retest = b.purpose === 'retest' && of === 'material' ? await openRetestSample(tx, lotNo) : null;
        if (retest) throw new SampleError(409, 'already_sampled', [`Lot ${lotNo} already has its retest sample ${retest}, waiting for QC's decision.`]);
        // LIMS-05: the specification's sampling plan (LIMS-08: every container of a starting material with an identity
        // test): the containers received give the number to sample (L19); the sampler confirms the numbers sampled.
        const [spec] = await tx<{ doc: SpecDoc }[]>`select doc from master_versions where id = ${b.specVersionId}`;
        let containers = b.containers ?? null;
        let sampling: SamplingTaken | undefined;
        if (samplingPlan(spec!.doc, b.purpose, 1) !== null) {
          if (!b.received) throw new SampleError(400, 'containers_needed', ['Containers received: give their number. The specification\'s sampling plan says how many of them are sampled'
            + `${identityContainers(spec!.doc, b.purpose, 1) !== null ? ' (every container: the identity of a starting material is tested on each)' : ''}.`]);
          const p = samplingPlan(spec!.doc, b.purpose, b.received)!;
          if ('problem' in p) throw new SampleError(400, 'invalid', [p.problem]);
          const numbers = [...(b.sampled ?? [])].sort((x, y) => x - y);
          const no = sampledProblem(numbers, p.n, b.received);
          if (no) throw new SampleError(400, 'sampled', [no]);
          containers = p.n;
          const h = spec!.doc.header.sampling;
          sampling = { received: b.received, plan: p.mode, line: p.line, numbers,
            details: Object.fromEntries(SAMPLING_DETAILS.flatMap(([k]) => (h?.[k] ? [[k, h[k]!]] : []))) };
        }
        // 4. the number and the row (5. audit)
        return newSample(tx, user.id, { specVersionId: b.specVersionId, purpose: b.purpose, lotNo, item, source, quantity: b.quantity, containers, ...(sampling ? { sampling } : {}) });
      });
    } catch (e) {
      if (e instanceof SampleError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
      throw e;
    }
  });

  // The samples, newest first, with their computed status.
  app.get('/api/samples', reader, async () => {
    const rows = await sql<(Omit<SampleRow, 'source'> & { byHand: boolean; specNumber: string; specVersionNo: number })[]>`
      select s.id::int, s.sample_no as "sampleNo", s.spec_version_id::int as "specVersionId", s.purpose, s.lot_no as "lotNo", s.item,
        s.source->>'from' = 'hand' as "byHand", s.quantity, s.containers, s.registered_by::int as "registeredBy", u.full_name as "registeredByName",
        s.registered_at as "registeredAt", v.doc->'header'->>'number' as "specNumber", v.version_no as "specVersionNo"
      from samples s join users u on u.id = s.registered_by join master_versions v on v.id = s.spec_version_id
      order by s.id desc limit 1000`;
    const events = rows.length ? await sql<(SampleEvent & { sampleId: number })[]>`
      select sample_id::int as "sampleId", kind, payload, person_id::int as person from sample_events where sample_id = any(${rows.map((r) => r.id)}) order by id` : [];
    return rows.map((r) => { const ev = events.filter((e) => e.sampleId === r.id); return { ...r, status: sampleStatus(r, ev), decision: sampleDecision(ev) }; });
  });

  // One sample with its specification, its chain of custody (LIMS-07), its status and what this person may do next.
  app.get<{ Params: { id: string } }>('/api/samples/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadSample(sql, id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const [v] = await sql<{ id: number; masterId: number; versionNo: number; state: string; doc: SpecDoc }[]>`
      select id::int, master_id::int as "masterId", version_no as "versionNo", state, doc from master_versions where id = ${l.s.specVersionId}`;
    const results = await sampleTestResults(sql, l.s.id, app);
    const trend = v ? await sampleTrend(sql, l.s, v.doc, results) : {};
    const oos = await oosOfSample(sql, l.s.id);
    // A monitoring or in-process sample is tested by its own test's method only (sampleOnly).
    const only = v ? sampleOnly(v.doc, l.s) : undefined;
    const methodIds = [...new Set((v?.doc.tests ?? []).filter((t) => !only || only.includes(t.key)).filter((t) => t.use === 'release and stability' || t.use === purposeLimits(l.s.purpose)).map((t) => t.method.masterId))];
    const methods = methodIds.length ? await sql<{ versionId: number; masterId: number; versionNo: number; code: string; name: string }[]>`
      select id::int as "versionId", master_id::int as "masterId", version_no as "versionNo", doc->'header'->>'code' as code, doc->'header'->>'name' as name
      from master_versions where kind = 'method' and state = 'effective' and master_id = any(${methodIds}) order by doc->'header'->>'code'` : [];
    const user = req.user!;
    // LIMS-30: a release sample's reserve sample (its lot's), and what the decision needs of it.
    const release = l.s.purpose === 'release';
    const [reserve] = release ? await loadReserves(sql, plantToday(new Date()), { sampleId: l.s.id }) : [];
    const need = release && v ? await reserveNeed(sql, l.s.id, v.doc) : undefined;
    const may = user.permissions.includes('lims.sample.register');
    const refusals = Object.fromEntries(SAMPLE_ACTION_NAMES.map((a) => [a, may ? sampleRefusal(a, facts(l.s), l.events, user.id) : 'You do not have the right to record sample entries.']));
    return {
      sample: l.s, status: sampleStatus(facts(l.s), l.events), events: l.events,
      spec: v ? { id: v.id, masterId: v.masterId, versionNo: v.versionNo, state: v.state, header: v.doc.header,
        // Each test with whether it applies to this sample's purpose, and its analyses with their results (LIMS-11).
        tests: v.doc.tests.map((t) => ({ ...t, applies: testApplies(t, l.s.purpose, sampleOnly(v.doc, l.s)),
          analyses: (results[t.key] ?? []).map((a) => (a.result?.value ? { ...a, result: { ...a.result, reported: reportedOn(t, l.s.purpose, a.result) } } : a)) })) } : null,
      // The methods this sample's tests are done by: their effective versions, to start an analysis from.
      methods,
      actions: SAMPLE_ACTION_NAMES.filter((a) => refusals[a] === null), refusals, contentHash: sampleHash(l.s, l.events),
      // QC's decision (LIMS-20): made, or what stands in the way of approval for this person.
      // LIMS-23, LIMS-25: the OOS of the sample, and the tests whose reviewed result is out of trend (answered or not).
      oos, oot: v ? testStates(v.doc, l.s.purpose, results, trend, sampleOnly(v.doc, l.s), l.s.containers).flatMap((t) => (t.reviewed?.outOfTrend ? [{ key: t.key, name: t.name, analysisNo: t.reviewed.analysisNo, shown: t.reviewed.shown ?? '',
        trend: t.reviewed.outOfTrend, answer: l.events.find((e) => e.kind === 'oot_answered' && e.payload.test === t.key && e.payload.analysisNo === t.reviewed!.analysisNo) ?? null }] : [])) : [],
      ootRefusal: user.permissions.includes('lims.qc.approve') ? null : 'Answering an out-of-trend flag needs the QC approval permission.',
      decision: sampleDecision(l.events), decisionHash: v ? decisionHash(l.s, l.events, testStates(v.doc, l.s.purpose, results, trend, sampleOnly(v.doc, l.s), l.s.containers)) : null,
      approvalProblems: !v ? ['The sample has no specification.'] : !user.permissions.includes('lims.qc.approve') ? ['QC approval needs the QC approval permission.']
        : approvalProblems(facts(l.s), l.events, testStates(v.doc, l.s.purpose, results, trend, sampleOnly(v.doc, l.s), l.s.containers), user.id, oos, need, openOf(results)),
      // LIMS-30: the reserve sample (null: none logged), and what the decision says when the specification names no quantity.
      reserve: reserve ? { id: reserve.row.id, amount: reserve.row.amount, unit: reserve.row.unit, location: reserve.row.location, keptUntil: reserve.row.keptUntil, state: reserve.state } : null,
      reserveRequired: v?.doc.header.reserveQuantity ?? null,
      // LIMS-08: the containers each identity test is done on (null: once); LIMS-54: the blank worksheets issued for it.
      identityContainers: v ? identityContainers(v.doc, l.s.purpose, l.s.containers) : null,
      forms: await loadForms(sql, { sampleId: l.s.id }),
      reserveNote: release && v && !need?.required ? 'The specification names no reserve quantity: the reserve sample is not checked at approval.' : null,
      rejectionRefusal: user.permissions.includes('lims.qc.approve') ? rejectionRefusal(l.events) : 'Rejection needs the QC approval permission.',
      // LIMS-09: tested on the supplier's certificate (recorded), or why not now; offered only when the specification allows it.
      reducedTesting: v?.doc.header.reducedTesting && release ? await (async () => {
        const recorded = l.events.find((e) => e.kind === 'reduced_testing') ?? null;
        const st = await reducedState(sql, app, l.s, v.doc, sampleDecision(l.events), !!recorded, plantToday(new Date()));
        return { recorded, problems: user.permissions.includes('lims.qc.approve') ? st.problems : ['Reduced testing is recorded by QC with the QC approval permission.', ...st.problems], basis: st.basis,
          interval: v.doc.header.reducedTesting };
      })() : null,
    };
  });

  // LIMS-09: QC records that this release sample's lot is tested on the supplier's certificate, when the pulled facts
  // allow it (shared/engine/reduced.ts); the basis as read now is kept with the entry.
  app.post<{ Params: { id: string } }>('/api/samples/:id/reduced-testing', { preHandler: requirePermission('lims.qc.approve') }, async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return reply.code(404).send({ error: 'not_found' });
    const user = req.user!;
    try {
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`sample-entry:${id}`}))`;
        const l = await loadSample(tx, id);
        if (!l) throw new SampleError(404, 'not_found');
        const [v] = await tx<{ doc: SpecDoc }[]>`select doc from master_versions where id = ${l.s.specVersionId}`;
        const st = await reducedState(tx, app, l.s, v!.doc, sampleDecision(l.events), l.events.some((e) => e.kind === 'reduced_testing'), plantToday(new Date()));
        if (st.problems.length || !st.basis) throw new SampleError(409, 'not_allowed_now', st.problems.length ? st.problems : ['The supplier of the lot is not known.']);
        const [ev] = await tx<{ id: number }[]>`
          insert into sample_events (sample_id, kind, payload, person_id) values (${id}, 'reduced_testing', ${tx.json(st.basis as never)}, ${user.id}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'sample.reduced_testing', objectType: 'sample', objectId: id, new: { event: ev!.id, ...st.basis } });
        return { ok: true, eventId: ev!.id, basis: st.basis };
      });
    } catch (e) {
      if (e instanceof SampleError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
      throw e;
    }
  });

  // One route per entry, each in the same steps: read the sample and its entries, check the order and the person, insert
  // the entry (and sign a disposal), audit.
  for (const action of SAMPLE_ACTION_NAMES) {
    const kind = SAMPLE_ACTIONS[action];
    app.post<{ Params: { id: string } }>(`/api/samples/:id/${action}`, register, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = ACTION_BODIES[action].safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
      const { proof, contentHash: shown, ...payload } = body.data as { proof?: string; contentHash?: string } & SampleEvent['payload'];
      const user = req.user!;
      try {
        const signer = action === 'dispose' ? await authenticateSigner(sql, app.proofKey, user, { proof: proof! }, { objectType: 'sample', objectId: id, meaning: 'disposed' }) : null;
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`sample-entry:${id}`}))`;
          const l = await loadSample(tx, id);
          if (!l) throw new SampleError(404, 'not_found');
          const no = sampleRefusal(action, facts(l.s), l.events, user.id);
          if (no) throw new SampleError(action === 'check' && no.startsWith('The person') ? 403 : 409, 'not_allowed_now', [no]);
          if (signer && shown !== sampleHash(l.s, l.events)) throw new SampleError(409, 'content_changed', ['The sample changed since you opened it.']);
          const [ev] = await tx<{ id: number }[]>`
            insert into sample_events (sample_id, kind, payload, person_id) values (${id}, ${kind}, ${tx.json(payload)}, ${user.id}) returning id::int`;
          if (signer) {
            const content = { ...sampleContent(l.s, l.events), action, ...payload };
            await sign(tx, { signer, objectType: 'sample_event', objectId: ev!.id, meaning: 'disposed', content, shownHash: contentHash('sample_event', ev!.id, content) });
          }
          await audit(tx, { actorId: user.id, action: `sample.${kind}`, objectType: 'sample', objectId: id, old: { status: sampleStatus(facts(l.s), l.events) },
            new: { event: ev!.id, ...payload }, reason: payload.reason ?? null });
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) {
        if (e instanceof SampleError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
        if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
        throw e;
      }
    });
  }

  // QC's decision (LIMS-20): approval, with the next CoA number (LIMS-21), only when every test that applies has a
  // reviewed result within its limit; rejection at any time with its reason. Both are e-signatures; the results decided
  // on are kept with the decision (published in result_v1, coa_v1).
  for (const decision of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/api/samples/:id/${decision}`, { preHandler: requirePermission('lims.qc.approve') }, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = (decision === 'reject' ? signBody.extend({ reason: text(1000) }) : signBody).safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
      const b = body.data as { proof: string; contentHash: string; reason?: string };
      const user = req.user!;
      const meaning = decision === 'approve' ? 'qc_approved' : 'rejected';
      try {
        const signer = await authenticateSigner(sql, app.proofKey, user, { proof: b.proof }, { objectType: 'sample', objectId: id, meaning });
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`sample-entry:${id}`}))`;
          const l = await loadSample(tx, id);
          if (!l) throw new SampleError(404, 'not_found');
          const [v] = await tx<{ doc: SpecDoc }[]>`select doc from master_versions where id = ${l.s.specVersionId}`;
          const sampleResults = await sampleTestResults(tx, id, app);
          const tests = testStates(v!.doc, l.s.purpose, sampleResults, await sampleTrend(tx, l.s, v!.doc, sampleResults), sampleOnly(v!.doc, l.s), l.s.containers);
          const need = l.s.purpose === 'release' ? await reserveNeed(tx, id, v!.doc) : undefined;
          const problems = decision === 'approve' ? approvalProblems(facts(l.s), l.events, tests, user.id, await oosOfSample(tx, id), need, openOf(sampleResults)) : [rejectionRefusal(l.events)].filter((x): x is string => !!x);
          if (problems.length) throw new SampleError(problems.some((p) => p.includes('another person approves')) ? 403 : 409, 'not_ready', problems);
          if (b.contentHash !== decisionHash(l.s, l.events, tests)) throw new SampleError(409, 'content_changed', ['The sample or its results changed since you opened it.']);
          let coaNo: string | undefined;
          if (decision === 'approve' && l.s.purpose === 'in_process') {
            // In-process: an in-process test report number, not a certificate (owner 19 Nov 2026).
            const [c] = await tx<{ n: number; yy: string }[]>`
              insert into ipr_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
              on conflict (year) do update set last_no = ipr_counters.last_no + 1 returning last_no as n, right(year::text, 2) as yy`;
            coaNo = `IPR${c!.yy}${String(c!.n).padStart(5, '0')}`;
          } else if (decision === 'approve') {
            const [c] = await tx<{ n: number; yy: string }[]>`
              insert into coa_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
              on conflict (year) do update set last_no = coa_counters.last_no + 1 returning last_no as n, right(year::text, 2) as yy`;
            coaNo = `COA${c!.yy}${String(c!.n).padStart(5, '0')}`;
          }
          // In-process: each result names the TrueBatch field it fills (the request test its code matches).
          const field = (code: unknown) => l.s.request?.tests.find((x) => (x.code || x.name) === code)?.name;
          const results = tests.filter((t) => t.decided).map((t) => (t.decided!.ipcField && field(t.decided!.ipcField) ? { ...t.decided, ipcName: field(t.decided!.ipcField) } : t.decided));
          const payload = { ...(coaNo ? { coaNo } : {}), ...(b.reason ? { reason: b.reason } : {}), results };
          const [ev] = await tx<{ id: number }[]>`
            insert into sample_events (sample_id, kind, payload, person_id) values (${id}, ${decision === 'approve' ? 'approved' : 'rejected'}, ${tx.json(payload as never)}, ${user.id}) returning id::int`;
          const content = { ...decisionContent(l.s, l.events, tests), decision, ...(coaNo ? { coaNo } : {}), ...(b.reason ? { reason: b.reason } : {}) };
          await sign(tx, { signer, objectType: 'sample_event', objectId: ev!.id, meaning, content, shownHash: contentHash('sample_event', ev!.id, content) });
          await audit(tx, { actorId: user.id, action: `sample.${decision === 'approve' ? 'approved' : 'rejected'}`, objectType: 'sample', objectId: id, new: { event: ev!.id, ...payload }, reason: b.reason ?? null });
          return { ok: true, eventId: ev!.id, ...(coaNo ? { coaNo } : {}) };
        });
      } catch (e) {
        if (e instanceof SampleError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
        if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
        throw e;
      }
    });
  }

  // LIMS-25: QC answers the out-of-trend flag of a test's reviewed result: no action, or an investigation, with the reason.
  app.post<{ Params: { id: string } }>('/api/samples/:id/oot', { preHandler: requirePermission('lims.qc.approve') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const body = z.object({ test: z.string().min(1).max(60), answer: z.enum(OOT_ANSWERS), reason: text(1000) }).strict().safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    const user = req.user!;
    try {
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`sample-entry:${id}`}))`;
        const l = await loadSample(tx, id);
        if (!l) throw new SampleError(404, 'not_found');
        const [v] = await tx<{ doc: SpecDoc }[]>`select doc from master_versions where id = ${l.s.specVersionId}`;
        const results = await sampleTestResults(tx, id, app);
        const tests = testStates(v!.doc, l.s.purpose, results, await sampleTrend(tx, l.s, v!.doc, results), sampleOnly(v!.doc, l.s), l.s.containers);
        const no = ootRefusal(l.events, tests, body.data.test);
        if (no) throw new SampleError(409, 'not_allowed_now', [no]);
        const payload = { test: body.data.test, analysisNo: tests.find((t) => t.key === body.data.test)!.reviewed!.analysisNo, answer: body.data.answer, reason: body.data.reason };
        const [ev] = await tx<{ id: number }[]>`
          insert into sample_events (sample_id, kind, payload, person_id) values (${id}, 'oot_answered', ${tx.json(payload)}, ${user.id}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'sample.oot_answered', objectType: 'sample', objectId: id, new: { event: ev!.id, ...payload }, reason: payload.reason });
        return { ok: true, eventId: ev!.id };
      });
    } catch (e) {
      if (e instanceof SampleError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
      throw e;
    }
  });

  // LIMS-21: the certificate of analysis of an approved sample, as a PDF: only the reviewed results decided on.
  app.get<{ Params: { id: string } }>('/api/samples/:id/coa', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadSample(sql, id);
    const approved = l?.events.find((e) => e.kind === 'approved');
    if (!l || !approved) return reply.code(404).send({ error: 'not_found', message: 'A certificate is issued only for an approved sample.' });
    const [v] = await sql<{ versionNo: number; doc: SpecDoc }[]>`select version_no as "versionNo", doc from master_versions where id = ${l.s.specVersionId}`;
    const def = coaDoc({ sample: l.s, spec: v!.doc, specVersion: v!.versionNo, decision: approved }, req.user!.fullName, new Date(), app.demo);
    return sendPdf(reply, `coa-${String(approved.payload.coaNo ?? l.s.sampleNo)}`, await render(def));
  });

}
