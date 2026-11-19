import type { FastifyInstance } from 'fastify';
import type { Sql, Tx } from './db.js';
import { PLANT_TZ } from '../shared/plant-time.js';
import type { SpecDoc } from '../shared/master/spec.js';
import { reducedTestingProblems, type LotSupplier, type PastLot, type ReducedFacts, type SupplierApproval } from '../shared/engine/reduced.js';
import { oosOfSamples } from './routes/oos.js';

// LIMS-09: the facts of reduced testing for a release sample, pulled now (shared/engine/reduced.ts decides): the lot's
// manufacturer and supplier (MMS), their approval (QMS), the manufacturer's name (master data), and this lab's own
// record of the manufacturer's earlier lots (full or reduced) and their OOS.

export interface ReducedBasis {
  manufacturerId: string; manufacturer: string; manufacturerAddress: string | null; supplierId: string; supplier: string;
  manufacturerBatchNo: string | null; broker: boolean; approval: string | null; approvedUntil: string | null; reducedTestingApprovedAt: string | null;
  lastFull: string | null; fullEvery: number; months: number;
}

export async function reducedFacts(q: Sql | Tx, app: FastifyInstance, s: { id: number; purpose: string; lotNo: string | null }, spec: SpecDoc,
  decided: string | null, recorded: boolean, today: string): Promise<{ facts: ReducedFacts; basis: ReducedBasis | null }> {
  const base = { spec, purpose: s.purpose, decided, recorded, today, past: [] as PastLot[], oos: [] as ReducedFacts['oos'] };
  if (decided || recorded || s.purpose !== 'release' || !spec.header.reducedTesting || spec.header.of !== 'material' || !s.lotNo) {
    return { facts: { ...base, lot: { supplierId: null, manufacturerId: null, manufacturerBatchNo: null }, approval: null }, basis: null };
  }
  const lotRead = await app.links.mms.supplier(s.lotNo);
  const lot: LotSupplier | null = lotRead.state === 'ok' ? lotRead.value ?? { supplierId: null, manufacturerId: null, manufacturerBatchNo: null } : null;
  if (!lot?.manufacturerId || !lot.supplierId) return { facts: { ...base, lot, approval: null }, basis: null };
  const names = await app.master.suppliers().catch(() => []);
  const mf = names.find((x) => x.itemId === lot.manufacturerId);
  const sp = names.find((x) => x.itemId === lot.supplierId);
  const manufacturer = mf?.name ?? 'the manufacturer';
  const ap = await app.links.qms.supplierApproval(spec.header.itemId, lot.manufacturerId, lot.supplierId);
  const approval: SupplierApproval | null = ap.state === 'ok' ? ap.value : null;
  // This lab's earlier release samples of the manufacturer's lots of the material, newest decision first.
  const lots = await app.links.mms.lotsOfManufacturer(spec.header.itemId, lot.manufacturerId);
  const lotNos = lots.state === 'ok' ? lots.value : [];
  const rows = lotNos.length ? await q<{ id: number; sampleNo: string; approvedOn: string | null; reduced: boolean }[]>`
    select s.id::int, s.sample_no as "sampleNo", (a.at at time zone ${PLANT_TZ})::date::text as "approvedOn",
      exists (select 1 from sample_events r where r.sample_id = s.id and r.kind = 'reduced_testing') as reduced
    from samples s left join sample_events a on a.sample_id = s.id and a.kind = 'approved'
    where s.purpose = 'release' and s.lot_no = any(${lotNos}) and s.id <> ${s.id}
    order by a.at desc nulls last, s.id desc` : [];
  const past = rows.filter((r) => r.approvedOn).map((r) => ({ sampleNo: r.sampleNo, approvedOn: r.approvedOn!, reduced: r.reduced }));
  const oos = await oosOfSamples(q, [...rows.map((r) => r.id), s.id]);
  const rt = spec.header.reducedTesting;
  const lastFull = past.find((p) => !p.reduced);
  return {
    facts: { ...base, lot, approval, past, oos, manufacturer, approvalUnread: ap.state !== 'ok' },
    basis: { manufacturerId: lot.manufacturerId, manufacturer, manufacturerAddress: mf?.address ?? null, supplierId: lot.supplierId, supplier: sp?.name ?? lot.supplierId,
      manufacturerBatchNo: lot.manufacturerBatchNo, broker: approval?.isBroker ?? false, approval: approval?.recordNumber ?? null,
      approvedUntil: approval?.approvedUntil ?? null, reducedTestingApprovedAt: approval?.reducedTestingApprovedAt ?? null,
      lastFull: lastFull ? `${lastFull.sampleNo} (${lastFull.approvedOn})` : null, fullEvery: rt.fullEvery, months: rt.months },
  };
}

/** The problems (empty: QC may record it) and what would be recorded. */
export async function reducedState(q: Sql | Tx, app: FastifyInstance, s: { id: number; purpose: string; lotNo: string | null }, spec: SpecDoc,
  decided: string | null, recorded: boolean, today: string) {
  const { facts, basis } = await reducedFacts(q, app, s, spec, decided, recorded, today);
  return { problems: reducedTestingProblems(facts), basis };
}
