import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';
import { small } from './engine-fixture.js';
import { approvalProblems, type TestState } from '../shared/engine/sample.js';
import { identityContainers, specSchema, testsForAnalysis, type SpecDoc } from '../shared/master/spec.js';
import { outsideCheckRefusal, outsideEntryRefusal, outsideFigure } from '../shared/engine/outside.js';
import { formRefusal, formState } from '../shared/engine/forms.js';
import { blankFormDoc, labelsDoc } from '../server/labels.js';
import { coaDoc } from '../server/coa.js';
import { render } from '../server/pdf.js';
import { loadSampleRow } from '../server/routes/samples.js';
import { loadForms } from '../server/routes/forms.js';
import { loadAnalysis, recordInput } from '../server/routes/analyses.js';
import { analysisRecordDoc } from '../server/analysis-record.js';
import { reportedFigure } from '../server/routes/samples.js';
import { c1WithinLimits } from '../shared/templates/index.js';
import { itemStatus, registerProblems, ITEM_KIND_NAME } from '../shared/engine/items.js';

// The register rules closed in build step 8c: sample labels (LIMS-06), the identity of each container of a starting
// material (LIMS-08), no supplier certificate in place of a test (LIMS-09), outside (contract) lab results (LIMS-22),
// records kept and readable (LIMS-52) and the paper fallback (LIMS-54).

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
  const footer = typeof def.footer === 'function' ? def.footer(1, 1, { width: 0, height: 0 } as never) : def.footer;
  return [def.header, ...(def.content as Content[]), footer].map(walk).join('\n');
}

// ---- The rules (pure functions) ----
const MAT = '00000000-0000-0000-0000-0000000000a8';
const specOf = (type: string, identity = true): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: MAT, code: 'RM-080', name: 'Demolactose', type, number: 'SPEC-RM-080', pharmacopoeia: 'Ph. Int.' },
  tests: [
    { key: 'ph', name: 'pH', method: { masterId: 1, code: 'PH', name: 'pH' }, result: 's0/t0/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' } },
    { key: 'id', name: 'Identity (IR)', method: { masterId: 2, code: 'IR', name: 'IR' }, result: 's0/t0/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' }, ...(identity ? { identity: true } : {}) },
    { key: 'look', name: 'Appearance', method: { masterId: 3, code: 'AP', name: 'Appearance' }, result: 's0/t0/observation', limitType: 'conforms', conforms: 'A white powder' },
  ],
});

