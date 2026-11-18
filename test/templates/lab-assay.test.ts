import { describe, expect, it } from 'vitest';
import { l1Assay, l2LabelClaim, l3OnBasis, l4Impurities, l9ResidualSolvents, l20ChromAdjustment, type L1Input, type L4Input, type L20Input } from '../../shared/templates/lab-assay.js';
import { callTemplate, TEMPLATES } from '../../shared/engine/templates.js';
import { ok, refused } from './helpers.js';

// A tablet assay used throughout (invented demo numbers).
// Standard 50.00 mg, potency 99.5 % as is, 100 mL, then 5 mL to 50 mL: 50.00 × 0.995 ÷ (100 × 10) = 0.04975 mg/mL.
const STD = { mass: '50.00 mg', potency: '99.5 %', dilution: { volume: '100 mL', steps: [{ aliquot: '5 mL', to: '50 mL' }] } };
// Sample: 250.0 mg of powder (average tablet weight 250.0 mg), 100 mL, then 5 mL to 50 mL: 1000 mL in all.
const SAMPLE = { mass: '250.0 mg', averageUnitWeight: '250.0 mg', dilution: { volume: '100 mL', steps: [{ aliquot: '5 mL', to: '50 mL' }] } };
const BASE: L1Input = {
  mode: 'external standard',
  sampleResponses: ['999000', '1001000'], // mean 1000000
  standardResponses: ['994000', '996000'], // mean 995000
  standard: STD,
  sample: SAMPLE,
  per: 'mass',
};
const L1 = (o: Partial<L1Input>): ReturnType<typeof l1Assay> => l1Assay({ ...BASE, ...o } as L1Input);

describe('L1 Assay by external standard: single standard', () => {
  it('L1 single standard: % of the sample (tablet powder)', () => {
    // C sample = 1000000 × 0.04975 ÷ 995000 = 0.05 mg/mL; × 1000 mL = 50 mg; 50 ÷ 250.0 × 100 = 20 %
    const r = ok(L1({}));
    expect(r.value.toFixed(6)).toBe('20.000000');
    expect(r.unit).toBe('%');
    expect(r.standardConcentration?.toFixed(6)).toBe('0.049750');
    expect(r.sampleConcentration.toFixed(6)).toBe('0.050000');
    expect(r.amount.toFixed(4)).toBe('50.0000');
  });

  it('L1 single standard: shows the worked line from standard to result', () => {
    const s = ok(L1({})).shown;
    expect(s).toContain('standard 50.00 mg × 99.5 % ÷ 100 ÷ (100 mL × 50 mL ÷ 5 mL) = 0.04975 mg/mL');
    expect(s).toContain('sample mean of (999000, 1001000) = 1000000 ÷ standard mean of (994000, 996000) = 995000');
    expect(s).toContain('= 50 mg in the sample ÷ 250.0 mg × 100 = 20 %');
    expect(s).toMatch(/result 20\.0 %$/);
  });

  it('L1 single standard: mg per unit from the average unit weight', () => {
    // 50 mg in 250.0 mg of powder × 250.0 mg per tablet = 50 mg per tablet
    const r = ok(L1({ per: 'unit' }));
    expect(r.value.toFixed(4)).toBe('50.0000');
    expect(r.unit).toBe('mg');
    expect(r.shown).toContain('× average unit weight 250.0 mg = 50 mg per unit');
  });

  it('L1 single standard: per unit with an average weight different from the portion', () => {
    // 50 mg in 250.0 mg × 501.2 mg per tablet = 100.24 mg per tablet
    const r = ok(L1({ per: 'unit', sample: { ...SAMPLE, averageUnitWeight: '501.2 mg' } }));
    expect(r.value.toFixed(2)).toBe('100.24');
  });

  it('L1 single standard: N whole units dissolved together', () => {
    // 10 tablets, 1000 mL, 5 → 50 mL: 10000 mL; 0.05 mg/mL × 10000 = 500 mg ÷ 10 = 50 mg per tablet
    const r = ok(L1({ per: 'unit', sample: { units: '10 tablets', dilution: { volume: '1000 mL', steps: [{ aliquot: '5 mL', to: '50 mL' }] } } }));
    expect(r.value.toFixed(4)).toBe('50.0000');
  });

  it('L1 single standard: result unit mg/g and µg/mg (per mass)', () => {
    // 20 % = 200 mg/g = 200 µg/mg
    expect(ok(L1({ unit: 'mg/g' })).value.toFixed(3)).toBe('200.000');
    expect(ok(L1({ unit: 'µg/mg' })).value.toFixed(3)).toBe('200.000');
  });

  it('L1 single standard: per unit in g', () => {
    expect(ok(L1({ per: 'unit', unit: 'g' })).value.toFixed(4)).toBe('0.0500');
  });

  it('L1 single standard: a sample blank is taken off the mean sample reading', () => {
    // (1005000 − 5000) = 1000000: same as the base case, 20 %
    const r = ok(L1({ sampleResponses: ['1005000'], sampleBlank: '5000' }));
    expect(r.value.toFixed(6)).toBe('20.000000');
    expect(r.shown).toContain('(1005000) − blank 5000');
  });

  it('L1 single standard: response as a difference of two readings (treated − untreated) via the standard blank too', () => {
    // sample 1002000 − 2000 = 1000000; standard 997000 − 2000 = 995000 → 20 %
    expect(ok(L1({ sampleResponses: ['1002000'], sampleBlank: '2000', standardResponses: ['997000'], standardBlank: '2000' })).value.toFixed(6)).toBe('20.000000');
  });

  it('L1 single standard: peak height as the response', () => {
    expect(ok(L1({ response: 'peak height', sampleResponses: ['1000'], standardResponses: ['995'] })).value.toFixed(6)).toBe('20.000000');
  });

  it('L1 single standard: absorbance readings in AU and mAU convert', () => {
    // sample 0.500 AU, standard 497.5 mAU = 0.4975 AU → C = 0.5 × 0.04975 ÷ 0.4975 = 0.05 mg/mL → 20 %
    expect(ok(L1({ response: 'absorbance', sampleResponses: ['0.500 AU'], standardResponses: ['497.5 mAU'] })).value.toFixed(6)).toBe('20.000000');
  });

  it('L1 single standard: limit checked with pharmacopoeia rounding', () => {
    // 50 mg per tablet against 47.5-52.5 mg
    expect(ok(L1({ per: 'unit', limit: { low: '47.5', high: '52.5', unit: 'mg' } })).check?.pass).toBe(true);
    // sample 948950 → 948950 × 0.04975 ÷ 995000 × 1000 = 47.4475 mg; rounds to 47.4: fails
    const r = ok(L1({ per: 'unit', sampleResponses: ['948950'], limit: { low: '47.5', high: '52.5', unit: 'mg' } }));
    expect(r.value.toFixed(4)).toBe('47.4475');
    expect(r.check?.pass).toBe(false);
    // sample 949000 → 47.45 mg; rounds to 47.5 (half up): passes
    expect(ok(L1({ per: 'unit', sampleResponses: ['949000'], limit: { low: '47.5', high: '52.5', unit: 'mg' } })).check?.pass).toBe(true);
  });

  it('L1 single standard: decimals setting changes only the display', () => {
    const r = ok(L1({ decimals: 3 }));
    expect(r.shown).toMatch(/result 20\.000 %$/);
  });
});

