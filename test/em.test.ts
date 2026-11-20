import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { plantToday } from '../server/routes/inventory.js';
import { monitoringChecks, monitoringSchema, type MonitoringDoc, type PlanSpec } from '../shared/master/monitoring.js';
import { specSchema, type SpecDoc } from '../shared/master/spec.js';
import { addDays } from '../shared/engine/stability.js';
import {
  dueList, excursionLevel, excursionRefusal, excursionStatus, parseReport, periodOf, type ExcursionEvent, type ExcursionFacts,
} from '../shared/engine/monitoring.js';
import { small } from './engine-fixture.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp, validatedOutside } from './helpers.js';

// Environmental monitoring and water (LIMS-36, LIMS-37; plan 2.9): the monitoring plan (a master version), what it
// makes due, samplings taken as ordinary samples, excursions over the alert and action limits (grade A: any colony)
// investigated under a deviation with isolates identified, the continuous monitoring systems' daily reports, the map and
// the published em_v1.

// ---- The plan (shared/master/monitoring.ts) ----
const emSpec = (over: Partial<SpecDoc['tests'][number]> = {}, header: Partial<SpecDoc['header']> = {}): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: 'mat-em', code: 'QC-EM', name: 'Environmental monitoring', type: 'Environmental monitoring', number: 'SPEC-EM-B', pharmacopoeia: 'In-house', ...header },
  tests: [{ key: 'sp', name: 'Settle plate (4 h)', method: { masterId: 1, code: 'QC-M-EM', name: 'Plate count' }, result: 's0/count/readingCheck', limitType: 'alert and action',
    limit: { high: '5', alertHigh: '3', unit: 'CFU' }, ...over }],
});
const waterSpec = (header: Partial<SpecDoc['header']> = {}): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: 'mat-pw', code: 'RM-PW', name: 'Purified water', type: 'Water', number: 'SPEC-PW', pharmacopoeia: 'IP', ...header },
  tests: ['toc', 'cond', 'micro'].map((k) => ({ key: k, name: k, method: { masterId: 2, code: 'QC-M-W', name: 'Water' }, result: 's0/t0/readingCheck', limitType: 'not more than',
    limit: { high: k === 'toc' ? '500' : k === 'cond' ? '1.3' : '100', unit: k === 'toc' ? 'ppb' : k === 'cond' ? 'µS/cm' : 'CFU/mL' } })),
});
const sampling = (over: object = {}) => ({ key: 'sp', kind: 'settle plate', frequency: 'daily', state: 'in operation', spec: { masterId: 10, testKey: 'sp', number: 'SPEC-EM-B', testName: '', method: '', limit: '' }, quantity: '1 plate', identify: 'on action', ...over });
const plan = (points: object[]): MonitoringDoc => monitoringSchema.parse({ header: { number: 'EMP-001', name: 'Sterile block', shifts: 2 }, points });
const roomPoint = (samplings: object[] = [sampling()], grade = 'B') => ({ key: 'p1', code: 'B101-SP1', name: 'Filling LAF', of: 'room', room: { itemId: 'rm-b', code: 'B101', name: 'Filling room', grade }, samplings });
const waterPoint = (kinds: string[], system = 'PW') => ({ key: `w-${system.toLowerCase()}`, code: `${system}-04`, name: 'Loop 1 outlet 4', of: 'water', system,
  samplings: kinds.map((k) => ({ key: k, kind: k === 'cond' ? 'conductivity' : k === 'toc' ? 'TOC' : k, frequency: 'weekly', spec: { masterId: 20, testKey: k, number: 'SPEC-PW', testName: '', method: '', limit: '' }, quantity: '250 mL' })) });
const specs = (m: Record<number, PlanSpec>) => (id: number) => m[id] ?? null;
const ok: Record<number, PlanSpec> = { 10: { state: 'effective', doc: emSpec() }, 20: { state: 'effective', doc: waterSpec() } };
const msgs = (doc: MonitoringDoc, m = ok) => monitoringChecks(doc, specs(m)).map((p) => p.message).join(' | ');

