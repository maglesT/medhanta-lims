import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp, validatedOutside } from './helpers.js';
import { small } from './engine-fixture.js';
import { OOS_CHECKLIST, checklistProblems, oosRefusal, oosStatus, plans, retestRefusal, type OosEvent, type OosEventKind, type OosPayload } from '../shared/engine/oos.js';
import { approvalProblems, type SampleEvent, type TestState } from '../shared/engine/sample.js';
import { specChecks, specSchema, type SpecDoc } from '../shared/master/spec.js';

// OOS and OOT (LIMS-23, LIMS-24, LIMS-25, LIMS-48; FDA guidance on OOS results, 2022): an out-of-limit result opens an
// OOS at once; phase I in the lab (checklist, planned re-measurements, conclusion, supervisor's review); a laboratory
// error is invalidated by QA and retested, the original kept; otherwise phase II in Deviations and QA's conclusion; the
// QC decision waits for it. A result outside the spec's trend limit is flagged and answered by QC.

// ---- The rules (shared/engine/oos.ts) ----
let n = 0;
const e = (kind: OosEventKind, person = 1, payload: OosPayload = {}): OosEvent => ({ id: ++n, kind, person, payload });
const yes = Object.fromEntries(OOS_CHECKLIST.map(([k]) => [k, { yes: true }]));
const facts = { analysisPeople: [1] };
const user = (id: number, ...permissions: string[]) => ({ id, permissions });
const analyst = user(1, 'lims.analysis.perform');
const supervisor = user(2, 'lims.analysis.review');
const qa = user(3, 'lims.oos.approve');

