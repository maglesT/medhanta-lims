import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp, validatedOutside } from './helpers.js';
import { small } from './engine-fixture.js';
import { approvalProblems, sampleDecision, type SampleEvent, type TestState } from '../shared/engine/sample.js';
import { limitText, specSchema, type SpecDoc } from '../shared/master/spec.js';
import { reportedFigure } from '../server/routes/samples.js';
import { resultFigure } from '../server/coa.js';

// QC's decision on a sample (LIMS-20) and its certificate of analysis (LIMS-21): approval only when every test that
// applies has a reviewed result within its limit, by a person who did no part of the analyses (LIMS-41); rejection at
// any time with a reason; one decision; the results decided on are published in result_v1 and coa_v1.

// ---- The rules (shared/engine/sample.ts) ----
const ev = (kind: SampleEvent['kind'], person = 1): SampleEvent => ({ kind, person, payload: {} });
const facts = { registeredBy: 1, byHand: false };
const ok = (over: Partial<NonNullable<TestState['reviewed']>> = {}): TestState['reviewed'] => ({ analysisNo: 'LA2600001', hasResult: true, pass: true, shown: '6.1', people: [5], openDeviations: 0, ...over });

describe('the approval rules', () => {
  it('LIMS-11 LIMS-20 every test that applies needs a reviewed result within its limit; a test that does not apply is not needed', () => {
    const received = [ev('received')];
    const tests: TestState[] = [{ key: 'ph', name: 'pH', applies: true, reviewed: ok() }, { key: 'w', name: 'Water', applies: false, reviewed: null }];
    expect(approvalProblems(facts, received, tests, 9)).toEqual([]);
    expect(approvalProblems(facts, received, [{ ...tests[0]!, reviewed: null }], 9)).toEqual(['pH: no reviewed result yet.']);
    expect(approvalProblems(facts, received, [{ ...tests[0]!, reviewed: ok({ hasResult: false }) }], 9)).toEqual(['pH: analysis LA2600001 has no result.']);
    expect(approvalProblems(facts, received, [{ ...tests[0]!, reviewed: ok({ pass: false, shown: '7.4' }) }], 9))
      .toEqual(['pH: 7.4 is out of limits (analysis LA2600001): it is investigated as an OOS result; the sample cannot be approved.']);
    expect(approvalProblems(facts, received, [{ ...tests[0]!, reviewed: ok({ openDeviations: 1 }) }], 9)).toEqual(['pH: analysis LA2600001 has 1 open deviation.']);
    // A report-only result has no pass or fail: its result is enough.
    expect(approvalProblems(facts, received, [{ ...tests[0]!, reviewed: ok({ pass: undefined }) }], 9)).toEqual([]);
  });

  it('LIMS-41 nobody approves a sample whose analyses they worked on', () => {
    expect(approvalProblems(facts, [ev('received')], [{ key: 'ph', name: 'pH', applies: true, reviewed: ok({ people: [5, 9] }) }], 9))
      .toEqual(['pH: you worked on analysis LA2600001; another person approves the sample.']);
  });

  it('LIMS-20 a sample not received yet is not approved; a decision is made once', () => {
    expect(approvalProblems(facts, [], [], 9)).toEqual(['QC has not received the sample yet.']);
    expect(approvalProblems(facts, [ev('received'), ev('approved')], [], 9)).toEqual(['The sample is already approved.']);
    expect(sampleDecision([ev('received'), ev('rejected')])).toBe('rejected');
    expect(sampleDecision([ev('received')])).toBeNull();
  });
});