describe('the monitoring plan (LIMS-36, LIMS-37)', () => {
  it('LIMS-36 a complete plan has no problems: graded room points with frequency, state and the specification\'s alert and action limits', () => {
    expect(monitoringChecks(plan([roomPoint()]), specs(ok))).toEqual([]);
  });
  it('LIMS-36 approval is refused while an element is missing: the points, the room\'s grade, the state, the specification test, alert and action limits', () => {
    expect(msgs(plan([]))).toMatch(/Add the sampling points/);
    expect(msgs(plan([roomPoint([sampling()], '')]))).toMatch(/gives room B101 no clean-room grade/);
    expect(msgs(plan([roomPoint([sampling({ state: undefined })])]))).toMatch(/at rest or in operation \(the limits differ\)/);
    expect(msgs(plan([roomPoint([sampling({ spec: null })])]))).toMatch(/pick the specification test/);
    expect(msgs(plan([roomPoint([sampling({ kind: 'TOC' })])]))).toMatch(/a room is sampled by plates/);
    expect(msgs(plan([roomPoint()]), { 10: { state: 'effective', doc: emSpec({ limitType: 'not more than', limit: { high: '5', unit: 'CFU' } }) } })).toMatch(/has no alert and action limits/);
    expect(msgs(plan([roomPoint()]), { 10: { state: 'effective', doc: emSpec({}, { type: 'Finished product' }) } })).toMatch(/is a finished product specification, not environmental monitoring/);
    expect(msgs(plan([roomPoint()]), {})).toMatch(/has no approved or effective version/);
    expect(monitoringChecks(plan([roomPoint([sampling({ state: undefined })])]), specs(ok)).every((p) => p.rule === 'LIMS-36')).toBe(true);
  });
  it('LIMS-36 limits are per m³, never per cubic foot (35.3 times smaller); active air is per m³; plates count CFU (library S11)', () => {
    const air = (unit: string) => ({ 10: { state: 'effective', doc: emSpec({ limit: { high: '10', alertHigh: '5', unit } }) } });
    expect(msgs(plan([roomPoint([sampling({ kind: 'active air', quantity: '1 m³ air' })])]), air('CFU/ft³'))).toMatch(/per cubic foot \(CFU\/ft³\); limits are per m³ \(1 per ft³ = 35.3 per m³\)/);
    expect(msgs(plan([roomPoint([sampling({ kind: 'active air', quantity: '1 m³ air' })])]), air('CFU'))).toMatch(/an active air limit is per m³ of air/);
    expect(msgs(plan([roomPoint([sampling({ kind: 'active air', quantity: '1 m³ air' })])]), air('CFU/m³'))).toBe('');
    expect(msgs(plan([roomPoint()]), air('ppb'))).toMatch(/a plate or micro count is in CFU/);
  });
  it('LIMS-36 the at-rest action limit is never looser than the in-operation one; grade A acts on any colony (library S11)', () => {
    const m = { ...ok, 11: { state: 'effective', doc: emSpec({ limit: { high: '50', alertHigh: '25', unit: 'CFU' } }) } };
    const both = [sampling(), sampling({ key: 'sp-rest', state: 'at rest', spec: { masterId: 11, testKey: 'sp', number: 'X', testName: '', method: '', limit: '' } })];
    expect(msgs(plan([roomPoint(both)]), m)).toMatch(/at-rest action limit \(NMT 50 CFU \(alert above 25\)\) is looser than the in-operation one \(NMT 5 CFU/);
    const a = monitoringChecks(plan([roomPoint([sampling()], 'A')]), specs(ok));
    expect(a).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringMatching(/grade A acts on any colony/) })]);
  });
  it('LIMS-37 each water system is tested at its points for what its pharmacopoeial specification asks; an in-house water specification is refused', () => {
    expect(monitoringChecks(plan([waterPoint(['toc', 'cond', 'micro'])]), specs(ok))).toEqual([]);
    expect(msgs(plan([waterPoint(['toc', 'cond'])]))).toMatch(/Purified water: no point is tested for micro/);
    expect(msgs(plan([waterPoint(['toc', 'cond', 'micro'], 'WFI')]))).toMatch(/Water for injections: no point is tested for endotoxin/);
    expect(msgs(plan([waterPoint(['toc', 'cond', 'micro'])]), { 20: { state: 'effective', doc: waterSpec({ pharmacopoeia: 'In-house' }) } })).toMatch(/pharmacopoeial specification; SPEC-PW is in-house/);
    expect(msgs(plan([{ ...waterPoint(['toc', 'cond', 'micro']), samplings: [{ ...waterPoint(['toc']).samplings[0], state: 'at rest' }] }]))).toMatch(/water has no at rest or in operation state/);
    expect(monitoringChecks(plan([waterPoint(['toc'])]), specs(ok)).every((p) => p.rule === 'LIMS-37')).toBe(true);
  });
});

describe('the schedule (LIMS-36)', () => {
  it('LIMS-36 periods: the day, the week from Monday, the calendar month', () => {
    expect(periodOf('daily', '2026-11-18')).toEqual({ key: '2026-11-18', from: '2026-11-18', to: '2026-11-18' });
    expect(periodOf('weekly', '2026-11-18')).toEqual({ key: 'W2026-11-16', from: '2026-11-16', to: '2026-11-22' });
    expect(periodOf('monthly', '2026-12-05')).toEqual({ key: '2026-12', from: '2026-12-01', to: '2026-12-31' });
    expect(periodOf('per batch', '2026-11-18')).toBeNull();
  });
  it('LIMS-36 a sampling is due until taken in its period (per shift: the plan\'s shifts a day); overdue when the previous period was missed', () => {
    const doc = plan([roomPoint([sampling(), sampling({ key: 'shift', frequency: 'per shift' }), sampling({ key: 'batch', frequency: 'per batch' })])]);
    const day = (takes: { sampling: string; on: string }[], today = '2026-11-18', since = '2026-11-18') => dueList(doc, takes.map((t) => ({ point: 'p1', ...t })), today, since)
      .map((r) => [r.sampling, r.needed, r.taken, r.state, r.missed]);
    expect(day([])).toEqual([['sp', 1, 0, 'due', null], ['shift', 2, 0, 'due', null]]);
    expect(day([{ sampling: 'sp', on: '2026-11-18' }, { sampling: 'shift', on: '2026-11-18' }])).toEqual([['sp', 1, 1, 'done', null], ['shift', 2, 1, 'due', null]]);
    // Effective since the 10th; nothing taken on the 17th: overdue, the missed day named.
    expect(day([{ sampling: 'shift', on: '2026-11-17' }, { sampling: 'shift', on: '2026-11-17' }], '2026-11-18', '2026-11-10')).toEqual([['sp', 1, 0, 'overdue', '2026-11-17'], ['shift', 2, 0, 'due', null]]);
  });
});

