import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { small } from './engine-fixture.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';
import { addYears, parseQty, reserveLogProblems, reserveRefusal, reserveShortfall, reserveStatus, type ReserveEvent, type ReserveFacts } from '../shared/engine/reserve.js';
import { approvalProblems, type SampleEvent } from '../shared/engine/sample.js';
import { specSchema, type SpecDoc } from '../shared/master/spec.js';

// Reserve (retention) samples (LIMS-30): logged per lot at the specification's quantity, kept for the required time,
// inspected yearly, withdrawals and the destruction checked by a second person; QC approval of a release sample waits
// for it. The retest of stored materials (LIMS-31): MMS's released lots by their retest date, and their retest samples.

// ---- The rules (shared/engine/reserve.ts) ----
const today = '2026-11-18';
const r: ReserveFacts = { amount: '60', unit: 'tablets', location: 'Reserve store, cabinet 3', rule: 'expiry', fromDate: '2028-10-31', keptUntil: '2029-10-31', loggedBy: 1, day: '2026-11-18' };
const req = parseQty('40 tablets');
let n = 0;
const ev = (kind: ReserveEvent['kind'], payload: ReserveEvent['payload'] = {}, person = 1, day = today): ReserveEvent => ({ id: ++n, kind, person, day, payload });

describe('the reserve sample rules', () => {
  it('LIMS-30 logged at least at the specification\'s quantity, in its unit, with a location and a kept-until date checked against the rule', () => {
    const ok = { quantity: '60 tablets', location: 'Reserve store, cabinet 3', rule: 'expiry' as const, fromDate: '2028-10-31', keptUntil: '2029-10-31' };
    expect(reserveLogProblems(ok, req, today)).toEqual([]);
    expect(reserveLogProblems({ ...ok, quantity: '30 tablets' }, req, today)).toEqual(['The specification asks for at least 40 tablets: keep at least that much (US 211.170(a)).']);
    expect(reserveLogProblems({ ...ok, quantity: '60 g' }, req, today)[0]).toMatch(/asks for the reserve in tablets/);
    expect(reserveLogProblems({ ...ok, location: ' ' }, req, today)).toEqual(['Give the storage location.']);
    // 1 year after expiry (US 211.170(b)); 3 years after complete distribution for an API with a retest date (Q7 11.71).
    expect(reserveLogProblems({ ...ok, keptUntil: '2029-10-30' }, req, today)).toEqual(['Kept until must be on or after 31 Oct 2029: 1 year after the expiry date of the lot or batch.']);
    expect(reserveLogProblems({ ...ok, rule: 'distribution', fromDate: '2027-01-15', keptUntil: '2029-10-31' }, req, today)).toEqual(['Kept until must be on or after 15 Jan 2030: 3 years after the batch is completely distributed (an API with a retest date).']);
    expect(reserveLogProblems({ ...ok, fromDate: '2024-01-01', keptUntil: '2025-01-01' }, req, today)).toEqual(['The kept-until date must be after today.']);
    // No quantity in the specification: any quantity with its unit.
    expect(reserveLogProblems({ ...ok, quantity: '5 g' }, null, today)).toEqual([]);
    expect(addYears('2028-02-29', 1)).toBe('2029-02-28');
  });

  it('LIMS-30 the status: kept, visual inspection overdue a year after the last, below the required quantity after withdrawals, destroyed', () => {
    expect(reserveStatus(r, [], req, today)).toMatchObject({ status: 'kept', left: '60', inspectionDue: '2027-11-18', why: [] });
    expect(reserveStatus(r, [], req, '2027-11-19')).toMatchObject({ status: 'visual inspection overdue', why: ['the yearly visual inspection was due on 18 Nov 2027'] });
    expect(reserveStatus(r, [ev('inspected', { finding: 'no deterioration' }, 2, '2027-11-10')], req, '2027-11-19').status).toBe('kept');
    const deteriorated = reserveStatus(r, [ev('inspected', { finding: 'deterioration', reason: 'Tablets mottled' }, 2, '2027-11-10')], req, '2027-11-19');
    expect(deteriorated.why).toEqual(['deterioration seen on 10 Nov 2027: Tablets mottled']);
    const w = ev('withdrawn', { amount: '30', reason: 'Complaint investigation' });
    const below = reserveStatus(r, [w], req, today);
    expect(below).toMatchObject({ status: 'below the required quantity', left: '30' });
    expect(below.why).toEqual(['below the required quantity: 30 tablets left, the specification asks for at least 40 tablets', 'the withdrawal of 30 tablets of 18 Nov 2026 waits for a second person\'s check']);
    expect(reserveStatus(r, [w, ev('checked', { of: w.id }, 2)], req, today).why).toEqual(['below the required quantity: 30 tablets left, the specification asks for at least 40 tablets']);
    expect(reserveStatus(r, [ev('destroyed', { reason: 'Retention period over' }, 1, '2029-11-02')], req, '2029-11-02').status).toBe('destroyed');
  });

  it('LIMS-30 entries: a withdrawal within what is left, checked by a second person; no destruction before the kept-until date; nothing after it', () => {
    expect(reserveRefusal('withdraw', r, [], 1, { amount: '61', reason: 'x' }, today)).toBe('Only 60 tablets is left.');
    expect(reserveRefusal('withdraw', r, [], 1, { amount: '10' }, today)).toBe('Give the reason for the withdrawal.');
    expect(reserveRefusal('withdraw', r, [], 1, { amount: '10', reason: 'Complaint' }, today)).toBeNull();
    const w = ev('withdrawn', { amount: '10', reason: 'Complaint' }, 1);
    expect(reserveRefusal('withdraw', r, [w], 1, { amount: '1', reason: 'x' }, today)).toBe(`Entry ${w.id} waits for a second person's check first.`);
    expect(reserveRefusal('check', r, [w], 1, {}, today)).toBe('The person who recorded the entry cannot check it: a second person checks it.');
    expect(reserveRefusal('check', r, [w], 2, {}, today)).toBeNull();
    expect(reserveRefusal('check', r, [], 2, {}, today)).toMatch(/no withdrawal or destruction waiting/);
    expect(reserveRefusal('inspect', r, [], 1, { finding: 'deterioration' }, today)).toBe('Say what deterioration was seen.');
    expect(reserveRefusal('destroy', r, [], 1, { reason: 'x' }, '2029-10-31')).toBe('The reserve sample is kept until 31 Oct 2029: it is not destroyed earlier.');
    expect(reserveRefusal('destroy', r, [], 1, { reason: 'Retention period over' }, '2029-11-01')).toBeNull();
    const d = ev('destroyed', { reason: 'Retention period over' }, 1, '2029-11-01');
    expect(reserveRefusal('note', r, [d], 1, { text: 'x' }, '2029-11-01')).toBe('The reserve sample is destroyed: nothing more is recorded.');
    expect(reserveRefusal('check', r, [d], 2, {}, '2029-11-01')).toBeNull();
  });

  it('LIMS-30 QC approval of a release sample waits for its reserve sample at the required quantity; a specification without one checks nothing', () => {
    const events: SampleEvent[] = [{ kind: 'received', person: 1, payload: {} }];
    const none = { required: req, reserve: null };
    expect(approvalProblems({ registeredBy: 1, byHand: false }, events, [], 9, [], none))
      .toEqual(['No reserve sample of this lot or batch is logged: the specification asks for at least 40 tablets (US 211.170, EU Annex 19).']);
    expect(reserveShortfall({ required: req, reserve: { left: '30', unit: 'tablets', destroyed: false } })).toBe('The reserve sample is below the required quantity: 30 tablets left, the specification asks for at least 40 tablets.');
    expect(reserveShortfall({ required: req, reserve: { left: '40', unit: 'Tablets', destroyed: false } })).toBeNull();
    expect(reserveShortfall({ required: null, reserve: null })).toBeNull();
    expect(approvalProblems({ registeredBy: 1, byHand: false }, events, [], 9, [])).toEqual([]);
  });
});

