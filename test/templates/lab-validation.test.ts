import { describe, expect, it } from 'vitest';
import {
  l27Linearity, l28Accuracy, l29Precision, l30DetectionLimits, l31Range, l32Robustness, l33TransferComparison, l34Specificity, type L28Input,
} from '../../shared/templates/lab-validation.js';
import { TEMPLATES } from '../../shared/engine/templates.js';
import { ok, refused } from './helpers.js';

// The method validation templates with hand-checked numbers (own demo numbers; each checked by an independent
// floating-point calculation; Student t from the tables: t(0.975; 8) = 2.3060, t(0.95; 10) = 1.8125).

const vals = (text: string, unit: string) => ({ values: text.split(' '), unit });
const n = (x: unknown) => Number(String(x));

describe('the validation templates', () => {
  it('are registered as L27 to L34', () => {
    expect(['L27', 'L28', 'L29', 'L30', 'L31', 'L32', 'L33', 'L34'].every((k) => k in TEMPLATES)).toBe(true);
  });
});

describe('L27 linearity', () => {
  // 50 to 150 % in 5 levels; responses 1012, 1498, 2003, 2510, 2995.
  // slope 19.912, intercept 12.4, r 0.999966, residuals 4.0 −7.8 −0.6 8.6 −4.2, residual SD 7.5011, SD(intercept) 10.0638;
  // the intercept 12.4 ÷ (19.912 × 100 + 12.4) × 100 = 0.619 % of the 100 % response.
  const lin = { x: vals('50 75 100 125 150', '%'), y: vals('1012 1498 2003 2510 2995', 'units') };
  it('least squares, r, r², residuals, residual SD, intercept as % of the 100 % response', () => {
    const r = ok(l27Linearity({ ...lin, limit: { low: '0.999', unit: '' }, r2Limit: { low: '0.998', unit: '' }, interceptLimit: { low: '-2.0', high: '2.0', unit: '%' } }));
    expect(n(r.slope)).toBeCloseTo(19.912, 10);
    expect(n(r.intercept)).toBeCloseTo(12.4, 10);
    expect(n(r.r)).toBeCloseTo(0.9999659427, 9);
    expect(n(r.r2)).toBeCloseTo(0.9999318865, 9);
    expect(r.residuals.map(n).map((e) => Math.round(e * 10) / 10)).toEqual([4, -7.8, -0.6, 8.6, -4.2]);
    expect(n(r.residualSd)).toBeCloseTo(7.501111, 5);
    expect(n(r.interceptSd)).toBeCloseTo(10.063797, 5);
    expect(n(r.interceptPercent)).toBeCloseTo(0.618886, 5);
    expect([n(r.low), n(r.high)]).toEqual([50, 150]);
    expect([r.check?.pass, r.r2Check?.pass, r.interceptCheck?.pass]).toEqual([true, true, true]);
    expect(r.shown).toContain('y-intercept = 0.62 % of the response at 100 %');
    // An intercept limit of ± 0.5 % fails.
    expect(ok(l27Linearity({ ...lin, interceptLimit: { low: '-0.5', high: '0.5', unit: '%' } })).interceptCheck?.pass).toBe(false);
  });
  it('levels in a concentration need the 100 % level for the % figures; fewer than 5 levels are refused', () => {
    const conc = ok(l27Linearity({ x: vals('0.25 0.375 0.5 0.625 0.75', 'mg/mL'), y: lin.y, target: '0.5 mg/mL' }));
    expect([n(conc.low), n(conc.high)]).toEqual([50, 150]);
    expect(n(conc.interceptPercent)).toBeCloseTo(0.618886, 5);
    expect(refused(l27Linearity({ x: vals('0.25 0.375 0.5 0.625 0.75', 'mg/mL'), y: lin.y, interceptLimit: { high: '2', unit: '%' } }))).toContain('Give the 100 % level');
    expect(refused(l27Linearity({ x: vals('50 75 100 125', '%'), y: vals('1 2 3 4', 'units') }))).toContain('at least 5 levels');
    expect(refused(l27Linearity({ x: vals('50 75 100 125 150', '%'), y: vals('1 2 3 4', 'units') }))).toContain('one response per level');
  });
});

