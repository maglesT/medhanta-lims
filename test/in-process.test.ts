import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, validatedOutside, type TestApp } from './helpers.js';
import { small } from './engine-fixture.js';
import { sampleOnly, specChecks, specSchema, testApplies, type SpecDoc } from '../shared/master/spec.js';
import { figureOf, unitValues } from '../server/routes/analyses.js';
import { requestProblems } from '../server/routes/in-process.js';
import { findBlock } from '../shared/blocks/index.js';

// In-process samples (owner 19 Nov 2026): a TrueBatch step's in-process lab request (lab_request_v1, every edition) is
// picked, never typed; the sample is tested for the in-process specification's tests whose TrueBatch field the request
// names; reviewed and approved as any sample, numbered as an in-process test report (IPR); result_v1 gives the request,
// the TrueBatch field, the individual values (BU, CU) and what the reported figure is.

const PRODUCT = 'prd-ip';
const spec = (bu: { masterId: number }, ph: { masterId: number }, over: object = {}): SpecDoc => specSchema.parse({
  header: { of: 'product', itemId: PRODUCT, code: 'FG-IP1', name: 'Examplol 500 mg tablets', type: 'In-process', number: 'SPEC-IP-FG-IP1', pharmacopoeia: 'In-house', ...over },
  tests: [
    { key: 'bu', name: 'Blend uniformity', method: { masterId: bu.masterId, code: 'BU', name: 'BU method' }, result: 's0/t0/result', limitType: 'range',
      limit: { low: '90.0', high: '110.0', unit: '%' }, use: 'release', ipcField: 'bu' },
    { key: 'ph', name: 'pH of the granules', method: { masterId: ph.masterId, code: 'PH', name: 'PH method' }, result: 's0/t0/readingCheck', limitType: 'range',
      limit: { low: '5.0', high: '7.0', unit: '' }, use: 'release', ipcField: 'ph' },
  ],
});

describe('the rules', () => {
  const doc = spec({ masterId: 1 }, { masterId: 2 });
  it('an in-process sample is tested for the tests whose TrueBatch field its request names; every test of an in-process specification names its field once', () => {
    expect(sampleOnly(doc, { request: { tests: [{ name: 'bu' }] } })).toEqual(['bu']);
    expect(sampleOnly(doc, { monitoring: { testKey: 'ph' } })).toEqual(['ph']);
    expect(sampleOnly(doc, {})).toBeUndefined();
    expect(testApplies(doc.tests[1]!, 'in_process', ['bu'])).toBe(false);
    const noField = { ...doc, tests: doc.tests.map((t, i) => (i === 1 ? { ...t, ipcField: undefined } : t)) };
    expect(specChecks(noField, () => null).map((p) => p.message)).toContain('pH of the granules: name the TrueBatch in-process field this test answers');
    const twice = { ...doc, tests: doc.tests.map((t) => ({ ...t, ipcField: 'bu' })) };
    expect(specChecks(twice, () => null).map((p) => p.message)).toContain('pH of the granules: the TrueBatch field bu is answered by two tests');
  });
  it('a request is tested only while open, against an effective in-process specification that has a test for each of its fields', () => {
    const r = { edition: 'truebatch' as const, requestId: 'B1/blend', batchNo: 'B1', productCode: 'FG-IP1', stageTitle: 'Blending', stepKey: 'blend', stepTitle: 'Blend uniformity',
      tests: [{ name: 'bu', label: 'Blend uniformity', unit: '%', individual: 10 }], requestedAt: '2026-11-19T06:00:00Z', status: 'open' };
    expect(requestProblems(r, doc)).toEqual([]);
    expect(requestProblems({ ...r, status: 'cancelled' }, doc)).toEqual(['Request B1/blend is cancelled in TrueBatch: only an open request is tested.']);
    expect(requestProblems(r, null)).toEqual(['No effective in-process specification for FG-IP1: QA makes one effective first.']);
    expect(requestProblems({ ...r, tests: [...r.tests, { name: 'lod', label: 'LOD', unit: '%', individual: null }] }, doc))
      .toEqual(['Specification SPEC-IP-FG-IP1 has no test for LOD (lod): add it in a new version.']);
  });
  it('individual values come from the block\'s unit fields in order (10, or 30 after the second stage); the figure is the AV of CU, the mean of BU', () => {
    const cu = findBlock({ id: 'content-uniformity', version: 1 })!;
    const v = (xs: string[]) => xs.map((x) => ({ value: x, unit: '%' }));
    const ok = { ok: true as const, value: '4.2', unit: '', shown: '' };
    expect(unitValues(cu, { results: v(['99.1', '100.2']), moreResults: v(['98.7']) }, ok)).toEqual(['99.1', '100.2', '98.7']);
    expect(unitValues(cu, {}, ok)).toBeNull();
    expect(figureOf(cu, 'acceptance')).toBe('AV');
    expect(figureOf(findBlock({ id: 'blend-uniformity', version: 1 }), 'result')).toBe('mean');
    expect(figureOf(findBlock({ id: 'check', version: 1 }), 'readingCheck')).toBe('result');
    // Weight variation: the contents T14 works out, to 1 decimal.
    expect(unitValues(findBlock({ id: 'uniformity-by-weight', version: 1 })!, {}, { ...ok, contents: ['99.14', '100.25'] } as never)).toEqual(['99.1', '100.3']);
  });
});

