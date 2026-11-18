import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Content } from 'pdfmake/interfaces.js';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { requirePermission } from '../auth.js';
import { pageFrame, plant, render, runs, sendPdf } from '../pdf.js';
import type { TestResult } from './analyses.js';
import type { SampleRow } from './samples.js';
import { stabilityTrend } from './stability-evaluation.js';
import { limitFor, purposeLimits, testsFor, type SpecDoc } from '../../shared/master/spec.js';
import type { MasterDoc } from '../../shared/master/schema.js';
import { oosStatus, type OosEvent } from '../../shared/engine/oos.js';
import { SAMPLE_PURPOSES, type SamplePurpose } from '../../shared/engine/sample.js';
import { excursionLevel } from '../../shared/engine/monitoring.js';
import type { SamplingKind } from '../../shared/master/monitoring.js';
import {
  TAT_DEFAULT_DAYS, assignRefusal, chartTrend, dueOn, kpis, plantDay, summaryOf, addDays,
  type KpiAnalysis, type KpiSample,
} from '../../shared/engine/trends.js';
import { l18ControlChart, NELSON_RULES } from '../../shared/templates/lab-trend.js';
import type { Limit } from '../../shared/templates/rounding.js';
import { plantDate } from '../../shared/plant-time.js';

// Trends, KPIs, the workload planner and the APQR data (plan 2.10, 2.11; LIMS-25, LIMS-42), build step 8. Everything is
// read from this product's own records when asked (the results as QC decided on them, the analyses and their events,
// the OOS, the stability studies, the EM samples) and computed by pure functions (shared/engine/trends.ts, template L18);
// only QC's turnaround targets and the assignments are stored (migration 0020).

const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
// The samples whose results make a product's or material's control chart: release and retest (stability results have
// their own trend, template L22; investigation samples are not routine).
const CHARTED: SamplePurpose[] = ['release', 'retest'];

/** A result as QC decided on it (the decision's payload, as result_v1 publishes it). */
export interface Decided {
  sampleId: number; sampleNo: string; lotNo: string; purpose: SamplePurpose; item: SampleRow['item']; point: string | null; pointName: string | null;
  specVersionId: number; decision: 'approved' | 'rejected'; decidedAt: Date; testKey: string; testName: string; value: string; unit: string; shown: string;
  limitText: string; pass: boolean | null; analysisNo: string; coaNo: string | null; reported: string | null;
}
/** A chart's series: a product or material (its release and retest samples), or an EM or water point. */
type Series = { of: 'product' | 'material'; code: string } | { point: string };
const seriesOf = (key: string): Series | null => {
  const m = /^(product|material):(.+)$/.exec(key);
  if (m) return { of: m[1] as 'product' | 'material', code: m[2]! };
  const p = /^point:(.+)$/.exec(key);
  return p ? { point: p[1]! } : null;
};
const seriesKey = (r: Pick<Decided, 'purpose' | 'item' | 'point'>) => (r.purpose === 'monitoring' ? `point:${r.point}` : `${r.item.of}:${r.item.code}`);

/** The decided results, oldest decision first: of a series (and test), in a period, before an instant, but one sample. */
export async function decided(q: Sql | Tx, f: { series?: Series; test?: string; from?: string; to?: string; before?: Date; notSample?: number; purposes?: SamplePurpose[] } = {}): Promise<Decided[]> {
  const s = f.series;
  return [...await q<Decided[]>`
    select s.id::int as "sampleId", s.sample_no as "sampleNo", s.lot_no as "lotNo", s.purpose, s.item, s.monitoring->>'pointCode' as point,
      s.monitoring->>'pointName' as "pointName", s.spec_version_id::int as "specVersionId", d.kind as decision, d.at as "decidedAt",
      r->>'key' as "testKey", r->>'name' as "testName", coalesce(r->>'value', '') as value, coalesce(r->>'unit', '') as unit, coalesce(r->>'shown', '') as shown,
      coalesce(r->>'limit', '') as "limitText", (r->>'pass')::boolean as pass, r->>'analysisNo' as "analysisNo", d.payload->>'coaNo' as "coaNo", r->>'reported' as reported
    from samples s join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
    cross join lateral jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) r
    where true
      ${s && 'point' in s ? q`and s.purpose = 'monitoring' and s.monitoring->>'pointCode' = ${s.point}` : q``}
      ${s && 'of' in s ? q`and s.item->>'of' = ${s.of} and s.item->>'code' = ${s.code} and s.purpose = any(${f.purposes ?? CHARTED})` : q``}
      ${!s && f.purposes ? q`and s.purpose = any(${f.purposes})` : q``}
      ${f.test ? q`and r->>'key' = ${f.test}` : q``}
      ${f.from ? q`and (d.at at time zone 'Asia/Kolkata')::date >= ${f.from}::date` : q``}
      ${f.to ? q`and (d.at at time zone 'Asia/Kolkata')::date <= ${f.to}::date` : q``}
      ${f.before ? q`and d.at < ${f.before}` : q``}
      ${f.notSample ? q`and s.id <> ${f.notSample}` : q``}
    order by d.at, s.id limit 20000`];
}

/**
 * LIMS-25: the out-of-trend flags of a sample's reviewed results, by test (the `trend` argument of testStates: the one way
 * a trend flag is raised). A stability sample: the prediction interval of its study (template L22, stabilityTrend). A
 * release, retest or monitoring sample: the control chart of the earlier decided results of its product, material or
 * point and test (template L18): a new result breaking a Nelson rule is flagged. The spec's trend limit is checked in
 * testStates itself.
 */
