import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';
import { loadAnalysis, sampleTestResults } from './analyses.js';
import { c1WithinLimits } from '../../shared/templates/index.js';
import { limitFor, limitText, purposeLimits, type SpecDoc } from '../../shared/master/spec.js';
import { reportedFigure, shownFigure } from '../coa.js';
import { analysisView, openSteps } from '../../shared/engine/index.js';
import {
  OOS_ACTIONS, OOS_ACTION_NAMES, OOS_CHECKLIST, checklistProblems, oosClosed, oosRefusal, oosStatus, phase1Conclusion, phase2, plans, retestRefusal, retests,
  type DeviationNow, type OosAction, type OosFacts, type OosEvent, type OosPayload, type OosStatus,
} from '../../shared/engine/oos.js';
import type { SampleOos } from '../../shared/engine/sample.js';

// OOS investigations (LIMS-23, LIMS-24, LIMS-48): opened at once by the signature that gave an out-of-limit result of a
// spec test; then phase I in LIMS, phase II in Deviations, concluded by QA. The status is computed (shared/engine/oos.ts).

const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';
export const OOS_PREFIX = 'OOS';

class OosError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}

// The result as recorded when the OOS opened: the test's name and limit, the value as worked out, and the step.
// shown: the value with its unit; line: the check as the analysis shows it ("7.4; limit 5.0 to 7.0: OUT OF LIMITS …").
export interface OosResult { name: string; value: string; unit: string; shown: string; line: string; limit: string; step: string }

/**
 * LIMS-23: opens an OOS for each spec test the analysis covers whose result step is now signed and out of its limit;
 * one per analysis and test, in the transaction of the signature (the caller holds the analysis's lock).
 */
export async function openOos(tx: Tx, analysisId: number, person: number): Promise<void> {
  const l = await loadAnalysis(tx, analysisId);
  if (!l?.sample) return;
  const { steps } = openSteps(l.doc, l.events, l.now);
  for (const t of l.sample.tests) {
    const [sk, tk, name] = t.result.split('/') as [string, string, string];
    const at = steps.filter((x) => x.stageKey === sk && x.stepKey === tk && ['done', 'done_awaiting_check', 'checked'].includes(x.state)).at(-1);
    const r = at?.results[name];
    // A repeat-until round whose stop check has not passed yet is "not yet", not out of limits.
    if (!at || at.notYet === name || !r?.ok || r.check?.pass !== false) continue;
    if ((await tx`select 1 from oos where analysis_id = ${analysisId} and test_key = ${t.key}`).length) continue;
    const [c] = await tx<{ n: number; yy: string }[]>`
      insert into oos_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
      on conflict (year) do update set last_no = oos_counters.last_no + 1 returning last_no as n, right(year::text, 2) as yy`;
    const oosNo = `${OOS_PREFIX}${c!.yy}${String(c!.n).padStart(4, '0')}`;
    // The value as reported (rounded as the limit is written, LIMS-15); the full value stays in `value` and the line.
    const text = typeof r.text === 'string' ? r.text : null;   // a judgement (L35): its word, no number
    const result: OosResult = { name: t.name, value: text ? '' : r.value, unit: text ? '' : r.unit, shown: text ?? shownOf(r.value, r.unit, limitFor(t, purposeLimits(l.sample.purpose))), line: r.shown, limit: limitText(t, purposeLimits(l.sample.purpose)), step: at.id };
    const [o] = await tx<{ id: number }[]>`
      insert into oos (oos_no, sample_id, analysis_id, test_key, result, opened_by)
      values (${oosNo}, ${l.sample.id}, ${analysisId}, ${t.key}, ${tx.json(result as never)}, ${person}) returning id::int`;
    await audit(tx, { actorId: person, action: 'oos.opened', objectType: 'oos', objectId: o!.id, new: { oosNo, sample: l.sample.sampleNo, analysis: l.analysis.analysisNo, test: t.key, ...result } });
  }
}

