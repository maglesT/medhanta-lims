import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';
import { masterSchema, type MasterDoc } from '../shared/master/schema.js';
import {
  conclude, findings, kindRefusal, methodUse, reportRefusal, reportStatus, useRefusal, type ReportFacts, type ValidationStep,
} from '../shared/engine/method-validation.js';
import type { Stored } from '../shared/engine/values.js';
import { storedReport } from '../server/routes/method-reports.js';
import { methodReportDoc } from '../server/method-report-pdf.js';

// Method validation, verification and transfer (plan 2.12): the report's rules (shared/engine/method-validation.ts),
// then on the server: a validation worksheet run as an analysis, its report prepared, reviewed by QC and approved by QA,
// and only then the method made effective (LIMS-02); a pharmacopoeial method verified, or validated outside QLIMS on
// paper (QA as the second person); a transferred method used only after its transfer report (LIMS-04).

// ---- The rules ----
const res = (shown: string, pass: boolean, extra: Record<string, unknown> = {}): Stored => ({ ok: true, value: '1', unit: '%', shown, check: { pass, level: pass ? 'pass' : 'fail', shown }, ...extra });
const vstep = (block: string, result: Stored | undefined, settings: Record<string, unknown> = {}): ValidationStep => ({ analysisNo: 'LA2600001', step: block, block, settings, result });
const report = (over: Partial<ReportFacts> = {}): ReportFacts => ({ id: 1, kind: 'validation', outside: false, methodVersionNo: 1, conclusion: 'met', preparedBy: 1, events: [], ...over });
const header = (over: Partial<MasterDoc['header']> = {}): MasterDoc['header'] => ({ code: 'M', name: 'M', technique: 'HPLC', reference: 'R', ...over });

describe('the validation report rules', () => {
  const full = [
    vstep('specificity', res('interference 0.1 %', true)),
    vstep('linearity', res('r 0.9999', true, { low: '50', high: '150' }), { use: 'assay' }),
    vstep('accuracy', res('mean recovery 99.9 %', true, { low: '80', high: '120' })),
    vstep('precision', res('RSD 0.3 %', true), { mode: 'repeatability' }),
    vstep('precision', res('RSD 0.6 %', true), { mode: 'intermediate precision' }),
  ];
  it('LIMS-02 an assay validation shows what ICH Q2 Table 1 asks: specificity, linearity, range, accuracy, repeatability and intermediate precision', () => {
    const fs = findings(full);
    expect(fs.map((f) => f.characteristic)).toEqual(['specificity', 'linearity', 'accuracy', 'repeatability', 'intermediate precision', 'range']);
    expect(fs.find((f) => f.characteristic === 'range')).toMatchObject({ met: true, shown: expect.stringContaining('range 80 to 120 %') });
    expect(conclude('validation', 'assay', fs)).toMatchObject({ met: true, missing: [] });
    // Without intermediate precision: missing. A quantitative impurity test also needs the quantitation limit.
    expect(conclude('validation', 'assay', findings(full.slice(0, 4)))).toMatchObject({ met: false, missing: ['intermediate precision'] });
    expect(conclude('validation', 'impurity (quantitative)', fs).missing).toEqual(['quantitation limit']);
    // A failed characteristic fails the report; the range is then not validated either.
    const bad = findings([...full.slice(0, 3), vstep('precision', res('RSD 2.4 %', false), { mode: 'repeatability' }), full[4]!]);
    expect(conclude('validation', 'assay', bad)).toMatchObject({ met: false, why: 'not met: range, repeatability' });
    // A verification shows what its protocol chose; a transfer needs the comparison.
    expect(conclude('verification', 'assay', findings([full[3]!])).met).toBe(true);
    expect(conclude('transfer', 'assay', findings([full[3]!]))).toMatchObject({ met: false, missing: ['transfer comparison'] });
  });

  it('LIMS-02 LIMS-04 the report a method needs: validation (in-house), verification (pharmacopoeial; a validation counts too), transfer (transferred)', () => {
    expect(kindRefusal(undefined, undefined, 'verification')).toContain('pharmacopoeial');
    expect(kindRefusal('pharmacopoeial', undefined, 'validation')).toBeNull();
    expect(kindRefusal('in-house', undefined, 'transfer')).toContain('LIMS-04');
    expect(kindRefusal('transferred', undefined, 'validation')).toContain('transfer report');
    expect(kindRefusal(undefined, 'validation', 'validation')).toContain('validation worksheet');
    expect(useRefusal(header(), 1, [])).toContain('not validated yet');
    expect(useRefusal(header({ use: 'validation' }), 1, [])).toBeNull();
    const approved = report({ events: [{ kind: 'reviewed', person: 2 }, { kind: 'approved', person: 3 }] });
    expect(useRefusal(header(), 1, [approved])).toBeNull();
    // Not approved, not met, or for a later version: it does not count.
    expect(useRefusal(header(), 1, [report({ events: [{ kind: 'reviewed', person: 2 }] })])).not.toBeNull();
    expect(useRefusal(header(), 1, [{ ...approved, conclusion: 'not met' }])).not.toBeNull();
    expect(useRefusal(header(), 1, [{ ...approved, methodVersionNo: 2 }])).not.toBeNull();
    expect(methodUse(header(), 3, [approved])).toMatchObject({ status: 'validated', report: { id: 1 } });
    expect(methodUse(header({ origin: 'pharmacopoeial' }), 1, [approved]).status).toBe('validated');
    expect(useRefusal(header({ origin: 'transferred' }), 1, [approved])).toContain('LIMS-04');
    expect(methodUse(header({ origin: 'transferred' }), 1, [{ ...approved, kind: 'transfer' }]).status).toBe('transferred');
  });

  it('LIMS-02 prepared, reviewed by QC and approved by QA: three people; outside QLIMS: QA approves as a second person', () => {
    const r = report();
    expect(reportStatus(r)).toBe('to review');
    expect(reportRefusal('review', r, 1)).toContain('cannot review');
    expect(reportRefusal('approve', r, 3)).toContain('QC reviews the report before');
    const reviewed = report({ events: [{ kind: 'reviewed', person: 2 }] });
    expect(reportRefusal('approve', reviewed, 2)).toContain('neither prepared nor reviewed');
    expect(reportRefusal('approve', reviewed, 3)).toBeNull();
    const paper = report({ outside: true });
    expect(reportStatus(paper)).toBe('to approve');
    expect(reportRefusal('review', paper, 2)).toContain('no QC review');
    expect(reportRefusal('approve', paper, 1)).toContain('second person');
    expect(reportRefusal('approve', paper, 2)).toBeNull();
  });
});