export async function sampleTrend(q: Sql | Tx, s: Pick<SampleRow, 'id' | 'item' | 'stability' | 'purpose' | 'monitoring'>, spec: SpecDoc, results: Record<string, TestResult[]>): Promise<Record<string, string>> {
  if (s.stability) return stabilityTrend(q, s);
  if (s.purpose !== 'monitoring' && !CHARTED.includes(s.purpose)) return {};
  if (s.item.of !== 'product' && s.item.of !== 'material' && !s.monitoring) return {};
  const [d] = await q<{ at: Date }[]>`select at from sample_events where sample_id = ${s.id} and kind in ('approved', 'rejected') limit 1`;
  const series: Series = s.monitoring ? { point: s.monitoring.pointCode } : { of: s.item.of as 'product' | 'material', code: s.item.code };
  const out: Record<string, string> = {};
  for (const t of spec.tests) {
    const r = (results[t.key] ?? []).filter((a) => a.status === 'reviewed').at(-1)?.result;
    if (!r || r.pass === false || !NUM.test(r.value)) continue;
    const history = (await decided(q, { series, test: t.key, before: d?.at ?? new Date(), notSample: s.id })).filter((h) => h.unit === r.unit && NUM.test(h.value));
    const flag = chartTrend(history, r, limitFor(t, purposeLimits(s.purpose)));
    if (flag) out[t.key] = flag;
  }
  return out;
}

const str = (x: { toString(): string } | null | undefined) => (x == null ? null : x.toString());
const today = () => plantDay(new Date());
const monthBack = (n: number) => addDays(`${today().slice(0, 7)}-15`, -30 * n).slice(0, 7);

/** The turnaround target of each sample purpose: QC's latest, else the product default. */
async function targets(q: Sql | Tx) {
  const rows = await q<{ purpose: SamplePurpose; days: number; setBy: string; at: Date }[]>`
    select distinct on (t.purpose) t.purpose, t.days, u.full_name as "setBy", t.at from tat_targets t join users u on u.id = t.set_by order by t.purpose, t.id desc`;
  return SAMPLE_PURPOSES.map((p) => { const r = rows.find((x) => x.purpose === p); return { purpose: p, days: r?.days ?? TAT_DEFAULT_DAYS[p], setBy: r?.setBy ?? null, at: r?.at ?? null }; });
}
const targetMap = (t: Awaited<ReturnType<typeof targets>>) => Object.fromEntries(t.map((x) => [x.purpose, x.days])) as Record<SamplePurpose, number>;

/** Each sample with its received and decision instants (the KPIs, the backlog, the workload). */
async function sampleFacts(q: Sql | Tx, open = false) {
  return q<(KpiSample & { id: number; specVersionId: number; item: SampleRow['item']; lotNo: string; monitoring: SampleRow['monitoring'] })[]>`
    select s.id::int, s.sample_no as "sampleNo", s.purpose, s.spec_version_id::int as "specVersionId", s.item, s.lot_no as "lotNo", s.monitoring,
      (select min(e.at) from sample_events e where e.sample_id = s.id and e.kind = 'received') as "receivedAt",
      (select min(e.at) from sample_events e where e.sample_id = s.id and e.kind in ('approved', 'rejected')) as "decidedAt",
      exists (select 1 from sample_events e where e.sample_id = s.id and e.kind = 'disposed') as disposed
    from samples s
    ${open ? q`where exists (select 1 from sample_events e where e.sample_id = s.id and e.kind = 'received')
      and not exists (select 1 from sample_events e where e.sample_id = s.id and e.kind in ('approved', 'rejected', 'disposed'))` : q``}
    order by s.id limit 20000`;
}

/** The skills (trainings) a method's effective version names on its steps. */
const skillsOf = (doc: MasterDoc) => {
  const out = new Map<string, { code: string; title?: string }>();
  for (const st of doc.stages) for (const t of st.steps) if (t.training) out.set(t.training.code, t.training);
  return [...out.values()];
};

class TrendError extends Error { constructor(public status: number, public problems: string[]) { super(problems[0]); } }
const fail = (e: unknown, reply: FastifyReply) => {
  if (e instanceof TrendError) return reply.code(e.status).send({ error: 'refused', problems: e.problems, message: e.problems[0] });
  throw e;
};