let t: TestApp;
let provider: Sql;
const S = { tb: '', lq: '' };
const cookies: Record<string, string> = {};
const requests = (schema: string) => `create table ${schema}.lab_request_v1 (request_id text, batch_no text, product_code text, stage_title text, step_key text,
  step_title text, tests jsonb, requested_at timestamptz, status text);`;
beforeAll(async () => {
  t = await freshApp(async (db) => {
    S.tb = `${db.schema}_tb`; S.lq = `${db.schema}_lq`;
    await db.owner.unsafe(`create schema ${S.tb}; create schema ${S.lq}; ${requests(S.tb)} ${requests(S.lq)}
      insert into ${S.tb}.lab_request_v1 values
        ('B26101/blend', 'B26101', 'FG-IP1', 'Blending', 'blend', 'Blend uniformity', '[{"name":"bu","label":"Blend uniformity","unit":"%","individual":10}]', now() - interval '1 hour', 'open'),
        ('B26101/lub', 'B26101', 'FG-IP1', 'Blending', 'lub', 'Lubrication', '[{"name":"lod","label":"LOD of the blend","unit":"%","individual":null}]', now() - interval '30 minutes', 'open'),
        ('B26100/blend', 'B26100', 'FG-IP1', 'Blending', 'blend', 'Blend uniformity', '[{"name":"bu","label":"Blend uniformity","unit":"%","individual":10}]', now() - interval '2 days', 'done');
      insert into ${S.lq}.lab_request_v1 values
        ('TL260004/bulk', 'TL260004', 'FG-IP1', 'Bulk', 'bulk', 'Bulk test', '[{"name":"ph","label":"pH","unit":null,"individual":null}]', now() - interval '10 minutes', 'open');
      grant usage on schema ${S.tb}, ${S.lq} to lims_app; grant select on all tables in schema ${S.tb}, ${S.lq} to lims_app;`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ truebatch: provider, truebatch_liquids: provider }, { truebatch: S.tb, truebatch_liquids: S.lq });
  });
  t.master.products_.push({ itemId: PRODUCT, code: 'FG-IP1', name: 'Examplol 500 mg tablets', version: 1, active: true, strength: '500 mg', dosageForm: 'tablet' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    analyst: ['lims.analysis.perform', 'lims.view'], reviewer: ['lims.analysis.review', 'lims.view'], qcuser: ['lims.qc.approve', 'lims.view'], sampler: ['lims.sample.register'],
    viewer: ['lims.view'] } as const;
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
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-100' }]] as const) {
    const res = await as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hash(who), ...x });
    expect(res.statusCode, `${a}: ${res.body}`).toBe(200);
  }
  if (kind === 'method') await validatedOutside(t.owner, v.id);
  expect((await as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
  return v;
}
const buMethod = () => {
  const d = small([{ role: 'Analyst', steps: [{ key: 't0', block: { id: 'blend-uniformity', version: 1 }, checker: false,
    settings: { limit: { spec: 'limit' }, rsdLimit: { high: '5.0', unit: '%' }, individualLimit: { low: '85.0', high: '115.0', unit: '%' } } }] }]);
  d.header.code = 'BU'; d.header.name = 'BU method';
  return d;
};
const phMethod = () => {
  const d = small([{ role: 'Analyst', steps: [{ key: 't0', settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
  d.header.code = 'PH'; d.header.name = 'PH method';
  return d;
};
async function analysed(sampleId: number, m: { id: number }, values: Record<string, unknown>) {
  const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: m.id, sampleId, proof: proofFor('analyst') });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  expect((await step('start')).statusCode).toBe(200);
  const rec = await step('record', { values });
  expect(rec.statusCode, rec.body).toBe(200);
  const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] };
  const done = await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash });
  expect(done.statusCode, done.body).toBe(200);
  const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
  expect((await as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash })).statusCode).toBe(200);
}
type Detail = { decisionHash: string; approvalProblems: string[]; sample: { purpose: string; request: { requestId: string } | null }; spec: { tests: { key: string; applies: boolean }[] } };
const detail = async (id: number) => (await as('qcuser', 'GET', `/api/samples/${id}`)).json() as Detail;