// ---- On the server ----
let t: TestApp;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  t = await freshApp();
  const people = { author: ['lims.master.author'], author2: ['lims.master.author', 'lims.master.approve'], checker: ['lims.master.check'], quality: ['lims.master.approve'],
    quality2: ['lims.master.approve'], analyst: ['lims.analysis.perform', 'lims.view'], analyst2: ['lims.analysis.perform', 'lims.analysis.check'],
    reviewer: ['lims.analysis.review', 'lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(() => t.close());

const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
async function ok(p: ReturnType<typeof as>) {
  const r = await p;
  expect(r.statusCode, r.body).toBe(200);
  return r;
}
const hashOf = async (who: string, id: number) => ((await as(who, 'GET', `/api/master-versions/${id}/review`)).json() as { contentHash: string }).contentHash;
/** Written, checked and approved by QA (not effective yet). */
async function approved(doc: MasterDoc) {
  const v = (await ok(as('author', 'POST', '/api/masters', { kind: 'method', doc }))).json() as { id: number; masterId: number };
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-080' }]] as const) {
    await ok(as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hashOf(who, v.id), ...x }));
  }
  return v;
}
const makeEffective = (id: number) => as('quality2', 'POST', `/api/master-versions/${id}/make-effective`, {});
const routine = (code: string, over: Partial<MasterDoc['header']> = {}) => masterSchema.parse({
  header: { code, name: `Demolol assay ${code}`, technique: 'HPLC', reference: `In-house ${code}`, ...over },
  stages: [{ key: 's', name: 'Assay', kind: 'normal', role: 'Analyst', steps: [{ key: 'r', block: { id: 'check', version: 1 }, checker: false,
    settings: { what: 'Assay', unit: '%', limit: { low: '95.0', high: '105.0', unit: '%' } } }] }],
});
const step = (key: string, id: string, settings: object) => ({ key, block: { id, version: 1 }, checker: true, settings });
const LINEARITY = { levelUnit: '%', limit: { low: '0.999', unit: '' }, interceptLimit: { low: '-2.0', high: '2.0', unit: '%' }, use: 'assay' };
const ACCURACY = { mode: 'recovery', amountUnit: 'mg', level1: '80 %', level2: '100 %', level3: '120 %', limit: { low: '98.0', high: '102.0', unit: '%' } };
const worksheet = (code: string, steps: object[]) => masterSchema.parse({
  header: { code, name: `Validation protocol ${code}`, technique: 'HPLC', reference: `VP-${code}`, use: 'validation' },
  stages: [{ key: 'v', name: 'Validation', kind: 'normal', role: 'Analyst', steps }],
});

