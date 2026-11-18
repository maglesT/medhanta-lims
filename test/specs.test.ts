import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';
import { method, placed } from './engine-fixture.js';
import { applySpec, limitFor, resultsOf, specChecks, specNames, specSchema, type SpecDoc, type SpecTest } from '../shared/master/spec.js';
import type { MasterDoc } from '../shared/master/schema.js';
import { evaluate } from '../shared/engine/index.js';

// Specifications (LIMS-01): a list of tests, each by a method with a limit of a type from a fixed list; versioned,
// checked and approved as methods; the effective version's values go into the method before an analysis runs.

// The fixture method with its assay limit and the standard's target left to the specification.
function assayMethod(): MasterDoc {
  const d = placed(method());
  const result = d.stages[3]!.steps.find((t) => t.key === 'result')!;
  result.settings.limit = { spec: 'limit' };
  d.stages[0]!.steps.find((t) => t.key === 'weigh-std')!.settings.target = { spec: 'standardMass' };
  return d;
}
const test1 = (over: Partial<SpecTest> = {}): SpecTest => ({
  key: 'assay', name: 'Assay', method: { masterId: 7, code: 'QC-M-001', name: 'Examplol assay by HPLC' }, result: 'drying/lod/constant',
  limitType: 'range', limit: { low: '95.0', high: '105.0', unit: '%' }, values: { standardMass: '50.0 mg' }, use: 'release and stability', ...over,
});
const spec = (tests: SpecTest[]): SpecDoc => specSchema.parse({
  header: { of: 'product', itemId: 'prd-1', code: 'FG-001', name: 'Examplol 500 mg tablets', type: 'Finished product', number: 'SPEC-FG-001', pharmacopoeia: 'Ph. Int.', edition: '2025' },
  tests,
});
const lookup = (doc: MasterDoc | null) => () => (doc ? { doc, state: 'effective' } : null);

describe('specification checks (LIMS-01)', () => {
  it('LIMS-01 a complete specification passes; the method asks for "limit" and "standardMass", the test gives both', () => {
    expect(specNames(assayMethod()).map((x) => x.name)).toEqual(['standardMass', 'limit']);
    expect(resultsOf(assayMethod()).map((r) => r.ref)).toContain('drying/lod/constant');
    // Results inside a replicate stage are not offered: one test has one reportable result.
    expect(resultsOf(assayMethod()).some((r) => r.ref.startsWith('sample/'))).toBe(false);
    expect(specChecks(spec([test1()]), lookup(assayMethod()))).toEqual([]);
  });

  it('LIMS-01 each limit type needs its own limit: range both sides, NMT the upper only, NLT the lower only, alert and action an alert, release and shelf life both limits', () => {
    const msg = (t: SpecTest) => specChecks(spec([t]), lookup(assayMethod())).map((p) => p.message);
    expect(msg(test1({ limit: { high: '105.0', unit: '%' } }))).toEqual(['Assay: a range needs both limits']);
    expect(msg(test1({ limitType: 'not more than' }))).toEqual(['Assay: "not more than" needs only the upper limit']);
    expect(msg(test1({ limitType: 'not less than', limit: { low: '80', unit: '%' } }))).toEqual([]);
    expect(msg(test1({ limitType: 'alert and action' }))).toEqual(['Assay: give the action limit and the alert limit']);
    expect(msg(test1({ limitType: 'alert and action', limit: { low: '95.0', high: '105.0', alertLow: '97.0', unit: '%' } }))).toEqual([]);
    expect(msg(test1({ limitType: 'release and shelf life' }))).toEqual(['Assay: give the release limit and the shelf-life limit']);
    expect(msg(test1({ limitType: 'release and shelf life', shelfLifeLimit: { low: '90.0', high: '110.0', unit: '%' } }))).toEqual([]);
  });

  it('LIMS-01 a "conforms" test says what the result must show and gives no number; a method that checks a limit cannot serve it', () => {
    const t = test1({ limitType: 'conforms', limit: undefined, conforms: 'The IR spectrum matches the reference spectrum' });
    expect(specChecks(spec([t]), lookup(assayMethod())).map((p) => p.message))
      .toEqual(['Assay: method QC-M-001 checks its result against a limit; a conforms test cannot give one']);
    const noLimit = assayMethod();
    noLimit.stages[3]!.steps.find((x) => x.key === 'result')!.settings.limit = { low: '95.0', high: '105.0', unit: '%' };
    expect(specChecks(spec([t]), lookup(noLimit))).toEqual([]);
    expect(specChecks(spec([{ ...t, conforms: '' }]), lookup(noLimit)).map((p) => p.message)).toEqual(['Assay: say what the result must show, and give no number']);
  });

  it('LIMS-01 a test needs an approved or effective method, a result of that method, and every value the method asks the specification for', () => {
    expect(specChecks(spec([test1()]), lookup(null)).map((p) => p.message)).toEqual(['Assay: method QC-M-001 has no approved or effective version']);
    expect(specChecks(spec([test1({ result: 'run/sst/precision', values: {} })]), lookup(assayMethod())).map((p) => [p.path, p.message])).toEqual([
      ['tests[0].values.standardMass', 'Assay: method QC-M-001 asks the specification for "standardMass" (Standard solution › Weigh)'],
    ]);
    expect(specChecks(spec([test1({ result: 'run/nothing/result' })]), lookup(assayMethod())).map((p) => p.message)).toEqual(['Assay: method QC-M-001 has no result run/nothing/result']);
    expect(specChecks(spec([]), lookup(null)).map((p) => p.message)).toEqual(['The specification has no tests']);
    expect(specChecks(spec([test1(), test1()]), lookup(assayMethod())).map((p) => p.message)).toEqual(['The key assay is used twice']);
  });

  it('LIMS-01 a limit the templates cannot read is refused', () => {
    expect(specChecks(spec([test1({ limit: { low: '105.0', high: '95.0', unit: '%' } })]), lookup(assayMethod())).map((p) => p.message)[0]).toMatch(/^Assay: /);
  });
});

