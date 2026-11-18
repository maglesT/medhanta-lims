import { describe, expect, it } from 'vitest';
import {
  fUpperP, l15ShelfLife, l22PredictionInterval, l23Mkt, l24Arrhenius, l25DesignCheck, monthsOf,
  type L15Input, type L25Input, type StabilityPoint,
} from '../../shared/templates/lab-stability.js';
import { callTemplate, TEMPLATES } from '../../shared/engine/templates.js';
import { Dec } from '../../shared/templates/dec.js';
import { ok, refused } from './helpers.js';

const d = (x: string | number): Dec => new Dec(x);
const TIMES = ['0', '3', '6', '9', '12', '18'];
const pts = (values: string[], unit = '%', times = TIMES): StabilityPoint[] => values.map((v, k) => ({ time: times[k] as string, value: `${v} ${unit}` }));

// ================================================================ L15 ICH Q1E shelf life
// Own constructed assay data (% of label claim), long-term 25 °C/60 %RH, time points 0, 3, 6, 9, 12, 18 months.
// Every batch: x̄ = 8, Sxx = 64 + 25 + 4 + 1 + 16 + 100 = 210.
// Independent check: a separate float calculation (plain least squares, the bound solved by bisection, t from the
// printed table, the F p-value by Simpson integration of the F density) gave the figures quoted below.
const A = pts(['100.2', '99.8', '99.5', '99.1', '98.9', '98.2']);
const B = pts(['100.0', '99.7', '99.2', '99.0', '98.6', '98.0']);
const C = pts(['100.4', '99.9', '99.7', '99.2', '99.0', '98.3']);
const D = pts(['100.1', '99.0', '98.1', '96.9', '96.0', '94.1']); // a faster-degrading batch
// A scattered set whose batches pool.
const P = pts(['100.3', '99.6', '99.7', '99.0', '99.1', '98.2']);
const Qb = pts(['99.9', '99.9', '99.3', '99.4', '98.7', '98.3']);
const R = pts(['100.1', '99.6', '99.6', '99.1', '98.8', '98.1']);

const l15 = (over: Partial<L15Input> = {}): L15Input => ({ batches: [{ batch: 'A', points: A }], criterion: { lower: '95.0 %' }, ...over });