describe('on the server', () => {
  const bu = { id: 0, masterId: 0 };
  const ph = { id: 0, masterId: 0 };
  beforeAll(async () => {
    Object.assign(bu, await effective('method', buMethod()));
    Object.assign(ph, await effective('method', phMethod()));
    await effective('spec', spec(bu, ph));
  });

  it('the open requests of every edition, oldest first, each with its specification or why it cannot be tested', async () => {
    expect((await as('viewer', 'GET', '/api/lab-requests')).statusCode).toBe(403);
    const r = (await as('analyst', 'GET', '/api/lab-requests')).json() as { link: string; requests: { requestId: string; editionName: string; spec: { number: string } | null; problems: string[] }[] };
    expect(r.link).toBe('ok');
    expect(r.requests.map((x) => [x.requestId, x.editionName, x.spec?.number, x.problems])).toEqual([
      ['B26101/blend', 'TrueBatch Tablets', 'SPEC-IP-FG-IP1', []],
      ['B26101/lub', 'TrueBatch Tablets', 'SPEC-IP-FG-IP1', ['Specification SPEC-IP-FG-IP1 has no test for LOD of the blend (lod): add it in a new version.']],
      ['TL260004/bulk', 'TrueBatch Liquids', 'SPEC-IP-FG-IP1', []]]);
  });

  it('a picked request makes the in-process sample (nothing typed), once; tested for its fields only; QC approves an in-process test report; result_v1 gives the request, field, individual values and figure', async () => {
    // Never registered as an ordinary sample, never for a request that cannot be tested, never twice.
    expect((await as('sampler', 'POST', '/api/samples', { source: 'truebatch', batchNumber: 'B26101', specVersionId: 1, quantity: '10 g', purpose: 'in_process' })).statusCode).toBe(400);
    expect((await as('analyst', 'POST', '/api/samples/in-process', { edition: 'truebatch', requestId: 'B26100/blend', quantity: '10 g' })).json().problems)
      .toEqual(['Request B26100/blend is done in TrueBatch: only an open request is tested.']);
    expect((await as('analyst', 'POST', '/api/samples/in-process', { edition: 'truebatch', requestId: 'B26101/lub', quantity: '10 g' })).statusCode).toBe(409);
    const r = await as('analyst', 'POST', '/api/samples/in-process', { edition: 'truebatch', requestId: 'B26101/blend', quantity: '10 unit doses' });
    expect(r.statusCode, r.body).toBe(200);
    const sid = (r.json() as { id: number }).id;
    expect((await as('analyst', 'POST', '/api/samples/in-process', { edition: 'truebatch', requestId: 'B26101/blend', quantity: '10 g' })).json().problems[0]).toMatch(/already has its sample LS\d{7}/);
    const d = await detail(sid);
    expect(d.sample).toMatchObject({ purpose: 'in_process', request: { requestId: 'B26101/blend' } });
    expect(d.spec.tests.map((x) => [x.key, x.applies])).toEqual([['bu', true], ['ph', false]]);
    expect((await as('sampler', 'POST', `/api/samples/${sid}/receive`, { condition: 'Thief samples, 10 locations' })).statusCode).toBe(200);
    // The pH method does none of this sample's tests.
    expect((await as('analyst', 'POST', '/api/analyses', { masterVersionId: ph.id, sampleId: sid, proof: proofFor('analyst') })).statusCode).toBe(409);
    const values = ['99.8', '101.2', '98.9', '100.4', '99.5', '100.9', '98.7', '101.0', '99.9', '100.3'];
    await analysed(sid, bu, { results: values });
    expect((await detail(sid)).approvalProblems).toEqual([]);
    const ok = await as('qcuser', 'POST', `/api/samples/${sid}/approve`, { proof: proofFor('qcuser'), contentHash: (await detail(sid)).decisionHash });
    expect(ok.statusCode, ok.body).toBe(200);
    const no = (ok.json() as { coaNo: string }).coaNo;
    expect(no).toMatch(/^IPR\d{7}$/);
    const [coa] = await t.owner.unsafe(`select purpose, request_id from ${t.schema}_report.coa_v1 where coa_number = '${no}'`);
    expect(coa).toEqual({ purpose: 'in_process', request_id: 'B26101/blend' });
    const rows = await t.owner.unsafe(`select test_key, reported, request_id, purpose, individual_values::text[] as individual, figure, ipc_field from ${t.schema}_report.result_v1 where coa_number = '${no}'`);
    expect(rows).toEqual([{ test_key: 'bu', reported: '100.1', request_id: 'B26101/blend', purpose: 'in_process', individual: values, figure: 'mean', ipc_field: 'bu' }]);
    // sample_v1 (MMS D-77): the sample with its quantity split into a number and its unit, who took it, and its status.
    const [sv] = await t.owner.unsafe(`select sample_number, lot_number, item_kind, purpose, quantity::text, unit, sampled_by, status, request_id from ${t.schema}_report.sample_v1 where request_id = 'B26101/blend'`);
    expect(sv).toMatchObject({ lot_number: 'B26101', item_kind: 'PRODUCT', purpose: 'in_process', quantity: '10', unit: 'unit doses', sampled_by: 'ANALYST', status: 'decided', request_id: 'B26101/blend' });
  });

  it('a request of another edition (TrueBatch Liquids) makes its sample the same way', async () => {
    const r = await as('analyst', 'POST', '/api/samples/in-process', { edition: 'truebatch_liquids', requestId: 'TL260004/bulk', quantity: '100 mL' });
    expect(r.statusCode, r.body).toBe(200);
    const d = await detail((r.json() as { id: number }).id);
    expect(d.spec.tests.map((x) => [x.key, x.applies])).toEqual([['bu', false], ['ph', true]]);
    // A release sample's result row has no request and the plain figure.
    const [n] = await t.owner.unsafe(`select count(*)::int as n from ${t.schema}_report.result_v1 where purpose = 'in_process'`);
    expect(n!.n).toBe(1);
  });
});
