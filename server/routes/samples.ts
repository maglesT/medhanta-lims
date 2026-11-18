import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission } from '../auth.js';
import { usableItem } from '../master.js';
import { LOT_WAITING, batchWaiting, type BatchRead, type LotRead } from '../links.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';
import type { SpecDoc } from '../../shared/master/spec.js';
import {
  PROVIDER_NAME, SAMPLE_ACTIONS, SAMPLE_ACTION_NAMES, SAMPLE_PURPOSES, isHand, sampleRefusal, sampleStatus,
  type LinkState, type SampleAction, type SampleEvent, type SamplePurpose, type Source,
} from '../../shared/engine/index.js';
import { plantDate } from '../../shared/plant-time.js';

// Samples (LIMS-05, LIMS-07): registered from an MMS lot or a TrueBatch batch waiting to be sampled (pull, don't type),
// or by hand while that link is absent or down (then checked by a second person, LIMS-50); then received, stored or
// handed over, and disposed of, each an insert-only entry. The status is computed (shared/engine/sample.ts).

// Plant time zone: the sample number's year is the plant's year.
const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';
export const SAMPLE_PREFIX = 'LS';

type Of = 'material' | 'product';
type From = 'mms' | 'truebatch';
const OF: Record<From, Of> = { mms: 'material', truebatch: 'product' };
export interface SampleItem { of: Of; itemId: string; code: string; name: string }
export interface SampleRow {
  id: number; sampleNo: string; specVersionId: number; purpose: SamplePurpose; lotNo: string; item: SampleItem; source: Source;
  quantity: string; containers: number | null; registeredBy: number; registeredByName: string; registeredAt: Date;
}
type EventRow = SampleEvent & { id: number; personName: string; at: Date; signature: { printedName: string; signedAt: Date } | null };

class SampleError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}

