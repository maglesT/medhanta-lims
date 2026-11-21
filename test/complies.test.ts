import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp, validatedOutside } from './helpers.js';
import { small } from './engine-fixture.js';
import { l35Complies } from '../shared/templates/index.js';
import { applySpec, limitText, specChecks, specSchema, type SpecDoc } from '../shared/master/spec.js';
import { resultFigure } from '../server/coa.js';

// Complies / does not comply (owner 21 Nov 2026): a description, identification or visual-check test whose result is a
// word, not a number. The spec test is a conforms test; the analyst picks the answer; "Does not comply" is an OOS; the
// certificate prints "Complies".
describe('the Complies template and block', () => {
  it('L35 the answer is the result: Complies passes, Does not comply fails; anything else is refused', () => {
    const ok = l35Complies({ answer: 'Complies', what: 'Description', requirement: 'White, round tablets' });
    expect(ok).toMatchObject({ ok: true, text: 'Complies', unit: '', check: { pass: true }, shown: 'Description: Complies (must show: White, round tablets)' });
    expect(l35Complies({ answer: 'Does not comply', what: 'Description' })).toMatchObject({ ok: true, text: 'DOES NOT COMPLY', check: { pass: false, level: 'fail' } });
    expect(l35Complies({ answer: 'maybe' })).toMatchObject({ ok: false });
  });

  it('the spec gives the requirement in its own words; only a conforms test takes a Complies result', () => {
    const m = method();
    const t = { key: 'desc', name: 'Description', method: { masterId: 1, code: 'M', name: 'M' }, result: 's0/look/result', limitType: 'conforms', conforms: 'White, round, biconvex tablets', values: {}, use: 'release' } as never;
    expect(applySpec(m, t).stages[0]!.steps[0]!.settings.conforms).toBe('White, round, biconvex tablets');
    const doc = (test: object) => specSchema.parse({ header: { of: 'material', itemId: 'm1', code: 'RM-1', name: 'Demolol', type: 'Active substance', number: 'SPEC-RM-1', pharmacopoeia: 'Ph. Int.', sampling: { plan: 'square root' } }, tests: [test] });
    const methods = () => ({ doc: m, state: 'effective' });
    expect(specChecks(doc({ ...(t as object) }), methods).filter((p) => p.level === 'error')).toEqual([]);
    expect(specChecks(doc({ ...(t as object), limitType: 'not more than', conforms: undefined, limit: { high: '0', unit: '' } }), methods).map((p) => p.message))
      .toContain('Description: method M gives Complies or Does not comply, with no number: make it a conforms test');
    expect(limitText({ ...(t as object) } as never)).toBe('Conforms: White, round, biconvex tablets');
    expect(resultFigure('Complies', '', '')).toBe('Complies');
    // A uniformity acceptance value has no unit, whatever unit its limit was typed with.
    expect(limitText({ result: 's0/cu/acceptance', limitType: 'not more than', limit: { high: '15.0', unit: 'nos' } } as never)).toBe('AV NMT 15.0');
  });
});

const method = () => small([{ role: 'Analyst', steps: [{ key: 'look', block: { id: 'complies', version: 1 }, settings: { what: 'Description', conforms: { spec: 'conforms' } } }] }]);

let t: TestApp;
const cookies: Record<string, string> = {};
const MAT = '00000000-0000-0000-0000-0000000000c5';
beforeAll(async () => {
  t = await freshApp();
  t.master.materials_.push({ itemId: MAT, code: 'RM-035', name: 'Demolol', version: 1, active: true, category: 'API', unit: 'kg' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register', 'lims.view'], sampler2: ['lims.sample.register'], analyst: ['lims.analysis.perform', 'lims.view'],
    reviewer: ['lims.analysis.review'], qcuser: ['lims.qc.approve', 'lims.view'] } as const;
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
let m = { id: 0, masterId: 0 };
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
async function analysed(sampleId: number, answer: string) {
  const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: m.id, sampleId, proof: proofFor('analyst') });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  expect((await step('start')).statusCode).toBe(200);
  expect((await step('record', { values: { answer } })).statusCode).toBe(200);
  if (answer !== 'Complies') expect((await step('note', { text: 'Yellow specks seen' })).statusCode).toBe(200);
  const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string; results: Record<string, { shown: string }> }[] };
  expect(d.steps[0]!.results.result!.shown).toBe(`Description: ${answer === 'Complies' ? 'Complies' : 'DOES NOT COMPLY'} (must show: White, round tablets)`);
  const done = await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash });
  expect(done.statusCode, done.body).toBe(200);
  const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
  const res = await as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

describe('a Complies test on the server', () => {
  beforeAll(async () => {
    m = await effective('method', method());
    const spec: SpecDoc = specSchema.parse({
      header: { of: 'material', itemId: MAT, code: 'RM-035', name: 'Demolol', type: 'Active substance', number: 'SPEC-RM-035', pharmacopoeia: 'Ph. Int.', sampling: { plan: 'square root' } },
      tests: [{ key: 'desc', name: 'Description', method: { masterId: m.masterId, code: 'M', name: 'M' }, result: 's0/look/result', limitType: 'conforms', conforms: 'White, round tablets' }],
    });
    specId = (await effective('spec', spec)).id;
  });

  it('Complies: QC approves; the certificate and result_v1 give "Complies", with no number', async () => {
    const sid = await sampleOf();
    await analysed(sid, 'Complies');
    const d = (await as('qcuser', 'GET', `/api/samples/${sid}`)).json() as { approvalProblems: string[]; decisionHash: string };
    expect(d.approvalProblems).toEqual([]);
    const r = await as('qcuser', 'POST', `/api/samples/${sid}/approve`, { proof: proofFor('qcuser'), contentHash: d.decisionHash });
    expect(r.statusCode, r.body).toBe(200);
    const coaNo = (r.json() as { coaNo: string }).coaNo;
    const [row] = await t.owner.unsafe(`select value::text, reported, passed, limit_text from ${t.schema}_report.result_v1 where coa_number = '${coaNo}'`);
    expect(row).toMatchObject({ value: null, reported: 'Complies', passed: true, limit_text: 'Conforms: White, round tablets' });
    const pdf = await as('qcuser', 'GET', `/api/samples/${sid}/coa`);
    expect(pdf.statusCode).toBe(200);
  });

  it('Does not comply: an OOS opens, as for a number out of its limit; the sample cannot be approved', async () => {
    const sid = await sampleOf();
    await analysed(sid, 'Does not comply');
    const [o] = await t.owner<{ result: { shown: string; value: string } }[]>`select result from oos where sample_id = ${sid}`;
    expect(o?.result).toMatchObject({ shown: 'DOES NOT COMPLY', value: '' });
    const d = (await as('qcuser', 'GET', `/api/samples/${sid}`)).json() as { approvalProblems: string[] };
    expect(d.approvalProblems.join(' ')).toMatch(/DOES NOT COMPLY|OOS/);
  });
});
