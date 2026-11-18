import { describe, expect, it } from 'vitest';
import { l18ControlChart, NELSON_RULES, type L18Input } from '../../shared/templates/lab-trend.js';
import { callTemplate, TEMPLATES } from '../../shared/engine/templates.js';
import { ok, refused } from './helpers.js';

// L18: individuals and moving range chart with the eight Nelson rules. Every figure below is worked by hand.
const chart = (values: (string | number)[], over: Partial<L18Input> = {}) => ok(l18ControlChart({ points: values.map((v) => `${v} %`), ...over }));
const rules = (values: (string | number)[], over: Partial<L18Input> = {}) => chart(values, over).breaks.map((b) => [b.rule, b.points]);

describe('L18 control chart: the limits', () => {
  it('LIMS-25 mean, sigma from the moving range, control limits, standard deviation, Cpk and Ppk (hand-worked)', () => {
    // 10, 12, 11, 13, 9: mean 55 ÷ 5 = 11; moving ranges 2, 1, 2, 4, MR̄ = 9 ÷ 4 = 2.25; sigma = 2.25 ÷ 1.128 = 1.99468…;
    // limits 11 ± 5.98404…; D4 × MR̄ = 3.267 × 2.25 = 7.35075; SD: squares 1 + 1 + 0 + 4 + 4 = 10, ÷ 4 = 2.5, √ = 1.58114.
    // Cpk against 5 to 17: min(6, 6) ÷ (3 × 1.99468…) = 6 × 1.128 ÷ 6.75 = 1.00267; Ppk = 6 ÷ (3 × 1.58114) = 1.26491.
    const r = chart([10, 12, 11, 13, 9], { limit: { low: '5', high: '17', unit: '%' } });
    expect(r.n).toBe(5);
    expect(r.mean.toFixed(4)).toBe('11.0000');
    expect(r.mrBar.toFixed(4)).toBe('2.2500');
    expect(r.sigma.toFixed(5)).toBe('1.99468');
    expect(r.ucl.toFixed(5)).toBe('16.98404');
    expect(r.lcl.toFixed(5)).toBe('5.01596');
    expect(r.zones.plus2.toFixed(5)).toBe('14.98936');
    expect(r.mrUcl.toFixed(5)).toBe('7.35075');
    expect(r.sd.toFixed(5)).toBe('1.58114');
    expect(r.min.toFixed(0)).toBe('9');
    expect(r.max.toFixed(0)).toBe('13');
    expect(r.cpk!.toFixed(5)).toBe('1.00267');
    expect(r.ppk!.toFixed(5)).toBe('1.26491');
    expect(r.movingRanges.map((m) => m.toFixed(0))).toEqual(['2', '1', '2', '4']);
    expect(r.breaks).toEqual([]);
    expect(r.shown).toBe('Individuals chart of 5 results: centre line 11.000 %, sigma = MR̄ 2.25 ÷ 1.128 = 1.9947 %, control limits 5.016 to 16.984 %; no Nelson rule broken');
  });

  it('a one-sided limit gives no Cpk; the limit is converted into the results\' unit', () => {
    const r = chart([10, 12, 11, 13, 9], { limit: { high: '0.20', unit: 'mg/g' } });
    expect(r.cpk).toBeNull();
    expect(r.specHigh!.toFixed(2)).toBe('0.02');
    expect(r.lastOutOfSpec).toBe(true);
  });

  it('the baseline sets the limits from the first results only; a moving range above D4 × MR̄ is named', () => {
    // Baseline 10, 11, 10, 11: mean 10.5, MR̄ 1, sigma 1 ÷ 1.128 = 0.88652; D4 × 1 = 3.267: the range 11 → 14.5 = 3.5 is above.
    const r = chart([10, 11, 10, 11, 14.5], { baseline: 4 });
    expect(r.mean.toFixed(2)).toBe('10.50');
    expect(r.sigma.toFixed(5)).toBe('0.88652');
    expect(r.mrBreaks).toEqual([5]);
    // 14.5 is 4.5 sigma above (> 3): rule 1 at point 5, which is the last point.
    expect(r.breaks).toEqual([{ rule: 1, text: NELSON_RULES[1], points: [5] }]);
    expect(r.lastPoint).toEqual([1]);
  });

  it('refuses fewer than two results, results that do not vary, a bad baseline and mixed kinds', () => {
    expect(refused(l18ControlChart({ points: ['10 %'] }))).toBe('A control chart needs at least two results (one moving range)');
    expect(refused(l18ControlChart({ points: ['10 %', '10 %', '10 %'] }))).toBe('The results do not vary (every moving range is 0): there are no control limits to draw');
    expect(refused(l18ControlChart({ points: ['10 %', '11 %', '12 %'], baseline: 1 }))).toBe('The baseline is the number of first results that set the limits: a whole number from 2 to 3, not 1');
    expect(refused(l18ControlChart({ points: ['10 %', '11 mg'] }))).toMatch(/^The results: /);
    expect(refused(l18ControlChart({ points: [10 as unknown as string, '11'] }))).toBe('Result 1 is missing');
  });
});

