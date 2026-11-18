import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { requirePermission } from '../auth.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';
import { render, sendPdf } from '../pdf.js';
import { ctdCsv, ctdDoc, ctdTables } from '../ctd.js';
import { sampleTestResults } from './analyses.js';
import { oosOfSample } from './oos.js';
import type { SampleItem, SampleRow } from './samples.js';
import { conditionLabel, type ProtocolDoc } from '../../shared/master/protocol.js';
import type { SpecDoc } from '../../shared/master/spec.js';
import {
  answersRefusal, arrhenius, evaluateTest, groupProposal, numericTests, storageOf, toReport, trendFlag,
  type NumericTest, type ReportItem, type ResultPoint, type TestEvaluation,
} from '../../shared/engine/stability-evaluation.js';
import type { L15Extrapolation } from '../../shared/templates/lab-stability.js';

// Stability evaluation (LIMS-29, LIMS-25; plan 2.6 and 2b items 3, 4, 7, 8): the results per study, condition and time
// point read from the stability samples' reviewed analyses; the ICH Q1E evaluation per long-term condition (template
// L15), per study or across a product's studies of the same protocol, signed by QA with the decision-tree answers as an
// insert-only record; the out-of-trend flag of a stability result (template L22, the sample's OOT flag); the Arrhenius
// advisory (L24); what is to be reported; the CTD tables (PDF and CSV). The calculations are shared/engine/stability-evaluation.ts.

export interface StudyInfo {
  id: number; studyNo: string; lotNo: string; t0: string; item: SampleItem; cell: string | null;
  protocolMasterId: number; protocolVersionNo: number; doc: ProtocolDoc; pulled: number; pullEvents: { condition: string; month: number }[];
}
export interface ItemData { item: SampleItem; studies: StudyInfo[]; points: ResultPoint[]; tests: Map<number, NumericTest[]>; reports: ReportItem[]; ootAnswered: Map<string, string> }

