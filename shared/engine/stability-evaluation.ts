/**
 * Stability evaluation (LIMS-29, LIMS-25; plan 2.6 and 2b items 3, 4, 7, 8): pure functions over the stability results
 * as read from the stability samples' reviewed analyses. Nothing here is stored or typed: the results are the analyses'
 * reportable values; the calculations are templates L15 (ICH Q1E shelf life), L22 (prediction interval, out of trend)
 * and L24 (Arrhenius, advisory only).
 */
import { Dec, fmt } from '../templates/core.js';
import { l15ShelfLife, l22PredictionInterval, l24Arrhenius, type L15Extrapolation, type Transform } from '../templates/lab-stability.js';
import { limitFor, limitWords, type SpecDoc, type SpecTest } from '../master/spec.js';
import type { ConditionCode } from '../master/protocol.js';

/** One stability result: a reviewed analysis's reportable value of one test of one stability sample. */
export interface ResultPoint {
  studyId: number; studyNo: string; lotNo: string;
  // The condition: its key in the protocol, its words, its code and role.
  condition: string; label: string; code: ConditionCode; role: string;
  month: number; testKey: string;
  sampleId: number; sampleNo: string; analysisNo: string;
  value: string; unit: string; shown: string; pass: boolean | null;
  // The sample's QC decision (null: reviewed, not yet decided).
  decided: 'approved' | 'rejected' | null;
}

/** A stability-indicating test: a test of the specification that applies on stability, with a numeric shelf-life limit. */
export interface NumericTest { key: string; name: string; low?: string; high?: string; unit: string; words: string }
export function numericTests(spec: SpecDoc): NumericTest[] {
  return spec.tests.flatMap((t: SpecTest) => {
    if (t.use === 'release' || t.limitType === 'conforms' || t.limitType === 'report only') return [];
    const l = limitFor(t, 'stability');
    if (!l || (l.low === undefined && l.high === undefined)) return [];
    return [{ key: t.key, name: t.name, unit: l.unit, words: limitWords(l), ...(l.low !== undefined ? { low: l.low } : {}), ...(l.high !== undefined ? { high: l.high } : {}) }];
  });
}

const q = (value: string, unit: string) => ({ value, unit });
const s = (d: Dec | undefined) => (d === undefined ? undefined : d.isFinite() ? d.toString() : 'Infinity');

// ---- L15: the Q1E evaluation of one test ----
export interface BatchSeries { studyId: number; studyNo: string; lotNo: string; points: ResultPoint[] }
export interface TestEvaluation {
  key: string; name: string; criterion: string; transform: Transform;
  used: string[]; notUsed: { lotNo: string; why: string }[];
  ok: boolean; message?: string;
  // Full precision as text ("Infinity": the bound never meets the criterion).
  estimate?: string; model?: string; limiting?: string; slopesP?: string; interceptsP?: string;
  branch?: string; cap?: string; proposed?: number; shown?: string;
}

/** Batches by study; a lot number that appears twice is named with its study. */
export function batchesOf(points: readonly ResultPoint[]): BatchSeries[] {
  const by = new Map<number, BatchSeries>();
  for (const p of points) {
    const b = by.get(p.studyId) ?? { studyId: p.studyId, studyNo: p.studyNo, lotNo: p.lotNo, points: [] };
    b.points.push(p);
    by.set(p.studyId, b);
  }
  const list = [...by.values()].sort((a, b) => a.studyNo.localeCompare(b.studyNo));
  return list.map((b) => ({ ...b, lotNo: list.filter((x) => x.lotNo === b.lotNo).length > 1 ? `${b.lotNo} (${b.studyNo})` : b.lotNo,
    points: [...b.points].sort((x, y) => x.month - y.month) }));
}

/**
 * ICH Q1E for one test at one long-term condition (template L15): the batches with at least 3 time points, pooled when
 * the poolability tests allow; the estimate, the bound, the limiting batch; with the decision-tree answers, the
 * proposed shelf life (the extrapolation cap, rounded down to whole months).
 */