// ---- On the server ----
let t: TestApp;
let provider: Sql;
let mms = '';
const cookies: Record<string, string> = {};
const MAT = '00000000-0000-0000-0000-00000000003a';
let method = { id: 0, masterId: 0 };
const specIds: Record<string, number> = {};

const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
async function effective(kind: 'method' | 'spec', doc: object) {
  const r = await as('author', 'POST', '/api/masters', { kind, doc });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number; masterId: number };
  for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${v.id}`;
  return v;
}
const spec = (number: string, reserveQuantity?: string): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: MAT, code: 'RM-031', name: 'Demolol', type: 'Active substance', number, pharmacopoeia: 'Ph. Int.', ...(reserveQuantity ? { reserveQuantity } : {}) },
  tests: [{ key: 'ph', name: 'pH', method: { masterId: method.masterId, code: 'M', name: 'M' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' } }],
});
/** A release sample of a lot waiting in MMS (received) with a reviewed pH within limits. */
async function readySample(specId: number, lot: string) {
  const r = await as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: lot, specVersionId: specId, quantity: '30 g', purpose: 'release' });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  expect((await as('sampler', 'POST', `/api/samples/${id}/receive`, { condition: 'Sealed' })).statusCode).toBe(200);
  const a = await as('analyst', 'POST', '/api/analyses', { masterVersionId: method.id, sampleId: id, proof: proofFor('analyst') });
  const aid = (a.json() as { id: number }).id;
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${aid}/steps/0.1.0.1/${action}`, body);
  await step('start');
  await step('record', { values: { reading: '6.1' } });
  const d = (await as('analyst', 'GET', `/api/analyses/${aid}`)).json() as { steps: { contentHash: string }[] };
  expect((await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash })).statusCode).toBe(200);
  const rv = (await as('reviewer', 'GET', `/api/analyses/${aid}`)).json() as { analysis: { contentHash: string } };
  expect((await as('reviewer', 'POST', `/api/analyses/${aid}/review`, { proof: proofFor('reviewer'), contentHash: rv.analysis.contentHash })).statusCode).toBe(200);
  return id;
}
type Detail = { decisionHash: string; approvalProblems: string[]; reserve: { id: number; state: { status: string; left: string } } | null; reserveNote: string | null };
const detail = async (id: number) => (await as('qcuser', 'GET', `/api/samples/${id}`)).json() as Detail;
const approve = async (id: number) => as('qcuser', 'POST', `/api/samples/${id}/approve`, { proof: proofFor('qcuser'), contentHash: (await detail(id)).decisionHash });
const inYears = (y: number) => addYears(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), y);