describe('L15 ICH Q1E shelf life', () => {
  it('L15 one batch: least squares and the one-sided 95 % lower bound of the mean meet 95.0 % at 44.6 months', () => {
    // Batch A: ȳ = 595.7 ÷ 6 = 99.28333; Sxy = Σ (x − 8)(y − ȳ) = −22.9; slope b = −22.9 ÷ 210 = −0.109048 %/month;
    // intercept a = 99.28333 + 0.109048 × 8 = 100.155714; Syy = 2.508333; SSE = Syy − b × Sxy = 2.508333 − 2.497190
    // = 0.011143; s = √(0.011143 ÷ 4) = 0.052780; t(0.95; 4) = 2.132.
    // Bound(t) = a + b t − 2.132 × s × √(1/6 + (t − 8)² ÷ 210) = 95.0 at t = 44.637 months (float check: 44.63684).
    const r = ok(l15ShelfLife(l15()));
    expect(r.model).toBe('single batch');
    expect(r.batches[0]!.slope.toFixed(6)).toBe('-0.109048');
    expect(r.batches[0]!.intercept.toFixed(6)).toBe('100.155714');
    expect(r.batches[0]!.residualSd.toFixed(6)).toBe('0.052780');
    expect(r.lines[0]!.t.toFixed(3)).toBe('2.132');
    expect(r.estimate.toFixed(2)).toBe('44.64');
    expect(r.value.toFixed(2)).toBe('44.64'); // no extrapolation asked: the value is the estimate
    expect(r.unit).toBe('months');
    expect(r.slopesP).toBeUndefined();
    expect(r.shown).toContain('one-sided 95 % lower confidence bound of the mean');
    expect(r.shown).toContain('44.6 months');
    expect(r.shown).toContain('estimated shelf life 44 months (rounded down)');
  });

  it('L15 log transform: ln(assay) regressed on time, bound meets ln 95.0 at 45.4 months', () => {
    // ln y: slope −0.00109940 per month, intercept 4.6067517, s = 0.00052181; ln 95 = 4.5538769;
    // bound meets it at 45.447 months (float check: 45.44705).
    const r = ok(l15ShelfLife(l15({ transform: 'log' })));
    expect(r.batches[0]!.slope.toFixed(7)).toBe('-0.0010994');
    expect(r.estimate.toFixed(2)).toBe('45.45');
    expect(r.shown).toContain('ln(value) regressed on time');
  });

  it('L15 poolability: equal slopes (p 0.783) but different intercepts (p < 0.25): common slope, earliest batch B 43.1 months', () => {
    // Full model (3 separate lines): SSE = 0.058000, df = 18 − 6 = 12, MSE = 0.0048333.
    // Common slope: ΣSxy = −70.3, ΣSxx = 630, b = −0.1115873; SSE = ΣSyy − b ΣSxy = 0.0604127 (df 14).
    // One line: SSE = 0.3981905 (df 16).
    // Slopes: F = (0.0604127 − 0.058) ÷ 2 ÷ 0.0048333 = 0.24959 on (2, 12): p = 0.78307.
    // Intercepts: F = (0.3981905 − 0.0604127) ÷ 2 ÷ 0.0048333 = 34.943 on (2, 12): p = 0.0000099.
    // Common-slope lines, s = √(0.0604127 ÷ 14) = 0.0656901, t(0.95; 14) = 1.761, var = s²(1/6 + (t − 8)² ÷ 630):
    // A meets 95.0 at 44.807, B at 43.084, C at 45.957 months: B limits.
    const r = ok(l15ShelfLife(l15({ batches: [{ batch: 'A', points: A }, { batch: 'B', points: B }, { batch: 'C', points: C }] })));
    expect(r.model).toBe('common slope');
    expect(r.slopesP!.toFixed(4)).toBe('0.7831');
    expect(r.interceptsP!.lt('0.0001')).toBe(true);
    expect(r.lines.map((l) => l.slope.toFixed(6))).toEqual(['-0.111587', '-0.111587', '-0.111587']);
    expect(r.lines[0]!.residualSd.toFixed(6)).toBe('0.065690');
    expect(r.lines[0]!.df.toString()).toBe('14');
    expect(r.lines.map((l) => l.meets.toFixed(2))).toEqual(['44.81', '43.08', '45.96']);
    expect(r.limiting).toBe('B (lower)');
    expect(r.estimate.toFixed(2)).toBe('43.08');
    expect(r.batches.map((b) => b.slope.toFixed(5))).toEqual(['-0.10905', '-0.11190', '-0.11381']);
  });

  it('L15 poolability: slopes and intercepts equal (p 0.756, 0.641): one pooled line, 44.9 months', () => {
    // Full SSE = 0.404714 (df 12, MSE 0.0337262); common slope SSE = 0.423984; one line SSE = 0.455095 (df 16).
    // Slopes F = 0.28568 on (2, 12): p = 0.75647. Intercepts F = 0.46123: p = 0.64123. Both ≥ 0.25: pooled.
    // Pooled: x̄ = 8, Sxx = 630, Sxy = −65.2, b = −0.1034921, a = 100.0890476, s = √(0.455095 ÷ 16) = 0.168652,
    // t(0.95; 16) = 1.746; bound a + b t − 1.746 s √(1/18 + (t − 8)² ÷ 630) = 95.0 at 44.933 months.
    const r = ok(l15ShelfLife(l15({ batches: [{ batch: 'P', points: P }, { batch: 'Q', points: Qb }, { batch: 'R', points: R }] })));
    expect(r.model).toBe('pooled');
    expect(r.slopesP!.toFixed(4)).toBe('0.7565');
    expect(r.interceptsP!.toFixed(4)).toBe('0.6412');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.line).toBe('all batches');
    expect(r.lines[0]!.slope.toFixed(7)).toBe('-0.1034921');
    expect(r.lines[0]!.intercept.toFixed(7)).toBe('100.0890476');
    expect(r.lines[0]!.residualSd.toFixed(6)).toBe('0.168652');
    expect(r.estimate.toFixed(1)).toBe('44.9');
    expect(r.shown).toContain('batches pooled, one line');
  });

  it('L15 slopes differ (p < 0.25): each batch on its own, the shortest batch D at 14.7 months', () => {
    // D: slope −0.3338095, own s = 0.091223 (df 4), t = 2.132: 14.730 months; A 44.637; B 41.447.
    const r = ok(l15ShelfLife(l15({ batches: [{ batch: 'A', points: A }, { batch: 'B', points: B }, { batch: 'D', points: D }] })));
    expect(r.model).toBe('separate');
    expect(r.slopesP!.lt('0.25')).toBe(true);
    expect(r.lines.map((l) => l.meets.toFixed(2))).toEqual(['44.64', '41.45', '14.73']);
    expect(r.limiting).toBe('D (lower)');
    expect(r.shown).toContain('the shortest batch counts');
  });

  it('L15 separate lines with the residual SD of all batches (separateMse "all batches")', () => {
    // MSE of the full model = 0.063 ÷ 12 = 0.00525, s = 0.072457, df 12, t(0.95; 12) = 1.782.
    const r = ok(l15ShelfLife(l15({ separateMse: 'all batches', batches: [{ batch: 'A', points: A }, { batch: 'B', points: B }, { batch: 'D', points: D }] })));
    expect(r.lines[0]!.residualSd.toFixed(6)).toBe('0.072457');
    expect(r.lines[0]!.df.toString()).toBe('12');
    expect(r.lines[0]!.t.toFixed(3)).toBe('1.782');
  });

  it('L15 an upper criterion: impurity NMT 0.5 %, one-sided upper bound meets it at 26.9 months', () => {
    // 0.10, 0.14, 0.19, 0.22, 0.27, 0.36 %: b = 0.0143810, a = 0.0982857, s = 0.0050709, t = 2.132;
    // a + b t + 2.132 s √(1/6 + (t − 8)² ÷ 210) = 0.5 at 26.906 months.
    const r = ok(l15ShelfLife(l15({ batches: [{ batch: 'A', points: pts(['0.10', '0.14', '0.19', '0.22', '0.27', '0.36']) }], criterion: { upper: '0.5 %' } })));
    expect(r.lines[0]!.side).toBe('upper');
    expect(r.estimate.toFixed(2)).toBe('26.91');
    expect(r.shown).toContain('one-sided 95 % upper confidence bound');
  });

  it('L15 both criteria: two-sided limits (t at 0.975), the earlier side counts', () => {
    // Common-slope model as above, t(0.975; 14) = 2.145 instead of 1.761: B meets 95.0 earlier, at 42.8 months.
    const r = ok(l15ShelfLife(l15({ batches: [{ batch: 'A', points: A }, { batch: 'B', points: B }, { batch: 'C', points: C }], criterion: { lower: '95.0 %', upper: '105.0 %' } })));
    expect(r.lines[0]!.t.toFixed(3)).toBe('2.145');
    expect(r.lines).toHaveLength(6);
    expect(r.estimate.toFixed(1)).toBe('42.8');
    expect(r.limiting).toBe('B (lower)');
    expect(r.shown).toContain('two-sided 95 % confidence limits');
  });

  it('L15 a bound that never meets the criterion: the attribute does not limit the shelf life', () => {
    // A decreasing assay against an upper criterion only.
    const r = ok(l15ShelfLife(l15({ criterion: { upper: '105.0 %' } })));
    expect(r.estimate.isFinite()).toBe(false);
    expect(r.shown).toContain('does not limit the shelf life');
    // With the Q1E tree the proposal is the cap (X = 18: min(36, 30) = 30).
    const e = ok(l15ShelfLife(l15({ criterion: { upper: '105.0 %' }, extrapolation: { storage: 'room temperature', accelerated: 'no significant change', change: 'little or none' } })));
    expect(e.proposed!.toString()).toBe('30');
    expect(e.value.toString()).toBe('30');
  });

  it('L15 a bound already outside the criterion at month 0 gives 0 months', () => {
    const r = ok(l15ShelfLife(l15({ criterion: { lower: '100.1 %' } })));
    expect(r.estimate.toString()).toBe('0');
    expect(r.shown).toContain('already outside at month 0');
  });

  // Q1E Appendix A with X = 18 months (latest time point) and the single-batch estimate 44.64 months.
  it.each([
    ['room temperature, no SC accelerated, little change: 2X, NMT X + 12', { storage: 'room temperature', accelerated: 'no significant change', change: 'little or none' }, '30', 'little or no change'],
    ['room temperature, change, statistics performed: 2X, NMT X + 12', { storage: 'room temperature', accelerated: 'no significant change', change: 'change or variability' }, '30', 'statistical analysis performed'],
    ['room temperature, change, not amenable: 1.5X, NMT X + 6', { storage: 'room temperature', accelerated: 'no significant change', change: 'change or variability', statistics: 'not amenable' }, '24', 'not amenable'],
    ['room temperature, SC accelerated, none at intermediate, statistics: 1.5X, NMT X + 6', { storage: 'room temperature', accelerated: 'significant change', intermediate: 'no significant change' }, '24', 'none at intermediate'],
    ['room temperature, SC accelerated, none at intermediate, not amenable: X + 3', { storage: 'room temperature', accelerated: 'significant change', intermediate: 'no significant change', statistics: 'not amenable' }, '21', 'X + 3'],
    ['room temperature, SC accelerated and intermediate: no extrapolation', { storage: 'room temperature', accelerated: 'significant change', intermediate: 'significant change' }, '18', 'no extrapolation'],
    ['refrigerated, no SC accelerated, little change: 1.5X, NMT X + 6', { storage: 'refrigerated', accelerated: 'no significant change', change: 'little or none' }, '24', 'refrigerated'],
    ['refrigerated, change, not amenable: X + 3', { storage: 'refrigerated', accelerated: 'no significant change', change: 'change or variability', statistics: 'not amenable' }, '21', 'X + 3'],
    ['refrigerated, SC accelerated: no extrapolation', { storage: 'refrigerated', accelerated: 'significant change' }, '18', 'no extrapolation'],
    ['frozen: long-term data only', { storage: 'frozen' }, '18', 'frozen'],
  ] as const)('L15 Q1E branch %s', (_name, extrapolation, cap, word) => {
    // 2X = 36, X + 12 = 30 → 30; 1.5X = 27, X + 6 = 24 → 24; X + 3 = 21; X = 18. Estimate 44.64 > cap: proposed = cap.
    const r = ok(l15ShelfLife(l15({ extrapolation })));
    expect(r.cap!.toString()).toBe(cap);
    expect(r.proposed!.toString()).toBe(cap);
    expect(r.value.toString()).toBe(cap);
    expect(r.longTerm!.toString()).toBe('18');
    expect(r.shown).toContain(word);
    expect(r.branch).toBeDefined();
  });

  it('L15 extrapolation never beyond the statistical estimate; X given; 1.5 X rounded down', () => {
    // D alone: estimate 14.73 < cap 30: proposed 14 (rounded down).
    const r = ok(l15ShelfLife(l15({ batches: [{ batch: 'D', points: D }], extrapolation: { storage: 'room temperature', accelerated: 'no significant change', change: 'change or variability' } })));
    expect(r.proposed!.toString()).toBe('14');
    expect(r.shown).toContain('the statistical estimate');
    // X = 21 given (data to 18 reported, 21 months covered): refrigerated 1.5X = 31.5, X + 6 = 27 → 27.
    const x = ok(l15ShelfLife(l15({ extrapolation: { storage: 'refrigerated', accelerated: 'no significant change', change: 'little or none', longTerm: '21 months' } })));
    expect(x.cap!.toString()).toBe('27');
    // Data to 9 months: 1.5 × 9 = 13.5 < 9 + 6 = 15 → cap 13.5, proposed 13.
    const n = ok(l15ShelfLife(l15({ batches: [{ batch: 'A', points: A.slice(0, 4) }], extrapolation: { storage: 'refrigerated', accelerated: 'no significant change', change: 'little or none' } })));
    expect(n.cap!.toString()).toBe('13.5');
    expect(n.proposed!.toString()).toBe('13');
  });

  it('L15 time points written "6 months" or "6 mo" and values in another fraction unit (mg/g) give the same result', () => {
    const mg = A.map((p, k) => ({ time: `${TIMES[k]} ${k % 2 === 0 ? 'months' : 'mo'}`, value: `${d((p.value as string).split(' ')[0]!).times(10).toString()} mg/g` }));
    const r = ok(l15ShelfLife(l15({ batches: [{ batch: 'A', points: mg }] })));
    expect(r.estimate.toFixed(2)).toBe('44.64');
  });

  it.each([
    ['fewer than 3 time points', l15({ batches: [{ batch: 'A', points: A.slice(0, 2) }] }), 'fewer than 3 time points'],
    ['3 results at only 2 time points', l15({ batches: [{ batch: 'A', points: pts(['100', '99.9', '99.5'], '%', ['0', '0', '3']) }] }), 'fewer than 3 time points'],
    ['no criterion', l15({ criterion: {} }), 'acceptance criterion'],
    ['lower above upper', l15({ criterion: { lower: '105 %', upper: '95 %' } }), 'below the upper'],
    ['no scatter at all', l15({ batches: [{ batch: 'A', points: pts(['100', '99', '98', '97']) }] }), 'no scatter'],
    ['no batches', l15({ batches: [] }), 'at least one batch'],
    ['a batch twice', l15({ batches: [{ batch: 'A', points: A }, { batch: 'A', points: B }] }), 'twice'],
    ['log with a zero value', l15({ transform: 'log', batches: [{ batch: 'A', points: pts(['0', '0.1', '0.2']) }] }), 'above zero'],
    ['a criterion of another kind', l15({ criterion: { lower: '95 mg' } }), 'The lower acceptance criterion'],
    ['a time in days', l15({ batches: [{ batch: 'A', points: [{ time: '90 d', value: '99 %' }, ...A] }] }), 'time point in months'],
    ['a pooling level of 25', l15({ poolingLevel: '25' }), 'pooling level'],
    ['tree without the accelerated answer', l15({ extrapolation: { storage: 'room temperature' } }), 'accelerated'],
    ['SC at accelerated without the intermediate answer', l15({ extrapolation: { storage: 'room temperature', accelerated: 'significant change' } }), 'intermediate'],
    ['X shorter than the data', l15({ extrapolation: { storage: 'frozen', longTerm: '12' } }), 'cover 18 months'],
  ])('L15 refuses: %s', (_n, input, word) => {
    expect(refused(l15ShelfLife(input))).toContain(word);
  });

  it('L15 refuses a batch on an exact line when its own residual SD is used', () => {
    const exact = pts(['100.0', '99.7', '99.4', '99.1', '98.8', '98.2']);
    expect(refused(l15ShelfLife(l15({ batches: [{ batch: 'A', points: A }, { batch: 'E', points: exact }, { batch: 'D', points: D }] })))).toContain('Batch E lies exactly');
  });

  it('L15 F p-value helper: P(F(2, 12) > 3.885) = 0.05 (printed table F 0.95; 2, 12 = 3.885)', () => {
    expect(fUpperP(d('3.885'), d(2), d(12)).toFixed(3)).toBe('0.050');
    expect(fUpperP(d(0), d(2), d(12)).toString()).toBe('1');
  });
});