export function evaluateTest(test: NumericTest, points: readonly ResultPoint[], transform: Transform = 'none', answers?: L15Extrapolation): TestEvaluation {
  const batches = batchesOf(points.filter((p) => p.testKey === test.key));
  const used = batches.filter((b) => new Set(b.points.map((p) => p.month)).size >= 3);
  const notUsed = batches.filter((b) => !used.includes(b)).map((b) => ({ lotNo: b.lotNo, why: `${new Set(b.points.map((p) => p.month)).size} time point(s): Q1E needs at least 3` }));
  const base = { key: test.key, name: test.name, criterion: test.words, transform, used: used.map((b) => b.lotNo), notUsed };
  if (!used.length) return { ...base, ok: false, message: 'No batch has 3 or more time points with reviewed results yet.' };
  const r = l15ShelfLife({
    batches: used.map((b) => ({ batch: b.lotNo, points: b.points.map((p) => ({ time: String(p.month), value: q(p.value, p.unit) })) })),
    criterion: { ...(test.low !== undefined ? { lower: q(test.low, test.unit) } : {}), ...(test.high !== undefined ? { upper: q(test.high, test.unit) } : {}) },
    transform, ...(answers ? { extrapolation: answers } : {}),
  });
  if (!r.ok) return { ...base, ok: false, message: r.message };
  return { ...base, ok: true, estimate: s(r.estimate), model: r.model, limiting: r.limiting, shown: r.shown,
    ...(r.slopesP ? { slopesP: fmt(r.slopesP, 3), interceptsP: fmt(r.interceptsP!, 3) } : {}),
    ...(r.branch ? { branch: r.branch, cap: s(r.cap) } : {}), ...(r.proposed ? { proposed: r.proposed.toNumber() } : {}) };
}

/** The group's proposal: the shortest proposed shelf life over its tests, with the test and batch that limit it; null with why. */
export function groupProposal(tests: readonly TestEvaluation[]): { months: number; test: string; limiting: string } | { months: null; why: string } {
  if (!tests.length) return { months: null, why: 'The specification has no stability test with a numeric limit.' };
  const bad = tests.find((t) => !t.ok);
  if (bad) return { months: null, why: `${bad.name}: ${bad.message}` };
  const missing = tests.find((t) => t.proposed === undefined);
  if (missing) return { months: null, why: 'Answer the Q1E decision tree first.' };
  const first = tests.reduce((a, b) => (b.proposed! < a.proposed! ? b : a));
  return { months: first.proposed!, test: first.name, limiting: first.limiting ?? '' };
}

/** The storage the long-term condition implies (the person confirms it). */
export const storageOf = (code: ConditionCode): L15Extrapolation['storage'] => (code === '5' ? 'refrigerated' : code === '-20' ? 'frozen' : 'room temperature');

/** Why the decision-tree answers are not complete for this storage; null when they are (template L15 asks the same). */
export function answersRefusal(a: L15Extrapolation): string | null {
  if (a.storage === 'frozen') return null;
  if (!a.accelerated) return 'Say whether the accelerated condition showed a significant change.';
  if (a.storage === 'room temperature' && a.accelerated === 'significant change' && !a.intermediate) return 'Say whether the intermediate condition showed a significant change.';
  if (a.accelerated === 'no significant change' && !a.change) return 'Say whether the data show little or no change and variability.';
  return null;
}

// ---- L22: out of trend (LIMS-25, plan 2b-3) ----
/**
 * Whether a stability result is outside the 95 % prediction interval of its batch's earlier results at the same
 * condition (template L22), and of the product's other batches there (pooled), when there are any; the words of the
 * flag, or null (in trend, or too few earlier results to judge).
 */
export function trendFlag(p: ResultPoint, all: readonly ResultPoint[]): string | null {
  const same = all.filter((x) => x.testKey === p.testKey && x.label === p.label);
  const earlier = same.filter((x) => x.studyId === p.studyId && x.month < p.month);
  const historical = batchesOf(same.filter((x) => x.studyId !== p.studyId))
    .map((b) => ({ batch: b.lotNo, points: b.points.map((x) => ({ time: String(x.month), value: q(x.value, x.unit) })) }));
  if (new Set(earlier.map((x) => x.month)).size < 3 && new Set(historical.flatMap((b) => b.points.map((x) => x.time))).size < 3) return null;
  const r = l22PredictionInterval({
    ...(earlier.length ? { batch: earlier.map((x) => ({ time: String(x.month), value: q(x.value, x.unit) })) } : {}),
    result: { time: String(p.month), value: q(p.value, p.unit) },
    ...(historical.length && new Set(historical.flatMap((b) => b.points.map((x) => x.time))).size >= 3 ? { historical } : {}),
  });
  if (!r.ok || !r.oot) return null;
  const dp = Math.max(1, (p.value.split('.')[1] ?? '').length);
  const out = [r.batchInterval && !r.batchInterval.within ? `this batch's earlier results ${fmt(r.batchInterval.low, dp)} to ${fmt(r.batchInterval.high, dp)}` : '',
    r.historicalInterval && !r.historicalInterval.within ? `the other batches ${fmt(r.historicalInterval.low, dp)} to ${fmt(r.historicalInterval.high, dp)}` : ''].filter(Boolean);
  return `outside the 95 % prediction interval of ${out.join(' and of ')}${p.unit ? ` ${p.unit}` : ''} (template L22)`;
}

// ---- L24: Arrhenius, advisory (plan 2b-4) ----
const CLIMATE: Partial<Record<ConditionCode, { t: string; rh?: string }>> = {
  '25/60': { t: '25', rh: '60' }, '30/65': { t: '30', rh: '65' }, '30/75': { t: '30', rh: '75' }, '40/75': { t: '40', rh: '75' }, '5': { t: '5' }, '-20': { t: '-20' },
};
export const ADVISORY = 'Advisory: for development decisions, not for the label (the label shelf life is ICH Q1E).';