beforeAll(async () => {
  t = await freshApp(async (db) => {
    mms = `${db.schema}_mms`;
    await db.owner.unsafe(`
      create schema ${mms};
      create table ${mms}.lot_v1 (lot_number text, kind text, material_master_id uuid, material_code text, product_master_id uuid, product_code text, status text,
        expiry_date date, retest_date date, qc_report_ref text, read_at timestamptz default now(), data_as_of timestamptz default now(), stock numeric, unit text);
      create table ${mms}.lot_test_v1 (lot_number text, report_ref text, test text, specification text, result text, value numeric, unit text, basis text,
        tested_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now());
      grant usage on schema ${mms} to lims_app; grant select on all tables in schema ${mms} to lims_app;
      insert into ${mms}.lot_v1 (lot_number, kind, material_master_id, material_code, status, expiry_date, retest_date, stock, unit) values
        ('RT-PAST', 'material', '${MAT}', 'RM-031', 'released', '2099-01-31', current_date - 10, 80, 'kg'),
        ('RT-SOON', 'material', '${MAT}', 'RM-031', 'approved', '2099-01-31', current_date + 20, 40, 'kg'),
        ('RT-LATER', 'material', '${MAT}', 'RM-031', 'released', '2099-01-31', current_date + 200, 40, 'kg'),
        ('RT-REJ', 'material', '${MAT}', 'RM-031', 'rejected', '2099-01-31', current_date - 5, 40, 'kg'),
        ('RS-L1', 'material', '${MAT}', 'RM-031', 'quarantine', '2099-01-31', null, 120, 'kg'),
        ('RS-L2', 'material', '${MAT}', 'RM-031', 'quarantine', '2099-01-31', null, 120, 'kg');`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ mms: provider }, { mms });
  });
  t.master.materials_.push({ itemId: MAT, code: 'RM-031', name: 'Demolol', version: 1, active: true, category: 'API', unit: 'kg' });
  const people = { author: ['lims.master.author'], sampler: ['lims.sample.register', 'lims.view'], sampler2: ['lims.sample.register'],
    analyst: ['lims.analysis.perform'], reviewer: ['lims.analysis.review'], qcuser: ['lims.qc.approve', 'lims.view'], viewer: ['lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
  method = await effective('method', small([{ role: 'Analyst', steps: [{ key: 'ph', block: { id: 'check', version: 1 }, settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]));
  specIds.reserve = (await effective('spec', spec('SPEC-RM-031', '20 g'))).id;
});
afterAll(async () => {
  await provider?.end();
  if (mms) await t.owner.unsafe(`drop schema if exists ${mms} cascade`);
  await t?.close();
});

describe('reserve samples on the server', () => {
  let sid = 0;
  let rid = 0;
  it('LIMS-30 QC approval is refused until the lot\'s reserve sample is logged at the specification\'s quantity, with its location and kept-until date', async () => {
    sid = await readySample(specIds.reserve!, 'RS-L1');
    const d = await detail(sid);
    expect(d.reserve).toBeNull();
    expect(d.approvalProblems).toEqual(['No reserve sample of this lot or batch is logged: the specification asks for at least 20 g (US 211.170, EU Annex 19).']);
    expect((await approve(sid)).json().problems).toEqual(d.approvalProblems);
    // Below the quantity, or kept too short a time: refused with the reason.
    const log = (body: object) => as('sampler', 'POST', `/api/samples/${sid}/reserve`, { quantity: '20 g', location: 'Reserve store, cabinet 3', rule: 'expiry', fromDate: inYears(2), keptUntil: inYears(3), ...body });
    expect((await log({ quantity: '10 g' })).json().problems).toEqual(['The specification asks for at least 20 g: keep at least that much (US 211.170(a)).']);
    expect((await log({ keptUntil: inYears(2) })).json().problems[0]).toMatch(/^Kept until must be on or after .*: 1 year after the expiry date/);
    expect((await as('viewer', 'POST', `/api/samples/${sid}/reserve`, { quantity: '20 g', location: 'x', rule: 'expiry', fromDate: inYears(2), keptUntil: inYears(3) })).statusCode).toBe(403);
    const ok = await log({});
    expect(ok.statusCode, ok.body).toBe(200);
    rid = (ok.json() as { id: number }).id;
    expect((await log({})).json().problems).toEqual(['The reserve sample of RS-L1 is already logged.']);
    const after = await detail(sid);
    expect(after.reserve).toMatchObject({ id: rid, state: { status: 'kept', left: '20' } });
    expect(after.approvalProblems).toEqual([]);
    const r = await approve(sid);
    expect(r.statusCode, r.body).toBe(200);
  });

  it('LIMS-30 the yearly visual inspection, a withdrawal checked by a second person (then below the required quantity), no early destruction; each entry audited', async () => {
    const entry = (who: string, action: string, body: object = {}) => as(who, 'POST', `/api/reserves/${rid}/${action}`, body);
    expect((await entry('sampler', 'inspect', { finding: 'no deterioration' })).statusCode).toBe(200);
    expect((await entry('sampler', 'withdraw', { amount: '25', reason: 'Complaint investigation' })).json().problems).toEqual(['Only 20 g is left.']);
    expect((await entry('sampler', 'withdraw', { amount: '5', reason: 'Complaint investigation CMP-26-004' })).statusCode).toBe(200);
    expect((await entry('sampler', 'check')).statusCode).toBe(403);
    expect((await entry('sampler2', 'check')).statusCode).toBe(200);
    expect((await entry('sampler', 'destroy', { reason: 'Retention over' })).json().problems[0]).toMatch(/^The reserve sample is kept until .*: it is not destroyed earlier\.$/);
    const d = (await as('viewer', 'GET', `/api/reserves/${rid}`)).json() as { state: { status: string; left: string; why: string[] }; events: { kind: string }[]; actions: string[] };
    expect(d.state).toMatchObject({ status: 'below the required quantity', left: '15' });
    expect(d.events.map((e) => e.kind)).toEqual(['inspected', 'withdrawn', 'checked']);
    expect(d.actions).toEqual([]);
    const list = (await as('viewer', 'GET', '/api/reserves')).json() as { id: number; lotNo: string; state: { status: string } }[];
    expect(list.find((x) => x.id === rid)).toMatchObject({ lotNo: 'RS-L1', state: { status: 'below the required quantity' } });
    const audited = await t.owner<{ action: string }[]>`select action from audit_log where object_type = 'reserve_sample' and object_id = ${String(rid)} order by id`;
    expect(audited.map((a) => a.action)).toEqual(['reserve.logged', 'reserve.inspected', 'reserve.withdrawn', 'reserve.checked']);
    // Insert-only (LIMS-46).
    await expect(t.owner`update reserve_samples set amount = 100 where id = ${rid}`).rejects.toThrow();
  });

  it('LIMS-30 a specification without a reserve quantity: QC approval is not held, and the decision says no reserve is checked', async () => {
    const plain = (await effective('spec', spec('SPEC-RM-031-B'))).id;
    const s = await readySample(plain, 'RS-L2');
    const d = await detail(s);
    expect(d.approvalProblems).toEqual([]);
    expect(d.reserveNote).toBe('The specification names no reserve quantity: the reserve sample is not checked at approval.');
  });
});

describe('the retest of stored materials on the server', () => {
  type Due = { link: string; rows: { lotNo: string; past: boolean; retestDate: string; sampleNo: string | null; specs: { id: number }[] }[]; pastWithout: string[] };
  const due = async (days = 30) => (await as('sampler', 'GET', `/api/retest-due?days=${days}`)).json() as Due;

  it('LIMS-31 the released lots whose retest date is past or within the days asked, read live from MMS; those past without a retest sample are named', async () => {
    const d = await due();
    expect(d.link).toBe('ok');
    expect(d.rows.map((r) => [r.lotNo, r.past])).toEqual([['RT-PAST', true], ['RT-SOON', false]]);
    expect(d.rows[0]!.specs.length).toBeGreaterThan(0);
    expect(d.pastWithout).toEqual(['RT-PAST']);
    expect((await due(365)).rows.map((r) => r.lotNo)).toEqual(['RT-PAST', 'RT-SOON', 'RT-LATER']);
  });

  it('LIMS-31 the retest sample of a released lot is registered from the list against the effective specification, one at a time', async () => {
    const reg = (lot: string, purpose = 'retest') => as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: lot, specVersionId: specIds.reserve, quantity: '25 g', purpose });
    // A released lot is not sampled for release; a rejected lot is not retested.
    expect((await reg('RT-PAST', 'release')).json().problems[0]).toMatch(/only a lot in quarantine or under test waits to be sampled/);
    expect((await reg('RT-REJ')).json().problems).toEqual(['Lot RT-REJ is rejected in MMS: only a released lot, or one waiting to be sampled, is retested.']);
    const r = await reg('RT-PAST');
    expect(r.statusCode, r.body).toBe(200);
    const { sampleNo } = r.json() as { sampleNo: string };
    expect((await reg('RT-PAST')).json().problems).toEqual([`Lot RT-PAST already has its retest sample ${sampleNo}, waiting for QC's decision.`]);
    const d = await due();
    expect(d.rows[0]).toMatchObject({ lotNo: 'RT-PAST', sampleNo });
    expect(d.pastWithout).toEqual([]);
  });

  it('LIMS-31 MMS down: the list says so (the retest sample is then registered by hand, checked by a second person)', async () => {
    await t.owner.unsafe(`revoke select on all tables in schema ${mms} from lims_app`);
    try {
      expect((await due()).link).toBe('down');
    } finally {
      await t.owner.unsafe(`grant select on all tables in schema ${mms} to lims_app`);
    }
  });

  it('LIMS-43 only samplers read the retest-due list', async () => {
    expect((await as('viewer', 'GET', '/api/retest-due')).statusCode).toBe(403);
  });
});