/**
 * LIMS-22, LIMS-23: opens the OOS of an outside lab's result out of its limit, when a second person has checked it
 * against the report (the moment it counts, as a signed step does for the lab's own). Once per outside result.
 */
export async function openOutsideOos(tx: Tx, o: { id: number; sampleId: number; testKey: string; testName: string; limit: string; value: string; unit: string; line: string; reportNo: string }, person: number): Promise<string> {
  const [c] = await tx<{ n: number; yy: string }[]>`
    insert into oos_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
    on conflict (year) do update set last_no = oos_counters.last_no + 1 returning last_no as n, right(year::text, 2) as yy`;
  const oosNo = `${OOS_PREFIX}${c!.yy}${String(c!.n).padStart(4, '0')}`;
  const result: OosResult = { name: o.testName, value: o.value, unit: o.unit, shown: `${o.value} ${o.unit}`.trim(), line: o.line, limit: o.limit, step: `outside lab report ${o.reportNo}` };
  const [r] = await tx<{ id: number }[]>`
    insert into oos (oos_no, sample_id, outside_result_id, test_key, result, opened_by)
    values (${oosNo}, ${o.sampleId}, ${o.id}, ${o.testKey}, ${tx.json(result as never)}, ${person}) returning id::int`;
  await audit(tx, { actorId: person, action: 'oos.opened', objectType: 'oos', objectId: r!.id, new: { oosNo, outsideResult: o.id, report: o.reportNo, test: o.testKey, ...result } });
  return oosNo;
}

type Row = { id: number; oosNo: string; sampleId: number; analysisId: number | null; outsideResultId: number | null; testKey: string; result: OosResult; openedBy: number; openedByName: string; openedAt: Date;
  sampleNo: string; lotNo: string; purpose: string; item: { of: string; code: string; name: string }; duringBatch: string | null; analysisNo: string; spec: SpecDoc; specNumber: string; specVersionNo: number };
type EventRow = OosEvent & { personName: string; at: Date; signature: { printedName: string; meaning: string; signedAt: Date } | null };

/** The result as reported: rounded half up as the limit is written (an OOS opened before this kept the full value). */
const shownOf = (value: string, unit: string, limit: Parameters<typeof reportedFigure>[2]) => {
  try { return value ? reportedFigure(value, unit, limit) : `${value} ${unit}`.trim(); } catch { return `${value} ${unit}`.trim(); }
};
const rounded = (r: Row): Row => {
  const t = r.spec.tests.find((x) => x.key === r.testKey);
  return t && r.result.value ? { ...r, result: { ...r.result, shown: shownOf(r.result.value, r.result.unit, limitFor(t, purposeLimits(r.purpose))) } } : r;
};
const ROW = (q: Sql | Tx) => q`
  select o.id::int, o.oos_no as "oosNo", o.sample_id::int as "sampleId", o.analysis_id::int as "analysisId", o.outside_result_id::int as "outsideResultId", o.test_key as "testKey", o.result,
    o.opened_by::int as "openedBy", u.full_name as "openedByName", o.opened_at as "openedAt", s.sample_no as "sampleNo", s.lot_no as "lotNo", s.purpose, s.item,
    s.monitoring->>'batch' as "duringBatch",
    coalesce(a.analysis_no, x.report_no) as "analysisNo", v.doc as spec, v.doc->'header'->>'number' as "specNumber", v.version_no as "specVersionNo"
  from oos o join users u on u.id = o.opened_by join samples s on s.id = o.sample_id left join analyses a on a.id = o.analysis_id
  left join outside_results x on x.id = o.outside_result_id
  join master_versions v on v.id = s.spec_version_id`;

async function events(q: Sql | Tx, ids: number[]): Promise<(EventRow & { oosId: number })[]> {
  if (!ids.length) return [];
  return [...await q<(EventRow & { oosId: number })[]>`
    select e.id::int, e.oos_id::int as "oosId", e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at,
      (select json_build_object('printedName', g.printed_name, 'meaning', g.meaning, 'signedAt', g.signed_at) from signatures g where g.object_type = 'oos_event' and g.object_id = e.id limit 1) as signature
    from oos_events e join users u on u.id = e.person_id where e.oos_id = any(${ids}) order by e.id`];
}