describe('the rules', () => {
  it('LIMS-08 a starting material\'s release sample is identified on each container; a product, a packing material or a retest once', () => {
    expect(identityContainers(specOf('Raw material'), 'release', 5)).toBe(5);
    expect(identityContainers(specOf('Active substance'), 'release', 2)).toBe(2);
    // No number of containers: 0, and registration refuses it.
    expect(identityContainers(specOf('Raw material'), 'release', null)).toBe(0);
    expect(identityContainers(specOf('Packing material'), 'release', 5)).toBeNull();
    expect(identityContainers(specOf('Raw material'), 'retest', 5)).toBeNull();
    expect(identityContainers(specOf('Raw material', false), 'release', 5)).toBeNull();
  });

  it('LIMS-08 an identity analysis names its container (1 to the containers sampled); the other tests are done without one', () => {
    const s = specOf('Raw material');
    expect(testsForAnalysis(s, 2, 'release', 3, 2)).toMatchObject({ tests: [{ key: 'id' }] });
    expect(testsForAnalysis(s, 2, 'release', 3)).toEqual({ problem: 'Pick the container this identity test is done on (1 to 3): each container of a starting material is identified.' });
    expect(testsForAnalysis(s, 2, 'release', 3, 4)).toEqual({ problem: 'The sample was taken from 3 containers: pick 1 to 3.' });
    expect(testsForAnalysis(s, 1, 'release', 3)).toMatchObject({ tests: [{ key: 'ph' }] });
    expect(testsForAnalysis(s, 1, 'release', 3, 1)).toEqual({ problem: 'This method does no identity test of the sample: start it without a container.' });
    expect(testsForAnalysis(s, 2, 'release', null, 1)).toEqual({ problem: 'This sample is not identified container by container: start the analysis without a container.' });
  });

  it('LIMS-08 approval waits for a reviewed identity result of every container; never a reduced number', () => {
    const ok = { analysisNo: 'LA2600001', hasResult: true, pass: true, people: [5], openDeviations: 0 };
    const t = (missing: number[], of = 3): TestState => ({ key: 'id', name: 'Identity (IR)', applies: true, reviewed: ok, containers: { of, missing } });
    const received = [{ kind: 'received' as const, person: 1, payload: {} }];
    expect(approvalProblems({ registeredBy: 1, byHand: false }, received, [t([2, 3])], 9)).toEqual(['Identity (IR): containers 2, 3 of 3 have no reviewed identity result; each container of a starting material is identified.']);
    expect(approvalProblems({ registeredBy: 1, byHand: false }, received, [t([3])], 9)).toEqual(['Identity (IR): container 3 of 3 has no reviewed identity result; each container of a starting material is identified.']);
    expect(approvalProblems({ registeredBy: 1, byHand: false }, received, [t([], 0)], 9)).toEqual(['Identity (IR): the sample does not say how many containers were sampled; each container of a starting material is identified.']);
    expect(approvalProblems({ registeredBy: 1, byHand: false }, received, [t([])], 9)).toEqual([]);
  });

  it('LIMS-09 no supplier certificate replaces a test: a specification has no reduced-testing option, and every test that applies needs its own reviewed result', () => {
    // MMS publishes no supplier, broker or reduced-testing qualification of a lot, so reduced testing is not offered.
    const doc = specOf('Raw material');
    const withSkip = { ...doc, tests: [{ ...doc.tests[0]!, reducedTesting: true }, ...doc.tests.slice(1)] };
    expect(specSchema.safeParse(withSkip).success).toBe(false);
    expect(specSchema.safeParse({ ...doc, header: { ...doc.header, supplierCertificate: true } }).success).toBe(false);
    const received = [{ kind: 'received' as const, person: 1, payload: {} }];
    expect(approvalProblems({ registeredBy: 1, byHand: false }, received, [{ key: 'ph', name: 'pH', applies: true, reviewed: null }], 9)).toEqual(['pH: no reviewed result yet.']);
    // The identity of a starting material is always done, on every container (LIMS-08).
    expect(identityContainers(doc, 'release', 7)).toBe(7);
  });

  it('LIMS-22 an outside lab\'s result is checked against the limit as the lab\'s own; conforms tests say yes or no; nothing else', () => {
    const s = specOf('Raw material');
    expect(outsideFigure(s.tests[0]!, 'release', { value: '6.24', unit: '' })).toMatchObject({ value: '6.24', pass: true });
    expect(outsideFigure(s.tests[0]!, 'release', { value: '7.05', unit: '' })).toMatchObject({ pass: false });
    expect(outsideFigure(s.tests[2]!, 'release', { conforms: true })).toEqual({ shown: 'Conforms: A white powder', value: '', unit: '', pass: true });
    expect(outsideFigure(s.tests[2]!, 'release', { value: '1' })).toEqual({ problem: 'Appearance: say whether the report finds it conforms (A white powder); a conforms test has no number.' });
    expect(outsideFigure(s.tests[0]!, 'release', { conforms: true })).toEqual({ problem: 'pH: type the result as the report gives it, with its unit.' });
    expect(outsideFigure(s.tests[0]!, 'release', { value: '6.2', unit: '%' })).toHaveProperty('problem');
    expect(outsideEntryRefusal(s.tests[1], true, true, null)).toBe('Identity (IR) is done on each container of the starting material, in this lab.');
    expect(outsideEntryRefusal(undefined, false, false, null)).toBe('That test is not one of this sample\'s specification tests.');
    expect(outsideEntryRefusal(s.tests[0], true, false, 'approved')).toBe('The sample is already approved.');
    expect(outsideCheckRefusal({ enteredBy: 4, checked: false }, 4, null)).toBe('The person who typed the result cannot check it: a second person checks it against the report.');
    expect(outsideCheckRefusal({ enteredBy: 4, checked: true }, 5, null)).toBe('A second person has already checked this result.');
    expect(outsideCheckRefusal({ enteredBy: 4, checked: false }, 5, null)).toBeNull();
  });

  it('LIMS-15 full precision is kept; the result is rounded half up as the limit is written only to compare it and to report it (USP General Notices 7.20)', () => {
    const limit = { low: '98.0', high: '102.0', unit: '%' };
    const at = (v: string) => c1WithinLimits({ value: { value: v, unit: '%' }, limit });
    expect(at('102.04')).toMatchObject({ check: { pass: true, rounded: '102.0 %' } });
    expect(at('102.05')).toMatchObject({ check: { pass: false, rounded: '102.1 %' } });
    expect(at('97.95')).toMatchObject({ check: { pass: true, rounded: '98.0 %' } });
    expect(at('97.94')).toMatchObject({ check: { pass: false } });
    // The worked line says how it was rounded; the value passed on keeps every digit.
    expect(String((at('101.96666') as { value: unknown }).value)).toBe('101.96666');
    expect((at('102.04') as { shown: string }).shown).toBe('102.040 % rounded to 1 decimal (as the limit is written) = 102.0 %; limit 98.0 to 102.0 %: within limits');
    expect(reportedFigure('99.95', '%', limit)).toBe('100.0 %');
    expect(reportedFigure('99.94999', '%', limit)).toBe('99.9 %');
  });

  it('LIMS-39 lab animals, where a site uses them: identified (species, own tag, supplier), kept suitable (blocked when not), their checks and uses written as entries', () => {
    expect(ITEM_KIND_NAME.animal).toBe('Lab animal');
    expect(registerProblems('animal', { name: 'Rabbit' }, [], '2026-11-18')).toEqual([
      'Organism: please give it.', 'Animal identification (ear tag or tattoo): please give it.', 'Supplier: please give it.']);
    expect(registerProblems('animal', { name: 'Rabbit', organism: 'Rabbit (New Zealand White)', tag: 'R-117', supplier: 'Demo Breeders' }, [], '2026-11-18')).toEqual([]);
    const item = { kind: 'animal' as const, facts: { name: 'Rabbit', organism: 'Rabbit', tag: 'R-117', supplier: 'Demo Breeders' }, registeredBy: 1, day: '2026-11-01' };
    expect(itemStatus(item, [], '2026-11-18').usable).toBe(true);
    const unwell = [{ id: 1, kind: 'blocked' as const, payload: { reason: 'weight loss at the weekly health check' }, person: 2, day: '2026-11-10' }];
    expect(itemStatus(item, unwell, '2026-11-18')).toMatchObject({ usable: false, why: ['blocked: weight loss at the weekly health check'] });
  });

  it('LIMS-54 a blank worksheet comes back once: used into an analysis of its sample by its method, unused, or voided with a reason', () => {
    const form = { methodMasterId: 2, methodCode: 'IR' };
    const analyses = [{ analysisNo: 'LA2600010', methodMasterId: 2 }, { analysisNo: 'LA2600011', methodMasterId: 1 }];
    expect(formState(null)).toBe('issued');
    expect(formRefusal('return', null, { outcome: 'used', analysisNo: 'LA2600010' }, form, analyses)).toBeNull();
    expect(formRefusal('return', null, { outcome: 'used', analysisNo: 'LA2600011' }, form, analyses)).toBe('Analysis LA2600011 is not by method IR, the form\'s method.');
    expect(formRefusal('return', null, { outcome: 'used', analysisNo: 'LA2699999' }, form, analyses)).toBe('Give the number of the analysis of this sample the form was transcribed into.');
    expect(formRefusal('return', null, { outcome: 'unused' }, form, analyses)).toBeNull();
    expect(formRefusal('void', null, {}, form, analyses)).toBe('Give the reason the form is voided (spoiled, lost …).');
    const back = { kind: 'returned' as const, payload: { outcome: 'unused' as const } };
    expect(formState(back)).toBe('unused');
    expect(formRefusal('void', back, { reason: 'x' }, form, analyses)).toBe('The form is already returned unused.');
  });
});

