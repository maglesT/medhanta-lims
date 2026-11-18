import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { FORM_OUTCOMES, formRefusal, formState, type FormEntry } from '../../shared/engine/forms.js';
import { sampleStatus, type SampleEvent } from '../../shared/engine/sample.js';
import { isHand } from '../../shared/engine/links.js';
import { testsFor, type SpecDoc } from '../../shared/master/spec.js';
import type { MasterDoc } from '../../shared/master/schema.js';
import { blankFormDoc, labelsDoc } from '../labels.js';
import { render, sendPdf } from '../pdf.js';
import { loadSampleRow } from './samples.js';

// LIMS-54: blank worksheets issued for paper, numbered and reconciled (shared/engine/forms.ts); LIMS-06: the sample's
// labels. Both printed from the record.

const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';
export const FORM_PREFIX = 'LF';

export interface FormRow { id: number; formNo: string; sampleId: number; sampleNo: string; methodVersionId: number; methodMasterId: number; methodCode: string; methodName: string;
  versionNo: number; reason: string; issuedBy: number; issuedByName: string; issuedAt: Date; entry: (FormEntry & { personName: string; at: Date }) | null }

export async function loadForms(q: Sql | Tx, where: { sampleId?: number; id?: number; open?: boolean }) {
  const list = await q<FormRow[]>`
    select f.id::int, f.form_no as "formNo", f.sample_id::int as "sampleId", s.sample_no as "sampleNo", f.method_version_id::int as "methodVersionId",
      v.master_id::int as "methodMasterId", v.doc->'header'->>'code' as "methodCode", v.doc->'header'->>'name' as "methodName", v.version_no as "versionNo",
      f.reason, f.issued_by::int as "issuedBy", u.full_name as "issuedByName", f.issued_at as "issuedAt",
      (select json_build_object('kind', e.kind, 'payload', e.payload, 'personName', eu.full_name, 'at', e.at) from issued_form_events e join users eu on eu.id = e.person_id where e.form_id = f.id) as entry
    from issued_forms f join samples s on s.id = f.sample_id join master_versions v on v.id = f.method_version_id join users u on u.id = f.issued_by
    where (${where.sampleId ?? null}::bigint is null or f.sample_id = ${where.sampleId ?? null}) and (${where.id ?? null}::bigint is null or f.id = ${where.id ?? null})
      and (not ${where.open ?? false} or not exists (select 1 from issued_form_events e where e.form_id = f.id))
    order by f.id desc limit 1000`;
  return list.map((f) => ({ ...f, state: formState(f.entry) }));
}

class FormError extends Error {
  constructor(public status: number, public problems: string[]) { super(problems[0]); }
}
const text = (max = 500) => z.string().trim().min(1).max(max);