async function loadOos(q: Sql | Tx, id: number) {
  const [o0] = await q<Row[]>`${ROW(q)} where o.id = ${id}`;
  const o = o0 && rounded(o0);
  if (!o) return null;
  const ev = await events(q, [id]);
  if (o.outsideResultId !== null) {
    // An outside result: the people who typed and checked it stand where the analysis's people do.
    const [x] = await q<{ people: number[] }[]>`
      select array_remove(array[o.entered_by::int, c.person_id::int], null) as people from outside_results o left join outside_result_checks c on c.result_id = o.id where o.id = ${o.outsideResultId}`;
    return { o, events: ev as EventRow[], facts: { analysisPeople: x!.people, outside: true } as OosFacts };
  }
  const a = (await loadAnalysis(q, o.analysisId!))!;
  const people = analysisView(a.doc, a.events, a.analysisEvents, a.now).people;
  return { o, events: ev as EventRow[], facts: { analysisPeople: people } as OosFacts };
}
type Loaded = NonNullable<Awaited<ReturnType<typeof loadOos>>>;

// What a signer is shown: the OOS as it stands, by its last entry (refused if anything was added since).
const oosContent = (l: Loaded) => ({ oos: l.o.id, oosNo: l.o.oosNo, result: l.o.result.shown, status: oosStatus(l.events), lastEvent: l.events.at(-1)?.id ?? 0 });
const oosHash = (l: Loaded) => contentHash('oos', l.o.id, oosContent(l));
const brief = (status: OosStatus): SampleOos['status'] => (status === 'confirmed' ? 'confirmed' : status === 'invalidated' ? 'invalidated' : 'open');

/** The OOS of a sample, for QC's decision and the sample screen. */
export async function oosOfSample(q: Sql | Tx, sampleId: number): Promise<(SampleOos & { id: number; analysisNo: string; testKey: string; detail: OosStatus })[]> {
  const rows = (await q<Row[]>`${ROW(q)} where o.sample_id = ${sampleId} order by o.id`).map(rounded);
  const ev = await events(q, rows.map((r) => r.id));
  return rows.map((r) => {
    const s = oosStatus(ev.filter((e) => e.oosId === r.id));
    return { id: r.id, oosNo: r.oosNo, testName: r.result.name, testKey: r.testKey, analysisNo: r.analysisNo, status: brief(s), detail: s };
  });
}
/** LIMS-09: the OOS of these samples, with the plant day each was opened (a stop to reduced testing). */
export async function oosOfSamples(q: Sql | Tx, sampleIds: number[]): Promise<{ oosNo: string; status: SampleOos['status']; openedOn: string }[]> {
  if (!sampleIds.length) return [];
  const rows = await q<{ id: number; oosNo: string; openedOn: string }[]>`
    select o.id::int, o.oos_no as "oosNo", (o.opened_at at time zone ${PLANT_TZ})::date::text as "openedOn" from oos o where o.sample_id = any(${sampleIds}) order by o.id`;
  const ev = await events(q, rows.map((r) => r.id));
  return rows.map((r) => ({ oosNo: r.oosNo, openedOn: r.openedOn, status: brief(oosStatus(ev.filter((e) => e.oosId === r.id))) }));
}
/** The OOS an analysis opened, and the one it is a retest of (the analysis screen links to them). */
export async function oosOfAnalysis(q: Sql | Tx, analysisId: number) {
  const rows = await q<{ id: number; oosNo: string; testName: string; retest: boolean }[]>`
    select o.id::int, o.oos_no as "oosNo", o.result->>'name' as "testName", o.analysis_id <> ${analysisId} as retest from oos o
    where o.analysis_id = ${analysisId} or exists (select 1 from oos_events e where e.oos_id = o.id and e.kind = 'retest' and (e.payload->>'analysis')::bigint = ${analysisId})
    order by o.id`;
  const ev = await events(q, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, status: oosStatus(ev.filter((e) => e.oosId === r.id)) }));
}

