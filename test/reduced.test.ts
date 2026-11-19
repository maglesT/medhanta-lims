import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, validatedOutside, type TestApp } from './helpers.js';
import { small } from './engine-fixture.js';
import { specChecks, specSchema, type SpecDoc } from '../shared/master/spec.js';
import { fullTestDue, reducedTestingProblems, type ReducedFacts } from '../shared/engine/reduced.js';
import { outsideCheckRefusal, outsideEntryRefusal } from '../shared/engine/outside.js';
import { coaDoc } from '../server/coa.js';
import { loadSampleRow } from '../server/routes/samples.js';

// LIMS-09: a lot tested on its supplier's certificate (reduced testing), only for a manufacturer and supplier QMS approves
// for it, with the identity always tested here, a full test of every n-th lot and at least every m months, and a stop
// while an OOS of the manufacturer's lots is open or after one is confirmed; the certificate's results are typed from
// its scan and checked by a second person who confirms its required fields (US 211.84(d)(2), EU C5 5.35-5.36,
// IN Schedule M 19.7.4).

const MAT = '00000000-0000-0000-0000-0000000000c1';
const MF = '00000000-0000-0000-0000-0000000000f1';
const SUP = '00000000-0000-0000-0000-0000000000f2';
const MF2 = '00000000-0000-0000-0000-0000000000f3';
const header = { of: 'material', itemId: MAT, code: 'RM-090', name: 'Demoxetine (active substance)', type: 'Active substance', number: 'SPEC-RM-090', pharmacopoeia: 'Ph. Int.',
  sampling: { plan: 'square root' }, reducedTesting: { fullEvery: 3, months: 12 } } as const;