describe('L28 accuracy', () => {
  // 3 levels × 3: recoveries 99.25 100.25 99.625 | 100.5 99.6 100.2 | 99.4167 100.4167 100.0833; mean 99.927 %,
  // SD 0.45939, 95 % CI 99.927 ± 2.3060 × 0.45939 ÷ 3 = 99.574 to 100.280 %.
  const levels: L28Input['levels'] = [
    { level: '80 %', added: vals('8.0 8.0 8.0', 'mg'), found: vals('7.94 8.02 7.97', 'mg') },
    { level: '100 %', added: vals('10.0 10.0 10.0', 'mg'), found: vals('10.05 9.96 10.02', 'mg') },
    { level: '120 %', added: vals('12.0 12.0 12.0', 'mg'), found: vals('11.93 12.05 12.01', 'mg') },
  ];
  it('recovery per level and overall, with the 95 % confidence interval', () => {
    const r = ok(l28Accuracy({ levels, limit: { low: '98.0', high: '102.0', unit: '%' }, levelLimit: { low: '98.0', high: '102.0', unit: '%' }, ciLimit: { low: '98.0', high: '102.0', unit: '%' } }));
    expect(n(r.value)).toBeCloseTo(99.926852, 5);
    expect(n(r.sd)).toBeCloseTo(0.4593885, 6);
    expect(n(r.t)).toBeCloseTo(2.306004, 5);
    expect(n(r.ci.low)).toBeCloseTo(99.573735, 4);
    expect(n(r.ci.high)).toBeCloseTo(100.279969, 4);
    expect(r.perLevel.map((l) => Math.round(n(l.mean) * 1000) / 1000)).toEqual([99.708, 100.1, 99.972]);
    expect([n(r.low), n(r.high)]).toEqual([80, 120]);
    expect([r.check?.pass, r.levelCheck?.pass, r.ciCheck?.pass]).toEqual([true, true, true]);
    expect(r.shown).not.toContain('fewer than');
    // A tighter level limit names the failing level.
    const tight = ok(l28Accuracy({ levels, levelLimit: { low: '99.8', high: '100.2', unit: '%' } }));
    expect(tight.levelCheck).toMatchObject({ pass: false });
    expect(tight.levelCheck?.shown).toContain('level 80 %');
  });
  it('standard addition: (spiked − mean unspiked) ÷ added × 100; fewer than 9 determinations are said', () => {
    // unspiked mean 2.00; (4.02 − 2.00) ÷ 2.0 × 100 = 101.0; (3.98 − 2.00) ÷ 2.0 × 100 = 99.0.
    const r = ok(l28Accuracy({ mode: 'standard addition', levels: [{ level: '50', added: vals('2.0 2.0', 'µg'), found: vals('4.02 3.98', 'µg'), unspiked: vals('1.99 2.01', 'µg') }] }));
    expect(n(r.value)).toBeCloseTo(100, 10);
    expect(r.shown).toContain('fewer than the 9 determinations over 3 levels');
    expect(refused(l28Accuracy({ mode: 'standard addition', levels: [{ level: '50', added: vals('2.0 2.0', 'µg'), found: vals('4.02 3.98', 'µg') }] }))).toContain('unspiked');
  });
});

describe('L29 precision', () => {
  it('repeatability: the % RSD of 6 determinations', () => {
    // mean 100.0167, SD 0.318852, RSD 0.3188 %.
    const r = ok(l29Precision({ mode: 'repeatability', readings: vals('99.8 100.2 100.5 99.6 100.1 99.9', '%'), limit: { high: '1.0', unit: '%' } }));
    expect(n(r.value)).toBeCloseTo(0.318799, 5);
    expect(r.check?.pass).toBe(true);
  });
  it('intermediate precision by one-way ANOVA: within, between and total % RSD', () => {
    // 3 runs of 3: means 100.1667, 100.9333, 99.8333, grand 100.3111; MS within 0.093333, MS between 0.954444, n₀ 3;
    // s² between (0.954444 − 0.093333) ÷ 3 = 0.287037; RSD repeatability 0.3046 %, between 0.5341 %, intermediate 0.6148 %;
    // largest difference of run means 1.1 ÷ 100.3111 = 1.0966 %.
    const groups = [vals('99.8 100.2 100.5', '%'), vals('100.9 101.2 100.7', '%'), vals('99.5 99.9 100.1', '%')];
    const r = ok(l29Precision({ mode: 'intermediate precision', groups, limit: { high: '2.0', unit: '%' }, repeatabilityLimit: { high: '1.0', unit: '%' }, differenceLimit: { high: '1.0', unit: '%' } }));
    expect(n(r.msWithin)).toBeCloseTo(0.0933333, 6);
    expect(n(r.msBetween)).toBeCloseTo(0.9544444, 6);
    expect(n(r.rsdRepeatability)).toBeCloseTo(0.3045575, 6);
    expect(n(r.rsdBetween)).toBeCloseTo(0.5340967, 6);
    expect(n(r.value)).toBeCloseTo(0.6148289, 6);
    expect(n(r.difference)).toBeCloseTo(1.0965884, 6);
    expect([r.check?.pass, r.repeatabilityCheck?.pass, r.differenceCheck?.pass]).toEqual([true, true, false]);
    expect(refused(l29Precision({ mode: 'intermediate precision', groups: [groups[0]!] }))).toContain('at least 2 runs');
  });
});