/**
 * LIMS-24: an analysis started as a retest of an OOS (one QA authorised when invalidating the result): it must be of
 * the same sample and cover the OOS's test; the link is an OOS entry. Null when linked, else why not.
 */
export async function linkRetest(tx: Tx, oosId: number, a: { id: number; analysisNo: string; sampleId: number | null; tests: string[] }, person: number): Promise<string | null> {
  await tx`select pg_advisory_xact_lock(hashtext(${`oos:${oosId}`}))`;
  const l = await loadOos(tx, oosId);
  if (!l) return 'There is no such OOS.';
  if (a.sampleId !== l.o.sampleId) return `A retest of ${l.o.oosNo} is an analysis of sample ${l.o.sampleNo}.`;
  if (!a.tests.includes(l.o.testKey)) return `This method does not do the test ${l.o.result.name} of ${l.o.oosNo}.`;
  const no = retestRefusal(l.events);
  if (no) return no;
  const [e] = await tx<{ id: number }[]>`
    insert into oos_events (oos_id, kind, payload, person_id) values (${oosId}, 'retest', ${tx.json({ analysis: a.id, analysisNo: a.analysisNo })}, ${person}) returning id::int`;
  await audit(tx, { actorId: person, action: 'oos.retest', objectType: 'oos', objectId: oosId, new: { event: e!.id, analysis: a.analysisNo } });
  return null;
}

const text = (max = 1000) => z.string().trim().min(1).max(max);
const answer = z.object({ yes: z.boolean(), comment: z.string().trim().max(1000).optional() }).strict();
const BODIES: Record<OosAction, z.ZodTypeAny> = {
  checklist: z.object({ answers: z.object(Object.fromEntries(OOS_CHECKLIST.map(([k]) => [k, answer.optional()]))).strict() }),
  plan: z.object({ what: text(), by: text(200) }),
  remeasure: z.object({ plan: z.number().int().positive(), value: z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'a number'), reference: text(200) }),
  // report: an outside result's phase I, the contract lab's investigation report (its number and file).
  'conclude-phase1': z.object({ labError: z.boolean(), cause: z.string().trim().max(1000).optional(),
    report: z.object({ reportNo: text(60), file: z.object({ name: text(255), content: z.string().min(1).max(12 * 1024 * 1024) }).strict() }).strict().optional() }),
  return: z.object({ reason: text() }),
  review: signBody,
  phase2: z.object({ reference: text(60) }),
  'check-phase2': z.object({}),
  conclude: signBody.extend({ outcome: z.enum(['confirmed', 'invalidated']), reason: text(), cause: z.string().trim().max(1000).optional(), retests: z.number().int().min(1).max(3).optional() }),
};