/** Issues an analysis of the worksheet, records each step (signed, checked by a second person) and has it reviewed. */
async function run(versionId: number, values: Record<string, unknown>[]) {
  const { id } = (await ok(as('analyst', 'POST', '/api/analyses', { masterVersionId: versionId, proof: proofFor('analyst') }))).json() as { id: number };
  for (const [i, v] of values.entries()) {
    const key = `0.1.${i}.1`;
    const act = (who: string, a: string, body: object = {}) => as(who, 'POST', `/api/analyses/${id}/steps/${key}/${a}`, body);
    const now = async (who: string) => ((await as(who, 'GET', `/api/analyses/${id}`)).json() as { steps: { id: string; contentHash: string }[] }).steps.find((s) => s.id === key)!;
    await ok(act('analyst', 'start'));
    await ok(act('analyst', 'record', { values: v }));
    await ok(act('analyst', 'done', { proof: proofFor('analyst'), contentHash: (await now('analyst')).contentHash }));
    await ok(act('analyst2', 'check', { proof: proofFor('analyst2'), contentHash: (await now('analyst2')).contentHash }));
  }
  const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
  await ok(as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash }));
  return id;
}
const LIN_VALUES = { levels: ['50', '75', '100', '125', '150'], responses: ['1012', '1498', '2003', '2510', '2995'] };
const ACC_VALUES = { added1: ['8.0', '8.0', '8.0'], found1: ['7.94', '8.02', '7.97'], added2: ['10.0', '10.0', '10.0'], found2: ['10.05', '9.96', '10.02'],
  added3: ['12.0', '12.0', '12.0'], found3: ['11.93', '12.05', '12.01'] };

type Preview = { conclusion: { met: boolean; missing: string[]; why: string }; contentHash: string };
const draft = (kind: string, methodVersionId: number, testType: string, analysisIds: number[]) => ({ kind, methodVersionId, testType, analysisIds });
async function prepare(d: ReturnType<typeof draft>, extra: object = {}) {
  const p = (await ok(as('author', 'POST', '/api/method-reports/preview', d))).json() as Preview;
  return as('author', 'POST', '/api/method-reports', { ...d, reference: 'VP-2026-011', proof: proofFor('author'), contentHash: p.contentHash, ...extra });
}
const reportHash = async (who: string, id: number) => ((await as(who, 'GET', `/api/method-reports/${id}`)).json() as { contentHash: string }).contentHash;
const signReport = async (who: string, id: number, action: 'review' | 'approve') => as(who, 'POST', `/api/method-reports/${id}/${action}`, { proof: proofFor(who), contentHash: await reportHash(who, id) });