describe('L30 detection and quantitation limits', () => {
  // 0.05 to 0.25 µg/mL: slope 24.18, residual SD 0.0270185, SD(intercept) 0.0283373;
  // DL = 3.3 × 0.0270185 ÷ 24.18 = 0.003687, QL = 10 × 0.0270185 ÷ 24.18 = 0.011174 µg/mL.
  const cal = { mode: 'calibration' as const, x: vals('0.05 0.10 0.15 0.20 0.25', 'µg/mL'), y: vals('1.21 2.38 3.62 4.79 6.05', 'units') };
  it('3.3σ/S and 10σ/S, σ as the protocol fixes it', () => {
    const r = ok(l30DetectionLimits({ ...cal, sigma: 'residual SD', limit: { high: '0.05', unit: 'µg/mL' } }));
    expect(n(r.lod)).toBeCloseTo(0.00368739, 7);
    expect(n(r.loq)).toBeCloseTo(0.01117391, 7);
    expect(r.unit).toBe('µg/mL');
    expect(r.check?.pass).toBe(true);
    const b = ok(l30DetectionLimits({ ...cal, sigma: 'intercept SD' }));
    expect(n(b.loq)).toBeCloseTo(0.01171929, 7);
    // Blank SD: blanks 0.02 0.05 0.03 0.04 (SD 0.0129099); QL = 10 × 0.0129099 ÷ 24.18 = 0.005339.
    expect(n(ok(l30DetectionLimits({ ...cal, sigma: 'blank SD', blanks: vals('0.02 0.05 0.03 0.04', 'units') })).loq)).toBeCloseTo(0.00533908, 7);
  });
  it('signal to noise: 2H ÷ h against NLT 10 at the QL; precision at the QL', () => {
    // 2 × 5.4 ÷ 1.0 = 10.8: met; replicate results RSD 4.08 % against NMT 10 %.
    const r = ok(l30DetectionLimits({ mode: 'signal to noise', level: 'quantitation limit', concentration: '0.05 %', signal: '5.4 mm', noise: '1.0 mm',
      readings: vals('0.049 0.051 0.050 0.047 0.052 0.050', '%'), rsdLimit: { high: '10', unit: '%' } }));
    expect(n(r.value)).toBeCloseTo(10.8, 10);
    expect(r.check?.pass).toBe(true);
    expect(n(r.loq)).toBe(0.05);
    expect(r.rsdCheck?.pass).toBe(true);
    expect(ok(l30DetectionLimits({ mode: 'signal to noise', level: 'quantitation limit', concentration: '0.05 %', signal: '4.4 mm', noise: '1.0 mm' })).check?.pass).toBe(false);
  });
});

describe('L31 range', () => {
  const met = { linearity: { low: '50', high: '150', met: true }, accuracy: { low: '80', high: '120', met: true }, precision: { met: true } };
  it('where linearity, accuracy and precision were met; it must cover the range the use requires (ICH Q2 Table 2)', () => {
    const r = ok(l31Range({ use: 'assay', ...met }));
    expect([n(r.low), n(r.high)]).toEqual([80, 120]);
    expect(r.check).toMatchObject({ pass: true });
    // Content uniformity needs 70 to 130 %: accuracy at 80-120 does not reach it.
    expect(ok(l31Range({ use: 'content uniformity', ...met })).check).toMatchObject({ pass: false });
    // Impurity: reporting threshold 0.05 % of a 0.5 % limit = 10 % of the limit, to 120 %.
    const imp = ok(l31Range({ use: 'impurity', reportingThreshold: '0.05 %', specLimit: '0.5 %', linearity: { low: '10', high: '150', met: true }, accuracy: { low: '10', high: '120', met: true }, precision: { met: true } }));
    expect([n(imp.requiredLow), n(imp.requiredHigh)]).toEqual([10, 120]);
    expect(imp.check).toMatchObject({ pass: true });
    // Dissolution Q 80 %: 35 to 130 %.
    expect(n(ok(l31Range({ use: 'dissolution', q: '80 %', ...met })).requiredLow)).toBe(35);
    // Precision not met: no range.
    expect(ok(l31Range({ use: 'assay', ...met, precision: { met: false } })).check).toMatchObject({ pass: false });
  });
});