/** Least-squares slope of value on months (all batches together), or null with fewer than 2 time points. */
function slope(points: readonly ResultPoint[]): Dec | null {
  if (new Set(points.map((p) => p.month)).size < 2) return null;
  const xs = points.map((p) => new Dec(p.month));
  const ys = points.map((p) => new Dec(p.value));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a.plus(b), new Dec(0)).div(n);
  const my = ys.reduce((a, b) => a.plus(b), new Dec(0)).div(n);
  const sxy = xs.reduce((a, x, k) => a.plus(x.minus(mx).times(ys[k]!.minus(my))), new Dec(0));
  const sxx = xs.reduce((a, x) => a.plus(x.minus(mx).pow(2)), new Dec(0));
  return sxy.div(sxx);
}

export interface ArrheniusResult { test: string; ok: boolean; message?: string; shown?: string; months?: string; rates: { label: string; rate: string }[]; advisory: string }
/**
 * Arrhenius (template L24) for one test of one protocol: the degradation rate at each condition with a temperature (the
 * slope of all its batches' results on time, in the direction of the limit), the allowed change from the mean initial
 * value to the limit, and the time to it at the long-term condition. With humidity when four or more conditions with
 * two humidities allow. Always advisory.
 */
export function arrhenius(test: NumericTest, points: readonly ResultPoint[], longTerm: ConditionCode): ArrheniusResult {
  const mine = points.filter((p) => p.testKey === test.key);
  const conditions = [...new Map(mine.map((p) => [p.label, p.code])).entries()].filter(([, c]) => CLIMATE[c]);
  const fail = (message: string, rates: ArrheniusResult['rates'] = []): ArrheniusResult => ({ test: test.name, ok: false, message, rates, advisory: ADVISORY });
  const store = CLIMATE[longTerm];
  if (!store) return fail('The long-term condition has no single temperature.');
  // The direction of degradation: towards the one limit, or (both limits) the way the hottest condition moves.
  const hottest = conditions.map(([label, c]) => ({ label, t: Number(CLIMATE[c]!.t) })).sort((a, b) => b.t - a.t)[0];
  const hotSlope = hottest ? slope(mine.filter((p) => p.label === hottest.label)) : null;
  const up = test.low === undefined ? true : test.high === undefined ? false : (hotSlope ?? new Dec(0)).gte(0);
  const rows = conditions.flatMap(([label, c]) => {
    const k = slope(mine.filter((p) => p.label === label));
    return k === null ? [] : [{ label, ...CLIMATE[c]!, rate: up ? k : k.neg() }];
  });
  const rates = rows.map((r) => ({ label: r.label, rate: `${fmt(r.rate, 5)}${test.unit ? ` ${test.unit}` : ''} per month` }));
  const initial = mine.filter((p) => p.month === 0);
  if (!initial.length) return fail('No initial (0-month) results: the allowed change cannot be worked out.', rates);
  const start = initial.reduce((a, p) => a.plus(new Dec(p.value)), new Dec(0)).div(initial.length);
  const allowed = up ? new Dec(test.high!).minus(start) : start.minus(new Dec(test.low!));
  if (!allowed.gt(0)) return fail('The initial results are already at the limit.', rates);
  const humid = rows.length >= 4 && rows.every((r) => r.rh) && new Set(rows.map((r) => r.rh)).size >= 2 && !!store.rh;
  const r = l24Arrhenius({
    points: rows.map((x) => ({ temperature: `${x.t} °C`, rate: `${x.rate.toString()} ${test.unit}/month`.replace(' /', '/'), ...(humid ? { rh: `${x.rh} %RH` } : {}) })),
    allowedChange: `${allowed.toString()}${test.unit ? ` ${test.unit}` : ''}`,
    storage: { temperature: `${store.t} °C`, ...(humid ? { rh: `${store.rh} %RH` } : {}) },
  });
  if (!r.ok) return fail(r.message, rates);
  return { test: test.name, ok: true, shown: r.shown, months: fmt(r.value, 1), rates, advisory: ADVISORY };
}

// ---- LIMS-29: what is to be reported ----
export interface ReportItem { key: string; kind: 'confirmed OOS' | 'negative trend'; studyId: number; studyNo: string; lotNo: string; label: string; month: number; test: string; what: string; oosNo?: string }
/** A confirmed OOS of a stability sample, or an out-of-trend result QC answered "investigation", on a marketed batch (or one whose state is not known). */
export function toReport(items: readonly ReportItem[], marketed: (lotNo: string) => boolean | null) {
  return items.flatMap((i) => {
    const m = marketed(i.lotNo);
    return m === false ? [] : [{ ...i, marketed: m }];
  });
}
