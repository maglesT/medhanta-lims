import type postgres from 'postgres';
import type { Sql } from './db.js';
import { TB_EDITIONS, TB_PRODUCTION, type Edition, type LinkState, type Provider } from '../shared/engine/links.js';
import type { TrainingRead } from '../shared/engine/training.js';
import { qualificationProblem, type QualPick, type QualRead } from '../shared/engine/qualification.js';
import type { SupplierApproval } from '../shared/engine/reduced.js';

// Links to the other Medhanta products, the Logbook way (platform PL-08, D-02). Each provider is read live through
// its report views with this product's own login, from the URL the platform writes only while the link is on
// (<PROVIDER>_DATABASE_URL). Nothing is copied or cached. Every read gives one of three answers:
//   absent: no URL (the product is not licensed, or the link is off);
//   down:   the URL is set but the read was refused or the provider did not answer;
//   ok:     the rows as read now.
// Owner 15 Nov 2026: while a link is ok its values are pulled and cannot be typed over; absent or down, people go on
// by hand with a second-person check and the entry is flagged for QA (shared/engine/links.ts).

export type Read<T> = { state: 'ok'; value: T } | { state: Exclude<LinkState, 'ok'> };

// Refused: no grant (42501), the view is gone (42P01), the login is off (28000). Not answering: admin shutdown
// (57P01), the statement timeout (57014), connection errors (class 08 and the client's own).
const isCut = (e: unknown) => {
  const code = (e as { code?: string }).code ?? '';
  return ['42501', '42P01', '28000', '57P01', '57014', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CONNECT_TIMEOUT',
    'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code) || code.startsWith('08');
};

type View = (name: string) => postgres.Helper<string, []>;
export interface Link {
  provider: Provider;
  read<T>(f: (q: Sql, view: View) => Promise<T>): Promise<Read<T>>;
}
/** One provider's link: its connection (null when absent) and the schema of its published views. */
export function link(provider: Provider, q: Sql | null, schema = 'report'): Link {
  return {
    provider,
    async read(f) {
      if (!q) return { state: 'absent' };
      try { return { state: 'ok', value: await f(q, (name) => q(`${schema}.${name}`)) }; } catch (e) {
        if (isCut(e)) return { state: 'down' };
        throw e;
      }
    },
  };
}

// ---- Deviations: report.deviation_v1 (published now).
export interface DeviationRead { number: string; status: string; title: string | null; closedAt: string | null }
type DevRow = { number: string; status: string; title: string | null; closed_at: string | null };
const dev = (r: DevRow): DeviationRead => ({ number: r.number, status: r.status, title: r.title, closedAt: r.closed_at });
export const deviationsClient = (l: Link) => ({
  byNumbers: (numbers: string[]) => l.read(async (q, v) => new Map((await q<DevRow[]>`
    select distinct on (number) number, status, title, closed_at::text from ${v('deviation_v1')} where number = any(${numbers}) order by number`)
    .map((r) => [r.number, dev(r)]))),
  // The deviations filed from these notes (owner, 17 Nov 2026: the number flows back): deviation_v1.source_ref is the
  // note's deviation_note_v1.source_ref. Read through to_jsonb, so a view without the column finds none.
  bySourceRefs: (refs: string[]) => l.read(async (q, v) => new Map((await q<(DevRow & { source_ref: string })[]>`
    select distinct on (source_ref) source_ref, number, status, title, closed_at from (
      select to_jsonb(d) ->> 'source_ref' as source_ref, number, status, title, closed_at::text from ${v('deviation_v1')} d) x
    where source_ref = any(${refs}) order by source_ref, number`).map((r) => [r.source_ref, dev(r)]))),
  // The deviations that name one of these numbers (the analysis number, the sample's lot or batch) in their batch
  // field, matched as Deviations matches batches (its batch_norm).
  byBatch: (...numbers: string[]) => l.read(async (q, v) => (await q<DevRow[]>`
    select distinct on (number) number, status, title, closed_at::text from ${v('deviation_v1')}
    where batch_norm = any(${numbers.filter(Boolean).map((n) => n.toLowerCase().replace(/[\s\-/._]+/g, ''))}) order by number`).map(dev)),
});

// ---- QMS: report.change_v1 (planned). A change control counts as approved once QA approved it and it is in one
// of these steps (an easy-to-change constant; the plan's question Q7).
export const CHANGE_STEPS = ['implementation', 'closure', 'closed'];
export interface ChangeRead { number: string; status: string; title: string | null; products: string | null; qaApprovedAt: string | null }
type CcRow = { number: string; status: string; title: string | null; products: string | null; qa_approved_at: string | null };
const cc = (r: CcRow): ChangeRead => ({ number: r.number, status: r.status, title: r.title, products: r.products, qaApprovedAt: r.qa_approved_at });
export const approvedChange = (c: ChangeRead) => c.qaApprovedAt !== null && CHANGE_STEPS.includes(c.status);
const word = (x: string) => new RegExp(`(^|[^a-z0-9])${x.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
// What QMS writes when a change control names no product ("None" ticked on its form).
const NO_PRODUCT = ['none', 'n/a', 'na', 'nil', '-', '—'];
/**
 * Whether a change control's products name this product or material: by its code (a whole word, case-insensitive) or
 * by its whole name as one entry of the list ("Atorvastatin calcium" does not match "… Atorvastatin calcium tablets");
 * 'none' when it names no product (empty, or QMS's "none").
 */
export function namesProduct(c: ChangeRead, product: { productCode: string; productName: string }): 'yes' | 'no' | 'none' {
  const p = c.products?.trim().toLowerCase();
  if (!p || NO_PRODUCT.includes(p)) return 'none';
  const code = product.productCode.trim().toLowerCase();
  const name = product.productName.trim().toLowerCase();
  const entries = p.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  return (code && word(code).test(p)) || (name && entries.some((x) => x === name || x === `${code} ${name}`)) ? 'yes' : 'no';
}
export const qmsClient = (l: Link) => ({
  change: (number: string) => l.read(async (q, v) => {
    const [r] = await q<CcRow[]>`select number, status, title, products, qa_approved_at::text from ${v('change_v1')} where number = ${number} limit 1`;
    return r ? cc(r) : null;
  }),
  approved: () => l.read(async (q, v) => (await q<CcRow[]>`
    select number, status, title, products, qa_approved_at::text from ${v('change_v1')}
    where qa_approved_at is not null and status = any(${CHANGE_STEPS}) order by number desc limit 200`).map(cc)),
  // LIMS-09: QMS's approval of a material from a manufacturer through a supplier (report.supplier_approval_v1).
  supplierApproval: (materialId: string, manufacturerId: string, supplierId: string) => l.read(async (q, v) => {
    const [r] = await q<{ record_number: string | null; status: string; approved_until: string | null; is_broker: boolean | null; reduced_testing_approved: boolean | null; reduced_testing_approved_at: string | null }[]>`
      select to_jsonb(a) ->> 'record_number' as record_number, status, approved_until::text, is_broker, reduced_testing_approved, reduced_testing_approved_at::text
      from ${v('supplier_approval_v1')} a where material_id::text = ${materialId} and manufacturer_id::text = ${manufacturerId} and supplier_id::text = ${supplierId}
      order by data_as_of desc nulls last limit 1`;
    return r ? { recordNumber: r.record_number, status: r.status, approvedUntil: r.approved_until, isBroker: r.is_broker === true,
      reducedTestingApproved: r.reduced_testing_approved === true, reducedTestingApprovedAt: r.reduced_testing_approved_at } satisfies SupplierApproval : null;
  }),
});

// ---- Logbook: report.equipment_status_v1 (planned), the status the Logbook computes. fit_for_use leaves out a use in
// progress (that is in_use_batch: a production batch, or one of LIMS's analyses once the Logbook reads instrument_use_v1). only_product (its last column, owner 17 Nov 2026): the product code that alone may
// use the item next, after an antibiotic and until a product-changeover cleaning is verified; null: any product. Read
// through to_jsonb, so a view from before the column was appended reads as null.
export interface EquipmentStatus {
  code: string; state: string; fitForUse: boolean; blockers: string[]; warnings: string[]; inUseBatch: string | null;
  cleanedAt: string | null; cleanedBy: string | null; checkedAt: string; onlyProduct: string | null;
}
// A status older than this is not used (never stale data): the link counts as down.
export const STATUS_MAX_AGE_MS = 5 * 60_000;
export const logbookClient = (l: Link) => ({
  status: (masterId: string) => l.read(async (q, v) => {
    const [r] = await q<{ code: string; state: string; fit_for_use: boolean; blockers: string[] | null; warnings: string[] | null; in_use_batch: string | null;
      cleaned_at: string | null; cleaned_by: string | null; checked_at: Date; age_ms: number; only_product: string | null }[]>`
      select code, state, fit_for_use, blockers, warnings, in_use_batch, cleaned_at::text, cleaned_by, checked_at,
        extract(epoch from now() - checked_at) * 1000 as age_ms, nullif(to_jsonb(s) ->> 'only_product', '') as only_product
      from ${v('equipment_status_v1')} s where master_id::text = ${masterId} limit 1`;
    if (!r) return null;
    if (Number(r.age_ms) > STATUS_MAX_AGE_MS) return 'stale' as const;
    return { code: r.code, state: r.state, fitForUse: r.fit_for_use, blockers: r.blockers ?? [], warnings: r.warnings ?? [], inUseBatch: r.in_use_batch,
      cleanedAt: r.cleaned_at, cleanedBy: r.cleaned_by, checkedAt: r.checked_at.toISOString(), onlyProduct: r.only_product } satisfies EquipmentStatus;
  }),
  // The master-data ids of every machine, instrument and room the Logbook has, for the pick lists (only these can be used).
  known: () => l.read(async (q, v) => (await q<{ id: string }[]>`select distinct master_id::text as id from ${v('equipment_status_v1')} where master_id is not null`).map((r) => r.id)),
});

// ---- MMS: report.lot_v1 and report.lot_test_v1 (planned, with numbers for assay, water and LOD and their basis).
export const LOT_USABLE = ['approved', 'released'];
// A material lot in these MMS statuses waits for its QC sample.
export const LOT_WAITING = ['quarantine', 'quarantined', 'under_test'];
export interface LotTest { test: string; value: string | null; unit: string | null; basis: string | null; reportRef: string | null }
export interface LotRead {
  lotNumber: string; materialMasterId: string | null; materialCode: string | null; status: string; expiryDate: string | null;
  retestDate: string | null; qcReportRef: string | null; dataAsOf: string | null; tests: LotTest[];
  // MMS's own balance of the lot (received − sampled − issued + returned ± adjustments − disposed) in the lot's unit;
  // null from an MMS whose lot_v1 does not give it yet (then nothing is compared with it).
  stock?: string | null; unit?: string | null;
}
type LotRow = { lot_number: string; material_master_id: string | null; material_code: string | null; status: string; expiry_date: string | null;
  retest_date: string | null; qc_report_ref: string | null; data_as_of: string | null };
const lotOf = (r: LotRow, tests: LotTest[] = []): LotRead => ({ lotNumber: r.lot_number, materialMasterId: r.material_master_id, materialCode: r.material_code,
  status: r.status, expiryDate: r.expiry_date, retestDate: r.retest_date, qcReportRef: r.qc_report_ref, dataAsOf: r.data_as_of, tests });
const LOT_COLS = `lot_number, material_master_id::text, material_code, status, expiry_date::text, retest_date::text, qc_report_ref, data_as_of::text`;
export const mmsClient = (l: Link) => ({
  lot: (lotNumber: string) => l.read(async (q, v) => {
    // stock and unit through to_jsonb: the columns when MMS's view has them, null on a view from before they were appended.
    const [r] = await q<(LotRow & { stock: string | null; unit: string | null })[]>`select ${q.unsafe(LOT_COLS)}, to_jsonb(l) ->> 'stock' as stock, to_jsonb(l) ->> 'unit' as unit
      from ${v('lot_v1')} l where lot_number = ${lotNumber} and kind = 'material' limit 1`;
    if (!r) return null;
    const tests = await q<{ test: string; value: string | null; unit: string | null; basis: string | null; report_ref: string | null }[]>`
      select test, value::text, unit, basis, report_ref from ${v('lot_test_v1')} where lot_number = ${lotNumber} and value is not null`;
    return { ...lotOf(r, tests.map((t) => ({ test: t.test, value: t.value, unit: t.unit, basis: t.basis, reportRef: t.report_ref }))), stock: r.stock, unit: r.unit };
  }),
  // LIMS-09: the lot's supplier, manufacturer and the manufacturer's batch number (lot_v1's last columns, through to_jsonb:
  // null on a view from before they were appended).
  supplier: (lotNumber: string) => l.read(async (q, v) => {
    const [r] = await q<{ supplier_id: string | null; manufacturer_id: string | null; manufacturer_batch_no: string | null }[]>`
      select to_jsonb(l) ->> 'supplier_id' as supplier_id, to_jsonb(l) ->> 'manufacturer_id' as manufacturer_id, to_jsonb(l) ->> 'manufacturer_batch_no' as manufacturer_batch_no
      from ${v('lot_v1')} l where lot_number = ${lotNumber} and kind = 'material' limit 1`;
    return r ? { supplierId: r.supplier_id, manufacturerId: r.manufacturer_id, manufacturerBatchNo: r.manufacturer_batch_no } : null;
  }),
  // LIMS-09: the lot numbers of a material from one manufacturer (for its periodic full test and its OOS).
  lotsOfManufacturer: (materialId: string, manufacturerId: string) => l.read(async (q, v) => (await q<{ lot_number: string }[]>`
    select lot_number from ${v('lot_v1')} l where kind = 'material' and material_master_id::text = ${materialId}
      and to_jsonb(l) ->> 'manufacturer_id' = ${manufacturerId} limit 5000`).map((r) => r.lot_number)),
  // The material lots waiting to be sampled: received and in quarantine (or under test) in MMS.
  waiting: () => l.read(async (q, v) => (await q<(LotRow & { stock: string | null; unit: string | null })[]>`
    select ${q.unsafe(LOT_COLS)}, to_jsonb(l) ->> 'stock' as stock, to_jsonb(l) ->> 'unit' as unit from ${v('lot_v1')} l
    where kind = 'material' and status = any(${LOT_WAITING}) order by lot_number limit 500`).map((r) => ({ ...lotOf(r), stock: r.stock, unit: r.unit }))),
  // The lots of a material that may be used today, for the pick list.
  usable: (materialId: string, today: string) => l.read(async (q, v) => (await q<LotRow[]>`
    select ${q.unsafe(LOT_COLS)} from ${v('lot_v1')} where kind = 'material' and material_master_id::text = ${materialId} and status = any(${LOT_USABLE})
      and (expiry_date is null or expiry_date >= ${today}::date) and (retest_date is null or retest_date >= ${today}::date)
    order by expiry_date nulls last, lot_number limit 100`).map((r) => lotOf(r))),
  // LIMS-31: the released lots whose retest date is on or before this date (due soon, or past), for the retest-due list.
  retestDue: (until: string) => l.read(async (q, v) => (await q<(LotRow & { stock: string | null; unit: string | null })[]>`
    select ${q.unsafe(LOT_COLS)}, to_jsonb(l) ->> 'stock' as stock, to_jsonb(l) ->> 'unit' as unit from ${v('lot_v1')} l
    where kind = 'material' and status = any(${LOT_USABLE}) and retest_date is not null and retest_date <= ${until}::date
    order by retest_date, lot_number limit 500`).map((r) => ({ ...lotOf(r), stock: r.stock, unit: r.unit }))),
});

// ---- Recruitment: report.training_v1 (published, owner 17 Nov 2026), one row per person and skill; qualified is already
// false when the training expired. Read by the signer's login (core's preferred_username, as Recruitment names people).
type TrainingRow = { skill_code: string; skill_title: string | null; qualified: boolean; trained_on: string | null; valid_until: string | null; data_as_of: string | null };
export const recruitmentClient = (l: Link) => ({
  training: (login: string, code: string) => l.read(async (q, v) => {
    const [r] = await q<TrainingRow[]>`
      select skill_code, skill_title, qualified, trained_on::text, valid_until::text, data_as_of::text from ${v('training_v1')}
      where lower(person_login) = lower(${login}) and skill_code = ${code} order by qualified desc, valid_until desc nulls last limit 1`;
    return r ? { code: r.skill_code, title: r.skill_title, qualified: r.qualified === true, trainedOn: r.trained_on, validUntil: r.valid_until, dataAsOf: r.data_as_of } satisfies TrainingRead : null;
  }),
  // The skills Recruitment trains people in, for the designer's pick list.
  skills: () => l.read(async (q, v) => (await q<{ code: string; title: string | null }[]>`
    select distinct on (skill_code) skill_code as code, skill_title as title from ${v('training_v1')} where skill_code is not null
    order by skill_code, skill_title nulls last limit 500`).map((r) => ({ code: r.code, ...(r.title ? { title: r.title } : {}) }))),
});

// ---- TrueBatch: report.batch_fact_v1 (published by each production edition), one row per batch. A batch with
// completed_at set and not released waits for its finished-product sample. report.lab_request_v1 (every edition): one
// row per in-process lab request a step opens (owner 19 Nov 2026).
export interface BatchRead {
  batchNumber: string; productCode: string | null; productName: string | null; status: string; completedAt: string | null;
  released: boolean; dataAsOf: string | null; quantity: string | null; edition?: Edition;
}
type BatchRow = { batch_number: string; product_code: string | null; product_name: string | null; status: string; completed_at: string | null;
  released: boolean | null; data_as_of: string | null; good_quantity: string | null; good_unit: string | null };
const batchOf = (r: BatchRow, edition?: Edition): BatchRead => ({ batchNumber: r.batch_number, productCode: r.product_code, productName: r.product_name, status: r.status,
  completedAt: r.completed_at, released: r.released === true, dataAsOf: r.data_as_of, quantity: r.good_quantity ? `${r.good_quantity} ${r.good_unit ?? ''}`.trim() : null,
  ...(edition ? { edition } : {}) });
// product_name, good_quantity and good_unit through to_jsonb: null on a view from before they were appended.
const BATCH_COLS = `batch_number, product_code, to_jsonb(b) ->> 'product_name' as product_name, status, completed_at::text, released, data_as_of::text,
  to_jsonb(b) ->> 'good_quantity' as good_quantity, to_jsonb(b) ->> 'good_unit' as good_unit`;
// A batch takes its release sample from production on (a bulk sampled at its QA hold, before packing; owner 19 Nov
// 2026) until it is released; never a rejected or cancelled one.
export const BATCH_DONE_WITH = ['REJECTED', 'CANCELLED', 'RELEASED'];
export const batchWaiting = (b: BatchRead) => !b.released && !BATCH_DONE_WITH.includes(b.status.toUpperCase());

/** An in-process lab request of a TrueBatch step (lab_request_v1). `individual`: the number of units tested one by one. */
// code (TrueBatch round 45): unique within the product ('<block id>.<field>'); name: the TrueBatch field name. A request
// from before codes has none: its name is its code.
export interface LabRequestTest { name: string; label: string; unit: string | null; individual: number | null; code?: string | null }
/** What an in-process specification test's TrueBatch field matches: the request test's code, else its name. */
export const testCode = (t: { name: string; code?: string | null }) => t.code || t.name;
export interface LabRequest { edition: Edition; requestId: string; batchNo: string; productCode: string; stageTitle: string | null; stepKey: string; stepTitle: string | null;
  tests: LabRequestTest[]; requestedAt: string; status: string }
type RequestRow = { request_id: string; batch_no: string; product_code: string; stage_title: string | null; step_key: string; step_title: string | null;
  tests: LabRequestTest[] | null; requested_at: string; status: string };
const requestOf = (r: RequestRow, edition: Edition): LabRequest => ({ edition, requestId: r.request_id, batchNo: r.batch_no, productCode: r.product_code, stageTitle: r.stage_title,
  stepKey: r.step_key, stepTitle: r.step_title, requestedAt: r.requested_at, status: r.status,
  tests: (r.tests ?? []).map((t) => ({ name: String(t.name), label: String(t.label ?? t.name), unit: t.unit ?? null, individual: t.individual ?? null, ...(t.code ? { code: String(t.code) } : {}) })) });
const REQUEST_COLS = `request_id, batch_no, product_code, stage_title, step_key, step_title, tests, requested_at::text, status`;

/**
 * One read over the editions' links: absent when none is linked; ok when at least one answers (the rows of those that
 * answer); down when none answers. A single lookup that finds nothing while an edition is down answers down, so the
 * person may type it by hand.
 */
type EditionLink = { edition: Edition; link: Link };
async function allEditions<T>(ls: EditionLink[], f: (q: Sql, v: View, edition: Edition) => Promise<T[]>): Promise<Read<T[]>> {
  const reads = await Promise.all(ls.map((e) => e.link.read((q, v) => f(q, v, e.edition))));
  const ok = reads.filter((r): r is { state: 'ok'; value: T[] } => r.state === 'ok');
  if (ok.length) return { state: 'ok', value: ok.flatMap((r) => r.value) };
  return { state: reads.some((r) => r.state === 'down') ? 'down' : 'absent' };
}
async function oneOf<T>(ls: EditionLink[], f: (q: Sql, v: View, edition: Edition) => Promise<T | null>): Promise<Read<T | null>> {
  const reads = await Promise.all(ls.map((e) => e.link.read((q, v) => f(q, v, e.edition))));
  const found = reads.find((r) => r.state === 'ok' && r.value !== null);
  if (found) return found as Read<T | null>;
  if (reads.some((r) => r.state === 'down')) return { state: 'down' };
  return reads.some((r) => r.state === 'ok') ? { state: 'ok', value: null } : { state: 'absent' };
}

/** TrueBatch: one link (a test's) or one per edition. */
export const truebatchClient = (links: Link | EditionLink[]) => {
  const all: EditionLink[] = Array.isArray(links) ? links : [{ edition: 'truebatch', link: links }];
  // Release samples: a production edition's batch_fact_v1, a packing edition's packing_batch_v1 (the finished packs,
  // same columns; owner 19 Nov 2026: a packing batch has its own release CoA).
  const production = all;
  const batchView = (e: Edition) => (TB_PRODUCTION.includes(e) ? 'batch_fact_v1' : 'packing_batch_v1');
  return {
    batch: (batchNumber: string) => oneOf(production, async (q, v, ed) => {
      const [r] = await q<BatchRow[]>`select ${q.unsafe(BATCH_COLS)} from ${v(batchView(ed))} b where batch_number = ${batchNumber} order by completed_at desc nulls last limit 1`;
      return r ? batchOf(r, ed) : null;
    }),
    waiting: () => allEditions(production, async (q, v, ed) => (await q<BatchRow[]>`
      select ${q.unsafe(BATCH_COLS)} from ${v(batchView(ed))} b where released is not true and upper(status) <> all(${BATCH_DONE_WITH})
      order by completed_at nulls last, batch_number limit 500`).map((r) => batchOf(r, ed))),
    // Stability (LIMS-27, plan 2.6): the completed batches of a product, newest first, to put on study; and the batches
    // released since a plant date (released_at through to_jsonb: the completion on a view from before it was appended).
    ofProduct: async (productCode: string) => {
      const r = await allEditions(production, async (q, v, ed) => (await q<BatchRow[]>`
        select ${q.unsafe(BATCH_COLS)} from ${v(batchView(ed))} b where product_code = ${productCode} and completed_at is not null and status <> 'REJECTED'
        order by completed_at desc, batch_number limit 100`).map((x) => batchOf(x, ed)));
      return r.state === 'ok' ? { ...r, value: r.value.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || a.batchNumber.localeCompare(b.batchNumber)) } : r;
    },
    releasedSince: async (date: string) => {
      const r = await allEditions(production, async (q, v, ed) => (await q<BatchRow[]>`
        select ${q.unsafe(BATCH_COLS)} from ${v(batchView(ed))} b where released is true
          and (coalesce((to_jsonb(b) ->> 'released_at')::timestamptz, completed_at) at time zone 'Asia/Kolkata')::date >= ${date}::date
        order by product_code, batch_number limit 2000`).map((x) => batchOf(x, ed)));
      return r.state === 'ok' ? { ...r, value: r.value.sort((a, b) => (a.productCode ?? '').localeCompare(b.productCode ?? '') || a.batchNumber.localeCompare(b.batchNumber)) } : r;
    },
    // In-process (owner 19 Nov 2026): the open requests of every edition, oldest first; one request; the test names a
    // product's requests have used (for the in-process specification's pick list).
    openRequests: async () => {
      const r = await allEditions(all, async (q, v, ed) => (await q<RequestRow[]>`
        select ${q.unsafe(REQUEST_COLS)} from ${v('lab_request_v1')} where status = 'open' order by requested_at limit 500`).map((x) => requestOf(x, ed)));
      return r.state === 'ok' ? { ...r, value: r.value.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)) } : r;
    },
    request: (edition: string, requestId: string) => oneOf(all.filter((e) => e.edition === edition), async (q, v, ed) => {
      const [x] = await q<RequestRow[]>`select ${q.unsafe(REQUEST_COLS)} from ${v('lab_request_v1')} where request_id = ${requestId} limit 1`;
      return x ? requestOf(x, ed) : null;
    }),
    requestFields: async (productCode: string) => {
      const r = await allEditions(all, async (q, v) => q<{ name: string; label: string; unit: string | null }[]>`
        select distinct coalesce(nullif(t ->> 'code', ''), t ->> 'name') as name, coalesce(t ->> 'label', t ->> 'name') as label, t ->> 'unit' as unit
        from ${v('lab_request_v1')} r, jsonb_array_elements(r.tests) t where r.product_code = ${productCode} limit 500`);
      return r.state === 'ok' ? { ...r, value: [...new Map(r.value.map((x) => [x.name, x])).values()].sort((a, b) => a.name.localeCompare(b.name)) } : r;
    },
  };
};

// ---- Qualification: report.qualification_v1 (published), one row per qualified item; a machine is matched by its
// master-data id (master_id). conditions (of a conditional qualification) through to_jsonb: null until Qualification
// publishes it. LIMS-12: shared/engine/qualification.ts says whether it may be used.
type QualRow = { master_id: string; code: string; name: string; status: string; next_review_due: string | null; data_as_of: string | null; conditions: string | null };
const QUAL_COLS = `master_id::text, code, name, status, next_review_due::text, data_as_of::text, nullif(to_jsonb(q) ->> 'conditions', '') as conditions`;
const qualOf = (r: QualRow): QualRead => ({ masterId: r.master_id, code: r.code, name: r.name, status: r.status, nextReviewDue: r.next_review_due,
  dataAsOf: r.data_as_of, conditions: r.conditions });
export const qualClient = (l: Link) => ({
  status: (masterId: string) => l.read(async (q, v) => {
    const [r] = await q<QualRow[]>`select ${q.unsafe(QUAL_COLS)} from ${v('qualification_v1')} q where master_id::text = ${masterId}
      order by status_since desc nulls last limit 1`;
    return r ? qualOf(r) : null;
  }),
  // Every item Qualification has with a master-data id, with why it may not be used today (the picker, LIMS-12).
  picks: (today: string) => l.read(async (q, v) => (await q<QualRow[]>`select distinct on (master_id) ${q.unsafe(QUAL_COLS)} from ${v('qualification_v1')} q
    where master_id is not null order by master_id, status_since desc nulls last limit 5000`)
    .map((r): QualPick => { const x = qualOf(r); const problem = qualificationProblem(x.code, x, today); return { id: x.masterId, problem }; })),
});

export interface Links {
  deviations: ReturnType<typeof deviationsClient>;
  qms: ReturnType<typeof qmsClient>;
  logbook: ReturnType<typeof logbookClient>;
  mms: ReturnType<typeof mmsClient>;
  recruitment: ReturnType<typeof recruitmentClient>;
  truebatch: ReturnType<typeof truebatchClient>;
  qual: ReturnType<typeof qualClient>;
}
/** The links, from their connections (null: absent). `schema` lets tests point a provider at its own schema. */
export function links(c: Partial<Record<Provider | Edition, Sql | null>> = {}, schema: Partial<Record<Provider | Edition, string>> = {}): Links {
  return {
    deviations: deviationsClient(link('deviations', c.deviations ?? null, schema.deviations)),
    qms: qmsClient(link('qms', c.qms ?? null, schema.qms)),
    logbook: logbookClient(link('logbook', c.logbook ?? null, schema.logbook)),
    mms: mmsClient(link('mms', c.mms ?? null, schema.mms)),
    recruitment: recruitmentClient(link('recruitment', c.recruitment ?? null, schema.recruitment)),
    // Every TrueBatch edition linked (start.ts); a test may give only "truebatch".
    truebatch: truebatchClient(TB_EDITIONS.filter((e) => e === 'truebatch' || c[e]).map((e) => ({ edition: e, link: link('truebatch', c[e] ?? null, schema[e]) }))),
    qual: qualClient(link('qual', c.qual ?? null, schema.qual)),
  };
}
