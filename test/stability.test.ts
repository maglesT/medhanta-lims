import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { plantToday } from '../server/routes/inventory.js';
import { protocolChecks, type ProtocolDoc } from '../shared/master/protocol.js';
import {
  addDays, addMonths, affectedBy, capacity, checkRefusal, extraRefusal, ongoingFlags, pointState, pullRefusal, schedule, stock, type StudyEvent,
} from '../shared/engine/stability.js';
import type { SpecDoc } from '../shared/master/spec.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';

// Stability (LIMS-26, LIMS-27, LIMS-28): an approved protocol with every element; a study of one batch placed in
// chambers the Logbook says are fit; pulls on schedule make stability samples; a late pull needs its reason and a
// deviation; the stock per condition; excursions; on-going stability flags; chamber capacity.

const protocol = (over: Partial<ProtocolDoc> = {}, header: Partial<ProtocolDoc['header']> = {}): ProtocolDoc => ({
  header: { of: 'product', itemId: 'prd-1', code: 'FG-001', name: 'Examplol 500 mg tablets', number: 'STP-FG-001', purpose: 'ongoing',
    containerClosure: 'Alu-Alu blister, 10 tablets', sameAsMarketed: true, shelfLifeMonths: 24, ...header },
  spec: { versionId: 1, number: 'SPEC-FG-001', versionNo: 1 },
  quantity: { amount: '20', unit: 'tablets' },
  pullWindowDays: 7,
  conditions: [{ key: 'lt', code: '30/75', role: 'long-term', months: [0, 3, 6, 9, 12, 18, 24] }, { key: 'acc', code: '40/75', role: 'accelerated', months: [0, 3, 6] }],
  design: { type: 'full', factors: [], matrix: [] },
  ...over,
});
const specDoc = (use: 'release' | 'stability' | 'release and stability' = 'release and stability'): SpecDoc => ({
  header: { of: 'product', itemId: 'prd-1', code: 'FG-001', name: 'Examplol 500 mg tablets', type: 'Finished product', number: 'SPEC-FG-001', pharmacopoeia: 'In-house' },
  tests: [{ key: 'assay', name: 'Assay', method: { masterId: 1, code: 'QC-M-001', name: 'Assay by HPLC' }, result: 'run/result/result', limitType: 'range',
    limit: { low: '95.0', high: '105.0', unit: '%' }, values: {}, use }],
});
const ev = (id: number, kind: StudyEvent['kind'], payload: StudyEvent['payload'] = {}, person = 1): StudyEvent => ({ id, kind, payload, person });
const chamber = { itemId: 'eq-ch1', code: 'CH-01', name: 'Stability chamber 30/75' };