describe('the OOS rules', () => {
  it('LIMS-23 phase I: the checklist, every "no" with what was found; concluded by the analyst; reviewed by a supervisor who did no part of it', () => {
    expect(checklistProblems(yes)).toEqual([]);
    expect(checklistProblems({ ...yes, calculation: { yes: false } })).toEqual(['The calculation was checked and is correct: you answered no; say what was found.']);
    expect(checklistProblems({})).toHaveLength(OOS_CHECKLIST.length);
    const ev: OosEvent[] = [];
    expect(oosStatus(ev)).toBe('phase I');
    expect(oosRefusal('conclude-phase1', facts, ev, analyst)).toBe('Answer the phase Ia checklist first.');
    ev.push(e('checklist', 1, { answers: yes }), e('phase1_concluded', 1, { labError: false }));
    expect(oosStatus(ev)).toBe('phase I review');
    expect(oosRefusal('review', facts, ev, user(1, 'lims.analysis.review'))).toMatch(/a supervisor who did not reviews it/);
    expect(oosRefusal('review', facts, ev, qa)).toBe('You do not have the permission for this action.');
    expect(oosRefusal('review', facts, ev, supervisor)).toBeNull();
    ev.push(e('phase1_reviewed', 2));
    expect(oosStatus(ev)).toBe('phase II');
    // A return sends phase I back: the checklist and conclusion are recorded again.
    const back = [...ev.slice(0, 2), e('phase1_returned', 2, { reason: 'Check the standard again' })];
    expect(oosStatus(back)).toBe('phase I');
    expect(oosRefusal('conclude-phase1', facts, back, analyst)).toBe('Answer the phase Ia checklist first.');
  });

  it('LIMS-24 a re-measurement is done only as planned in writing before; every result stays, none averaged away', () => {
    const ev = [e('checklist', 1, { answers: yes })];
    expect(oosRefusal('remeasure', facts, ev, analyst, { plan: 99 })).toBe('A re-measurement is done only as planned in writing before: write the plan first.');
    const plan = e('plan', 1, { what: 'Re-inject the same sample solution twice', by: 'Analyst' });
    ev.push(plan);
    expect(oosRefusal('conclude-phase1', facts, ev, analyst)).toBe('Every planned re-measurement is recorded before phase I is concluded.');
    expect(oosRefusal('remeasure', facts, ev, analyst, { plan: plan.id })).toBeNull();
    ev.push(e('remeasured', 1, { plan: plan.id, value: '7.3', pass: false }));
    expect(oosRefusal('remeasure', facts, ev, analyst, { plan: plan.id })).toBe('This plan\'s re-measurement is already recorded.');
    expect(plans(ev)).toMatchObject([{ plan: { id: plan.id }, result: { payload: { value: '7.3', pass: false } } }]);
  });

  it('LIMS-24 a result is invalidated only for an assignable laboratory cause, by QA, who did no part of the analysis; retests only as QA authorised', () => {
    const ev = [e('checklist', 1, { answers: { ...yes, standards: { yes: false, comment: 'Standard solution 10 days old (limit 7)' } } }),
      e('phase1_concluded', 1, { labError: true, cause: 'Expired standard solution' }), e('phase1_reviewed', 2)];
    expect(oosStatus(ev)).toBe('QA approval');
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'confirmed' })).toMatch(/QA invalidates the result, or returns phase I/);
    expect(oosRefusal('conclude', facts, ev, user(1, 'lims.oos.approve'), { outcome: 'invalidated' })).toMatch(/another person in QA/);
    expect(oosRefusal('conclude', facts, ev, supervisor, { outcome: 'invalidated' })).toBe('You do not have the permission for this action.');
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'invalidated' })).toBeNull();
    expect(retestRefusal(ev)).toMatch(/only after QA invalidated/);
    ev.push(e('concluded', 3, { outcome: 'invalidated', retests: 1 }), e('retest', 1, { analysis: 7 }));
    expect(oosStatus(ev)).toBe('invalidated');
    expect(retestRefusal(ev)).toBe('QA authorised 1 retest: 1 started.');
    expect(oosRefusal('checklist', facts, ev, analyst)).toMatch(/concluded/);
  });

  it('LIMS-23 phase II: a deviation number (typed by hand while Deviations is not reachable, then checked by a second person), concluded by QA once it is closed', () => {
    const ev = [e('checklist', 1, { answers: yes }), e('phase1_concluded', 1, { labError: false }), e('phase1_reviewed', 2)];
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'confirmed' })).toBe('Phase II needs its deviation number in DIVE first.');
    const typed = e('phase2', 2, { reference: 'DEV-P-9', source: { from: 'hand', state: 'down' } });
    ev.push(typed);
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'confirmed' })).toBe('A second person checks the deviation number typed by hand first.');
    expect(oosRefusal('check-phase2', facts, ev, supervisor)).toBe('You typed the deviation number: a second person checks it.');
    expect(oosRefusal('check-phase2', facts, ev, qa)).toBeNull();
    ev.push(e('phase2_checked', 3, { entry: typed.id }));
    // Read now from Deviations: open there, QA waits; closed, QA concludes; unreachable, QA confirms by hand.
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'confirmed' }, { state: 'ok', status: 'investigation' })).toMatch(/is investigation in DIVE: QA concludes once it is closed there/);
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'confirmed' }, { state: 'ok', status: 'closed' })).toBeNull();
    // Cancelled in Deviations as not a deviation (owner, 20 Nov 2026): ended, QA concludes; rejected is not an end for phase II.
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'confirmed' }, { state: 'ok', status: 'cancelled' })).toBeNull();
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'confirmed' }, { state: 'ok', status: 'rejected' })).toMatch(/is rejected in DIVE/);
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'confirmed' }, { state: 'down' })).toBeNull();
    expect(oosRefusal('conclude', facts, ev, qa, { outcome: 'invalidated' }, { state: 'ok', status: 'closed' })).toBe('An invalidation needs the assignable laboratory cause found.');
  });

  it('LIMS-23 LIMS-25 QC approval waits for the sample\'s OOS and answered out-of-trend flags; a confirmed OOS leaves only rejection', () => {
    const received: SampleEvent[] = [{ kind: 'received', person: 1, payload: {} }];
    const ok: TestState = { key: 'ph', name: 'pH', applies: true, reviewed: { analysisNo: 'LA2600002', hasResult: true, pass: true, shown: '6.8', people: [5], openDeviations: 0 } };
    const f = { registeredBy: 1, byHand: false };
    expect(approvalProblems(f, received, [ok], 9, [{ oosNo: 'OOS260001', testName: 'pH', status: 'open' }])).toEqual(['OOS260001 (pH) is open: the sample is approved only after the OOS is concluded.']);
    expect(approvalProblems(f, received, [ok], 9, [{ oosNo: 'OOS260001', testName: 'pH', status: 'confirmed' }])).toEqual(['OOS260001 (pH) is a confirmed OOS: the sample can only be rejected.']);
    expect(approvalProblems(f, received, [ok], 9, [{ oosNo: 'OOS260001', testName: 'pH', status: 'invalidated' }])).toEqual([]);
    const oot = { ...ok, reviewed: { ...ok.reviewed!, outOfTrend: 'trend limit 5.5 to 6.5' } };
    expect(approvalProblems(f, received, [oot], 9)).toEqual(['pH: 6.8 is out of trend (trend limit 5.5 to 6.5, analysis LA2600002): QC answers the flag first.']);
    const answered: SampleEvent[] = [...received, { kind: 'oot_answered', person: 9, payload: { test: 'ph', analysisNo: 'LA2600002', answer: 'no action', reason: 'Within the variation of the method' } }];
    expect(approvalProblems(f, answered, [oot], 9)).toEqual([]);
  });
});