/** The effective specifications of a material (by its master-data id) or a product (by its code) (LIMS-01). */
async function effectiveSpecs(q: Sql | Tx, of: Of, key: string) {
  return q<{ id: number; masterId: number; versionNo: number; header: SpecDoc['header'] }[]>`
    select id::int, master_id::int as "masterId", version_no as "versionNo", doc->'header' as header from master_versions
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

const lotShown = (l: LotRead) => `MMS lot ${l.lotNumber}: ${l.materialCode ?? '—'}, ${l.status.replaceAll('_', ' ')}, expiry ${l.expiryDate ? plantDate(l.expiryDate) : '—'}, retest ${l.retestDate ? plantDate(l.retestDate) : '—'}${l.stock ? `, ${l.stock} ${l.unit ?? ''} in stock`.trimEnd() : ''}`;
const batchShown = (b: BatchRead) => `TrueBatch batch ${b.batchNumber}: ${b.productCode ?? '—'}${b.productName ? ` ${b.productName}` : ''}, ${b.status.replaceAll('_', ' ').toLowerCase()}, completed ${b.completedAt ?? '—'}${b.quantity ? `, ${b.quantity} made` : ''}`;

async function loadSample(q: Sql | Tx, id: number): Promise<{ s: SampleRow; events: EventRow[] } | null> {
  const [s] = await q<SampleRow[]>`
    select s.id::int, s.sample_no as "sampleNo", s.spec_version_id::int as "specVersionId", s.purpose, s.lot_no as "lotNo", s.item, s.source,
      s.quantity, s.containers, s.registered_by::int as "registeredBy", u.full_name as "registeredByName", s.registered_at as "registeredAt"
    from samples s join users u on u.id = s.registered_by where s.id = ${id}`;
  if (!s) return null;
  const events = await q<EventRow[]>`
    select e.id::int, e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at,
      (select json_build_object('printedName', g.printed_name, 'signedAt', g.signed_at) from signatures g where g.object_type = 'sample_event' and g.object_id = e.id limit 1) as signature
    from sample_events e join users u on u.id = e.person_id where e.sample_id = ${id} order by e.id`;
  return { s, events: [...events] };
}
const facts = (s: SampleRow) => ({ registeredBy: s.registeredBy, byHand: isHand(s.source) });
// What the signer of a disposal is shown: the sample as it stands, by its last entry (refused if anything was added since).
const sampleContent = (s: SampleRow, events: EventRow[]) => ({ sample: s.id, sampleNo: s.sampleNo, lotNo: s.lotNo, item: s.item.code, status: sampleStatus(facts(s), events), lastEvent: events.at(-1)?.id ?? 0 });
const sampleHash = (s: SampleRow, events: EventRow[]) => contentHash('sample', s.id, sampleContent(s, events));

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
  purpose: z.enum(SAMPLE_PURPOSES).default('release'),
}).strict();
const ACTION_BODIES: Record<SampleAction, z.ZodTypeAny> = {
  check: z.object({}),
  receive: z.object({ condition: text(500) }),
  store: z.object({ where: text(200) }),
  'hand-over': z.object({ to: text(200) }),
  dispose: signBody.extend({ reason: text(500), method: text(200) }),
  note: z.object({ text: text(1000) }),
};

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
        stock: l.stock ? `${l.stock} ${l.unit ?? ''}`.trim() : null, specs: specs.map(({ header, ...x }) => ({ ...x, number: header.number, type: header.type, market: header.market ?? null })),
        noSpec: specs.length ? null : `No effective specification for ${l.materialCode ?? 'this material'}.`, sampleNo: await releaseSample(sql, 'material', l.lotNumber) });
    }
    if (batches.state === 'ok') for (const b of batches.value) {
      const specs = b.productCode ? await effectiveSpecs(sql, 'product', b.productCode) : [];
      requests.push({ source: 'truebatch' as const, lotNo: b.batchNumber, of: 'product' as const, itemId: null, code: b.productCode ?? '', name: b.productName ?? specs[0]?.header.name ?? null,
        status: b.status, shown: batchShown(b), asOf: b.dataAsOf, stock: b.quantity,
        specs: specs.map(({ header, ...x }) => ({ ...x, number: header.number, type: header.type, market: header.market ?? null })),
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
    return (await effectiveSpecs(sql, of, of === 'material' ? item.itemId : item.code)).map(({ header, ...x }) => ({ ...x, number: header.number, type: header.type, market: header.market ?? null }));
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
      let item: SampleItem;
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
          if (!LOT_WAITING.includes(l.status)) throw new SampleError(409, 'not_waiting', [`Lot ${lotNo} is ${l.status.replaceAll('_', ' ')} in MMS: only a lot in quarantine or under test waits to be sampled.`]);
          if (!l.materialMasterId) throw new SampleError(409, 'not_found', [`MMS names no material for lot ${lotNo}.`]);
          const m = usableItem(await app.master.materials(), l.materialMasterId, 'material');
          item = { of, itemId: m.itemId, code: m.code, name: m.name };
          source = { from: 'mms', asOf: l.dataAsOf, shown: lotShown(l) };
        } else {
          const t = read.value as BatchRead | null;
          if (!t) throw new SampleError(409, 'not_found', [`Batch ${lotNo} is not in TrueBatch.`]);
          if (!batchWaiting(t)) throw new SampleError(409, 'not_waiting', [`Batch ${lotNo} is ${t.released ? 'already released' : 'not completed'} in TrueBatch: only a completed batch, not yet released, waits to be sampled.`]);
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
        // 4. the number of the plant year, never reused
        const [c] = await tx<{ n: number; yy: string }[]>`
          insert into sample_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
          on conflict (year) do update set last_no = sample_counters.last_no + 1
          returning last_no as n, right(year::text, 2) as yy`;
        const sampleNo = `${SAMPLE_PREFIX}${c!.yy}${String(c!.n).padStart(5, '0')}`;
        const row = { sampleNo, specVersionId: b.specVersionId, purpose: b.purpose, lotNo, item, source, quantity: b.quantity, containers: b.containers ?? null };
        const [s] = await tx<{ id: number }[]>`
          insert into samples (sample_no, spec_version_id, purpose, lot_no, item, source, quantity, containers, registered_by)
          values (${sampleNo}, ${b.specVersionId}, ${b.purpose}, ${lotNo}, ${tx.json(item as never)}, ${tx.json(source as never)}, ${b.quantity}, ${b.containers ?? null}, ${user.id})
          returning id::int`;
        // 5. audit
        await audit(tx, { actorId: user.id, action: 'sample.registered', objectType: 'sample', objectId: s!.id, new: row });
        return { id: s!.id, sampleNo };
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
    return rows.map((r) => ({ ...r, status: sampleStatus(r, events.filter((e) => e.sampleId === r.id)) }));
  });

  // One sample with its specification, its chain of custody (LIMS-07), its status and what this person may do next.
  app.get<{ Params: { id: string } }>('/api/samples/:id', reader, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadSample(sql, id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const [v] = await sql<{ id: number; masterId: number; versionNo: number; state: string; doc: SpecDoc }[]>`
      select id::int, master_id::int as "masterId", version_no as "versionNo", state, doc from master_versions where id = ${l.s.specVersionId}`;
    const user = req.user!;
    const may = user.permissions.includes('lims.sample.register');
    const refusals = Object.fromEntries(SAMPLE_ACTION_NAMES.map((a) => [a, may ? sampleRefusal(a, facts(l.s), l.events, user.id) : 'You do not have the right to record sample entries.']));
    return {
      sample: l.s, status: sampleStatus(facts(l.s), l.events), events: l.events,
      spec: v ? { id: v.id, masterId: v.masterId, versionNo: v.versionNo, state: v.state, header: v.doc.header,
        tests: v.doc.tests } : null,
      actions: SAMPLE_ACTION_NAMES.filter((a) => refusals[a] === null), refusals, contentHash: sampleHash(l.s, l.events),
    };
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
}