const specOf = (ph: { masterId: number }, ir: { masterId: number }, over: object = {}): SpecDoc => specSchema.parse({
  header: { ...header, ...over },
  tests: [
    { key: 'ph', name: 'pH', method: { masterId: ph.masterId, code: 'PH', name: 'PH method' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' } },
    { key: 'id', name: 'Identity (IR)', method: { masterId: ir.masterId, code: 'IR', name: 'IR method' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' }, identity: true },
  ],
});

// ---- The rules (pure functions) ----
describe('the rules', () => {
  const doc = specOf({ masterId: 1 }, { masterId: 2 });
  const approval = { recordNumber: 'SA-26-0007', status: 'approved', approvedUntil: '2027-06-30', isBroker: false, reducedTestingApproved: true, reducedTestingApprovedAt: '2026-01-10' };
  const ok: ReducedFacts = { spec: doc, purpose: 'release', decided: null, recorded: false, lot: { supplierId: SUP, manufacturerId: MF, manufacturerBatchNo: 'DX-2611' },
    approval, past: [{ sampleNo: 'LS2600010', approvedOn: '2026-10-01', reduced: false }], oos: [], today: '2026-11-19', manufacturer: 'Demo Fine Chem' };

  it('LIMS-09 reduced testing only when the specification allows it, MMS names the manufacturer and supplier and QMS approves them for it', () => {
    expect(reducedTestingProblems(ok)).toEqual([]);
    expect(reducedTestingProblems({ ...ok, spec: specOf({ masterId: 1 }, { masterId: 2 }, { reducedTesting: undefined }) })).toEqual(['Specification SPEC-RM-090 does not allow reduced testing: every test is done here.']);
    expect(reducedTestingProblems({ ...ok, purpose: 'retest' })).toEqual(['Only a release sample of a lot is tested on the supplier\'s certificate.']);
    expect(reducedTestingProblems({ ...ok, lot: null })).toEqual(['MMS cannot be read now: the lot\'s manufacturer and supplier are not known, so the lot is tested in full.']);
    expect(reducedTestingProblems({ ...ok, lot: { supplierId: null, manufacturerId: MF, manufacturerBatchNo: null } })).toEqual(['MMS does not name the lot\'s manufacturer and supplier: the lot is tested in full.']);
    expect(reducedTestingProblems({ ...ok, approval: null })).toEqual(['QMS has no supplier approval of RM-090 from Demo Fine Chem through this supplier.']);
    expect(reducedTestingProblems({ ...ok, approval: null, approvalUnread: true })).toEqual(['QMS cannot be read now: the supplier approval is not known, so the lot is tested in full.']);
    expect(reducedTestingProblems({ ...ok, approval: { ...approval, status: 'conditional' } })).toEqual(['The supplier approval (SA-26-0007) is conditional in QMS, not approved.']);
    expect(reducedTestingProblems({ ...ok, approval: { ...approval, approvedUntil: '2026-11-18' } })).toEqual(['The supplier approval (SA-26-0007) ran out on 2026-11-18.']);
    expect(reducedTestingProblems({ ...ok, approval: { ...approval, reducedTestingApproved: false } })).toEqual(['QA has not approved reduced testing for this supplier in QMS (SA-26-0007).']);
    expect(reducedTestingProblems({ ...ok, decided: 'approved' })).toEqual(['The sample is already approved.']);
    expect(reducedTestingProblems({ ...ok, recorded: true })).toEqual(['This lot is already tested on the supplier\'s certificate.']);
  });

  it('LIMS-09 the supplier\'s results are checked by full testing at intervals: every n-th lot and at least every m months', () => {
    const rt = { fullEvery: 3, months: 12 };
    const full = (sampleNo: string, approvedOn: string) => ({ sampleNo, approvedOn, reduced: false });
    const red = (sampleNo: string, approvedOn: string) => ({ sampleNo, approvedOn, reduced: true });
    expect(fullTestDue(rt, [], '2026-11-19', 'Demo Fine Chem')).toBe('No lot of Demo Fine Chem has been tested in full and approved yet: this lot is tested in full (full testing every 3 lots and at least every 12 months).');
    expect(fullTestDue(rt, [full('A', '2026-10-01')], '2026-11-19')).toBeNull();
    expect(fullTestDue(rt, [red('B', '2026-10-20'), full('A', '2026-10-01')], '2026-11-19')).toBeNull();
    expect(fullTestDue(rt, [red('C', '2026-11-01'), red('B', '2026-10-20'), full('A', '2026-10-01')], '2026-11-19', 'Demo Fine Chem'))
      .toBe('2 lots of Demo Fine Chem were tested on the certificate since A: this lot is tested in full (full testing every 3 lots and at least every 12 months).');
    expect(fullTestDue(rt, [full('A', '2025-11-19')], '2026-11-19', 'Demo Fine Chem'))
      .toBe('The last full test of Demo Fine Chem (A, 2025-11-19) is 12 months old or more: this lot is tested in full (full testing every 3 lots and at least every 12 months).');
    expect(fullTestDue(rt, [full('A', '2025-11-20')], '2026-11-19')).toBeNull();
    expect(reducedTestingProblems({ ...ok, past: [] })).toEqual(['No lot of Demo Fine Chem has been tested in full and approved yet: this lot is tested in full (full testing every 3 lots and at least every 12 months).']);
  });

  it('LIMS-09 a full-test mismatch stops reduced testing: an open OOS until it closes, a confirmed one until QA approves reduced testing again', () => {
    expect(reducedTestingProblems({ ...ok, oos: [{ oosNo: 'OOS2600004', status: 'open', openedOn: '2026-11-02' }] }))
      .toEqual(['OOS2600004 on a lot of Demo Fine Chem is open: lots are tested in full until it is closed.']);
    expect(reducedTestingProblems({ ...ok, oos: [{ oosNo: 'OOS2600004', status: 'confirmed', openedOn: '2026-11-02' }] }))
      .toEqual(['OOS2600004 on a lot of Demo Fine Chem was confirmed after reduced testing was approved: QA approves reduced testing again in QMS first.']);
    // Approved again in QMS after the OOS: reduced testing may go on; an invalidated OOS never stops it.
    expect(reducedTestingProblems({ ...ok, approval: { ...approval, reducedTestingApprovedAt: '2026-11-10' }, oos: [{ oosNo: 'OOS2600004', status: 'confirmed', openedOn: '2026-11-02' }] })).toEqual([]);
    expect(reducedTestingProblems({ ...ok, oos: [{ oosNo: 'OOS2600005', status: 'invalidated', openedOn: '2026-11-02' }] })).toEqual([]);
  });

  it('LIMS-09 at least one specific identity test is still done; reduced testing only for a starting or packing material', () => {
    expect(specChecks(doc, () => null).filter((p) => p.rule === 'LIMS-09')).toEqual([]);
    const noId = { ...doc, tests: doc.tests.map((x) => ({ ...x, identity: undefined })) };
    expect(specChecks(noId, () => null).filter((p) => p.rule === 'LIMS-09').map((p) => p.message)).toEqual(['Reduced testing needs at least one identity test, done here on every lot']);
    const fg = { ...doc, header: { ...doc.header, of: 'product' as const, type: 'Finished product' as const } };
    expect(specChecks(fg, () => null).filter((p) => p.rule === 'LIMS-09').map((p) => p.message)).toContain('Reduced testing on the supplier\'s certificate is for a raw material, an active substance or a packing material, not a finished product');
    expect(specSchema.safeParse({ ...doc, header: { ...doc.header, reducedTesting: { fullEvery: 1, months: 12 } } }).success).toBe(false);
    // The identity is never taken from the certificate; a certificate result only once QC recorded reduced testing.
    expect(outsideEntryRefusal(doc.tests[1], true, false, null, { reduced: true })).toBe('Identity (IR) is an identity test: it is always done in this lab, never taken from the certificate.');
    expect(outsideEntryRefusal(doc.tests[0], true, false, null, { reduced: false })).toBe('This lot is not tested on the supplier\'s certificate: QC records reduced testing on the sample first.');
    expect(outsideEntryRefusal(doc.tests[0], true, false, null, { reduced: true })).toBeNull();
  });

  it('LIMS-09 the certificate holds the required fields: the second person confirms them on the scan', () => {
    expect(outsideCheckRefusal({ enteredBy: 4, checked: false, certificate: true }, 5, null)).toMatch(/^Confirm the certificate gives the manufacturer's name and address, the batch number, /);
    expect(outsideCheckRefusal({ enteredBy: 4, checked: false, certificate: true }, 5, null, true)).toBeNull();
    expect(outsideCheckRefusal({ enteredBy: 4, checked: false }, 5, null)).toBeNull();
  });
});

// ---- On the server ----
function pdfText(def: TDocumentDefinitions): string {
  const walk = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(walk).join('');
    if (!c || typeof c !== 'object') return '';
    const o = c as { text?: unknown; stack?: unknown[]; table?: { body: unknown[][] } };
    if (o.stack) return o.stack.map(walk).join('\n');
    if (o.table) return o.table.body.map((r) => r.map((x) => walk(x).trim()).join(' | ')).join('\n');
    return walk(o.text);
  };
  return (def.content as Content[]).map(walk).join('\n');
}

let t: TestApp;
let provider: Sql;
const S = { mms: '', qms: '' };
const cookies: Record<string, string> = {};
beforeAll(async () => {
  t = await freshApp(async (db) => {
    S.mms = `${db.schema}_mms`;
    S.qms = `${db.schema}_qms`;
    await db.owner.unsafe(`
      create schema ${S.mms}; create schema ${S.qms};
      create table ${S.mms}.lot_v1 (lot_number text, kind text, material_master_id uuid, material_code text, product_master_id uuid, product_code text, status text,
        expiry_date date, retest_date date, qc_report_ref text, read_at timestamptz default now(), data_as_of timestamptz default now(), stock numeric, unit text,
        supplier_id uuid, manufacturer_id uuid, manufacturer_batch_no text);
      create table ${S.mms}.lot_test_v1 (lot_number text, report_ref text, test text, specification text, result text, value numeric, unit text, basis text,
        tested_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now());
      create table ${S.qms}.supplier_approval_v1 (material_id uuid, manufacturer_id uuid, supplier_id uuid, is_broker boolean, status text, approved_until date,
        reduced_testing_approved boolean, reduced_testing_approved_at date, data_as_of timestamptz default now(), record_number text);
      grant usage on schema ${S.mms}, ${S.qms} to lims_app;
      grant select on all tables in schema ${S.mms}, ${S.qms} to lims_app;
      insert into ${S.mms}.lot_v1 (lot_number, kind, material_master_id, material_code, status, expiry_date, stock, unit, supplier_id, manufacturer_id, manufacturer_batch_no) values
        ('DX-1', 'material', '${MAT}', 'RM-090', 'quarantine', '2099-01-31', 50, 'kg', '${SUP}', '${MF}', 'DFC-2601'),
        ('DX-2', 'material', '${MAT}', 'RM-090', 'quarantine', '2099-01-31', 50, 'kg', '${SUP}', '${MF}', 'DFC-2602'),
        ('DX-3', 'material', '${MAT}', 'RM-090', 'quarantine', '2099-01-31', 50, 'kg', '${SUP}', '${MF2}', 'OTH-2601');
      insert into ${S.qms}.supplier_approval_v1 (material_id, manufacturer_id, supplier_id, is_broker, status, approved_until, reduced_testing_approved, reduced_testing_approved_at, record_number) values
        ('${MAT}', '${MF}', '${SUP}', false, 'approved', '2099-12-31', true, '2026-01-10', 'SA-26-0007');`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ mms: provider, qms: provider }, { mms: S.mms, qms: S.qms });
  });
  t.master.materials_.push({ itemId: MAT, code: 'RM-090', name: 'Demoxetine (active substance)', version: 1, active: true, category: 'API', unit: 'kg' });
  t.master.suppliers_.push({ itemId: MF, code: 'SUP-DFC', name: 'Demo Fine Chem', version: 1, active: true, address: 'Plot 7, Demo Industrial Area' },
    { itemId: SUP, code: 'SUP-DTR', name: 'Demo Traders', version: 1, active: true, address: null });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register', 'lims.view'], analyst: ['lims.analysis.perform', 'lims.view'], reviewer: ['lims.analysis.review', 'lims.view'],
    qcuser: ['lims.qc.approve', 'lims.view'], viewer: ['lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(async () => { await provider?.end(); await t.close(); });

const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
async function effective(kind: 'method' | 'spec', doc: object) {
  const r = await as('author', 'POST', '/api/masters', { kind, doc });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number; masterId: number };
  const hash = async (who: string) => ((await as(who, 'GET', `/api/master-versions/${v.id}/review`)).json() as { contentHash: string }).contentHash;
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-090' }]] as const) {
    const res = await as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hash(who), ...x });
    expect(res.statusCode, `${a}: ${res.body}`).toBe(200);
  }
  if (kind === 'method') await validatedOutside(t.owner, v.id);
  expect((await as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
  return v;
}
const method = (code: string) => {
  const d = small([{ role: 'Analyst', steps: [{ key: 'ph', block: { id: 'check', version: 1 }, settings: { what: 'Reading', unit: '', limit: { spec: 'limit' } } }] }]);
  d.header.code = code;
  d.header.name = `${code} method`;
  return d;
};
const ph = { id: 0, masterId: 0 };
const ir = { id: 0, masterId: 0 };
let specId = 0;
async function sampleOf(lot: string) {
  const r = await as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: lot, specVersionId: specId, quantity: '50 g', purpose: 'release', received: 1, sampled: [1] });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  expect((await as('sampler', 'POST', `/api/samples/${id}/receive`, { condition: 'Sealed' })).statusCode).toBe(200);
  return id;
}
async function analysed(sampleId: number, m: { id: number }, reading: string, container?: number) {
  const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: m.id, sampleId, proof: proofFor('analyst'), ...(container ? { container } : {}) });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  expect((await step('start')).statusCode).toBe(200);
  expect((await step('record', { values: { reading } })).statusCode).toBe(200);
  const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] };
  expect((await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash })).statusCode).toBe(200);
  const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
  expect((await as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash })).statusCode).toBe(200);
}
type Detail = { decisionHash: string; approvalProblems: string[]; reducedTesting: { recorded: { payload: Record<string, unknown> } | null; problems: string[]; basis: Record<string, unknown> | null } | null };
const detail = async (id: number, who = 'qcuser') => (await as(who, 'GET', `/api/samples/${id}`)).json() as Detail;
const approve = async (id: number) => as('qcuser', 'POST', `/api/samples/${id}/approve`, { proof: proofFor('qcuser'), contentHash: (await detail(id)).decisionHash });
const scan = Buffer.from('%PDF-1.4 demo certificate of analysis of the manufacturer');