/** Everything LIMS holds on the stability of one product or material: its studies and the reviewed results of their samples. */
export async function itemData(q: Sql | Tx, item: { of: string; itemId: string }): Promise<ItemData | null> {
  const studies = [...await q<(Omit<StudyInfo, 'pullEvents'> & { pullEvents: { condition: string; month: number }[] | null })[]>`
    select s.id::int, s.study_no as "studyNo", s.lot_no as "lotNo", s.t0::text as t0, s.item, s.cell, v.master_id::int as "protocolMasterId",
      v.version_no as "protocolVersionNo", v.doc,
      (select count(*)::int from stability_events e where e.study_id = s.id and e.kind = 'pulled') as pulled,
      (select json_agg(json_build_object('condition', e.payload->>'condition', 'month', (e.payload->>'month')::int)) from stability_events e where e.study_id = s.id and e.kind = 'pulled') as "pullEvents"
    from stability_studies s join master_versions v on v.id = s.protocol_version_id
    where s.item->>'of' = ${item.of} and s.item->>'itemId' = ${item.itemId} order by s.study_no`].map((s) => ({ ...s, pullEvents: s.pullEvents ?? [] }));
  if (!studies.length) return null;
  const samples = await q<{ id: number; sampleNo: string; specVersionId: number; stability: NonNullable<SampleRow['stability']> }[]>`
    select id::int, sample_no as "sampleNo", spec_version_id::int as "specVersionId", stability from samples
    where stability is not null and (stability->>'studyId')::bigint = any(${studies.map((s) => s.id)}) order by id`;
  const specIds = [...new Set(samples.map((s) => s.specVersionId))];
  const specs = new Map((specIds.length ? await q<{ id: number; doc: SpecDoc }[]>`select id::int, doc from master_versions where id = any(${specIds})` : []).map((s) => [s.id, s.doc]));
  const events = samples.length ? await q<{ sampleId: number; kind: string; payload: { test?: string; analysisNo?: string; answer?: string; reason?: string } }[]>`
    select sample_id::int as "sampleId", kind, payload from sample_events where sample_id = any(${samples.map((s) => s.id)}) and kind in ('approved', 'rejected', 'oot_answered') order by id` : [];
  const points: ResultPoint[] = [];
  const reports: ReportItem[] = [];
  const ootAnswered = new Map<string, string>();
  const tests = new Map<number, NumericTest[]>();
  for (const sm of samples) {
    const st = studies.find((s) => s.id === sm.stability.studyId)!;
    const spec = specs.get(sm.specVersionId);
    if (!spec) continue;
    const numeric = numericTests(spec);
    tests.set(st.protocolMasterId, numeric);
    const c = st.doc.conditions.find((x) => x.key === sm.stability.condition);
    const decision = events.find((e) => e.sampleId === sm.id && (e.kind === 'approved' || e.kind === 'rejected'))?.kind as 'approved' | 'rejected' | undefined;
    const results = await sampleTestResults(q, sm.id);
    for (const t of numeric) {
      const r = (results[t.key] ?? []).filter((a) => a.status === 'reviewed' && a.result?.value).at(-1);
      if (!r?.result) continue;
      points.push({ studyId: st.id, studyNo: st.studyNo, lotNo: st.lotNo, condition: sm.stability.condition, label: c ? conditionLabel(c) : sm.stability.label,
        code: c?.code ?? 'other', role: c?.role ?? 'long-term', month: sm.stability.month, testKey: t.key, sampleId: sm.id, sampleNo: sm.sampleNo,
        analysisNo: r.analysisNo, value: r.result.value, unit: r.result.unit, shown: r.result.shown, pass: r.result.pass ?? null, decided: decision ?? null });
    }
    const where = { studyId: st.id, studyNo: st.studyNo, lotNo: st.lotNo, label: c ? conditionLabel(c) : sm.stability.label, month: sm.stability.month };
    for (const e of events.filter((x) => x.sampleId === sm.id && x.kind === 'oot_answered')) {
      ootAnswered.set(`${e.payload.analysisNo}:${e.payload.test}`, e.payload.answer ?? '');
      if (e.payload.answer === 'investigation') {
        const name = spec.tests.find((t) => t.key === e.payload.test)?.name ?? e.payload.test ?? '';
        reports.push({ key: `oot:${e.payload.analysisNo}:${e.payload.test}`, kind: 'negative trend', ...where, test: name,
          what: `${name}, analysis ${e.payload.analysisNo}: out of trend, QC answered "investigation" (${e.payload.reason ?? ''})` });
      }
    }
    for (const o of (await oosOfSample(q, sm.id)).filter((x) => x.status === 'confirmed')) {
      reports.push({ key: `oos:${o.oosNo}`, kind: 'confirmed OOS', ...where, test: o.testName, oosNo: o.oosNo, what: `${o.testName}, analysis ${o.analysisNo}: ${o.oosNo} confirmed` });
    }
  }
  for (const st of studies) {
    if (!tests.has(st.protocolMasterId) && st.doc.spec) {
      const [v] = await q<{ doc: SpecDoc }[]>`select doc from master_versions where id = ${st.doc.spec.versionId}`;
      if (v) tests.set(st.protocolMasterId, numericTests(v.doc));
    }
  }
  return { item: studies.at(-1)!.item, studies, points, tests, reports, ootAnswered };
}

/** LIMS-25: the out-of-trend flags (template L22) of a stability sample's reviewed results, by test. */
export async function stabilityTrend(q: Sql | Tx, s: Pick<SampleRow, 'id' | 'item' | 'stability'>): Promise<Record<string, string>> {
  if (!s.stability) return {};
  const d = await itemData(q, s.item);
  if (!d) return {};
  return Object.fromEntries(d.points.filter((p) => p.sampleId === s.id).flatMap((p) => { const w = trendFlag(p, d.points); return w ? [[p.testKey, w]] : []; }));
}

