import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { plantToday } from '../server/routes/inventory.js';
import { addDays } from '../shared/engine/stability.js';
import { OOS_CHECKLIST } from '../shared/engine/oos.js';
import {
  ADVISORY, answersRefusal, arrhenius, evaluateTest, groupProposal, numericTests, toReport, trendFlag, type NumericTest, type ReportItem, type ResultPoint,
} from '../shared/engine/stability-evaluation.js';
import { specSchema, type SpecDoc } from '../shared/master/spec.js';
import { small } from './engine-fixture.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';

// Stability evaluation (LIMS-29, LIMS-25; plan 2.6, 2b items 3, 4, 7, 8): results from the stability samples' reviewed
// analyses; ICH Q1E per long-term condition (template L15) per study and across the product's studies, signed by QA
// with the decision-tree answers and stored insert-only; the out-of-trend flag of a stability result (template L22);
// the Arrhenius advisory (L24); a confirmed OOS or a negative trend on a marketed batch to be reported; the CTD tables;
// the published stability_v1.

const ASSAY: NumericTest = { key: 'assay', name: 'Assay', low: '95.0', high: '105.0', unit: '%', words: '95.0 to 105.0 %' };
let seq = 0;
const pt = (study: number, lot: string, month: number, value: string, over: Partial<ResultPoint> = {}): ResultPoint => ({
  studyId: study, studyNo: `STB26${String(study).padStart(3, '0')}`, lotNo: lot, condition: 'lt', label: '30 °C / 75 % RH (India, zone IVb)', code: '30/75', role: 'long-term',
  month, testKey: 'assay', sampleId: ++seq, sampleNo: `LS26${seq}`, analysisNo: `LA26${seq}`, value, unit: '%', shown: `${value} %`, pass: true, decided: null, ...over,
});
const series = (study: number, lot: string, values: string[], months = [0, 3, 6, 9, 12], over: Partial<ResultPoint> = {}) => values.map((v, k) => pt(study, lot, months[k]!, v, over));

