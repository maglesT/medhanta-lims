import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp, validatedOutside } from './helpers.js';
import { small } from './engine-fixture.js';
import { specSchema, type SpecDoc } from '../shared/master/spec.js';
import {
  TAT_DEFAULT_DAYS, TREND_MIN_HISTORY, addDays, assignRefusal, chartTrend, daysFrom, dueOn, kpis, summaryOf, type KpiAnalysis, type KpiSample,
} from '../shared/engine/trends.js';

// Trends, KPIs, the workload planner and the APQR data (plan 2.10, 2.11; LIMS-25, LIMS-42).

// ---- The rules (shared/engine/trends.ts) ----
const at = (s: string) => new Date(s);
const ten = ['6.0', '6.1', '5.9', '6.0', '6.1', '5.9', '6.0', '6.1', '5.9', '6.0'].map((value) => ({ value, unit: '' }));

describe('control chart flag of a new result', () => {
  it('LIMS-25 a new result breaking a Nelson rule against the earlier decided results is out of trend; within the pattern it is not', () => {
    // Ten earlier results: mean 6.0, MR̄ 1.2 ÷ 9 = 0.1333…, sigma 0.11820…, upper control limit 6.3546: 6.6 is beyond 3 sigma.
    expect(chartTrend(ten, { value: '6.6', unit: '' })).toBe('control chart of the last 10 decided results: Nelson rule 1 (one point more than 3 sigma from the centre line)');
    expect(chartTrend(ten, { value: '6.05', unit: '' })).toBeNull();
    // Out of the specification: an OOS, not a trend.
    expect(chartTrend(ten, { value: '7.4', unit: '' }, { low: '5.0', high: '7.0', unit: '' })).toBeNull();
    // Fewer than TREND_MIN_HISTORY earlier results: not trended yet.
    expect(TREND_MIN_HISTORY).toBe(10);
    expect(chartTrend(ten.slice(1), { value: '6.6', unit: '' })).toBeNull();
  });

  it('LIMS-42 the results summary: n, min, max, mean, sd and Cpk with a two-sided limit (hand-worked)', () => {
    // 6.0 6.1 5.9 6.0 6.1 5.9 6.0 6.1 5.9 6.0: mean 6.000, SD √(0.06 ÷ 9) = 0.0816; Cpk = 1.0 ÷ (3 × 0.13333 ÷ 1.128) = 2.82.
    expect(summaryOf(ten, { low: '5.0', high: '7.0', unit: '' })).toEqual({ n: 10, min: '5.900', max: '6.100', mean: '6.000', sd: '0.082', cpk: '2.82', rules: [] });
    expect(summaryOf([{ value: '6.2', unit: '' }])).toEqual({ n: 1, min: '6.200', max: '6.200', mean: '6.200', sd: null, cpk: null, rules: [] });
    expect(summaryOf([])).toMatchObject({ n: 0, mean: null });
  });
});