describe('L32 robustness', () => {
  it('per varied factor the difference from the nominal mean and its system suitability', () => {
    // nominal 100.0 100.2 (100.1); flow +10 %: 99.6 99.8 (99.7, −0.40 %); 35 °C: 101.0 101.4 (101.2, +1.10 %).
    const factors = [{ name: 'Flow +10 %', results: vals('99.6 99.8', '%'), suitability: 'yes' }, { name: 'Column 35 °C', results: vals('101.0 101.4', '%'), suitability: 'yes' }];
    const r = ok(l32Robustness({ nominal: vals('100.0 100.2', '%'), factors, limit: { high: '2.0', unit: '%' } }));
    expect(n(r.value)).toBeCloseTo(1.0989011, 6);
    expect(r.check?.pass).toBe(true);
    expect(r.suitabilityCheck.pass).toBe(true);
    const bad = ok(l32Robustness({ nominal: vals('100.0 100.2', '%'), factors: [{ ...factors[0]!, suitability: 'no' }], limit: { high: '0.2', unit: '%' } }));
    expect([bad.check?.pass, bad.suitabilityCheck.pass]).toEqual([false, false]);
    expect(bad.suitabilityCheck.shown).toContain('Flow +10 %');
  });
});

describe('L33 transfer comparison', () => {
  // Sending 99.0 to 101.5 (n 6), receiving 0.5 lower with the same spread: difference −0.5, SE 0.54006, Welch df 10,
  // t(0.95; 10) 1.8125: 90 % CI −1.479 to 0.479 within ± 2.0 %: equivalent; within ± 1.0 %: not shown.
  const s = vals('99.0 99.5 100.0 100.5 101.0 101.5', '%');
  const r_ = vals('98.5 99.0 99.5 100.0 100.5 101.0', '%');
  it('equivalence by TOST: the 90 % interval of the difference inside ± the margin', () => {
    const r = ok(l33TransferComparison({ mode: 'equivalence (TOST)', sending: s, receiving: r_, margin: '2.0 %', rsdLimit: { high: '2.0', unit: '%' } }));
    expect(n(r.value)).toBeCloseTo(-0.5, 10);
    expect(n(r.df)).toBeCloseTo(10, 8);
    expect(n(r.t)).toBeCloseTo(1.812461, 5);
    expect(n(r.ci?.low)).toBeCloseTo(-1.478841, 5);
    expect(n(r.ci?.high)).toBeCloseTo(0.478841, 5);
    expect(r.check?.pass).toBe(true);
    expect(r.rsdCheck?.pass).toBe(true);
    expect(ok(l33TransferComparison({ mode: 'equivalence (TOST)', sending: s, receiving: r_, margin: '1.0 %' })).check?.pass).toBe(false);
  });
  it('the simple difference criterion', () => {
    expect(ok(l33TransferComparison({ mode: 'difference', sending: s, receiving: r_, margin: '1.0 %' })).check?.pass).toBe(true);
    expect(ok(l33TransferComparison({ mode: 'difference', sending: s, receiving: r_, margin: '0.4 %' })).check?.pass).toBe(false);
    expect(refused(l33TransferComparison({ mode: 'difference', sending: s, receiving: r_, margin: '1.0 mg' }))).toContain('acceptance margin');
  });
});

describe('L34 specificity', () => {
  it('interference as % of the analyte response, resolution and peak purity', () => {
    // blank 0, placebo 4, impurity A 2 against 2000: 0, 0.2, 0.1 %.
    const r = ok(l34Specificity({ standard: '2000 units', interferences: vals('0 4 2', 'units'), limit: { high: '0.5', unit: '%' }, resolution: '2.4', resolutionLimit: { low: '2.0', unit: '' }, purity: 'yes' }));
    expect(n(r.value)).toBeCloseTo(0.2, 10);
    expect([r.check?.pass, r.resolutionCheck?.pass, r.purityCheck?.pass]).toEqual([true, true, true]);
    expect(ok(l34Specificity({ standard: '2000 units', interferences: vals('0 4 2', 'units'), purity: 'no' })).purityCheck?.pass).toBe(false);
  });
});