// ================================================================ L22 prediction interval
describe('L22 prediction interval (OOT)', () => {
  it('L22 this batch: 97.5 % at 18 months is outside 97.86-98.50 % (out of trend)', () => {
    // Batch A at 0-12 months (5 results): b = −0.11, a = 100.16, s = 0.060553 (df 3); t(0.975; 3) = 3.182;
    // ŷ(18) = 100.16 − 1.98 = 98.18; x̄ = 6, Sxx = 90; half width = 3.182 × 0.060553 × √(1 + 1/5 + 144/90) = 0.32242.
    // 98.18 ± 0.322 = 97.858 to 98.502 (float check 97.8576, 98.5024).
    const r = ok(l22PredictionInterval({ batch: A.slice(0, 5), result: { time: '18', value: '97.5 %' } }));
    expect(r.batchInterval!.predicted.toFixed(2)).toBe('98.18');
    expect(r.batchInterval!.low.toFixed(3)).toBe('97.858');
    expect(r.batchInterval!.high.toFixed(3)).toBe('98.502');
    expect(r.batchInterval!.within).toBe(false);
    expect(r.oot).toBe(true);
    expect(r.shown).toContain('OUT OF TREND');
    expect(r.value.toString()).toBe('97.5');
  });

  it('L22 the actual 18-month result 98.2 % is in trend', () => {
    const r = ok(l22PredictionInterval({ batch: A.slice(0, 5), result: { time: '18', value: '98.2 %' } }));
    expect(r.oot).toBe(false);
    expect(r.shown).toContain('in trend');
  });

  it('L22 historical batches pooled: B and C as one line, 97.62-98.62 % at 18 months', () => {
    // 12 results: b = −0.112857, a = 100.152857, s = 0.195082 (df 10), t(0.975; 10) = 2.228, ŷ(18) = 98.121429;
    // half width 2.228 × 0.195082 × √(1 + 1/12 + 100/420) = 0.49965 → 97.6218 to 98.6211.
    const r = ok(l22PredictionInterval({ batch: A.slice(0, 5), result: { time: '18', value: '97.7 %' }, historical: [{ batch: 'B', points: B }, { batch: 'C', points: C }] }));
    expect(r.historicalInterval!.low.toFixed(3)).toBe('97.622');
    expect(r.historicalInterval!.high.toFixed(3)).toBe('98.621');
    expect(r.historicalInterval!.within).toBe(true);
    expect(r.batchInterval!.within).toBe(false); // outside its own batch's interval: still OOT
    expect(r.oot).toBe(true);
  });

  it('L22 a new batch with fewer than 3 earlier points is judged on the historical batches only', () => {
    const r = ok(l22PredictionInterval({ batch: A.slice(0, 2), result: { time: '6', value: '99.5 %' }, historical: [{ batch: 'B', points: B }, { batch: 'C', points: C }] }));
    expect(r.batchInterval).toBeUndefined();
    expect(r.oot).toBe(false);
    expect(r.shown).toContain('historical batches only');
  });

  it('L22 log transform: the interval is shown back in %', () => {
    const r = ok(l22PredictionInterval({ batch: A.slice(0, 5), result: { time: '18', value: '98.2 %' }, transform: 'log' }));
    expect(r.batchInterval!.predicted.toFixed(1)).toBe('98.2');
    expect(r.batchInterval!.low.lt(r.batchInterval!.predicted)).toBe(true);
  });

  it.each([
    ['fewer than 3 earlier points and no history', { batch: A.slice(0, 2), result: { time: '6', value: '99.5 %' } }, 'fewer than 3 earlier time points'],
    ['earlier results on an exact line', { batch: pts(['100', '99', '98']), result: { time: '9', value: '97 %' } }, 'no scatter'],
    ['a result of another kind', { batch: A.slice(0, 5), result: { time: '18', value: '98 mg' } }, 'cannot be converted'],
  ])('L22 refuses: %s', (_n, input, word) => {
    expect(refused(l22PredictionInterval(input))).toContain(word);
  });
});

