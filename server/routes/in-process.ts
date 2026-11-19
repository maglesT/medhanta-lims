import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { requirePermission } from '../auth.js';
import { usableItem } from '../master.js';
import type { LabRequest } from '../links.js';
import { EDITION_NAME, TB_EDITIONS, type Edition } from '../../shared/engine/links.js';
import type { SpecDoc } from '../../shared/master/spec.js';
import { effectiveSpecs, newSample, type SampleRequest } from './samples.js';
import { plantClock } from '../../shared/plant-time.js';

// In-process samples (owner 19 Nov 2026): a TrueBatch step with in-process QC fields opens a lab request
// (lab_request_v1, every edition); the analyst makes the sample by picking an open request: nothing is typed. It is
// tested against the product's effective in-process specification, for the tests whose TrueBatch field the request
// names (each spec test's `ipcField`); then received, analysed, reviewed and approved as any sample, numbered as an
// in-process test report (server/routes/samples.ts). The request stays TrueBatch's: LIMS keeps it as read.

class IpcError extends Error {
  constructor(public status: number, public problems: string[]) { super(problems[0]); }
}

/** Why an in-process sample cannot be made of this request with this specification; empty when it can. */
export function requestProblems(r: LabRequest, spec: SpecDoc | null): string[] {
  if (r.status !== 'open') return [`Request ${r.requestId} is ${r.status} in TrueBatch: only an open request is tested.`];
  if (!spec) return [`No effective in-process specification for ${r.productCode}: QA makes one effective first.`];
  if (!r.tests.length) return [`Request ${r.requestId} names no test.`];
  const missing = r.tests.filter((t) => !spec.tests.some((x) => x.ipcField === t.name));
  return missing.length ? [`Specification ${spec.header.number} has no test for ${missing.map((t) => `${t.label} (${t.name})`).join(', ')}: add it in a new version.`] : [];
}

async function inProcessSpec(q: Sql | Tx, productCode: string) {
  const specs = (await effectiveSpecs(q, 'product', productCode)).filter((s) => s.header.type === 'In-process');
  if (!specs.length) return null;
  const [v] = await q<{ id: number; versionNo: number; doc: SpecDoc }[]>`select id::int, version_no as "versionNo", doc from master_versions where id = ${specs[0]!.id}`;
  return v ?? null;
}
const made = async (q: Sql | Tx, edition: string, requestId: string) => {
  const [s] = await q<{ id: number; sampleNo: string }[]>`select id::int, sample_no as "sampleNo" from samples where request->>'edition' = ${edition} and request->>'requestId' = ${requestId}`;
  return s ?? null;
};

export function inProcessRoutes(app: FastifyInstance, sql: Sql) {
  const picker = { preHandler: requirePermission('lims.sample.register', 'lims.analysis.perform') };

  // The open lab requests of every TrueBatch edition, oldest first: each with the specification it is tested against
  // (or why it cannot be), and its sample once made.
  app.get('/api/lab-requests', picker, async () => {
    const r = await app.links.truebatch.openRequests();
    if (r.state !== 'ok') return { link: r.state, requests: [] };
    const requests = [];
    for (const x of r.value) {
      const spec = await inProcessSpec(sql, x.productCode);
      requests.push({ ...x, editionName: EDITION_NAME[x.edition], requestedShown: plantClock(x.requestedAt, true),
        spec: spec ? { id: spec.id, number: spec.doc.header.number, versionNo: spec.versionNo } : null, problems: requestProblems(x, spec?.doc ?? null),
        sample: await made(sql, x.edition, x.requestId) });
    }
    return { link: r.state, requests };
  });

  // The in-process fields a product's requests have named, for the specification editor's pick list.
  app.get<{ Querystring: { product?: string } }>('/api/lab-requests/fields', { preHandler: requirePermission('lims.master.author', 'lims.master.check', 'lims.master.approve') }, async (req) => {
    const r = await app.links.truebatch.requestFields(String(req.query.product ?? ''));
    return { link: r.state, fields: r.state === 'ok' ? r.value : [] };
  });

  // Make the in-process sample of an open request (picked, nothing typed).
  app.post('/api/samples/in-process', picker, async (req, reply) => {
    const b = z.object({ edition: z.enum(TB_EDITIONS), requestId: z.string().trim().min(1).max(200), quantity: z.string().trim().min(1).max(60).regex(/^\d+(\.\d+)?\s*\S.*$/, 'give the quantity with its unit, e.g. 20 tablets') })
      .strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', problems: b.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    const user = req.user!;
    try {
      const read = await app.links.truebatch.request(b.data.edition, b.data.requestId);
      if (read.state !== 'ok') throw new IpcError(409, [`${EDITION_NAME[b.data.edition as Edition]} ${read.state === 'down' ? 'does not answer' : 'is not linked'} now: an in-process sample is made from its request; try again when it answers.`]);
      const r = read.value;
      if (!r) throw new IpcError(404, [`Request ${b.data.requestId} is not in ${EDITION_NAME[b.data.edition as Edition]}.`]);
      const product = (await app.master.products()).find((p) => p.code === r.productCode);
      if (!product) throw new IpcError(409, [`Product ${r.productCode} of request ${r.requestId} is not in master data.`]);
      const m = usableItem([product], product.itemId, 'product');
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`request:${r.edition}:${r.requestId}`}))`;
        const twice = await made(tx, r.edition, r.requestId);
        if (twice) throw new IpcError(409, [`Request ${r.requestId} already has its sample ${twice.sampleNo}.`]);
        const spec = await inProcessSpec(tx, r.productCode);
        const problems = requestProblems(r, spec?.doc ?? null);
        if (problems.length) throw new IpcError(409, problems);
        const request: SampleRequest = { edition: r.edition, requestId: r.requestId, batchNo: r.batchNo, stageTitle: r.stageTitle, stepKey: r.stepKey, stepTitle: r.stepTitle,
          tests: r.tests, requestedAt: r.requestedAt };
        return newSample(tx, user.id, { specVersionId: spec!.id, purpose: 'in_process', lotNo: r.batchNo, item: { of: 'product', itemId: m.itemId, code: m.code, name: m.name },
          source: { from: 'truebatch', asOf: r.requestedAt, shown: `${EDITION_NAME[r.edition]} batch ${r.batchNo}, request ${r.requestId}: ${[r.stageTitle, r.stepTitle].filter(Boolean).join(' › ')}` },
          quantity: b.data.quantity, containers: null, request });
      });
    } catch (e) {
      if (e instanceof IpcError) return reply.code(e.status).send({ error: 'refused', problems: e.problems, message: e.problems[0] });
      throw e;
    }
  });
}