describe('excursions (LIMS-36)', () => {
  const limit = { high: '5', alertHigh: '3', unit: 'CFU' };
  it('LIMS-36 a result over the alert limit is an alert (trend watch), over the action limit an action; grade A acts on any colony', () => {
    expect(excursionLevel({ value: '2', unit: 'CFU' }, limit, 'B', 'settle plate').level).toBe('none');
    expect(excursionLevel({ value: '4', unit: 'CFU' }, limit, 'B', 'settle plate').level).toBe('alert');
    expect(excursionLevel({ value: '7', unit: 'CFU' }, limit, 'B', 'settle plate').level).toBe('action');
    expect(excursionLevel({ value: '1', unit: 'CFU' }, { high: '1', alertHigh: '1', unit: 'CFU' }, 'A', 'settle plate')).toEqual({ level: 'action', why: 'Grade A: 1 CFU (any colony is acted on).' });
    expect(excursionLevel({ value: '0', unit: 'CFU' }, limit, 'A', 'settle plate').level).toBe('none');
    expect(excursionLevel({ value: '450', unit: 'ppb' }, { high: '500', alertHigh: '400', unit: 'ppb' }, null, 'TOC').level).toBe('alert');
  });
  const ev = (id: number, kind: ExcursionEvent['kind'], payload: ExcursionEvent['payload'] = {}, person = 1): ExcursionEvent => ({ id, kind, payload, person });
  const facts = (over: Partial<ExcursionFacts> = {}): ExcursionFacts => ({ origin: 'result', level: 'action', recordedBy: 1, identify: 'on action', growth: true, ...over });
  it('LIMS-36 an action excursion is investigated under a deviation (typed by hand: checked by a second person), its isolates identified where the sampling says, then closed by QA', () => {
    expect(excursionStatus(facts(), [])).toBe('investigation to open');
    expect(excursionRefusal('close', facts(), [], 2)).toMatch(/Open the investigation first/);
    const hand = [ev(1, 'deviation', { number: 'DEV-26-100', byHand: true })];
    expect(excursionStatus(facts(), hand)).toBe('deviation to check');
    expect(excursionRefusal('check', facts(), hand, 1)).toBe('You typed the deviation number: a second person checks it.');
    expect(excursionRefusal('check', facts(), hand, 2)).toBeNull();
    const checked = [...hand, ev(2, 'checked', { entry: 1 }, 2)];
    expect(excursionStatus(facts(), checked)).toBe('isolates to identify');
    expect(excursionRefusal('close', facts(), checked, 3)).toMatch(/Identify the isolates first/);
    const isolated = [...checked, ev(3, 'isolate', { genus: 'Staphylococcus', species: 'epidermidis' })];
    expect(excursionStatus(facts(), isolated)).toBe('open');
    expect(excursionRefusal('close', facts(), isolated, 1)).toMatch(/another QA person closes/);
    expect(excursionRefusal('close', facts(), isolated, 3, false)).toMatch(/still open in Deviations/);
    expect(excursionRefusal('close', facts(), isolated, 3, true)).toBeNull();
    expect(excursionStatus(facts({ identify: 'no' }), checked)).toBe('open');
    expect(excursionStatus(facts(), [...isolated, ev(4, 'closed', { text: 'Root cause: glove' }, 3)])).toBe('closed');
  });
  it('LIMS-36 an alarm imported from a monitoring system is confirmed by a second person; an alert is a trend watch with no investigation', () => {
    const imp = facts({ origin: 'import', growth: false, identify: 'no' });
    expect(excursionStatus(imp, [])).toBe('to confirm');
    expect(excursionRefusal('confirm', imp, [], 1)).toMatch(/second person confirms/);
    expect(excursionRefusal('deviation', imp, [], 2)).toMatch(/confirms the alarm first/);
    expect(excursionStatus(imp, [ev(1, 'confirmed', {}, 2)])).toBe('investigation to open');
    const alert = facts({ level: 'alert', identify: 'on action' });
    expect(excursionStatus(alert, [])).toBe('trend watch');
    expect(excursionRefusal('deviation', alert, [], 1)).toMatch(/trend watch: no investigation/);
    expect(excursionStatus(facts({ level: 'alert', identify: 'any growth' }), [])).toBe('isolates to identify');
  });
});