// ---- On the server ----
let t: TestApp;
let provider: Sql;
let DV = '';
const cookies: Record<string, string> = {};
const MAT = '00000000-0000-0000-0000-00000000000d';
beforeAll(async () => {
  t = await freshApp(async (db) => {
    DV = `${db.schema}_dv`;
    await db.owner.unsafe(`create schema ${DV};
      create table ${DV}.deviation_v1 (number text, status text, classification text, opened_at timestamptz, closed_at timestamptz, product text, batch text,
        batch_norm text, outcome text, read_at timestamptz default now(), data_as_of timestamptz default now(), title text, source_ref text);
      grant usage on schema ${DV} to lims_app; grant select on all tables in schema ${DV} to lims_app;`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ deviations: provider }, { deviations: DV });
  });
  t.master.materials_.push({ itemId: MAT, code: 'RM-040', name: 'Demoxine', version: 1, active: true, category: 'API', unit: 'kg' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register', 'lims.view'], sampler2: ['lims.sample.register'], analyst: ['lims.analysis.perform', 'lims.view'],
    reviewer: ['lims.analysis.review'], supervisor: ['lims.analysis.review'], qalead: ['lims.oos.approve'], qcuser: ['lims.qc.approve', 'lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(async () => { await t.close(); await provider.end(); });

const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
async function effective(kind: 'method' | 'spec', doc: object) {
  const r = await as('author', 'POST', '/api/masters', { kind, doc });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number; masterId: number };
  const hash = async (who: string) => ((await as(who, 'GET', `/api/master-versions/${v.id}/review`)).json() as { contentHash: string }).contentHash;
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-003' }]] as const) {
    const res = await as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hash(who), ...x });
    expect(res.statusCode, `${a}: ${res.body}`).toBe(200);
  }
  await validatedOutside(t.owner, v.id);
  expect((await as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
  return v;
}
const phMethod = () => small([{ role: 'Analyst', steps: [{ key: 'ph', block: { id: 'check', version: 1 }, settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
const spec = (m: number): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: MAT, code: 'RM-040', name: 'Demoxine', type: 'Active substance', number: 'SPEC-RM-040', pharmacopoeia: 'Ph. Int.', sampling: { plan: 'square root' } },
  tests: [{ key: 'ph', name: 'pH', method: { masterId: m, code: 'M', name: 'M' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' },
    trendLimit: { low: '5.5', high: '6.5', unit: '' } }],
});
let method = { id: 0, masterId: 0 };
let specId = 0;

async function sampleOf() {
  const r = await as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: `RM-${Math.random().toString(36).slice(2, 8)}`, byHand: true, itemId: MAT,
    specVersionId: specId, quantity: '30 g', purpose: 'release', received: 1, sampled: [1] });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  expect((await as('sampler2', 'POST', `/api/samples/${id}/check`, {})).statusCode).toBe(200);
  expect((await as('sampler', 'POST', `/api/samples/${id}/receive`, { condition: 'Sealed' })).statusCode).toBe(200);
  return id;
}
/** An analysis of the sample (a retest of an OOS when oosId is given): pH recorded and signed; reviewed unless told not. */
async function analysed(sampleId: number, reading: string, review = true, oosId?: number) {
  const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: method.id, sampleId, proof: proofFor('analyst'), ...(oosId ? { oosId } : {}) });
  expect(r.statusCode, r.body).toBe(200);
  const { id, analysisNo } = r.json() as { id: number; analysisNo: string };
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  expect((await step('start')).statusCode).toBe(200);
  expect((await step('record', { values: { reading } })).statusCode).toBe(200);
  const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] };
  if (Number(reading) < 5 || Number(reading) > 7) expect((await step('note', { text: 'Out of limits: OOS opened' })).statusCode).toBe(200);
  const done = await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash });
  expect(done.statusCode, done.body).toBe(200);
  if (review) {
    const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
    const res = await as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash });
    expect(res.statusCode, res.body).toBe(200);
  }
  return { id, analysisNo };
}
type Oos = { oos: { id: number; oosNo: string; result: { shown: string; limit: string } }; status: string; actions: string[]; refusals: Record<string, string | null>; contentHash: string;
  plans: { plan: { id: number }; result: { payload: { value: string; pass: boolean } } | null }[]; retests: { authorised: number; analyses: { analysisNo: string; status: string }[] };
  phase2: { reference: string; typed: boolean; checked: boolean } | null; deviations: { link: string; list: { number: string }[] }; retestRefusal: string | null };