describe('KPIs', () => {
  const a = (o: Partial<KpiAnalysis>): KpiAnalysis => ({ analysisNo: 'LA', method: 'M-PH', analyst: 'Ana', issuedAt: at('2026-10-01T05:00:00Z'), finishedAt: at('2026-10-05T05:00:00Z'),
    reviewed: true, stopped: false, invalidated: false, corrected: false, oos: false, ...o });
  const s = (o: Partial<KpiSample>): KpiSample => ({ sampleNo: 'LS', purpose: 'release', receivedAt: at('2026-10-01T04:30:00Z'), decidedAt: at('2026-10-06T04:30:00Z'), disposed: false, ...o });
  it('right first time, OOS rate, invalid-run rate per month and per analyst and method; turnaround against the target; the backlog by age', () => {
    const analyses = [
      a({}), a({ corrected: true }), a({ oos: true, analyst: 'Ben' }), a({ reviewed: false, stopped: true, method: 'M-KF' }),
      a({ invalidated: true }), a({ finishedAt: null, reviewed: false }),
      a({ finishedAt: at('2026-11-02T05:00:00Z'), analyst: 'Ben' }),
    ];
    const samples = [
      s({}),                                                                              // 5 days: within 10
      s({ decidedAt: at('2026-10-20T04:30:00Z') }),                                       // 19 days: over
      s({ purpose: 'monitoring', receivedAt: at('2026-10-01T04:30:00Z'), decidedAt: at('2026-10-04T04:30:00Z') }), // 3 days: within 7
      s({ sampleNo: 'LS-OPEN1', decidedAt: null, receivedAt: at('2026-11-15T04:30:00Z') }),   // 3 days old
      s({ sampleNo: 'LS-OPEN2', decidedAt: null, receivedAt: at('2026-10-10T04:30:00Z') }),   // 39 days old: over 10
      s({ sampleNo: 'LS-GONE', decidedAt: null, disposed: true }),
    ];
    const k = kpis(analyses, samples, { from: '2026-10', to: '2026-11', targets: TAT_DEFAULT_DAYS, today: '2026-11-18' });
    // October: 5 finished (the open one is not); reviewed 4 (one stopped); right first time 2 of 5 (corrected and invalidated
    // are not; the OOS one is: it was not corrected) → 40.0 %; OOS 1 of 4 reviewed = 25.0 %; invalid 2 of 5 = 40.0 %.
    expect(k.months[0]).toEqual({ month: '2026-10', finished: 5, rightFirstTime: 2, rftPct: 40, reviewed: 4, oos: 1, oosPct: 25, invalid: 2, invalidPct: 40,
      decided: 3, tatMeanDays: 9, tatWithin: 2, tatPct: 66.7 });
    expect(k.months[1]).toMatchObject({ month: '2026-11', finished: 1, rightFirstTime: 1, rftPct: 100, decided: 0, tatMeanDays: null, tatPct: null });
    expect(k.byAnalyst.map((x) => [x.analyst, x.finished, x.rightFirstTime, x.oos])).toEqual([['Ana', 4, 1, 0], ['Ben', 2, 2, 1]]);
    expect(k.byTest.map((x) => [x.method, x.finished, x.invalid])).toEqual([['M-KF', 1, 1], ['M-PH', 5, 1]]);
    expect(k.backlog.map((b) => [b.sampleNo, b.ageDays, b.due, b.over])).toEqual([['LS-OPEN2', 39, '2026-10-20', true], ['LS-OPEN1', 3, '2026-11-25', false]]);
    expect(k.buckets).toEqual([{ label: '0 to 7 days', count: 1, over: 0 }, { label: '8 to 14 days', count: 0, over: 0 }, { label: '15 to 30 days', count: 0, over: 0 },
      { label: 'over 30 days', count: 1, over: 1 }]);
  });
  it('plant dates: due on the plant date received plus the target', () => {
    // 20:00 UTC on 31 Oct is 1 Nov in the plant (IST).
    expect(dueOn(at('2026-10-31T20:00:00Z'), 10)).toBe('2026-11-11');
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(daysFrom('2026-10-10', '2026-11-18')).toBe(39);
  });
  it('the analyst must be trained in the method\'s skills while Recruitment answers; not checked while it does not', () => {
    const skills = [{ code: 'SOP-QC-012', title: 'pH measurement' }];
    expect(assignRefusal('Ana', skills, { state: 'ok', qualified: { 'SOP-QC-012': true } })).toBeNull();
    expect(assignRefusal('Ana', skills, { state: 'ok', qualified: {} })).toBe('Ana has no valid training in SOP-QC-012 pH measurement (Recruitment).');
    expect(assignRefusal('Ana', skills, { state: 'down' })).toBeNull();
    expect(assignRefusal('Ana', [], { state: 'ok', qualified: {} })).toBeNull();
  });
});