describe('the continuous monitoring reports (owner decision, 18 Nov 2026)', () => {
  it('LIMS-36 a particle counter\'s daily summary is read by its fixed layout: per m³ only, one day, channels 0.5 and 5.0 µm, alarms ALERT or ACTION', () => {
    const head = 'date,room,channel_um,count_per_m3,max_per_m3,alarm';
    const r = parseReport('particle', `${head}\n2026-11-17,B101,0.5,2900,3400,\n2026-11-17,B101,5.0,25,40,ACTION\n`);
    expect(r).toEqual({ ok: true, date: '2026-11-17', rows: [
      { where: 'B101', channel: '0.5', values: { count: '2900', max: '3400' }, alarm: null },
      { where: 'B101', channel: '5.0', values: { count: '25', max: '40' }, alarm: 'ACTION' }] });
    expect(parseReport('particle', 'date,room,channel_um,count_per_ft3,max_per_ft3,alarm\n2026-11-17,B101,0.5,100,120,')).toMatchObject({ ok: false, message: expect.stringMatching(/per cubic foot/) });
    expect(parseReport('particle', `${head}\n2026-11-17,B101,1.0,1,1,`)).toMatchObject({ ok: false, message: 'Line 2: the size channel 1.0 µm is not 0.5 or 5.0.' });
    expect(parseReport('particle', `${head}\n2026-11-17,B101,0.5,1,1,\n2026-11-18,B101,0.5,1,1,`)).toMatchObject({ ok: false, message: expect.stringMatching(/one report is one day/) });
    expect(parseReport('particle', `${head}\n2026-11-17,B101,0.5,many,1,`)).toMatchObject({ ok: false, message: 'Line 2: many is not a number.' });
    expect(parseReport('water', `${head}\n`)).toMatchObject({ ok: false, message: expect.stringMatching(/not the online water monitor daily summary layout/) });
    expect(parseReport('water', 'date,point,toc_ppb,conductivity_us_cm,alarm\n2026-11-17,PW-04,120,0.9,ALERT')).toMatchObject({ ok: true, rows: [{ where: 'PW-04', values: { toc: '120', conductivity: '0.9' }, alarm: 'ALERT' }] });
  });
});

// ---- On the server ----
let t: TestApp;
let provider: Sql;
let dv = '';
const cookies: Record<string, string> = {};
const item = (itemId: string, code: string, name: string) => ({ itemId, code, name, version: 1, active: true });
const as = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: object) => call(t.app, cookies[who]!, method as 'GET', url, body);

beforeAll(async () => {
  t = await freshApp(async (db) => {
    dv = `${db.schema}_dv`;
    await db.owner.unsafe(`
      create schema ${dv};
      create table ${dv}.deviation_v1 (number text, status text, classification text, opened_at timestamptz, closed_at timestamptz, product text, analysis text,
        analysis_norm text, outcome text, read_at timestamptz default now(), data_as_of timestamptz default now(), title text, source_ref text, batch text, batch_norm text);
      grant usage on schema ${dv} to lims_app;
      grant select on all tables in schema ${dv} to lims_app;
      insert into ${dv}.deviation_v1 (number, status, title, batch, batch_norm) values ('DEV-26-201', 'open', 'Settle plate over action limit in B101', 'B101-SP1', 'b101sp1');`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ deviations: provider }, { deviations: dv });
  });
  t.master.materials_.push({ ...item('mat-em', 'QC-EM', 'Environmental monitoring'), category: 'EM', unit: 'nos' },
    { ...item('mat-pw', 'RM-PW', 'Purified water'), category: 'Water', unit: 'L' });
  t.master.rooms_.push({ ...item('rm-b', 'B101', 'Filling room'), area: 'Sterile', grade: 'B' }, { ...item('rm-a', 'A101', 'Filling LAF'), area: 'Sterile', grade: 'a' });
  const people = {
    author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register', 'lims.view'], sampler2: ['lims.sample.register'], analyst: ['lims.analysis.perform', 'lims.view'], reviewer: ['lims.analysis.review'],
    qcman: ['lims.qc.approve', 'lims.view'], viewer: ['lims.view'],
  } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(async () => {
  await provider?.end();
  if (dv) await t.owner.unsafe(`drop schema if exists ${dv} cascade`);
  await t?.close();
});

const hash = async (id: number, who: string) => ((await as(who, 'GET', `/api/master-versions/${id}/review`)).json() as { contentHash: string }).contentHash;
async function approve(id: number) {
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-090' }]] as const) {
    const res = await as(who, 'POST', `/api/master-versions/${id}/${a}`, { proof: proofFor(who), contentHash: await hash(id, who), ...x });
    expect(res.statusCode, `${a}: ${res.body}`).toBe(200);
  }
  await validatedOutside(t.owner, id);
  expect((await as('quality2', 'POST', `/api/master-versions/${id}/make-effective`, {})).statusCode).toBe(200);
}
async function effective(kind: 'method' | 'spec', doc: object) {
  const r = await as('author', 'POST', '/api/masters', { kind, doc });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number; masterId: number };
  await approve(v.id);
  return v;
}
const countMethod = (unit: string) => small([{ role: 'Analyst', steps: [{ key: 'count', block: { id: 'check', version: 1 }, settings: { what: 'Colonies', unit, limit: { spec: 'limit' } } }] }]);
/** An analysis of the sample: the reading recorded, signed and reviewed by a second person. */
async function analysed(methodVersionId: number, sampleId: number, reading: string, failing = false) {
  const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: methodVersionId, sampleId, proof: proofFor('analyst') });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  expect((await step('start')).statusCode).toBe(200);
  expect((await step('record', { values: { reading } })).statusCode).toBe(200);
  if (failing) expect((await step('note', { text: 'Over the action limit: excursion' })).statusCode).toBe(200);
  const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] };
  expect((await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash })).statusCode).toBe(200);
  const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
  const res = await as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash });
  expect(res.statusCode, res.body).toBe(200);
}