describe('the stability protocol (LIMS-26)', () => {
  const spec = { state: 'effective', doc: specDoc() };
  it('LIMS-26 a complete protocol has no problems', () => {
    expect(protocolChecks(protocol(), spec)).toEqual([]);
  });
  it('LIMS-26 approval is refused while a required element is missing: container closure (the marketed one), specification, conditions, quantity', () => {
    const m = (doc: ProtocolDoc, s: typeof spec | null = spec) => protocolChecks(doc, s).map((p) => p.message).join(' | ');
    expect(m(protocol({}, { containerClosure: '' }))).toMatch(/container closure/);
    expect(m(protocol({}, { sameAsMarketed: false }))).toMatch(/marketed/);
    expect(m(protocol({ spec: null }))).toMatch(/Pick the specification version/);
    expect(m(protocol(), null)).toMatch(/does not exist/);
    expect(m(protocol(), { state: 'draft', doc: specDoc() })).toMatch(/pick an approved or effective version/);
    expect(m(protocol(), { state: 'effective', doc: specDoc('release') })).toMatch(/no test that applies on stability/);
    expect(m(protocol(), { state: 'effective', doc: { ...specDoc(), header: { ...specDoc().header, code: 'FG-999', name: 'Other tablets' } } })).toMatch(/is for FG-999/);
    expect(m(protocol({ conditions: [] }))).toMatch(/Add the storage conditions/);
    expect(m(protocol({ quantity: { amount: '0', unit: 'tablets' } }))).toMatch(/quantity pulled/);
    expect(protocolChecks(protocol({}, { sameAsMarketed: false }), spec).every((p) => p.rule === 'LIMS-26')).toBe(true);
  });
  it('LIMS-26 the time points run to the end of shelf life at a long-term condition; they go up; "other" says what it is', () => {
    const m = (doc: ProtocolDoc) => protocolChecks(doc, spec).map((p) => p.message).join(' | ');
    expect(m(protocol({}, { shelfLifeMonths: 36 }))).toMatch(/end of the shelf life \(36 months\)/);
    expect(m(protocol({ conditions: [{ key: 'acc', code: '40/75', role: 'accelerated', months: [0, 3, 6, 36] }] }))).toMatch(/No long-term condition/);
    expect(m(protocol({ conditions: [{ key: 'lt', code: '25/60', role: 'long-term', months: [0, 6, 3, 24] }] }))).toMatch(/go up, each once/);
    expect(m(protocol({ conditions: [{ key: 'lt', code: 'other', role: 'long-term', months: [0, 24] }] }))).toMatch(/"other" condition/);
    expect(m(protocol({ conditions: [{ key: 'a', code: '25/60', role: 'long-term', months: [24] }, { key: 'b', code: '25/60', role: 'long-term', months: [24] }] }))).toMatch(/listed twice/);
  });
  it('LIMS-26 a reduced design is checked against ICH Q1D by template L25 at approval: extremes tested, related formulations, matrix time points, and why', () => {
    const m = (design: Partial<ProtocolDoc['design']>) => protocolChecks(protocol({ design: { type: 'full', factors: [], matrix: [], ...design } }), spec).map((p) => p.message).join(' | ');
    const lv = (tested: string[]) => [['250 mg', '250 mg'], ['500 mg', '500 mg'], ['1000 mg', '1000 mg']].map(([name, size]) => ({ name: name!, size, tested: tested.includes(name!) }));
    const strength = (tested: string[], formulation: 'identical' | 'different' = 'identical') => [{ name: 'Strength', kind: 'strength' as const, levels: lv(tested), formulation }];
    expect(m({ type: 'bracketing' })).toMatch(/says why/);
    expect(m({ type: 'bracketing', justification: 'Same blend' })).toMatch(/Bracketing needs the factors/);
    expect(m({ type: 'bracketing', justification: 'Same blend', factors: strength(['250 mg', '500 mg']) })).toMatch(/Strength: the extremes must be tested; 1000 mg is an extreme and not tested/);
    expect(m({ type: 'bracketing', justification: 'Different blends', factors: strength(['250 mg', '1000 mg'], 'different') })).toMatch(/identical or closely related formulations/);
    expect(m({ type: 'bracketing', justification: 'Same blend', factors: strength(['250 mg', '1000 mg']) })).toBe('');
    // Matrixing at 30/75 (0 … 24 months): every cell at the initial, 12-month and final points, half the others.
    const cells = [{ cell: 'Batch 1', condition: 'lt', months: [0, 3, 9, 12, 24] }, { cell: 'Batch 2', condition: 'lt', months: [0, 6, 12, 18, 24] }];
    expect(m({ type: 'matrixing', justification: 'Q1D one-half', matrix: [{ cell: 'Batch 1', condition: 'lt', months: [0, 4, 12] }], reduction: '1/2', variability: 'small' })).toMatch(/4 months is not a time point/);
    expect(m({ type: 'matrixing', justification: 'Q1D one-half', matrix: [{ ...cells[0]!, months: [0, 3, 9, 12] }, cells[1]!], reduction: '1/2', variability: 'small' })).toMatch(/Batch 1: every combination is tested at the initial and final time points/);
    expect(m({ type: 'matrixing', justification: 'Q1D one-half', matrix: cells, reduction: '1/2', variability: 'large' })).toMatch(/large variability/);
    expect(m({ type: 'matrixing', justification: 'Q1D one-half', matrix: cells, reduction: '1/2', variability: 'small' })).toBe('');
  });
});