export function oosRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.view', 'lims.analysis.perform', 'lims.analysis.review', 'lims.qc.approve', 'lims.oos.approve') };

  /**
   * The deviation Deviations filed from this OOS: its deviation_v1.source_ref names the OOS ("lims:oos:" and the OOS's
   * oos_v1 id, its row id or its number). Read live; null when none, or Deviations cannot be read.
   */
  async function filedOf(l: Loaded): Promise<string | null> {
    const h = createHash('md5').update(`lims:oos:${l.o.id}`).digest('hex');
    const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    const refs = [`lims:oos:${uuid}`, `lims:oos:${l.o.id}`, `lims:oos:${l.o.oosNo}`];
    const r = await app.links.deviations.bySourceRefs(refs);
    if (r.state !== 'ok') return null;
    return refs.map((x) => r.value.get(x)?.number).find((x): x is string => !!x) ?? null;
  }
  /** Loads the OOS with the deviation filed from it (facts.filedDeviation). */
  const loadWithFiled = async (q: Sql | Tx, id: number) => {
    const l = await loadOos(q, id);
    if (l) l.facts.filedDeviation = await filedOf(l);
    return l;
  };

  /** The phase II deviation as Deviations has it now. */
  async function deviationNow(l: Loaded): Promise<DeviationNow | undefined> {
    const p = phase2(l.events, l.facts.filedDeviation);
    if (!p) return undefined;
    const r = await app.links.deviations.byNumbers([p.reference]);
    return r.state === 'ok' ? { state: 'ok', status: r.value.get(p.reference)?.status ?? null } : { state: r.state };
  }

  // The OOS, newest first, with their computed status.
  app.get('/api/oos', reader, async () => {
    const rows = (await sql<Row[]>`${ROW(sql)} order by o.id desc limit 500`).map(rounded);
    const ev = await events(sql, rows.map((r) => r.id));
    return rows.map(({ spec: _, ...r }) => {
      const e = ev.filter((x) => x.oosId === r.id);
      const s = oosStatus(e);
      return { ...r, status: s, closedAt: oosClosed(s) ? e.find((x) => x.kind === 'concluded')!.at : null, deviation: phase2(e)?.reference ?? null };
    });
  });

  // One OOS: its facts, every entry, the plans with their results (none averaged), the retests with their results, the
  // phase II deviation read live, other samples of the item (impact), and what this person may do next.
  app.get<{ Params: { id: string } }>('/api/oos/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadWithFiled(sql, id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const user = req.user!;
    const status = oosStatus(l.events);
    const dev = await deviationNow(l);
    const p2 = phase2(l.events, l.facts.filedDeviation);
    const r2 = p2 ? await app.links.deviations.byNumbers([p2.reference]) : null;
    const picks = await app.links.deviations.byBatch(l.o.analysisNo, l.o.lotNo);
    const results = await sampleTestResults(sql, l.o.sampleId);
    const rt = retests(l.events);
    const retestIds = rt.started.map((e) => e.payload.analysis);
    const others = await sql<{ id: number; sampleNo: string; lotNo: string; purpose: string; registeredAt: Date; decision: string | null }[]>`
      select s.id::int, s.sample_no as "sampleNo", s.lot_no as "lotNo", s.purpose, s.registered_at as "registeredAt",
        (select e.kind from sample_events e where e.sample_id = s.id and e.kind in ('approved', 'rejected') limit 1) as decision
      from samples s where s.item->>'code' = ${l.o.item.code} and s.id <> ${l.o.sampleId} order by s.id desc limit 10`;
    // The method's effective version, to start a retest by.
    const t0 = l.o.spec.tests.find((t) => t.key === l.o.testKey);
    const [method] = t0 ? await sql<{ id: number; versionNo: number; code: string; name: string }[]>`
      select id::int, version_no as "versionNo", doc->'header'->>'code' as code, doc->'header'->>'name' as name from master_versions
      where kind = 'method' and state = 'effective' and master_id = ${t0.method.masterId}` : [];
    // A re-measurement is offered for the first plan still without its result.
    const open = plans(l.events).find((x) => !x.result)?.plan.id;
    const refusals = Object.fromEntries(OOS_ACTION_NAMES.map((a) => [a, oosRefusal(a, l.facts, l.events, user, a === 'remeasure' && open ? { plan: open } : {}, dev)]));
    const { spec, ...o } = l.o;
    const test = spec.tests.find((t) => t.key === l.o.testKey);
    return {
      oos: o, status, events: l.events, checklist: OOS_CHECKLIST, plans: plans(l.events), conclusion: phase1Conclusion(l.events) ?? null,
      phase2: p2 ? { ...p2, deviation: r2?.state === 'ok' ? r2.value.get(p2.reference) ?? null : null, link: r2?.state ?? 'absent' } : null,
      deviations: { link: picks.state, list: picks.state === 'ok' ? picks.value : [] },
      retests: { authorised: rt.authorised, by: l.events.find((e) => e.kind === 'concluded' && e.payload.outcome === 'invalidated') ?? null,
        analyses: (results[l.o.testKey] ?? []).filter((r) => retestIds.includes(r.analysisId)).map((r) => (r.result?.value ? { ...r, result: { ...r.result, value: shownFigure(r.result.value, test ? limitFor(test, purposeLimits(l.o.purpose)) : undefined) } } : r)) },
      original: (results[l.o.testKey] ?? []).find((r) => (l.o.outsideResultId !== null ? r.outside?.id === l.o.outsideResultId : r.analysisId === l.o.analysisId)) ?? null,
      test: test ? { name: test.name, limit: limitText(test, purposeLimits(l.o.purpose)), method: test.method } : null,
      others, actions: OOS_ACTION_NAMES.filter((a) => refusals[a] === null), refusals, contentHash: oosHash(l),
      retestRefusal: retestRefusal(l.events), retestMethod: method ?? null,
    };
  });

  // One route per entry, each in the same steps: read the OOS and its entries, check the order and the person, insert
  // the entry (and its signature), audit; an invalidation marks the analysis (LIMS-24, LIMS-48).
  for (const action of OOS_ACTION_NAMES) {
    const rule = OOS_ACTIONS[action];
    // The contract lab's report comes with an outside result's phase I conclusion (at most 8 MB, in base64).
    app.post<{ Params: { id: string } }>(`/api/oos/:id/${action}`, { ...reader, ...(action === 'conclude-phase1' ? { bodyLimit: 12 * 1024 * 1024 } : {}) }, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = BODIES[action].safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) ?? [] });
      const { proof, contentHash: shown, report: sent, ...input } = body.data as { proof?: string; contentHash?: string; report?: { reportNo: string; file: { name: string; content: string } } } & Omit<OosPayload, 'report'> & { answers?: Record<string, { yes: boolean; comment?: string }> };
      // An outside result's phase I: the contract lab's report, named by its file's size and SHA-256 (the file is not kept).
      const bytes = sent ? Buffer.from(sent.file.content, 'base64') : null;
      if (bytes && !bytes.length) return reply.code(400).send({ error: 'invalid', problems: ['The report file is empty.'] });
      if (sent && bytes) (input as OosPayload).report = { reportNo: sent.reportNo, fileName: sent.file.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      const user = req.user!;
      try {
        const signer = rule.meaning ? await authenticateSigner(sql, app.proofKey, user, { proof: proof! }, { objectType: 'oos', objectId: id, meaning: rule.meaning }) : null;
        // Read before the transaction: the phase II deviation in Deviations, and a deviation number picked or typed.
        const pre = await loadWithFiled(sql, id);
        if (!pre) throw new OosError(404, 'not_found');
        const dev = action === 'conclude' ? await deviationNow(pre) : undefined;
        const typed = action === 'phase2' ? await app.links.deviations.byNumbers([input.reference!]) : null;
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`oos:${id}`}))`;
          const l = (await loadOos(tx, id))!;
          l.facts.filedDeviation = pre.facts.filedDeviation;
          const no = oosRefusal(action, l.facts, l.events, user, input, dev);
          if (no) throw new OosError(no.startsWith('You ') ? 403 : 409, 'not_allowed_now', [no]);
          if (signer && shown !== oosHash(l)) throw new OosError(409, 'content_changed', ['The OOS changed since you opened it.']);
          let payload: OosPayload = {};
          const status = oosStatus(l.events);
          switch (action) {
            case 'checklist': {
              const answers = Object.fromEntries(Object.entries(input.answers ?? {}).filter(([, x]) => x).map(([k, x]) => [k, { yes: x!.yes, ...(x!.yes || !x!.comment ? {} : { comment: x!.comment }) }]));
              const p = checklistProblems(answers);
              if (p.length) throw new OosError(400, 'invalid', p);
              payload = { answers };
              break;
            }
            case 'plan': payload = { what: input.what, by: input.by }; break;
            case 'remeasure': {
              // Each result is checked against the test's limit and shown on its own: never averaged with the OOS result.
              const t = l.o.spec.tests.find((x) => x.key === l.o.testKey);
              const lim = t && limitFor(t, purposeLimits(l.o.purpose));
              const r = lim ? c1WithinLimits({ value: { value: input.value!, unit: l.o.result.unit }, limit: lim }) : null;
              if (r && !r.ok) throw new OosError(400, 'invalid', [r.message]);
              payload = { plan: input.plan, value: input.value, reference: input.reference, ...(r?.ok ? { shown: r.shown, pass: r.check?.pass } : {}) };
              break;
            }
            case 'conclude-phase1':
              if (input.labError && !input.cause?.trim()) throw new OosError(400, 'invalid', ['Name the assignable laboratory error found.']);
              payload = { labError: input.labError, ...(input.labError ? { cause: input.cause } : {}), ...(l.facts.outside ? { report: (input as OosPayload).report! } : {}) };
              break;
            case 'return': payload = { reason: input.reason }; break;
            case 'phase2': {
              // Picked from Deviations while it answers (the number must be there); typed by hand only while it does not.
              if (typed!.state === 'ok' && !typed!.value.get(input.reference!)) throw new OosError(409, 'unknown_deviation', [`${input.reference} is not in the DIVE system: pick the deviation filed for this OOS, or check the number.`]);
              payload = { reference: input.reference, source: typed!.state === 'ok' ? { from: 'deviations' } : { from: 'hand', state: typed!.state } };
              break;
            }
            case 'check-phase2': payload = { entry: phase2(l.events)!.event!.id }; break;
            case 'conclude': {
              // After a phase I that found a laboratory error the outcome is the invalidation, with that cause.
              const cause = status === 'QA approval' ? phase1Conclusion(l.events)!.payload.cause : input.cause;
              payload = { outcome: input.outcome, reason: input.reason, ...(input.outcome === 'invalidated' ? { cause, retests: input.retests ?? 1 } : {}) };
              break;
            }
          }
          const [ev] = await tx<{ id: number }[]>`
            insert into oos_events (oos_id, kind, payload, person_id) values (${id}, ${rule.event}, ${tx.json(payload as never)}, ${user.id}) returning id::int`;
          if (signer && rule.meaning) {
            const content = { ...oosContent(l), action, ...payload };
            await sign(tx, { signer, objectType: 'oos_event', objectId: ev!.id, meaning: rule.meaning, content, shownHash: contentHash('oos_event', ev!.id, content) });
          }
          await audit(tx, { actorId: user.id, action: `oos.${rule.event}`, objectType: 'oos', objectId: id, old: { status }, new: { event: ev!.id, ...payload }, reason: payload.reason ?? null });
          // LIMS-24, LIMS-48: the invalidated analysis stays, marked; its result no longer counts for the sample.
          // An outside result invalidated no longer counts (outsideResults reads the conclusion); there is no analysis to mark.
          if (action === 'conclude' && payload.outcome === 'invalidated' && l.o.analysisId !== null) await tx`select pg_advisory_xact_lock(${l.o.analysisId}::bigint)`;
          if (action === 'conclude' && payload.outcome === 'invalidated' && l.o.analysisId !== null
              && !(await tx`select 1 from analysis_events where analysis_id = ${l.o.analysisId} and kind = 'invalidated'`).length) {
            const [ae] = await tx<{ id: number }[]>`
              insert into analysis_events (analysis_id, kind, payload, person_id)
              values (${l.o.analysisId}, 'invalidated', ${tx.json({ oos: id, oosNo: l.o.oosNo, reason: payload.reason! })}, ${user.id}) returning id::int`;
            await audit(tx, { actorId: user.id, action: 'analysis.invalidated', objectType: 'analysis', objectId: l.o.analysisId, new: { event: ae!.id, oos: l.o.oosNo }, reason: payload.reason ?? null });
          }
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) {
        if (e instanceof OosError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
        if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
        throw e;
      }
    });
  }
}