describe('the Q1E evaluation (template L15)', () => {
  const data = [...series(1, 'B1', ['100.2', '99.8', '99.3', '99.0', '98.5']), ...series(2, 'B2', ['100.0', '99.7', '99.1', '98.8', '98.4']),
    ...series(3, 'B3', ['100.3', '99.9']), ...series(4, 'B4', ['100.1', '99.6', '99.2', '98.8', '98.3'])];
  it('LIMS-29 the stability-indicating tests are those that apply on stability with a numeric shelf-life limit', () => {
    const spec = specSchema.parse({ header: { of: 'product', itemId: 'p', code: 'FG', name: 'X', type: 'Finished product', number: 'S', pharmacopoeia: 'IP' }, tests: [
      { key: 'assay', name: 'Assay', method: { masterId: 1, code: 'M', name: 'M' }, result: 'a/b/c', limitType: 'release and shelf life', limit: { low: '95.0', high: '105.0', unit: '%' }, shelfLifeLimit: { low: '90.0', high: '110.0', unit: '%' } },
      { key: 'id', name: 'Identity', method: { masterId: 1, code: 'M', name: 'M' }, result: 'a/b/c', limitType: 'conforms', conforms: 'Matches' },
      { key: 'imp', name: 'Impurity A', method: { masterId: 1, code: 'M', name: 'M' }, result: 'a/b/c', limitType: 'not more than', limit: { high: '0.5', unit: '%' } },
      { key: 'desc', name: 'Water', method: { masterId: 1, code: 'M', name: 'M' }, result: 'a/b/c', limitType: 'not more than', limit: { high: '2.0', unit: '%' }, use: 'release' },
    ] });
    expect(numericTests(spec)).toEqual([
      { key: 'assay', name: 'Assay', low: '90.0', high: '110.0', unit: '%', words: '90.0 to 110.0 %' },
      { key: 'imp', name: 'Impurity A', high: '0.5', unit: '%', words: 'NMT 0.5 %' },
    ]);
  });
  it('LIMS-29 the batches with 3 or more time points are pooled as far as the poolability tests allow (here a common slope); the estimate, the model and the limiting line', () => {
    const e = evaluateTest(ASSAY, data);
    expect(e).toMatchObject({ ok: true, used: ['B1', 'B2', 'B4'], notUsed: [{ lotNo: 'B3', why: expect.stringMatching(/2 time point\(s\): Q1E needs at least 3/) }], model: 'common slope', limiting: 'B2 (lower)' });
    expect(Number(e.estimate)).toBeGreaterThan(24);
    expect(Number(e.estimate)).toBeLessThan(40);
    expect(e.proposed).toBeUndefined();
    expect(e.shown).toMatch(/poolability \(ANCOVA, level 0\.25\)/);
  });
  it('LIMS-29 with the decision-tree answers the proposed shelf life is capped (here 2X, not more than X + 12 = 24 months) and the group takes its shortest test', () => {
    const answers = { storage: 'room temperature', accelerated: 'no significant change', change: 'change or variability', statistics: 'performed' } as const;
    const e = evaluateTest(ASSAY, data, 'none', answers);
    expect(e).toMatchObject({ ok: true, proposed: 24, cap: '24', branch: expect.stringMatching(/room temperature, no significant change at accelerated/) });
    const imp: NumericTest = { key: 'imp', name: 'Impurity A', high: '0.5', unit: '%', words: 'NMT 0.5 %' };
    const ip = evaluateTest(imp, [...series(1, 'B1', ['0.10', '0.15', '0.21', '0.24', '0.31']), ...series(2, 'B2', ['0.12', '0.16', '0.20', '0.27', '0.30'])].map((p) => ({ ...p, testKey: 'imp' })), 'none', answers);
    expect(ip.ok).toBe(true);
    expect(ip.proposed!).toBeLessThan(24);
    expect(groupProposal([e, ip])).toEqual({ months: ip.proposed, test: 'Impurity A', limiting: ip.limiting });
    expect(groupProposal([e, { ...ip, ok: false, message: 'too few' }])).toEqual({ months: null, why: 'Impurity A: too few' });
    expect(groupProposal([evaluateTest(ASSAY, data)])).toEqual({ months: null, why: 'Answer the Q1E decision tree first.' });
  });
  it('LIMS-29 the decision tree asks only what the storage needs', () => {
    expect(answersRefusal({ storage: 'frozen' })).toBeNull();
    expect(answersRefusal({ storage: 'room temperature' })).toMatch(/accelerated/);
    expect(answersRefusal({ storage: 'room temperature', accelerated: 'significant change' })).toMatch(/intermediate/);
    expect(answersRefusal({ storage: 'room temperature', accelerated: 'significant change', intermediate: 'no significant change' })).toBeNull();
    expect(answersRefusal({ storage: 'refrigerated', accelerated: 'no significant change' })).toMatch(/little or no change/);
    expect(answersRefusal({ storage: 'refrigerated', accelerated: 'significant change' })).toBeNull();
  });
});