describe('the schedule and the stock', () => {
  it('LIMS-28 each time point is due months after T0 with its pull window; the 31st becomes the month\'s last day', () => {
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonths('2027-08-31', 6)).toBe('2028-02-29');
    expect(addMonths('2026-11-18', 14)).toBe('2028-01-18');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    const s = schedule(protocol(), '2026-11-18');
    expect(s).toHaveLength(10);
    expect(s.find((p) => p.condition === 'lt' && p.month === 3)).toEqual({ condition: 'lt', label: '30 °C / 75 % RH (India, zone IVb)', month: 3, due: '2027-02-18', from: '2027-02-11', to: '2027-02-25' });
  });
  it('LIMS-28 a matrixed batch follows its own cell\'s time points', () => {
    const doc = protocol({ design: { type: 'matrixing', factors: [], matrix: [{ cell: 'Batch 2', condition: 'lt', months: [0, 6, 12, 24] }], justification: 'Q1D' } });
    expect(schedule(doc, '2026-01-01', 'Batch 2').filter((p) => p.condition === 'lt').map((p) => p.month)).toEqual([0, 6, 12, 24]);
    expect(schedule(doc, '2026-01-01').filter((p) => p.condition === 'lt').map((p) => p.month)).toEqual([0, 3, 6, 9, 12, 18, 24]);
  });
  const placedLt = (q: string) => ev(1, 'placed', { condition: 'lt', chamber, quantity: q });
  const facts = { createdBy: 1, byHand: false, t0: '2026-01-01' };
  it('LIMS-28 a pull is made within its window: not before it opens; late only with a reason and a deviation', () => {
    const e = [placedLt('200'), ev(2, 'placed', { condition: 'acc', chamber, quantity: '100' })];
    expect(pullRefusal(protocol(), facts, e, 'lt', 3, '2026-03-20')).toMatch(/due on 2026-04-01: its window opens on 2026-03-25/);
    expect(pullRefusal(protocol(), facts, e, 'lt', 3, '2026-03-25')).toBeNull();
    expect(pullRefusal(protocol(), facts, e, 'lt', 3, '2026-04-09')).toMatch(/late \(its window closed on 2026-04-08\): give the reason and the deviation number/);
    expect(pullRefusal(protocol(), facts, e, 'lt', 3, '2026-04-09', { reason: 'Chamber down', deviation: 'DEV-26-001' })).toBeNull();
    expect(pullRefusal(protocol(), facts, e, 'lt', 5, '2026-06-01')).toBe('The protocol has no such time point.');
    expect(pullRefusal(protocol(), facts, [...e, ev(3, 'pulled', { condition: 'lt', month: 3, sampleNo: 'LS2600001' })], 'lt', 3, '2026-04-01')).toMatch(/is done \(LS2600001\)/);
    expect(pointState(schedule(protocol(), '2026-01-01')[1]!, e, '2026-04-09')).toBe('overdue');
    expect(pointState(schedule(protocol(), '2026-01-01')[1]!, e, '2026-03-26')).toBe('due');
    expect(pointState(schedule(protocol(), '2026-01-01')[1]!, e, '2026-03-01')).toBe('not yet');
  });
  it('LIMS-28 typed by hand: the study and a chamber accepted without the Logbook are checked by a second person before any pull', () => {
    const hand = { ...facts, byHand: true };
    const e = [ev(1, 'placed', { condition: 'lt', chamber, chamberByHand: true, quantity: '200' })];
    expect(pullRefusal(protocol(), hand, e, 'lt', 0, '2026-01-01')).toMatch(/typed by hand: a second person checks the study first/);
    expect(checkRefusal(hand, e, 0, 1)).toMatch(/cannot check it/);
    const checked = [...e, ev(2, 'checked', { entry: 0 }, 2)];
    expect(pullRefusal(protocol(), hand, checked, 'lt', 0, '2026-01-01')).toMatch(/without LEAD: a second person checks its status label first/);
    expect(checkRefusal(hand, checked, 1, 1)).toBe('You typed it: a second person checks it.');
    expect(checkRefusal(hand, checked, 1, 2)).toBeNull();
    expect(pullRefusal(protocol(), hand, [...checked, ev(3, 'checked', { entry: 1 }, 2)], 'lt', 0, '2026-01-01')).toBeNull();
  });
  it('LIMS-28 a pull that would leave a later time point short is refused until QA approves more placement', () => {
    // 7 time points of 20 tablets need 140; 100 placed.
    const e = [placedLt('100')];
    expect(stock(protocol(), '2026-01-01', e)[0]).toMatchObject({ placed: 100, used: 0, left: 100, needed: 140 });
    expect(pullRefusal(protocol(), facts, e, 'lt', 0, '2026-01-01')).toMatch(/leave 80 tablets .* need 120 tablets: QA approves more placement first/);
    const more = [...e, ev(2, 'extra', { condition: 'lt', quantity: '40', reason: 'Batch had more' }, 1)];
    expect(stock(protocol(), '2026-01-01', more)[0]).toMatchObject({ placed: 100, extraWaiting: 40 });
    expect(pullRefusal(protocol(), facts, more, 'lt', 0, '2026-01-01')).toMatch(/QA approves more placement first/);
    expect(extraRefusal(more, 2, 1)).toMatch(/another person approves it/);
    expect(extraRefusal(more, 2, 2)).toBeNull();
    const approved = [...more, ev(3, 'extra_approved', { entry: 2 }, 2)];
    expect(extraRefusal(approved, 2, 3)).toMatch(/already approved/);
    expect(stock(protocol(), '2026-01-01', approved)[0]).toMatchObject({ placed: 140, left: 140, extraWaiting: 0 });
    expect(pullRefusal(protocol(), facts, approved, 'lt', 0, '2026-01-01')).toBeNull();
    const pulled = [...approved, ev(4, 'pulled', { condition: 'lt', month: 0, sampleNo: 'LS2600001' })];
    expect(stock(protocol(), '2026-01-01', pulled)[0]).toMatchObject({ used: 20, left: 120, needed: 120 });
  });
});