// ---- On the server ----
let t: TestApp;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  t = await freshApp();
  t.master.materials_.push({ itemId: MAT, code: 'RM-080', name: 'Demolactose', version: 1, active: true, category: 'Excipient', unit: 'kg' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register', 'lims.view'], sampler2: ['lims.sample.register'], analyst: ['lims.analysis.perform', 'lims.view'],
    reviewer: ['lims.analysis.review', 'lims.view'], qcuser: ['lims.qc.approve', 'lims.view'], viewer: ['lims.view'] } as const;
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
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-080' }]] as const) {
    const res = await as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hash(who), ...x });
    expect(res.statusCode, `${a}: ${res.body}`).toBe(200);
  }
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
const spec = () => specSchema.parse({
  header: { of: 'material', itemId: MAT, code: 'RM-080', name: 'Demolactose', type: 'Raw material', number: 'SPEC-RM-080', pharmacopoeia: 'Ph. Int.' },
  tests: [
    { key: 'ph', name: 'pH', method: { masterId: ph.masterId, code: 'PH', name: 'PH method' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' } },
    { key: 'id', name: 'Identity (IR)', method: { masterId: ir.masterId, code: 'IR', name: 'IR method' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' }, identity: true },
  ],
});

async function sampleOf(containers?: number) {
  const r = await as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: `L8-${Math.random().toString(36).slice(2, 8)}`, byHand: true, itemId: MAT,
    specVersionId: specId, quantity: '50 g', purpose: 'release', ...(containers ? { containers } : {}) });
  if (!containers) return r;
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  expect((await as('sampler2', 'POST', `/api/samples/${id}/check`, {})).statusCode).toBe(200);
  expect((await as('sampler', 'POST', `/api/samples/${id}/receive`, { condition: 'Sealed' })).statusCode).toBe(200);
  return id;
}
/** An analysis of the sample by a method (for a container), recorded, signed and reviewed. */
async function analysed(sampleId: number, m: { id: number }, reading: string, container?: number) {
  const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: m.id, sampleId, proof: proofFor('analyst'), ...(container ? { container } : {}) });
  expect(r.statusCode, r.body).toBe(200);
  const { id, analysisNo } = r.json() as { id: number; analysisNo: string };
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  expect((await step('start')).statusCode).toBe(200);
  expect((await step('record', { values: { reading } })).statusCode).toBe(200);
  const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] };
  expect((await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash })).statusCode).toBe(200);
  const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
  expect((await as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash })).statusCode).toBe(200);
  return { id, analysisNo };
}
type Detail = { decisionHash: string; approvalProblems: string[]; identityContainers: number | null; spec: { tests: { key: string; analyses: { analysisNo: string; status: string; container?: number; outside?: { id: number } }[] }[] } };
const detail = async (id: number, who = 'qcuser') => (await as(who, 'GET', `/api/samples/${id}`)).json() as Detail;
const approve = async (id: number) => as('qcuser', 'POST', `/api/samples/${id}/approve`, { proof: proofFor('qcuser'), contentHash: (await detail(id)).decisionHash });
const report = Buffer.from('%PDF-1.4 demo report of an outside lab');