describe('out of trend (template L22) and Arrhenius (template L24)', () => {
  it('LIMS-25 a stability result outside the 95 % prediction interval of its batch\'s earlier results is out of trend; inside, or too few earlier results, it is not', () => {
    const earlier = series(1, 'B1', ['100.2', '99.8', '99.3', '99.0']);
    expect(trendFlag(pt(1, 'B1', 12, '98.6'), [...earlier])).toBeNull();
    expect(trendFlag(pt(1, 'B1', 12, '97.0'), [...earlier])).toMatch(/^outside the 95 % prediction interval of this batch's earlier results \d+\.\d to \d+\.\d % \(template L22\)$/);
    expect(trendFlag(pt(1, 'B1', 6, '97.0'), [...earlier.slice(0, 2)])).toBeNull();
    // Another condition or test is not compared.
    expect(trendFlag(pt(1, 'B1', 12, '97.0', { label: '40 °C / 75 % RH' }), [...earlier])).toBeNull();
  });
  it('LIMS-25 the product\'s other batches at the condition are the historical line when the batch has too few earlier results', () => {
    const others = [...series(2, 'B2', ['100.0', '99.7', '99.1', '98.8', '98.4']), ...series(4, 'B4', ['100.1', '99.6', '99.2', '98.8', '98.3'])];
    expect(trendFlag(pt(5, 'B5', 3, '99.7'), others)).toBeNull();
    expect(trendFlag(pt(5, 'B5', 3, '97.9'), others)).toMatch(/of the other batches/);
  });
  it('Arrhenius is advisory: the rates at three temperatures give the time to the limit at the long-term condition; two temperatures are not enough', () => {
    const at = (label: string, code: ResultPoint['code'], values: string[], months: number[]) => values.map((v, k) => pt(1, 'B1', months[k]!, v, { label, code, role: code === '30/75' ? 'long-term' : 'accelerated' }));
    const lt = at('30/75', '30/75', ['100.0', '99.7', '99.4', '99.1'], [0, 3, 6, 9]);
    const acc = at('40/75', '40/75', ['100.0', '98.8', '97.6'], [0, 3, 6]);
    const two = arrhenius(ASSAY, [...lt, ...acc], '30/75');
    expect(two).toMatchObject({ ok: false, message: expect.stringMatching(/three or more different temperatures/), advisory: ADVISORY });
    const r = arrhenius(ASSAY, [...lt, ...acc, ...at('25/60', '25/60', ['100.0', '99.8', '99.6'], [0, 3, 6])], '30/75');
    expect(r).toMatchObject({ ok: true, advisory: ADVISORY, shown: expect.stringMatching(/^advisory: for development decisions, not for the label/) });
    expect(r.rates.map((x) => x.label)).toEqual(['30/75', '40/75', '25/60']);
    expect(Number(r.months)).toBeGreaterThan(30);
  });
  it('LIMS-29 a confirmed OOS or a negative trend is to be reported unless the batch is known not to be marketed', () => {
    const i = (lotNo: string): ReportItem => ({ key: `oos:${lotNo}`, kind: 'confirmed OOS', studyId: 1, studyNo: 'STB26001', lotNo, label: 'x', month: 6, test: 'Assay', what: '', oosNo: 'OOS260001' });
    expect(toReport([i('A'), i('B'), i('C')], (l) => (l === 'A' ? true : l === 'B' ? false : null)).map((r) => [r.lotNo, r.marketed])).toEqual([['A', true], ['C', null]]);
  });
});

// ---- On the server ----
let t: TestApp;
let provider: Sql;
const S = { tb: '', dv: '' };
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
const as = (who: string, method: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, method as 'GET', url, body);
const ok = async <R extends { statusCode: number; body: string }>(r: Promise<R>) => { const x = await r; expect(x.statusCode, x.body).toBe(200); return x; };
const yes = Object.fromEntries(OOS_CHECKLIST.map(([k]) => [k, { yes: true }]));
let method = { id: 0, masterId: 0 };
const studies: Record<string, number> = {};
const samples: Record<string, { id: number; analysisNo: string }> = {};

async function effective(kind: 'method' | 'spec' | 'protocol', doc: object) {
  const r = await as('author', 'POST', '/api/masters', { kind, doc });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number; masterId: number };
  for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${v.id}`;
  return v;
}

beforeAll(async () => {
  t = await freshApp(async (db) => {
    S.tb = `${db.schema}_tb`; S.dv = `${db.schema}_dv`;
    await db.owner.unsafe(`
      create schema ${S.tb}; create schema ${S.dv};
      create table ${S.tb}.batch_fact_v1 (batch_id uuid default gen_random_uuid(), batch_number text, product_code text, strength text, record_kind text, status text,
        issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now(),
        product_name text, good_quantity numeric, good_unit text, released_at timestamptz);
      create table ${S.dv}.deviation_v1 (number text, status text, classification text, opened_at timestamptz, closed_at timestamptz, product text, batch text,
        batch_norm text, outcome text, read_at timestamptz default now(), data_as_of timestamptz default now(), title text, source_ref text);
      grant usage on schema ${S.tb}, ${S.dv} to lims_app; grant select on all tables in schema ${S.tb}, ${S.dv} to lims_app;
      insert into ${S.tb}.batch_fact_v1 (batch_number, product_code, product_name, status, completed_at, released, released_at) values
        ('B26101', 'FG-201', 'Stabilol 50 mg tablets', 'RELEASED', now(), true, now()),
        ('B26102', 'FG-201', 'Stabilol 50 mg tablets', 'RELEASED', now(), true, now()),
        ('B26103', 'FG-201', 'Stabilol 50 mg tablets', 'RELEASED', now(), true, now());
      insert into ${S.dv}.deviation_v1 (number, status, title) values ('DEV-26-020', 'open', 'Stability pulls of the old studies');`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ truebatch: provider, deviations: provider }, { truebatch: S.tb, deviations: S.dv });
  });
  t.master.products_.push({ itemId: 'prd-201', code: 'FG-201', name: 'Stabilol 50 mg tablets', version: 1, active: true, strength: '50 mg', dosageForm: 'tablet' });
  const people = {
    author: ['lims.master.author'], sampler: ['lims.sample.register', 'lims.view'], analyst: ['lims.analysis.perform', 'lims.view'], reviewer: ['lims.analysis.review'],
    supervisor: ['lims.analysis.review'], qalead: ['lims.oos.approve'], qcman: ['lims.qc.approve', 'lims.view'], viewer: ['lims.view'],
  } as const;
  for (const [name, perms] of Object.entries(people)) {
    ids[name] = await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
  // Assay by a reading (check block), 95.0 to 105.0 % at release and on stability.
  method = await effective('method', small([{ role: 'Analyst', steps: [{ key: 'as', block: { id: 'check', version: 1 }, settings: { what: 'Assay', unit: '%', limit: { spec: 'limit' } } }] }]));
  const spec = await effective('spec', specSchema.parse({
    header: { of: 'product', itemId: 'prd-201', code: 'FG-201', name: 'Stabilol 50 mg tablets', type: 'Finished product', number: 'SPEC-FG-201', pharmacopoeia: 'In-house' },
    tests: [{ key: 'assay', name: 'Assay', method: { masterId: method.masterId, code: 'M', name: 'M' }, result: 's0/as/readingCheck', limitType: 'range', limit: { low: '95.0', high: '105.0', unit: '%' } }],
  }) satisfies SpecDoc);
  const protocol = await effective('protocol', {
    header: { of: 'product', itemId: 'prd-201', code: '', name: '', number: 'STP-FG-201', purpose: 'registration', containerClosure: 'HDPE bottle, 30 tablets', sameAsMarketed: true, shelfLifeMonths: 24 },
    spec: { versionId: spec.id, number: '', versionNo: 1 }, quantity: { amount: '20', unit: 'tablets' }, pullWindowDays: 7,
    conditions: [{ key: 'lt', code: '30/75', role: 'long-term', months: [0, 3, 6, 9, 12, 18, 24] }, { key: 'acc', code: '40/75', role: 'accelerated', months: [0, 3, 6] }],
    design: { type: 'full', factors: [], matrix: [] },
  });
  // Three studies placed 400 days ago (set up as the database owner): their pulls to 12 months are late (reason, deviation).
  const t0 = addDays(plantToday(new Date()), -400);
  const results: Record<string, { lt: string[]; acc: string[] }> = {
    B26101: { lt: ['100.2', '99.8', '99.3', '99.0', '98.5'], acc: ['100.2', '99.0', '97.9'] },
    B26102: { lt: ['100.0', '99.7', '99.1', '98.8', '98.4'], acc: ['100.0', '98.8', '97.6'] },
    B26103: { lt: ['100.3', '99.9', '99.5', '99.1', '97.1'], acc: ['100.3', '99.1', '94.0'] },
  };
  for (const [n, lot] of Object.keys(results).entries()) {
    const [s] = await t.owner<{ id: number }[]>`insert into stability_studies (study_no, protocol_version_id, lot_no, item, source, t0, created_by)
      values (${`STB25${String(101 + n)}`}, ${protocol.id}, ${lot}, ${t.owner.json({ of: 'product', itemId: 'prd-201', code: 'FG-201', name: 'Stabilol 50 mg tablets' })},
        ${t.owner.json({ from: 'truebatch', asOf: null, shown: `TrueBatch batch ${lot}` })}, ${t0}, ${ids.sampler!}) returning id::int`;
    studies[lot] = s!.id;
    for (const c of ['lt', 'acc']) {
      await t.owner`insert into stability_events (study_id, kind, payload, person_id) values (${s!.id}, 'placed', ${t.owner.json({ condition: c, chamber: { itemId: 'eq-1', code: 'CH-01', name: 'Chamber' }, quantity: '400' })}, ${ids.sampler!})`;
    }
    for (const c of ['lt', 'acc'] as const) {
      for (const [k, value] of results[lot]![c].entries()) {
        const month = [0, 3, 6, 9, 12][k]!;
        const p = await ok(as('sampler', 'POST', `/api/stability/studies/${s!.id}/pull`, { condition: c, month, late: { reason: 'Study set up late', deviation: 'DEV-26-020' } }));
        const sid = p.json().sampleId as number;
        await ok(as('sampler', 'POST', `/api/samples/${sid}/receive`, { condition: 'Sealed' }));
        const a = await ok(as('analyst', 'POST', '/api/analyses', { masterVersionId: method.id, sampleId: sid, proof: proofFor('analyst') }));
        const { id, analysisNo } = a.json() as { id: number; analysisNo: string };
        const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
        await ok(step('start'));
        await ok(step('record', { values: { reading: value } }));
        if (Number(value) < 95) await ok(step('note', { text: 'Out of limits: OOS opened' }));
        const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] };
        await ok(step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash }));
        const r = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
        await ok(as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: r.analysis.contentHash }));
        samples[`${lot}:${c}:${month}`] = { id: sid, analysisNo };
      }
    }
  }
}, 120_000);
afterAll(async () => {
  await provider?.end();
  for (const s of Object.values(S)) if (s) await t.owner.unsafe(`drop schema if exists ${s} cascade`);
  await t?.close();
});

type Evaluation = {
  scope: string; kind: string; groups: { key: string; label: string; storage: string; studies: string[]; contentHash: string; signRefusal: string | null;
    tests: { key: string; ok: boolean; model?: string; used: string[]; estimate?: string; message?: string }[] }[];
  tables: { studyNo: string; condition: string; months: number[]; rows: { key: string; cells: Record<string, { figure: string; oot: string | null; pass: boolean | null }> }[] }[];
  arrhenius: { ok: boolean; message?: string; advisory: string }[];
  toReport: { key: string; kind: string; lotNo: string; oosNo?: string; marketed: boolean | null; answer: { needed: boolean } | null }[];
  evaluations: { id: number; months: number; kind: string; printedName: string | null; studyIds: number[] }[];
};
const product = async (who = 'qcman') => (await as(who, 'GET', '/api/stability/evaluation?of=product&itemId=prd-201')).json() as Evaluation;

describe('stability evaluation on the server', () => {
  it('LIMS-25 a stability result outside the prediction interval of its batch\'s earlier results (and the other batches) is the sample\'s out-of-trend flag, answered by QC before approval', async () => {
    const sid = samples['B26103:lt:12']!.id;
    const d = (await as('qcman', 'GET', `/api/samples/${sid}`)).json() as { oot: { key: string; trend: string; answer: unknown }[]; approvalProblems: string[] };
    expect(d.oot).toEqual([expect.objectContaining({ key: 'assay', trend: expect.stringMatching(/^outside the 95 % prediction interval of this batch's earlier results .* \(template L22\)$/), answer: null })]);
    expect(d.approvalProblems).toContainEqual(expect.stringMatching(/^Assay: 97\.1 % is out of trend \(outside the 95 % prediction interval .*\): QC answers the flag first\.$/));
    // The other batches' 12-month results are in trend.
    for (const lot of ['B26101', 'B26102']) expect(((await as('qcman', 'GET', `/api/samples/${samples[`${lot}:lt:12`]!.id}`)).json() as { oot: unknown[] }).oot).toEqual([]);
    await ok(as('qcman', 'POST', `/api/samples/${sid}/oot`, { test: 'assay', answer: 'investigation', reason: 'Drop at 12 months: investigate the batch' }));
    expect(((await as('qcman', 'GET', `/api/samples/${sid}`)).json() as { approvalProblems: string[] }).approvalProblems.filter((p) => /out of trend/.test(p))).toEqual([]);
  });

  it('LIMS-29 the study screen evaluates its own batch: results per condition and time point, Q1E on the long-term condition', async () => {
    const e = (await as('viewer', 'GET', `/api/stability/evaluation?study=${studies.B26101}`)).json() as Evaluation;
    expect(e).toMatchObject({ scope: 'study', kind: 'shelf life' });
    expect(e.groups).toEqual([expect.objectContaining({ label: '30 °C / 75 % RH (India, zone IVb)', storage: 'room temperature', studies: ['STB25101'],
      tests: [expect.objectContaining({ key: 'assay', ok: true, model: 'single batch', used: ['B26101'] })], signRefusal: 'QA signs the evaluation (the QC approval permission).' })]);
    const lt = e.tables.find((x) => x.condition.startsWith('30 °C'))!;
    expect(lt.months).toEqual([0, 3, 6, 9, 12, 18, 24]);
    expect(Object.fromEntries(Object.entries(lt.rows[0]!.cells).map(([m, c]) => [m, c.figure]))).toEqual({ 0: '100.2 %', 3: '99.8 %', 6: '99.3 %', 9: '99.0 %', 12: '98.5 %' });
    expect(e.arrhenius).toEqual([]);
  });

  it('LIMS-29 a confirmed OOS of a stability sample and a negative trend on a marketed batch are to be reported, with the OOS number; QA answers whether a regulator notice is needed', async () => {
    const sid = samples['B26103:acc:6']!.id;
    const oos = ((await as('qcman', 'GET', `/api/samples/${sid}`)).json() as { oos: { id: number; oosNo: string }[] }).oos[0]!;
    const get = async (who: string) => (await as(who, 'GET', `/api/oos/${oos.id}`)).json() as { contentHash: string };
    const act = async (who: string, action: string, body: object = {}, signed?: boolean) =>
      ok(as(who, 'POST', `/api/oos/${oos.id}/${action}`, { ...body, ...(signed ? { proof: proofFor(who), contentHash: (await get(who)).contentHash } : {}) }));
    await act('analyst', 'checklist', { answers: yes });
    await act('analyst', 'conclude-phase1', { labError: false });
    await act('supervisor', 'review', {}, true);
    const an = samples['B26103:acc:6']!.analysisNo;
    await t.owner.unsafe(`insert into ${S.dv}.deviation_v1 (number, status, batch, batch_norm, title, closed_at) values ('DEV-26-0400', 'closed', '${an}', '${an.toLowerCase()}', 'Phase II', now())`);
    await act('supervisor', 'phase2', { reference: 'DEV-26-0400' });
    await act('qalead', 'conclude', { outcome: 'confirmed', reason: 'Degradation at 40 °C confirmed' }, true);
    const e = await product();
    expect(e.toReport.map((r) => [r.kind, r.lotNo, r.oosNo ?? null, r.marketed])).toEqual([['negative trend', 'B26103', null, true], ['confirmed OOS', 'B26103', oos.oosNo, true]]);
    const key = e.toReport.find((r) => r.oosNo)!.key;
    expect((await as('viewer', 'POST', '/api/stability/report-answers', { of: 'product', itemId: 'prd-201', key, needed: true, text: 'Field alert FA-26-01' })).statusCode).toBe(403);
    await ok(as('qcman', 'POST', '/api/stability/report-answers', { of: 'product', itemId: 'prd-201', key, needed: true, text: 'Field alert FA-26-01 filed by regulatory affairs' }));
    expect((await as('qcman', 'POST', '/api/stability/report-answers', { of: 'product', itemId: 'prd-201', key, needed: false, text: 'Again' })).statusCode).toBe(409);
    expect((await product()).toReport.find((r) => r.key === key)!.answer).toMatchObject({ needed: true });
    // The study screen shows it too.
    const s = (await as('viewer', 'GET', `/api/stability/evaluation?study=${studies.B26103}`)).json() as Evaluation;
    expect(s.toReport.map((r) => r.kind)).toEqual(['negative trend', 'confirmed OOS']);
    // The CTD table marks the failing result.
    expect(s.tables.find((x) => x.condition.startsWith('40 °C'))!.rows[0]!.cells[6]).toMatchObject({ figure: '94.0 %', pass: false });
  });

  it('LIMS-29 across the product\'s studies: Q1E with poolability; QA answers the decision tree and signs; the evaluation is kept insert-only and published in stability_v1', async () => {
    const e = await product();
    expect(e.scope).toBe('product');
    const g = e.groups[0]!;
    expect(g.studies).toEqual(['STB25101', 'STB25102', 'STB25103']);
    expect(g.tests[0]).toMatchObject({ ok: true, used: ['B26101', 'B26102', 'B26103'] });
    expect(g.signRefusal).toBeNull();
    const answers = { storage: 'room temperature', accelerated: 'significant change', intermediate: 'no significant change', statistics: 'performed' };
    const body = { scope: { of: 'product', itemId: 'prd-201' }, group: g.key, answers, transforms: {} };
    const preview = (await ok(as('viewer', 'POST', '/api/stability/evaluation/preview', body))).json() as { proposal: { months: number | null; test: string }; tests: { cap: string; branch: string }[] };
    expect(preview.tests[0]!.branch).toMatch(/significant change at accelerated, none at intermediate, statistical analysis performed/);
    expect(preview.proposal).toMatchObject({ test: 'Assay' });
    expect(preview.proposal.months).toBeGreaterThan(0);
    expect(preview.proposal.months).toBeLessThanOrEqual(18);
    expect((await as('viewer', 'POST', '/api/stability/evaluation/preview', { ...body, answers: { storage: 'room temperature' } })).json().answersRefusal).toMatch(/accelerated/);
    expect((await as('sampler', 'POST', '/api/stability/evaluations', { ...body, proof: proofFor('sampler'), contentHash: g.contentHash })).statusCode).toBe(403);
    const stale = await as('qcman', 'POST', '/api/stability/evaluations', { ...body, proof: proofFor('qcman'), contentHash: '0'.repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toMatch(/results changed/);
    const signed = await ok(as('qcman', 'POST', '/api/stability/evaluations', { ...body, proof: proofFor('qcman'), contentHash: g.contentHash }));
    const { id, months } = signed.json() as { id: number; months: number };
    expect(months).toBe(preview.proposal.months);
    expect((await t.owner`select meaning, printed_name from signatures where object_type = 'stability_evaluation' and object_id = ${id}`)[0]).toEqual({ meaning: 'qc_approved', printed_name: 'QCMAN' });
    const row = (await t.owner<{ inputs: { answers: object; results: unknown[] }; outputs: { proposal: { months: number } } }[]>`select inputs, outputs from stability_evaluations where id = ${id}`)[0]!;
    expect(row.inputs.answers).toEqual(answers);
    expect(row.inputs.results).toHaveLength(15);
    expect(row.outputs.proposal.months).toBe(months);
    await expect(t.owner`update stability_evaluations set months = 36 where id = ${id}`).rejects.toThrow();
    expect((await product()).evaluations).toEqual([expect.objectContaining({ id, months, kind: 'shelf life', printedName: 'QCMAN' })]);
    expect((await as('viewer', 'GET', '/api/stability/products')).json()).toEqual([{ of: 'product', itemId: 'prd-201', code: 'FG-201', name: 'Stabilol 50 mg tablets', studies: 3, months }]);
    const view = await t.owner.unsafe(`select study_number, item_kind, batch_number, protocol_number, conditions, last_time_point_months, status, shelf_life_months, retest_period_months,
      evaluation_condition from ${t.schema}_report.stability_v1 order by study_number`);
    expect(view).toEqual(['B26101', 'B26102', 'B26103'].map((b, n) => ({ study_number: `STB25${101 + n}`, item_kind: 'PRODUCT', batch_number: b, protocol_number: 'STP-FG-201',
      conditions: ['30/75 long-term', '40/75 accelerated'], last_time_point_months: 12, status: 'ON_STUDY', shelf_life_months: months, retest_period_months: null,
      evaluation_condition: '30 °C / 75 % RH (India, zone IVb)' })));
    expect((await t.owner.unsafe(`select study_id from ${t.schema}_report.stability_v1 where study_number = 'STB25101'`))[0]!.study_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('LIMS-29 the Arrhenius advisory shows when accelerated data exist, never as the label shelf life', async () => {
    const e = await product();
    expect(e.arrhenius).toEqual([expect.objectContaining({ ok: false, message: expect.stringMatching(/three or more different temperatures/), advisory: ADVISORY })]);
  });

  it('LIMS-29 the CTD tables (3.2.P.8.3) per batch, condition and time point, with the limits and the signed shelf life: CSV and PDF', async () => {
    const csv = await ok(as('viewer', 'GET', '/api/stability/ctd?of=product&itemId=prd-201&format=csv'));
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Section,Code,Name,Study,Batch,Protocol,Container closure,Placed,Condition,Role,Test,Acceptance criterion,Time point (months),Result,Complies,Sample,Analysis,QC decision,Out of trend,Shelf life (months)');
    // 3 batches × (7 long-term + 3 accelerated time points) × 1 test.
    expect(lines).toHaveLength(1 + 30);
    const months = (await product()).evaluations[0]!.months;
    expect(lines.find((l) => l.includes('STB25101') && l.includes(',12,')))
      .toMatch(new RegExp(`^3\\.2\\.P\\.8\\.3,FG-201,Stabilol 50 mg tablets,STB25101,B26101,STP-FG-201 v1,"HDPE bottle, 30 tablets",.*,"30 °C / 75 % RH \\(India, zone IVb\\)",long-term,Assay,95\\.0 to 105\\.0 %,12,98\\.5 %,yes,LS\\d+,LA\\d+,"reviewed, not yet decided",,${months}$`));
    expect(lines.find((l) => l.includes('STB25103') && l.includes('long-term') && l.includes(',12,'))).toMatch(/outside the 95 % prediction interval.*QC: investigation/);
    const pdf = await ok(as('viewer', 'GET', '/api/stability/ctd?of=product&itemId=prd-201&format=pdf'));
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