// ================================================================ L23 mean kinetic temperature
describe('L23 mean kinetic temperature', () => {
  it('L23 25 °C and 35 °C: MKT 31.22 °C (above the arithmetic mean 30 °C), fails NMT 30 °C', () => {
    // ΔH ÷ R = 83.144 ÷ 0.0083144 = 10 000 K. T = 298.15, 308.15 K.
    // e^(−10000/298.15) = 2.7116e−15, e^(−10000/308.15) = 7.7924e−15; mean 5.2520e−15; −ln = 32.8550;
    // 10000 ÷ 32.8550 = 304.371 K = 31.221 °C (float check 31.22102).
    const r = ok(l23Mkt({ readings: ['25 °C', '35 °C'], limit: { high: '30', unit: '°C' } }));
    expect(r.value.toFixed(3)).toBe('31.221');
    expect(r.kelvin.toFixed(2)).toBe('304.37');
    expect(r.mean.toString()).toBe('30');
    expect(r.unit).toBe('°C');
    expect(r.check!.pass).toBe(false);
    expect(r.shown).toContain('10000.0 K');
  });

  it('L23 20, 25, 30 °C: 25.86 °C; a constant 25 °C gives exactly 25 °C; kelvin and °F readings convert exactly', () => {
    // Float check: 25.85821 °C.
    expect(ok(l23Mkt({ readings: ['20 °C', '25 °C', '30 °C'] })).value.toFixed(3)).toBe('25.858');
    expect(ok(l23Mkt({ readings: ['293.15 K', '298.15 K', '303.15 K'] })).value.toFixed(3)).toBe('25.858');
    expect(ok(l23Mkt({ readings: ['68 °F', '77 °F', '86 °F'] })).value.toFixed(3)).toBe('25.858');
    expect(ok(l23Mkt({ readings: ['25 °C', '25 °C', '25 °C'] })).value.toFixed(10)).toBe('25.0000000000');
  });

  it('L23 another ΔH (in J/mol) and equal-interval times', () => {
    // ΔH 60 kJ/mol: ΔH ÷ R = 7216.39 K; a lower ΔH weighs the high reading less: MKT between 30 and 31.22 °C.
    const r = ok(l23Mkt({ readings: ['25 °C', '35 °C'], deltaH: '60000 J/mol', times: ['2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z'] }));
    expect(r.value.gt(30) && r.value.lt('31.221')).toBe(true);
  });

  it.each([
    ['one reading', { readings: ['25 °C'] }, 'at least two readings'],
    ['a reading not a temperature', { readings: ['25 °C', '25 %'] }, 'Reading 2'],
    ['below absolute zero', { readings: ['25 °C', '-300 °C'] }, 'absolute zero'],
    ['unequal intervals', { readings: ['25 °C', '26 °C', '27 °C'], times: ['2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z', '2026-11-01T03:00:00Z'] }, 'equal intervals'],
    ['times count', { readings: ['25 °C', '26 °C'], times: ['2026-11-01T00:00:00Z'] }, 'one time per reading'],
    ['ΔH not an energy', { readings: ['25 °C', '26 °C'], deltaH: '83 kJ' }, 'ΔH'],
  ])('L23 refuses: %s', (_n, input, word) => {
    expect(refused(l23Mkt(input as never))).toContain(word);
  });
});