// ---- On the server ----
let t: TestApp;
const cookies: Record<string, string> = {};
const MAT = '00000000-0000-0000-0000-00000000000c';
beforeAll(async () => {
  t = await freshApp();
  t.master.materials_.push({ itemId: MAT, code: 'RM-030', name: 'Demolol', version: 1, active: true, category: 'API', unit: 'kg' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register', 'lims.view'], sampler2: ['lims.sample.register'], analyst: ['lims.analysis.perform', 'lims.view', 'lims.qc.approve'],
    reviewer: ['lims.analysis.review'], qcuser: ['lims.qc.approve', 'lims.view'], viewer: ['lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(() => t.close());

const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
async function effective(kind: 'method' | 'spec', doc: object) {
  const r = await as('author', 'POST', '/api/masters', { kind, doc });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number; masterId: number };
  const hash = async (who: string) => ((await as(who, 'GET', `/api/master-versions/${v.id}/review`)).json() as { contentHash: string }).contentHash;
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-002' }]] as const) {
    const res = await as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hash(who), ...x });
    expect(res.statusCode, `${a}: ${res.body}`).toBe(200);
  }
  await validatedOutside(t.owner, v.id);
  expect((await as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
  return v;
}
const phMethod = () => small([{ role: 'Analyst', steps: [{ key: 'ph', block: { id: 'check', version: 1 }, settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
const spec = (m: number): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: MAT, code: 'RM-030', name: 'Demolol', type: 'Active substance', number: 'SPEC-RM-030', pharmacopoeia: 'Ph. Int.', sampling: { plan: 'square root' } },
  tests: [{ key: 'ph', name: 'pH', method: { masterId: m, code: 'M', name: 'M' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' } }],
});
let method = { id: 0, masterId: 0 };
let coaOf = 0;
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
/** An analysis of the sample: pH recorded, signed, and (unless told not) reviewed by a second person. */
async function analysed(sampleId: number, reading: string, review = true) {
  const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: method.id, sampleId, proof: proofFor('analyst') });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  expect((await step('start')).statusCode).toBe(200);
  expect((await step('record', { values: { reading } })).statusCode).toBe(200);
  const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] };
  if (Number(reading) < 5 || Number(reading) > 7) expect((await step('note', { text: 'Out of limits: OOS investigation opened' })).statusCode).toBe(200);
  expect((await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash })).statusCode).toBe(200);
  if (review) {
    const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
    const res = await as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash });
    expect(res.statusCode, res.body).toBe(200);
  }
  return id;
}
type Detail = { decision: string | null; decisionHash: string; approvalProblems: string[]; rejectionRefusal: string | null };
const detail = async (id: number, who = 'qcuser') => (await as(who, 'GET', `/api/samples/${id}`)).json() as Detail;
const decide = async (id: number, who: string, decision: 'approve' | 'reject', extra: object = {}) =>
  as(who, 'POST', `/api/samples/${id}/${decision}`, { proof: proofFor(who), contentHash: (await detail(id, who)).decisionHash, ...extra });