describe('on the server', () => {
  beforeAll(async () => {
    Object.assign(ph, await effective('method', method('PH')));
    Object.assign(ir, await effective('method', method('IR')));
    specId = (await effective('spec', spec())).id;
  });

  it('LIMS-08 a starting material\'s release sample needs its number of containers; each is identified before QC approves', async () => {
    const no = await sampleOf();
    expect((no as { statusCode: number }).statusCode).toBe(400);
    expect((no as { json: () => { problems: string[] } }).json().problems[0]).toMatch(/^Containers sampled: give their number\. The identity of a starting material is tested on each container/);
    const sid = await sampleOf(3) as number;
    expect((await detail(sid)).identityContainers).toBe(3);
    // The identity method needs its container; the pH method takes none.
    const noContainer = await as('analyst', 'POST', '/api/analyses', { masterVersionId: ir.id, sampleId: sid, proof: proofFor('analyst') });
    expect(noContainer.json().problems).toEqual(['Pick the container this identity test is done on (1 to 3): each container of a starting material is identified.']);
    expect((await as('analyst', 'POST', '/api/analyses', { masterVersionId: ir.id, sampleId: sid, container: 4, proof: proofFor('analyst') })).statusCode).toBe(409);
    await analysed(sid, ph, '6.1');
    const c1 = await analysed(sid, ir, '6.0', 1);
    expect((await detail(sid)).approvalProblems).toEqual(['Identity (IR): containers 2, 3 of 3 have no reviewed identity result; each container of a starting material is identified.']);
    const c2 = await analysed(sid, ir, '6.0', 2);
    const c3 = await analysed(sid, ir, '6.0', 3);
    expect((await detail(sid)).approvalProblems).toEqual([]);
    const r = await approve(sid);
    expect(r.statusCode, r.body).toBe(200);
    const [row] = await t.owner.unsafe(`select analysis_number from ${t.schema}_report.result_v1 where coa_number = '${(r.json() as { coaNo: string }).coaNo}' and test_key = 'id'`);
    expect(row).toEqual({ analysis_number: [c1, c2, c3].map((x) => x.analysisNo).join(', ') });
    // The analysis record and the certificate name the container (LIMS-10) and say each container was identified.
    const [a] = await t.owner<{ container: number }[]>`select container from analyses where id = ${c2.id}`;
    expect(a!.container).toBe(2);
    const s = (await loadSampleRow(t.sql, sid))!;
    const [ev] = await t.owner`select e.id::int, e.kind, e.payload, e.person_id::int as person, 'QCUSER' as "personName", e.at, null as signature from sample_events e where e.sample_id = ${sid} and e.kind = 'approved'`;
    expect(pdfText(coaDoc({ sample: s, spec: spec(), specVersion: 1, decision: ev as never }, 'VIEWER'))).toContain('6.0 (each of 3 containers)');
  });

  it('LIMS-10 the worksheet record of a sample\'s analysis names the sample, its lot, the container tested and the specification version and tests', async () => {
    const sid = await sampleOf(2) as number;
    const a = await analysed(sid, ir, '6.0', 2);
    const text = pdfText(analysisRecordDoc(await recordInput(t.sql, (await loadAnalysis(t.sql, a.id))!), 'VIEWER'));
    const s = (await loadSampleRow(t.sql, sid))!;
    expect(text).toContain(`Sample | ${s.sampleNo} · RM-080 Demolactose · ${s.lotNo} · container 2 | Specification | SPEC-RM-080 version 1: Identity (IR) | Purpose | release`);
    expect(text).toContain('Reading: 6.0');
    expect(text).toMatch(/Reviewed \(second person\): REVIEWER, /);
  });

  it('LIMS-22 an outside lab\'s result: the report named with its SHA-256, the result typed and checked by a second person, marked on the CoA and in result_v1', async () => {
    const sid = await sampleOf(1) as number;
    await analysed(sid, ir, '6.0', 1);
    const body = { test: 'ph', lab: 'Demo Analytical Services', reportNo: 'DAS-2026-117', file: { name: 'DAS-2026-117.pdf', content: report.toString('base64') }, value: '6.42', unit: '' };
    expect((await as('viewer', 'POST', `/api/samples/${sid}/outside`, body)).statusCode).toBe(403);
    const r = await as('analyst', 'POST', `/api/samples/${sid}/outside`, body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().sha256).toBe(createHash('sha256').update(report).digest('hex'));
    // The identity of each container is done here, not outside.
    expect((await as('analyst', 'POST', `/api/samples/${sid}/outside`, { ...body, test: 'id' })).json().problems).toEqual(['Identity (IR) is done on each container of the starting material, in this lab.']);
    // Not counted until a second person checks it; the person who typed it cannot.
    expect((await detail(sid)).approvalProblems).toEqual(['pH: no reviewed result yet.']);
    const rid = (r.json() as { id: number }).id;
    expect((await as('analyst', 'POST', `/api/samples/${sid}/outside/${rid}/check`)).statusCode).toBe(403);
    const self = await call(t.app, cookies.reviewer!, 'POST', `/api/samples/${sid}/outside/${rid}/check`, {});
    expect(self.statusCode, self.body).toBe(200);
    expect((await as('reviewer', 'POST', `/api/samples/${sid}/outside/${rid}/check`)).statusCode).toBe(409);
    const d = await detail(sid);
    expect(d.spec.tests.find((x) => x.key === 'ph')!.analyses).toMatchObject([{ analysisNo: 'DAS-2026-117', status: 'reviewed', outside: { id: rid } }]);
    expect(d.approvalProblems).toEqual([]);
    const ok = await approve(sid);
    expect(ok.statusCode, ok.body).toBe(200);
    const coaNo = (ok.json() as { coaNo: string }).coaNo;
    const rows = await t.owner.unsafe(`select test_key, outside_lab, analysis_number, method_code, reported from ${t.schema}_report.result_v1 where coa_number = '${coaNo}' order by test_key`);
    expect(rows).toEqual([{ test_key: 'id', outside_lab: null, analysis_number: expect.stringMatching(/^LA/), method_code: 'IR', reported: '6.0' },
      { test_key: 'ph', outside_lab: 'Demo Analytical Services', analysis_number: 'DAS-2026-117', method_code: 'Outside lab: Demo Analytical Services', reported: '6.4' }]);
    const s = (await loadSampleRow(t.sql, sid))!;
    const [ev] = await t.owner`select e.id::int, e.kind, e.payload, e.person_id::int as person, 'QCUSER' as "personName", e.at, null as signature from sample_events e where e.sample_id = ${sid} and e.kind = 'approved'`;
    const text = pdfText(coaDoc({ sample: s, spec: spec(), specVersion: 1, decision: ev as never }, 'VIEWER'));
    expect(text).toContain('OUTSIDE LAB: Demo Analytical Services\nreport DAS-2026-117');
    expect(text).toContain(`pH: tested by the outside (contract) lab Demo Analytical Services, report DAS-2026-117 (file DAS-2026-117.pdf, SHA-256 ${createHash('sha256').update(report).digest('hex')})`);
    // After the decision nothing more is entered.
    expect((await as('analyst', 'POST', `/api/samples/${sid}/outside`, body)).json().problems).toEqual(['The sample is already approved.']);
    expect(await t.owner`select 1 from audit_log where action in ('sample.outside_result', 'sample.outside_checked') and object_id = ${String(sid)}`).toHaveLength(2);
  });

  it('LIMS-06 the sample\'s label and one label per container sampled, printed from the record', async () => {
    const sid = await sampleOf(2) as number;
    const res = await as('viewer', 'GET', `/api/samples/${sid}/labels`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const s = (await loadSampleRow(t.sql, sid))!;
    const def = labelsDoc(s, { number: 'SPEC-RM-080', versionNo: 1 }, 'VIEWER');
    // Laid out first (pdfmake changes what it lays out): each label still names the material and the lot.
    await render(def);
    const text = pdfText(def);
    expect(text.match(new RegExp(`Lot: ${s.lotNo}`, 'g'))).toHaveLength(3);
    expect(text).toContain(`QC SAMPLE ${s.sampleNo}`);
    expect(text).toContain('Material: RM-080 · Demolactose');
    expect(text).toContain(`Lot: ${s.lotNo}`);
    expect(text).toContain('Containers: 2 (sampled from containers 1 to 2)');
    expect(text).toContain('Sampled by: SAMPLER');
    expect(text).toMatch(/Date: \d{1,2} \w{3} 20\d\d/);
    expect(text).toContain('SAMPLED · container 1 of 2');
    expect(text).toContain('SAMPLED · container 2 of 2');
    expect(text.match(new RegExp(`Sample: ${s.sampleNo}`, 'g'))).toHaveLength(2);
    expect((await as('viewer', 'GET', '/api/samples/999999/labels')).statusCode).toBe(404);
  });

  it('LIMS-54 a blank worksheet is issued numbered for a sample and method, printed with its number, and reconciled when it comes back', async () => {
    const sid = await sampleOf(1) as number;
    expect((await as('analyst', 'POST', `/api/samples/${sid}/forms`, { masterVersionId: ir.id, reason: '' })).statusCode).toBe(400);
    const r = await as('analyst', 'POST', `/api/samples/${sid}/forms`, { masterVersionId: ir.id, reason: 'LIMS down for maintenance' });
    expect(r.statusCode, r.body).toBe(200);
    const { id, formNo } = r.json() as { id: number; formNo: string };
    expect(formNo).toMatch(/^LF\d{7}$/);
    const r2 = await as('analyst', 'POST', `/api/samples/${sid}/forms`, { masterVersionId: ph.id, reason: 'Bench without a terminal' });
    expect(Number((r2.json() as { formNo: string }).formNo.slice(4))).toBe(Number(formNo.slice(4)) + 1);
    expect((await as('viewer', 'GET', '/api/forms?open=1')).json().map((f: { formNo: string }) => f.formNo)).toEqual(expect.arrayContaining([formNo]));
    const pdf = await as('viewer', 'GET', `/api/forms/${id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const [f] = await loadForms(t.sql, { id });
    const [m] = await t.sql<{ doc: never; versionNo: number }[]>`select doc, version_no as "versionNo" from master_versions where id = ${ir.id}`;
    const text = pdfText(blankFormDoc(f!, (await loadSampleRow(t.sql, sid))!, m!, 'VIEWER'));
    expect(text).toMatch(new RegExp(`^Medhanta LIMS · Form ${formNo} · blank worksheet IR for sample LS\\d{7}`));
    expect(text).toContain('Issued by ANALYST');
    expect(text).toContain('LIMS down for maintenance');
    expect(text).toContain('Performed by / date:');
    // Back: used, into an analysis of this sample by the form's method.
    const a = await analysed(sid, ir, '6.0', 1);
    const b = await analysed(sid, ph, '6.0');
    expect((await as('analyst', 'POST', `/api/forms/${id}/return`, { outcome: 'used', analysisNo: b.analysisNo })).json().problems).toEqual([`Analysis ${b.analysisNo} is not by method IR, the form's method.`]);
    expect((await as('analyst', 'POST', `/api/forms/${id}/return`, { outcome: 'used', analysisNo: a.analysisNo })).statusCode).toBe(200);
    expect((await as('analyst', 'POST', `/api/forms/${id}/void`, { reason: 'twice' })).json().problems).toEqual(['The form is already returned, transcribed.']);
    const f2 = (r2.json() as { id: number }).id;
    expect((await as('analyst', 'POST', `/api/forms/${f2}/void`, { reason: 'Spoiled by a spill' })).statusCode).toBe(200);
    const open = (await as('viewer', 'GET', '/api/forms?open=1')).json() as { formNo: string }[];
    expect(open.map((x) => x.formNo)).not.toContain(formNo);
    const all = (await as('viewer', 'GET', '/api/forms')).json() as { formNo: string; state: string }[];
    expect(all.filter((x) => x.formNo === formNo || x.formNo === (r2.json() as { formNo: string }).formNo).map((x) => x.state).sort()).toEqual(['used', 'voided']);
    expect(await t.owner`select 1 from audit_log where action like 'form.%' and object_id = ${String(id)}`).toHaveLength(3);
  });

  it('LIMS-52 records are insert-only: every table of records refuses a change or a delete, by the app and by the owner', async () => {
    // Counters (numbers never reused), the users' rows and the one-time signing proofs are not records; a method or
    // specification version is locked once out of draft (its own trigger); every other table refuses UPDATE, DELETE and TRUNCATE.
    const tables = await t.owner<{ table_name: string; triggers: string | null }[]>`
      select c.relname as table_name, string_agg(tg.tgname, ',') as triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_trigger tg on tg.tgrelid = c.oid and not tg.tgisinternal
      where n.nspname = ${t.schema} and c.relkind = 'r' group by c.relname order by c.relname`;
    const notRecords = (name: string) => /_counters$/.test(name) || ['users', 'sessions', 'signing_proofs', 'schema_migrations', 'migrations'].includes(name);
    const unprotected = tables.filter((x) => !notRecords(x.table_name) && !x.triggers);
    expect(unprotected.map((x) => x.table_name)).toEqual([]);
    for (const table of ['samples', 'sample_events', 'outside_results', 'issued_forms', 'issued_form_events', 'analyses', 'step_events', 'signatures', 'audit_log']) {
      expect(tables.find((x) => x.table_name === table), table).toBeTruthy();
    }
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    for (const [table, col] of [['samples', 'quantity'], ['sample_events', 'payload'], ['outside_results', 'lab'], ['issued_forms', 'reason'], ['analyses', 'tests'], ['audit_log', 'reason']]) {
      for (const q of [t.owner, t.sql]) for (const stmt of [`delete from ${table}`, `update ${table} set ${col} = ${col}`]) expect(['42501', 'P0001'], `${table}: ${stmt}`).toContain(await code(q.unsafe(stmt)));
    }
  });

  it('LIMS-52 the PDF copies are made again from the stored record at any time: the same content, only the time of the copy differs', async () => {
    const [x] = await t.owner<{ id: number }[]>`select sample_id::int as id from sample_events where kind = 'approved' order by id limit 1`;
    const make = async (at: Date) => {
      const s = (await loadSampleRow(t.sql, x!.id))!;
      const [ev] = await t.owner`select e.id::int, e.kind, e.payload, e.person_id::int as person, 'QCUSER' as "personName", e.at, null as signature from sample_events e where e.sample_id = ${x!.id} and e.kind = 'approved'`;
      return pdfText(coaDoc({ sample: s, spec: spec(), specVersion: 1, decision: ev as never }, 'VIEWER', at)).replace(/Generated .* by VIEWER/, 'Generated … by VIEWER');
    };
    expect(await make(new Date('2027-01-01T00:00:00Z'))).toBe(await make(new Date('2036-06-30T00:00:00Z')));
  });
});