describe('L1 standard potency and basis (safety rule S3)', () => {
  it('L1 standard potency on the dried basis, standard used as is: × (100 − LOD) ÷ 100', () => {
    // 100.0 % dried × (100 − 0.5) ÷ 100 = 99.5 % as is → same as the base case
    const r = ok(L1({ standard: { ...STD, potency: '100.0 %', potencyBasis: 'dried', lod: '0.5 %' } }));
    expect(r.value.toFixed(6)).toBe('20.000000');
    expect(r.shown).toContain('100.0 % × (100 − 0.5 %) ÷ 100');
  });

  it('L1 standard potency on the anhydrous basis, with the standard\'s water', () => {
    // 99.8 % × (100 − 2.0) ÷ 100 = 97.804 %; C std = 50.00 × 0.97804 ÷ 1000 = 0.048902 mg/mL
    // C sample = 1000000 × 0.048902 ÷ 995000 = 0.049147738…; × 1000 ÷ 250 × 100 = 19.65909…%
    const r = ok(L1({ standard: { ...STD, potency: '99.8 %', potencyBasis: 'anhydrous', water: '2.0 %' } }));
    expect(r.standardConcentration?.toFixed(6)).toBe('0.048902');
    expect(r.value.toFixed(4)).toBe('19.6591');
  });

  it('L1 standard dried before use: its dried-basis potency is used directly', () => {
    expect(ok(L1({ standard: { ...STD, potencyBasis: 'dried', driedBeforeUse: true } })).value.toFixed(6)).toBe('20.000000');
  });

  it('L1 standard potency in µg/mg', () => {
    // 995 µg/mg = 99.5 %
    expect(ok(L1({ standard: { ...STD, potency: '995 µg/mg' } })).value.toFixed(6)).toBe('20.000000');
  });

  it.each([
    [{ potencyBasis: 'dried', driedBeforeUse: true, lod: '0.5 %' }, /Basis applied twice \(safety rule S3\).*dried before use/],
    [{ potencyBasis: 'as is', lod: '0.5 %' }, /S3.*as-is potency/],
    [{ potencyBasis: 'as is', driedBeforeUse: true }, /S3.*dried before use but its potency is as is/],
    [{ potencyBasis: 'dried' }, /give its loss on drying/],
    [{ potencyBasis: 'anhydrous' }, /give its water content/],
    [{ potencyBasis: 'dried', water: '1.0 %' }, /corrected with the loss on drying, not the water/],
    [{ potencyBasis: 'anhydrous', lod: '1.0 %' }, /corrected with the water content, not the loss on drying/],
    [{ potencyBasis: 'dried', lod: '100 %' }, /from 0 to less than 100 %/],
    [{ potency: '0 %' }, /potency must be more than zero/],
    [{ potency: undefined }, /potency from the standard's item is missing/],
  ] as [Record<string, unknown>, RegExp][])('L1 standard refuses %o', (o, msg) => {
    expect(refused(L1({ standard: { ...STD, ...o } }))).toMatch(msg);
  });

  it('L1 standard of declared strength (reference solution), diluted', () => {
    // 0.4975 mg/mL, 5 mL to 50 mL = 0.04975 mg/mL → 20 %
    const r = ok(L1({ standard: { declared: '0.4975 mg/mL', dilution: { steps: [{ aliquot: '5 mL', to: '50 mL' }] } } }));
    expect(r.value.toFixed(6)).toBe('20.000000');
    expect(r.shown).toContain('standard 0.4975 mg/mL ÷ (50 mL ÷ 5 mL) = 0.04975 mg/mL');
  });

  it('L1 standard of declared strength in µg/mL', () => {
    expect(ok(L1({ standard: { declared: '49.75 µg/mL' } })).value.toFixed(6)).toBe('20.000000');
  });

  it.each([
    [{ declared: '0.5 mg/mL', mass: '50 mg' }, /either the weighed amount or the declared concentration/],
    [{ declared: '0.5 mg/mL', dilution: { volume: '100 mL' } }, /declared strength is not dissolved again/],
    [{ declared: '0.5 mg' }, /must be a mass concentration/],
    [{ potency: '99.5 %' }, /give the weighed amount/],
    [{ mass: '50 mg', potency: '99.5 %' }, /first flask/],
    [{ mass: '50 mL', potency: '99.5 %', dilution: { volume: '100 mL' } }, /must be a mass/],
  ] as [Record<string, unknown>, RegExp][])('L1 standard refuses %o', (s, msg) => {
    expect(refused(L1({ standard: s }))).toMatch(msg);
  });
});

describe('L1 bracketing standards', () => {
  const BR: Partial<L1Input> = { mode: 'bracketing', sampleResponses: ['1000000'], standardResponses: ['990000', '1000000'], standardResponsesAfter: ['1000000', '1010000'] };

  it('L1 bracketing standards: mean of the mean before and the mean after', () => {
    // before 995000, after 1005000 → 1000000; C sample = C std = 0.04975 mg/mL; × 1000 = 49.75 mg ÷ 250 × 100 = 19.9 %
    const r = ok(L1(BR));
    expect(r.value.toFixed(6)).toBe('19.900000');
    expect(r.shown).toContain('(before mean of (990000, 1000000) = 995000; after mean of (1000000, 1010000) = 1005000) mean = 1000000');
  });

  it('L1 bracketing standards: unequal numbers before and after still weigh the two means equally', () => {
    // before mean 995000 (1 injection), after mean (1000000+1010000+1020000)/3 = 1010000 → 1002500
    // C = 1000000 × 0.04975 ÷ 1002500 = 0.0496259…; × 1000 ÷ 250 × 100 = 19.85037…%
    const r = ok(L1({ ...BR, standardResponses: ['995000'], standardResponsesAfter: ['1000000', '1010000', '1020000'] }));
    expect(r.value.toFixed(5)).toBe('19.85037');
  });

  it('L1 bracketing standards: refuses without the standards after', () => {
    expect(refused(L1({ ...BR, standardResponsesAfter: undefined }))).toMatch(/after the samples as well as before/);
  });

  it('L1 bracketing standards: standards after the samples in the single-standard mode are refused', () => {
    expect(refused(L1({ standardResponsesAfter: ['1000000'] }))).toMatch(/use the bracketing mode/);
  });
});

describe('L1 internal standard', () => {
  const IS: Partial<L1Input> = {
    mode: 'internal standard',
    sampleResponses: ['2000', '2020'],
    sampleIsResponses: ['1000', '1010'], // ratios 2.0, 2.0
    standardResponses: ['1990', '2010'],
    standardIsResponses: ['1000', '1000'], // ratios 1.99, 2.01 → 2.0
  };

  it('L1 internal standard: response ratio analyte ÷ internal standard, injection by injection', () => {
    // C sample = 2.0 ÷ 2.0 × 0.04975 = 0.04975 mg/mL → 49.75 mg ÷ 250 × 100 = 19.9 %
    const r = ok(L1(IS));
    expect(r.value.toFixed(6)).toBe('19.900000');
    expect(r.shown).toContain('mean ratio of (2000 ÷ 1000, 2020 ÷ 1010) = 2');
  });

  it('L1 internal standard: a different sample ratio', () => {
    // sample ratio 2100 ÷ 1000 = 2.1; standard 2.0 → C = 2.1 ÷ 2 × 0.04975 = 0.0522375; × 1000 ÷ 250 × 100 = 20.895 %
    expect(ok(L1({ ...IS, sampleResponses: ['2100'], sampleIsResponses: ['1000'] })).value.toFixed(3)).toBe('20.895');
  });

  it.each([
    [{ sampleIsResponses: ['1000'] }, /one internal standard reading for each analyte reading \(2\)/],
    [{ standardIsResponses: undefined }, /one internal standard reading for each analyte reading/],
    [{ sampleIsResponses: ['0', '1000'] }, /internal standard response is zero/],
    [{ sampleBlank: '10' }, /blank is not taken off response ratios/],
  ] as [Partial<L1Input>, RegExp][])('L1 internal standard refuses %o', (o, msg) => {
    expect(refused(L1({ ...IS, ...o }))).toMatch(msg);
  });

  it('L1 internal standard: internal standard readings in the external standard mode are refused', () => {
    expect(refused(L1({ sampleIsResponses: ['1000', '1000'] }))).toMatch(/not the internal standard mode/);
  });
});

describe('L1 calibration curve', () => {
  const pts = (rows: [string, string][]): { concentration: string; response: string }[] => rows.map(([concentration, response]) => ({ concentration, response }));
  // Reading = 20000 × C + 10 exactly
  const CURVE = pts([['0.02 mg/mL', '410'], ['0.04 mg/mL', '810'], ['0.06 mg/mL', '1210'], ['0.08 mg/mL', '1610']]);
  // Sample 50.00 mg, 100 mL, 10 mL to 100 mL: 1000 mL
  const CS = { mass: '50.00 mg', dilution: { volume: '100 mL', steps: [{ aliquot: '10 mL', to: '100 mL' }] } };
  const C: Partial<L1Input> = { mode: 'calibration curve', standard: undefined, standardResponses: undefined, sampleResponses: ['1010'], calibration: { points: CURVE }, sample: CS };

  it('L1 calibration curve: least squares and read-back', () => {
    // (1010 − 10) ÷ 20000 = 0.05 mg/mL; × 1000 mL = 50 mg ÷ 50.00 mg × 100 = 100 %
    const r = ok(L1(C));
    expect(r.value.toFixed(6)).toBe('100.000000');
    expect(r.curve?.slope.toFixed(6)).toBe('20000.000000');
    expect(r.curve?.intercept.toFixed(6)).toBe('10.000000');
    expect(r.curve?.r.toFixed(6)).toBe('1.000000');
  });

  it('L1 calibration curve: a scattered curve, hand-checked fit', () => {
    // x = 0.02, 0.04, 0.06, 0.08; y = 400, 820, 1180, 1600. x̄ = 0.05, ȳ = 1000
    // Sxy = Σ(x − x̄)(y − ȳ) = (−0.03)(−600) + (−0.01)(−180) + (0.01)(180) + (0.03)(600) = 39.6; Sxx = 0.002
    // slope = 19800; intercept = 1000 − 19800 × 0.05 = 10; Syy = 360000 + 32400 + 32400 + 360000 = 784800
    // r = 39.6 ÷ √(0.002 × 784800) = 39.6 ÷ 39.6182… = 0.99954…
    const r = ok(L1({ ...C, sampleResponses: ['1000'], calibration: { points: pts([['0.02 mg/mL', '400'], ['0.04 mg/mL', '820'], ['0.06 mg/mL', '1180'], ['0.08 mg/mL', '1600']]) } }));
    expect(r.curve?.slope.toFixed(3)).toBe('19800.000');
    expect(r.curve?.intercept.toFixed(3)).toBe('10.000');
    expect(r.curve?.r.toFixed(5)).toBe('0.99954');
    // (1000 − 10) ÷ 19800 = 0.05 mg/mL → 100 %
    expect(r.value.toFixed(6)).toBe('100.000000');
  });

  it('L1 calibration curve: r against the method\'s minimum, rounded as the minimum is written', () => {
    const scattered = pts([['0.02 mg/mL', '400'], ['0.04 mg/mL', '820'], ['0.06 mg/mL', '1180'], ['0.08 mg/mL', '1600']]);
    // r = 0.99954: rounds to 1.000 against "0.999" → valid; rounds to 0.9995 against "0.9999" → not valid
    expect(ok(L1({ ...C, sampleResponses: ['1000'], calibration: { points: scattered, minR: '0.999' } })).value.toFixed(1)).toBe('100.0');
    expect(refused(L1({ ...C, sampleResponses: ['1000'], calibration: { points: scattered, minR: '0.9999' } }))).toMatch(/correlation coefficient 0\.9995.*not valid/);
  });

  it('L1 calibration curve: through the origin', () => {
    // y = 400, 800, 1200 at 0.02, 0.04, 0.06: slope Σxy ÷ Σx² = 20000; sample 1000 → 0.05 mg/mL → 100 %
    const r = ok(L1({ ...C, sampleResponses: ['1000'], calibration: { points: pts([['0.02 mg/mL', '400'], ['0.04 mg/mL', '800'], ['0.06 mg/mL', '1200']]), throughOrigin: true } }));
    expect(r.curve?.intercept.toFixed(1)).toBe('0.0');
    expect(r.value.toFixed(6)).toBe('100.000000');
  });

  it('L1 calibration curve: with an internal standard (ratios)', () => {
    // ratios 0.41, 0.81, 1.21, 1.61 against 0.02 … 0.08 mg/mL: slope 20, intercept 0.01; sample 2020 ÷ 2000 = 1.01 → 0.05 mg/mL
    const points = [['0.02 mg/mL', '410'], ['0.04 mg/mL', '810'], ['0.06 mg/mL', '1210'], ['0.08 mg/mL', '1610']].map(([c, y]) => ({ concentration: c as string, response: y as string, isResponse: '1000' }));
    const r = ok(L1({ ...C, sampleResponses: ['2020'], sampleIsResponses: ['2000'], calibration: { points } }));
    expect(r.curve?.slope.toFixed(6)).toBe('20.000000');
    expect(r.value.toFixed(6)).toBe('100.000000');
  });

  it('L1 calibration curve: concentrations in µg/mL', () => {
    const r = ok(L1({ ...C, calibration: { points: pts([['20 µg/mL', '410'], ['40 µg/mL', '810'], ['60 µg/mL', '1210'], ['80 µg/mL', '1610']]) } }));
    expect(r.value.toFixed(6)).toBe('100.000000');
  });

  it.each([
    [['1700'], /outside the calibrated range 0\.02 mg\/mL to 0\.08 mg\/mL.*dilute the sample/], // (1700 − 10) ÷ 20000 = 0.0845
    [['300'], /outside the calibrated range/], // 0.0145
  ])('L1 calibration curve: refuses a sample outside the range (%s)', (y, msg) => {
    expect(refused(L1({ ...C, sampleResponses: y }))).toMatch(msg);
  });

  it('L1 calibration curve: the ends of the range are inside', () => {
    // 1610 → 0.08 mg/mL → 160 %
    expect(ok(L1({ ...C, sampleResponses: ['1610'] })).value.toFixed(3)).toBe('160.000');
  });

  it.each([
    [pts([['0.02 mg/mL', '410'], ['0.04 mg/mL', '810']]), /at least 3 standards/],
    [pts([['0.04 mg/mL', '400'], ['0.04 mg/mL', '810'], ['0.04 mg/mL', '820']]), /two different concentrations/],
    [pts([['0.02 mg/mL', '800'], ['0.04 mg/mL', '800'], ['0.06 mg/mL', '800']]), /same reading/],
    [pts([['0.02 mg/mL', '1200'], ['0.04 mg/mL', '800'], ['0.06 mg/mL', '400']]), /slope not above zero/],
    [pts([['0.02 mg', '410'], ['0.04 mg', '810'], ['0.06 mg', '1210']]), /must be a mass concentration/],
  ] as [{ concentration: string; response: string }[], RegExp][])('L1 calibration curve refuses bad standards %#', (points, msg) => {
    expect(refused(L1({ ...C, calibration: { points } }))).toMatch(msg);
  });

  it('L1 calibration curve: calibration standards in another mode are refused', () => {
    expect(refused(L1({ calibration: { points: CURVE } }))).toMatch(/use the calibration curve mode/);
  });
});

describe('L1 specific absorbance (no reference standard; safety rule S1)', () => {
  // Sample 100.0 mg, 100 mL, then 1 mL to 100 mL: 10000 mL. A = 0.7079; A(1 %, 1 cm) = 715.
  const SA: Partial<L1Input> = {
    mode: 'specific absorbance',
    standard: undefined,
    standardResponses: undefined,
    sampleResponses: ['0.7079'],
    specificAbsorbance: { value: '715', form: 'A(1 %, 1 cm)', pathLength: '1 cm' },
    sample: { mass: '100.0 mg', dilution: { volume: '100 mL', steps: [{ aliquot: '1 mL', to: '100 mL' }] } },
  };

  it('L1 specific absorbance: A ÷ (A(1 %, 1 cm) × b) in g per 100 mL', () => {
    // 0.7079 ÷ 715 = 0.00099006993 g/100 mL = 0.0099006993 mg/mL; × 10000 mL = 99.006993 mg ÷ 100.0 mg × 100 = 99.007 %
    const r = ok(L1(SA));
    expect(r.value.toFixed(3)).toBe('99.007');
    expect(r.standardConcentration).toBeUndefined();
    expect(r.shown).toContain('sample 0.7079 ÷ (A(1 %, 1 cm) 715 × 1 cm)');
  });

  it('L1 specific absorbance: the absorptivity form (per g/L) gives the same with a tenth of the figure', () => {
    // a = 71.5 L/(g·cm): 0.7079 ÷ 71.5 = 0.0099006993 g/L = mg/mL → 99.007 %
    expect(ok(L1({ ...SA, specificAbsorbance: { value: '71.5', form: 'absorptivity', pathLength: '1 cm' } })).value.toFixed(3)).toBe('99.007');
  });

  it('L1 specific absorbance: S1, the figure taken in the wrong form is 10 times off', () => {
    // 715 read as an absorptivity: 0.7079 ÷ 715 = 0.00099 mg/mL → 9.9007 %: shown and caught by the limit
    const r = ok(L1({ ...SA, specificAbsorbance: { value: '715', form: 'absorptivity', pathLength: '1 cm' }, limit: { low: '95.0', high: '105.0', unit: '%' } }));
    expect(r.value.toFixed(4)).toBe('9.9007');
    expect(r.check?.pass).toBe(false);
  });

  it('L1 specific absorbance: S1, the form must be stated', () => {
    expect(refused(L1({ ...SA, specificAbsorbance: { value: '715', pathLength: '1 cm' } as never }))).toMatch(/S1.*differ 10 times/);
  });

  it('L1 specific absorbance: path length in mm, and a 0.5 cm cell', () => {
    expect(ok(L1({ ...SA, specificAbsorbance: { value: '715', form: 'A(1 %, 1 cm)', pathLength: '10 mm' } })).value.toFixed(3)).toBe('99.007');
    // a 0.5 cm cell: C = 0.7079 ÷ (715 × 0.5) → twice the content, 198.014 %
    expect(ok(L1({ ...SA, specificAbsorbance: { value: '715', form: 'A(1 %, 1 cm)', pathLength: '0.5 cm' } })).value.toFixed(3)).toBe('198.014');
  });

  it('L1 specific absorbance: mean of readings and a blank', () => {
    // (0.7080 + 0.7090) ÷ 2 = 0.7085 − blank 0.0006 = 0.7079 → 99.007 %
    expect(ok(L1({ ...SA, sampleResponses: ['0.7080', '0.7090'], sampleBlank: '0.0006' })).value.toFixed(3)).toBe('99.007');
  });

  it('L1 specific absorbance: per unit with the average unit weight', () => {
    // 99.006993 mg in 100.0 mg × 120.0 mg per tablet = 118.808 mg per tablet
    const r = ok(L1({ ...SA, per: 'unit', sample: { mass: '100.0 mg', averageUnitWeight: '120.0 mg', dilution: { volume: '100 mL', steps: [{ aliquot: '1 mL', to: '100 mL' }] } } }));
    expect(r.value.toFixed(3)).toBe('118.808');
  });

  it('L1 specific absorbance: conversion to IU (retinol style)', () => {
    // 99.006993 mg × 1000 IU/mg (invented) = 99006.993 IU in 100.0 mg → 990069.93 IU/g
    const r = ok(L1({ ...SA, iuPerMg: '1000 IU/mg' }));
    expect(r.unit).toBe('IU/g');
    expect(r.value.toFixed(2)).toBe('990069.93');
    // per unit in IU: × 120.0 mg ÷ 100.0 mg = 118808.39 IU
    const u = ok(L1({ ...SA, iuPerMg: '1000 IU/mg', per: 'unit', sample: { mass: '100.0 mg', averageUnitWeight: '120.0 mg', dilution: { volume: '100 mL', steps: [{ aliquot: '1 mL', to: '100 mL' }] } } }));
    expect(u.unit).toBe('IU');
    expect(u.value.toFixed(2)).toBe('118808.39');
  });

  it.each([
    [{ standard: STD }, /uses no reference standard/],
    [{ specificAbsorbance: undefined }, /needs the specific absorbance figure/],
    [{ specificAbsorbance: { value: '715', form: 'A(1 %, 1 cm)', pathLength: '1 mL' } }, /path length must be a length/],
    [{ specificAbsorbance: { value: '715 L/g', form: 'A(1 %, 1 cm)', pathLength: '1 cm' } }, /plain decimal/],
    [{ specificAbsorbance: { value: '0', form: 'A(1 %, 1 cm)', pathLength: '1 cm' } }, /more than zero/],
    [{ response: 'peak area' }, /reads an absorbance/],
    [{ sampleResponses: ['0.0005'], sampleBlank: '0.0010' }, /negative/],
  ] as [Partial<L1Input>, RegExp][])('L1 specific absorbance refuses %#', (o, msg) => {
    expect(refused(L1({ ...SA, ...o }))).toMatch(msg);
  });

  it('L1 specific absorbance: given in the external standard mode it is refused', () => {
    expect(refused(L1({ specificAbsorbance: { value: '715', form: 'A(1 %, 1 cm)', pathLength: '1 cm' } }))).toMatch(/use the specific absorbance mode/);
  });

  it('L1: IU conversion outside the specific absorbance mode is refused', () => {
    expect(refused(L1({ iuPerMg: '1000 IU/mg' }))).toMatch(/belongs to the specific absorbance mode/);
  });
});

describe('L1 results per volume (liquids, safety rule S7)', () => {
  const LIQ = { volume: '5.0 mL', dilution: { volume: '100 mL', steps: [{ aliquot: '5 mL', to: '50 mL' }] } };

  it('L1 per volume: sample taken by volume', () => {
    // C = 0.05 mg/mL × 1000 mL = 50 mg in 5.0 mL → 10 mg/mL
    const r = ok(L1({ per: 'volume', sample: LIQ }));
    expect(r.unit).toBe('mg/mL');
    expect(r.value.toFixed(4)).toBe('10.0000');
  });

  it('L1 per volume: result in % w/v and µg/mL', () => {
    // 10 mg/mL = 1 % w/v = 10000 µg/mL
    expect(ok(L1({ per: 'volume', sample: LIQ, unit: '%w/v' })).value.toFixed(4)).toBe('1.0000');
    expect(ok(L1({ per: 'volume', sample: LIQ, unit: 'µg/mL' })).value.toFixed(1)).toBe('10000.0');
  });

  it('L1 per volume: sample taken by mass with its weight per mL', () => {
    // 50 mg in 6.000 g = 6000 mg; × 1.20 g/mL × 1000 = 10 mg/mL
    const r = ok(L1({ per: 'volume', sample: { mass: '6.000 g', weightPerMl: '1.20 g/mL', dilution: LIQ.dilution } }));
    expect(r.value.toFixed(4)).toBe('10.0000');
    expect(r.shown).toContain('weight per mL 1.20 g/mL');
  });

  it('L1 per volume: S7, a liquid taken by mass without its weight per mL is refused', () => {
    expect(refused(L1({ per: 'volume', sample: { mass: '6.000 g', dilution: LIQ.dilution } }))).toMatch(/Safety rule S7.*weight per mL/);
  });

  it.each([
    [{ per: 'mass' as const, sample: LIQ }, /needs the sample taken by mass/],
    [{ per: 'unit' as const, sample: LIQ }, /use the result per volume/],
    [{ per: 'unit' as const, sample: { mass: '250 mg', dilution: SAMPLE.dilution } }, /needs the average unit weight/],
    [{ per: 'volume' as const, sample: { units: '10', dilution: SAMPLE.dilution } }, /use the result per unit/],
    [{ per: 'volume' as const, sample: LIQ, unit: '%' }, /result unit per volume must be a mass concentration/],
    [{ per: 'mass' as const, unit: 'mg' }, /result unit per mass must be a percentage/],
    [{ per: 'unit' as const, unit: '%' }, /result unit per unit must be a mass/],
  ] as [Partial<L1Input>, RegExp][])('L1 per volume/unit refuses %#', (o, msg) => {
    expect(refused(L1(o))).toMatch(msg);
  });
});

describe('L1 sample and reading refusals', () => {
  it.each([
    [{ sample: { dilution: SAMPLE.dilution } }, /exactly one of/],
    [{ sample: { mass: '250 mg', volume: '5 mL', dilution: SAMPLE.dilution } }, /exactly one of/],
    [{ sample: { mass: '0 mg', dilution: SAMPLE.dilution } }, /more than zero/],
    [{ sample: { units: '2.5', dilution: SAMPLE.dilution } }, /whole number/],
    [{ sample: { mass: '250 mg', dilution: {} } }, /first flask/],
    [{ sample: { mass: '250 mg', dilution: { volume: '100 mL', steps: [{ aliquot: '60 mL', to: '50 mL' }] } } }, /aliquot \(60 mL\) is more than the volume it is made up to \(50 mL\)/],
    [{ sample: { mass: '250 mg', dilution: { volume: '100 mg' } } }, /must be a volume/],
    [{ sampleResponses: [] }, /at least one reading/],
    [{ sampleResponses: ['-5'] }, /cannot be negative/],
    [{ sampleResponses: ['1000 AU'] }, /a peak area is a plain number/],
    [{ sampleResponses: ['1000 mg'] }, /must be a number or an absorbance/],
    [{ standardResponses: ['0'] }, /reading after the blank is zero/],
    [{ sampleResponses: [{ value: 1000 as unknown as string, unit: '' }] }, /not as a JavaScript number/],
    [{ onBasis: { basis: 'dried', lod: '1.0 %' }, per: 'unit' as const }, /not put on a basis/],
  ] as [Partial<L1Input>, RegExp][])('L1 refuses %#', (o, msg) => {
    expect(refused(L1(o))).toMatch(msg);
  });

  it('L1: the standard is required in the standard modes', () => {
    expect(refused(L1({ standard: undefined }))).toMatch(/The standard is missing/);
  });
});

describe('L1 result on a basis (L3 inside L1)', () => {
  it('L1 on the dried basis with the sample\'s own LOD', () => {
    // 20 % × 100 ÷ (100 − 2.0) = 20.40816…%
    const r = ok(L1({ onBasis: { basis: 'dried', lod: '2.0 %' } }));
    expect(r.value.toFixed(4)).toBe('20.4082');
    expect(r.shown).toContain('on the dried basis');
  });

  it('L1 on a basis refuses a test portion dried before the test (S3)', () => {
    expect(refused(L1({ onBasis: { basis: 'dried', lod: '2.0 %', measuredOn: 'dried sample' } }))).toMatch(/S3/);
  });
});

describe('L2 % label claim', () => {
  it.each([
    ['50 mg', '50 mg', '100.0'],
    ['49.2 mg', '50 mg', '98.4'], // 49.2 ÷ 50 × 100
    ['0.5012 g', '500 mg', '100.2'], // 501.2 ÷ 500 × 100 = 100.24
    ['51200 IU', '50000 IU', '102.4'], // 51200 ÷ 50000
  ])('L2: %s ÷ %s × 100 = %s %%', (c, l, want) => {
    expect(ok(l2LabelClaim({ content: c, labelClaim: l })).value.toFixed(1)).toBe(want);
  });

  it('L2: shows the worked line', () => {
    expect(ok(l2LabelClaim({ content: '49.2 mg', labelClaim: '50 mg' })).shown).toBe('49.2 mg ÷ 50 mg × 100 = 98.4 % of label claim');
  });

  it('L2: per mL against a label claim per 5 mL', () => {
    // label 125 mg per 5 mL = 25 mg/mL; found 24.6 mg/mL → 98.4 %
    const r = ok(l2LabelClaim({ content: '24.6 mg/mL', labelClaim: '125 mg', labelPer: '5 mL' }));
    expect(r.value.toFixed(1)).toBe('98.4');
    expect(r.shown).toContain('(125 mg ÷ 5 mL = 25 mg/mL)');
  });

  it('L2: content per mL against a label in % w/v', () => {
    // 1 % w/v = 10 mg/mL; 9.85 mg/mL → 98.5 %
    expect(ok(l2LabelClaim({ content: '9.85 mg/mL', labelClaim: '1 %w/v' })).value.toFixed(1)).toBe('98.5');
  });

  it('L2: takes the L1 result straight in', () => {
    // L1 per unit 49.75 mg (bracketing) against 50 mg = 99.5 %
    const content = ok(l1Assay({ ...BASE, mode: 'bracketing', sampleResponses: ['1000000'], standardResponses: ['995000'], standardResponsesAfter: ['1005000'], per: 'unit' }));
    expect(ok(l2LabelClaim({ content, labelClaim: '50 mg' })).value.toFixed(2)).toBe('99.50');
  });

  it('L2: takes an L1 per-volume result and the label per 5 mL', () => {
    const content = ok(l1Assay({ ...BASE, per: 'volume', sample: { volume: '5.0 mL', dilution: SAMPLE.dilution } }));
    // 10 mg/mL against 50 mg per 5 mL = 10 mg/mL → 100 %
    expect(ok(l2LabelClaim({ content, labelClaim: '50 mg', labelPer: '5 mL' })).value.toFixed(2)).toBe('100.00');
  });

  it('L2: limit with pharmacopoeia rounding (94.95 passes 95.0-105.0, 94.94 fails)', () => {
    expect(ok(l2LabelClaim({ content: '47.475 mg', labelClaim: '50 mg', limit: { low: '95.0', high: '105.0', unit: '%' } })).check?.pass).toBe(true);
    expect(ok(l2LabelClaim({ content: '47.47 mg', labelClaim: '50 mg', limit: { low: '95.0', high: '105.0', unit: '%' } })).check?.pass).toBe(false);
  });

  it.each([
    [{ content: '24.6 mg/mL', labelClaim: '125 mg' }, /S7.*give the volume the label claim is per/],
    [{ content: '123 mg', labelClaim: '125 mg', labelPer: '5 mL' }, /S7.*must be per mL/],
    [{ content: '24.6 mg/mL', labelClaim: '125 mg', labelPer: '5 mg' }, /must be a volume/],
    [{ content: '50 mg', labelClaim: '0 mg' }, /more than zero/],
    [{ content: '-1 mg', labelClaim: '50 mg' }, /cannot be negative/],
    [{ content: '50000 IU', labelClaim: '50 mg' }, /never a mass/],
    [{ content: '50 mg', labelClaim: '50 mL' }, /cannot be converted/],
  ] as [Parameters<typeof l2LabelClaim>[0], RegExp][])('L2 refuses %#', (i, msg) => {
    expect(refused(l2LabelClaim(i))).toMatch(msg);
  });
});

describe('L3 Result on a basis', () => {
  it.each([
    [{ result: '98.0 %', basis: 'dried', lod: '2.0 %' }, '100.000000'], // 98 × 100 ÷ 98
    [{ result: '98.0 %', basis: 'anhydrous', water: '5.0 %' }, '103.157895'], // 98 × 100 ÷ 95 = 103.1578947…
    [{ result: '98.0 %', basis: 'anhydrous and solvent-free', water: '1.5 %', solvents: '0.5 %' }, '100.000000'], // 98 × 100 ÷ 98
    [{ result: '99.0 %', basis: 'solvent-free', solvents: '1.0 %' }, '100.000000'], // 99 ÷ 99
    [{ result: '97.0 %', basis: 'ignited', loi: '3.0 %' }, '100.000000'], // 97 ÷ 97
    [{ result: '950 µg/mg', basis: 'anhydrous', water: '3.0 %' }, '979.381443'], // 950 × 100 ÷ 97 = 979.3814433
    [{ result: '0.15 %', basis: 'dried', lod: '0.5 %' }, '0.150754'], // 0.15 ÷ 0.995 = 0.1507537
    [{ result: '1500 ppm', basis: 'anhydrous', water: '4.0 %' }, '1562.500000'], // 1500 ÷ 0.96
    [{ result: '850 IU/mg', basis: 'dried', lod: '15.0 %' }, '1000.000000'], // 850 ÷ 0.85
  ] as [Parameters<typeof l3OnBasis>[0], string][])('L3: %o → %s', (i, want) => {
    expect(ok(l3OnBasis(i)).value.toFixed(6)).toBe(want);
  });

  it('L3: shows the worked line and keeps the result unit', () => {
    const r = ok(l3OnBasis({ result: '98.0 %', basis: 'anhydrous', water: '5.0 %' }));
    expect(r.shown).toBe('98.0 % × 100 ÷ (100 − 5.0 %) = 103.2 % (anhydrous basis)');
    expect(r.unit).toBe('%');
  });

  it('L3: water in mg/g', () => {
    // water 20 mg/g = 2.0 %; 98 ÷ 0.98 = 100
    expect(ok(l3OnBasis({ result: '98.0 %', basis: 'anhydrous', water: '20 mg/g' })).value.toFixed(6)).toBe('100.000000');
  });

  it('L3: result unit changed to mg/g', () => {
    // 98.0 % = 980 mg/g; ÷ 0.98 = 1000 mg/g
    expect(ok(l3OnBasis({ result: '98.0 %', basis: 'dried', lod: '2.0 %', unit: 'mg/g' })).value.toFixed(3)).toBe('1000.000');
  });

  it('L3: takes an L1 result', () => {
    // L1 20 % on the dried basis with LOD 2.0 % = 20.408…
    expect(ok(l3OnBasis({ result: ok(L1({})), basis: 'dried', lod: '2.0 %' })).value.toFixed(4)).toBe('20.4082');
  });

  it('L3: limit on the dried basis (98.0-102.0 %) with rounding', () => {
    // 97.0 ÷ 0.99 = 97.979…: rounds to 98.0, passes
    expect(ok(l3OnBasis({ result: '97.0 %', basis: 'dried', lod: '1.0 %', limit: { low: '98.0', high: '102.0', unit: '%' } })).check?.pass).toBe(true);
    // 96.9 ÷ 0.99 = 97.878…: rounds to 97.9, fails
    expect(ok(l3OnBasis({ result: '96.9 %', basis: 'dried', lod: '1.0 %', limit: { low: '98.0', high: '102.0', unit: '%' } })).check?.pass).toBe(false);
  });

  it.each([
    [{ result: '98.0 %', basis: 'dried', lod: '2.0 %', measuredOn: 'dried sample' }, /Basis applied twice \(safety rule S3\)/],
    [{ result: '98.0 %', basis: 'anhydrous', water: '2.0 %', measuredOn: 'dried sample' }, /S3/],
    [{ result: '98.0 %', basis: 'dried' }, /needs the sample's own loss on drying/],
    [{ result: '98.0 %', basis: 'anhydrous' }, /needs the sample's own water content/],
    [{ result: '98.0 %', basis: 'anhydrous and solvent-free', water: '1 %' }, /residual solvents/],
    [{ result: '98.0 %', basis: 'anhydrous', water: '2.0 %', lod: '2.0 %' }, /does not use the loss on drying.*twice/],
    [{ result: '98.0 %', basis: 'dried', lod: '2.0 %', water: '2.0 %' }, /does not use the water content/],
    [{ result: '98.0 %', basis: 'dried', lod: '100 %' }, /from 0 to less than 100 %/],
    [{ result: '98.0 %', basis: 'dried', lod: '-1 %' }, /from 0 to less than 100 %/],
    [{ result: '98.0 %', basis: 'anhydrous and solvent-free', water: '60 %', solvents: '40 %' }, /less than 100 %/],
    [{ result: '98.0 mg', basis: 'dried', lod: '2.0 %' }, /must be a percentage/],
    [{ result: '-1 %', basis: 'dried', lod: '2.0 %' }, /cannot be negative/],
    [{ result: '98 %', basis: 'wet' as never, lod: '2.0 %' }, /Unknown basis/],
  ] as [Parameters<typeof l3OnBasis>[0], RegExp][])('L3 refuses %#', (i, msg) => {
    expect(refused(l3OnBasis(i))).toMatch(msg);
  });

  it('L3: an ignited test portion may still be put on the ignited basis', () => {
    expect(ok(l3OnBasis({ result: '97.0 %', basis: 'ignited', loi: '3.0 %', measuredOn: 'dried sample' })).value.toFixed(3)).toBe('100.000');
  });
});

describe('L4 Impurities: area normalisation', () => {
  // Principal 99510, impurity A at RRT 0.80 = 300, unknown at RRT 1.20 = 150, a small peak 40, a blank peak 900 (excluded).
  const NORM: L4Input = {
    mode: 'area normalisation',
    disregardLimit: '0.05',
    peaks: [
      { principal: true, area: '99510', rrt: '1.00' },
      { name: 'impurity A', rrt: '0.80', area: '300' },
      { rrt: '1.20', area: '150' },
      { rrt: '1.50', area: '40' },
      { rrt: '0.30', area: '900', excluded: 'blank' },
    ],
  };

  it('L4 area normalisation: disregard limit, then % of the total area', () => {
    // first total 99510 + 300 + 150 + 40 = 100000; 40 → 0.04 % ≤ 0.05: disregarded. New total 99960.
    // A = 300 ÷ 99960 × 100 = 0.300120…; unknown 150 ÷ 99960 × 100 = 0.150060…; total 0.450180…
    const r = ok(l4Impurities(NORM));
    expect(r.impurities.map((m) => [m.name, m.percent.toFixed(4)])).toEqual([['impurity A', '0.3001'], ['unknown at RRT 1.20', '0.1501']]);
    expect(r.value.toFixed(4)).toBe('0.4502');
    expect(r.disregarded.map((d) => [d.name, d.percent.toFixed(2)])).toEqual([['unknown at RRT 1.50', '0.04']]);
    expect(r.excluded).toEqual([{ name: 'peak at RRT 0.30', reason: 'blank' }]);
    expect(r.largestUnknown?.name).toBe('unknown at RRT 1.20');
    expect(r.shown).toContain('total area 99960 (3 peaks; 1 at or below the disregard limit 0.05 % left out)');
  });

  it('L4 area normalisation: a peak exactly at the disregard limit is disregarded, one above is kept', () => {
    // 50 of 100000 = 0.05 % → disregarded ("at or below"); 60 of 100000 = 0.06 % → kept
    const at = ok(l4Impurities({ ...NORM, peaks: [{ principal: true, area: '99950' }, { rrt: '1.2', area: '50' }] }));
    expect(at.impurities).toHaveLength(0);
    expect(at.value.toFixed(2)).toBe('0.00');
    const above = ok(l4Impurities({ ...NORM, peaks: [{ principal: true, area: '99940' }, { rrt: '1.2', area: '60' }] }));
    expect(above.impurities[0]?.percent.toFixed(2)).toBe('0.06');
  });

  it('L4 area normalisation: rounding at the disregard limit (0.054 rounds to 0.05: disregarded)', () => {
    const r = ok(l4Impurities({ ...NORM, peaks: [{ principal: true, area: '99946' }, { rrt: '1.2', area: '54' }] }));
    expect(r.disregarded).toHaveLength(1);
  });

  it('L4 area normalisation: without a disregard limit every peak counts', () => {
    // total 100000: A 0.30, unknown 0.15, unknown 0.04 → 0.49
    const r = ok(l4Impurities({ ...NORM, disregardLimit: undefined }));
    expect(r.value.toFixed(2)).toBe('0.49');
    expect(r.impurities).toHaveLength(3);
  });

  it('L4 area normalisation: limits on a named impurity, on unknowns and on the total', () => {
    const r = ok(l4Impurities({
      ...NORM,
      named: [{ name: 'impurity A', limit: { high: '0.2', unit: '%' } }],
      unknownLimit: { high: '0.10', unit: '%' },
      limit: { high: '1.0', unit: '%' },
    }));
    expect(r.impurities[0]?.check?.pass).toBe(false); // 0.3001 → 0.3 > 0.2
    expect(r.impurities[1]?.check?.pass).toBe(false); // 0.1501 → 0.15 > 0.10
    expect(r.check?.pass).toBe(true); // 0.45 → 0.5 ≤ 1.0
    expect(r.largestUnknown?.check?.pass).toBe(false);
    expect(r.allPass).toBe(false);
  });

  it('L4 area normalisation: all within gives allPass', () => {
    const r = ok(l4Impurities({ ...NORM, named: [{ name: 'impurity A', limit: { high: '0.5', unit: '%' } }], unknownLimit: { high: '0.20', unit: '%' }, limit: { high: '1.0', unit: '%' } }));
    expect(r.allPass).toBe(true);
  });

  it('L4 area normalisation: a correction factor multiplies the area (S4)', () => {
    // A 300 × 2.0 = 600; total 99510 + 600 + 150 = 100260 (the 40 peak: 40/100300 = 0.0399 % disregarded)
    // A = 600 ÷ 100260 × 100 = 0.598444…
    const r = ok(l4Impurities({ ...NORM, named: [{ name: 'impurity A', factor: { kind: 'correction factor', value: '2.0' } }] }));
    expect(r.impurities[0]?.percent.toFixed(4)).toBe('0.5984');
    expect(r.impurities[0]?.shown).toContain('300 × correction factor 2');
  });

  it('L4 area normalisation: a relative response factor divides the area (S4); RRF 0.5 = correction factor 2', () => {
    const r = ok(l4Impurities({ ...NORM, named: [{ name: 'impurity A', factor: { kind: 'relative response factor', value: '0.5' } }] }));
    expect(r.impurities[0]?.percent.toFixed(4)).toBe('0.5984');
    expect(r.impurities[0]?.shown).toContain('300 ÷ relative response factor 0.5');
  });

  it('L4 S4: the wrong direction is a factor squared (RRF 0.5 used as a correction factor gives a quarter)', () => {
    // 300 × 0.5 = 150: 150 ÷ (99510 + 150 + 150) = 0.150285… against 0.598…: 4 times less
    const r = ok(l4Impurities({ ...NORM, named: [{ name: 'impurity A', factor: { kind: 'correction factor', value: '0.5' } }] }));
    expect(r.impurities[0]?.percent.toFixed(4)).toBe('0.1503');
  });

  it('L4 S4: a factor without its kind is refused', () => {
    expect(refused(l4Impurities({ ...NORM, named: [{ name: 'impurity A', factor: { value: '2.0' } as never }] }))).toMatch(/safety rule S4.*correction factor.*relative response factor/);
    expect(refused(l4Impurities({ ...NORM, named: [{ name: 'impurity A', factor: { kind: 'RRF', value: '2.0' } as never }] }))).toMatch(/S4/);
  });

  it('L4: a factor on the peak and on the impurity is refused', () => {
    const peaks = NORM.peaks!.map((p) => (p.name === 'impurity A' ? { ...p, factor: { kind: 'correction factor' as const, value: '2' } } : p));
    expect(refused(l4Impurities({ ...NORM, peaks, named: [{ name: 'impurity A', factor: { kind: 'correction factor', value: '2' } }] }))).toMatch(/give it once/);
  });

  it('L4: impurity defined by an RRT window', () => {
    const r = ok(l4Impurities({ ...NORM, named: [{ name: 'impurity B', rrtLow: '1.15', rrtHigh: '1.25' }] }));
    expect(r.impurities.map((m) => [m.name, m.kind])).toEqual([['impurity A', 'named'], ['impurity B', 'named']]);
    expect(r.largestUnknown).toBeUndefined();
  });

  it('L4: split peaks of one named impurity are summed', () => {
    // C at RRT 1.30 and 1.32: 100 + 50 = 150 of 100000 = 0.15 %
    const r = ok(l4Impurities({ mode: 'area normalisation', peaks: [{ principal: true, area: '99850' }, { name: 'impurity C', rrt: '1.30', area: '100' }, { name: 'impurity C', rrt: '1.32', area: '50' }] }));
    expect(r.impurities).toHaveLength(1);
    expect(r.impurities[0]?.peaks).toBe(2);
    expect(r.impurities[0]?.percent.toFixed(2)).toBe('0.15');
    expect(r.impurities[0]?.shown).toContain('impurity C (2 peaks summed)');
  });

  it('L4: two unknowns at the same RRT stay separate', () => {
    const r = ok(l4Impurities({ mode: 'area normalisation', peaks: [{ principal: true, area: '99850' }, { rrt: '1.30', area: '100' }, { rrt: '1.30', area: '50' }] }));
    expect(r.impurities).toHaveLength(2);
    expect(r.largestUnknown?.percent.toFixed(2)).toBe('0.10');
  });

  it('L4: peaks excluded by an RRT window with the reason (counter-ion)', () => {
    const r = ok(l4Impurities({ ...NORM, disregardLimit: undefined, excludeRrt: [{ low: '1.45', high: '1.55', reason: 'counter-ion (maleate)' }] }));
    expect(r.excluded.map((x) => x.reason)).toEqual(['counter-ion (maleate)', 'blank']); // in peak order
    // total 99510 + 300 + 150 = 99960 → 0.4502
    expect(r.value.toFixed(4)).toBe('0.4502');
  });

  it('L4: groups (named sum) with a limit', () => {
    const r = ok(l4Impurities({
      mode: 'area normalisation',
      peaks: [{ principal: true, area: '99400' }, { name: 'A', area: '300' }, { name: 'B', area: '200' }, { name: 'C', area: '100' }],
      named: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      groups: [{ name: 'A + B', members: ['A', 'B'], limit: { high: '0.4', unit: '%' } }],
    }));
    // A 0.3 + B 0.2 = 0.5 % > 0.4: fails
    expect(r.groups[0]?.percent.toFixed(2)).toBe('0.50');
    expect(r.groups[0]?.check?.pass).toBe(false);
    expect(r.allPass).toBe(false);
  });

  it('L4: reporting threshold: at the threshold not reported, not in the total', () => {
    // A 0.30, unknown 0.05 (not reported: not above 0.05), unknown 0.06 reported → total 0.36
    const r = ok(l4Impurities({ mode: 'area normalisation', reportingThreshold: '0.05', peaks: [{ principal: true, area: '99590' }, { name: 'A', area: '300' }, { rrt: '1.2', area: '50' }, { rrt: '1.4', area: '60' }] }));
    expect(r.impurities.map((m) => m.reported)).toEqual([true, false, true]);
    expect(r.value.toFixed(2)).toBe('0.36');
    expect(r.impurities[1]?.shown).toContain('not reported');
  });

  it('L4: "not more than 2 peaks above 0.10 %"', () => {
    const peaks = [{ principal: true, area: '99550' }, { rrt: '1.1', area: '150' }, { rrt: '1.2', area: '150' }, { rrt: '1.3', area: '150' }];
    const r = ok(l4Impurities({ mode: 'area normalisation', peaks, countRule: { above: '0.10', notMoreThan: 2 } }));
    expect(r.countCheck?.pass).toBe(false);
    expect(r.countCheck?.shown).toContain('3 impurities above 0.10 %; not more than 2 allowed: OUT OF LIMITS');
    const ok2 = ok(l4Impurities({ mode: 'area normalisation', peaks: peaks.slice(0, 3), countRule: { above: '0.10', notMoreThan: 2 } }));
    expect(ok2.countCheck?.pass).toBe(true);
  });

  it.each([
    [{ peaks: [{ rrt: '1.2', area: '100' }] }, /exactly one principal peak/],
    [{ peaks: [{ principal: true, area: '100' }, { principal: true, area: '100' }] }, /exactly one principal peak/],
    [{ peaks: [] }, /Give the peaks/],
    [{ peaks: [{ principal: true, area: '1000' }, { rrt: '1.2', area: '10', excluded: ' ' }] }, /excluded without a reason/],
    [{ peaks: [{ principal: true, area: '1000' }, { rrt: '1.2', area: '-1' }] }, /cannot be negative/],
    [{ peaks: [{ principal: true, area: '1000 mg' }] }, /must be a number; "1000 mg" is a mass/],
    [{ peaks: [{ principal: true, area: '1000' }], references: [{ name: 'R', responses: ['100'], percentOfTest: '1 %' }] }, /uses no reference solution/],
    [{ peaks: [{ principal: true, area: '0' }] }, /total peak area is zero/],
    [{ peaks: [{ principal: true, area: '1000' }, { rrt: '1.2', area: '10' }], named: [{ name: 'X', rrtLow: '1.1', rrtHigh: '1.3' }, { name: 'Y', rrtLow: '1.15', rrtHigh: '1.25' }] }, /must not overlap/],
    [{ peaks: [{ principal: true, area: '1000' }], named: [{ name: 'X' }, { name: 'X' }] }, /defined twice/],
    [{ peaks: [{ principal: true, area: '1000' }], named: [{ name: 'X', rrtLow: '1.1' }] }, /both ends/],
    [{ peaks: [{ principal: true, area: '1000' }], named: [{ name: 'X' }], groups: [{ name: 'G', members: ['Y'] }] }, /not an impurity of the method/],
    [{ peaks: [{ principal: true, area: '1000' }], groups: [{ name: 'G', members: [] }] }, /no members/],
    [{ peaks: [{ principal: true, area: '1000' }], countRule: { above: '0.10', notMoreThan: 1.5 } }, /whole number/],
    [{ peaks: [{ principal: true, area: '1000' }], disregardLimit: '0.05 %' }, /plain decimal/],
    [{ peaks: [{ principal: true, area: '1000' }, { rrt: '1.2', area: '10', reference: 'R' }] }, /area normalisation uses none/],
  ] as [Partial<L4Input>, RegExp][])('L4 area normalisation refuses %#', (o, msg) => {
    expect(refused(l4Impurities({ mode: 'area normalisation', peaks: [], ...o } as L4Input))).toMatch(msg);
  });
});

describe('L4 Impurities: external standard', () => {
  // Diluted reference: the test solution diluted to 1.0 %; its principal peak 4990, 5010 → mean 5000.
  const DIL: L4Input = {
    mode: 'external standard',
    references: [{ name: 'reference (b)', responses: ['4990', '5010'], percentOfTest: '1.0 %' }],
    peaks: [{ principal: true, area: '480000' }, { name: 'impurity A', rrt: '0.8', area: '2500' }, { rrt: '1.3', area: '500' }],
  };

  it('L4 diluted reference: area ÷ reference area × 1.0 %', () => {
    // A = 2500 ÷ 5000 × 1.0 = 0.5 %; unknown 500 ÷ 5000 × 1.0 = 0.1 %; total 0.6 %
    const r = ok(l4Impurities(DIL));
    expect(r.impurities.map((m) => m.percent.toFixed(3))).toEqual(['0.500', '0.100']);
    expect(r.value.toFixed(3)).toBe('0.600');
    expect(r.shown).toContain('reference "reference (b)" mean of (4990, 5010) = 5000 at 1.0 % of the test solution');
  });

  it('L4 diluted reference: with a correction factor of 1.4 on impurity B', () => {
    // B 1000 × 1.4 = 1400 ÷ 5000 × 1.0 = 0.28 %
    const r = ok(l4Impurities({ ...DIL, peaks: [...DIL.peaks!, { name: 'impurity B', area: '1000', factor: { kind: 'correction factor', value: '1.4' } }] }));
    expect(r.impurities.find((m) => m.name === 'impurity B')?.percent.toFixed(3)).toBe('0.280');
  });

  it('L4 diluted reference: disregard limit (0.05 %) applied to the % of each peak', () => {
    // a peak of 200 → 200 ÷ 5000 × 1.0 = 0.04 %: disregarded
    const r = ok(l4Impurities({ ...DIL, disregardLimit: '0.05', peaks: [...DIL.peaks!, { rrt: '1.6', area: '200' }] }));
    expect(r.disregarded).toHaveLength(1);
    expect(r.value.toFixed(3)).toBe('0.600');
  });

  it('L4 impurity standard: reference standard against the test solution', () => {
    // standard 10.0 mg × 98.0 % ÷ (100 mL × 100 mL ÷ 1 mL) = 0.00098 mg/mL; test 500.0 mg ÷ 50 mL = 10 mg/mL
    // reference = 0.00098 ÷ 10 × 100 = 0.0098 % of the test solution; A 5000 ÷ 4900 × 0.0098 = 0.01 %
    const r = ok(l4Impurities({
      mode: 'external standard',
      sample: { mass: '500.0 mg', dilution: { volume: '50 mL' } },
      references: [{ name: 'impurity A RS', responses: ['4900'], standard: { mass: '10.0 mg', potency: '98.0 %', dilution: { volume: '100 mL', steps: [{ aliquot: '1 mL', to: '100 mL' }] } } }],
      peaks: [{ name: 'impurity A', area: '5000' }],
    }));
    expect(r.impurities[0]?.percent.toFixed(4)).toBe('0.0100');
  });

  it('L4 impurity standard with the test solution concentration given', () => {
    // standard declared 0.010 mg/mL; test 10 mg/mL → 0.1 %; A 4000 ÷ 5000 × 0.1 = 0.08 %
    const r = ok(l4Impurities({
      mode: 'external standard',
      sample: { concentration: '10 mg/mL' },
      references: [{ name: 'RS', responses: ['5000'], standard: { declared: '0.010 mg/mL' } }],
      peaks: [{ name: 'impurity A', area: '4000' }],
    }));
    expect(r.impurities[0]?.percent.toFixed(3)).toBe('0.080');
  });

  it('L4 two references: impurity A against its own standard, unknowns against the diluted test solution', () => {
    const r = ok(l4Impurities({
      mode: 'external standard',
      sample: { concentration: '10 mg/mL' },
      references: [
        { name: 'diluted', responses: ['5000'], percentOfTest: '0.5 %' },
        { name: 'A RS', responses: ['5000'], standard: { declared: '0.010 mg/mL' } },
      ],
      peaks: [{ name: 'impurity A', area: '4000', reference: 'A RS' }, { rrt: '1.3', area: '1000' }],
    }));
    // A: 4000 ÷ 5000 × 0.1 = 0.08 %; unknown 1000 ÷ 5000 × 0.5 = 0.1 %
    expect(r.impurities.map((m) => m.percent.toFixed(3))).toEqual(['0.080', '0.100']);
    expect(r.value.toFixed(3)).toBe('0.180');
  });

  it.each([
    [{ references: undefined }, /needs a reference solution/],
    [{ references: [{ name: 'R', responses: ['5000'] }] }, /either the % of the test solution.*or the reference standard/],
    [{ references: [{ name: 'R', responses: ['5000'], percentOfTest: '1 %', standard: { declared: '1 mg/mL' } }] }, /either the %/],
    [{ references: [{ name: 'R', responses: ['5000'], standard: { declared: '0.01 mg/mL' } }] }, /give the sample mass and dilution/],
    [{ references: [{ name: 'R', responses: ['0'], percentOfTest: '1 %' }] }, /reading after the blank is zero/],
    [{ references: [{ name: 'R', responses: ['5000'], percentOfTest: '1 %' }, { name: 'R', responses: ['5000'], percentOfTest: '1 %' }] }, /given twice/],
    [{ peaks: [{ rrt: '1.2', area: '100', reference: 'missing' }] }, /reference "missing" is not given/],
    [{ references: [{ name: 'R', responses: ['5000'], percentOfTest: '0 %' }] }, /more than zero/],
  ] as [Partial<L4Input>, RegExp][])('L4 external standard refuses %#', (o, msg) => {
    expect(refused(l4Impurities({ ...DIL, ...o } as L4Input))).toMatch(msg);
  });
});

describe('L9 Residual solvents', () => {
  // Headspace: 0.2000 g in 5 mL. Methanol standard 120 µg/mL (= 3000 ppm level), ethanol 200 µg/mL (= 5000 ppm level).
  const SOLV = {
    sample: { mass: '0.2000 g', dilution: { volume: '5 mL' } },
    solvents: [
      { name: 'methanol', class: 2 as const, mode: 'external standard' as const, sampleResponses: ['500'], standardResponses: ['1000'], standard: { declared: '120 µg/mL' }, limit: { high: '3000', unit: 'ppm' } },
      { name: 'ethanol', class: 3 as const, mode: 'external standard' as const, sampleResponses: ['100'], standardResponses: ['2000'], standard: { declared: '200 µg/mL' }, limit: { high: '5000', unit: 'ppm' } },
    ],
  };

  it('L9: ppm per solvent and the sum', () => {
    // methanol 500 ÷ 1000 × 120 µg/mL = 60 µg/mL × 5 mL = 300 µg ÷ 0.2000 g = 1500 ppm
    // ethanol 100 ÷ 2000 × 200 µg/mL = 10 µg/mL × 5 mL = 50 µg ÷ 0.2 g = 250 ppm; sum 1750 ppm
    const r = ok(l9ResidualSolvents(SOLV));
    expect(r.solvents.map((s) => [s.name, s.ppm.toFixed(1)])).toEqual([['methanol', '1500.0'], ['ethanol', '250.0']]);
    expect(r.value.toFixed(1)).toBe('1750.0');
    expect(r.unit).toBe('ppm');
    expect(r.allPass).toBe(true);
    expect(r.solvents[0]?.shown).toContain('methanol (class 2)');
  });

  it('L9: a solvent above its class limit fails', () => {
    // methanol 2100 ÷ 1000 × 120 = 252 µg/mL × 5 = 1260 µg ÷ 0.2 g = 6300 ppm > 3000
    const r = ok(l9ResidualSolvents({ ...SOLV, solvents: [{ ...SOLV.solvents[0]!, sampleResponses: ['2100'] }, SOLV.solvents[1]!] }));
    expect(r.solvents[0]?.ppm.toFixed(0)).toBe('6300');
    expect(r.solvents[0]?.check?.pass).toBe(false);
    expect(r.allPass).toBe(false);
  });

  it('L9: limit rounding in ppm (3000.4 rounds to 3000 and passes; 3000.5 fails)', () => {
    // sample x: x ÷ 1000 × 120 × 5 ÷ 0.2 = 3x → x = 1000.1333… for 3000.4; use 1000.13 → 3000.39, 1000.17 → 3000.51
    const at = (y: string): boolean | undefined => ok(l9ResidualSolvents({ ...SOLV, solvents: [{ ...SOLV.solvents[0]!, sampleResponses: [y] }] })).solvents[0]?.check?.pass;
    expect(at('1000.13')).toBe(true);
    expect(at('1000.17')).toBe(false);
  });

  it('L9: limit on the sum (class 3 solvents NMT 5000 ppm) and a µg/g limit', () => {
    const r = ok(l9ResidualSolvents({ ...SOLV, limit: { high: '0.5', unit: '%' } }));
    expect(r.check?.pass).toBe(true); // 1750 ppm = 0.175 % → 0.2 ≤ 0.5
    expect(ok(l9ResidualSolvents({ ...SOLV, limit: { high: '1000', unit: 'µg/g' } })).check?.pass).toBe(false);
  });

  it('L9: a weighed standard with a dilution, and an internal standard', () => {
    // standard 60.0 mg × 100 % in 100 mL, 1 mL → 50 mL = 0.012 mg/mL; ratios sample 0.5, standard 1.0 → 0.006 mg/mL × 5 mL = 0.03 mg = 30 µg ÷ 0.2 g = 150 ppm
    const r = ok(l9ResidualSolvents({
      sample: SOLV.sample,
      solvents: [{ name: 'acetone', mode: 'internal standard', sampleResponses: ['500'], sampleIsResponses: ['1000'], standardResponses: ['1000'], standardIsResponses: ['1000'], standard: { mass: '60.0 mg', potency: '100.0 %', dilution: { volume: '100 mL', steps: [{ aliquot: '1 mL', to: '50 mL' }] } } }],
    }));
    expect(r.value.toFixed(1)).toBe('150.0');
  });

  it.each([
    [{ solvents: [] }, /at least one solvent/],
    [{ sample: { volume: '1 mL', dilution: { volume: '5 mL' } } }, /taken by mass/],
    [{ solvents: [SOLV.solvents[0]!, SOLV.solvents[0]!] }, /given twice/],
    [{ solvents: [{ ...SOLV.solvents[0]!, class: 4 as never }] }, /class must be 1, 2 or 3/],
    [{ solvents: [{ ...SOLV.solvents[0]!, name: ' ' }] }, /needs its name/],
    [{ solvents: [{ ...SOLV.solvents[0]!, mode: 'specific absorbance' as const }] }, /not by specific absorbance/],
    [{ solvents: [{ ...SOLV.solvents[0]!, standard: undefined }] }, /^methanol: The standard is missing/],
  ] as [Partial<Parameters<typeof l9ResidualSolvents>[0]>, RegExp][])('L9 refuses %#', (o, msg) => {
    expect(refused(l9ResidualSolvents({ ...SOLV, ...o } as Parameters<typeof l9ResidualSolvents>[0]))).toMatch(msg);
  });
});

describe('L20 Chromatographic adjustment check', () => {
  const ISO: L20Input = {
    elution: 'isocratic',
    method: { length: '250 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', injectionVolume: '20 µL' },
    actual: { length: '150 mm', diameter: '4.6 mm', particleSize: '3 µm', flow: '1.7 mL/min', injectionVolume: '12 µL' },
  };

  it('L20 isocratic: 250 × 4.6 mm, 5 µm → 150 × 4.6 mm, 3 µm', () => {
    // L/dp 250/5 = 50 → 150/3 = 50: 0 %. Flow 1.0 × (4.6² × 5) ÷ (4.6² × 3) = 1.6667 mL/min; 1.7 is +2.0 %: within ± 50 %
    // Injection 20 × (150 × 4.6²) ÷ (250 × 4.6²) = 12 µL: used 12 µL
    const r = ok(l20ChromAdjustment(ISO));
    expect(r.ldpChange.toFixed(2)).toBe('0.00');
    expect(r.adjustedFlow.toFixed(4)).toBe('1.6667');
    expect(r.adjustedInjectionVolume?.toFixed(3)).toBe('12.000');
    expect(r.items.map((x) => [x.name, x.status])).toEqual([['column length and particle size', 'within'], ['flow rate', 'within'], ['injection volume', 'within']]);
    expect(r.check?.pass).toBe(true);
    expect(r.check?.level).toBe('pass');
    expect(r.unit).toBe('mL/min');
  });

  it('L20 isocratic: L/dp outside −25 % to +50 % fails', () => {
    // 100 mm / 3 µm = 33.33 against 50: −33.3 %
    const r = ok(l20ChromAdjustment({ ...ISO, actual: { ...ISO.actual, length: '100 mm', injectionVolume: '8 µL', flow: '1.7 mL/min' } }));
    expect(r.ldpChange.toFixed(1)).toBe('-33.3');
    expect(r.items[0]?.status).toBe('outside');
    expect(r.check?.pass).toBe(false);
    expect(r.shown).toContain('OUT OF LIMITS');
  });

  it('L20 isocratic: L/dp at the edges (+50 % and −25 % pass; rounding of −25.4 % to −25)', () => {
    // 150 mm × 2 µm = 75 against 50: +50 %
    expect(ok(l20ChromAdjustment({ ...ISO, method: { ...ISO.method, injectionVolume: undefined }, actual: { length: '150 mm', diameter: '4.6 mm', particleSize: '2 µm', flow: '2.5 mL/min' } })).items[0]?.status).toBe('within');
    // 112.5 mm / 3 µm = 37.5: −25 %
    expect(ok(l20ChromAdjustment({ ...ISO, method: { ...ISO.method, injectionVolume: undefined }, actual: { length: '112.5 mm', diameter: '4.6 mm', particleSize: '3 µm', flow: '1.7 mL/min' } })).items[0]?.status).toBe('within');
    // 112.3 mm / 3 µm = 37.4333: −25.13 % → rounds to −25: within
    expect(ok(l20ChromAdjustment({ ...ISO, method: { ...ISO.method, injectionVolume: undefined }, actual: { length: '112.3 mm', diameter: '4.6 mm', particleSize: '3 µm', flow: '1.7 mL/min' } })).items[0]?.status).toBe('within');
    // 111.0 mm / 3 µm = 37: −26 %: outside
    expect(ok(l20ChromAdjustment({ ...ISO, method: { ...ISO.method, injectionVolume: undefined }, actual: { length: '111.0 mm', diameter: '4.6 mm', particleSize: '3 µm', flow: '1.7 mL/min' } })).items[0]?.status).toBe('outside');
  });

  it('L20 isocratic: internal diameter change scales the flow and the injection volume', () => {
    // 150 × 4.6 mm, 5 µm, 1.0 mL/min, 10 µL → 150 × 2.1 mm, 5 µm
    // flow 1.0 × 2.1² ÷ 4.6² = 4.41 ÷ 21.16 = 0.208412…; injection 10 × 4.41 ÷ 21.16 = 2.08412… µL
    const base: L20Input = {
      elution: 'isocratic',
      method: { length: '150 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', injectionVolume: '10 µL' },
      actual: { length: '150 mm', diameter: '2.1 mm', particleSize: '5 µm', flow: '0.2 mL/min', injectionVolume: '2 µL' },
    };
    const r = ok(l20ChromAdjustment(base));
    expect(r.adjustedFlow.toFixed(6)).toBe('0.208412');
    expect(r.adjustedInjectionVolume?.toFixed(5)).toBe('2.08412');
    // 0.2 ÷ 0.208412 = −4.04 %: within ± 50; 2 µL = 2.08 rounded to 0 decimals: within
    expect(r.items.map((x) => x.status)).toEqual(['within', 'within', 'within']);
    // 0.35 mL/min: +67.9 %: outside
    expect(ok(l20ChromAdjustment({ ...base, actual: { ...base.actual, flow: '0.35 mL/min' } })).items[1]?.status).toBe('outside');
    // 0.3 mL/min: +43.9 %: within the further ± 50 %
    expect(ok(l20ChromAdjustment({ ...base, actual: { ...base.actual, flow: '0.3 mL/min' } })).items[1]?.status).toBe('within');
  });

  it('L20: an injection volume other than the scaled one needs system suitability (alert)', () => {
    const r = ok(l20ChromAdjustment({ ...ISO, actual: { ...ISO.actual, injectionVolume: '20 µL' } }));
    expect(r.items[2]?.status).toBe('conditional');
    expect(r.items[2]?.shown).toContain('allowed only when system suitability');
    expect(r.check?.pass).toBe(true);
    expect(r.check?.level).toBe('alert');
  });

  it('L20: units convert (cm, µm, µL, mL/h)', () => {
    // 25 cm = 250 mm; 0.005 mm = 5 µm; 60 mL/h = 1 mL/min
    const r = ok(l20ChromAdjustment({ ...ISO, method: { length: '25 cm', diameter: '4.6 mm', particleSize: '0.005 mm', flow: '60 mL/h', injectionVolume: '0.020 mL' } }));
    expect(r.adjustedFlow.toFixed(4)).toBe('1.6667');
    expect(r.adjustedInjectionVolume?.toFixed(3)).toBe('12.000');
  });

  it('L20: a change to superficially porous particles is judged by the plate number', () => {
    // 250 × 4.6, 5 µm (N 10000) → 100 × 4.6, 2.7 µm superficially porous (N 12000): +20 %: within
    const r = ok(l20ChromAdjustment({
      elution: 'isocratic',
      method: { length: '250 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', plateNumber: '10000' },
      actual: { length: '100 mm', diameter: '4.6 mm', particleSize: '2.7 µm', particle: 'superficially porous', flow: '1.8 mL/min', plateNumber: '12000' },
    }));
    expect(r.items[0]?.name).toBe('column (superficially porous particles)');
    expect(r.items[0]?.status).toBe('within');
    // N 7000: −30 %: outside
    const bad = ok(l20ChromAdjustment({
      elution: 'isocratic',
      method: { length: '250 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', plateNumber: '10000' },
      actual: { length: '100 mm', diameter: '4.6 mm', particleSize: '2.7 µm', particle: 'superficially porous', flow: '1.8 mL/min', plateNumber: '7000' },
    }));
    expect(bad.items[0]?.status).toBe('outside');
  });

  const GRAD: L20Input = {
    elution: 'gradient',
    method: { length: '150 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.5 mL/min', gradientTimes: ['0 min', '5 min', '25 min', '30 min'], dwellVolume: '1.0 mL' },
    actual: { length: '100 mm', diameter: '2.1 mm', particleSize: '3 µm', flow: '0.52 mL/min', dwellVolume: '0.10 mL' },
  };

  it('L20 gradient: scaled flow, gradient time points and dwell volume', () => {
    // L/dp 30 → 33.33: +11.1 %. Flow 1.5 × (2.1² × 5) ÷ (4.6² × 3) = 1.5 × 22.05 ÷ 63.48 = 0.521030…; used 0.52 (= 0.52 at 2 decimals)
    // column volume ratio (100 × 4.41) ÷ (150 × 21.16) = 441 ÷ 3174 = 0.138941…
    // time factor (1.5 ÷ 0.52) × 0.138941 = 0.400792…; points 0, 2.00396, 10.0198, 12.0238 min
    // dwell (1.0 × 0.138941 − 0.10) ÷ 0.52 = 0.074887 min: an isocratic hold, so the points move later by it
    const r = ok(l20ChromAdjustment(GRAD));
    expect(r.adjustedFlow.toFixed(6)).toBe('0.521030');
    expect(r.gradientFactor?.toFixed(6)).toBe('0.400792');
    expect(r.dwellOffset?.toFixed(6)).toBe('0.074887');
    expect(r.adjustedGradientTimes?.map((x) => x.toFixed(3))).toEqual(['0.000', '0.075', '2.079', '10.095', '12.099']);
    expect(r.items.map((x) => [x.name, x.status])).toEqual([['column length and particle size', 'within'], ['flow rate', 'within'], ['gradient time points', 'within']]);
    expect(r.shown).toContain('add an isocratic hold of 0.07488… min at the start');
  });

  it('L20 gradient: no further flow change is allowed', () => {
    // 0.60 mL/min against 0.52 (0.521 rounded to 2 decimals): outside
    const r = ok(l20ChromAdjustment({ ...GRAD, actual: { ...GRAD.actual, flow: '0.60 mL/min' } }));
    expect(r.items[1]?.status).toBe('outside');
    expect(r.check?.pass).toBe(false);
  });

  it('L20 gradient: a larger dwell volume on the system used delays the injection', () => {
    // same column; method dwell 0.5 mL, system 1.1 mL at 1.0 mL/min: (0.5 − 1.1) ÷ 1.0 = −0.6 min
    const r = ok(l20ChromAdjustment({
      elution: 'gradient',
      method: { length: '150 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', gradientTimes: ['0 min', '20 min'], dwellVolume: '0.5 mL' },
      actual: { length: '150 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', dwellVolume: '1.1 mL' },
    }));
    expect(r.dwellOffset?.toFixed(2)).toBe('-0.60');
    expect(r.adjustedGradientTimes?.map((x) => x.toFixed(1))).toEqual(['0.0', '20.0']);
    expect(r.shown).toContain('start the gradient 0.6 min before the injection');
  });

  it('L20 gradient: dwell volume from the step-gradient test (D = (t0.5 − 0.5 tG) × F)', () => {
    // method system: t0.5 6.0 min, tG 10 min, 1.0 mL/min → tD = 1.0 min → 1.0 mL; actual 0.4 mL → (1.0 − 0.4) ÷ 1.0 = 0.6 min hold
    const r = ok(l20ChromAdjustment({
      elution: 'gradient',
      method: { length: '150 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', gradientTimes: ['0 min', '20 min'], dwellMeasurement: { tHalf: '6.0 min', gradientTime: '10 min', flow: '1.0 mL/min' } },
      actual: { length: '150 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', dwellVolume: '0.4 mL' },
    }));
    expect(r.dwellOffset?.toFixed(2)).toBe('0.60');
    expect(r.adjustedGradientTimes?.map((x) => x.toFixed(1))).toEqual(['0.0', '0.6', '20.6']);
  });

  it('L20 gradient: the table used is compared with the adjusted one at its decimals', () => {
    // no dwell: 0, 2.00396, 10.0198, 12.0238 → written 0, 2.0, 10.0, 12.0 matches; 0, 2.0, 10.0, 13.0 does not
    const noDwell = { ...GRAD, method: { ...GRAD.method, dwellVolume: undefined }, actual: { ...GRAD.actual, dwellVolume: undefined } };
    expect(ok(l20ChromAdjustment({ ...noDwell, actual: { ...noDwell.actual, gradientTimes: ['0 min', '2.0 min', '10.0 min', '12.0 min'] } })).items[2]?.status).toBe('within');
    const bad = ok(l20ChromAdjustment({ ...noDwell, actual: { ...noDwell.actual, gradientTimes: ['0 min', '2.0 min', '10.0 min', '13.0 min'] } }));
    expect(bad.items[2]?.status).toBe('outside');
    expect(bad.items[2]?.shown).toContain('time point 4 of the table used do not match');
  });

  it('L20 gradient: same column and flow: nothing changes', () => {
    const r = ok(l20ChromAdjustment({ elution: 'gradient', method: { length: '150 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min', gradientTimes: ['0 min', '30 min'] }, actual: { length: '150 mm', diameter: '4.6 mm', particleSize: '5 µm', flow: '1.0 mL/min' } }));
    expect(r.gradientFactor?.toFixed(6)).toBe('1.000000');
    expect(r.check?.level).toBe('pass');
  });

  it.each([
    [{ technique: 'gas chromatography' as const }, /liquid chromatography only.*C1/],
    [{ elution: 'gradient' as const }, /needs the time points of its gradient table/],
    [{ method: { ...ISO.method, gradientTimes: ['0 min', '5 min'] } }, /method is isocratic/],
    [{ actual: { ...ISO.actual, dwellVolume: '1 mL' } }, /gradient methods only/],
    [{ actual: { ...ISO.actual, injectionVolume: undefined } }, /injection volume of the method and the one used/],
    [{ actual: { ...ISO.actual, length: '0 mm' } }, /more than zero/],
    [{ actual: { ...ISO.actual, flow: '1.7 mL' } }, /must be a volume rate/],
    [{ actual: { ...ISO.actual, particleSize: '3 mg' } }, /must be a length/],
    [{ actual: { ...ISO.actual, particle: 'superficially porous' as const } }, /judged by the plate number/],
    [{ method: { ...ISO.method, particle: 'superficially porous' as const } }, /superficially porous to totally porous.*not an allowed adjustment/],
    [{ actual: undefined as never }, /actual conditions are missing/],
  ] as [Partial<L20Input>, RegExp][])('L20 refuses %#', (o, msg) => {
    expect(refused(l20ChromAdjustment({ ...ISO, ...o }))).toMatch(msg);
  });

  it.each([
    [{ gradientTimes: ['1 min', '5 min'] }, {}, /must start at 0 min/],
    [{ gradientTimes: ['0 min', '5 min', '5 min'] }, {}, /not after the one before it/],
    [{ gradientTimes: ['0 min', '5 mL'] }, {}, /must be a time/],
    [{}, { dwellVolume: undefined }, /dwell volume of the method's system and of the system used/],
    [{ dwellMeasurement: { tHalf: '4 min', gradientTime: '10 min', flow: '1 mL/min' } }, {}, /not both/],
    [{ dwellVolume: undefined, dwellMeasurement: { tHalf: '4 min', gradientTime: '10 min', flow: '1 mL/min' } }, {}, /more than half the gradient time/],
    [{}, { gradientTimes: ['0 min', '2 min'] }, /has 2 time points; the adjusted table has 5/],
  ] as [Partial<L20Input['method']>, Partial<L20Input['actual']>, RegExp][])('L20 gradient refuses %#', (m, a, msg) => {
    expect(refused(l20ChromAdjustment({ ...GRAD, method: { ...GRAD.method, ...m }, actual: { ...GRAD.actual, ...a } }))).toMatch(msg);
  });
});

describe('L templates in the engine registry', () => {
  it('L1 L2 L3 L4 L9 L20 are registered and callable by ID', () => {
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L9', 'L20']) expect(TEMPLATES[id]).toBeTypeOf('function');
    const r = callTemplate('L2', { content: '49.2 mg', labelClaim: '50 mg' });
    expect(r.ok && r.value.toFixed(1)).toBe('98.4');
    expect(callTemplate('L1', BASE).ok).toBe(true);
  });
});

// ================================================================ inputs added for the result blocks (build step 3)
describe('L1 and L4: the inputs a result block passes', () => {
  // The sample's further dilutions (5 mL to 50 mL) as one factor 10, as the dilute step gives it (L21, in "units").
  const byFactor = (factor: unknown) => ({ ...SAMPLE, dilution: { volume: '100 mL', factor } });

  it('L1 a dilution factor gives the same result as its steps: 20 %', () => {
    expect(ok(L1({ sample: byFactor('10') as L1Input['sample'] })).value.toFixed(6)).toBe('20.000000');
    expect(ok(L1({ sample: byFactor({ value: '10.000', unit: 'units' }) as L1Input['sample'] })).value.toFixed(6)).toBe('20.000000');
    expect(ok(L1({ sample: byFactor('10') as L1Input['sample'] })).shown).toContain('(100 mL × dilution factor 10)');
    expect(ok(L1({ standard: { ...STD, dilution: { volume: '100 mL', factor: '10' } } })).value.toFixed(6)).toBe('20.000000');
  });

  it('L1 a dilution factor is refused with the steps too, below 1, or in a unit of another kind', () => {
    expect(refused(L1({ sample: { ...SAMPLE, dilution: { ...SAMPLE.dilution, factor: '10' } } }))).toMatch(/not both \(they would count twice\)/);
    expect(refused(L1({ sample: byFactor('0.5') as L1Input['sample'] }))).toMatch(/a dilution factor is at least 1/);
    expect(refused(L1({ sample: byFactor('10 mL') as L1Input['sample'] }))).toMatch(/dilution factor/);
  });

  it('L1 per unit with the label claim: the % of label claim (L2)', () => {
    // 50 mg found in 250.0 mg of powder × 250.0 mg average weight = 50 mg per tablet ÷ 50 mg = 100 %.
    const r = ok(L1({ per: 'unit', labelClaim: '50 mg' }));
    expect([r.value.toFixed(4), r.unit, r.perUnit?.toFixed(4)]).toEqual(['100.0000', '%', '50.0000']);
    expect(r.shown).toContain('50 mg ÷ label claim 50 mg × 100 = 100 % of label claim');
    expect(refused(L1({ labelClaim: '50 mg' }))).toMatch(/A label claim is per unit/);
  });

  it('L1 a basis group left out entirely is no basis; its values without the basis are refused', () => {
    expect(ok(L1({ onBasis: {} as never })).value.toFixed(6)).toBe('20.000000');
    expect(refused(L1({ onBasis: { lod: '0.5 %' } as never }))).toMatch(/but no basis/);
  });

  it('L1 a recorded "yes" for a standard dried before use counts (safety rule S3 still applies)', () => {
    const std = { ...STD, potencyBasis: 'dried' as const };
    expect(ok(L1({ standard: { ...std, driedBeforeUse: 'yes' } })).value.toFixed(6)).toBe('20.000000');
    expect(refused(L1({ standard: { ...std, driedBeforeUse: 'yes', lod: '1.0 %' } }))).toMatch(/safety rule S3/);
    expect(refused(L1({ standard: { ...std, driedBeforeUse: 'no' } }))).toMatch(/give its loss on drying/);
  });

  // The area-normalisation example as a peak table: principal 100000; RRT 0.85 200; RRT 1.20 300.
  const TABLE: L4Input = { mode: 'area normalisation', table: { rrts: ['0.85', '1.20'], areas: ['200', '300'], principal: '100000' } };

  it('L4 the peak table: RRT k with area k, the principal peak on its own', () => {
    // Total 100500: 200 ÷ 100500 × 100 = 0.19900 %; 300 ÷ 100500 × 100 = 0.29851 %; total 0.49751 %.
    const r = ok(l4Impurities(TABLE));
    expect(r.value.toFixed(5)).toBe('0.49751');
    expect(r.impurities.map((m) => m.name)).toEqual(['unknown at RRT 0.85', 'unknown at RRT 1.20']);
    // Readings with a unit from a step count by their value.
    expect(ok(l4Impurities({ ...TABLE, table: { rrts: [{ value: '0.85', unit: '' }, { value: '1.20', unit: '' }], areas: [{ value: '200', unit: '' }, { value: '300', unit: '' }], principal: { value: '100000', unit: '' } } })).value.toFixed(5)).toBe('0.49751');
  });

  it('L4 the peak table is refused with the peaks too, with unequal lists, or an RRT that is not a plain decimal', () => {
    expect(refused(l4Impurities({ ...TABLE, peaks: [{ area: '1', principal: true }] }))).toMatch(/either as peaks or as the peak table/);
    expect(refused(l4Impurities({ ...TABLE, table: { ...TABLE.table!, rrts: ['0.85'] } }))).toMatch(/1 relative retention times and 2 areas/);
    expect(refused(l4Impurities({ ...TABLE, table: { ...TABLE.table!, rrts: ['0.85', 'x'] } }))).toMatch(/Peak 2: the relative retention time must be a plain decimal/);
  });

  it('L4 named impurities in the table by their windows; an entry without a name is none; a factor left out entirely is none', () => {
    const named = [{ name: 'impurity A', rrtLow: '0.80', rrtHigh: '0.90', limit: { high: '0.15', unit: '%' }, factor: {} as never }, { rrtLow: '1.1' } as never];
    const r = ok(l4Impurities({ ...TABLE, named }));
    expect(r.impurities.map((m) => `${m.name} ${m.kind}`)).toEqual(['impurity A named', 'unknown at RRT 1.20 unknown']);
    // impurity A 0.19900 % → 0.20 % > 0.15 %: its own limit fails; the individual limits fail with it.
    expect(r.limitsCheck).toMatchObject({ pass: false, shown: expect.stringMatching(/^Individual limits: impurity A: .*OUT OF LIMITS/) });
    expect(r.check).toBeUndefined();
    expect(failedKeys(r)).toEqual(['limitsCheck']);
    // Without individual limits there is no such check.
    expect(ok(l4Impurities(TABLE)).limitsCheck).toBeUndefined();
  });

  it('L4 a reference list left empty (area normalisation) is no reference', () => {
    expect(ok(l4Impurities({ ...TABLE, references: [] })).value.toFixed(5)).toBe('0.49751');
  });
});

/** The keys of the checks in a result that failed (as the engine finds them). */
function failedKeys(r: object): string[] {
  return Object.entries(r).filter(([k, v]) => /check$/i.test(k) && (v as { pass?: boolean } | null)?.pass === false).map(([k]) => k);
}
