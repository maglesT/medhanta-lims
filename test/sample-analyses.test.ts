import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';
import { small } from './engine-fixture.js';
import { specSchema, testsFor, type SpecDoc } from '../shared/master/spec.js';

// An analysis made for a sample (build step 3, round 4): the sample must be in QC; the analysis covers the tests of the
// sample's effective specification done by its method for the sample's purpose, and runs the method with the spec's
// limits in place (release or shelf life); the sample shows each test's analyses and results (LIMS-11, LIMS-17).

let t: TestApp;
const cookies: Record<string, string> = {};
const MAT = '00000000-0000-0000-0000-00000000000a';
beforeAll(async () => {
  t = await freshApp();
  t.master.materials_.push({ itemId: MAT, code: 'RM-012', name: 'Examplol', version: 1, active: true, category: 'API', unit: 'kg' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register', 'lims.view'], sampler2: ['lims.sample.register'], analyst: ['lims.analysis.perform', 'lims.view'], viewer: ['lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(() => t.close());

const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
const hash = async (id: number, who: string) => ((await as(who, 'GET', `/api/master-versions/${id}/review`)).json() as { contentHash: string }).contentHash;
const act = async (who: string, id: number, action: string, extra: object = {}) =>
  as(who, 'POST', `/api/master-versions/${id}/${action}`, { proof: proofFor(who), contentHash: await hash(id, who), ...extra });
async function effective(kind: 'method' | 'spec', doc: object) {
  const r = await as('author', 'POST', '/api/masters', { kind, doc });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number; masterId: number };
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-001' }]] as const) {
    const res = await act(who, v.id, a, x);
    expect(res.statusCode, `${a}: ${res.body}`).toBe(200);
  }
  expect((await as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
  return v;
}

// A pH method whose limit the specification gives, and one for water.
const phMethod = () => small([{ role: 'Analyst', steps: [{ key: 'ph', block: { id: 'check', version: 1 }, settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
const waterMethod = () => small([{ role: 'Analyst', steps: [{ key: 'water', block: { id: 'check', version: 1 }, settings: { what: 'Water', unit: '%', limit: { spec: 'limit' } } }] }]);
const spec = (ph: number, water: number): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: MAT, code: 'RM-012', name: 'Examplol', type: 'Active substance', number: 'SPEC-RM-012', pharmacopoeia: 'Ph. Int.' },
  tests: [
    { key: 'ph', name: 'pH', method: { masterId: ph, code: 'M', name: 'M' }, result: 's0/ph/readingCheck', limitType: 'release and shelf life',
      limit: { low: '5.0', high: '7.0', unit: '' }, shelfLifeLimit: { low: '4.5', high: '7.5', unit: '' } },
    { key: 'water', name: 'Water', method: { masterId: water, code: 'M', name: 'M' }, result: 's0/water/readingCheck', limitType: 'not more than',
      limit: { high: '0.5', unit: '%' }, use: 'release' },
  ],
});
let methods: { ph: { id: number; masterId: number }; water: { id: number; masterId: number } };

/** A sample of the spec, typed by hand (MMS is not linked here), checked by a second person; received unless told not. */
async function sampleOf(specVersionId: number, purpose = 'release', receive = true) {
  const r = await as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: `RM-${Math.random().toString(36).slice(2, 8)}`, byHand: true, itemId: MAT,
    specVersionId, quantity: '50 g', purpose });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  expect((await as('sampler2', 'POST', `/api/samples/${id}/check`, {})).statusCode).toBe(200);
  if (receive) expect((await as('sampler', 'POST', `/api/samples/${id}/receive`, { condition: 'Sealed' })).statusCode).toBe(200);
  return id;
}
const start = (versionId: number, sampleId?: number) => as('analyst', 'POST', '/api/analyses', { masterVersionId: versionId, proof: proofFor('analyst'), ...(sampleId ? { sampleId } : {}) });
const detail = async (id: number) => (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as {
  sample: { sampleNo: string; tests: { key: string }[] } | null; master: { doc: { stages: { steps: { settings: Record<string, unknown> }[] }[] } };
  steps: { id: string; contentHash: string; results: Record<string, { check?: { pass: boolean } }> }[];
};
const step = (id: number, key: string, action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/${key}/${action}`, body);

describe('analyses of a sample', () => {
  let specId = 0;
  beforeAll(async () => {
    methods = { ph: await effective('method', phMethod()), water: await effective('method', waterMethod()) };
    specId = (await effective('spec', spec(methods.ph.masterId, methods.water.masterId))).id;
  });

  it('testsFor: the tests a method does for a purpose (release tests, or stability tests)', () => {
    const s = spec(1, 2);
    expect(testsFor(s, 1, 'release').map((x) => x.key)).toEqual(['ph']);
    expect(testsFor(s, 2, 'release').map((x) => x.key)).toEqual(['water']);
    expect(testsFor(s, 2, 'stability')).toEqual([]);
  });

  it('LIMS-07 an analysis starts only once QC has received the sample', async () => {
    const id = await sampleOf(specId, 'release', false);
    const r = await start(methods.ph.id, id);
    expect(r.statusCode).toBe(409);
    expect(r.json().problems[0]).toMatch(/is registered: it is tested once QC has received it/);
  });

  it('LIMS-01 LIMS-17 the analysis covers the spec test of its method, and checks its result against the spec\'s release limit', async () => {
    const sid = await sampleOf(specId);
    const r = await start(methods.ph.id, sid);
    expect(r.statusCode, r.body).toBe(200);
    const { id, analysisNo } = r.json() as { id: number; analysisNo: string };
    expect(analysisNo).toMatch(/^LA\d{7}$/);
    const d = await detail(id);
    expect(d.sample?.tests.map((x) => x.key)).toEqual(['ph']);
    expect(d.master.doc.stages[0]!.steps[0]!.settings.limit).toEqual({ low: '5.0', high: '7.0', unit: '' });
    expect((await step(id, '0.1.0.1', 'start')).statusCode).toBe(200);
    expect((await step(id, '0.1.0.1', 'record', { values: { reading: '7.2' } })).statusCode).toBe(200);
    expect((await detail(id)).steps[0]!.results.readingCheck!.check!.pass).toBe(false);
    // The sample shows the test, its analysis and its result.
    const s = (await as('viewer', 'GET', `/api/samples/${sid}`)).json() as { spec: { tests: { key: string; applies: boolean; analyses: { analysisNo: string }[] }[] }; methods: { masterId: number }[] };
    expect(s.spec.tests.map((x) => [x.key, x.applies, x.analyses.map((a) => a.analysisNo)])).toEqual([['ph', true, [analysisNo]], ['water', true, []]]);
    expect(s.methods.map((m) => m.masterId).sort()).toEqual([methods.ph.masterId, methods.water.masterId].sort());
  });

  it('LIMS-17 a stability sample is checked against the shelf-life limit, and only by the tests that apply on stability', async () => {
    const sid = await sampleOf(specId, 'stability');
    const r = await start(methods.ph.id, sid);
    const { id } = r.json() as { id: number };
    expect((await detail(id)).master.doc.stages[0]!.steps[0]!.settings.limit).toEqual({ low: '4.5', high: '7.5', unit: '' });
    const w = await start(methods.water.id, sid);
    expect(w.statusCode).toBe(409);
    expect(w.json().problems[0]).toMatch(/has no stability test done by method M/);
    const s = (await as('viewer', 'GET', `/api/samples/${sid}`)).json() as { spec: { tests: { key: string; applies: boolean }[] }; methods: { masterId: number }[] };
    expect(s.spec.tests.map((x) => [x.key, x.applies])).toEqual([['ph', true], ['water', false]]);
    expect(s.methods.map((m) => m.masterId)).toEqual([methods.ph.masterId]);
  });

  it('LIMS-48 an analysis without a sample is trial work: it names no sample and covers no test', async () => {
    const r = await start(methods.ph.id);
    expect(r.statusCode).toBe(200);
    const d = await detail((r.json() as { id: number }).id);
    expect(d.sample).toBeNull();
    // Its limit is the method's own: the spec's value is not there, so the check waits.
    expect(d.master.doc.stages[0]!.steps[0]!.settings.limit).toEqual({ spec: 'limit' });
  });

  it('a sample that does not exist is refused', async () => {
    const r = await start(methods.ph.id, 999999);
    expect(r.statusCode).toBe(404);
  });
});