describe('on-going stability, capacity and excursions', () => {
  it('LIMS-27 a product and pack with batches released this year and no on-going study started is flagged; a study or QA\'s answer clears it', () => {
    const released = [{ productCode: 'FG-001', productName: 'Examplol 500 mg', batch: 'B1' }, { productCode: 'FG-002', productName: 'Examplol 250 mg', batch: 'B2' }];
    const protocols = [{ productCode: 'FG-001', pack: 'Alu-Alu' }, { productCode: 'FG-001', pack: 'HDPE bottle' }];
    const flags = ongoingFlags(released, protocols, [{ productCode: 'FG-001', pack: 'Alu-Alu', studyNo: 'STB26001' }], []);
    expect(flags.map((f) => [f.productCode, f.pack, f.flag])).toEqual([
      ['FG-001', 'Alu-Alu', null],
      ['FG-001', 'HDPE bottle', 'No on-going study started this year for HDPE bottle: put a batch on study, or QA records why not.'],
      ['FG-002', null, '1 batch released this year and no effective on-going stability protocol.'],
    ]);
    const answered = ongoingFlags(released, protocols, [], [{ productCode: 'FG-001', pack: 'HDPE bottle', text: 'Pack discontinued', by: 'QA' }]);
    expect(answered.find((f) => f.pack === 'HDPE bottle')).toMatchObject({ flag: null, answer: { text: 'Pack discontinued' } });
  });
  it('chamber capacity: units in each chamber and condition now and at the start of each coming year', () => {
    const e = [ev(1, 'placed', { condition: 'lt', chamber, quantity: '160' }), ev(2, 'placed', { condition: 'acc', chamber: { ...chamber, itemId: 'eq-ch2', code: 'CH-02' }, quantity: '60' }),
      ev(3, 'pulled', { condition: 'lt', month: 0 })];
    const rows = capacity([{ studyNo: 'STB26001', doc: protocol(), t0: '2026-01-01', events: e }], '2026-02-01', [2027, 2028, 2029]);
    // 30/75: 140 left (6 time points of 20 and 20 spare); on 1 Jan 2027: 12, 18 and 24 months still to pull, and the
    // spare; on 1 Jan 2028 the 24-month pull (due that day) and the spare.
    expect(rows.map((r) => [r.chamber.code, r.now, r.byYear])).toEqual([['CH-01', 140, { 2027: 80, 2028: 40, 2029: 0 }], ['CH-02', 60, { 2027: 0, 2028: 0, 2029: 0 }]]);
  });
  it('LIMS-28 an excursion lists the studies and time points whose samples were in the chamber', () => {
    const study = { id: 1, studyNo: 'STB26001', doc: protocol(), t0: '2026-01-01', events: [ev(1, 'placed', { condition: 'lt', chamber, quantity: '200' }), ev(2, 'pulled', { condition: 'lt', month: 0 }), ev(3, 'pulled', { condition: 'lt', month: 3 })],
      pulledOn: { 2: '2026-01-01', 3: '2026-04-02' } as Record<number, string> };
    expect(affectedBy({ chamberItemId: 'eq-ch1', fromDate: '2026-04-01', toDate: '2026-04-03' }, [study])).toEqual([{ studyId: 1, studyNo: 'STB26001', condition: '30 °C / 75 % RH (India, zone IVb)', months: [3, 6, 9, 12, 18, 24] }]);
    expect(affectedBy({ chamberItemId: 'eq-ch2', fromDate: '2026-04-01', toDate: '2026-04-03' }, [study])).toEqual([]);
    expect(affectedBy({ chamberItemId: 'eq-ch1', fromDate: '2025-04-01', toDate: '2025-04-03' }, [study])).toEqual([]);
  });
});

// ---- On the server ----
let t: TestApp;
let provider: Sql;
const S = { tb: '', lb: '', dv: '' };
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
const item = (itemId: string, code: string, name: string) => ({ itemId, code, name, version: 1, active: true });
const as = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: object) => call(t.app, cookies[who]!, method as 'GET', url, body);
let specId = 0;
let protocolId = 0;