// Baseline 10, 11, 10, 11 (mean 10.5, sigma 0.886525…): 1 sigma 9.6135 to 11.3865, 2 sigma 8.7270 to 12.2730,
// 3 sigma 7.8404 to 13.1596.
const B = [10, 11, 10, 11];
describe('L18 the eight Nelson rules (hand-made series)', () => {
  it('LIMS-25 rule 1: one point beyond 3 sigma (13.2 is; 13.1 is not)', () => {
    expect(rules([...B, '13.2'], { baseline: 4 })).toEqual([[1, [5]]]);
    expect(rules([...B, '13.1'], { baseline: 4 })).toEqual([]);
  });
  it('LIMS-25 rule 2: nine points in a row on one side (11 at point 4, then eight at 10.6)', () => {
    expect(rules([...B, ...Array(8).fill('10.6')], { baseline: 4 })).toEqual([[2, [4, 5, 6, 7, 8, 9, 10, 11, 12]]]);
    // A point on the centre line breaks the run.
    expect(rules([...B, ...Array(4).fill('10.6'), '10.5', ...Array(4).fill('10.6')], { baseline: 4 })).toEqual([]);
  });
  it('LIMS-25 rule 3: six points steadily rising (equal neighbours break it)', () => {
    expect(rules([...B, '10.0', '10.1', '10.2', '10.3', '10.4', '10.45'], { baseline: 4 })).toEqual([[3, [5, 6, 7, 8, 9, 10]]]);
    expect(rules([...B, '10.0', '10.1', '10.2', '10.2', '10.4', '10.45'], { baseline: 4 })).toEqual([]);
  });
  it('LIMS-25 rule 4: fourteen points alternating up and down', () => {
    expect(rules([...B, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11], { baseline: 4 })).toEqual([[4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]]]);
    expect(rules([...B, 10, 11, 10, 11, 10, 11, 10, 11, 10], { baseline: 4 })).toEqual([]);
  });
  it('LIMS-25 rule 5: two of three beyond 2 sigma on one side (the two points named)', () => {
    expect(rules([...B, '12.3', '11.0', '12.4'], { baseline: 4 })).toEqual([[5, [5, 7]]]);
    // On opposite sides: not this rule.
    expect(rules([...B, '12.3', '11.0', '8.7'], { baseline: 4 })).toEqual([]);
  });
  it('LIMS-25 rule 6: four of five beyond 1 sigma on one side', () => {
    expect(rules([...B, '11.5', '11.6', '10.5', '11.7', '11.8'], { baseline: 4 })).toEqual([[6, [5, 6, 8, 9]]]);
    expect(rules([...B, '11.5', '11.6', '10.5', '11.7', '11.3'], { baseline: 4 })).toEqual([]);
  });
  it('LIMS-25 rule 7: fifteen points in a row within 1 sigma', () => {
    // Baseline 10, 12, 10, 12: mean 11, sigma 2 ÷ 1.128 = 1.77305, 1 sigma 9.22695 to 12.77305; neither alternating nor one-sided.
    const s = [10, 12, 10, 12, '11.2', '11.4', '10.8', '10.6', '11.3', '11.5', '10.7', '10.9', '11.1', '10.8', '11.2'];
    expect(rules(s, { baseline: 4 })).toEqual([[7, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]]]);
    expect(rules(s.slice(0, 14), { baseline: 4 })).toEqual([]);
  });
  it('LIMS-25 rule 8: eight points in a row beyond 1 sigma on both sides', () => {
    expect(rules([...B, 12, 9, 12, 9, 12, 9, 12, 9], { baseline: 4 })).toEqual([[8, [5, 6, 7, 8, 9, 10, 11, 12]]]);
    // All on one side is rule 2 / 6 territory, not rule 8.
    expect(rules([...B, 12, 9, 12, 9, 12, 9, 12, '11.0'], { baseline: 4 }).map((r) => r[0])).not.toContain(8);
  });
  it('LIMS-25 a new result is out of trend only when a break includes it (lastPoint)', () => {
    // The 2-of-3 break is made by points 5 and 6; point 7 (10.5, on the centre line) adds nothing.
    const r = chart([...B, '12.3', '12.4', '10.5'], { baseline: 4 });
    expect(r.breaks.map((b) => [b.rule, b.points])).toContainEqual([5, [5, 6]]);
    expect(r.lastPoint).toEqual([]);
  });
  it('is the registered template L18', () => {
    expect(TEMPLATES.L18).toBeTypeOf('function');
    expect(callTemplate('L18', { points: ['1 %', '2 %', '3 %'] }).ok).toBe(true);
  });
});