export function trendRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.view', 'lims.qc.approve', 'lims.analysis.review', 'lims.sample.register', 'lims.analysis.perform') };
  const planner = { preHandler: requirePermission('lims.analysis.review', 'lims.qc.approve') };

  // ---------------------------------------------------------------- control charts (LIMS-25)
  // The series that can be charted: per product or material (release and retest samples) or EM and water point, each
  // numeric test with its decided results.
  app.get('/api/trends/series', reader, async () => {
    const rows = (await decided(sql, { purposes: [...CHARTED, 'monitoring'] })).filter((r) => NUM.test(r.value));
    const out = new Map<string, { series: string; kind: 'item' | 'point'; code: string; name: string; testKey: string; testName: string; unit: string; n: number; last: Date }>();
    for (const r of rows) {
      const series = seriesKey(r);
      const k = `${series}|${r.testKey}|${r.unit}`;
      const x = out.get(k) ?? { series, kind: r.purpose === 'monitoring' ? 'point' as const : 'item' as const, code: r.purpose === 'monitoring' ? r.point ?? '' : r.item.code,
        name: r.purpose === 'monitoring' ? `${r.pointName ?? ''} (${r.item.code})` : r.item.name, testKey: r.testKey, testName: r.testName, unit: r.unit, n: 0, last: r.decidedAt };
      x.n++; x.last = r.decidedAt;
      out.set(k, x);
    }
    return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code) || a.testName.localeCompare(b.testName));
  });

  // One chart: the decided results of a series and test in a period (oldest first), the I-MR chart (template L18) with
  // the specification limits, and the Nelson rule breaks with their points.
  app.get<{ Querystring: Record<string, string> }>('/api/trends/chart', reader, async (req, reply) => {
    const p = z.object({ series: z.string().min(3).max(200), test: z.string().min(1).max(60), unit: z.string().max(40).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().safeParse(req.query);
    const series = p.success ? seriesOf(p.data.series) : null;
    if (!p.success || !series) return reply.code(400).send({ error: 'invalid' });
    let rows = (await decided(sql, { series, test: p.data.test, ...(p.data.from ? { from: p.data.from } : {}), ...(p.data.to ? { to: p.data.to } : {}) })).filter((r) => NUM.test(r.value));
    const unit = p.data.unit ?? rows.at(-1)?.unit;
    rows = rows.filter((r) => r.unit === unit);
    if (!rows.length) return { series: p.data.series, test: p.data.test, points: [], chart: null, message: 'No decided results of this test in the period.' };
    const last = rows.at(-1)!;
    const [v] = await sql<{ doc: SpecDoc; number: string; versionNo: number }[]>`select doc, doc->'header'->>'number' as number, version_no as "versionNo" from master_versions where id = ${last.specVersionId}`;
    const t = v?.doc.tests.find((x) => x.key === p.data.test);
    const limit = t ? limitFor(t, purposeLimits(last.purpose)) : undefined;
    const ids = [...new Set(rows.map((r) => r.sampleId))];
    const oos = await sql<{ sampleId: number; analysisNo: string; oosNo: string }[]>`
      select o.sample_id::int as "sampleId", a.analysis_no as "analysisNo", o.oos_no as "oosNo" from oos o join analyses a on a.id = o.analysis_id
      where o.sample_id = any(${ids}) and o.test_key = ${p.data.test}`;
    const oot = await sql<{ sampleId: number; analysisNo: string; answer: string }[]>`
      select sample_id::int as "sampleId", payload->>'analysisNo' as "analysisNo", payload->>'answer' as answer from sample_events
      where sample_id = any(${ids}) and kind = 'oot_answered' and payload->>'test' = ${p.data.test}`;
    const c = l18ControlChart({ points: rows.map((r) => ({ value: r.value, unit: r.unit })), ...(limit ? { limit } : {}) });
    return {
      series: p.data.series, test: p.data.test, testName: last.testName, unit, item: last.purpose === 'monitoring' ? { code: last.point, name: last.pointName } : { code: last.item.code, name: last.item.name },
      spec: v ? { number: v.number, versionNo: v.versionNo, limit: limit ?? null, trendLimit: t?.trendLimit ?? null } : null,
      points: rows.map((r, k) => ({ n: k + 1, sampleId: r.sampleId, sampleNo: r.sampleNo, lotNo: r.lotNo, value: r.value, reported: r.reported, shown: r.shown, pass: r.pass, analysisNo: r.analysisNo,
        decidedAt: r.decidedAt, decision: r.decision, oos: oos.find((o) => o.sampleId === r.sampleId && o.analysisNo === r.analysisNo)?.oosNo ?? null,
        oot: oot.find((o) => o.sampleId === r.sampleId && o.analysisNo === r.analysisNo)?.answer ?? null })),
      chart: c.ok ? { shown: c.shown, mean: str(c.mean), sigma: str(c.sigma), sd: str(c.sd), ucl: str(c.ucl), lcl: str(c.lcl), mrBar: str(c.mrBar), mrUcl: str(c.mrUcl),
        zones: { plus1: str(c.zones.plus1), plus2: str(c.zones.plus2), minus1: str(c.zones.minus1), minus2: str(c.zones.minus2) },
        movingRanges: c.movingRanges.map(str), mrBreaks: c.mrBreaks, specLow: str(c.specLow), specHigh: str(c.specHigh), cpk: str(c.cpk), ppk: str(c.ppk), breaks: c.breaks } : null,
      message: c.ok ? null : c.message,
      rules: NELSON_RULES,
    };
  });

  // ---------------------------------------------------------------- KPIs (plan 2.11)
  app.get<{ Querystring: Record<string, string> }>('/api/kpis', reader, async (req, reply) => {
    const p = z.object({ from: z.string().regex(/^\d{4}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}$/).optional() }).strict().safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const to = p.data.to ?? today().slice(0, 7);
    const from = p.data.from ?? monthBack(11);
    if (from > to) return reply.code(400).send({ error: 'invalid', message: 'The first month is after the last one.' });
    const analyses = await sql<(KpiAnalysis & { outcome: string | null })[]>`
      select a.analysis_no as "analysisNo", v.doc->'header'->>'code' as method, u.full_name as analyst, a.issued_at as "issuedAt",
        (select min(e.at) from analysis_events e where e.analysis_id = a.id and e.kind in ('reviewed', 'stopped', 'invalidated')) as "finishedAt",
        exists (select 1 from analysis_events e where e.analysis_id = a.id and e.kind = 'reviewed') as reviewed,
        exists (select 1 from analysis_events e where e.analysis_id = a.id and e.kind = 'stopped') as stopped,
        exists (select 1 from analysis_events e where e.analysis_id = a.id and e.kind = 'invalidated') as invalidated,
        exists (select 1 from step_events e where e.analysis_id = a.id and e.kind in ('corrected', 'sent_back')) as corrected,
        exists (select 1 from oos o where o.analysis_id = a.id) as oos
      from analyses a join master_versions v on v.id = a.master_version_id join users u on u.id = a.issued_by
      where a.sample_id is not null order by a.id limit 50000`;
    const t = await targets(sql);
    return { from, to, today: today(), targets: t, ...kpis(analyses, await sampleFacts(sql), { from, to, targets: targetMap(t), today: today() }) };
  });

  app.get('/api/kpis/targets', reader, async () => targets(sql));
  // QC sets the turnaround target of a sample purpose (insert-only; the latest applies).
  app.post('/api/kpis/targets', { preHandler: requirePermission('lims.qc.approve') }, async (req, reply) => {
    const b = z.object({ purpose: z.enum(SAMPLE_PURPOSES), days: z.number().int().min(1).max(365) }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', problems: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    return sql.begin(async (tx) => {
      const before = targetMap(await targets(tx))[b.data.purpose];
      const [r] = await tx<{ id: number }[]>`insert into tat_targets (purpose, days, set_by) values (${b.data.purpose}, ${b.data.days}, ${req.user!.id}) returning id::int`;
      await audit(tx, { actorId: req.user!.id, action: 'kpi.tat_target_set', objectType: 'tat_target', objectId: r!.id, old: { purpose: b.data.purpose, days: before }, new: b.data });
      return { ok: true, id: r!.id };
    });
  });

  // ---------------------------------------------------------------- workload planner (plan 2.10)
  /** The open samples (received, not decided, not disposed) and, per method that does their tests, its analysis and assignment. */
  async function workRows(q: Sql | Tx) {
    const t = targetMap(await targets(q));
    const samples = await sampleFacts(q, true);
    const specs = new Map<number, SpecDoc>();
    for (const id of new Set(samples.map((s) => s.specVersionId))) {
      const [v] = await q<{ doc: SpecDoc }[]>`select doc from master_versions where id = ${id}`;
      if (v) specs.set(id, v.doc);
    }
    const masterIds = [...new Set([...specs.values()].flatMap((d) => d.tests.map((x) => x.method.masterId)))];
    const methods = masterIds.length ? await q<{ masterId: number; versionId: number; doc: MasterDoc }[]>`
      select master_id::int as "masterId", id::int as "versionId", doc from master_versions where kind = 'method' and state = 'effective' and master_id = any(${masterIds})` : [];
    const ids = samples.map((s) => s.id);
    const analyses = ids.length ? await q<{ id: number; analysisNo: string; sampleId: number; masterId: number; status: string | null; issuedBy: string }[]>`
      select a.id::int, a.analysis_no as "analysisNo", a.sample_id::int as "sampleId", v.master_id::int as "masterId", u.full_name as "issuedBy",
        (select e.kind from analysis_events e where e.analysis_id = a.id and e.kind in ('reviewed', 'stopped', 'invalidated') order by e.id desc limit 1) as status
      from analyses a join master_versions v on v.id = a.master_version_id join users u on u.id = a.issued_by where a.sample_id = any(${ids}) order by a.id` : [];
    const assigned = ids.length ? await q<{ sampleId: number; masterId: number; analystId: number; analyst: string; by: string; at: Date; training: Record<string, unknown> }[]>`
      select distinct on (l.sample_id, l.method_master_id) l.sample_id::int as "sampleId", l.method_master_id::int as "masterId", l.analyst_id::int as "analystId",
        u.full_name as analyst, b.full_name as by, l.at, l.training
      from lab_assignments l join users u on u.id = l.analyst_id join users b on b.id = l.assigned_by
      where l.sample_id = any(${ids}) order by l.sample_id, l.method_master_id, l.id desc` : [];
    const rows = [];
    for (const s of samples) {
      const spec = specs.get(s.specVersionId);
      if (!spec) continue;
      const tests = spec.tests.filter((x) => (x.use === 'release and stability' || x.use === purposeLimits(s.purpose)) && (!s.monitoring || x.key === s.monitoring.testKey));
      const target = t[s.purpose];
      for (const masterId of [...new Set(tests.map((x) => x.method.masterId))]) {
        const m = methods.find((x) => x.masterId === masterId);
        const a = analyses.filter((x) => x.sampleId === s.id && x.masterId === masterId && x.status !== 'invalidated').at(-1) ?? null;
        if (a?.status === 'reviewed') continue;   // done: the sample waits for QC's decision, not for an analyst
        const due = dueOn(s.receivedAt!, target);
        rows.push({ sampleId: s.id, sampleNo: s.sampleNo, purpose: s.purpose, lotNo: s.lotNo, item: { code: s.item.code, name: s.item.name },
          received: plantDay(s.receivedAt!), due, overdue: due < today(), targetDays: target,
          methodMasterId: masterId, method: m ? { code: m.doc.header.code, name: m.doc.header.name, skills: skillsOf(m.doc) } : null,
          tests: testsFor(spec, masterId, s.purpose).filter((x) => !s.monitoring || x.key === s.monitoring.testKey).map((x) => x.name),
          analysis: a ? { id: a.id, analysisNo: a.analysisNo, status: a.status ?? 'in progress', by: a.issuedBy } : null,
          assigned: assigned.find((x) => x.sampleId === s.id && x.masterId === masterId) ?? null });
      }
    }
    return rows.sort((a, b) => a.due.localeCompare(b.due) || a.sampleNo.localeCompare(b.sampleNo));
  }

  /** A person's training in each skill, as Recruitment answers now; absent or down when it does not. */
  async function trainingOf(login: string, skills: readonly { code: string }[]) {
    const qualified: Record<string, boolean> = {};
    for (const s of skills) {
      const r = await app.links.recruitment.training(login, s.code);
      if (r.state !== 'ok') return { state: r.state };
      qualified[s.code] = !!r.value?.qualified;
    }
    return { state: 'ok' as const, qualified };
  }

  // Who tests what by when: the open samples' tests per method with their due date (received + the purpose's target),
  // the analysis if started and the assignment; the analysts (people who work on analyses) with their open analyses and
  // assignments, and for each method whether they are trained in its skills (Recruitment, read now).
  app.get('/api/workload', reader, async () => {
    const rows = await workRows(sql);
    const people = await sql<{ id: number; username: string; name: string; open: number }[]>`
      select u.id::int, u.username, u.full_name as name,
        (select count(*)::int from analyses a where a.issued_by = u.id and a.sample_id is not null
          and not exists (select 1 from analysis_events e where e.analysis_id = a.id and e.kind in ('reviewed', 'stopped', 'invalidated'))) as open
      from users u
      where exists (select 1 from analyses a where a.issued_by = u.id) or exists (select 1 from step_events e where e.person_id = u.id)
        or exists (select 1 from sessions x where x.user_id = u.id and 'lims.analysis.perform' = any(x.permissions))
        or exists (select 1 from lab_assignments l where l.analyst_id = u.id)
      order by u.full_name`;
    const methods = new Map(rows.filter((r) => r.method).map((r) => [r.methodMasterId, r.method!]));
    let link: 'ok' | 'absent' | 'down' = 'ok';
    const trained: Record<number, Record<number, string | null>> = {};
    for (const [masterId, m] of methods) {
      trained[masterId] = {};
      for (const p of people) {
        const read = m.skills.length ? await trainingOf(p.username, m.skills) : { state: 'ok' as const, qualified: {} };
        if (read.state !== 'ok') link = read.state;
        trained[masterId]![p.id] = assignRefusal(p.name, m.skills, read);
      }
    }
    return { today: today(), link, rows, trained,
      analysts: people.map((p) => ({ id: p.id, name: p.name, openAnalyses: p.open, assigned: rows.filter((r) => r.assigned?.analystId === p.id).length })) };
  });

  // Assign a sample's tests done by one method to an analyst (insert-only; assigning again is a new row). Refused while
  // Recruitment answers and the analyst is not trained in a skill the method names; not checked (and said) while it
  // does not answer.
  app.post('/api/workload/assign', planner, async (req, reply) => {
    const b = z.object({ sampleId: z.number().int().positive(), methodMasterId: z.number().int().positive(), analystId: z.number().int().positive() }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid' });
    try {
      const rows = await workRows(sql);
      const row = rows.find((r) => r.sampleId === b.data.sampleId && r.methodMasterId === b.data.methodMasterId);
      if (!row) throw new TrendError(409, ['This sample has no open test done by that method: it is not received, already decided or disposed, or its analysis is reviewed.']);
      if (!row.method) throw new TrendError(409, ['The method has no effective version: it cannot be started, so it is not assigned.']);
      const [who] = await sql<{ id: number; username: string; name: string }[]>`select id::int, username, full_name as name from users where id = ${b.data.analystId}`;
      if (!who) throw new TrendError(404, ['There is no such person.']);
      if (row.assigned?.analystId === who.id) throw new TrendError(409, [`${row.sampleNo} (${row.method.code}) is already assigned to ${who.name}.`]);
      const read = row.method.skills.length ? await trainingOf(who.username, row.method.skills) : { state: 'ok' as const, qualified: {} };
      const no = assignRefusal(who.name, row.method.skills, read);
      if (no) throw new TrendError(409, [no]);
      const training = !row.method.skills.length ? { checked: 'the method names no training' }
        : read.state === 'ok' ? { checked: 'Recruitment', skills: row.method.skills.map((s) => s.code) } : { checked: `not checked: Recruitment ${read.state === 'down' ? 'does not answer' : 'is not linked'}` };
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`assign:${b.data.sampleId}:${b.data.methodMasterId}`}))`;
        const [r] = await tx<{ id: number }[]>`
          insert into lab_assignments (sample_id, method_master_id, analyst_id, training, assigned_by)
          values (${b.data.sampleId}, ${b.data.methodMasterId}, ${who.id}, ${tx.json(training)}, ${req.user!.id}) returning id::int`;
        await audit(tx, { actorId: req.user!.id, action: 'workload.assigned', objectType: 'sample', objectId: b.data.sampleId,
          old: row.assigned ? { analyst: row.assigned.analyst } : undefined, new: { assignment: r!.id, method: row.method!.code, analyst: who.name, due: row.due, training } });
        return { ok: true, id: r!.id, training };
      });
    } catch (e) { return fail(e, reply); }
  });

  // My work: what is assigned to me and still open (the sample not decided, the method's analysis not reviewed).
  app.get('/api/workload/mine', { preHandler: requirePermission() }, async (req) =>
    (await workRows(sql)).filter((r) => r.assigned?.analystId === req.user!.id).map((r) => ({ sampleId: r.sampleId, sampleNo: r.sampleNo, item: r.item, lotNo: r.lotNo,
      method: r.method, tests: r.tests, due: r.due, overdue: r.overdue, analysis: r.analysis, by: r.assigned!.by, at: r.assigned!.at })));

  // ---------------------------------------------------------------- APQR (LIMS-42)
  app.get('/api/apqr/items', reader, async () => sql`
    select distinct s.item->>'of' as of, s.item->>'code' as code, s.item->>'name' as name from samples s
    where s.item->>'of' in ('product', 'material') order by 1, 2`);

  // The lab's part of a product's (or material's) annual review over a period: results summary per test, lots and their
  // decisions, OOS and OOT, method and specification changes, stability studies, and the EM and water results. On
  // screen (JSON), or exported as PDF or CSV.
  app.get<{ Querystring: Record<string, string> }>('/api/apqr', reader, async (req, reply) => {
    const p = z.object({ of: z.enum(['product', 'material']), code: z.string().min(1).max(60), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), format: z.enum(['json', 'csv', 'pdf']).default('json') }).strict().safeParse(req.query);
    if (!p.success || p.data.from > p.data.to) return reply.code(400).send({ error: 'invalid', message: 'Give the product or material and a period (from, to).' });
    const r = await apqr(sql, p.data);
    if (!r) return reply.code(404).send({ error: 'not_found', message: `No sample of ${p.data.code} has been registered.` });
    const name = `APQR-${p.data.code}-${p.data.from}-${p.data.to}`.replace(/[^A-Za-z0-9._-]/g, '_');
    if (p.data.format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`).send(apqrCsv(r));
    if (p.data.format === 'pdf') return sendPdf(reply, name, await render(apqrDoc(r, req.user!.fullName, new Date(), app.demo)));
    return r;
  });
}