beforeAll(async () => {
  t = await freshApp(async (db) => {
    S.tb = `${db.schema}_tb`; S.lb = `${db.schema}_lb`; S.dv = `${db.schema}_dv`;
    await db.owner.unsafe(`
      create schema ${S.tb}; create schema ${S.lb}; create schema ${S.dv};
      create table ${S.tb}.batch_fact_v1 (batch_id uuid default gen_random_uuid(), batch_number text, product_code text, strength text, record_kind text, status text,
        issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now(),
        product_name text, good_quantity numeric, good_unit text, released_at timestamptz);
      create table ${S.lb}.equipment_status_v1 (master_id text, code text, kind text, state text, fit_for_use boolean, blockers text[], warnings text[],
        in_use_batch text, cleaned_at timestamptz, cleaned_by text, checked_at timestamptz default now(), read_at timestamptz default now(), data_as_of timestamptz default now());
      create table ${S.dv}.deviation_v1 (number text, status text, classification text, opened_at timestamptz, closed_at timestamptz, product text, analysis text,
        analysis_norm text, outcome text, read_at timestamptz default now(), data_as_of timestamptz default now(), title text, source_ref text);
      grant usage on schema ${S.tb}, ${S.lb}, ${S.dv} to lims_app;
      grant select on all tables in schema ${S.tb}, ${S.lb}, ${S.dv} to lims_app;
      insert into ${S.tb}.batch_fact_v1 (batch_number, product_code, product_name, status, completed_at, released, released_at) values
        ('B26001', 'FG-001', 'Examplol 500 mg tablets', 'PRODUCTION_APPROVED', now(), false, null),
        ('B26002', 'FG-001', 'Examplol 500 mg tablets', 'RELEASED', now(), true, now()),
        ('B26003', 'FG-002', 'Examplol 250 mg tablets', 'RELEASED', now(), true, now()),
        ('B26004', 'FG-001', 'Examplol 500 mg tablets', 'IN_PRODUCTION', null, false, null);
      insert into ${S.lb}.equipment_status_v1 (master_id, code, kind, state, fit_for_use, blockers, warnings) values
        ('eq-ch1', 'CH-01', 'equipment', 'in service', true, '{}', '{}'),
        ('eq-ch2', 'CH-02', 'equipment', 'in service', true, '{}', '{}'),
        ('eq-ch3', 'CH-03', 'equipment', 'out of service', false, '{"Out of service: humidity sensor failed."}', '{}');
      insert into ${S.dv}.deviation_v1 (number, status, title) values ('DEV-26-014', 'open', 'Stability pull missed: chamber room closed');`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ truebatch: provider, logbook: provider, deviations: provider }, { truebatch: S.tb, logbook: S.lb, deviations: S.dv });
  });
  t.master.products_.push({ ...item('prd-1', 'FG-001', 'Examplol 500 mg tablets'), strength: '500 mg', dosageForm: 'tablet' },
    { ...item('prd-2', 'FG-002', 'Examplol 250 mg tablets'), strength: '250 mg', dosageForm: 'tablet' });
  t.master.equipment_.push(
    { ...item('eq-ch1', 'CH-01', 'Stability chamber 30/75'), kind: 'equipment', type: 'stability chamber', room: 'STB-01' },
    { ...item('eq-ch2', 'CH-02', 'Stability chamber 40/75'), kind: 'equipment', type: 'stability chamber', room: 'STB-01' },
    { ...item('eq-ch3', 'CH-03', 'Stability chamber 25/60'), kind: 'equipment', type: 'stability chamber', room: 'STB-01' },
    { ...item('eq-ch4', 'CH-04', 'Walk-in chamber 5 °C'), kind: 'equipment', type: 'stability chamber', room: 'STB-01' });
  const people = {
    author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register'], sampler2: ['lims.sample.register'], qcman: ['lims.qc.approve'], viewer: ['lims.view'],
  } as const;
  for (const [name, perms] of Object.entries(people)) {
    ids[name] = await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
  const r = await as('author', 'POST', '/api/masters', { kind: 'spec', doc: specDoc() });
  expect(r.statusCode, r.body).toBe(200);
  specId = r.json().id;
  for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${specId}`;
});
afterAll(async () => {
  await provider?.end();
  for (const s of Object.values(S)) if (s) await t.owner.unsafe(`drop schema if exists ${s} cascade`);
  await t?.close();
});

const review = async (id: number, who: string) => (await as(who, 'GET', `/api/master-versions/${id}/review`)).json() as { contentHash: string; refusals: Record<string, string | null> };
const act = async (who: string, id: number, action: string, extra: object = {}) =>
  as(who, 'POST', `/api/master-versions/${id}/${action}`, { proof: proofFor(who), contentHash: (await review(id, who)).contentHash, ...extra });

describe('protocols on the server', () => {
  it('LIMS-26 a protocol is a master version: refused for review while an element is missing, then checked, approved by QA with a change control, made effective', async () => {
    const draft = protocol({ spec: { versionId: specId, number: '', versionNo: 1 } }, { code: '', name: '', sameAsMarketed: false });
    const c = await as('author', 'POST', '/api/masters', { kind: 'protocol', doc: draft });
    expect(c.statusCode, c.body).toBe(200);
    protocolId = c.json().id;
    const v = (await as('viewer', 'GET', `/api/master-versions/${protocolId}`)).json() as { kind: string; doc: ProtocolDoc };
    // Pulled, not typed: the product's code and name from master data, the specification's number from its version.
    expect(v.kind).toBe('protocol');
    expect(v.doc.header).toMatchObject({ code: 'FG-001', name: 'Examplol 500 mg tablets' });
    expect(v.doc.spec).toEqual({ versionId: specId, number: 'SPEC-FG-001', versionNo: 1 });
    const problems = (await as('viewer', 'GET', `/api/master-versions/${protocolId}/checks`)).json().problems as { message: string; rule: string }[];
    expect(problems).toEqual([expect.objectContaining({ rule: 'LIMS-26', message: expect.stringMatching(/marketed/) })]);
    const no = await act('author', protocolId, 'submit');
    expect(no.statusCode).toBe(409);
    expect(no.json().message).toMatch(/master check shows 1 problem/);
    expect((await as('author', 'PUT', `/api/master-versions/${protocolId}`, { doc: { ...v.doc, header: { ...v.doc.header, sameAsMarketed: true } } })).statusCode).toBe(200);
    expect((await act('author', protocolId, 'submit')).statusCode).toBe(200);
    expect((await act('checker', protocolId, 'pass')).statusCode).toBe(200);
    const ok = await act('quality', protocolId, 'approve', { changeControl: 'CC-2026-031' });
    expect(ok.statusCode, ok.body).toBe(200);
    // QMS is not linked: the number was typed, so another QA person makes it effective.
    expect((await as('quality', 'POST', `/api/master-versions/${protocolId}/make-effective`, {})).statusCode).toBe(403);
    expect((await as('quality2', 'POST', `/api/master-versions/${protocolId}/make-effective`, {})).statusCode).toBe(200);
    const list = (await as('viewer', 'GET', '/api/masters?kind=protocol')).json() as { id: number; state: string }[];
    expect(list).toEqual([expect.objectContaining({ id: protocolId, state: 'effective' })]);
    expect((await as('viewer', 'GET', '/api/masters?kind=spec')).json().map((x: { id: number }) => x.id)).not.toContain(protocolId);
  });
});

describe('studies on the server', () => {
  let studyId = 0;
  const placements = (lt: string, ch = 'eq-ch1') => [{ condition: 'lt', chamberItemId: ch, quantity: lt }, { condition: 'acc', chamberItemId: 'eq-ch2', quantity: '60' }];

  it('LIMS-27 before any study: the products released this year without an on-going study are flagged', async () => {
    const r = (await as('viewer', 'GET', '/api/stability/ongoing')).json() as { link: string; flags: { productCode: string; pack: string | null; flag: string | null }[] };
    expect(r.link).toBe('ok');
    expect(r.flags).toEqual([
      expect.objectContaining({ productCode: 'FG-001', pack: 'Alu-Alu blister, 10 tablets', flag: expect.stringMatching(/No on-going study started this year/) }),
      expect.objectContaining({ productCode: 'FG-002', pack: null, flag: expect.stringMatching(/no effective on-going stability protocol/) }),
    ]);
    expect((await as('sampler', 'POST', '/api/stability/ongoing', { productCode: 'FG-002', pack: 'any', text: 'Not marketed' })).statusCode).toBe(403);
  });

  it('LIMS-28 a study is placed only in chambers the Logbook says are fit, for a completed batch of the protocol\'s product', async () => {
    const start = (b: object) => as('sampler', 'POST', '/api/stability/studies', { protocolVersionId: protocolId, batchNumber: 'B26001', placements: placements('100'), ...b });
    expect((await as('viewer', 'POST', '/api/stability/studies', { protocolVersionId: protocolId, batchNumber: 'B26001', placements: placements('100') })).statusCode).toBe(403);
    const unfit = await start({ placements: placements('100', 'eq-ch3') });
    expect(unfit.statusCode).toBe(409);
    expect(unfit.json().message).toBe('CH-03 Out of service: humidity sensor failed.');
    expect((await start({ placements: placements('100', 'eq-ch4') })).json().message).toBe('CH-04 is not in LEAD, so it cannot hold stability samples.');
    expect((await start({ batchNumber: 'B26003' })).json().message).toMatch(/is of FG-002, not of FG-001/);
    expect((await start({ batchNumber: 'B26004' })).json().message).toMatch(/only a completed batch goes on study/);
    expect((await start({ byHand: true })).json().message).toMatch(/TrueBatch answers/);
    expect((await start({ placements: [placements('100')[0]] })).json().message).toMatch(/Place the samples for 40 °C \/ 75 % RH too/);
    const chambers = (await as('sampler', 'GET', '/api/stability/chambers')).json() as { code: string; fit: boolean | null }[];
    expect(chambers.map((c) => [c.code, c.fit])).toEqual([['CH-01', true], ['CH-02', true], ['CH-03', false], ['CH-04', false]]);
    const ok = await start({});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().studyNo).toMatch(/^STB\d{5}$/);
    studyId = ok.json().id;
  });

  it('LIMS-28 a pull within the window makes a stability sample of the protocol\'s specification, naming the study and time point; the stock is kept', async () => {
    const pull = (b: object, who = 'sampler') => as(who, 'POST', `/api/stability/studies/${studyId}/pull`, b);
    // 100 placed at 30/75 for 7 time points of 20: the first pull would leave the later ones short.
    const short = await pull({ condition: 'lt', month: 0 });
    expect(short.statusCode).toBe(409);
    expect(short.json().message).toMatch(/leave 80 tablets .* need 120 tablets: QA approves more placement first/);
    const extra = await as('sampler', 'POST', `/api/stability/studies/${studyId}/extra`, { condition: 'lt', quantity: '40', reason: 'More tablets from the batch' });
    const entry = extra.json().eventId as number;
    const detail = async (who = 'qcman') => (await as(who, 'GET', `/api/stability/studies/${studyId}`)).json();
    expect((await detail()).extras).toEqual([expect.objectContaining({ entry, approved: false, refusal: null })]);
    expect((await as('sampler', 'POST', `/api/stability/studies/${studyId}/approve-extra`, { entry, proof: proofFor('sampler'), contentHash: (await detail('sampler')).contentHash })).statusCode).toBe(403);
    const ap = await as('qcman', 'POST', `/api/stability/studies/${studyId}/approve-extra`, { entry, proof: proofFor('qcman'), contentHash: (await detail()).contentHash });
    expect(ap.statusCode, ap.body).toBe(200);
    expect((await t.owner`select meaning from signatures where object_type = 'stability_event' and object_id = ${ap.json().eventId}`)[0]).toEqual({ meaning: 'qc_approved' });
    // Early: the 3-month pull's window has not opened.
    expect((await pull({ condition: 'lt', month: 3 })).json().message).toMatch(/its window opens on/);
    const ok = await pull({ condition: 'lt', month: 0 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await pull({ condition: 'lt', month: 0 })).json().message).toMatch(/is done/);
    const s = (await as('sampler', 'GET', `/api/samples/${ok.json().sampleId}`)).json();
    expect(s.sample).toMatchObject({ sampleNo: ok.json().sampleNo, purpose: 'stability', lotNo: 'B26001', quantity: '20 tablets',
      stability: { studyId, condition: 'lt', label: '30 °C / 75 % RH (India, zone IVb)', month: 0 } });
    expect(s.spec.id).toBe(specId);
    const d = await detail();
    expect(d.stock[0]).toMatchObject({ placed: 140, used: 20, left: 120, needed: 120 });
    expect(d.points.find((p: { condition: string; month: number }) => p.condition === 'lt' && p.month === 0)).toMatchObject({ state: 'pulled', sampleNo: ok.json().sampleNo });
    expect(d.results).toEqual([expect.objectContaining({ month: 0, sampleNo: ok.json().sampleNo, tests: { assay: null } })]);
    const list = (await as('viewer', 'GET', '/api/stability/studies')).json();
    expect(list.studies[0]).toMatchObject({ id: studyId, pulled: 1, total: 10, overdue: 0 });
    // The 0-month pull at 40/75 is due now: listed as due this week.
    expect(list.due).toEqual([expect.objectContaining({ studyId, condition: 'acc', month: 0, state: 'due' })]);
  });

  it('LIMS-28 a late pull needs its reason and a deviation number that Deviations knows', async () => {
    // A study placed 400 days ago (set up as the database owner): its 3-month pull is long past its window.
    const t0 = addDays(plantToday(new Date()), -400);
    const [s] = await t.owner<{ id: number }[]>`insert into stability_studies (study_no, protocol_version_id, lot_no, item, source, t0, created_by)
      values ('STB25009', ${protocolId}, 'B25001', ${t.owner.json({ of: 'product', itemId: 'prd-1', code: 'FG-001', name: 'Examplol 500 mg tablets' })},
        ${t.owner.json({ from: 'truebatch', asOf: null, shown: 'TrueBatch batch B25001' })}, ${t0}, ${ids.sampler!}) returning id::int`;
    for (const [c, ch] of [['lt', 'eq-ch1'], ['acc', 'eq-ch2']]) {
      await t.owner`insert into stability_events (study_id, kind, payload, person_id) values (${s!.id}, 'placed', ${t.owner.json({ condition: c, chamber: { itemId: ch, code: ch === 'eq-ch1' ? 'CH-01' : 'CH-02', name: 'Stability chamber' }, quantity: '400' })}, ${ids.sampler!})`;
    }
    const pull = (b: object) => as('sampler', 'POST', `/api/stability/studies/${s!.id}/pull`, b);
    expect((await pull({ condition: 'lt', month: 3 })).json().message).toMatch(/is late \(its window closed on .*\): give the reason and the deviation number/);
    expect((await pull({ condition: 'lt', month: 3, late: { reason: 'Chamber room closed', deviation: 'DEV-26-999' } })).json().message).toMatch(/not in the DIVE system/);
    const ok = await pull({ condition: 'lt', month: 3, late: { reason: 'Chamber room closed', deviation: 'DEV-26-014' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const d = (await as('viewer', 'GET', `/api/stability/studies/${s!.id}`)).json();
    expect(d.points.find((p: { month: number; condition: string }) => p.condition === 'lt' && p.month === 3).late).toEqual({ reason: 'Chamber room closed', deviation: 'DEV-26-014', byHand: false });
    const list = (await as('viewer', 'GET', '/api/stability/studies')).json();
    expect(list.studies.find((x: { id: number }) => x.id === s!.id).overdue).toBeGreaterThan(0);
    expect(list.due.some((x: { studyId: number; state: string }) => x.studyId === s!.id && x.state === 'overdue')).toBe(true);
  });

  it('LIMS-28 an excursion entered with its readings lists the studies affected; a second person checks it; QC assesses it', async () => {
    const now = new Date(Date.now() - 2 * 86400_000).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16).replace(' ', 'T');
    const end = new Date(Date.now() - 1 * 86400_000).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16).replace(' ', 'T');
    const body = { chamberItemId: 'eq-ch1', from: now, to: end, deviation: 'DEV-26-014', readings: [{ at: now, temperature: '33.5', humidity: '78' }, { at: end, temperature: '31.0' }] };
    expect((await as('sampler', 'POST', '/api/stability/excursions', { ...body, deviation: 'DEV-26-999' })).json().message).toMatch(/not in the DIVE system/);
    expect((await as('sampler', 'POST', '/api/stability/excursions', { ...body, readings: [{ at: '2020-01-01T00:00', temperature: '30' }] })).json().message).toMatch(/outside the excursion's period/);
    const r = await as('sampler', 'POST', '/api/stability/excursions', body);
    expect(r.statusCode, r.body).toBe(200);
    const x = async (who = 'qcman') => ((await as(who, 'GET', '/api/stability/excursions')).json() as { id: number; affected: { studyNo: string; months: number[] }[]; range: object; mkt: object; checkRefusal: string | null; assessRefusal: string | null }[])[0]!;
    // L23 needs readings at equal intervals.
    const mid = new Date(Date.now() - 1.5 * 86400_000 + 3600_000).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16).replace(' ', 'T');
    expect((await as('sampler', 'POST', '/api/stability/excursions', { ...body, readings: [...body.readings, { at: mid, temperature: '32.0' }] })).json().message).toMatch(/equal intervals/);
    const got = await x();
    expect(got.range).toEqual({ min: '31.0', max: '33.5' });
    // Mean kinetic temperature of 33.5 and 31.0 °C (template L23): 10000 K ÷ −ln((e^(−10000/306.65) + e^(−10000/304.15)) ÷ 2) = 305.48 K, above their mean 32.25 °C.
    expect(got.mkt).toMatchObject({ ok: true, value: '32.33 °C' });
    // The study placed today was not in the chamber yet; the old one's samples not pulled before it began were.
    expect(got.affected.map((a) => a.studyNo)).toEqual(['STB25009']);
    expect(got.affected[0]!.months).toEqual([0, 3, 6, 9, 12, 18, 24]);
    expect((await as('qcman', 'POST', `/api/stability/excursions/${got.id}/assess`, { text: 'No impact' })).json().message).toMatch(/second person checks the readings first/);
    expect((await as('sampler', 'POST', `/api/stability/excursions/${got.id}/check`, {})).statusCode).toBe(403);
    expect((await as('sampler2', 'POST', `/api/stability/excursions/${got.id}/check`, {})).statusCode).toBe(200);
    expect((await as('qcman', 'POST', `/api/stability/excursions/${got.id}/assess`, { text: 'Within 2 °C for 24 h: no impact on the samples' })).statusCode).toBe(200);
    expect((await x()).assessRefusal).toMatch(/already assessed/);
    const old = (await as('viewer', 'GET', '/api/stability/studies')).json().studies.find((x: { studyNo: string }) => x.studyNo === 'STB25009');
    expect((await as('viewer', 'GET', `/api/stability/studies/${old.id}`)).json().excursions).toEqual([expect.objectContaining({ id: got.id, deviation: 'DEV-26-014' })]);
    expect((await as('viewer', 'GET', `/api/stability/studies/${studyId}`)).json().excursions).toEqual([]);
  });

  it('LIMS-27 the study started this year clears its product\'s flag; QA records why for the other', async () => {
    expect((await as('qcman', 'POST', '/api/stability/ongoing', { productCode: 'FG-002', pack: 'any', text: 'Launch next year' })).statusCode).toBe(200);
    expect((await as('qcman', 'POST', '/api/stability/ongoing', { productCode: 'FG-002', pack: 'any', text: 'Again' })).statusCode).toBe(409);
    const r = (await as('viewer', 'GET', '/api/stability/ongoing')).json() as { flags: { productCode: string; flag: string | null; studies: string[] }[] };
    expect(r.flags.find((f) => f.productCode === 'FG-001')).toMatchObject({ flag: null, studies: [expect.stringMatching(/^STB26/)] });
    expect(r.flags.find((f) => f.productCode === 'FG-002')).toMatchObject({ flag: null, answer: { text: 'Launch next year', by: 'QCMAN' } });
  });

  it('chamber capacity: the units booked per chamber and condition', async () => {
    const r = (await as('viewer', 'GET', '/api/stability/capacity')).json() as { rows: { chamber: { code: string }; condition: string; now: number; studies: string[] }[] };
    expect(r.rows.find((x) => x.chamber.code === 'CH-01')).toMatchObject({ condition: '30 °C / 75 % RH (India, zone IVb)', now: 120 + 380, studies: expect.arrayContaining([expect.stringMatching(/^STB26/), 'STB25009']) });
  });
});