describe('QC decision on the server', () => {
  beforeAll(async () => {
    method = await effective('method', phMethod());
    specId = (await effective('spec', spec(method.masterId))).id;
  });

  it('LIMS-20 LIMS-21 QC approves a sample whose tests all have a reviewed result within limits: a CoA number, the certificate, and the published views', async () => {
    const sid = await sampleOf();
    expect((await detail(sid)).approvalProblems).toEqual(['pH: no reviewed result yet.']);
    await analysed(sid, '6.1', false);
    expect((await detail(sid)).approvalProblems).toEqual(['pH: no reviewed result yet.']);
    const aid = await analysed(sid, '6.2');
    expect((await detail(sid)).approvalProblems).toEqual([]);
    const r = await decide(sid, 'qcuser', 'approve');
    expect(r.statusCode, r.body).toBe(200);
    const coaNo = (r.json() as { coaNo: string }).coaNo;
    expect(coaNo).toMatch(/^COA\d{7}$/);
    expect((await detail(sid)).decision).toBe('approved');
    coaOf = sid;
    // Published for MMS and TrueBatch: the CoA and its results as decided (reviewed only).
    const [coa] = await t.owner.unsafe(`select coa_number, decision, item_code, decided_by, spec_number from ${t.schema}_report.coa_v1 where coa_number = '${coaNo}'`);
    expect(coa).toMatchObject({ coa_number: coaNo, decision: 'APPROVED', item_code: 'RM-030', decided_by: 'QCUSER', spec_number: 'SPEC-RM-030' });
    const rows = await t.owner.unsafe(`select test_key, value::text, passed, limit_text, analysis_number from ${t.schema}_report.result_v1 where coa_number = '${coaNo}'`);
    const [rep] = await t.owner.unsafe(`select reported from ${t.schema}_report.result_v1 where coa_number = '${coaNo}'`);
    expect(rep).toEqual({ reported: '6.2' });
    // The TrueBatch contract (19 Nov 2026): reported is the bare figure, never with its unit, for every row; the printed
    // text is reported_text. Found on the demo: COA2600002 published '1.25 g/mL' and COA2600001 (decided before
    // `reported` was kept) published none. Decisions stood in by the owner connection (the record's own shape).
    const decided = async (results: object[]) => {
      const id = await sampleOf();
      const [u] = await t.owner<{ id: number }[]>`select id::int from users order by id limit 1`;
      await t.owner`insert into sample_events (sample_id, kind, payload, person_id) values (${id}, 'approved', ${t.owner.json({ coaNo: `COA-T${id}`, results } as never)}, ${u!.id})`;
      return t.owner.unsafe(`select test_key, reported, reported_text from ${t.schema}_report.result_v1 where coa_number = 'COA-T${id}' order by test_key`);
    };
    expect(await decided([{ key: 'ph', name: 'pH', value: '6.249604474630443', unit: '', shown: 'Reading 6.249604474630443 after no further change' }]))
      .toEqual([{ test_key: 'ph', reported: '6.2', reported_text: '6.2' }]);
    expect(await decided([{ key: 'a', name: 'Density', value: '1.250', unit: 'g/mL', shown: '1.250 g/mL', reported: '1.25 g/mL' },
      { key: 'b', name: 'Viscosity', value: '85', unit: 'mPa·s', shown: '85 mPa·s', reported: '85 mPa·s' },
      { key: 'c', name: 'Appearance', value: '', unit: '', shown: 'Conforms: a clear syrup' },
      { key: 'd', name: 'Water', value: '0.500', unit: '%', shown: '0.500 %', reported: '0.500 %' }]))
      .toEqual([{ test_key: 'a', reported: '1.25', reported_text: '1.25 g/mL' }, { test_key: 'b', reported: '85', reported_text: '85 mPa·s' },
        { test_key: 'c', reported: 'Conforms: a clear syrup', reported_text: 'Conforms: a clear syrup' }, { test_key: 'd', reported: '0.500', reported_text: '0.500 %' }]);
    const [a] = await t.owner<{ analysis_no: string }[]>`select analysis_no from analyses where id = ${aid}`;
    expect(rows).toEqual([{ test_key: 'ph', value: '6.2', passed: true, limit_text: '5.0 to 7.0', analysis_number: a!.analysis_no }]);
    // Once decided: no second decision.
    expect((await decide(sid, 'qcuser', 'reject', { reason: 'second thoughts' })).json().problems).toEqual(['The sample is already approved.']);
  });

  it('an approved sample takes no new analysis and no review of a late one', async () => {
    const msg = 'This sample is already approved. Re-testing goes through an OOS or a new sample.';
    const sid = await sampleOf();
    const late = await analysed(sid, '6.0', false);
    await analysed(sid, '6.2');
    expect((await decide(sid, 'qcuser', 'approve')).statusCode).toBe(200);
    const issue = await as('analyst', 'POST', '/api/analyses', { masterVersionId: method.id, sampleId: sid, proof: proofFor('analyst') });
    expect(issue.statusCode).toBe(409);
    expect(issue.json().problems).toEqual([msg]);
    const a = (await as('reviewer', 'GET', `/api/analyses/${late}`)).json() as { analysis: { contentHash: string } };
    const review = await as('reviewer', 'POST', `/api/analyses/${late}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash });
    expect(review.statusCode).toBe(409);
    expect(review.json().problems).toEqual([msg]);
  });

  it('LIMS-17 a reviewed result out of limits blocks approval; QC rejects with a reason, and no certificate is issued', async () => {
    const sid = await sampleOf();
    await analysed(sid, '7.4');
    const d = await detail(sid);
    // The OOS it opened (test/oos.test.ts) and the result out of limits both stand in the way.
    expect(d.approvalProblems[0]).toMatch(/^OOS\d{6} \(pH\) is open/);
    expect(d.approvalProblems[1]).toMatch(/^pH: 7\.4 is out of limits \(analysis LA\d+\): it is investigated as an OOS result/);
    expect((await decide(sid, 'qcuser', 'approve')).statusCode).toBe(409);
    const r = await decide(sid, 'qcuser', 'reject', { reason: 'pH out of limits, confirmed' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await detail(sid)).decision).toBe('rejected');
    expect((await as('viewer', 'GET', `/api/samples/${sid}/coa`)).statusCode).toBe(404);
    const [coa] = await t.owner.unsafe(`select coa_number, decision, reason from ${t.schema}_report.coa_v1 c join samples s on s.sample_no = c.sample_number where s.id = ${sid}`);
    expect(coa).toEqual({ coa_number: null, decision: 'REJECTED', reason: 'pH out of limits, confirmed' });
  });

  it('LIMS-41 the analyst of a sample cannot approve it, even with the QC permission', async () => {
    const sid = await sampleOf();
    await analysed(sid, '6.0');
    const r = await decide(sid, 'analyst', 'approve');
    expect(r.statusCode).toBe(403);
    expect(r.json().problems[0]).toMatch(/you worked on analysis/);
  });

  it('LIMS-47 the decision is signed over the results as shown: a result reviewed after the page was read is refused as a change', async () => {
    const sid = await sampleOf();
    await analysed(sid, '6.3');
    const stale = (await detail(sid)).decisionHash;
    await analysed(sid, '6.4');
    const r = await as('qcuser', 'POST', `/api/samples/${sid}/approve`, { proof: proofFor('qcuser'), contentHash: stale });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('content_changed');
    expect((await decide(sid, 'qcuser', 'approve')).statusCode).toBe(200);
  });

  it('LIMS-21 the certificate of analysis is issued for an approved sample only, as a PDF', async () => {
    const pdf = await as('viewer', 'GET', `/api/samples/${coaOf}/coa`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('LIMS-43 only QC decides', async () => {
    const sid = await sampleOf();
    expect((await as('sampler', 'POST', `/api/samples/${sid}/approve`, { proof: proofFor('sampler'), contentHash: 'x'.repeat(64) })).statusCode).toBe(403);
    expect((await detail(sid, 'viewer')).approvalProblems).toEqual(['QC approval needs the QC approval permission.']);
  });

  it('LIMS-21 the certificate shows the result as reported: rounded as the limit is written, never the full-precision value', () => {
    expect(reportedFigure('0.32960447463044346783859368757491', '%', { high: '0.5' })).toBe('0.3 %');
    expect(reportedFigure('99.649', '%', { low: '98.0', high: '102.00' })).toBe('99.65 %');
    expect(reportedFigure('6.25', '', { low: '5.0', high: '7.0' })).toBe('6.3');
    expect(reportedFigure('12.3456', 'ppm', undefined)).toBe('12.3456 ppm');
    // A decision kept before `reported` existed: the figure is read from the end of the worked line.
    const shown = 'Loss on drying = (31.1262 g − 31.1229 g) ÷ (31.1262 g − 30.1250 g) × 100 = 0.3296… %; 0.3296… % rounded to 1 decimal (as the limit is written) = 0.3 %; limit not more than 0.5 %';
    expect(resultFigure(shown, '0.3296044746304434678', '%')).toBe('0.3 %');
    expect(resultFigure(shown, '0.3296', '%', '0.3 %')).toBe('0.3 %');
  });

  it('limitText says each limit type plainly', () => {
    const s = spec(1);
    expect(limitText(s.tests[0]!)).toBe('5.0 to 7.0');
    expect(limitText({ ...s.tests[0]!, limitType: 'not more than', limit: { high: '0.5', unit: '%' } })).toBe('NMT 0.5 %');
    expect(limitText({ ...s.tests[0]!, limitType: 'conforms', limit: undefined, conforms: 'Matches the reference' })).toBe('Conforms: Matches the reference');
    expect(limitText({ ...s.tests[0]!, limitType: 'report only', limit: undefined })).toBe('Report');
  });
});