// ---- On the server ----
let t: TestApp;
const cookies: Record<string, string> = {};
const MAT = '00000000-0000-0000-0000-0000000000d1';
beforeAll(async () => {
  t = await freshApp();
  t.master.materials_.push({ itemId: MAT, code: 'RM-081', name: 'Trendolol', version: 1, active: true, category: 'API', unit: 'kg' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register'], sampler2: ['lims.sample.register'], analyst: ['lims.analysis.perform'], reviewer: ['lims.analysis.review'],
    qcuser: ['lims.qc.approve', 'lims.view'], viewer: ['lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
}, 60_000);
afterAll(() => t.close());

const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
async function effective(kind: 'method' | 'spec', doc: object) {
  const r = await as('author', 'POST', '/api/masters', { kind, doc });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number; masterId: number };
  const hash = async (who: string) => ((await as(who, 'GET', `/api/master-versions/${v.id}/review`)).json() as { contentHash: string }).contentHash;
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-081' }]] as const) {
    expect((await as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hash(who), ...x })).statusCode).toBe(200);
  }
  await validatedOutside(t.owner, v.id);
  expect((await as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
  return v;
}
let method = { id: 0, masterId: 0 };
let specId = 0;
let n = 0;
async function sampleOf() {
  const r = await as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: `RM81-${String(++n).padStart(3, '0')}`, byHand: true, itemId: MAT, specVersionId: specId, quantity: '30 g', received: 1, sampled: [1] });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  expect((await as('sampler2', 'POST', `/api/samples/${id}/check`, {})).statusCode).toBe(200);
  expect((await as('sampler', 'POST', `/api/samples/${id}/receive`, { condition: 'Sealed' })).statusCode).toBe(200);
  return id;
}
async function analysed(sampleId: number, reading: string) {
  const r = await as('analyst', 'POST', '/api/analyses', { masterVersionId: method.id, sampleId, proof: proofFor('analyst') });
  expect(r.statusCode, r.body).toBe(200);
  const { id } = r.json() as { id: number };
  const step = (action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  expect((await step('start')).statusCode).toBe(200);
  expect((await step('record', { values: { reading } })).statusCode).toBe(200);
  const d = (await as('analyst', 'GET', `/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] };
  expect((await step('done', { proof: proofFor('analyst'), contentHash: d.steps[0]!.contentHash })).statusCode).toBe(200);
  const a = (await as('reviewer', 'GET', `/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
  expect((await as('reviewer', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('reviewer'), contentHash: a.analysis.contentHash })).statusCode).toBe(200);
  return id;
}
type Detail = { decisionHash: string; approvalProblems: string[]; oot: { key: string; trend: string }[] };
const detail = async (id: number) => (await as('qcuser', 'GET', `/api/samples/${id}`)).json() as Detail;
const approve = async (id: number) => as('qcuser', 'POST', `/api/samples/${id}/approve`, { proof: proofFor('qcuser'), contentHash: (await detail(id)).decisionHash });
const spec = (m: number): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: MAT, code: 'RM-081', name: 'Trendolol', type: 'Active substance', number: 'SPEC-RM-081', pharmacopoeia: 'Ph. Int.', sampling: { plan: 'square root' } },
  tests: [{ key: 'ph', name: 'pH', method: { masterId: m, code: 'M-PH', name: 'pH' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' } }],
});

describe('trends on the server', () => {
  let flagged = 0;
  beforeAll(async () => {
    method = await effective('method', small([{ role: 'Analyst', steps: [{ key: 'ph', block: { id: 'check', version: 1 }, settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]));
    specId = (await effective('spec', spec(method.masterId))).id;
    // Ten decided lots: 6.0 6.1 5.9 … (the chart's baseline).
    for (const v of ten) {
      const sid = await sampleOf();
      await analysed(sid, v.value);
      expect((await approve(sid)).statusCode).toBe(200);
    }
  }, 120_000);

  it('LIMS-25 a reviewed result breaking a Nelson rule on the control chart of the earlier decided results raises the sample\'s OOT flag; QC answers it before approval', async () => {
    const quiet = await sampleOf();
    await analysed(quiet, '6.05');
    expect((await detail(quiet)).oot).toEqual([]);
    flagged = await sampleOf();
    await analysed(flagged, '6.6');
    const d = await detail(flagged);
    expect(d.oot.map((o) => [o.key, o.trend])).toEqual([['ph', 'control chart of the last 10 decided results: Nelson rule 1 (one point more than 3 sigma from the centre line)']]);
    expect(d.approvalProblems.some((p) => p.includes('is out of trend'))).toBe(true);
    expect((await as('qcuser', 'POST', `/api/samples/${flagged}/oot`, { test: 'ph', answer: 'investigation', reason: 'Buffer lot changed: checked under the OOT procedure' })).statusCode).toBe(200);
    expect((await detail(flagged)).approvalProblems).toEqual([]);
    expect((await approve(flagged)).statusCode).toBe(200);
    // Decided, the flag stays as it was (judged against the results decided before it).
    expect((await detail(flagged)).oot).toHaveLength(1);
  });

  it('LIMS-25 the control chart of the material\'s pH: the decided results, the limits, the specification and the rule break with its point', async () => {
    const series = (await as('viewer', 'GET', '/api/trends/series')).json() as { series: string; testKey: string; n: number }[];
    expect(series).toEqual([expect.objectContaining({ series: 'material:RM-081', testKey: 'ph', n: 11 })]);
    const c = (await as('viewer', 'GET', '/api/trends/chart?series=material:RM-081&test=ph')).json() as {
      points: { n: number; value: string; oot: string | null }[]; spec: { number: string; limit: { low: string; high: string } };
      chart: { mean: string; specLow: string; specHigh: string; breaks: { rule: number; points: number[] }[] } };
    expect(c.points.map((p) => Number(p.value))).toEqual([...ten.map((x) => Number(x.value)), 6.6]);
    expect(c.points.at(-1)!.oot).toBe('investigation');
    expect(c.spec).toMatchObject({ number: 'SPEC-RM-081', limit: { low: '5.0', high: '7.0' } });
    expect([c.chart.specLow, c.chart.specHigh]).toEqual(['5', '7']);
    // All 11: mean 66.6 ÷ 11 = 6.0545…; MR̄ (1.2 + 0.6) ÷ 10 = 0.18, sigma 0.15957…: 6.6 is 3.42 sigma above.
    expect(Number(c.chart.mean).toFixed(4)).toBe('6.0545');
    expect(c.chart.breaks.find((b) => b.rule === 1)?.points).toEqual([11]);
  });

  it('LIMS-42 trend_v1 publishes each decided result with its lot, value, limits and OOS/OOT flags', async () => {
    const rows = await t.owner.unsafe(`select lot_number, test_key, value::text, limit_text, limit_low, limit_high, result_status, out_of_trend, oot_answer, oos_number, spec_number, decision, purpose, item_code
      from ${t.schema}_report.trend_v1 where item_code = 'RM-081' order by decided_at`);
    expect(rows).toHaveLength(11);
    expect(rows.at(-1)).toEqual({ lot_number: 'RM81-012', test_key: 'ph', value: '6.6', limit_text: '5.0 to 7.0', limit_low: '5.0', limit_high: '7.0', result_status: 'PASS',
      out_of_trend: true, oot_answer: 'INVESTIGATION', oos_number: null, spec_number: 'SPEC-RM-081', decision: 'APPROVED', purpose: 'release', item_code: 'RM-081' });
    const [{ id }] = (await t.owner.unsafe(`select trend_id::text as id from ${t.schema}_report.trend_v1 limit 1`)) as unknown as [{ id: string }];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('LIMS-42 the APQR summary of the material over a period: results with Cpk, lots, OOT, the specification and method made effective, exported as CSV and PDF', async () => {
    const q = `of=material&code=RM-081&from=2026-01-01&to=2099-12-31`;
    const r = (await as('viewer', 'GET', `/api/apqr?${q}`)).json() as {
      results: { name: string; n: number; mean: string; cpk: string | null; rules: number[] }[]; lots: unknown[]; failed: unknown[]; oot: { answer: string }[];
      changes: { kind: string; number: string; changeControl: string }[]; oos: unknown[] };
    expect(r.results).toEqual([expect.objectContaining({ name: 'pH', n: 11, mean: '6.055', rules: [1] })]);
    expect(r.results[0]!.cpk).not.toBeNull();
    expect(r.lots).toHaveLength(11);
    expect(r.failed).toEqual([]);
    expect(r.oot.map((o) => o.answer)).toEqual(['investigation']);
    expect(r.changes.map((c) => [c.kind, c.number, c.changeControl])).toEqual([['method', 'M', 'CC-2026-081'], ['spec', 'SPEC-RM-081', 'CC-2026-081']]);
    const csv = await as('viewer', 'GET', `/api/apqr?${q}&format=csv`);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.body).toContain('Results,pH,5.0 to 7.0,11,0,11,5.900,6.600,6.055');
    expect(csv.body).toContain('OOT,LS');
    const pdf = await as('viewer', 'GET', `/api/apqr?${q}&format=pdf`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('KPIs and the turnaround target QC sets (insert-only; the latest applies)', async () => {
    const k = (await as('viewer', 'GET', '/api/kpis')).json() as { months: { finished: number; rightFirstTime: number }[]; targets: { purpose: string; days: number }[] };
    const all = k.months.reduce((s, m) => s + m.finished, 0);
    expect(all).toBe(12);
    expect(k.months.reduce((s, m) => s + m.rightFirstTime, 0)).toBe(12);
    expect(k.targets.find((x) => x.purpose === 'release')!.days).toBe(10);
    expect((await as('viewer', 'POST', '/api/kpis/targets', { purpose: 'release', days: 7 })).statusCode).toBe(403);
    expect((await as('qcuser', 'POST', '/api/kpis/targets', { purpose: 'release', days: 7 })).statusCode).toBe(200);
    expect(((await as('viewer', 'GET', '/api/kpis/targets')).json() as { purpose: string; days: number }[]).find((x) => x.purpose === 'release')!.days).toBe(7);
    await expect(t.owner`update tat_targets set days = 1`).rejects.toThrow();
  });

  it('the workload planner: an open sample\'s method assigned to an analyst shows on their work; assigned again is a new entry', async () => {
    const sid = await sampleOf();
    const w = (await as('reviewer', 'GET', '/api/workload')).json() as { rows: { sampleId: number; methodMasterId: number; due: string; assigned: unknown }[]; analysts: { id: number; name: string }[]; link: string };
    const row = w.rows.find((r) => r.sampleId === sid)!;
    expect(row).toMatchObject({ methodMasterId: method.masterId, assigned: null });
    const analyst = w.analysts.find((a) => a.name === 'ANALYST')!;
    expect((await as('viewer', 'POST', '/api/workload/assign', { sampleId: sid, methodMasterId: method.masterId, analystId: analyst.id })).statusCode).toBe(403);
    const r = await as('reviewer', 'POST', '/api/workload/assign', { sampleId: sid, methodMasterId: method.masterId, analystId: analyst.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().training).toEqual({ checked: 'the method names no training' });
    expect((await as('reviewer', 'POST', '/api/workload/assign', { sampleId: sid, methodMasterId: method.masterId, analystId: analyst.id })).json().message).toMatch(/is already assigned to ANALYST/);
    const mine = (await as('analyst', 'GET', '/api/workload/mine')).json() as { sampleId: number; due: string; method: { code: string } }[];
    expect(mine.map((m) => [m.sampleId, m.method.code, m.due])).toEqual([[sid, 'M', row.due]]);
    // Once its analysis is reviewed, it leaves the planner and the analyst's list.
    await analysed(sid, '6.0');
    expect((await as('analyst', 'GET', '/api/workload/mine')).json()).toEqual([]);
    await expect(t.owner`delete from lab_assignments`).rejects.toThrow();
  });
});