// ---- Evaluation groups: a protocol (all its versions) and one long-term condition ----
type Scope = { study: number } | { of: 'product' | 'material'; itemId: string };
const scopeSchema = z.union([
  z.object({ study: z.coerce.number().int().positive() }).strict(),
  z.object({ of: z.enum(['product', 'material']), itemId: z.string().min(1).max(100) }).strict(),
]);
const answersSchema = z.object({
  storage: z.enum(['room temperature', 'refrigerated', 'frozen']),
  accelerated: z.enum(['no significant change', 'significant change']).optional(),
  intermediate: z.enum(['no significant change', 'significant change']).optional(),
  change: z.enum(['little or none', 'change or variability']).optional(),
  statistics: z.enum(['performed', 'not amenable']).optional(),
}).strict();
const transformsSchema = z.record(z.string().max(60), z.enum(['none', 'log'])).default({});

export const kindOf = (of: string) => (of === 'material' ? 'retest period' as const : 'shelf life' as const);

interface Group { key: string; protocolMasterId: number; protocolNumber: string; label: string; code: ProtocolDoc['conditions'][number]['code']; studies: StudyInfo[]; tests: NumericTest[]; points: ResultPoint[] }
function groupsOf(d: ItemData, studies: readonly StudyInfo[]): Group[] {
  const out = new Map<string, Group>();
  for (const st of studies) {
    for (const c of st.doc.conditions.filter((x) => x.role === 'long-term')) {
      const label = conditionLabel(c);
      const key = `${st.protocolMasterId}|${label}`;
      const g = out.get(key) ?? { key, protocolMasterId: st.protocolMasterId, protocolNumber: st.doc.header.number, label, code: c.code, studies: [], tests: d.tests.get(st.protocolMasterId) ?? [], points: [] };
      g.studies.push(st);
      out.set(key, g);
    }
  }
  for (const g of out.values()) g.points = d.points.filter((p) => p.label === g.label && g.studies.some((s) => s.id === p.studyId));
  return [...out.values()];
}
/** What a signer of the evaluation is shown and what is stored with it: the results as read, the tests, the scope. */
const groupInputs = (g: Group, scope: Scope) => ({
  scope: 'study' in scope ? 'study' : 'product', studies: g.studies.map((s) => s.studyNo), protocolMasterId: g.protocolMasterId, condition: g.label,
  tests: g.tests.map((t) => ({ key: t.key, name: t.name, criterion: t.words })),
  results: g.points.map((p) => ({ study: p.studyNo, lot: p.lotNo, month: p.month, test: p.testKey, value: p.value, unit: p.unit, sample: p.sampleNo, analysis: p.analysisNo, decided: p.decided })),
});
const groupHash = (g: Group, scope: Scope) => contentHash('stability_evaluation', 0, groupInputs(g, scope));
function evaluateGroup(g: Group, transforms: Record<string, 'none' | 'log'>, answers?: L15Extrapolation): { tests: TestEvaluation[]; proposal: ReturnType<typeof groupProposal> } {
  const tests = g.tests.map((t) => evaluateTest(t, g.points, transforms[t.key] ?? 'none', answers));
  return { tests, proposal: groupProposal(tests) };
}

class EvalError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}