describe('applySpec: the specification fills the method', () => {
  it('LIMS-17 the spec\'s limit and values replace the method\'s { spec } settings; the engine checks the result against the release limit, or the shelf-life limit on stability', () => {
    const t = test1({ limitType: 'release and shelf life', shelfLifeLimit: { low: '90.0', high: '110.0', unit: '%' } });
    const release = applySpec(assayMethod(), t, 'release');
    const k = { stage: 3, sub: 1, step: 3, round: 1 };
    expect(release.stages[3]!.steps[3]!.settings.limit).toEqual({ low: '95.0', high: '105.0', unit: '%' });
    expect(release.stages[0]!.steps[1]!.settings.target).toBe('50.0 mg');
    expect(evaluate(release, [], k, { reading: { value: '93.0', unit: '%' } }).readingCheck).toMatchObject({ ok: true, check: { pass: false } });
    const stability = applySpec(assayMethod(), t, 'stability');
    expect(evaluate(stability, [], k, { reading: { value: '93.0', unit: '%' } }).readingCheck).toMatchObject({ ok: true, check: { pass: true } });
    expect(limitFor(t, 'stability')).toEqual({ low: '90.0', high: '110.0', unit: '%' });
    expect(limitFor(test1(), 'stability')).toEqual({ low: '95.0', high: '105.0', unit: '%' });
  });

  it('a value the spec does not give stays a { spec } setting, and the calculation that needs it waits; a "report only" test leaves the optional limit out', () => {
    const d = applySpec(assayMethod(), test1({ values: {} }));
    expect(d.stages[0]!.steps[1]!.settings.target).toEqual({ spec: 'standardMass' });
    expect(evaluate(d, [], { stage: 0, sub: 1, step: 1, round: 1 }, { mass: { value: '50.1', unit: 'mg' } }).massCheck).toBeUndefined();
    const r = applySpec(assayMethod(), test1({ limitType: 'report only', limit: undefined }));
    expect(r.stages[3]!.steps[3]!.settings.limit).toBeUndefined();
  });

  it('LIMS-17 one method serves two tests: each result step gets the limit of the test whose result it is', () => {
    const d = assayMethod();
    d.stages[2]!.steps.find((x) => x.key === 'temp')!.settings.limit = { spec: 'limit' };
    const assay = test1({ result: 'sample/result/readingCheck' });
    const temp = test1({ key: 'temp', name: 'Column temperature', result: 'run/temp/readingCheck', limit: { low: '25', high: '35', unit: '°C' }, values: {} });
    const both = applySpec(d, [assay, temp]);
    expect(both.stages[3]!.steps.find((x) => x.key === 'result')!.settings.limit).toEqual({ low: '95.0', high: '105.0', unit: '%' });
    expect(both.stages[2]!.steps.find((x) => x.key === 'temp')!.settings.limit).toEqual({ low: '25', high: '35', unit: '°C' });
    expect(both.stages[0]!.steps.find((x) => x.key === 'weigh-std')!.settings.target).toBe('50.0 mg');
  });
});

