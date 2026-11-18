import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { identityContainers, limitText, purposeLimits, type SpecDoc } from '../../shared/master/spec.js';
import { openOutsideOos } from './oos.js';
import { outsideCheckRefusal, outsideEntryRefusal, outsideFigure } from '../../shared/engine/outside.js';
import { sampleDecision, type SampleEvent } from '../../shared/engine/sample.js';
import type { TestResult } from './analyses.js';

// LIMS-22: tests done by an outside (contract) lab, stated in the QC record (shared/engine/outside.ts). The lab's report
// is named by its file, size and SHA-256 (worked out here from its bytes; the file is not kept, the report is the lab's
// record); its result is typed from the report and counts once a second person has checked it.

/** At most 8 MB: a lab's report as a PDF or scan. */
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;

interface Row { id: number; testKey: string; oosOutcome: string | null; lab: string; reportNo: string; fileName: string; size: number; sha256: string; value: string | null; unit: string; conforms: boolean | null;
  enteredBy: number; enteredByName: string; enteredAt: Date; checkedBy: number | null; checkedByName: string | null; checkedAt: Date | null }

async function rows(q: Sql | Tx, sampleId: number, id?: number) {
  return q<Row[]>`
    select o.id::int, o.test_key as "testKey", o.lab, o.report_no as "reportNo", o.file_name as "fileName", o.size, o.sha256, o.value, o.unit, o.conforms,
      o.entered_by::int as "enteredBy", u.full_name as "enteredByName", o.entered_at as "enteredAt",
      c.person_id::int as "checkedBy", cu.full_name as "checkedByName", c.at as "checkedAt",
      (select e.payload->>'outcome' from oos x join oos_events e on e.oos_id = x.id and e.kind = 'concluded' where x.outside_result_id = o.id) as "oosOutcome"
    from outside_results o join users u on u.id = o.entered_by
      left join outside_result_checks c on c.result_id = o.id left join users cu on cu.id = c.person_id
    where o.sample_id = ${sampleId} and (${id ?? null}::bigint is null or o.id = ${id ?? null}) order by o.id`;
}

/** The outside results of a sample as test results (sampleTestResults): reviewed once checked; the report number in place of the analysis number. */
export async function outsideResults(q: Sql | Tx, sampleId: number): Promise<{ testKey: string; result: TestResult }[]> {
  const list = await rows(q, sampleId);
  if (!list.length) return [];
  const [s] = await q<{ purpose: string; spec: SpecDoc }[]>`select s.purpose, v.doc as spec from samples s join master_versions v on v.id = s.spec_version_id where s.id = ${sampleId}`;
  return list.flatMap((o) => {
    const t = s!.spec.tests.find((x) => x.key === o.testKey);
    const f = t && outsideFigure(t, s!.purpose, { ...(o.value !== null ? { value: o.value, unit: o.unit } : {}), ...(o.conforms !== null ? { conforms: o.conforms } : {}) });
    if (!f || 'problem' in f) return [];
    return [{ testKey: o.testKey, result: {
      // LIMS-24: invalidated by QA in its OOS investigation, it stays on the record and no longer counts.
      analysisId: 0, analysisNo: o.reportNo, status: o.oosOutcome === 'invalidated' ? 'invalidated' : o.checkedBy !== null ? 'reviewed' : 'waiting for check', method: `Outside lab: ${o.lab}`,
      people: [o.enteredBy, ...(o.checkedBy !== null ? [o.checkedBy] : [])], openDeviations: 0, reviewedAt: o.checkedAt, result: f,
      outside: { id: o.id, lab: o.lab, reportNo: o.reportNo, fileName: o.fileName, size: o.size, sha256: o.sha256, enteredBy: o.enteredByName, enteredAt: o.enteredAt, checkedBy: o.checkedByName, checkedAt: o.checkedAt },
    } satisfies TestResult }];
  });
}

const text = (max = 200) => z.string().trim().min(1).max(max);
const entryBody = z.object({
  test: text(60), lab: text(200), reportNo: text(60),
  // The report as the browser read it: its name and its bytes in base64.
  file: z.object({ name: text(255), content: z.string().min(1).max(Math.ceil(MAX_REPORT_BYTES / 3) * 4 + 8) }).strict(),
  value: z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'a number as the report gives it').optional(),
  unit: z.string().trim().max(20).optional(),
  conforms: z.boolean().optional(),
}).strict();

class OutsideError extends Error {
  constructor(public status: number, public problems: string[]) { super(problems[0]); }
}