const oosOf = async (sampleId: number) => ((await as('qcuser', 'GET', `/api/samples/${sampleId}`)).json() as { oos: { id: number; oosNo: string; status: string }[] }).oos;
const get = async (id: number, who = 'analyst') => (await as(who, 'GET', `/api/oos/${id}`)).json() as Oos;
const act = async (who: string, id: number, action: string, body: object = {}, signed?: 'reviewed' | 'oos_approved') =>
  as(who, 'POST', `/api/oos/${id}/${action}`, { ...body, ...(signed ? { proof: proofFor(who), contentHash: (await get(id, who)).contentHash } : {}) });
const ok = async (r: Promise<{ statusCode: number; body: string }>) => { const x = await r; expect(x.statusCode, x.body).toBe(200); };
const detail = async (id: number) => (await as('qcuser', 'GET', `/api/samples/${id}`)).json() as { decisionHash: string; approvalProblems: string[];
  oot: { key: string; answer: unknown }[]; spec: { tests: { analyses: { analysisNo: string; status: string }[] }[] } };
const approve = async (id: number) => as('qcuser', 'POST', `/api/samples/${id}/approve`, { proof: proofFor('qcuser'), contentHash: (await detail(id)).decisionHash });
const view = async (oosNo: string) => (await t.owner.unsafe(`select oos_number, status, phase_ii_needed, deviation_number, test_name, shown, closed_at is not null as closed from ${t.schema}_report.oos_v1 where oos_number = '${oosNo}'`))[0];