describe('EM and water on the server', () => {
  let emMethod = { id: 0, masterId: 0 };
  let waterMethod = { id: 0, masterId: 0 };
  let planId = 0;
  let plateSample = 0;
  let excursionId = 0;

  it('LIMS-36 LIMS-37 a monitoring plan is a master version: rooms and grades from master data, specifications pulled, checked, approved by QA with a change control, made effective', async () => {
    emMethod = await effective('method', countMethod('CFU'));
    waterMethod = await effective('method', countMethod('ppb'));
    const condMethod = await effective('method', countMethod('µS/cm'));
    const em = await effective('spec', { ...emSpec(), tests: [{ ...emSpec().tests[0], method: { masterId: emMethod.masterId, code: 'M', name: 'M' }, result: 's0/count/readingCheck' }] });
    const wt = (key: string, name: string, m: number, high: string, alert: string, unit: string) => ({ key, name, method: { masterId: m, code: 'M', name: 'M' }, result: 's0/count/readingCheck',
      limitType: 'alert and action', limit: { high, alertHigh: alert, unit } });
    const pw = await effective('spec', specSchema.parse({ header: waterSpec().header, tests: [wt('toc', 'TOC', waterMethod.masterId, '500', '400', 'ppb'),
      wt('cond', 'Conductivity', condMethod.masterId, '1.3', '1.0', 'µS/cm'), wt('micro', 'Total aerobic count (1 mL)', emMethod.masterId, '100', '50', 'CFU')] }));
    const sp = (masterId: number, testKey: string) => ({ masterId, testKey, number: '', testName: '', method: '', limit: '' });
    const water = (kinds: string[]) => ({ ...waterPoint(kinds), samplings: waterPoint(kinds).samplings.map((s) => ({ ...s, spec: sp(pw.masterId, s.key) })) });
    const doc = plan([
      { ...roomPoint([sampling({ spec: sp(em.masterId, 'sp') }), sampling({ key: 'rest', state: 'at rest', frequency: 'weekly', spec: sp(em.masterId, 'sp') })]), room: { itemId: 'rm-b', code: '', name: '', grade: '' } },
      { key: 'a1', code: 'A101-SP1', name: 'Needles', of: 'room', room: { itemId: 'rm-a', code: '', name: '', grade: '' }, critical: true, samplings: [sampling({ spec: sp(em.masterId, 'sp') })] },
      water(['toc', 'cond']),
    ]);
    const c = await as('author', 'POST', '/api/masters', { kind: 'monitoring', doc });
    expect(c.statusCode, c.body).toBe(200);
    planId = c.json().id;
    const v = (await as('viewer', 'GET', `/api/master-versions/${planId}`)).json() as { kind: string; doc: MonitoringDoc };
    // Pulled, not typed: each room's code, name and grade (upper case) from master data; the specification's number, test, method and limit.
    expect(v.kind).toBe('monitoring');
    expect(v.doc.points[0]!.room).toEqual({ itemId: 'rm-b', code: 'B101', name: 'Filling room', grade: 'B' });
    expect(v.doc.points[1]!.room).toMatchObject({ code: 'A101', grade: 'A' });
    expect(v.doc.points[0]!.samplings[0]!.spec).toEqual({ masterId: em.masterId, testKey: 'sp', number: 'SPEC-EM-B', testName: 'Settle plate (4 h)', method: 'M M', limit: 'NMT 5 CFU (alert above 3)' });
    const problems = (await as('viewer', 'GET', `/api/master-versions/${planId}/checks`)).json().problems as { message: string; rule: string; level: string }[];
    expect(problems.filter((p) => p.level === 'error')).toEqual([expect.objectContaining({ rule: 'LIMS-37', message: 'Purified water: no point is tested for micro.' })]);
    expect((await as('author', 'POST', `/api/master-versions/${planId}/submit`, { proof: proofFor('author'), contentHash: await hash(planId, 'author') })).statusCode).toBe(409);
    expect((await as('author', 'PUT', `/api/master-versions/${planId}`, { doc: { ...v.doc, points: [...v.doc.points.slice(0, 2), water(['toc', 'cond', 'micro'])] } })).statusCode).toBe(200);
    expect((await as('viewer', 'GET', `/api/master-versions/${planId}/checks`)).json().problems.filter((p: { level: string }) => p.level === 'error')).toEqual([]);
    await approve(planId);
    expect((await as('viewer', 'GET', '/api/masters?kind=monitoring')).json()).toEqual([expect.objectContaining({ id: planId, state: 'effective' })]);
    expect((await as('viewer', 'GET', '/api/masters?kind=spec')).json().map((x: { id: number }) => x.id)).not.toContain(planId);
  });

  it('LIMS-36 the effective plan makes its samplings due today; taking one makes an ordinary sample of the room, purpose monitoring, tested to the sampling\'s test only', async () => {
    const due = (await as('viewer', 'GET', '/api/em/due')).json() as { today: string; due: { code: string; sampling: string; due: string; state: string | null; kind: string; grade: string }[] };
    expect(due.due.find((d) => d.sampling === 'rest')).toMatchObject({ state: 'at rest', grade: 'B', kind: 'settle plate' });
    expect(due.due.map((d) => [d.code, d.sampling, d.due])).toEqual([['B101-SP1', 'sp', 'due'], ['B101-SP1', 'rest', 'due'], ['A101-SP1', 'sp', 'due'],
      ['PW-04', 'toc', 'due'], ['PW-04', 'cond', 'due'], ['PW-04', 'micro', 'due']]);
    expect((await as('viewer', 'POST', '/api/em/take', { planVersionId: planId, point: 'p1', sampling: 'sp' })).statusCode).toBe(403);
    expect((await as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: 'X', byHand: true, itemId: 'mat-em', specVersionId: 1, quantity: '1 plate', purpose: 'monitoring' })).json().problems.join()).toMatch(/taken from its monitoring plan/);
    const r = await as('sampler', 'POST', '/api/em/take', { planVersionId: planId, point: 'p1', sampling: 'sp' });
    expect(r.statusCode, r.body).toBe(200);
    plateSample = r.json().sampleId;
    expect((await as('sampler', 'POST', '/api/em/take', { planVersionId: planId, point: 'p1', sampling: 'sp' })).json().message).toMatch(/already taken this day \(LS\d+\): give the reason/);
    const s = (await as('sampler', 'GET', `/api/samples/${plateSample}`)).json();
    expect(s.sample).toMatchObject({ purpose: 'monitoring', lotNo: 'B101-SP1', item: { of: 'room', itemId: 'rm-b', code: 'B101', name: 'Filling room' }, quantity: '1 plate',
      source: { from: 'plan' }, monitoring: { pointCode: 'B101-SP1', kind: 'settle plate', state: 'in operation', grade: 'B', testKey: 'sp', takenOn: plantToday(new Date()), limit: { high: '5', alertHigh: '3', unit: 'CFU' } } });
    expect(s.status).toBe('registered');
    const after = (await as('viewer', 'GET', '/api/em/due')).json() as { due: { code: string; sampling: string; due: string; last: { sampleNo: string } | null }[] };
    expect(after.due.find((d) => d.code === 'B101-SP1' && d.sampling === 'sp')).toMatchObject({ due: 'done', last: { sampleNo: s.sample.sampleNo } });
  });

  it('LIMS-36 a reviewed result over the action limit is an excursion: its investigation opens with a deviation Deviations knows; isolates identified; QA closes it once Deviations has', async () => {
    expect((await as('sampler', 'POST', `/api/samples/${plateSample}/receive`, { condition: 'Plate closed, incubated 30-35 °C' })).statusCode).toBe(200);
    await analysed(emMethod.id, plateSample, '7', true);
    const list = (await as('viewer', 'GET', '/api/em/excursions')).json() as { pending: { sampleId: number; level: string; shown: string }[]; excursions: unknown[] };
    expect(list.pending).toEqual([expect.objectContaining({ sampleId: plateSample, level: 'action', point: expect.objectContaining({ code: 'B101-SP1' }) })]);
    // The analysis's out-of-limit result opened its OOS (the existing flow).
    expect((await as('sampler', 'GET', `/api/samples/${plateSample}`)).json().oos).toHaveLength(1);
    // oos_v1 says where an EM OOS is: the point and its room (no batch picked here); lot_number as before.
    expect(await t.owner.unsafe(`select item_kind, point_code, room_code, batch_number from ${t.schema}_report.oos_v1`)).toEqual([{ item_kind: 'ROOM', point_code: 'B101-SP1', room_code: 'B101', batch_number: null }]);
    const open = (b: object) => as('sampler', 'POST', '/api/em/excursions', { sampleId: plateSample, ...b });
    expect((await open({})).json().message).toMatch(/over its action limit: give the deviation number/);
    expect((await open({ deviation: 'DEV-26-999' })).json().message).toMatch(/not in the Deviations system/);
    const ok = await open({ deviation: 'DEV-26-201' });
    expect(ok.statusCode, ok.body).toBe(200);
    excursionId = ok.json().id;
    expect((await open({ deviation: 'DEV-26-201' })).statusCode).toBe(409);
    const detail = async (who = 'qcman') => (await as(who, 'GET', `/api/em/excursions/${excursionId}`)).json();
    let d = await detail();
    expect(d.excursion).toMatchObject({ origin: 'result', level: 'action', status: 'isolates to identify', point: { code: 'B101-SP1', where: 'B101 Filling room', grade: 'B', kind: 'settle plate' },
      result: { value: '7', unit: 'CFU', limit: 'NMT 5 CFU (alert above 3)', growth: true } });
    expect(d.deviation).toMatchObject({ number: 'DEV-26-201', byHand: false, link: 'ok', closed: false });
    expect(d.deviations.list.map((x: { number: string }) => x.number)).toEqual(['DEV-26-201']);
    expect(d.refusals.close).toMatch(/Identify the isolates first/);
    expect((await as('sampler', 'POST', `/api/em/excursions/${excursionId}/isolate`, { genus: 'staph', species: 'epidermidis', methodMasterId: emMethod.masterId, report: 'ID-26-001' })).statusCode).toBe(400);
    expect((await as('sampler', 'POST', `/api/em/excursions/${excursionId}/isolate`, { genus: 'Staphylococcus', species: 'epidermidis', methodMasterId: emMethod.masterId, report: 'ID-26-001' })).statusCode).toBe(200);
    d = await detail();
    expect(d.events.find((e: { kind: string }) => e.kind === 'isolate').payload).toMatchObject({ genus: 'Staphylococcus', species: 'epidermidis', method: 'M M', report: 'ID-26-001' });
    expect(d.excursion.status).toBe('open');
    expect((await as('sampler', 'POST', `/api/em/excursions/${excursionId}/close`, { text: 'x' })).statusCode).toBe(403);
    expect((await as('qcman', 'POST', `/api/em/excursions/${excursionId}/close`, { text: 'Gowning breach' })).json().message).toMatch(/still open in Deviations/);
    // Cancelled in Deviations as not a deviation (owner, 20 Nov 2026; closed_at stays empty): ended, as closed.
    await t.owner.unsafe(`update ${dv}.deviation_v1 set status = 'cancelled' where number = 'DEV-26-201'`);
    expect((await detail()).deviation).toMatchObject({ number: 'DEV-26-201', closed: true });
    expect((await as('qcman', 'POST', `/api/em/excursions/${excursionId}/close`, { text: 'Gowning breach; operator retrained' })).statusCode).toBe(200);
    expect((await detail()).excursion.status).toBe('closed');
  });

  it('LIMS-36 the EM map per room shows each point\'s latest result with its level; the trend table lists the last results with the limits; em_v1 publishes the sampling', async () => {
    const map = (await as('viewer', 'GET', '/api/em/map')).json() as { groups: { key: string; grade: string; points: { code: string; samplings: { key: string; limit: string; latest: { result: { level: string; value: string } } | null }[] }[] }[] };
    const b = map.groups.find((g) => g.key === 'room:B101')!;
    expect(b.grade).toBe('B');
    expect(b.points[0]!.samplings.find((s) => s.key === 'sp')).toMatchObject({ limit: 'NMT 5 CFU (alert above 3)', latest: { result: { level: 'action', value: '7' } } });
    const one = (await as('viewer', 'GET', `/api/em/map?point=${(await as('viewer', 'GET', '/api/masters?kind=monitoring')).json()[0].masterId}:p1&n=5`)).json();
    expect(one.groups).toHaveLength(1);
    // QC rejects the sample (its result is over the limit): the decision publishes the result in em_v1.
    const s = (await as('qcman', 'GET', `/api/samples/${plateSample}`)).json();
    const rej = await as('qcman', 'POST', `/api/samples/${plateSample}/reject`, { proof: proofFor('qcman'), contentHash: s.decisionHash, reason: 'Over the action limit' });
    expect(rej.statusCode, rej.body).toBe(200);
    const rows = await t.owner.unsafe(`select sample_number, point_code, point_kind, room_code, room_grade, sampling_kind, state, value, unit, alert_limit, action_limit, level,
      excursion_status, deviation_number, decision from ${t.schema}_report.em_v1`);
    expect(rows).toEqual([expect.objectContaining({ point_code: 'B101-SP1', point_kind: 'ROOM', room_code: 'B101', room_grade: 'B', sampling_kind: 'settle plate', state: 'in operation',
      value: '7', unit: 'CFU', alert_limit: '3', action_limit: '5', level: 'ACTION', excursion_status: 'CLOSED', deviation_number: 'DEV-26-201', decision: 'REJECTED' })]);
    expect((await t.owner.unsafe(`select em_id from ${t.schema}_report.em_v1`))[0]!.em_id).toMatch(/^[0-9a-f-]{36}$/);
    // At its end (owner 19 Nov 2026): the time taken, and the batch it was taken during (none here; TrueBatch is not
    // linked in this test, so a batch given is typed by hand and checked).
    const [first] = await t.owner.unsafe(`select sampled_at, batch_number from ${t.schema}_report.em_v1`);
    expect(first!.sampled_at).toBeInstanceOf(Date);
    expect(first!.batch_number).toBeNull();
    const again = await as('sampler', 'POST', '/api/em/take', { planVersionId: planId, point: 'p1', sampling: 'sp', batch: 'B26-077', reason: 'Filling of batch B26-077' });
    expect(again.statusCode, again.body).toBe(200);
    const [withBatch] = await t.owner.unsafe(`select batch_number from ${t.schema}_report.em_v1 where sample_number = '${(again.json() as { sampleNo: string }).sampleNo}'`);
    expect(withBatch!.batch_number).toBe('B26-077');
  });

  it('LIMS-36 EM adverse trends: the first Staphylococcus epidermidis at B101 is a new organism QC acknowledges with the reason (insert-only, once)', async () => {
    type Row = { key: string; kind: string; room: string; what: string; answer: { reason: string; by: string } | null };
    const all = (await as('viewer', 'GET', '/api/em/adverse')).json() as Row[];
    const flora = all.find((a) => a.kind === 'new organism')!;
    expect(flora).toMatchObject({ room: 'B101', what: 'B101, B101-SP1: new organism Staphylococcus epidermidis (not identified at B101 in the 12 months before)', answer: null });
    // One action result at the point (grade B: 2 in 3): no repeated-alerts trend yet.
    expect(all.filter((a) => a.kind === 'repeated alerts')).toEqual([]);
    expect(((await as('viewer', 'GET', '/api/em/adverse?point=B101-SP1')).json() as Row[]).map((a) => a.key)).toEqual([flora.key]);
    const ack = (who: string, reason: string) => as(who, 'POST', '/api/em/adverse/answer', { key: flora.key, reason });
    expect((await ack('sampler', 'Seen')).statusCode).toBe(403);
    expect((await ack('qcman', 'Skin flora; gowning retraining under DEV-26-201')).statusCode).toBe(200);
    expect((await ack('qcman', 'again')).statusCode).toBe(409);
    expect(((await as('viewer', 'GET', '/api/em/adverse')).json() as Row[]).find((a) => a.key === flora.key)!.answer).toMatchObject({ reason: 'Skin flora; gowning retraining under DEV-26-201', by: 'QCMAN' });
    await expect(t.owner`delete from em_trend_answers`).rejects.toThrow();
  });

  it('LIMS-36 grade A acts on any colony: one CFU at a grade A point is an action excursion, though within the specification\'s limit', async () => {
    const r = await as('sampler', 'POST', '/api/em/take', { planVersionId: planId, point: 'a1', sampling: 'sp' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await as('sampler', 'POST', `/api/samples/${r.json().sampleId}/receive`, { condition: 'Plate closed' })).statusCode).toBe(200);
    await analysed(emMethod.id, r.json().sampleId, '1');
    const list = (await as('viewer', 'GET', '/api/em/excursions')).json() as { pending: { sampleId: number; level: string; why: string }[] };
    expect(list.pending).toEqual([expect.objectContaining({ sampleId: r.json().sampleId, level: 'action', why: 'Grade A: 1 CFU (any colony is acted on).' })]);
  });

  it('LIMS-37 water is sampled at its planned point as a sample of the water system, tested to the pharmacopoeial specification; a result over the alert limit is a trend watch', async () => {
    const r = await as('sampler', 'POST', '/api/em/take', { planVersionId: planId, point: 'w-pw', sampling: 'toc' });
    expect(r.statusCode, r.body).toBe(200);
    const id = r.json().sampleId as number;
    const s = (await as('sampler', 'GET', `/api/samples/${id}`)).json();
    expect(s.sample).toMatchObject({ purpose: 'monitoring', lotNo: 'PW-04', item: { of: 'water', itemId: 'water:PW', code: 'PW', name: 'Purified water' }, quantity: '250 mL',
      monitoring: { kind: 'TOC', frequency: 'weekly', state: null, testKey: 'toc' } });
    // Only the sampling's test applies to the sample (TOC), not conductivity and micro.
    expect(s.spec.tests.map((x: { key: string; applies: boolean }) => [x.key, x.applies])).toEqual([['toc', true], ['cond', false], ['micro', false]]);
    expect((await as('sampler', 'POST', `/api/samples/${id}/receive`, { condition: 'TOC vial sealed' })).statusCode).toBe(200);
    await analysed(waterMethod.id, id, '450');
    const pending = (await as('viewer', 'GET', '/api/em/excursions')).json().pending as { sampleId: number; level: string }[];
    expect(pending.find((p) => p.sampleId === id)).toMatchObject({ level: 'alert' });
    expect((await as('sampler', 'POST', '/api/em/excursions', { sampleId: id, deviation: 'DEV-26-201' })).json().message).toMatch(/alert limit only: a trend watch/);
    const ok = await as('sampler', 'POST', '/api/em/excursions', { sampleId: id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await as('viewer', 'GET', `/api/em/excursions/${ok.json().id}`)).json().excursion).toMatchObject({ level: 'alert', status: 'trend watch', point: { of: 'water', where: 'Purified water' } });
    // QC approves it (within its limit): only the TOC result is needed.
    const d = (await as('qcman', 'GET', `/api/samples/${id}`)).json();
    expect(d.approvalProblems).toEqual([]);
  });

  it('LIMS-36 a particle counter\'s daily report is imported with its SHA-256; its alarms are excursions a second person confirms; the same file twice, an unknown room or per ft³ are refused', async () => {
    const yesterday = addDays(plantToday(new Date()), -1);
    const content = `date,room,channel_um,count_per_m3,max_per_m3,alarm\n${yesterday},B101,0.5,2900,3400,\n${yesterday},B101,5.0,25,40,ACTION\n`;
    const imp = (b: object) => as('sampler', 'POST', '/api/em/imports', { kind: 'particle', fileName: 'PC-B101.csv', content, ...b });
    expect((await imp({ content: content.replace('B101,5.0', 'Z999,5.0') })).json().message).toBe('Room Z999 is not in master data.');
    expect((await imp({ content: content.replace('count_per_m3,max_per_m3', 'count_per_ft3,max_per_ft3') })).json().message).toMatch(/per cubic foot/);
    const ok = await imp({});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ date: yesterday, rows: 2, alarms: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await imp({ fileName: 'again.csv' })).json().message).toMatch(/imported already \(PC-B101.csv\): the same SHA-256/);
    const list = (await as('viewer', 'GET', '/api/em/imports')).json();
    expect(list.imports[0]).toMatchObject({ kind: 'particle', reportDate: yesterday, alarms: 1, rows: [{ where: 'B101', channel: '0.5', values: { count: '2900', max: '3400' }, alarm: null }, expect.anything()] });
    const x = (await as('viewer', 'GET', '/api/em/excursions')).json().excursions.find((e: { origin: string }) => e.origin === 'import');
    expect(x).toMatchObject({ level: 'action', status: 'to confirm', point: { code: 'B101', grade: 'B' } });
    expect((await as('sampler', 'POST', `/api/em/excursions/${x.id}/confirm`, {})).json().message).toMatch(/You imported the report: a second person confirms/);
    expect((await as('sampler', 'POST', `/api/em/excursions/${x.id}/deviation`, { number: 'DEV-26-201' })).json().message).toMatch(/confirms the alarm first/);
    expect((await as('sampler2', 'POST', `/api/em/excursions/${x.id}/confirm`, {})).statusCode).toBe(200);
    expect((await as('sampler2', 'POST', `/api/em/excursions/${x.id}/deviation`, { number: 'DEV-26-201' })).statusCode).toBe(200);
    expect((await as('viewer', 'GET', `/api/em/excursions/${x.id}`)).json().excursion.status).toBe('open');
  });
});