// ================================================================ APQR summary
type Apqr = NonNullable<Awaited<ReturnType<typeof apqr>>>;
async function apqr(q: Sql, f: { of: 'product' | 'material'; code: string; from: string; to: string }) {
  const [item] = await q<{ name: string; itemId: string }[]>`
    select s.item->>'name' as name, s.item->>'itemId' as "itemId" from samples s where s.item->>'of' = ${f.of} and s.item->>'code' = ${f.code} order by s.id desc limit 1`;
  if (!item) return null;
  const period = { from: f.from, to: f.to };
  const rows = await decided(q, { series: { of: f.of, code: f.code }, ...period, purposes: ['release', 'retest', 'investigation'] });
  // Lots and their decisions (each decided sample once).
  const lots = [...new Map(rows.map((r) => [r.sampleId, { sampleNo: r.sampleNo, lotNo: r.lotNo, purpose: r.purpose, decision: r.decision, decidedAt: r.decidedAt, coaNo: r.coaNo }])).values()];
  // Results per test: the decided numeric results (n, min, max, mean, sd, Cpk with a two-sided limit, Nelson rules broken).
  const specIds = [...new Set(rows.map((r) => r.specVersionId))];
  const specs = specIds.length ? await q<{ id: number; doc: SpecDoc }[]>`select id::int, doc from master_versions where id = any(${specIds})` : [];
  const testKeys = [...new Set(rows.map((r) => r.testKey))];
  const results = testKeys.map((key) => {
    const rs = rows.filter((r) => r.testKey === key);
    const last = rs.at(-1)!;
    const t = specs.find((s) => s.id === last.specVersionId)?.doc.tests.find((x) => x.key === key);
    const limit: Limit | undefined = t ? limitFor(t, 'release') : undefined;
    const nums = rs.filter((r) => NUM.test(r.value) && r.unit === last.unit);
    return { key, name: last.testName, limit: last.limitText, unit: last.unit, results: rs.length, failed: rs.filter((r) => r.pass === false).length,
      ...summaryOf(nums.map((r) => ({ value: r.value, unit: r.unit })), limit) };
  });
  // OOS of every sample of the item opened in the period (stability ones too), with status and phase II deviation.
  const oosRows = await q<{ id: number; oosNo: string; sampleNo: string; lotNo: string; purpose: string; test: string; shown: string; openedAt: Date; analysisNo: string }[]>`
    select o.id::int, o.oos_no as "oosNo", s.sample_no as "sampleNo", s.lot_no as "lotNo", s.purpose, o.result->>'name' as test, o.result->>'shown' as shown,
      o.opened_at as "openedAt", a.analysis_no as "analysisNo"
    from oos o join samples s on s.id = o.sample_id join analyses a on a.id = o.analysis_id
    where s.item->>'of' = ${f.of} and s.item->>'code' = ${f.code}
      and (o.opened_at at time zone 'Asia/Kolkata')::date between ${f.from}::date and ${f.to}::date order by o.id`;
  const oosEvents = oosRows.length ? await q<(OosEvent & { oosId: number })[]>`
    select oos_id::int as "oosId", id::int, kind, payload, person_id::int as person, at from oos_events where oos_id = any(${oosRows.map((o) => o.id)}) order by id` : [];
  const oos = oosRows.map(({ id, ...o }) => {
    const ev = oosEvents.filter((e) => e.oosId === id);
    return { ...o, status: oosStatus(ev), deviation: (ev.filter((e) => e.kind === 'phase2').at(-1)?.payload as { reference?: string } | undefined)?.reference ?? null };
  });
  // OOT flags QC answered in the period.
  const oot = await q<{ sampleNo: string; lotNo: string; test: string; analysisNo: string; answer: string; reason: string; at: Date }[]>`
    select s.sample_no as "sampleNo", s.lot_no as "lotNo", e.payload->>'test' as test, e.payload->>'analysisNo' as "analysisNo", e.payload->>'answer' as answer,
      e.payload->>'reason' as reason, e.at from sample_events e join samples s on s.id = e.sample_id
    where e.kind = 'oot_answered' and s.item->>'of' = ${f.of} and s.item->>'code' = ${f.code}
      and (e.at at time zone 'Asia/Kolkata')::date between ${f.from}::date and ${f.to}::date order by e.id`;
  // Method and specification versions made effective in the period: the item's specifications and the methods they name.
  const specMasters = await q<{ masterId: number }[]>`
    select distinct master_id::int as "masterId" from master_versions where kind = 'spec' and doc->'header'->>'of' = ${f.of} and doc->'header'->>'code' = ${f.code}`;
  const allSpecs = specMasters.length ? await q<{ doc: SpecDoc }[]>`select doc from master_versions where kind = 'spec' and master_id = any(${specMasters.map((m) => m.masterId)})` : [];
  const methodMasters = [...new Set(allSpecs.flatMap((s) => s.doc.tests.map((t) => t.method.masterId)))];
  const masterIds = [...specMasters.map((m) => m.masterId), ...methodMasters];
  const changes = masterIds.length ? await q<{ kind: string; number: string; name: string; versionNo: number; effectiveAt: Date; changeControl: string | null; retiredAt: Date | null }[]>`
    select v.kind, coalesce(v.doc->'header'->>'number', v.doc->'header'->>'code') as number, coalesce(v.doc->'header'->>'name', '') as name, v.version_no as "versionNo",
      e.at as "effectiveAt", (select a.payload->>'changeControl' from master_events a where a.version_id = v.id and a.kind = 'approved' limit 1) as "changeControl",
      (select r.at from master_events r where r.version_id = v.id and r.kind = 'retired' limit 1) as "retiredAt"
    from master_versions v join master_events e on e.version_id = v.id and e.kind = 'effective'
    where v.master_id = any(${masterIds}) and (e.at at time zone 'Asia/Kolkata')::date between ${f.from}::date and ${f.to}::date order by e.at` : [];
  // Stability: the item's studies, the last time point pulled, the latest signed evaluation.
  const stability = await q<{ studyNo: string; lotNo: string; protocol: string; t0: string; lastMonth: number | null; evaluation: string | null }[]>`
    select s.study_no as "studyNo", s.lot_no as "lotNo", v.doc->'header'->>'number' || ' v' || v.version_no as protocol, s.t0::text,
      (select max((x.payload->>'month')::int) from stability_events x where x.study_id = s.id and x.kind = 'pulled') as "lastMonth",
      (select x.kind || ' ' || x.months || ' months (' || x.condition || ')' from stability_evaluations x where s.id = any(x.study_ids) order by x.id desc limit 1) as evaluation
    from stability_studies s join master_versions v on v.id = s.protocol_version_id
    where s.item->>'of' = ${f.of} and s.item->>'code' = ${f.code} order by s.id`;
  const stabilityResults = (await decided(q, { series: { of: f.of, code: f.code }, ...period, purposes: ['stability'] }));
  // EM and water in the period (the plant's monitoring: LIMS does not know which rooms made the batch): per point and
  // sampling, the decided results and how many were over the alert or action level; the excursions recorded.
  const em = await q<{ point: string; pointName: string; where: string; grade: string | null; kind: SamplingKind; value: string | null; unit: string | null; pass: boolean | null; limit: Limit | null }[]>`
    select s.monitoring->>'pointCode' as point, s.monitoring->>'pointName' as "pointName", s.item->>'code' as where, s.monitoring->>'grade' as grade, s.monitoring->>'kind' as kind,
      r->>'value' as value, r->>'unit' as unit, (r->>'pass')::boolean as pass, s.monitoring->'limit' as limit
    from samples s join sample_events d on d.sample_id = s.id and d.kind in ('approved', 'rejected')
    left join lateral (select j from jsonb_array_elements(coalesce(d.payload->'results', '[]'::jsonb)) j where j->>'key' = s.monitoring->>'testKey' limit 1) rr(r) on true
    where s.purpose = 'monitoring' and (d.at at time zone 'Asia/Kolkata')::date between ${f.from}::date and ${f.to}::date order by s.id`;
  const emSummary = new Map<string, { point: string; name: string; where: string; grade: string | null; kind: string; n: number; alert: number; action: number }>();
  for (const x of em) {
    const k = `${x.point}|${x.kind}`;
    const g = emSummary.get(k) ?? { point: x.point, name: x.pointName, where: x.where, grade: x.grade, kind: x.kind, n: 0, alert: 0, action: 0 };
    g.n++;
    const level = x.pass === false ? 'action' : x.value && NUM.test(x.value) ? excursionLevel({ value: x.value, unit: x.unit ?? '' }, x.limit ?? undefined, x.grade, x.kind).level : 'none';
    if (level === 'alert') g.alert++;
    if (level === 'action') g.action++;
    emSummary.set(k, g);
  }
  const excursions = await q<{ point: string; level: string; shown: string; deviation: string | null; closed: boolean; at: Date }[]>`
    select e.point->>'code' as point, e.level, e.result->>'shown' as shown, e.recorded_at as at,
      (select c.payload->>'number' from em_excursion_events c where c.excursion_id = e.id and c.kind = 'deviation' order by c.id desc limit 1) as deviation,
      exists (select 1 from em_excursion_events c where c.excursion_id = e.id and c.kind = 'closed') as closed
    from em_excursions e where (e.recorded_at at time zone 'Asia/Kolkata')::date between ${f.from}::date and ${f.to}::date order by e.id`;
  return {
    item: { of: f.of, code: f.code, name: item.name }, period, generatedAt: new Date(),
    lots, failed: lots.filter((l) => l.decision === 'rejected'), results, oos, oot, changes, stability,
    stabilityResults: { n: stabilityResults.length, failed: stabilityResults.filter((r) => r.pass === false).length },
    em: [...emSummary.values()], excursions,
  };
}

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"` : s; };
const day = (d: Date | null | undefined) => (d ? plantDay(d) : '');
/** The APQR export as CSV: one section after another, each row starting with its section's name. */
export function apqrCsv(r: Apqr): string {
  const L: unknown[][] = [['Section', 'APQR lab data', r.item.of, r.item.code, r.item.name, `${r.period.from} to ${r.period.to}`]];
  L.push(['Results', 'Test', 'Limit', 'Results', 'Failed', 'n (numeric)', 'Min', 'Max', 'Mean', 'SD', 'Cpk', 'Nelson rules broken']);
  for (const t of r.results) L.push(['Results', t.name, t.limit, t.results, t.failed, t.n, t.min, t.max, t.mean, t.sd, t.cpk, t.rules.join(' ')]);
  L.push(['Lots', 'Sample', 'Lot or batch', 'Purpose', 'Decision', 'Decided', 'CoA']);
  for (const l of r.lots) L.push(['Lots', l.sampleNo, l.lotNo, l.purpose, l.decision, day(l.decidedAt), l.coaNo]);
  L.push(['OOS', 'OOS', 'Sample', 'Lot or batch', 'Purpose', 'Test', 'Result', 'Status', 'Deviation', 'Opened']);
  for (const o of r.oos) L.push(['OOS', o.oosNo, o.sampleNo, o.lotNo, o.purpose, o.test, o.shown, o.status, o.deviation, day(o.openedAt)]);
  L.push(['OOT', 'Sample', 'Lot or batch', 'Test', 'Analysis', 'QC answer', 'Reason', 'Answered']);
  for (const o of r.oot) L.push(['OOT', o.sampleNo, o.lotNo, o.test, o.analysisNo, o.answer, o.reason, day(o.at)]);
  L.push(['Changes', 'Kind', 'Number', 'Name', 'Version', 'Effective', 'Change control', 'Retired']);
  for (const c of r.changes) L.push(['Changes', c.kind, c.number, c.name, c.versionNo, day(c.effectiveAt), c.changeControl, day(c.retiredAt)]);
  L.push(['Stability', 'Study', 'Batch or lot', 'Protocol', 'Placed', 'Last time point (months)', 'Latest signed evaluation']);
  for (const s of r.stability) L.push(['Stability', s.studyNo, s.lotNo, s.protocol, s.t0, s.lastMonth, s.evaluation]);
  L.push(['EM and water', 'Point', 'Name', 'Room or system', 'Grade', 'Sampling', 'Results', 'Alert', 'Action']);
  for (const e of r.em) L.push(['EM and water', e.point, e.name, e.where, e.grade, e.kind, e.n, e.alert, e.action]);
  L.push(['Excursions', 'Point', 'Level', 'Result', 'Deviation', 'Status', 'Recorded']);
  for (const x of r.excursions) L.push(['Excursions', x.point, x.level, x.shown, x.deviation, x.closed ? 'closed' : 'open', day(x.at)]);
  return `﻿${L.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const small = (text: string, extra: Record<string, unknown> = {}): Content => ({ text: runs(text), fontSize: 7.5, ...extra }) as Content;
const th = (text: string): Content => ({ text: runs(text), fontSize: 7.5, bold: true, fillColor: '#eef1f4' });
const h2 = (text: string): Content => ({ text: runs(text), bold: true, fontSize: 11, margin: [0, 12, 0, 4] });
const table = (head: string[], body: unknown[][], none: string): Content => (body.length
  ? { table: { headerRows: 1, dontBreakRows: true, widths: head.map(() => '*'), body: [head.map(th), ...body.map((row) => row.map((c) => small(String(c ?? ''))))] }, layout: 'lightHorizontalLines' } as Content
  : small(none));
/** The APQR export as PDF (pdfmake, as the CoA and the CTD tables). */
export function apqrDoc(r: Apqr, by: string, printedAt = new Date(), demo = false) {
  const content: Content[] = [
    { text: runs('Annual product quality review: QC laboratory data'), fontSize: 15, bold: true },
    { text: runs(`${r.item.code} · ${r.item.name} · ${plantDate(r.period.from)} to ${plantDate(r.period.to)}`), fontSize: 11, margin: [0, 2, 0, 6] },
    small('Results as QC decided on them (reviewed analyses only). Mean, SD and Cpk by template L18 (Cpk = min(USL − mean, mean − LSL) ÷ 3 sigma, sigma from the moving range; two-sided limits only). The review itself is done in QMS.', { color: '#555555' }),
    h2(`Results (${r.lots.length} lots or batches decided, ${r.failed.length} rejected)`),
    table(['Test', 'Limit', 'Results', 'Failed', 'n', 'Min', 'Max', 'Mean', 'SD', 'Cpk', 'Rules broken'],
      r.results.map((t) => [t.name, t.limit, t.results, t.failed, t.n, t.min, t.max, t.mean, t.sd, t.cpk, t.rules.join(', ')]), 'No results decided in the period.'),
    h2('Lots and batches'),
    table(['Sample', 'Lot or batch', 'Purpose', 'Decision', 'Decided', 'CoA'], r.lots.map((l) => [l.sampleNo, l.lotNo, l.purpose, l.decision, plant(l.decidedAt), l.coaNo]), 'None.'),
    h2('Failed batches and investigations (OOS)'),
    table(['OOS', 'Sample', 'Lot or batch', 'Purpose', 'Test', 'Result', 'Status', 'Deviation', 'Opened'],
      r.oos.map((o) => [o.oosNo, o.sampleNo, o.lotNo, o.purpose, o.test, o.shown, o.status, o.deviation, plant(o.openedAt)]), 'No OOS in the period.'),
    h2('Out-of-trend results answered by QC'),
    table(['Sample', 'Lot or batch', 'Test', 'Analysis', 'Answer', 'Reason', 'Answered'], r.oot.map((o) => [o.sampleNo, o.lotNo, o.test, o.analysisNo, o.answer, o.reason, plant(o.at)]), 'None.'),
    h2('Method and specification changes'),
    table(['Kind', 'Number', 'Name', 'Version', 'Effective', 'Change control', 'Retired'],
      r.changes.map((c) => [c.kind, c.number, c.name, c.versionNo, plant(c.effectiveAt), c.changeControl, plant(c.retiredAt)]), 'No version made effective in the period.'),
    h2(`Stability (${r.stabilityResults.n} stability results decided in the period, ${r.stabilityResults.failed} failed)`),
    table(['Study', 'Batch or lot', 'Protocol', 'Placed', 'Last time point (months)', 'Latest signed evaluation'],
      r.stability.map((s) => [s.studyNo, s.lotNo, s.protocol, s.t0, s.lastMonth, s.evaluation]), 'No stability study of this item.'),
    h2('Environmental monitoring and water (the plant, in the period)'),
    table(['Point', 'Name', 'Room or system', 'Grade', 'Sampling', 'Results', 'Alert', 'Action'], r.em.map((e) => [e.point, e.name, e.where, e.grade, e.kind, e.n, e.alert, e.action]), 'No EM or water results decided in the period.'),
    table(['Point', 'Level', 'Result', 'Deviation', 'Status', 'Recorded'], r.excursions.map((x) => [x.point, x.level, x.shown, x.deviation, x.closed ? 'closed' : 'open', plant(x.at)]), 'No excursions in the period.'),
  ];
  return pageFrame(`Medhanta LIMS · APQR lab data · ${r.item.code}`, by, content, printedAt, demo);
}