describe('LIMS-02 method validation on the server', () => {
  it('LIMS-02 an in-house method becomes effective only after its validation report, from reviewed worksheet analyses, is reviewed by QC and approved by QA', async () => {
    const m = await approved(routine('QC-M-801'));
    const refused = await makeEffective(m.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'not_validated', message: expect.stringContaining('not validated yet') });
    // The validation worksheet needs no validation itself: it becomes effective as any method.
    const w = await approved(worksheet('VP-801', [step('lin', 'linearity', LINEARITY), step('acc', 'accuracy', ACCURACY)]));
    await ok(makeEffective(w.id));
    const aid = await run(w.id, [LIN_VALUES, ACC_VALUES]);
    // For an assay ICH Q2 asks more than linearity and accuracy: the preview says what is missing.
    const assay = (await ok(as('author', 'POST', '/api/method-reports/preview', draft('validation', m.id, 'assay', [aid])))).json() as Preview;
    expect(assay.conclusion).toMatchObject({ met: false, missing: ['specificity', 'range', 'repeatability', 'intermediate precision'] });
    // A verification is not for an in-house method.
    expect((await as('author', 'POST', '/api/method-reports/preview', draft('verification', m.id, 'assay', [aid]))).json()).toMatchObject({ error: 'wrong_kind' });
    // The protocol for this method asked linearity and accuracy: met.
    const r = await prepare(draft('validation', m.id, 'other (as the protocol says)', [aid]));
    expect(r.statusCode, r.body).toBe(200);
    const { id, reportNo, conclusion } = r.json() as { id: number; reportNo: string; conclusion: string };
    expect(reportNo).toMatch(/^MVR\d{6}$/);
    expect(conclusion).toBe('met');
    const detail = (await as('reviewer', 'GET', `/api/method-reports/${id}`)).json() as { outputs: { characteristics: { characteristic: string; met: boolean }[] }; status: string };
    expect(detail.outputs.characteristics.map((c) => [c.characteristic, c.met])).toEqual([['linearity', true], ['accuracy', true]]);
    expect(detail.status).toBe('to review');
    // Still not effective: the report is not approved yet.
    expect((await makeEffective(m.id)).json().error).toBe('not_validated');
    expect((await signReport('quality', id, 'approve')).json().message).toContain('QC reviews the report before');
    await ok(signReport('reviewer', id, 'review'));
    await ok(signReport('quality', id, 'approve'));
    await ok(makeEffective(m.id));
    // The PDF QA files: made again from the stored report and its three signatures, the same each time.
    const pdf = await as('analyst', 'GET', `/api/method-reports/${id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const stored = (await storedReport(t.sql, id))!;
    const at = new Date('2026-11-18T10:00:00Z');
    const text = JSON.stringify(methodReportDoc(stored.report, stored.signatures, 'ANALYST', at));
    expect(text).toBe(JSON.stringify(methodReportDoc((await storedReport(t.sql, id))!.report, stored.signatures, 'ANALYST', at)));
    for (const words of [reportNo, 'QC-M-801', 'version 1', 'in-house method', 'Protocol VP-2026-011', 'Correlation coefficient r: NLT 0.999', 'Mean recovery: 98.0 to 102.0 %',
      'mean recovery 99.93 %', 'r = 0.99997', 'Conclusion: met', 'Prepared', 'AUTHOR', 'Reviewed (QC)', 'REVIEWER', 'Approved (QA)', 'QUALITY']) expect(text).toContain(words);
    expect(text).toMatch(/LA26\d{5}/);
    expect(stored.signatures.map((g) => g.meaning)).toEqual(['prepared', 'reviewed', 'approved']);
    const list = (await as('analyst', 'GET', '/api/method-reports')).json() as { methods: { code: string; status: string; reportNo: string | null }[] };
    expect(list.methods.find((x) => x.code === 'QC-M-801')).toMatchObject({ status: 'validated', reportNo });
  });

  it('LIMS-02 a report covers reviewed analyses of validation worksheets only; a worksheet is never run for a sample', async () => {
    const m = await approved(routine('QC-M-802'));
    const w = await approved(worksheet('VP-802', [step('lin', 'linearity', LINEARITY)]));
    await ok(makeEffective(w.id));
    const { id } = (await ok(as('analyst', 'POST', '/api/analyses', { masterVersionId: w.id, proof: proofFor('analyst') }))).json() as { id: number };
    expect((await as('author', 'POST', '/api/method-reports/preview', draft('validation', m.id, 'assay', [id]))).json()).toMatchObject({ error: 'not_reviewed' });
    expect((await as('analyst', 'POST', '/api/analyses', { masterVersionId: w.id, sampleId: 1, proof: proofFor('analyst') })).json()).toMatchObject({ error: 'validation_worksheet' });
  });

  it('LIMS-02 a pharmacopoeial method validated on paper before QLIMS: recorded with the paper report number, approved by QA as a second person', async () => {
    const m = await approved(routine('QC-M-803', { origin: 'pharmacopoeial', reference: 'Ph. Int. Demolol tablets', edition: '11th ed.' }));
    expect((await makeEffective(m.id)).json().message).toContain('not verified yet');
    const r = await as('author2', 'POST', '/api/method-reports', { ...draft('verification', m.id, 'assay', []), outside: true, reference: 'QC/VER/2019/044', proof: proofFor('author2') });
    expect(r.statusCode, r.body).toBe(200);
    const { id } = r.json() as { id: number };
    expect((await signReport('author2', id, 'approve')).json().message).toContain('second person');
    expect((await signReport('reviewer', id, 'review')).json().message).toContain('no QC review');
    await ok(signReport('quality', id, 'approve'));
    await ok(makeEffective(m.id));
    const list = (await as('analyst', 'GET', '/api/method-reports')).json() as { methods: { code: string; status: string }[] };
    expect(list.methods.find((x) => x.code === 'QC-M-803')?.status).toBe('verified (outside QLIMS)');
    const paper = (await storedReport(t.sql, id))!;
    const text = JSON.stringify(methodReportDoc(paper.report, paper.signatures, 'ANALYST'));
    expect(text).toContain('Validated outside QLIMS: paper report QC/VER/2019/044');
    expect(text).toContain('pharmacopoeial method');
  });
});

describe('LIMS-04 method transfer on the server', () => {
  it('LIMS-04 a transferred method is used only after its transfer report: sending and receiving laboratory, protocol, comparative results, conclusion, QC review and QA approval', async () => {
    const m = await approved(routine('QC-M-804', { origin: 'transferred' }));
    expect((await makeEffective(m.id)).json().message).toContain('LIMS-04');
    const w = await approved(worksheet('TP-804', [step('cmp', 'transfer-comparison', { mode: 'equivalence (TOST)', resultUnit: '%', margin: '2.0 %' })]));
    await ok(makeEffective(w.id));
    const aid = await run(w.id, [{ sending: ['99.0', '99.5', '100.0', '100.5', '101.0', '101.5'], receiving: ['98.5', '99.0', '99.5', '100.0', '100.5', '101.0'] }]);
    expect((await as('author', 'POST', '/api/method-reports/preview', draft('validation', m.id, 'assay', [aid]))).json().message).toContain('transfer report');
    // The laboratories are named.
    expect((await prepare(draft('transfer', m.id, 'assay', [aid]))).json()).toMatchObject({ error: 'labs_missing' });
    const r = await prepare(draft('transfer', m.id, 'assay', [aid]), { sendingLab: 'R&D analytical laboratory, Site A', receivingLab: 'QC laboratory, Site B' });
    expect(r.statusCode, r.body).toBe(200);
    const { id, conclusion } = r.json() as { id: number; conclusion: string };
    expect(conclusion).toBe('met');
    expect((await makeEffective(m.id)).json().error).toBe('not_validated');
    await ok(signReport('reviewer', id, 'review'));
    await ok(signReport('quality', id, 'approve'));
    await ok(makeEffective(m.id));
    const d = (await as('analyst', 'GET', `/api/method-reports/${id}`)).json() as { sendingLab: string; receivingLab: string; reference: string; status: string };
    expect(d).toMatchObject({ sendingLab: 'R&D analytical laboratory, Site A', receivingLab: 'QC laboratory, Site B', reference: 'VP-2026-011', status: 'approved' });
  });

  it('LIMS-04 a transfer whose comparison fails concludes "not met" and does not let the method be used', async () => {
    const m = await approved(routine('QC-M-805', { origin: 'transferred' }));
    const w = await approved(worksheet('TP-805', [step('cmp', 'transfer-comparison', { mode: 'difference', resultUnit: '%', margin: '0.4 %' })]));
    await ok(makeEffective(w.id));
    const values = { sending: ['99.0', '99.5', '100.0', '100.5', '101.0', '101.5'], receiving: ['98.5', '99.0', '99.5', '100.0', '100.5', '101.0'] };
    // The failed comparison is a failed check: the step needs a deviation note before it is signed.
    const { id: aid } = (await ok(as('analyst', 'POST', '/api/analyses', { masterVersionId: w.id, proof: proofFor('analyst') }))).json() as { id: number };
    const act = (who: string, a: string, body: object = {}) => as(who, 'POST', `/api/analyses/${aid}/steps/0.1.0.1/${a}`, body);
    const now = async (who: string) => ((await as(who, 'GET', `/api/analyses/${aid}`)).json() as { steps: { contentHash: string }[] }).steps[0]!;
    await ok(act('analyst', 'start'));
    await ok(act('analyst', 'record', { values }));
    await ok(act('analyst', 'note', { text: 'Difference 0.5 % over the 0.4 % margin: transfer not shown; investigation per the transfer protocol.' }));
    await ok(act('analyst', 'done', { proof: proofFor('analyst'), contentHash: (await now('analyst')).contentHash }));
    await ok(act('analyst2', 'check', { proof: proofFor('analyst2'), contentHash: (await now('analyst2')).contentHash }));
    const a = (await as('reviewer', 'GET', `/api/analyses/${aid}`)).json() as { analysis: { contentHash: string } };
    await ok(as('reviewer', 'POST', `/api/analyses/${aid}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash }));
    const r = await prepare(draft('transfer', m.id, 'assay', [aid]), { sendingLab: 'Site A', receivingLab: 'Site B' });
    const { id, conclusion } = r.json() as { id: number; conclusion: string };
    expect(conclusion).toBe('not met');
    await ok(signReport('reviewer', id, 'review'));
    await ok(signReport('quality', id, 'approve'));
    expect((await makeEffective(m.id)).json().error).toBe('not_validated');
  });
});
