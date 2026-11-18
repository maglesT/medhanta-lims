import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';
import { loadAnalysis } from './analyses.js';
import { render, sendPdf } from '../pdf.js';
import { methodReportDoc, type ReportForPdf, type SignatureRow } from '../method-report-pdf.js';
import { findBlock } from '../../shared/blocks/index.js';
import { analysisView, openSteps, stepTitle } from '../../shared/engine/index.js';
import type { MasterDoc } from '../../shared/master/schema.js';
import {
  REPORT_KINDS, TEST_TYPES, conclude, findings, kindRefusal, methodUse, reportRefusal, reportStatus,
  type ReportFacts, type ReportKind, type TestType, type ValidationStep,
} from '../../shared/engine/method-validation.js';

const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';

// Method validation, verification and transfer reports (plan 2.12; LIMS-02, LIMS-04). A report reads the validation
// results of reviewed worksheet analyses (pull, don't type), concludes per characteristic (shared/engine/
// method-validation.ts), and is signed by its preparer, reviewed by QC and approved by QA. Making a method version
// effective needs an approved report (masters.ts, `useRefusal`).

class ReportError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}
function fail(e: unknown, reply: FastifyReply) {
  if (e instanceof ReportError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
  if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
  throw e;
}
const invalid = (reply: FastifyReply, issues?: z.ZodIssue[]) => reply.code(400).send({ error: 'invalid', problems: (issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`) });

interface ReportRow {
  id: number; reportNo: string; kind: ReportKind; outside: boolean; methodMasterId: number; methodVersionId: number; methodVersionNo: number; testType: string;
  reference: string; sendingLab: string | null; receivingLab: string | null; analysisIds: number[]; inputs: unknown; outputs: unknown; conclusion: 'met' | 'not met';
  remarks: string; personId: number; personName: string; at: Date; code: string; name: string; origin: string;
}
interface EventRow { id: number; reportId: number; kind: 'reviewed' | 'approved'; person: number; personName: string; at: Date }

async function reports(q: Sql | Tx, where: { masterId?: number; id?: number } = {}): Promise<(ReportRow & { events: EventRow[] })[]> {
  const rows = await q<ReportRow[]>`
    select r.id::int, r.report_no as "reportNo", r.kind, r.outside, r.method_master_id::int as "methodMasterId", r.method_version_id::int as "methodVersionId",
      r.method_version_no as "methodVersionNo", r.test_type as "testType", r.reference, r.sending_lab as "sendingLab", r.receiving_lab as "receivingLab",
      r.analysis_ids::int[] as "analysisIds", r.inputs, r.outputs, r.conclusion, r.remarks, r.person_id::int as "personId", u.full_name as "personName", r.at,
      v.doc->'header'->>'code' as code, v.doc->'header'->>'name' as name, coalesce(v.doc->'header'->>'origin', 'in-house') as origin
    from method_reports r join users u on u.id = r.person_id join master_versions v on v.id = r.method_version_id
    where (${where.masterId ?? null}::bigint is null or r.method_master_id = ${where.masterId ?? null}) and (${where.id ?? null}::bigint is null or r.id = ${where.id ?? null})
    order by r.id desc`;
  const events = rows.length ? await q<EventRow[]>`
    select e.id::int, e.report_id::int as "reportId", e.kind, e.person_id::int as person, u.full_name as "personName", e.at
    from method_report_events e join users u on u.id = e.person_id where e.report_id = any(${rows.map((r) => r.id)}) order by e.id` : [];
  return rows.map((r) => ({ ...r, events: events.filter((e) => e.reportId === r.id) }));
}
const facts = (r: ReportRow & { events: EventRow[] }): ReportFacts => ({ id: r.id, kind: r.kind, outside: r.outside, methodVersionNo: r.methodVersionNo,
  conclusion: r.conclusion, preparedBy: r.personId, events: r.events.map((e) => ({ kind: e.kind, person: e.person })) });

/** The report's signatures in order: prepared, reviewed (QC), approved (QA). */
export async function reportSignatures(q: Sql | Tx, r: { id: number; events: { id: number }[] }): Promise<SignatureRow[]> {
  return [...await q<SignatureRow[]>`
    select meaning, printed_name as "printedName", signed_at as "signedAt" from signatures
    where (object_type = 'method_report' and object_id = ${r.id}) or (object_type = 'method_report_event' and object_id = any(${r.events.map((e) => e.id)}))
    order by signed_at, id`];
}
/** The stored report as the PDF reads it (tests: it is made again from stored data). */
export async function storedReport(q: Sql | Tx, id: number) {
  const r = (await reports(q, { id }))[0];
  return r ? { report: r as unknown as ReportForPdf, signatures: await reportSignatures(q, r) } : null;
}

/** The reports of a method, as the LIMS-02/04 check reads them (masters.ts). */
export async function methodReportFacts(q: Sql | Tx, masterId: number): Promise<ReportFacts[]> {
  return (await reports(q, { masterId })).map(facts);
}

/** The validation steps of reviewed worksheet analyses: each step's result from its last signed round. */
async function validationSteps(q: Sql | Tx, ids: readonly number[]): Promise<ValidationStep[]> {
  const out: ValidationStep[] = [];
  for (const id of ids) {
    const l = await loadAnalysis(q, id);
    if (!l) throw new ReportError(404, 'no_such_analysis', [`There is no analysis ${id}.`]);
    if (l.doc.header.use !== 'validation') throw new ReportError(409, 'not_a_worksheet', [`${l.analysis.analysisNo} is not an analysis of a validation worksheet.`]);
    const status = analysisView(l.doc, l.events, l.analysisEvents, l.now).status;
    if (status !== 'reviewed') throw new ReportError(409, 'not_reviewed', [`${l.analysis.analysisNo} is ${status}: a report covers reviewed analyses only.`]);
    const { steps } = openSteps(l.doc, l.events, l.now);
    l.doc.stages.forEach((stage, si) => stage.steps.forEach((st, ti) => {
      if (!['specificity', 'linearity', 'accuracy', 'precision', 'lod-loq', 'signal-to-noise', 'robustness', 'transfer-comparison'].includes(st.block.id)) return;
      const done = steps.filter((x) => x.key.stage === si && x.key.step === ti && ['done', 'checked'].includes(x.state)).at(-1);
      out.push({ analysisNo: l.analysis.analysisNo, step: `${l.doc.header.code} ${stepTitle(l.doc, st)}`, block: st.block.id, settings: st.settings as Record<string, unknown>,
        result: done?.results.result });
    }));
  }
  return out;
}

interface Draft { kind: ReportKind; methodVersionId: number; testType: TestType; analysisIds: number[] }
async function work(q: Sql | Tx, b: Draft) {
  const [v] = await q<{ id: number; masterId: number; versionNo: number; state: string; kind: string; doc: MasterDoc }[]>`
    select id::int, master_id::int as "masterId", version_no as "versionNo", state, kind, doc from master_versions where id = ${b.methodVersionId}`;
  if (!v || v.kind !== 'method') throw new ReportError(404, 'no_such_method', ['There is no such method version.']);
  if (!['approved', 'effective'].includes(v.state)) throw new ReportError(409, 'not_approved', [`Version ${v.versionNo} of ${v.doc.header.code} is ${v.state.replace('_', ' ')}: a report is on an approved (or effective) version.`]);
  const no = kindRefusal(v.doc.header.origin, v.doc.header.use, b.kind);
  if (no) throw new ReportError(409, 'wrong_kind', [no]);
  const steps = await validationSteps(q, b.analysisIds);
  const fs = findings(steps);
  const c = conclude(b.kind, b.testType, fs);
  return { v, steps, fs, c, inputs: { analyses: b.analysisIds, steps }, outputs: { findings: fs, ...c } };
}
const draftHash = (b: Draft, outputs: unknown) => contentHash('method_report', 0, { ...b, outputs });

const draftSchema = z.object({
  kind: z.enum(REPORT_KINDS), methodVersionId: z.number().int().positive(), testType: z.enum(TEST_TYPES),
  analysisIds: z.array(z.number().int().positive()).max(50),
}).strict();
const createSchema = draftSchema.extend({
  outside: z.boolean().default(false),
  reference: z.string().trim().min(1).max(200),
  sendingLab: z.string().trim().min(1).max(200).optional(),
  receivingLab: z.string().trim().min(1).max(200).optional(),
  remarks: z.string().trim().max(2000).default(''),
}).merge(signBody.partial({ contentHash: true })).strict();

async function nextNo(tx: Tx): Promise<string> {
  await tx`select pg_advisory_xact_lock(hashtext('method_reports'))`;
  const [c] = await tx<{ n: number; yy: string }[]>`
    select count(*)::int + 1 as n, to_char(now() at time zone ${PLANT_TZ}, 'YY') as yy from method_reports
    where report_no like 'MVR' || to_char(now() at time zone ${PLANT_TZ}, 'YY') || '%'`;
  return `MVR${c!.yy}${String(c!.n).padStart(4, '0')}`;
}

export function methodReportRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };
  const author = { preHandler: requirePermission('lims.master.author') };

  // The reports, and per method its use status (validated / verified / transferred, or not yet: LIMS-02, LIMS-04).
  app.get('/api/method-reports', anyUser, async () => {
    const all = await reports(sql);
    const versions = await sql<{ id: number; masterId: number; versionNo: number; state: string; doc: MasterDoc }[]>`
      select id::int, master_id::int as "masterId", version_no as "versionNo", state, doc from master_versions where kind = 'method' order by master_id, version_no`;
    const methods = versions.map((v) => {
      const u = methodUse(v.doc.header, v.versionNo, all.filter((r) => r.methodMasterId === v.masterId).map(facts));
      const r = u.report && all.find((x) => x.id === u.report!.id);
      return { versionId: v.id, masterId: v.masterId, versionNo: v.versionNo, state: v.state, code: v.doc.header.code, name: v.doc.header.name,
        origin: v.doc.header.origin ?? 'in-house', use: v.doc.header.use ?? 'routine', status: u.status, needs: u.needs, reportNo: r?.reportNo ?? null };
    });
    return {
      reports: all.map((r) => ({ id: r.id, reportNo: r.reportNo, kind: r.kind, outside: r.outside, code: r.code, name: r.name, methodVersionNo: r.methodVersionNo,
        reference: r.reference, conclusion: r.conclusion, status: reportStatus(facts(r)), personName: r.personName, at: r.at })),
      methods,
    };
  });

  // What a new report can cover: the reviewed analyses of validation worksheets.
  app.get('/api/method-reports/analyses', anyUser, async () => {
    const rows = await sql<{ id: number }[]>`
      select a.id::int from analyses a join master_versions v on v.id = a.master_version_id where v.doc->'header'->>'use' = 'validation' order by a.id desc limit 200`;
    const out = [];
    for (const { id } of rows) {
      const l = (await loadAnalysis(sql, id))!;
      const status = analysisView(l.doc, l.events, l.analysisEvents, l.now).status;
      if (status === 'reviewed') out.push({ id, analysisNo: l.analysis.analysisNo, code: l.doc.header.code, name: l.doc.header.name, issuedAt: l.analysis.issuedAt });
    }
    return out;
  });

  // The conclusion before signing (nothing is stored), with the hash the preparer signs.
  app.post('/api/method-reports/preview', anyUser, async (req, reply) => {
    const b = draftSchema.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error.issues);
    try {
      const w = await work(sql, b.data as Draft);
      return { findings: w.fs, conclusion: w.c, contentHash: draftHash(b.data as Draft, w.outputs) };
    } catch (e) { return fail(e, reply); }
  });

  // The preparer signs the report (e-signature "prepared"); outside: the paper validation's number, no analyses.
  app.post('/api/method-reports', author, async (req, reply) => {
    const b = createSchema.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error.issues);
    const d = b.data;
    const user = req.user!;
    try {
      if (d.kind === 'transfer' && (!d.sendingLab || !d.receivingLab)) throw new ReportError(400, 'labs_missing', ['A transfer report names the sending and the receiving laboratory (LIMS-04).']);
      if (d.outside && d.analysisIds.length) throw new ReportError(400, 'outside_with_analyses', ['A validation outside LIMS has no analyses here: give the paper report\'s number.']);
      if (!d.outside && !d.analysisIds.length) throw new ReportError(400, 'no_analyses', ['Choose the reviewed analyses the report covers.']);
      const signer = await authenticateSigner(sql, app.proofKey, user, { proof: d.proof }, { objectType: 'method_report', objectId: 0, meaning: 'prepared' });
      return await sql.begin(async (tx) => {
        const draft: Draft = { kind: d.kind, methodVersionId: d.methodVersionId, testType: d.testType, analysisIds: d.analysisIds };
        let w: Awaited<ReturnType<typeof work>>;
        if (d.outside) {
          const [v] = await tx<{ id: number; masterId: number; versionNo: number; state: string; kind: string; doc: MasterDoc }[]>`
            select id::int, master_id::int as "masterId", version_no as "versionNo", state, kind, doc from master_versions where id = ${d.methodVersionId}`;
          if (!v || v.kind !== 'method') throw new ReportError(404, 'no_such_method', ['There is no such method version.']);
          const no = kindRefusal(v.doc.header.origin, v.doc.header.use, d.kind);
          if (no) throw new ReportError(409, 'wrong_kind', [no]);
          const outputs = { findings: [], characteristics: [], missing: [], met: true, why: `${d.kind} outside LIMS: paper report ${d.reference}` };
          w = { v, steps: [], fs: [], c: outputs, inputs: { analyses: [], steps: [] }, outputs };
        } else {
          w = await work(tx, draft);
          if (d.contentHash !== draftHash(draft, w.outputs)) throw new ReportError(409, 'content_changed', ['The results changed since you opened the report.']);
        }
        const reportNo = await nextNo(tx);
        const conclusion = w.c.met ? 'met' : 'not met';
        const [row] = await tx<{ id: number }[]>`
          insert into method_reports (report_no, kind, outside, method_master_id, method_version_id, method_version_no, test_type, reference, sending_lab, receiving_lab,
            analysis_ids, inputs, outputs, conclusion, remarks, person_id)
          values (${reportNo}, ${d.kind}, ${d.outside}, ${w.v.masterId}, ${w.v.id}, ${w.v.versionNo}, ${d.testType}, ${d.reference}, ${d.sendingLab ?? null}, ${d.receivingLab ?? null},
            ${d.analysisIds}, ${tx.json(w.inputs as never)}, ${tx.json(w.outputs as never)}, ${conclusion}, ${d.remarks}, ${user.id}) returning id::int`;
        const content = { reportNo, kind: d.kind, outside: d.outside, method: w.v.doc.header.code, versionNo: w.v.versionNo, reference: d.reference,
          sendingLab: d.sendingLab ?? null, receivingLab: d.receivingLab ?? null, analyses: d.analysisIds, conclusion, outputs: w.outputs };
        await sign(tx, { signer, objectType: 'method_report', objectId: row!.id, meaning: 'prepared', content, shownHash: contentHash('method_report', row!.id, content) });
        await audit(tx, { actorId: user.id, action: 'method_report.prepared', objectType: 'method_report', objectId: row!.id,
          new: { reportNo, kind: d.kind, outside: d.outside, method: w.v.doc.header.code, versionNo: w.v.versionNo, reference: d.reference, conclusion } });
        return { ok: true, id: row!.id, reportNo, conclusion };
      });
    } catch (e) { return fail(e, reply); }
  });

  const one = async (q: Sql | Tx, id: number) => (await reports(q, { id }))[0];
  const shown = (r: ReportRow & { events: EventRow[] }) => ({ report: r.id, reportNo: r.reportNo, conclusion: r.conclusion, outputs: r.outputs, events: r.events.map((e) => e.id) });

  app.get<{ Params: { id: string } }>('/api/method-reports/:id', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const r = id === null ? undefined : await one(sql, id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const f = facts(r);
    const can = (a: 'review' | 'approve', p: 'lims.analysis.review' | 'lims.master.approve') => (req.user!.permissions.includes(p) ? reportRefusal(a, f, req.user!.id) : 'You do not have the right for this.');
    const blocks = Object.fromEntries((r.inputs as { steps?: ValidationStep[] }).steps?.map((s) => [s.block, findBlock({ id: s.block, version: 1 })?.name ?? s.block]) ?? []);
    return { ...r, status: reportStatus(f), blocks, contentHash: contentHash('method_report', r.id, shown(r)), refusals: { review: can('review', 'lims.analysis.review'), approve: can('approve', 'lims.master.approve') } };
  });

  // The report as the document QA files: made again from the stored report and its signatures.
  app.get<{ Params: { id: string } }>('/api/method-reports/:id/pdf', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const r = id === null ? undefined : await one(sql, id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return sendPdf(reply, r.reportNo, await render(methodReportDoc(r as unknown as ReportForPdf, await reportSignatures(sql, r), req.user!.fullName, new Date(), app.demo)));
  });

  // QC reviews (e-signature "reviewed"), QA approves (e-signature "approved"); each a different person (LIMS-02, LIMS-04).
  for (const [action, meaning, perm] of [['review', 'reviewed', 'lims.analysis.review'], ['approve', 'approved', 'lims.master.approve']] as const) {
    app.post<{ Params: { id: string } }>(`/api/method-reports/:id/${action}`, { preHandler: requirePermission(perm) }, async (req, reply) => {
      const id = parseId(req.params.id);
      const b = signBody.safeParse(req.body);
      if (id === null || !b.success) return invalid(reply, b.error?.issues);
      const user = req.user!;
      try {
        const signer = await authenticateSigner(sql, app.proofKey, user, b.data, { objectType: 'method_report', objectId: id, meaning });
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext('method_report'), ${id}::int)`;
          const r = await one(tx, id);
          if (!r) throw new ReportError(404, 'not_found');
          const no = reportRefusal(action, facts(r), user.id);
          if (no) throw new ReportError(409, 'not_allowed_now', [no]);
          if (b.data.contentHash !== contentHash('method_report', r.id, shown(r))) throw new ReportError(409, 'content_changed', ['The report changed since you opened it.']);
          const [ev] = await tx<{ id: number }[]>`insert into method_report_events (report_id, kind, person_id) values (${id}, ${meaning}, ${user.id}) returning id::int`;
          const content = { ...shown(r), action };
          await sign(tx, { signer, objectType: 'method_report_event', objectId: ev!.id, meaning, content, shownHash: contentHash('method_report_event', ev!.id, content) });
          await audit(tx, { actorId: user.id, action: `method_report.${meaning}`, objectType: 'method_report', objectId: id, new: { event: ev!.id, reportNo: r.reportNo } });
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) { return fail(e, reply); }
    });
  }
}