export function formRoutes(app: FastifyInstance, sql: Sql) {
  const reader = { preHandler: requirePermission('lims.sample.register', 'lims.view', 'lims.analysis.perform') };
  const perform = { preHandler: requirePermission('lims.analysis.perform') };
  const fail = (e: unknown, reply: import('fastify').FastifyReply) => {
    if (e instanceof FormError) return reply.code(e.status).send({ error: 'refused', problems: e.problems, message: e.problems[0] });
    throw e;
  };

  // LIMS-06: the sample's label and a label for each container sampled, as a PDF.
  app.get<{ Params: { id: string } }>('/api/samples/:id/labels', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const s = id === null ? null : await loadSampleRow(sql, id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const [v] = await sql<{ versionNo: number; number: string }[]>`select version_no as "versionNo", doc->'header'->>'number' as number from master_versions where id = ${s.specVersionId}`;
    return sendPdf(reply, `labels-${s.sampleNo}`, await render(labelsDoc(s, v!, req.user!.fullName, new Date(), app.demo)));
  });

  // The reconciliation list: every issued form, or (?open=1) those not back yet.
  app.get<{ Querystring: { open?: string } }>('/api/forms', reader, async (req) => loadForms(sql, { open: req.query.open === '1' }));

  // Issue a numbered blank worksheet of an effective method version that does a test of the sample, with the reason.
  app.post<{ Params: { id: string } }>('/api/samples/:id/forms', perform, async (req, reply) => {
    const id = parseId(req.params.id);
    const b = z.object({ masterVersionId: z.number().int().positive(), reason: text() }).strict().safeParse(req.body);
    if (id === null || !b.success) return reply.code(400).send({ error: 'invalid', problems: b.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    const user = req.user!;
    try {
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`sample-entry:${id}`}))`;
        const [s] = await tx<{ sampleNo: string; purpose: string; registeredBy: number; source: never; spec: SpecDoc }[]>`
          select s.sample_no as "sampleNo", s.purpose, s.registered_by::int as "registeredBy", s.source, v.doc as spec from samples s join master_versions v on v.id = s.spec_version_id where s.id = ${id}`;
        if (!s) throw new FormError(404, ['There is no such sample.']);
        const events = await tx<SampleEvent[]>`select kind, payload, person_id::int as person from sample_events where sample_id = ${id} order by id`;
        const status = sampleStatus({ registeredBy: s.registeredBy, byHand: isHand(s.source) }, events);
        if (!['received', 'stored', 'handed over'].includes(status)) throw new FormError(409, [`Sample ${s.sampleNo} is ${status}: a worksheet is issued once QC has received it.`]);
        if (events.some((e) => e.kind === 'approved' || e.kind === 'rejected')) throw new FormError(409, [`QC has already decided on sample ${s.sampleNo}.`]);
        const [m] = await tx<{ masterId: number; state: string; kind: string; code: string }[]>`
          select master_id::int as "masterId", state, kind, doc->'header'->>'code' as code from master_versions where id = ${b.data.masterVersionId}`;
        if (m?.kind !== 'method' || m.state !== 'effective') throw new FormError(409, ['Only an effective method version is issued as a blank worksheet.']);
        if (!testsFor(s.spec, m.masterId, s.purpose).length) throw new FormError(409, [`The specification of sample ${s.sampleNo} has no test done by method ${m.code}.`]);
        const [c] = await tx<{ n: number; yy: string }[]>`
          insert into issued_form_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
          on conflict (year) do update set last_no = issued_form_counters.last_no + 1 returning last_no as n, right(year::text, 2) as yy`;
        const formNo = `${FORM_PREFIX}${c!.yy}${String(c!.n).padStart(5, '0')}`;
        const [f] = await tx<{ id: number }[]>`
          insert into issued_forms (form_no, sample_id, method_version_id, reason, issued_by) values (${formNo}, ${id}, ${b.data.masterVersionId}, ${b.data.reason}, ${user.id}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'form.issued', objectType: 'issued_form', objectId: f!.id, new: { formNo, sample: s.sampleNo, method: m.code, reason: b.data.reason } });
        return { ok: true, id: f!.id, formNo };
      });
    } catch (e) { return fail(e, reply); }
  });

  // The blank worksheet as a PDF; each print is in the audit trail (a copy is traceable to who printed it and when).
  app.get<{ Params: { id: string } }>('/api/forms/:id/pdf', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const [f] = id === null ? [] : await loadForms(sql, { id });
    if (!f) return reply.code(404).send({ error: 'not_found' });
    const s = (await loadSampleRow(sql, f.sampleId))!;
    const [m] = await sql<{ doc: MasterDoc; versionNo: number }[]>`select doc, version_no as "versionNo" from master_versions where id = ${f.methodVersionId}`;
    await audit(sql, { actorId: req.user!.id, action: 'form.printed', objectType: 'issued_form', objectId: f.id, new: { formNo: f.formNo } });
    return sendPdf(reply, `form-${f.formNo}`, await render(blankFormDoc(f, s, m!, req.user!.fullName, new Date(), app.demo)));
  });

  // The form comes back: used (transcribed into an analysis of the sample by the form's method) or unused; or voided.
  for (const action of ['return', 'void'] as const) {
    app.post<{ Params: { id: string } }>(`/api/forms/:id/${action}`, perform, async (req, reply) => {
      const id = parseId(req.params.id);
      const b = (action === 'return' ? z.object({ outcome: z.enum(FORM_OUTCOMES), analysisNo: text(20).optional() }) : z.object({ reason: text() })).strict().safeParse(req.body);
      if (id === null || !b.success) return reply.code(400).send({ error: 'invalid', problems: b.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
      const input = b.data as FormEntry['payload'];
      const user = req.user!;
      try {
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext(${`form:${id}`}))`;
          const [f] = await loadForms(tx, { id });
          if (!f) throw new FormError(404, ['There is no such form.']);
          const analyses = await tx<{ analysisNo: string; methodMasterId: number }[]>`
            select a.analysis_no as "analysisNo", v.master_id::int as "methodMasterId" from analyses a join master_versions v on v.id = a.master_version_id where a.sample_id = ${f.sampleId}`;
          const no = formRefusal(action, f.entry, input, f, analyses);
          if (no) throw new FormError(409, [no]);
          const payload = action === 'return' ? { outcome: input.outcome, ...(input.outcome === 'used' ? { analysisNo: input.analysisNo!.trim() } : {}) } : { reason: input.reason };
          await tx`insert into issued_form_events (form_id, kind, payload, person_id) values (${id}, ${action === 'return' ? 'returned' : 'voided'}, ${tx.json(payload as never)}, ${user.id})`;
          await audit(tx, { actorId: user.id, action: `form.${action === 'return' ? 'returned' : 'voided'}`, objectType: 'issued_form', objectId: id, old: { state: f.state }, new: { formNo: f.formNo, ...payload }, reason: input.reason ?? null });
          return { ok: true };
        });
      } catch (e) { return fail(e, reply); }
    });
  }
}