describe('on the server', () => {
  beforeAll(async () => {
    Object.assign(ph, await effective('method', method('PH')));
    Object.assign(ir, await effective('method', method('IR')));
    specId = (await effective('spec', specOf(ph, ir))).id;
  });

  it('LIMS-09 the first lot of a manufacturer is tested in full; the next is tested on its certificate: identity here, the rest typed from the scan and checked, named on the CoA and in result_v1', async () => {
    // Lot 1: no full test of the manufacturer yet.
    const s1 = await sampleOf('DX-1');
    expect((await detail(s1)).reducedTesting!.problems).toEqual(['No lot of Demo Fine Chem has been tested in full and approved yet: this lot is tested in full (full testing every 3 lots and at least every 12 months).']);
    expect((await as('qcuser', 'POST', `/api/samples/${s1}/reduced-testing`)).statusCode).toBe(409);
    await analysed(s1, ph, '6.1');
    await analysed(s1, ir, '6.0', 1);
    expect((await approve(s1)).statusCode).toBe(200);

    // Lot 2: QMS approves the manufacturer and supplier for reduced testing; QC records it.
    const s2 = await sampleOf('DX-2');
    const d = await detail(s2);
    expect(d.reducedTesting!.problems).toEqual([]);
    expect(d.reducedTesting!.basis).toMatchObject({ manufacturer: 'Demo Fine Chem', manufacturerAddress: 'Plot 7, Demo Industrial Area', supplier: 'Demo Traders', manufacturerBatchNo: 'DFC-2602',
      broker: false, approval: 'SA-26-0007', lastFull: expect.stringMatching(/^LS\d+ \(\d{4}-\d\d-\d\d\)$/), fullEvery: 3, months: 12 });
    expect((await detail(s2, 'viewer')).reducedTesting!.problems[0]).toBe('Reduced testing is recorded by QC with the QC approval permission.');
    expect((await as('analyst', 'POST', `/api/samples/${s2}/reduced-testing`)).statusCode).toBe(403);
    // A certificate result before QC records reduced testing is refused.
    const body = { certificate: true, test: 'ph', reportNo: 'DFC-COA-2602', file: { name: 'DFC-COA-2602.pdf', content: scan.toString('base64') }, value: '6.30', unit: '' };
    expect((await as('analyst', 'POST', `/api/samples/${s2}/outside`, body)).json().problems).toEqual(['This lot is not tested on the supplier\'s certificate: QC records reduced testing on the sample first.']);
    const rec = await as('qcuser', 'POST', `/api/samples/${s2}/reduced-testing`);
    expect(rec.statusCode, rec.body).toBe(200);
    expect((await as('qcuser', 'POST', `/api/samples/${s2}/reduced-testing`)).json().problems).toEqual(['This lot is already tested on the supplier\'s certificate.']);
    // Identity is never from the certificate; the lab is the manufacturer QC recorded, not typed.
    expect((await as('analyst', 'POST', `/api/samples/${s2}/outside`, { ...body, test: 'id' })).json().problems).toEqual(['Identity (IR) is done on each container of the starting material, in this lab.']);
    const r = await as('analyst', 'POST', `/api/samples/${s2}/outside`, { ...body, lab: 'Typed Lab' });
    expect(r.statusCode, r.body).toBe(200);
    const rid = (r.json() as { id: number }).id;
    const [row] = await t.owner<{ lab: string; certificate: boolean }[]>`select lab, certificate from outside_results where id = ${rid}`;
    expect(row).toEqual({ lab: 'Demo Fine Chem', certificate: true });
    // The checker confirms the certificate's fields.
    expect((await as('reviewer', 'POST', `/api/samples/${s2}/outside/${rid}/check`, {})).json().problems[0]).toMatch(/^Confirm the certificate gives /);
    expect((await as('reviewer', 'POST', `/api/samples/${s2}/outside/${rid}/check`, { certificateFields: true })).statusCode).toBe(200);
    await analysed(s2, ir, '6.0', 1);
    expect((await detail(s2)).approvalProblems).toEqual([]);
    const ok = await approve(s2);
    expect(ok.statusCode, ok.body).toBe(200);
    const coaNo = (ok.json() as { coaNo: string }).coaNo;
    const rows = await t.owner.unsafe(`select test_key, outside_lab, analysis_number, method_code from ${t.schema}_report.result_v1 where coa_number = '${coaNo}' order by test_key`);
    expect(rows).toEqual([{ test_key: 'id', outside_lab: null, analysis_number: expect.stringMatching(/^LA/), method_code: 'IR' },
      { test_key: 'ph', outside_lab: 'supplier\'s certificate (Demo Fine Chem)', analysis_number: 'DFC-COA-2602', method_code: 'Supplier\'s certificate: Demo Fine Chem' }]);
    const s = (await loadSampleRow(t.sql, s2))!;
    const [ev] = await t.owner`select e.id::int, e.kind, e.payload, e.person_id::int as person, 'QCUSER' as "personName", e.at, null as signature from sample_events e where e.sample_id = ${s2} and e.kind = 'approved'`;
    const text = pdfText(coaDoc({ sample: s, spec: specOf(ph, ir), specVersion: 1, decision: ev as never }, 'VIEWER'));
    expect(text).toContain('SUPPLIER\'S CERTIFICATE: Demo Fine Chem\ncertificate DFC-COA-2602');
    expect(text).toContain(`pH: taken from the certificate DFC-COA-2602 of the manufacturer Demo Fine Chem (scan DFC-COA-2602.pdf, SHA-256 ${createHash('sha256').update(scan).digest('hex')})`);
    expect(await t.owner`select 1 from audit_log where action = 'sample.reduced_testing' and object_id = ${String(s2)}`).toHaveLength(1);
  });

  it('LIMS-09 a lot of a manufacturer QMS has not approved is tested in full', async () => {
    const s3 = await sampleOf('DX-3');
    expect((await detail(s3)).reducedTesting!.problems).toEqual(['QMS has no supplier approval of RM-090 from the manufacturer through this supplier.',
      'No lot of the manufacturer has been tested in full and approved yet: this lot is tested in full (full testing every 3 lots and at least every 12 months).']);
  });
});