// ---- On the server: kept, checked and approved as methods ----

let t: TestApp;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  t = await freshApp();
  t.master.products_.push({ itemId: 'prd-1', code: 'FG-001', name: 'Examplol 500 mg tablets', version: 1, active: true, strength: '500 mg', dosageForm: 'tablet' });
  t.master.materials_.push({ itemId: 'mat-old', code: 'RM-009', name: 'Retired material', version: 1, active: false, category: 'API', unit: 'kg' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'], analyst: ['lims.analysis.perform'], viewer: ['lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(() => t.close());

const as = (who: string, m: 'GET' | 'POST' | 'PUT', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
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
  // Typed by hand (no QMS link): another QA person makes it effective.
  expect((await as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
  return v;
}

describe('specifications on the server', () => {
  it('LIMS-01 a specification is written, checked by a second person and approved by QA as a method; it names a product of master data (its code and name as master data has them)', async () => {
    const m = await effective('method', assayMethod());
    const doc = spec([test1({ method: { masterId: m.masterId, code: 'QC-M-001', name: 'Examplol assay by HPLC' } })]);
    const typed = { ...doc, header: { ...doc.header, code: 'TYPED', name: 'Typed name' } };
    const s = await effective('spec', typed);
    const v = (await as('viewer', 'GET', `/api/master-versions/${s.id}`)).json() as { kind: string; state: string; doc: SpecDoc };
    expect(v).toMatchObject({ kind: 'spec', state: 'effective', doc: { header: { code: 'FG-001', name: 'Examplol 500 mg tablets' } } });
    // The lists are apart: methods by default, specifications with ?kind=spec.
    const methods = (await as('viewer', 'GET', '/api/masters')).json() as { kind: string }[];
    const specs = (await as('viewer', 'GET', '/api/masters?kind=spec')).json() as { kind: string; header: { number: string } }[];
    expect(methods.every((x) => x.kind === 'method')).toBe(true);
    expect(specs.map((x) => [x.kind, x.header.number])).toEqual([['spec', 'SPEC-FG-001']]);
    // A new version keeps its kind.
    const nv = (await as('author', 'POST', `/api/masters/${s.masterId}/versions`, {})).json() as { id: number };
    expect(((await as('viewer', 'GET', `/api/master-versions/${nv.id}`)).json() as { kind: string }).kind).toBe('spec');
  });

  it('LIMS-01 a specification with check errors is not sent for review; its method must be approved or effective', async () => {
    const r = await as('author', 'POST', '/api/masters', { kind: 'spec', doc: spec([test1({ method: { masterId: 99999, code: 'QC-M-404', name: 'None' } })]) });
    const { id } = r.json() as { id: number };
    const checks = (await as('author', 'GET', `/api/master-versions/${id}/checks`)).json() as { problems: { message: string }[] };
    expect(checks.problems.map((p) => p.message)).toEqual(['Assay: method QC-M-404 has no approved or effective version']);
    const res = await act('author', id, 'submit');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('master_has_errors');
  });

  it('PL-08 a specification names an active material or product of master data', async () => {
    const doc = spec([]);
    const r = await as('author', 'POST', '/api/masters', { kind: 'spec', doc: { ...doc, header: { ...doc.header, of: 'material', itemId: 'mat-old' } } });
    expect(r.statusCode).toBe(409);
    const nothing = await as('author', 'POST', '/api/masters', { kind: 'spec', doc: { ...doc, header: { ...doc.header, itemId: 'prd-none' } } });
    expect(nothing.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('LIMS-01 an analysis is started from a method, never from a specification', async () => {
    const m = await effective('method', assayMethod());
    const s = await effective('spec', spec([test1({ method: { masterId: m.masterId, code: 'QC-M-001', name: 'Examplol assay by HPLC' } })]));
    const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: s.id, proof: proofFor('analyst') });
    expect(r.statusCode).toBe(409);
    expect(r.json().problems).toEqual(['Only an effective method version can be issued.']);
  });

  it('LIMS-01 the database keeps a version\'s kind', async () => {
    const [v] = await t.owner<{ id: number }[]>`select id::int from master_versions where kind = 'spec' limit 1`;
    await expect(t.owner`update master_versions set kind = 'method' where id = ${v!.id}`).rejects.toThrow(/keeps its identity/);
  });
});