describe('OOS on the server', () => {
  beforeAll(async () => {
    method = await effective('method', phMethod());
    specId = (await effective('spec', spec(method.masterId))).id;
  });

  it('LIMS-23 an out-of-limit result opens an OOS at once, when the step is signed; a result within the limit opens none', async () => {
    const sid = await sampleOf();
    await analysed(sid, '6.0', false);
    expect(await oosOf(sid)).toEqual([]);
    const { id: aid } = await analysed(sid, '7.4', false);
    const list = await oosOf(sid);
    expect(list).toMatchObject([{ oosNo: expect.stringMatching(/^OOS\d{6}$/), status: 'open' }]);
    const o = await get(list[0]!.id);
    expect(o).toMatchObject({ status: 'phase I', oos: { result: { shown: '7.4', limit: '5.0 to 7.0' } } });
    // The analysis links to it; the published view shows it open; the sample cannot be approved.
    expect(((await as('analyst', 'GET', `/api/analyses/${aid}`)).json() as { oos: { oosNo: string }[] }).oos).toMatchObject([{ oosNo: o.oos.oosNo }]);
    expect(await view(o.oos.oosNo)).toEqual({ oos_number: o.oos.oosNo, status: 'OPEN', phase_ii_needed: false, deviation_number: null, test_name: 'pH', shown: '7.4', closed: false });
    expect((await detail(sid)).approvalProblems).toContain(`${o.oos.oosNo} (pH) is open: the sample is approved only after the OOS is concluded.`);
    // LIMS-15: an OOS shows the result as reported, rounded as the limit is written (found on the demo: OOS260001 showed
    // the loss on drying to 49 decimals); the full value stays in the record.
    const s2 = await sampleOf();
    await analysed(s2, '7.4567', false);
    const o2 = await get((await oosOf(s2))[0]!.id);
    expect(o2.oos.result.shown).toBe('7.5');
    expect((await view(o2.oos.oosNo))!.shown).toBe('7.5');
    const [pub] = await t.owner.unsafe(`select value::text from ${t.schema}_report.oos_v1 where oos_number = '${o2.oos.oosNo}'`);
    expect(pub!.value).toBe('7.5');
    const [rec] = await t.owner<{ value: string }[]>`select result->>'value' as value from oos where oos_no = ${o2.oos.oosNo}`;
    expect(rec!.value).toBe('7.4567');
  });

  it('LIMS-24 LIMS-48 phase I finds a laboratory error; QA invalidates; the original analysis stays, marked invalidated; the authorised retest passes and the sample is approved', async () => {
    const sid = await sampleOf();
    const first = await analysed(sid, '7.4', true);
    const id = (await oosOf(sid))[0]!.id;
    // Phase Ia by the analyst; a re-measurement only as planned (Ib), its result kept as it is.
    expect((await act('analyst', id, 'remeasure', { plan: 1, value: '7.3', reference: 'pH meter printout 12' })).json().problems).toEqual(['A re-measurement is done only as planned in writing before: write the plan first.']);
    expect((await act('analyst', id, 'checklist', { answers: { ...yes, instrument: { yes: false } } })).json().problems).toEqual(['The instrument was fit for use and calibrated: you answered no; say what was found.']);
    await ok(act('analyst', id, 'checklist', { answers: { ...yes, instrument: { yes: false, comment: 'pH meter calibration buffer 7.00 expired on 1 Nov' } } }));
    await ok(act('analyst', id, 'plan', { what: 'Measure the same solution again after calibrating with in-date buffers', by: 'Analyst' }));
    const plan = (await get(id)).plans[0]!.plan.id;
    await ok(act('analyst', id, 'remeasure', { plan, value: '6.2', reference: 'pH meter printout 13' }));
    expect((await get(id)).plans).toMatchObject([{ result: { payload: { value: '6.2', pass: true } } }]);
    await ok(act('analyst', id, 'conclude-phase1', { labError: true, cause: 'pH meter calibrated with an expired buffer' }));
    // A supervisor reviews phase I (e-signature 'reviewed').
    expect((await act('reviewer', id, 'review', {}, 'reviewed')).statusCode).toBe(200);
    expect((await get(id)).status).toBe('QA approval');
    // No retest before QA's invalidation; QA signs it (permission lims.oos.approve).
    const early = await as('analyst', 'POST', '/api/analyses', { masterVersionId: method.id, sampleId: sid, oosId: id, proof: proofFor('analyst') });
    expect(early.statusCode).toBe(409);
    expect(early.json().problems[0]).toMatch(/only after QA invalidated/);
    expect((await act('supervisor', id, 'conclude', { outcome: 'invalidated', reason: 'Assignable cause confirmed' }, 'reviewed')).statusCode).toBe(401);
    await ok(act('qalead', id, 'conclude', { outcome: 'invalidated', reason: 'Assignable laboratory cause confirmed: expired buffer', retests: 1 }, 'oos_approved'));
    expect(await view((await get(id)).oos.oosNo)).toMatchObject({ status: 'INVALIDATED', closed: true });
    // LIMS-48: the original stays, marked invalidated, never deleted.
    const a = (await as('analyst', 'GET', `/api/analyses/${first.id}`)).json() as { analysis: { status: string; invalidated: { payload: { oosNo: string } } } };
    expect(a.analysis).toMatchObject({ status: 'invalidated', invalidated: { payload: { oosNo: (await get(id)).oos.oosNo } } });
    expect((await detail(sid)).spec.tests[0]!.analyses).toMatchObject([{ analysisNo: first.analysisNo, status: 'invalidated' }]);
    await expect(t.owner`delete from analyses where id = ${first.id}`).rejects.toThrow();
    // The retest QA authorised: a new analysis linked to the OOS; a second one is refused.
    const re = await analysed(sid, '6.1', true, id);
    expect((await get(id)).retests).toMatchObject({ authorised: 1, analyses: [{ analysisNo: re.analysisNo, status: 'reviewed' }] });
    expect((await as('analyst', 'POST', '/api/analyses', { masterVersionId: method.id, sampleId: sid, oosId: id, proof: proofFor('analyst') })).json().problems)
      .toEqual(['QA authorised 1 retest: 1 started.']);
    // The invalidated result no longer counts: the retest's does; the sample is approved.
    expect((await detail(sid)).approvalProblems).toEqual([]);
    const r = await approve(sid);
    expect(r.statusCode, r.body).toBe(200);
    const [res] = await t.owner.unsafe(`select analysis_number, value::text from ${t.schema}_report.result_v1 where coa_number = '${(r.json() as { coaNo: string }).coaNo}'`);
    expect(res).toEqual({ analysis_number: re.analysisNo, value: '6.1' });
  });

  it('LIMS-23 no laboratory error: phase II is a deviation picked from Deviations; QA concludes "OOS confirmed" once it is closed there; the sample can only be rejected', async () => {
    const sid = await sampleOf();
    const { analysisNo } = await analysed(sid, '4.6', true);
    const id = (await oosOf(sid))[0]!.id;
    const oosNo = (await get(id)).oos.oosNo;
    await ok(act('analyst', id, 'checklist', { answers: yes }));
    await ok(act('analyst', id, 'conclude-phase1', { labError: false }));
    await ok(act('supervisor', id, 'review', {}, 'reviewed'));
    expect(await view(oosNo)).toMatchObject({ status: 'OPEN', phase_ii_needed: true });
    // Deviations names the analysis: the deviation is picked; a number Deviations does not have is refused.
    await t.owner.unsafe(`insert into ${DV}.deviation_v1 (number, status, batch, batch_norm, title) values
      ('DEV-26-0300', 'investigation', '${analysisNo}', '${analysisNo.toLowerCase()}', 'Phase II of ${oosNo}')`);
    expect((await get(id)).deviations).toEqual({ link: 'ok', list: [expect.objectContaining({ number: 'DEV-26-0300' })] });
    expect((await act('supervisor', id, 'phase2', { reference: 'DEV-26-9999' })).json().error).toBe('unknown_deviation');
    await ok(act('supervisor', id, 'phase2', { reference: 'DEV-26-0300' }));
    expect((await get(id)).phase2).toMatchObject({ reference: 'DEV-26-0300', typed: false });
    const early = await act('qalead', id, 'conclude', { outcome: 'confirmed', reason: 'Manufacturing cause found' }, 'oos_approved');
    expect(early.json().problems[0]).toMatch(/DEV-26-0300 is investigation in DIVE/);
    await t.owner.unsafe(`update ${DV}.deviation_v1 set status = 'closed', closed_at = now() where number = 'DEV-26-0300'`);
    await ok(act('qalead', id, 'conclude', { outcome: 'confirmed', reason: 'Phase II DEV-26-0300 closed: mixing time too short' }, 'oos_approved'));
    expect(await view(oosNo)).toMatchObject({ status: 'CONFIRMED', phase_ii_needed: false, deviation_number: 'DEV-26-0300', closed: true });
    expect((await detail(sid)).approvalProblems).toContain(`${oosNo} (pH) is a confirmed OOS: the sample can only be rejected.`);
    expect((await approve(sid)).statusCode).toBe(409);
    await ok(as('qcuser', 'POST', `/api/samples/${sid}/reject`, { proof: proofFor('qcuser'), contentHash: (await detail(sid)).decisionHash, reason: `Confirmed OOS ${oosNo}` }));
  });

  it('LIMS-23 the deviation Deviations filed from the OOS (its source_ref names it) is the phase II deviation, nobody picks it; QA concludes once it is closed', async () => {
    const sid = await sampleOf();
    await analysed(sid, '4.4', true);
    const id = (await oosOf(sid))[0]!.id;
    const oosNo = (await get(id)).oos.oosNo;
    await ok(act('analyst', id, 'checklist', { answers: yes }));
    await ok(act('analyst', id, 'conclude-phase1', { labError: false }));
    await ok(act('supervisor', id, 'review', {}, 'reviewed'));
    const [row] = await t.owner.unsafe(`select oos_id::text from ${t.schema}_report.oos_v1 where oos_number = '${oosNo}'`) as { oos_id: string }[];
    const oosId = row!.oos_id;
    await t.owner.unsafe(`insert into ${DV}.deviation_v1 (number, status, title, source_ref) values ('DEV-26-0310', 'investigation', 'Phase II of ${oosNo}', 'lims:oos:${oosId}')`);
    const d = await get(id);
    expect(d.phase2).toMatchObject({ reference: 'DEV-26-0310', typed: false, filed: true, event: null });
    expect((await act('supervisor', id, 'phase2', { reference: 'DEV-26-0310' })).json().problems).toEqual(['The phase II deviation is DEV-26-0310.']);
    expect((await act('qalead', id, 'conclude', { outcome: 'confirmed', reason: 'early' }, 'oos_approved')).json().problems[0]).toMatch(/DEV-26-0310 is investigation in DIVE/);
    await t.owner.unsafe(`update ${DV}.deviation_v1 set status = 'closed', closed_at = now() where number = 'DEV-26-0310'`);
    await ok(act('qalead', id, 'conclude', { outcome: 'confirmed', reason: 'Phase II DEV-26-0310 closed: wrong granulation end point' }, 'oos_approved'));
    expect(await view(oosNo)).toMatchObject({ status: 'CONFIRMED', closed: true });
  });

  it('LIMS-23 Deviations not reachable: the phase II number is typed by hand, checked by a second person, and QA confirms the closure by hand', async () => {
    const sid = await sampleOf();
    await analysed(sid, '7.6', false);
    const id = (await oosOf(sid))[0]!.id;
    await ok(act('analyst', id, 'checklist', { answers: yes }));
    await ok(act('analyst', id, 'conclude-phase1', { labError: false }));
    await ok(act('supervisor', id, 'review', {}, 'reviewed'));
    await t.owner.unsafe(`revoke select on ${DV}.deviation_v1 from lims_app`);
    try {
      expect((await get(id)).deviations.link).toBe('down');
      await ok(act('supervisor', id, 'phase2', { reference: 'DEV-PAPER-12' }));
      expect((await get(id)).phase2).toMatchObject({ reference: 'DEV-PAPER-12', typed: true, checked: false });
      expect((await act('qalead', id, 'conclude', { outcome: 'confirmed', reason: 'Closed' }, 'oos_approved')).json().problems).toEqual(['A second person checks the deviation number typed by hand first.']);
      expect((await act('supervisor', id, 'check-phase2')).json().problems).toEqual(['You typed the deviation number: a second person checks it.']);
      await ok(act('reviewer', id, 'check-phase2'));
      await ok(act('qalead', id, 'conclude', { outcome: 'confirmed', reason: 'DEV-PAPER-12 closed on paper on 18 Nov (QA checked the record)' }, 'oos_approved'));
      expect((await get(id)).status).toBe('confirmed');
    } finally {
      await t.owner.unsafe(`grant select on ${DV}.deviation_v1 to lims_app`);
    }
  });

  it('LIMS-25 a reviewed result within the limit but outside the trend limit is flagged; QC answers it before approval', async () => {
    const sid = await sampleOf();
    await analysed(sid, '6.8', true);
    expect(await oosOf(sid)).toEqual([]);
    const d = await detail(sid);
    expect(d.approvalProblems).toEqual([expect.stringMatching(/^pH: 6\.8 is out of trend \(trend limit 5\.5 to 6\.5, analysis LA\d+\): QC answers the flag first\.$/)]);
    expect(d.oot).toMatchObject([{ key: 'ph', answer: null }]);
    expect((await as('analyst', 'POST', `/api/samples/${sid}/oot`, { test: 'ph', answer: 'no action', reason: 'x' })).statusCode).toBe(403);
    await ok(as('qcuser', 'POST', `/api/samples/${sid}/oot`, { test: 'ph', answer: 'investigation', reason: 'Third high result this month: trend investigation TI-26-04' }));
    expect((await as('qcuser', 'POST', `/api/samples/${sid}/oot`, { test: 'ph', answer: 'no action', reason: 'again' })).json().problems).toEqual(['QC has already answered this flag.']);
    expect((await detail(sid)).approvalProblems).toEqual([]);
    await ok(approve(sid));
  });

  it('LIMS-25 the trend limit is part of the specification: checked like the limit, refused on a conforms test', () => {
    const s = spec(1);
    const problems = specChecks({ ...s, tests: [{ ...s.tests[0]!, limitType: 'conforms', limit: undefined, conforms: 'Clear solution' }] }, () => null);
    expect(problems.map((p) => p.message)).toContain('pH: a conforms test has no number to trend');
  });
});