// ================================================================ L24 Arrhenius advisory shelf life
describe('L24 Arrhenius advisory shelf life', () => {
  it('L24 three temperatures: Ea 82.6 kJ/mol, k(25 °C) 0.2307 %/month, 8.7 months to a 2 % change; labelled advisory', () => {
    // Rates 0.1, 0.25, 0.6 %/day at 50, 60, 70 °C → × 30.4375 days/month = 3.04375, 7.609375, 18.2625 %/month.
    // ln k on 1/T (T = 323.15, 333.15, 343.15 K): slope −9933.6 K → Ea = 9933.6 × 8.314463 = 82.59 kJ/mol;
    // ln A = 31.8509; k(298.15 K) = e^(31.8509 − 9933.6 ÷ 298.15) = 0.230719 %/month; 2 ÷ 0.230719 = 8.6686 months.
    const r = ok(l24Arrhenius({ points: [{ temperature: '50 °C', rate: '0.1 %/day' }, { temperature: '60 °C', rate: '0.25 %/day' }, { temperature: '70 °C', rate: '0.6 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }));
    expect(r.ea.toFixed(2)).toBe('82.59');
    expect(r.lnA.toFixed(4)).toBe('31.8509');
    expect(r.rateAtStorage.toFixed(4)).toBe('0.2307');
    expect(r.value.toFixed(3)).toBe('8.669');
    expect(r.unit).toBe('months');
    expect(r.advisory).toBe(true);
    expect(r.shown.startsWith('advisory: for development decisions, not for the label (the label shelf life is ICH Q1E)')).toBe(true);
  });

  it('L24 isoconversion times give the same fit as the rates (k = allowed change ÷ time)', () => {
    // 2 % at 0.1 %/day = 20 days; 0.25 → 8 days; 0.6 → 3.3333… days (written in weeks: 20/42 = … not exact, so days).
    const r = ok(l24Arrhenius({ points: [{ temperature: '50 °C', timeToLimit: '20 days' }, { temperature: '60 °C', timeToLimit: '8 d' }, { temperature: '70 °C', rate: '0.6 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }));
    expect(r.value.toFixed(3)).toBe('8.669');
  });

  it('L24 humidity-corrected: rates made from Ea 100 kJ/mol, B 0.04 per %RH, ln A 36 are recovered; 6.96 months to 1 % at 25 °C/60 %RH', () => {
    // k = e^(36 − 100000 ÷ (8.314463 T) + 0.04 RH) per month, written to 10 significant digits (own construction).
    // At 25 °C/60 %RH: k = e^(36 − 40.3410 + 2.4) = 0.143769 %/month; 1 ÷ 0.143769 = 6.9556 months.
    const r = ok(l24Arrhenius({
      points: [
        { temperature: '50 °C', rh: '75 %RH', rate: '5.93733875 %/month' },
        { temperature: '60 °C', rh: '40 %RH', rate: '4.474692471 %/month' },
        { temperature: '70 °C', rh: '75 %RH', rate: '51.96140472 %/month' },
        { temperature: '80 °C', rh: '10 %RH', rate: '10.41225148 %/month' },
        { temperature: '70 °C', rh: '40 %RH', rate: '12.81352465 %/month' },
      ],
      allowedChange: '1 %', storage: { temperature: '25 °C', rh: '60 %RH' },
    }));
    expect(r.ea.toFixed(3)).toBe('100.000');
    expect(r.b!.toFixed(5)).toBe('0.04000');
    expect(r.lnA.toFixed(3)).toBe('36.000');
    expect(r.value.toFixed(3)).toBe('6.956');
    expect(r.shown).toContain('B = 0.0400 per %RH');
  });

  it.each([
    ['two temperatures', { points: [{ temperature: '50 °C', rate: '0.1 %/day' }, { temperature: '60 °C', rate: '0.2 %/day' }, { temperature: '60 °C', rate: '0.25 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }, 'three or more different temperatures'],
    ['rates falling with temperature', { points: [{ temperature: '50 °C', rate: '0.6 %/day' }, { temperature: '60 °C', rate: '0.25 %/day' }, { temperature: '70 °C', rate: '0.1 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }, 'not Arrhenius'],
    ['humidity on some points only', { points: [{ temperature: '50 °C', rh: '75 %RH', rate: '0.1 %/day' }, { temperature: '60 °C', rate: '0.25 %/day' }, { temperature: '70 °C', rate: '0.6 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }, 'every condition'],
    ['humidity without the storage humidity', { points: [{ temperature: '50 °C', rh: '75', rate: '0.1 %/day' }, { temperature: '60 °C', rh: '40', rate: '0.25 %/day' }, { temperature: '70 °C', rh: '75', rate: '0.6 %/day' }, { temperature: '80 °C', rh: '10', rate: '0.6 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }, 'storage humidity'],
    ['a zero rate', { points: [{ temperature: '50 °C', rate: '0 %/day' }, { temperature: '60 °C', rate: '0.25 %/day' }, { temperature: '70 °C', rate: '0.6 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }, 'more than zero'],
    ['rate and time both', { points: [{ temperature: '50 °C', rate: '0.1 %/day', timeToLimit: '20 d' }, { temperature: '60 °C', rate: '0.25 %/day' }, { temperature: '70 °C', rate: '0.6 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }, 'either the rate or the time'],
    ['a rate in another unit than the allowed change', { points: [{ temperature: '50 °C', rate: '0.1 mg/day' }, { temperature: '60 °C', rate: '0.25 %/day' }, { temperature: '70 °C', rate: '0.6 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }, 'the rate'],
    ['a rate per a non-time', { points: [{ temperature: '50 °C', rate: '0.1 %/kg' }, { temperature: '60 °C', rate: '0.25 %/day' }, { temperature: '70 °C', rate: '0.6 %/day' }], allowedChange: '2 %', storage: { temperature: '25 °C' } }, 'not a time unit'],
  ])('L24 refuses: %s', (_n, input, word) => {
    expect(refused(l24Arrhenius(input as never))).toContain(word);
  });
});

// ================================================================ L25 ICH Q1D design check
const strengths = { name: 'strength', kind: 'strength' as const, formulation: 'identical' as const, levels: [{ name: '50 mg', size: '50 mg', tested: true }, { name: '75 mg', size: '75 mg', tested: false }, { name: '100 mg', size: '100 mg', tested: true }] };
const bottles = { name: 'bottle', kind: 'container size' as const, sameClosureSystem: true, levels: [{ name: '30s', size: '30 tablets', tested: true }, { name: '100s', size: '100 tablets', tested: false }, { name: '500s', size: '500 tablets', tested: true }] };
// One-third reduction over 0, 3, 6, 9, 12, 18, 24, 36 months: fixed 0, 12 (last before submission), 36; the
// intermediate 3, 6, 9, 18, 24 (5) × 3 batches = 15 tests, two-thirds kept = 10: batch 1 tests 4, batches 2 and 3 test 3.
const TP = ['0', '3', '6', '9', '12', '18', '24', '36'];
const matrix = (over: Partial<L25Input> = {}): L25Input => ({
  design: 'matrixing', timePoints: TP, reduction: '1/3', variability: 'small',
  schedule: [
    { batch: 'B1', times: ['0', '3', '6', '12', '18', '24', '36'] },
    { batch: 'B2', times: ['0', '3', '9', '12', '24', '36'] },
    { batch: 'B3', times: ['0', '6', '9', '12', '18', '36'] },
  ],
  ...over,
});

describe('L25 ICH Q1D design check', () => {
  it('L25 bracketing of strengths and bottle sizes: extremes tested, identical formulation, same closure: PASS', () => {
    const r = ok(l25DesignCheck({ design: 'bracketing', factors: [strengths] }));
    expect(r.pass).toBe(true);
    expect(r.value.toString()).toBe('0');
    expect(r.shown).toContain('PASS');
    expect(r.notes[0]).toContain('75 mg bracketed');
    expect(ok(l25DesignCheck({ design: 'bracketing', factors: [strengths, bottles] })).pass).toBe(true);
  });

  it.each([
    ['an untested extreme', { design: 'bracketing', factors: [{ ...strengths, levels: [{ name: '50 mg', size: '50 mg', tested: false }, { name: '75 mg', size: '75 mg', tested: true }, { name: '100 mg', size: '100 mg', tested: true }] }] }, 'extremes must be tested'],
    ['different formulations', { design: 'bracketing', factors: [{ ...strengths, formulation: 'different' }] }, 'identical or closely related'],
    ['formulation not stated', { design: 'bracketing', factors: [{ ...strengths, formulation: undefined }] }, 'state whether the formulations'],
    ['another closure system', { design: 'bracketing', factors: [{ ...bottles, sameClosureSystem: false }] }, 'same container closure system'],
    ['a pack without the reason for its extremes', { design: 'bracketing', factors: [{ ...bottles, kind: 'pack' }] }, 'why the tested packs'],
    ['container size and fill bracketed together', { design: 'bracketing', factors: [bottles, { ...bottles, name: 'fill', kind: 'fill' }] }, 'one of them varies'],
    ['an untested level in a full design', { design: 'full', factors: [strengths] }, 'not bracketing'],
  ] as const)('L25 bracketing fails: %s', (_n, input, word) => {
    const r = ok(l25DesignCheck(input as never));
    expect(r.pass).toBe(false);
    expect(r.problems.join(' ')).toContain(word);
    expect(r.shown).toContain('FAIL');
  });

  it('L25 matrixing, one-third reduction, balanced, all at 0, 12 and 36 months: PASS', () => {
    const r = ok(l25DesignCheck(matrix()));
    expect(r.problems).toEqual([]);
    expect(r.notes.join(' ')).toContain('10 of 15 intermediate tests');
  });

  it.each([
    ['a one-half reduction stated (7.5 of 15 wanted, 10 tested)', matrix({ reduction: '1/2' }), 'tests 7.5 of the 15'],
    ['a combination without the final time point', matrix({ schedule: [{ batch: 'B1', times: ['0', '3', '6', '12', '18', '24'] }, { batch: 'B2', times: ['0', '3', '9', '12', '24', '36'] }, { batch: 'B3', times: ['0', '6', '9', '12', '18', '36'] }] }), 'missing 36'],
    ['a combination without 12 months (last before submission)', matrix({ schedule: [{ batch: 'B1', times: ['0', '3', '6', '9', '18', '24', '36'] }, { batch: 'B2', times: ['0', '3', '9', '12', '24', '36'] }, { batch: 'B3', times: ['0', '6', '9', '12', '18', '36'] }] }), 'last before submission'],
    ['fewer than 3 points in the first 12 months', matrix({ reduction: '1/2', schedule: [{ batch: 'B1', times: ['0', '12', '18', '24', '36'] }, { batch: 'B2', times: ['0', '3', '6', '9', '12', '36'] }] }), 'three time points including the initial'],
    ['an unbalanced design', matrix({ schedule: [{ batch: 'B1', times: TP }, { batch: 'B2', times: ['0', '6', '12', '24', '36'] }, { batch: 'B3', times: ['0', '3', '9', '12', '36'] }] }), 'not balanced'],
    ['large variability', matrix({ variability: 'large' }), 'should not be applied'],
    ['moderate variability without statistics', matrix({ variability: 'moderate' }), 'statistical justification'],
    ['no reduction stated', matrix({ reduction: undefined }), 'state the reduction'],
    ['accelerated with two points', { design: 'matrixing', condition: 'accelerated', timePoints: ['0', '3', '6'], reduction: '1/2', variability: 'small', schedule: [{ batch: 'B1', times: ['0', '6'] }, { batch: 'B2', times: ['0', '3', '6'] }] }, 'accelerated condition at least three'],
  ] as const)('L25 matrixing fails: %s', (_n, input, word) => {
    const r = ok(l25DesignCheck(input as never));
    expect(r.pass).toBe(false);
    expect(r.problems.join(' ')).toContain(word);
  });

  it('L25 matrixing with full data before approval needs no 12-month point; moderate variability with statistics passes', () => {
    // Fixed now 0 and 36 only: intermediate 3, 6, 9, 12, 18, 24 (6) × 2 = 12; one-half kept = 6 (3 each).
    const r = ok(l25DesignCheck(matrix({
      fullDataBeforeApproval: true, reduction: '1/2', variability: 'moderate', statisticallyJustified: true,
      schedule: [{ batch: 'B1', times: ['0', '3', '9', '18', '36'] }, { batch: 'B2', times: ['0', '6', '12', '24', '36'] }],
    })));
    expect(r.problems).toEqual([]);
  });

  it('L25 bracketing and matrixing: rows use only tested levels; every tested level is scheduled', () => {
    const rows = [
      { batch: 'B1', levels: { strength: '50 mg' }, times: ['0', '3', '6', '12', '18', '24', '36'] },
      { batch: 'B1', levels: { strength: '100 mg' }, times: ['0', '3', '9', '12', '24', '36'] },
      { batch: 'B2', levels: { strength: '50 mg' }, times: ['0', '6', '9', '12', '18', '36'] },
    ];
    expect(ok(l25DesignCheck(matrix({ design: 'bracketing and matrixing', factors: [strengths], schedule: rows }))).problems).toEqual([]);
    const bad = ok(l25DesignCheck(matrix({ design: 'bracketing and matrixing', factors: [strengths], schedule: [rows[0]!, { ...rows[1]!, levels: { strength: '75 mg' } }, rows[2]!] })));
    expect(bad.problems.join(' ')).toContain('75 mg is scheduled but marked as not tested');
    expect(bad.problems.join(' ')).toContain('100 mg is to be tested but no batch is scheduled');
  });

  it('L25 full design: every combination at every time point', () => {
    expect(ok(l25DesignCheck({ design: 'full', timePoints: ['0', '3', '6'], schedule: [{ batch: 'B1', times: ['0', '3', '6'] }] })).pass).toBe(true);
    expect(ok(l25DesignCheck({ design: 'full', timePoints: ['0', '3', '6'], schedule: [{ batch: 'B1', times: ['0', '6'] }] })).problems[0]).toContain('missing 3');
  });

  it.each([
    ['bracketing without factors', { design: 'bracketing' }, 'needs the factors'],
    ['a level without its quantity', { design: 'bracketing', factors: [{ ...strengths, levels: [{ name: '50 mg', tested: true }, { name: '75 mg', tested: false }, { name: '100 mg', tested: true }] }] }, 'quantity of every level'],
    ['matrixing without a schedule', { design: 'matrixing', timePoints: TP }, 'needs the schedule'],
    ['a time not in the protocol', matrix({ schedule: [{ batch: 'B1', times: ['0', '4', '36'] }] }), 'not a time point of the protocol'],
    ['an unknown factor', matrix({ schedule: [{ batch: 'B1', levels: { colour: 'red' }, times: ['0', '36'] }] }), 'no factor colour'],
    ['a reduction not a fraction', matrix({ reduction: 'one third' }), 'fraction'],
  ] as const)('L25 refuses: %s', (_n, input, word) => {
    expect(refused(l25DesignCheck(input as never))).toContain(word);
  });
});

describe('L15-L25 registration', () => {
  it('L15 L22 L23 L24 L25 are registered and called through the engine', () => {
    for (const id of ['L15', 'L22', 'L23', 'L24', 'L25']) expect(TEMPLATES[id]).toBeDefined();
    const r = callTemplate('L23', { readings: ['25 °C', '35 °C'] });
    expect(r.ok).toBe(true);
    expect(monthsOf('6 months', 't').toString()).toBe('6');
  });
});