export function outsideRoutes(app: FastifyInstance, sql: Sql) {
  const load = async (tx: Tx, id: number) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`sample-entry:${id}`}))`;
    const [s] = await tx<{ id: number; purpose: string; containers: number | null; spec: SpecDoc; testKey: string | null }[]>`
      select s.id::int, s.purpose, s.containers, v.doc as spec, s.monitoring->>'testKey' as "testKey" from samples s join master_versions v on v.id = s.spec_version_id where s.id = ${id}`;
    if (!s) throw new OutsideError(404, ['There is no such sample.']);
    const events = await tx<SampleEvent[]>`select kind, payload, person_id::int as person from sample_events where sample_id = ${id} order by id`;
    return { s, decided: sampleDecision(events) };
  };
  const fail = (e: unknown, reply: import('fastify').FastifyReply) => {
    if (e instanceof OutsideError) return reply.code(e.status).send({ error: 'refused', problems: e.problems, message: e.problems[0] });
    throw e;
  };

  // Enter an outside lab's result for a test of the sample, from its report (the analyst).
  app.post<{ Params: { id: string } }>('/api/samples/:id/outside', { preHandler: requirePermission('lims.analysis.perform'), bodyLimit: Math.ceil(MAX_REPORT_BYTES / 3) * 4 + 64 * 1024 }, async (req, reply) => {
    const id = parseId(req.params.id);
    const b = entryBody.safeParse(req.body);
    if (id === null || !b.success) return reply.code(400).send({ error: 'invalid', problems: b.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
    const bytes = Buffer.from(b.data.file.content, 'base64');
    if (!bytes.length) return reply.code(400).send({ error: 'invalid', problems: ['The report file is empty.'] });
    if (bytes.length > MAX_REPORT_BYTES) return reply.code(400).send({ error: 'invalid', problems: [`The report is larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB.`] });
    const user = req.user!;
    try {
      return await sql.begin(async (tx) => {
        const { s, decided } = await load(tx, id);
        const t = s.spec.tests.find((x) => x.key === b.data.test);
        const on = purposeLimits(s.purpose);
        const applies = !!t && (t.use === 'release and stability' || t.use === on) && (s.testKey === null || t.key === s.testKey);
        const no = outsideEntryRefusal(t, applies, identityContainers(s.spec, s.purpose, s.containers) !== null, decided);
        if (no) throw new OutsideError(409, [no]);
        const f = outsideFigure(t!, s.purpose, { ...(b.data.value !== undefined ? { value: b.data.value, unit: b.data.unit ?? '' } : {}), ...(b.data.conforms !== undefined ? { conforms: b.data.conforms } : {}) });
        if ('problem' in f) throw new OutsideError(409, [f.problem]);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const [r] = await tx<{ id: number }[]>`
          insert into outside_results (sample_id, test_key, lab, report_no, file_name, size, sha256, value, unit, conforms, entered_by)
          values (${id}, ${t!.key}, ${b.data.lab}, ${b.data.reportNo}, ${b.data.file.name}, ${bytes.length}, ${sha256}, ${b.data.value ?? null}, ${b.data.value !== undefined ? b.data.unit ?? '' : ''},
            ${b.data.conforms ?? null}, ${user.id}) returning id::int`;
        await audit(tx, { actorId: user.id, action: 'sample.outside_result', objectType: 'sample', objectId: id,
          new: { result: r!.id, test: t!.key, lab: b.data.lab, reportNo: b.data.reportNo, file: b.data.file.name, size: bytes.length, sha256, shown: f.shown } });
        return { ok: true, id: r!.id, sha256, shown: f.shown };
      });
    } catch (e) { return fail(e, reply); }
  });

  // A second person checks the typed result against the report (the reviewer).
  app.post<{ Params: { id: string; rid: string } }>('/api/samples/:id/outside/:rid/check', { preHandler: requirePermission('lims.analysis.review') }, async (req, reply) => {
    const id = parseId(req.params.id);
    const rid = parseId(req.params.rid);
    if (id === null || rid === null) return reply.code(404).send({ error: 'not_found' });
    const user = req.user!;
    try {
      return await sql.begin(async (tx) => {
        const { s, decided } = await load(tx, id);
        const [o] = await rows(tx, id, rid);
        if (!o) throw new OutsideError(404, ['There is no such outside result of this sample.']);
        const no = outsideCheckRefusal({ enteredBy: o.enteredBy, checked: o.checkedBy !== null }, user.id, decided);
        if (no) throw new OutsideError(no.startsWith('The person') ? 403 : 409, [no]);
        await tx`insert into outside_result_checks (result_id, person_id) values (${rid}, ${user.id})`;
        await audit(tx, { actorId: user.id, action: 'sample.outside_checked', objectType: 'sample', objectId: id, new: { result: rid, reportNo: o.reportNo, sha256: o.sha256 } });
        // LIMS-23: out of its limit, it opens an OOS as the lab's own result does.
        const t = s.spec.tests.find((x) => x.key === o.testKey)!;
        const f = outsideFigure(t, s.purpose, { ...(o.value !== null ? { value: o.value, unit: o.unit } : {}), ...(o.conforms !== null ? { conforms: o.conforms } : {}) });
        const oosNo = !('problem' in f) && f.pass === false ? await openOutsideOos(tx, { id: rid, sampleId: id, testKey: t.key, testName: t.name, limit: limitText(t, purposeLimits(s.purpose)),
          value: f.value, unit: f.unit, line: f.shown, reportNo: o.reportNo }, user.id) : null;
        return { ok: true, ...(oosNo ? { oosNo } : {}) };
      });
    } catch (e) { return fail(e, reply); }
  });
}