export function stabilityEvaluationRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.sample.register', 'lims.qc.approve', 'lims.view') };
  const qa = { preHandler: requirePermission('lims.qc.approve') };
  const fail = (e: unknown, reply: import('fastify').FastifyReply) => {
    if (e instanceof EvalError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
    if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
    throw e;
  };

  /** The data of a scope: one study (with its product's other studies, for the trend), or a product or material. */
  async function load(q: Sql | Tx, scope: Scope) {
    let item: { of: string; itemId: string };
    if ('study' in scope) {
      const [s] = await q<{ item: SampleItem }[]>`select item from stability_studies where id = ${scope.study}`;
      if (!s) throw new EvalError(404, 'not_found', ['There is no such study.']);
      item = s.item;
    } else item = scope;
    const d = await itemData(q, item);
    if (!d) throw new EvalError(404, 'not_found', ['No stability study of this item.']);
    const studies = 'study' in scope ? d.studies.filter((s) => s.id === scope.study) : d.studies;
    return { d, studies, groups: groupsOf(d, studies) };
  }

  /** Marketed: TrueBatch says released (a product's batch) or MMS says released (a material's lot); null while the link does not answer. */
  async function marketed(of: string, lots: string[]) {
    const out = new Map<string, boolean | null>();
    for (const lot of new Set(lots)) {
      if (of === 'product') {
        const r = await app.links.truebatch.batch(lot);
        out.set(lot, r.state === 'ok' ? !!r.value?.released : null);
      } else {
        const r = await app.links.mms.lot(lot);
        out.set(lot, r.state === 'ok' ? /released|approved/i.test(r.value?.status ?? '') : null);
      }
    }
    return out;
  }

  async function signed(q: Sql | Tx, item: { of: string; itemId: string }, studyIds: number[]) {
    return q<{ id: number; scope: string; condition: string; protocolMasterId: number; kind: string; months: number; studyIds: number[]; inputs: object; outputs: object;
      printedName: string | null; signedAt: Date | null }[]>`
      select e.id::int, e.scope, e.condition, e.protocol_master_id::int as "protocolMasterId", e.kind, e.months, e.study_ids::int[] as "studyIds", e.inputs, e.outputs,
        g.printed_name as "printedName", g.signed_at as "signedAt"
      from stability_evaluations e left join signatures g on g.object_type = 'stability_evaluation' and g.object_id = e.id
      where e.item->>'of' = ${item.of} and e.item->>'itemId' = ${item.itemId} and e.study_ids && ${studyIds}::bigint[] order by e.id desc`;
  }

  // The products and materials with stability studies, with their latest signed shelf life or retest period.
  app.get('/api/stability/products', reader, async () => sql`
    select g.*, (select e.months from stability_evaluations e where e.item->>'itemId' = g."itemId" and e.item->>'of' = g.of order by e.id desc limit 1) as months
    from (select s.item->>'of' as of, s.item->>'itemId' as "itemId", max(s.item->>'code') as code, max(s.item->>'name') as name, count(*)::int as studies
      from stability_studies s group by 1, 2) g order by g.code`);

  // The evaluation of a study or of a product (or material): results, Q1E per long-term condition, trend flags, what is
  // to be reported, the Arrhenius advisory (product), and the signed evaluations.
  app.get<{ Querystring: Record<string, string> }>('/api/stability/evaluation', reader, async (req, reply) => {
    const parsed = scopeSchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const scope = parsed.data as Scope;
    const user = req.user!;
    try {
      const { d, studies, groups } = await load(sql, scope);
      const ids = studies.map((s) => s.id);
      const mine = d.points.filter((p) => ids.includes(p.studyId));
      const reports = d.reports.filter((r) => ids.includes(r.studyId));
      const m = await marketed(d.item.of, reports.map((r) => r.lotNo));
      const answers = await sql<{ key: string; needed: boolean; text: string; by: string; at: Date }[]>`
        select a.key, a.needed, a.text, u.full_name as by, a.at from stability_report_answers a join users u on u.id = a.person_id
        where a.item->>'of' = ${d.item.of} and a.item->>'itemId' = ${d.item.itemId}`;
      const mayQa = user.permissions.includes('lims.qc.approve');
      // Arrhenius per protocol and test, when the protocol has an accelerated, intermediate or stress condition with results.
      const arrh = 'study' in scope ? [] : groups.flatMap((g) => {
        const all = d.points.filter((p) => g.studies.some((s) => s.id === p.studyId));
        if (!all.some((p) => p.role !== 'long-term')) return [];
        return g.tests.map((t) => ({ protocolNumber: g.protocolNumber, longTerm: g.label, ...arrhenius(t, all, g.code) }));
      });
      return {
        scope: 'study' in scope ? 'study' : 'product', item: d.item, kind: kindOf(d.item.of),
        studies: studies.map((s) => ({ id: s.id, studyNo: s.studyNo, lotNo: s.lotNo, protocolNumber: s.doc.header.number, purpose: s.doc.header.purpose })),
        tables: ctdTables(studies, d.tests, mine.map((p) => ({ ...p, oot: trendFlag(p, d.points), ootAnswer: d.ootAnswered.get(`${p.analysisNo}:${p.testKey}`) ?? null }))),
        groups: groups.map((g) => {
          const e = evaluateGroup(g, {});
          return { key: g.key, protocolNumber: g.protocolNumber, label: g.label, storage: storageOf(g.code), studies: g.studies.map((s) => s.studyNo), tests: e.tests,
            contentHash: groupHash(g, scope),
            signRefusal: !mayQa ? 'QA signs the evaluation (the QC approval permission).' : e.tests.find((t) => !t.ok) ? `${e.tests.find((t) => !t.ok)!.name}: ${e.tests.find((t) => !t.ok)!.message}`
              : !g.tests.length ? 'The specification has no stability test with a numeric limit.' : null };
        }),
        arrhenius: arrh,
        toReport: toReport(reports, (lot) => m.get(lot) ?? null).map((r) => ({ ...r, answer: answers.find((a) => a.key === r.key) ?? null })),
        reportRefusal: mayQa ? null : 'QA answers whether a regulator notice is needed (the QC approval permission).',
        evaluations: await signed(sql, d.item, ids),
      };
    } catch (e) { return fail(e, reply); }
  });

  const evalBody = z.object({ scope: scopeSchema, group: z.string().min(1).max(300), answers: answersSchema, transforms: transformsSchema }).strict();

  // The proposal with the decision-tree answers, before signing (nothing is stored).
  app.post('/api/stability/evaluation/preview', reader, async (req, reply) => {
    const b = evalBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', problems: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    try {
      const { groups } = await load(sql, b.data.scope as Scope);
      const g = groups.find((x) => x.key === b.data.group);
      if (!g) throw new EvalError(404, 'not_found', ['There is no such condition to evaluate.']);
      const why = answersRefusal(b.data.answers as L15Extrapolation);
      const e = evaluateGroup(g, b.data.transforms, why ? undefined : b.data.answers as L15Extrapolation);
      return { ...e, answersRefusal: why };
    } catch (e) { return fail(e, reply); }
  });

  // QA signs the evaluation (e-signature "QC approved"): stored with the results as read, the answers and the outputs (LIMS-29).
  app.post('/api/stability/evaluations', qa, async (req, reply) => {
    const b = evalBody.merge(signBody).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', problems: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    const user = req.user!;
    const scope = b.data.scope as Scope;
    const answers = b.data.answers as L15Extrapolation;
    try {
      const signer = await authenticateSigner(sql, app.proofKey, user, { proof: b.data.proof }, { objectType: 'stability_evaluation', objectId: 0, meaning: 'qc_approved' });
      return await sql.begin(async (tx) => {
        const { d, groups } = await load(tx, scope);
        const g = groups.find((x) => x.key === b.data.group);
        if (!g) throw new EvalError(404, 'not_found', ['There is no such condition to evaluate.']);
        if (b.data.contentHash !== groupHash(g, scope)) throw new EvalError(409, 'content_changed', ['The results changed since you opened the evaluation.']);
        const why = answersRefusal(answers);
        if (why) throw new EvalError(409, 'not_ready', [why]);
        const e = evaluateGroup(g, b.data.transforms, answers);
        if (e.proposal.months === null) throw new EvalError(409, 'not_ready', [e.proposal.why]);
        const inputs = { ...groupInputs(g, scope), answers, transforms: b.data.transforms };
        const outputs = { tests: e.tests, proposal: e.proposal };
        const item = { of: d.item.of, itemId: d.item.itemId, code: d.item.code, name: d.item.name };
        const [row] = await tx<{ id: number }[]>`
          insert into stability_evaluations (scope, item, protocol_master_id, condition, study_ids, kind, months, inputs, outputs, person_id)
          values (${'study' in scope ? 'study' : 'product'}, ${tx.json(item as never)}, ${g.protocolMasterId}, ${g.label}, ${g.studies.map((s) => s.id)},
            ${kindOf(d.item.of)}, ${e.proposal.months}, ${tx.json(inputs as never)}, ${tx.json(outputs as never)}, ${user.id}) returning id::int`;
        const content = { evaluation: row!.id, ...inputs, proposal: e.proposal };
        await sign(tx, { signer, objectType: 'stability_evaluation', objectId: row!.id, meaning: 'qc_approved', content, shownHash: contentHash('stability_evaluation', row!.id, content) });
        await audit(tx, { actorId: user.id, action: 'stability.evaluation_signed', objectType: 'stability_evaluation', objectId: row!.id,
          new: { item: item.code, condition: g.label, studies: inputs.studies, kind: kindOf(d.item.of), months: e.proposal.months } });
        return { ok: true, id: row!.id, months: e.proposal.months };
      });
    } catch (e) { return fail(e, reply); }
  });

  // QA's answer to a result to be reported (LIMS-29): is a regulator notice needed (yes or no), with the reference or why
  // not. The app never sends it.
  app.post('/api/stability/report-answers', qa, async (req, reply) => {
    const b = z.object({ of: z.enum(['product', 'material']), itemId: z.string().min(1).max(100), key: z.string().min(1).max(200), needed: z.boolean(),
      text: z.string().trim().min(1).max(1000) }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', problems: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    try {
      return await sql.begin(async (tx) => {
        const d = await itemData(tx, b.data);
        const r = d?.reports.find((x) => x.key === b.data.key);
        if (!d || !r) throw new EvalError(404, 'not_found', ['There is no such result to report.']);
        const [a] = await tx<{ id: number }[]>`
          insert into stability_report_answers (key, item, study_id, needed, text, person_id)
          values (${b.data.key}, ${tx.json({ of: d.item.of, itemId: d.item.itemId, code: d.item.code } as never)}, ${r.studyId}, ${b.data.needed}, ${b.data.text}, ${req.user!.id})
          on conflict (key) do nothing returning id::int`;
        if (!a) throw new EvalError(409, 'already_answered', ['QA has already answered this.']);
        await audit(tx, { actorId: req.user!.id, action: 'stability.report_answered', objectType: 'stability_study', objectId: r.studyId, new: { key: b.data.key, needed: b.data.needed, text: b.data.text } });
        return { ok: true, id: a.id };
      });
    } catch (e) { return fail(e, reply); }
  });

  // The CTD tables (3.2.P.8.3 for a product, 3.2.S.7.3 for a material): per batch and condition, each stability test at each
  // time point, with the specification limits and the signed evaluations. PDF or CSV.
  app.get<{ Querystring: Record<string, string> }>('/api/stability/ctd', reader, async (req, reply) => {
    const parsed = z.object({ of: z.enum(['product', 'material']), itemId: z.string().min(1).max(100), format: z.enum(['pdf', 'csv']) }).strict().safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const { format, ...item } = parsed.data;
    try {
      const { d } = await load(sql, item);
      const tables = ctdTables(d.studies, d.tests, d.points.map((p) => ({ ...p, oot: trendFlag(p, d.points), ootAnswer: d.ootAnswered.get(`${p.analysisNo}:${p.testKey}`) ?? null })));
      const evaluations = await signed(sql, d.item, d.studies.map((s) => s.id));
      const name = `CTD-${d.item.of === 'material' ? '3.2.S.7.3' : '3.2.P.8.3'}-${d.item.code}`;
      if (format === 'csv') {
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}.csv"`)
          .send(ctdCsv(d.item, tables, evaluations));
      }
      return sendPdf(reply, name, await render(ctdDoc(d.item, tables, evaluations, req.user!.fullName, new Date(), app.demo)));
    } catch (e) { return fail(e, reply); }
  });
}
