import { describe, expect, it } from 'vitest';
import {
  chi2Quantile, fQuantile, incompleteBeta, incompleteGamma, l10Reading, l14Statistics, l17Standardisation, l19SamplingPlan,
  l5Dissolution, l6Titration, l7WaterKf, l8MassLoss, lnGamma, tQuantile, type L5Input,
} from '../../shared/templates/lab-physchem.js';
import { c6StagedTest } from '../../shared/templates/staged.js';
import { ethanolDensity, ethanolWw } from '../../shared/templates/mixing.js';
import { callTemplate, TEMPLATES } from '../../shared/engine/templates.js';
import { Dec } from '../../shared/templates/dec.js';
import { ok, refused } from './helpers.js';

const d = (x: string | number): Dec => new Dec(x);

// ================================================================ L5 Dissolution
// One example run used throughout (own numbers): 500 mg tablets, 900 mL, standard 0.01 mg/mL with response 0.500,
// sample diluted 50 times, so C (mg/mL) = response ÷ 0.500 × 0.01 × 50 = the response itself. Aliquots 10 mL.
const base = (over: Partial<L5Input> = {}): L5Input => ({
  labelClaim: '500 mg',
  standard: { responses: ['0.500'], concentration: '0.01 mg/mL' },
  dilution: '50',
  volumeMode: 'replace and correct',
  stages: [{ name: 'medium', volume: '900 mL', times: [{ time: '10 min', aliquot: '10 mL' }, { time: '20 min', aliquot: '10 mL' }, { time: '30 min', aliquot: '10 mL' }] }],
  vessels: [{ responses: ['0.300', '0.450', '0.520'] }],
  ...over,
});

describe('L5 Dissolution', () => {
  it.each([
    // 10 min: 0.300 × 900 = 270 mg = 54.0 % in every mode.
    // replace and correct: 20 min 0.450 × 900 + 0.300 × 10 = 408 mg (81.6 %); 30 min 0.520 × 900 + 3 + 4.5 = 475.5 mg (95.1 %)
    ['replace and correct', ['54.0', '81.6', '95.1']],
    // no replacement: 20 min 0.450 × 890 + 3 = 403.5 mg (80.7 %); 30 min 0.520 × 880 + 3 + 4.5 = 465.1 mg (93.02 %)
    ['no replacement', ['54.0', '80.7', '93.0']],
    // replace, no correction: 0.450 × 900 = 405 (81.0 %); 0.520 × 900 = 468 (93.6 %)
    ['replace, no correction', ['54.0', '81.0', '93.6']],
  ] as const)('L5 volume mode %s', (volumeMode, want) => {
    const r = ok(l5Dissolution(base({ volumeMode })));
    expect(r.vessels[0]!.results.map((x) => x.toFixed(1))).toEqual(want);
    expect(r.value.toFixed(1)).toBe(want[2]);
    expect(r.unit).toBe('%');
  });

  it('L5 amounts are kept in mg at full precision (no replacement, 30 min: 465.1 mg exactly)', () => {
    const r = ok(l5Dissolution(base({ volumeMode: 'no replacement' })));
    expect(r.vessels[0]!.amounts.map((x) => x.toString())).toEqual(['270', '403.5', '465.1']);
  });

  it('L5 the standard response is the mean of the replicates (0.495 and 0.505 → 0.500)', () => {
    const r = ok(l5Dissolution(base({ standard: { responses: ['0.495', '0.505'], concentration: '0.01 mg/mL' } })));
    expect(r.value.toFixed(1)).toBe('95.1');
  });

  it('L5 the standard concentration converts: 10 µg/mL = 0.01 mg/mL', () => {
    expect(ok(l5Dissolution(base({ standard: { responses: ['0.500'], concentration: '10 µg/mL' } }))).value.toFixed(1)).toBe('95.1');
  });

  it('L5 reportAt picks the time point whose mean is the value (20 min: 81.6 %)', () => {
    expect(ok(l5Dissolution(base({ reportAt: '20 min' }))).value.toFixed(1)).toBe('81.6');
  });

  // Six vessels; with the earlier responses 0.300 and 0.450 the 30-min result is (900 R + 7.5) ÷ 500 × 100 = 180 R + 1.5 %.
  const six = (at30: string[]): L5Input => base({ vessels: at30.map((r) => ({ responses: ['0.300', '0.450', r] })) });

  it('L5 feeds C6: six vessels at 30 min (95.1, 94.2, 96.9, 93.3, 96.0, 92.4 %) pass S1 with Q = 80', () => {
    const r = ok(l5Dissolution(six(['0.520', '0.515', '0.530', '0.510', '0.525', '0.505'])));
    expect(r.atTime[2]!.map((x) => new Dec(x).toFixed(1))).toEqual(['95.1', '94.2', '96.9', '93.3', '96.0', '92.4']);
    expect(r.points[2]!.mean.toFixed(2)).toBe('94.65'); // 567.9 ÷ 6
    const c6 = ok(c6StagedTest({ test: 'dissolution IR', Q: '80', stages: [r.atTime[2]!] }));
    expect(c6.decision).toBe('pass');
    expect(c6.stageReached).toBe(1);
  });

  it('L5 feeds C6 ER: perVessel gives every time point of each vessel', () => {
    const r = ok(l5Dissolution(six(Array(6).fill('0.520') as string[])));
    expect(r.perVessel).toHaveLength(6);
    expect(r.perVessel[0]!.map((x) => new Dec(x).toFixed(1))).toEqual(['54.0', '81.6', '95.1']);
    const c6 = ok(c6StagedTest({ test: 'dissolution ER', ranges: [{ time: '10', low: '45', high: '65' }, { time: '20', low: '70', high: '90' }, { time: '30', low: '85' }], stages: [r.perVessel as string[][]] }));
    expect(c6.decision).toBe('pass');
  });

  it('L5 Tier 1 and Tier 2 are separate runs: Tier 1 (73.5 %) goes to S2 in C6, Tier 2 with enzyme passes S1', () => {
    // Tier 1: 180 × 0.400 + 1.5 = 73.5 % in each vessel < Q + 5 = 85
    const t1 = ok(l5Dissolution({ ...six(Array(6).fill('0.400') as string[]), label: 'Tier 1' }));
    expect(t1.shown.startsWith('Tier 1: 6 vessels')).toBe(true);
    expect(ok(c6StagedTest({ test: 'dissolution IR', Q: '80', stages: [t1.atTime[2]!] })).decision).toBe('next stage');
    // Tier 2 (pancreatin): 180 × 0.510 + 1.5 = 93.3 %
    const t2 = ok(l5Dissolution({ ...six(Array(6).fill('0.510') as string[]), label: 'Tier 2 (with pancreatin)' }));
    expect(t2.value.toFixed(1)).toBe('93.3');
    expect(ok(c6StagedTest({ test: 'dissolution IR', Q: '80', stages: [t2.atTime[2]!] })).decision).toBe('pass');
  });

  // Delayed release (Ph.Int 5.5, FDA omeprazole method D002): acid 750 mL for 120 min, one 10-mL aliquot not replaced.
  const acid = { name: 'acid', volume: '750 mL', volumeMode: 'no replacement' as const, times: [{ time: '120 min', aliquot: '10 mL' }] };

  it('L5 Method A (add medium): 750 mL acid − 10 mL aliquot + 250 mL buffer = 990 mL; buffer result 95.08 %', () => {
    // acid: C 0.020 → 0.020 × 750 = 15 mg = 3.0 %; buffer 45 min: 0.480 × 990 + 0.020 × 10 = 475.2 + 0.2 = 475.4 mg = 95.08 %
    const r = ok(l5Dissolution(base({
      stages: [acid, { name: 'buffer', change: 'add medium', added: '250 mL', times: [{ time: '45 min', aliquot: '10 mL' }] }],
      vessels: [{ responses: ['0.020', '0.480'] }],
    })));
    expect(r.vessels[0]!.results.map((x) => x.toFixed(2))).toEqual(['3.00', '95.08']);
    expect(r.shown).toContain('buffer: + 250 mL');
  });

  it('L5 safety S9: the same buffer reading on the acid volume (750 mL) would be 25 % low; the template never uses it', () => {
    // 0.480 × 750 = 360 mg = 72.0 %, against 95.08 % on 990 mL: Method A without the volume change understates by 1/4.
    const r = ok(l5Dissolution(base({ stages: [acid, { name: 'buffer', change: 'add medium', added: '250 mL', times: [{ time: '45 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.020', '0.480'] }] })));
    expect(r.value.gt(d('72.0').times(1.3))).toBe(true);
  });

  it.each([
    // Method B: acid 15 mg (3.0 %), drain, 1000 mL buffer: 0.480 × 1000 = 480 mg; cumulative 480 + 15 = 495 mg = 99.0 %
    ['add earlier amount', '99.0'],
    // this stage only: 480 mg = 96.0 %
    ['this stage only', '96.0'],
  ] as const)('L5 Method B (drain) with %s → %s %%', (earlier, want) => {
    const r = ok(l5Dissolution(base({
      stages: [acid, { name: 'buffer', change: 'drain', volume: '1000 mL', earlier, times: [{ time: '45 min', aliquot: '10 mL' }] }],
      vessels: [{ responses: ['0.020', '0.480'] }],
    })));
    expect(r.value.toFixed(1)).toBe(want);
  });

  it('L5 cumulative over three media (FDA mesalamine method D003: 500 mL acid, 900 mL pH 6.0, 900 mL pH 7.2)', () => {
    // acid 0.010 × 500 = 5 mg (1.0 %); pH 6.0: 0.050 × 900 + 5 = 50 mg (10.0 %); pH 7.2: 0.480 × 900 + 50 = 482 mg (96.4 %)
    const r = ok(l5Dissolution(base({
      stages: [
        { name: 'acid', volume: '500 mL', times: [{ time: '120 min', aliquot: '5 mL' }] },
        { name: 'pH 6.0', change: 'drain', volume: '900 mL', earlier: 'add earlier amount', times: [{ time: '60 min', aliquot: '5 mL' }] },
        { name: 'pH 7.2', change: 'drain', volume: '900 mL', earlier: 'add earlier amount', times: [{ time: '60 min', aliquot: '5 mL' }] },
      ],
      vessels: [{ responses: ['0.010', '0.050', '0.480'] }],
    })));
    expect(r.vessels[0]!.results.map((x) => x.toFixed(1))).toEqual(['1.0', '10.0', '96.4']);
    expect(r.points.map((p) => p.stage)).toEqual(['acid', 'pH 6.0', 'pH 7.2']);
  });

  it('L5 the time points of a later stage start again (buffer 10 min after acid 120 min)', () => {
    const r = ok(l5Dissolution(base({ stages: [acid, { name: 'buffer', change: 'add medium', added: '250 mL', times: [{ time: '10 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.020', '0.480'] }] })));
    expect(r.points[1]!.time).toBe('10 min');
  });

  it('L5 transdermal system (FDA estradiol method D007): amount per patch and per cm², against the content per patch', () => {
    // Standard 1 µg/mL at 0.200; 900 mL; 6 h 0.100 → 0.0005 mg/mL × 900 = 0.45 mg; 12 h 0.180 → 0.0009 × 900 + 0.0005 × 5 = 0.8125 mg
    const t = (express: L5Input['express']) => ok(l5Dissolution({
      labelClaim: '2 mg', standard: { responses: ['0.200'], concentration: '1 µg/mL' }, volumeMode: 'replace and correct', express, area: '10 cm²',
      stages: [{ name: 'water 32 °C', volume: '900 mL', times: [{ time: '6 h', aliquot: '5 mL' }, { time: '12 h', aliquot: '5 mL' }] }],
      vessels: [{ responses: ['0.100', '0.180'] }],
    }));
    expect(t('amount per unit').value.toString()).toBe('0.8125');
    expect(t('amount per unit').unit).toBe('mg');
    expect(t('amount per area').value.toString()).toBe('0.08125'); // 0.8125 mg ÷ 10 cm²
    expect(t('amount per area').unit).toBe('mg/cm²');
    expect(t('% of label claim').value.toString()).toBe('40.625'); // 0.8125 ÷ 2 × 100
  });

  it('L5 per-time statistics: mean, SD, RSD, min, max', () => {
    const r = ok(l5Dissolution(six(['0.520', '0.515', '0.530', '0.510', '0.525', '0.505'])));
    const p = r.points[2]!;
    expect(p.min.toFixed(1)).toBe('92.4');
    expect(p.max.toFixed(1)).toBe('96.9');
    expect(p.sd?.toFixed(3)).toBe('1.684'); // results 180 R + 1.5: SD(R) = √(0.0004375 ÷ 5) = 0.0093541; × 180 = 1.68375
  });

  it.each([
    [{ labelClaim: '0.05 mg/24 h' }, /delivery rate.*S9/],
    [{ labelClaim: '50 mL' }, /must be a mass/],
    [{ labelClaim: '0 mg' }, /more than zero/],
    [{ standard: { responses: ['0'], concentration: '0.01 mg/mL' } }, /standard response must be more than zero/],
    [{ standard: { responses: [], concentration: '0.01 mg/mL' } }, /Give the standard response/],
    [{ standard: { responses: ['0.5'], concentration: '0.01 mg' } }, /must be a mass concentration/],
    [{ dilution: '0' }, /dilution must be more than zero/],
    [{ vessels: [{ responses: ['0.3', '0.45'] }] }, /needs 3 responses/],
    [{ vessels: [{ responses: ['0.3', '-0.1', '0.5'] }] }, /cannot be negative/],
    [{ vessels: [] }, /at least one vessel/],
    [{ stages: [] }, /at least one stage/],
    [{ stages: [{ name: 'medium', volume: '900 mL', times: [{ time: '20 min', aliquot: '10 mL' }, { time: '10 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.1', '0.2'] }] }, /must rise/],
    [{ stages: [{ name: 'medium', volume: '9 mL', times: [{ time: '10 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.1'] }] }, /not less than the volume left/],
    [{ stages: [{ name: 'medium', times: [{ time: '10 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.1'] }] }, /Give the medium volume/],
    [{ stages: [{ name: 'medium', change: 'drain', volume: '900 mL', times: [{ time: '10 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.1'] }] }, /first stage .* cannot start/],
    [{ stages: [acid, { name: 'buffer', times: [{ time: '10 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.1', '0.2'] }] }, /Say how the buffer stage starts/],
    [{ stages: [acid, { name: 'buffer', change: 'add medium', times: [{ time: '10 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.1', '0.2'] }] }, /give the volume added.*S9/],
    [{ stages: [acid, { name: 'buffer', change: 'drain', volume: '1000 mL', times: [{ time: '10 min', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.1', '0.2'] }] }, /say whether the amount released before is added.*S9/],
    [{ stages: [{ name: 'medium', volume: '900 mL', times: [] }] }, /has no time points/],
    [{ express: 'amount per area' as const }, /needs the area/],
    [{ reportAt: '25 min' }, /not one of the time points/],
    [{ stages: [{ name: 'medium', volume: '900 mL', times: [{ time: '10 mL', aliquot: '10 mL' }] }], vessels: [{ responses: ['0.1'] }] }, /must be a time/],
  ] as [Partial<L5Input>, RegExp][])('L5 refuses %o', (over, msg) => {
    expect(refused(l5Dissolution(base(over)))).toMatch(msg);
  });
});

// ================================================================ L6 Titration
describe('L6 Titration', () => {
  // Acetylsalicylic acid tablets (Ph.Int 6.2.2.3, research M002): boil with NaOH 0.5 M VS, back-titrate with HCl 0.5 M VS,
  // blank; each mL of 0.5 M NaOH ≡ 45.04 mg. Own readings: blank 30.00 mL, sample 20.00 mL, HCl factor 1.0020,
  // powder 0.4600 g, average tablet 0.3500 g.
  const asa = {
    mode: 'back' as const, sample: '0.4600 g', blank: '30.00 mL',
    titrant: { volume: '20.00 mL', molarity: '0.5 M', factor: '1.0020' },
    equivalence: { mass: '45.04 mg', molarity: '0.5 M', of: 'excess' as const },
  };

  it('L6 back titration with blank: (30.00 − 20.00) × 0.5 × 1.0020 ÷ 0.5 × 45.04 = 451.3008 mg; ÷ 460.0 mg = 98.11 %', () => {
    const r = ok(l6Titration(asa));
    expect(r.value.toFixed(2)).toBe('98.11'); // 451.3008 ÷ 460 × 100 = 98.10887
    expect(r.shown).toContain('the excess VS cancels');
  });

  it('L6 back titration with blank: only the titrant factor counts; the excess VS given or not changes nothing (M002 safety)', () => {
    const r = ok(l6Titration({ ...asa, excess: { volume: '30.00 mL', molarity: '0.5 M', factor: '1.0500' } }));
    expect(r.value.toFixed(5)).toBe('98.10887');
  });

  it('L6 per tablet from the powder and the average tablet weight: 451.3008 ÷ 460.0 × 350.0 = 343.38 mg', () => {
    const r = ok(l6Titration({ ...asa, report: 'mg per unit', unitWeight: '0.3500 g' }));
    expect(r.value.toFixed(2)).toBe('343.38');
    expect(r.unit).toBe('mg');
  });

  it('L6 mg found: 451.3008 mg exactly', () => {
    expect(ok(l6Titration({ ...asa, report: 'mg' })).value.toString()).toBe('451.3008');
  });

  it('L6 in mg/g: 98.10887 % = 981.09 mg/g', () => {
    const r = ok(l6Titration({ ...asa, unit: 'mg/g' }));
    expect(r.unit).toBe('mg/g');
    expect(r.value.toFixed(2)).toBe('981.09');
  });

  it('L6 on the dried basis (LOD 0.5 %): 98.10887 × 100 ÷ 99.5 = 98.60 %', () => {
    expect(ok(l6Titration({ ...asa, basis: { as: 'dried', loss: '0.5 %' } })).value.toFixed(2)).toBe('98.60');
  });

  it('L6 safety S3: refuses the dried basis when the sample was dried before weighing', () => {
    expect(refused(l6Titration({ ...asa, basis: { as: 'dried', loss: '0.5 %', sampleAlreadyDried: true } }))).toMatch(/counts the loss twice.*S3/);
  });

  // Non-aqueous direct titration (Ph.Int 2.6, research G010): perchloric acid 0.1 M, factor 0.9985, 15.20 mL, blank 0.05 mL,
  // 20.17 mg per mL of 0.1 M, sample 0.3050 g.
  const hclo4 = {
    mode: 'direct' as const, sample: '0.3050 g', blank: '0.05 mL',
    titrant: { volume: '15.20 mL', molarity: '0.1 M', factor: '0.9985' },
    equivalence: { mass: '20.17 mg', molarity: '0.1 mol/L' },
  };

  it('L6 direct with blank: (15.20 − 0.05) × 0.1 × 0.9985 ÷ 0.1 × 20.17 = 305.1171 mg = 100.04 %', () => {
    const r = ok(l6Titration(hclo4));
    expect(r.value.toFixed(2)).toBe('100.04'); // 305.11713675 ÷ 305 × 100 = 100.03841
  });

  it('L6 temperature-corrected titre (G010): standardised at 20 °C, titrated at 25 °C: × [1 + 0.001 × (20 − 25)] = × 0.995', () => {
    // (15.20 − 0.05) × 0.995 = 15.07425 mL → 303.59155 mg → 99.54 %
    const r = ok(l6Titration({ ...hclo4, temperatureCorrection: { standardisedAt: '20 °C', titratedAt: '25 °C' } }));
    expect(r.value.toFixed(2)).toBe('99.54');
    expect(r.shown).toBe('(15.20 mL − blank 0.05 mL) of 0.1 mol/L × 0.9985 ÷ 0.1 mol/L × 20.17 mg (titres × [1 + 0.001 × (20 °C − 25 °C)] = × 0.995) = 303.591… mg; ÷ 0.3050 g × 100 = 99.54 %');
  });

  it('L6 the equivalence follows the VS molarity (S5): 1.401 mg per mL of 0.05 M or 2.802 mg per mL of 0.1 M give the same', () => {
    // Nitrogen (Ph.Int 2.10): 0.05 M sulfuric acid, factor 1.000, 10.00 mL, blank 0.10 mL: 9.90 × 0.05 = 0.495 mmol
    // 0.495 ÷ 0.05 × 1.401 = 13.8699 mg; 0.495 ÷ 0.1 × 2.802 = 13.8699 mg
    const n = (mass: string, molarity: string) => ok(l6Titration({ mode: 'direct', sample: '0.2000 g', blank: '0.10 mL', titrant: { volume: '10.00 mL', molarity: '0.05 M', factor: '1.000' }, equivalence: { mass, molarity }, report: 'mg' })).value.toString();
    expect(n('1.401 mg', '0.05 M')).toBe('13.8699');
    expect(n('2.802 mg', '0.1 M')).toBe('13.8699');
  });

  it('L6 back titration without blank, each VS with its own factor (Ph.Int 2.5 aluminium, research G009)', () => {
    // edetate 25.00 mL × 0.05 × 1.0010 − lead nitrate 12.40 mL × 0.05 × 0.9990 = 1.25125 − 0.61938 = 0.63187 mmol
    // ÷ 0.05 × 1.349 mg = 17.0478526 mg; ÷ 200.0 mg = 8.52 %
    const r = ok(l6Titration({
      mode: 'back', sample: '0.2000 g',
      excess: { volume: '25.00 mL', molarity: '0.05 M', factor: '1.0010' },
      titrant: { volume: '12.40 mL', molarity: '0.05 M', factor: '0.9990' },
      equivalence: { mass: '1.349 mg', molarity: '0.05 M', of: 'excess' },
    }));
    expect(r.value.toFixed(4)).toBe('8.5239');
  });

  it('L6 back titration with a reaction ratio: 1 mol titrant takes up 2 mol of the excess VS', () => {
    // excess 0.1 M HCl 50.00 mL × 1.000 = 5.000 mmol; titrant 0.05 M Ba(OH)2-like 10.00 mL × 1.000 × 2 = 1.000 mmol
    // 4.000 mmol of 0.1 M HCl ÷ 0.1 × 5.004 mg = 200.16 mg
    const r = ok(l6Titration({ mode: 'back', sample: '1.000 g', excess: { volume: '50.00 mL', molarity: '0.1 M', factor: '1.000' }, titrant: { volume: '10.00 mL', molarity: '0.05 M', factor: '1.000' }, reactionRatio: '2', equivalence: { mass: '5.004 mg', molarity: '0.1 M', of: 'excess' }, report: 'mg' }));
    expect(r.value.toString()).toBe('200.16');
  });

  it('L6 aliquot factor: 100 mL made, 25 mL titrated → × 4', () => {
    const r = ok(l6Titration({ ...hclo4, aliquot: { total: '100 mL', taken: '25 mL' }, report: 'mg' }));
    expect(r.value.toString()).toBe('1220.468547'); // 305.11713675 × 4
  });

  it('L6 sample by volume in mg/mL: 305.11713675 mg ÷ 10.0 mL = 30.512 mg/mL', () => {
    const r = ok(l6Titration({ ...hclo4, sample: '10.0 mL', report: 'mg/mL' }));
    expect(r.value.toFixed(3)).toBe('30.512');
    expect(r.unit).toBe('mg/mL');
  });

  it.each([
    ['0.4370 g', '103.27', true], // 451.3008 ÷ 437.0 = 103.2725 → within 95.0-105.0
    ['0.4295 g', '105.08', false], // 105.0770 → 105.1 > 105.0
    ['0.4298 g', '105.00', true], // 105.0025 → 105.0 (rounded at the limit's decimals)
  ])('L6 limit 95.0-105.0 %% with pharmacopoeia rounding: sample %s → %s %%, pass %s', (sample, val, pass) => {
    const r = ok(l6Titration({ ...asa, sample, limit: { low: '95.0', high: '105.0', unit: '%' } }));
    expect(r.value.toFixed(2)).toBe(val);
    expect(r.check?.pass).toBe(pass);
  });

  it.each([
    [{ ...asa, titrant: { ...asa.titrant, volume: '31.00 mL' } }, /takes less titrant than the blank/],
    [{ ...hclo4, blank: '16.00 mL' }, /blank volume is more than the titration volume/],
    [{ ...asa, blank: undefined }, /needs the VS added in excess.*S5/],
    [{ ...hclo4, titrant: { ...hclo4.titrant, factor: '0.1' } }, /not near 1.*molarity was not typed as the factor/],
    [{ ...hclo4, titrant: { ...hclo4.titrant, factor: undefined as unknown as string } }, /factor of the titrant.*S5/],
    [{ ...hclo4, sample: '0 g' }, /more than zero/],
    [{ ...hclo4, sample: '10 mL' }, /must be a mass/],
    [{ ...hclo4, equivalence: { mass: '20.17 mL', molarity: '0.1 M' } }, /must be a mass/],
    [{ ...hclo4, equivalence: { mass: '20.17 mg', molarity: '0.1 M', of: 'excess' as const } }, /direct titration the equivalence is written for the titrant/],
    [{ ...hclo4, report: 'mg per unit' as const }, /average unit weight/],
    [{ ...hclo4, report: 'mg' as const, basis: { as: 'dried' as const, loss: '1 %' } }, /basis applies to a content in %/],
    [{ ...hclo4, unit: 'mg/mL' }, /reported as a fraction/],
    [{ ...hclo4, aliquot: { total: '25 mL', taken: '100 mL' } }, /more than the whole sample solution/],
    [{ ...hclo4, basis: { as: 'dried' as const, loss: '100 %' } }, /from 0 to less than 100/],
    [{ mode: 'back' as const, sample: '1 g', excess: { volume: '5.00 mL', molarity: '0.1 M', factor: '1.000' }, titrant: { volume: '10.00 mL', molarity: '0.1 M', factor: '1.000' }, equivalence: { mass: '5 mg', molarity: '0.1 M' } }, /took up more than the excess/],
  ])('L6 refuses %#', (i, msg) => {
    expect(refused(l6Titration(i as Parameters<typeof l6Titration>[0]))).toMatch(msg);
  });
});

// ================================================================ L7 Water by Karl Fischer
describe('L7 Water by Karl Fischer', () => {
  const vol = { mode: 'volumetric' as const, sample: '0.2000 g', volume: '3.25 mL', factor: '5.012 mg/mL', blank: '0.05 mL' };

  it('L7 volumetric: (3.25 − 0.05) × 5.012 = 16.0384 mg ÷ 200.0 mg × 100 = 8.02 %', () => {
    const r = ok(l7WaterKf(vol));
    expect(r.waterMg.toString()).toBe('16.0384');
    expect(r.value.toFixed(4)).toBe('8.0192');
    expect(r.shown).toBe('((3.25 mL − 0.05 mL) × 5.012 mg/mL) = 16.0384 mg water ÷ 0.2000 g × 100 = 8.02 %');
  });

  it.each([
    ['mg/g', '80.192'], // 8.0192 % × 10
    ['g/g', '0.080192'], // ÷ 100
    ['ppm', '80192'], // × 10000
  ])('L7 result in %s = %s', (unit, want) => {
    expect(ok(l7WaterKf({ ...vol, unit })).value.toString()).toBe(want);
  });

  it('L7 drift subtracted: 10 µg/min × 3 min = 30 µg; 16.0384 − 0.030 = 16.0084 mg = 8.0042 %', () => {
    expect(ok(l7WaterKf({ ...vol, drift: { rate: '10 µg/min', time: '3 min' } })).value.toFixed(4)).toBe('8.0042');
  });

  it('L7 back-titration mode (Ph.Int 2.8 method B): (10.00 × 5.000 − 8.00 × 2.500) = 30.0 mg ÷ 500.0 mg = 6.00 %', () => {
    expect(ok(l7WaterKf({ mode: 'volumetric back', sample: '0.5000 g', reagent: '10.00 mL', factor: '5.000 mg/mL', back: '8.00 mL', backWater: '2.500 mg/mL' })).value.toString()).toBe('6');
  });

  it('L7 coulometric: 1250 µg − blank 20 µg − 5 µg/min × 2 min = 1220 µg ÷ 100.0 mg = 1.22 %', () => {
    const r = ok(l7WaterKf({ mode: 'coulometric', sample: '100.0 mg', water: '1250 µg', blank: '20 µg', drift: { rate: '5 µg/min', time: '2 min' } }));
    expect(r.value.toString()).toBe('1.22');
    expect(ok(l7WaterKf({ mode: 'coulometric', sample: '100.0 mg', water: '1250 µg', blank: '20 µg', drift: { rate: '5 µg/min', time: '2 min' }, unit: 'ppm' })).value.toString()).toBe('12200');
  });

  it.each([
    ['2.60 mL', true], // 13.00 mg ÷ 100.0 mg = 13.0 % = 0.1300 g/g: within 0.115-0.145 g/g
    ['2.90 mL', true], // 14.50 mg = 0.1450 g/g: on the upper limit
    ['2.93 mL', false], // 14.65 mg = 0.1465 g/g → 0.147 > 0.145
    ['2.57 mL', true], // 12.85 mg = 0.1285
  ])('L7 amoxicillin trihydrate limit 0.115-0.145 g/g (research S002): titre %s → pass %s', (volume, pass) => {
    const r = ok(l7WaterKf({ mode: 'volumetric', sample: '0.1000 g', volume, factor: '5.000 mg/mL', unit: 'g/g', limit: { low: '0.115', high: '0.145', unit: 'g/g' } }));
    expect(r.check?.pass).toBe(pass);
  });

  it('L7 a limit in % checks a result in mg/g (30 mg/g = 3.0 %)', () => {
    expect(ok(l7WaterKf({ ...vol, unit: 'mg/g', limit: { high: '3.0', unit: '%' } })).check?.pass).toBe(false);
  });

  it.each([
    [{ ...vol, blank: '4.00 mL' }, /would be negative/],
    [{ ...vol, sample: '0 g' }, /more than zero/],
    [{ ...vol, factor: '5.012 mL' }, /must be a mass concentration/],
    [{ ...vol, factor: '0 mg/mL' }, /more than zero/],
    [{ ...vol, drift: { rate: '10 µg', time: '3 min' } }, /must be a mass rate/],
    [{ ...vol, unit: 'mg/mL' }, /reported as a fraction/],
    [{ mode: 'volumetric back' as const, sample: '0.5 g', reagent: '5.00 mL', factor: '5.000 mg/mL', back: '12.00 mL', backWater: '2.500 mg/mL' }, /would be negative/],
    [{ mode: 'coulometric' as const, sample: '100 mg', water: '1250 mL' }, /must be a mass/],
    [{ ...vol, volume: { value: 3.25 as unknown as string, unit: 'mL' } }, /not as a JavaScript number/],
  ])('L7 refuses %#', (i, msg) => {
    expect(refused(l7WaterKf(i as Parameters<typeof l7WaterKf>[0]))).toMatch(msg);
  });
});

// ================================================================ L8 Mass loss / residue
describe('L8 Mass loss / residue', () => {
  const lod = { mode: 'loss on drying' as const, tare: '25.1234 g', before: '26.1240 g', after: '26.1180 g' };

  it('L8 loss on drying: (26.1240 − 26.1180) ÷ (26.1240 − 25.1234) × 100 = 0.0060 ÷ 1.0006 = 0.60 %', () => {
    const r = ok(l8MassLoss(lod));
    expect(r.value.toFixed(5)).toBe('0.59964');
    expect(r.sampleMass.toString()).toBe('1.0006');
    expect(r.shown).toBe('loss on drying: (26.1240 g − 26.1180 g) ÷ (26.1240 g − 25.1234 g) × 100 = 0.60 %');
  });

  it('L8 in mg/g (Ph.Int writes "NMT 5 mg/g"): 5.9964 mg/g, NMT 5 fails, NMT 6 passes', () => {
    expect(ok(l8MassLoss({ ...lod, unit: 'mg/g' })).value.toFixed(4)).toBe('5.9964');
    expect(ok(l8MassLoss({ ...lod, unit: 'mg/g', limit: { high: '5', unit: 'mg/g' } })).check?.pass).toBe(false);
    expect(ok(l8MassLoss({ ...lod, unit: 'mg/g', limit: { high: '6', unit: 'mg/g' } })).check?.pass).toBe(true);
  });

  it('L8 constant mass by the F2 helper: 26.1185 then 26.1181 g, change 0.4 mg ≤ 0.5 mg; the last weighing is used', () => {
    // loss 26.1240 − 26.1181 = 0.0059 g ÷ 1.0006 = 0.58965 %
    const r = ok(l8MassLoss({ ...lod, after: ['26.1185 g', '26.1181 g'], constantMass: { maxChange: '0.5 mg' } }));
    expect(r.value.toFixed(5)).toBe('0.58965');
    expect(r.constantMass?.pass).toBe(true);
    expect(r.shown).toContain('constant mass');
  });

  it('L8 not at constant mass (1.4 mg > 0.5 mg): refused, heat again', () => {
    expect(refused(l8MassLoss({ ...lod, after: ['26.1195 g', '26.1181 g'], constantMass: { maxChange: '0.5 mg' } }))).toMatch(/Not yet at constant mass.*Heat again/);
  });

  it('L8 sulfated ash "or the result complies" (Ph.Int 2.3, research G008): not constant, but within the limit: accepted', () => {
    const r = ok(l8MassLoss({ mode: 'sulfated ash', tare: '20.0000 g', before: '21.0000 g', after: ['20.0020 g', '20.0012 g'], constantMass: { maxChange: '0.5 mg' }, orWithinLimit: true, limit: { high: '0.1', unit: '%' } }));
    expect(r.check?.pass).toBe(true); // 0.12 % → 0.1
    expect(r.shown).toContain('heating may stop');
    // the same, but above the limit, is refused
    expect(refused(l8MassLoss({ mode: 'sulfated ash', tare: '20.0000 g', before: '21.0000 g', after: ['20.0030 g', '20.0020 g'], constantMass: { maxChange: '0.5 mg' }, orWithinLimit: true, limit: { high: '0.1', unit: '%' } }))).toMatch(/Not yet at constant mass/);
  });

  it.each([
    ['20.0012 g', '0.12', true], // 0.0012 ÷ 1.0000 = 0.12 % → 0.1 ≤ 0.1
    ['20.0014 g', '0.14', true], // 0.14 → 0.1
    ['20.0015 g', '0.15', false], // 0.15 → 0.2 (half up) > 0.1
  ])('L8 sulfated ash NMT 0.1 %%: after %s → %s %%, pass %s', (after, val, pass) => {
    const r = ok(l8MassLoss({ mode: 'sulfated ash', tare: '20.0000 g', before: '21.0000 g', after, limit: { high: '0.1', unit: '%' } }));
    expect(r.value.toFixed(2)).toBe(val);
    expect(r.check?.pass).toBe(pass);
  });

  it.each([
    ['residue on ignition'],
    ['residue'],
  ] as const)('L8 %s: (after − tare) ÷ (before − tare)', (mode) => {
    // unsaponifiable matter (research S015): residue 0.0450 g of 5.0000 g = 0.90 % = 9.0 mg/g
    const r = ok(l8MassLoss({ mode, tare: '50.0000 g', before: '55.0000 g', after: '50.0450 g', unit: 'mg/g' }));
    expect(r.value.toString()).toBe('9');
  });

  it('L8 loss on ignition: (before − after) ÷ sample', () => {
    expect(ok(l8MassLoss({ mode: 'loss on ignition', tare: '30.000 g', before: '32.000 g', after: '31.880 g' })).value.toString()).toBe('6'); // 0.120 ÷ 2.000
  });

  it('L8 container weight loss (stability, research T002): of the whole container, or of the contents with a tare', () => {
    expect(ok(l8MassLoss({ mode: 'container weight loss', before: '52.340 g', after: '52.288 g' })).value.toFixed(4)).toBe('0.0994'); // 0.052 ÷ 52.340
    expect(ok(l8MassLoss({ mode: 'container weight loss', tare: '40.000 g', before: '52.340 g', after: '52.288 g' })).value.toFixed(4)).toBe('0.4214'); // 0.052 ÷ 12.340
  });

  it('L8 on the dried basis: sulfated ash 0.12 % with LOD 2.0 % → 0.12 × 100 ÷ 98 = 0.1224 %', () => {
    expect(ok(l8MassLoss({ mode: 'sulfated ash', tare: '20.0000 g', before: '21.0000 g', after: '20.0012 g', basis: { as: 'dried', loss: '2.0 %' } })).value.toFixed(4)).toBe('0.1224');
  });

  it('L8 masses in mg and g mix: tare in g, before and after in mg', () => {
    expect(ok(l8MassLoss({ mode: 'loss on drying', tare: '25.1234 g', before: '26124.0 mg', after: '26118.0 mg' })).value.toFixed(5)).toBe('0.59964');
  });

  it.each([
    [{ ...lod, tare: undefined }, /Give the tare/],
    [{ ...lod, before: '25.0000 g' }, /no sample/],
    [{ ...lod, after: '26.1300 g' }, /gained mass/],
    [{ mode: 'sulfated ash' as const, tare: '20.0000 g', before: '21.0000 g', after: '19.9990 g' }, /less than the tare/],
    [{ mode: 'residue' as const, tare: '20.0000 g', before: '21.0000 g', after: '21.5000 g' }, /residue is more than the sample/],
    [{ ...lod, constantMass: { maxChange: '0.5 mg' } }, /at least two successive weighings/],
    [{ ...lod, after: [] }, /Give the mass after/],
    [{ ...lod, after: '26.1 mL' }, /must be a mass/],
    [{ ...lod, unit: 'mg' }, /reported as a fraction/],
    [{ ...lod, basis: { as: 'dried' as const, loss: '0.6 %', sampleAlreadyDried: true } }, /S3/],
  ])('L8 refuses %#', (i, msg) => {
    expect(refused(l8MassLoss(i as Parameters<typeof l8MassLoss>[0]))).toMatch(msg);
  });
});

// ================================================================ L10 Readings with a fixed rule
describe('L10 Readings with a fixed rule', () => {
  const rot = { mode: 'specific rotation' as const, angle: '+1.05 °', form: 'solution' as const, concentration: '2.000 g/100 mL' };

  it.each([
    ['1 dm', '52.5'], // 100 × 1.05 ÷ (1 × 2.000) = 52.5
    ['100 mm', '52.5'], // the same tube in mm
    ['10 cm', '52.5'],
    ['2 dm', '26.25'], // 100 × 1.05 ÷ (2 × 2) = 26.25
  ])('L10 specific rotation: path length %s → [α] = %s°', (pathLength, want) => {
    expect(ok(l10Reading({ ...rot, pathLength })).value.toString()).toBe(want);
  });

  it('L10 specific rotation: the concentration may be in mg/mL (20 mg/mL = 2 g/100 mL)', () => {
    expect(ok(l10Reading({ ...rot, pathLength: '1 dm', concentration: '20 mg/mL' })).value.toString()).toBe('52.5');
  });

  it('L10 specific rotation shows its worked line', () => {
    expect(ok(l10Reading({ ...rot, pathLength: '1 dm' })).shown).toBe('[α] = 100 × +1.05 ° ÷ (1.0000 dm × 2.0000 g/100 mL) = 52.5°');
  });

  it.each([
    ['1 mm', /not plausible.*S12/], // a 1-dm tube typed as mm: 0.01 dm
    ['100 dm', /not plausible.*S12/], // a 100-mm tube typed as dm
    ['1', /with its unit.*S12/], // a bare number
    ['1 g', /must be a length/],
  ])('L10 safety S12: path length %s is refused', (pathLength, msg) => {
    expect(refused(l10Reading({ ...rot, pathLength }))).toMatch(msg);
  });

  it('L10 specific rotation on the anhydrous basis (water 5.0 %): 52.5 × 100 ÷ 95 = 55.26°', () => {
    expect(ok(l10Reading({ ...rot, pathLength: '1 dm', basis: { as: 'anhydrous', loss: '5.0 %' } })).value.toFixed(2)).toBe('55.26');
  });

  it('L10 specific rotation of a neat liquid: −10.50° ÷ (1 dm × 0.9000) = −11.67°', () => {
    expect(ok(l10Reading({ mode: 'specific rotation', angle: '-10.50 °', pathLength: '1 dm', form: 'neat liquid', density: '0.9000' })).value.toFixed(2)).toBe('-11.67');
  });

  it('L10 specific rotation of a solution by mass: 100 × 2.00 ÷ (2 dm × 10.0 g/100 g × 1.040) = 9.62°', () => {
    expect(ok(l10Reading({ mode: 'specific rotation', angle: '2.00 °', pathLength: '200 mm', form: 'solution by mass', massPercent: '10.0 g/100 g', density: '1.040' })).value.toFixed(2)).toBe('9.62');
  });

  it.each([
    ['+52.0', '+54.0', '1.0745 °', true], // [α] = 53.725 → 53.7
    ['+52.0', '+54.0', '1.0810 °', false], // 54.05 → 54.1 (half up) > 54.0
    ['+52.0', '+54.0', '1.0809 °', true], // 54.045 → 54.0
  ])('L10 rotation limit %s to %s: α %s → pass %s', (low, high, angle, pass) => {
    expect(ok(l10Reading({ ...rot, pathLength: '1 dm', angle, limit: { low: low.replace('+', ''), high: high.replace('+', ''), unit: '°' } })).check?.pass).toBe(pass);
  });

  it.each([
    [{ ...rot, pathLength: '1 dm', concentration: undefined }, /needs its concentration/],
    [{ ...rot, pathLength: '1 dm', concentration: '0 g/100 mL' }, /more than zero/],
    [{ ...rot, pathLength: '1 dm', concentration: '2 %' }, /must be a mass concentration/],
    [{ ...rot, pathLength: '1 dm', angle: '1.05' }, /must be an angle/],
    [{ mode: 'specific rotation' as const, angle: '1 °', pathLength: '1 dm', form: 'neat liquid' as const }, /needs the relative density/],
    [{ mode: 'specific rotation' as const, angle: '1 °', pathLength: '1 dm', form: 'solution by mass' as const, density: '1.0' }, /g per 100 g/],
  ])('L10 rotation refuses %#', (i, msg) => {
    expect(refused(l10Reading(i as Parameters<typeof l10Reading>[0]))).toMatch(msg);
  });

  it('L10 content from rotation: 3.20° × 0.9524 %w/v per degree = 3.04768 %w/v', () => {
    const r = ok(l10Reading({ mode: 'content from rotation', angle: '3.20 °', factor: { value: '0.9524', unit: '%w/v' } }));
    expect(r.value.toString()).toBe('3.04768');
    expect(r.unit).toBe('%w/v');
  });

  const pyc = { empty: '20.000 g', withWater: '45.000 g', withSample: '43.000 g' };
  it('L10 relative density (pycnometer, research S015): (43.000 − 20.000) ÷ (45.000 − 20.000) = 0.9200', () => {
    expect(ok(l10Reading({ mode: 'relative density', ...pyc })).value.toString()).toBe('0.92');
  });

  it('L10 weight per mL: 0.92 × 0.99705 g/mL (water at 25 °C, from the table item) = 0.917286 g/mL', () => {
    const r = ok(l10Reading({ mode: 'weight per mL', ...pyc, waterDensity: '0.99705 g/mL', temperature: '25 °C' }));
    expect(r.value.toString()).toBe('0.917286');
    expect(r.unit).toBe('g/mL');
    expect(ok(l10Reading({ mode: 'weight per mL', ...pyc, waterDensity: '997.05 kg/m³' })).value.toString()).toBe('0.917286');
  });

  it.each([
    [{ mode: 'weight per mL' as const, ...pyc }, /needs the density of water/],
    [{ mode: 'weight per mL' as const, ...pyc, waterDensity: '997 g/mL' }, /between 0.95 and 1.000/],
    [{ mode: 'relative density' as const, ...pyc, withWater: '20.000 g' }, /must weigh more than the empty/],
    [{ mode: 'relative density' as const, ...pyc, empty: '20 mL' }, /must be a mass/],
  ])('L10 density refuses %#', (i, msg) => {
    expect(refused(l10Reading(i as Parameters<typeof l10Reading>[0]))).toMatch(msg);
  });

  it('L10 ethanol content from density (OIML R 22, research S009): the density of 96.0 % v/v gives back 96.0 % v/v and 93.84 % w/w', () => {
    // T26 gives 96 % v/v = 93.84 % w/w; its density by the same formula is fed back
    const p = ethanolWw(d(96)).div(100);
    const rho = ethanolDensity(p).div(1000).toFixed(6);
    expect(rho.slice(0, 6)).toBe('0.8074'); // 807.4 kg/m³ at 20 °C
    const vv = ok(l10Reading({ mode: 'ethanol content', density: `${rho} g/mL`, report: '% v/v' }));
    expect(vv.value.toFixed(2)).toBe('96.00');
    expect(vv.unit).toBe('%v/v');
    expect(ok(l10Reading({ mode: 'ethanol content', density: `${rho} g/mL`, report: '% w/w' })).value.toFixed(2)).toBe('93.84');
  });

  it('L10 ethanol: a density outside water to ethanol (0.78924-0.99820 g/mL) is refused', () => {
    expect(refused(l10Reading({ mode: 'ethanol content', density: '1.050 g/mL', report: '% v/v' }))).toMatch(/outside the range/);
  });

  it('L10 pH: the reading with its temperature', () => {
    const r = ok(l10Reading({ mode: 'pH', reading: '6.52', temperature: '25.0 °C', calibrationTemperature: '24.0 °C', limit: { low: '5.0', high: '7.0', unit: '' } }));
    expect(r.shown).toBe('pH 6.52 at 25.0 °C');
    expect(r.check?.pass).toBe(true);
  });

  it.each([
    [{ mode: 'pH' as const, reading: '6.52', temperature: '25.0 °C', calibrationTemperature: '20.0 °C' }, /more than 2 °C from the calibration/],
    [{ mode: 'pH' as const, reading: '15.0', temperature: '25 °C' }, /from 0 to 14/],
    [{ mode: 'pH' as const, reading: '6.5 mg', temperature: '25 °C' }, /must be a number/],
    [{ mode: 'pH' as const, reading: '6.5', temperature: '25 mg' }, /must be a temperature/],
  ])('L10 pH refuses %#', (i, msg) => {
    expect(refused(l10Reading(i as Parameters<typeof l10Reading>[0]))).toMatch(msg);
  });

  it.each([
    ['1.0 µS/cm', '23.5 °C', 'pass'], // limit at 20 °C (next lower step) 1.1
    ['1.2 µS/cm', '23.5 °C', 'next stage'], // 1.2 > 1.1
    ['1.2 µS/cm', '25.0 °C', 'pass'], // limit at 25 °C 1.3
    ['0.0012 mS/cm', '25.0 °C', 'pass'], // the same in mS/cm
    ['2.9 µS/cm', '97 °C', 'pass'], // 95 °C row: 2.9
  ])('L10 conductivity stage 1 (USP <645>): %s at %s → %s', (reading, temperature, want) => {
    expect(ok(l10Reading({ mode: 'conductivity', stage: 1, reading, temperature, temperatureCompensated: false })).decision).toBe(want);
  });

  it('L10 safety S11: stage 1 refuses a temperature-compensated reading', () => {
    expect(refused(l10Reading({ mode: 'conductivity', stage: 1, reading: '1.0 µS/cm', temperature: '23.5 °C', temperatureCompensated: true }))).toMatch(/NOT compensated.*S11/);
  });

  it.each([
    ['2.0 µS/cm', '25.4 °C', 'pass'],
    ['2.14 µS/cm', '25.0 °C', 'pass'], // rounds to 2.1
    ['2.15 µS/cm', '25.0 °C', 'next stage'], // rounds to 2.2
  ])('L10 conductivity stage 2 (25 ± 1 °C, NMT 2.1): %s at %s → %s', (reading, temperature, want) => {
    expect(ok(l10Reading({ mode: 'conductivity', stage: 2, reading, temperature, temperatureCompensated: false })).decision).toBe(want);
  });

  it('L10 conductivity stage 2 outside 25 ± 1 °C is refused', () => {
    expect(refused(l10Reading({ mode: 'conductivity', stage: 2, reading: '2.0 µS/cm', temperature: '27 °C', temperatureCompensated: false }))).toMatch(/25 ± 1 °C/);
  });

  it.each([
    ['6.03', '2.3 µS/cm', 'pass'], // pH 6.0: limit 2.4
    ['6.03', '2.5 µS/cm', 'fail'],
    ['6.66', '2.6 µS/cm', 'pass'], // pH 6.7: 2.6
    ['7.2', '1.0 µS/cm', 'fail'], // outside pH 5.0-7.0
  ])('L10 conductivity stage 3: pH %s, %s → %s', (pH, reading, want) => {
    expect(ok(l10Reading({ mode: 'conductivity', stage: 3, reading, pH, temperatureCompensated: false })).decision).toBe(want);
  });

  it('L10 TOC (USP <643>) with system suitability: 210 ppb against the limit response 520 − 50 = 470 ppb; efficiency 97.87 %', () => {
    const r = ok(l10Reading({ mode: 'TOC', reading: '210 ppb', suitability: { water: '50 ppb', sucrose: '520 ppb', benzoquinone: '510 ppb' } }));
    expect(r.check?.pass).toBe(true);
    expect(r.shown).toContain('response efficiency 97.9 %'); // 460 ÷ 470 × 100 = 97.872
    expect(ok(l10Reading({ mode: 'TOC', reading: '480 ppb', suitability: { water: '50 ppb', sucrose: '520 ppb', benzoquinone: '510 ppb' } })).check?.pass).toBe(false);
  });

  it('L10 TOC system not suitable (efficiency 80.9 %) is refused', () => {
    expect(refused(l10Reading({ mode: 'TOC', reading: '210 ppb', suitability: { water: '50 ppb', sucrose: '520 ppb', benzoquinone: '430 ppb' } }))).toMatch(/not suitable/);
  });

  it('L10 TOC as a plain reading against a limit of 500 ppb', () => {
    expect(ok(l10Reading({ mode: 'TOC', reading: '210 ppb', limit: { high: '500', unit: 'ppb' } })).check?.pass).toBe(true);
  });

  it('L10 corrected melting point (Ph.Int 1.2.1, research G001): 135.2 − 0.3 + 0.00015 × 60 × (135.2 − 35) = 135.8018 °C', () => {
    const r = ok(l10Reading({ mode: 'melting point', reading: '135.2 °C', thermometerCorrection: '-0.3 Δ°C', stem: { degrees: '60', stemTemperature: '35 °C' } }));
    expect(r.value.toString()).toBe('135.8018');
    expect(r.shown.endsWith('= 135.8 °C')).toBe(true);
  });
});

// ================================================================ distributions
describe('L14 critical values (computed, checked against the published tables)', () => {
  it.each([
    ['0.975', '1', '12.706'], ['0.975', '2', '4.303'], ['0.975', '5', '2.571'], ['0.975', '9', '2.262'], ['0.975', '10', '2.228'],
    ['0.975', '30', '2.042'], ['0.975', '120', '1.980'], ['0.95', '10', '1.812'], ['0.995', '5', '4.032'], ['0.95', '5', '2.015'],
  ])('L14 t(%s; df %s) = %s', (p, df, want) => {
    expect(tQuantile(d(p), d(df)).toFixed(3)).toBe(want);
  });

  it('L14 t with very many degrees of freedom tends to z = 1.960', () => {
    expect(tQuantile(d('0.975'), d('100000')).toFixed(3)).toBe('1.960');
  });

  it.each([
    ['0.95', '3', '10', '3.708'], ['0.95', '5', '5', '5.050'], ['0.975', '5', '5', '7.146'], ['0.95', '1', '1', '161.448'],
    ['0.95', '2', '2', '19.000'], ['0.975', '9', '9', '4.026'], ['0.99', '4', '20', '4.431'],
  ])('L14 F(%s; %s, %s) = %s', (p, a, b, want) => {
    expect(fQuantile(d(p), d(a), d(b)).toFixed(3)).toBe(want);
  });

  it.each([
    ['0.975', '10', '20.483'], ['0.025', '10', '3.247'], ['0.95', '1', '3.841'], ['0.975', '5', '12.833'], ['0.025', '5', '0.831'], ['0.05', '9', '3.325'],
  ])('L14 χ²(%s; %s) = %s', (p, k, want) => {
    expect(chi2Quantile(d(p), d(k)).toFixed(3)).toBe(want);
  });

  it('L14 ln Γ and the incomplete functions at known points', () => {
    expect(lnGamma(d(5)).toFixed(12)).toBe(Dec.ln(24).toFixed(12)); // Γ(5) = 4! = 24
    expect(lnGamma(d('0.5')).toFixed(12)).toBe(Dec.ln(Dec.acos(-1).sqrt()).toFixed(12)); // Γ(1/2) = √π
    expect(incompleteBeta(d('0.5'), d(2), d(2)).toFixed(12)).toBe('0.500000000000'); // symmetric
    expect(incompleteBeta(d('0.3'), d(1), d(1)).toFixed(12)).toBe('0.300000000000'); // uniform
    expect(incompleteGamma(d(1), d(1)).toFixed(12)).toBe(d(1).minus(Dec.exp(-1)).toFixed(12)); // 1 − e⁻¹
  });
});

// ================================================================ L14 Statistics
describe('L14 Statistics', () => {
  // Own assay results (%): mean 99.5333, SD 0.527889 (sum of squares 1.393333 ÷ 5), RSD 0.5304 %.
  const a = { values: '99.1 99.5 100.2 98.8 100.0 99.6'.split(' '), unit: '%' };
  const b = { values: '98.0 98.6 98.2 98.9 98.4 98.5'.split(' '), unit: '%' };

  it('L14 summary: mean, SD, RSD and the 95 % confidence interval of the mean (t = 2.5706, 5 df)', () => {
    // half-width 2.570582 × 0.527889 ÷ √6 = 0.553985 → 98.9793 to 100.0873
    const r = ok(l14Statistics({ mode: 'summary', readings: a }));
    expect(r.value.toFixed(4)).toBe('99.5333');
    expect(r.sd?.toFixed(6)).toBe('0.527889');
    expect(r.rsd?.toFixed(4)).toBe('0.5304');
    expect(r.ci?.low.toFixed(4)).toBe('98.9793');
    expect(r.ci?.high.toFixed(4)).toBe('100.0873');
  });

  it('L14 one-sided lower bound at 95 %: 99.5333 − 2.015048 × 0.527889 ÷ √6 = 99.0991', () => {
    const r = ok(l14Statistics({ mode: 'summary', readings: a, sides: 'lower bound' }));
    expect(r.ci?.low.toFixed(4)).toBe('99.0991');
    expect(r.ci?.high.isFinite()).toBe(false);
  });

  it('L14 confidence interval of the SD (χ² 0.8312 and 12.8325): 0.32951 to 1.29471', () => {
    // 0.527889 × √(5 ÷ 12.832502) = 0.329512; 0.527889 × √(5 ÷ 0.831212) = 1.294708
    const r = ok(l14Statistics({ mode: 'summary', readings: a, sdInterval: true }));
    expect(r.sdCi?.low.toFixed(4)).toBe('0.3295');
    expect(r.sdCi?.high.toFixed(4)).toBe('1.2947');
  });

  it('L14 prediction interval for one more result: 99.5333 ± 2.570582 × 0.527889 × √(7/6) = 98.0676 to 100.9990', () => {
    const r = ok(l14Statistics({ mode: 'summary', readings: a, prediction: true }));
    expect(r.predictionInterval?.low.toFixed(4)).toBe('98.0676');
    expect(r.predictionInterval?.high.toFixed(4)).toBe('100.9990');
  });

  it('L14 tolerance interval, 10 results, 95 % coverage at 95 % confidence: Howe k = 3.38 (published exact table 3.379)', () => {
    const ten = { values: ['99.1', '99.5', '100.2', '98.8', '100.0', '99.6', '99.9', '100.4', '99.0', '99.7'], unit: '%' };
    const r = ok(l14Statistics({ mode: 'summary', readings: ten, toleranceCoverage: '95' }));
    // k² = 9 × 1.1 × 3.841459 ÷ 3.325113 = 11.4374 → k = 3.3819
    expect(r.k?.toFixed(3)).toBe('3.382');
  });

  it('L14 bias against a known true value 100.0 %: −0.4667 (95 % CI −1.0207 to 0.0873)', () => {
    const r = ok(l14Statistics({ mode: 'summary', readings: a, trueValue: '100.0 %' }));
    expect(r.bias?.toFixed(4)).toBe('-0.4667');
    expect(r.biasCi?.low.toFixed(4)).toBe('-1.0207');
    expect(r.biasCi?.high.toFixed(4)).toBe('0.0873');
  });

  it('L14 RSD limit at the limit\'s decimals: 0.5304 % passes NMT 2.0 and NMT 0.5 (→ 0.5), fails NMT 0.50 (→ 0.53)', () => {
    expect(ok(l14Statistics({ mode: 'summary', readings: a, rsdLimit: { high: '2.0', unit: '%' } })).rsdCheck?.pass).toBe(true);
    expect(ok(l14Statistics({ mode: 'summary', readings: a, rsdLimit: { high: '0.5', unit: '%' } })).rsdCheck?.pass).toBe(true);
    expect(ok(l14Statistics({ mode: 'summary', readings: a, rsdLimit: { high: '0.50', unit: '%' } })).rsdCheck?.pass).toBe(false);
  });

  it('L14 the confidence level can be 90 or 99 %', () => {
    const r90 = ok(l14Statistics({ mode: 'summary', readings: a, confidence: '90' }));
    const r99 = ok(l14Statistics({ mode: 'summary', readings: a, confidence: '99' }));
    expect(r90.t?.toFixed(3)).toBe('2.015'); // t(0.95; 5)
    expect(r99.t?.toFixed(3)).toBe('4.032'); // t(0.995; 5)
  });

  it('L14 difference of two means, pooled SD: 1.1000, 95 % CI 0.5412 to 1.6588 (t 2.2281, 10 df): significant', () => {
    // pooled variance (1.393333 + 0.493333) ÷ 10 = 0.188667; SE = √(0.188667 × 2/6) = 0.250777
    const r = ok(l14Statistics({ mode: 'two means', a, b, variances: 'equal' }));
    expect(r.value.toFixed(4)).toBe('1.1000');
    expect(r.ci?.low.toFixed(4)).toBe('0.5412');
    expect(r.ci?.high.toFixed(4)).toBe('1.6588');
    expect(r.significant).toBe(true);
    expect(r.shown).toContain('SIGNIFICANT difference');
  });

  it('L14 difference of two means, Welch: df = 8.146 (Welch-Satterthwaite), t between t(8) 2.306 and t(9) 2.262', () => {
    const r = ok(l14Statistics({ mode: 'two means', a, b, variances: 'unequal' }));
    expect(r.df?.toFixed(3)).toBe('8.146');
    expect(r.t?.gt('2.262') && r.t?.lt('2.306')).toBe(true);
    expect(r.significant).toBe(true);
  });

  it('L14 difference of two means: no significant difference when the interval holds 0', () => {
    const r = ok(l14Statistics({ mode: 'two means', a, b: { values: '99.3 99.9 99.0 100.1 99.4 99.8'.split(' '), unit: '%' }, variances: 'equal' }));
    expect(r.significant).toBe(false);
  });

  it('L14 F test: 0.278667 ÷ 0.098667 = 2.824 < F(0.975; 5, 5) = 7.146: no significant difference', () => {
    const r = ok(l14Statistics({ mode: 'F test', a, b }));
    expect(r.value.toFixed(3)).toBe('2.824');
    expect(r.critical?.toFixed(3)).toBe('7.146');
    expect(r.significant).toBe(false);
  });

  it('L14 F test one-sided (a > b) at 95 %: critical F(0.95; 5, 5) = 5.050', () => {
    expect(ok(l14Statistics({ mode: 'F test', a, b, sides: 'one-sided' })).critical?.toFixed(3)).toBe('5.050');
  });

  it('L14 F test two-sided puts the larger variance on top whichever series it is', () => {
    expect(ok(l14Statistics({ mode: 'F test', a: b, b: a })).value.toFixed(3)).toBe('2.824');
  });

  it.each([
    [{ mode: 'summary' as const, readings: { values: ['99.1'], unit: '%' } }, /at least two results/],
    [{ mode: 'summary' as const, readings: a, confidence: '100' }, /between 50 and 100/],
    [{ mode: 'summary' as const, readings: a, toleranceCoverage: '0' }, /between 0 and 100/],
    [{ mode: 'F test' as const, a, b: { values: ['98.0', '98.0'], unit: '%' } }, /no spread/],
    [{ mode: 'two means' as const, a: { values: ['1', '1'], unit: '%' }, b: { values: ['2', '2'], unit: '%' }, variances: 'equal' as const }, /no spread/],
    [{ mode: 'two means' as const, a, b: { values: ['1', '2'], unit: 'mg' }, variances: 'equal' as const }, /cannot be converted/],
  ])('L14 refuses %#', (i, msg) => {
    expect(refused(l14Statistics(i as Parameters<typeof l14Statistics>[0]))).toMatch(msg);
  });
});

// ================================================================ L17 Standardisation
describe('L17 Standardisation', () => {
  // 0.1 M sodium hydroxide VS against potassium hydrogen phthalate (20.42 mg per mL of 0.1 M), purity 99.95 %.
  const naoh = {
    mode: 'VS factor' as const, molarity: '0.1 M', equivalent: '20.42 mg', purity: '99.95 %',
    replicates: [{ mass: '408.5 mg', volume: '19.95 mL' }, { mass: '410.2 mg', volume: '20.05 mL' }, { mass: '409.0 mg', volume: '19.98 mL' }],
  };

  it('L17 VS factor: f = m × purity ÷ (E × V); mean 1.00187, RSD 0.043 %, molarity 0.10019 M', () => {
    // 408.5 × 0.9995 ÷ (20.42 × 19.95) = 1.002250; 410.2 × 0.9995 ÷ (20.42 × 20.05) = 1.001402; 409.0 × 0.9995 ÷ (20.42 × 19.98) = 1.001970
    const r = ok(l17Standardisation({ ...naoh, rsdLimit: { high: '0.2', unit: '%' } }));
    expect(r.replicates.map((x) => x.toFixed(6))).toEqual(['1.002250', '1.001402', '1.001970']);
    expect(r.value.toFixed(5)).toBe('1.00187');
    expect(r.rsd?.toFixed(3)).toBe('0.043');
    expect(r.molarity?.toFixed(6)).toBe('0.100187');
    expect(r.rsdCheck?.pass).toBe(true);
  });

  it('L17 VS factor with a blank: the titre less the blank', () => {
    // 408.5 ÷ (20.42 × (20.00 − 0.05)) = 1.002752
    expect(ok(l17Standardisation({ mode: 'VS factor', molarity: '0.1 M', equivalent: '20.42 mg', replicates: [{ mass: '408.5 mg', volume: '20.00 mL', blank: '0.05 mL' }] })).value.toFixed(6)).toBe('1.002752');
  });

  it('L17 VS factor limit 0.95-1.05 is checked on the mean', () => {
    expect(ok(l17Standardisation({ ...naoh, limit: { low: '0.95', high: '1.05', unit: '' } })).check?.pass).toBe(true);
  });

  it('L17 RSD limit NMT 0.02 % fails (0.043 %)', () => {
    expect(ok(l17Standardisation({ ...naoh, rsdLimit: { high: '0.02', unit: '%' } })).rsdCheck?.pass).toBe(false);
  });

  it('L17 KF water equivalent from sodium tartrate dihydrate (15.66 % water): 150.0 × 0.1566 ÷ 4.70 = 4.99787; mean 5.0045 mg/mL', () => {
    const r = ok(l17Standardisation({ mode: 'KF water equivalent', waterContent: '15.66 %', replicates: [{ mass: '150.0 mg', volume: '4.70 mL' }, { mass: '152.0 mg', volume: '4.75 mL' }] }));
    expect(r.replicates.map((x) => x.toFixed(5))).toEqual(['4.99787', '5.01120']);
    expect(r.value.toFixed(4)).toBe('5.0045');
    expect(r.unit).toBe('mg/mL');
  });

  it('L17 KF water equivalent with water itself (100 %): 25.0 mg ÷ 5.00 mL = 5.000 mg/mL', () => {
    expect(ok(l17Standardisation({ mode: 'KF water equivalent', waterContent: '100 %', replicates: [{ mass: '25.0 mg', volume: '5.00 mL' }] })).value.toString()).toBe('5');
  });

  const ws = {
    mode: 'working standard' as const,
    primary: { potency: '99.8 %', preparations: [{ mass: '50.0 mg', responses: ['125000', '125400'], volume: '100 mL' }] },
    working: { preparations: [{ mass: '50.5 mg', responses: ['124800', '125200'], volume: '100 mL' }, { mass: '49.8 mg', responses: ['123300', '123500'], volume: '100 mL' }] },
  };

  it('L17 working standard against the primary: 98.654 % and 98.760 %, mean 98.71 %', () => {
    // primary: 125200 ÷ 0.500 mg/mL ÷ 0.998 = 250901.80 per mg/mL of pure substance
    // ws 1: 125000 ÷ 0.505 = 247524.75 → ÷ 250901.80 × 100 = 98.654 %; ws 2: 123400 ÷ 0.498 = 247791.16 → 98.760 %
    const r = ok(l17Standardisation({ ...ws, rsdLimit: { high: '1.0', unit: '%' } }));
    expect(r.replicates.map((x) => x.toFixed(3))).toEqual(['98.654', '98.760']);
    expect(r.value.toFixed(3)).toBe('98.707');
    expect(r.rsdCheck?.pass).toBe(true);
  });

  it('L17 working standard without dilution volumes (all made up alike) gives the same', () => {
    const strip = (p: { mass: string; responses: string[] }) => ({ mass: p.mass, responses: p.responses });
    const r = ok(l17Standardisation({ ...ws, primary: { potency: '99.8 %', preparations: ws.primary.preparations.map(strip) }, working: { preparations: ws.working.preparations.map(strip) } }));
    expect(r.value.toFixed(3)).toBe('98.707');
  });

  it('L17 working standard on the dried basis (LOD 0.40 %): 98.7071 × 100 ÷ 99.6 = 99.10 %', () => {
    expect(ok(l17Standardisation({ ...ws, basis: { as: 'dried', loss: '0.40 %' } })).value.toFixed(2)).toBe('99.10');
  });

  it.each([
    [{ ...naoh, replicates: [] }, /at least one replicate/],
    [{ ...naoh, replicates: [{ mass: '40.85 mg', volume: '19.95 mL' }] }, /not near 1/],
    [{ ...naoh, replicates: [{ mass: '408.5 mg', volume: '0.05 mL', blank: '0.05 mL' }] }, /more than zero/],
    [{ ...naoh, purity: '101 %' }, /not more than 100/],
    [{ ...naoh, rsdLimit: { high: '0.2', unit: '%' }, replicates: [{ mass: '408.5 mg', volume: '19.95 mL' }] }, /at least two replicates/],
    [{ mode: 'KF water equivalent' as const, waterContent: '0 %', replicates: [{ mass: '25 mg', volume: '5 mL' }] }, /more than 0/],
    [{ ...ws, working: { preparations: [{ mass: '50.5 mg', responses: ['124800'] }] } }, /dilution volume for every preparation, or for none/],
    [{ ...ws, working: { preparations: [] } }, /at least one preparation/],
    [{ ...ws, primary: { ...ws.primary, potency: '0 %' } }, /more than 0/],
    [{ ...ws, working: { preparations: [{ mass: '50.5 mg', responses: ['0'], volume: '100 mL' }] } }, /response must be more than zero/],
  ])('L17 refuses %#', (i, msg) => {
    expect(refused(l17Standardisation(i as Parameters<typeof l17Standardisation>[0]))).toMatch(msg);
  });
});

// ================================================================ L19 Sampling plan size
describe('L19 Sampling plan size', () => {
  it.each([
    ['20', 6], // 1 + 4.472 = 5.47 → 6
    ['4', 3], // 1 + 2 = 3
    ['7', 4], // 1 + 2.646 = 3.65 → 4
    ['100', 11], // 1 + 10
    ['101', 12], // 1 + 10.05 → 12
    ['2', 2], // 1 + 1.414 = 2.41 → 3, but only 2 containers
    ['1', 1],
    ['20 units', 6], // a counted value
  ])('L19 √N + 1 rounded up: N = %s → %s containers', (containers, n) => {
    expect(ok(l19SamplingPlan({ mode: 'square root', containers })).value.toNumber()).toBe(n);
  });

  it('L19 composite: 6 containers in composites of up to 3 → 2 tests; one composite → 1 test', () => {
    expect(ok(l19SamplingPlan({ mode: 'square root', containers: '20', test: { compositesOf: 3 } })).tests).toBe(2);
    expect(ok(l19SamplingPlan({ mode: 'square root', containers: '20', test: 'one composite' })).tests).toBe(1);
    expect(ok(l19SamplingPlan({ mode: 'square root', containers: '20' })).tests).toBe(6);
  });

  it('L19 every container', () => {
    expect(ok(l19SamplingPlan({ mode: 'every container', containers: '7' })).value.toNumber()).toBe(7);
  });

  it('L19 shows the rule', () => {
    expect(ok(l19SamplingPlan({ mode: 'square root', containers: '20' })).shown).toBe('sample 6 of 20 containers (1 + √20 = 5.47, rounded up = 6); each tested: 6 tests');
  });

  it.each([
    ['parenteral', '40', 4], // 10 % = 4, or 4
    ['parenteral', '45', 5], // 10 % = 4.5 → 5
    ['parenteral', '300', 10],
    ['parenteral', '600', 12], // 2 % = 12, less than 20
    ['parenteral', '2000', 20], // 2 % = 40 → 20
    ['parenteral', '3', 3], // 4 needed, only 3: all
    ['large-volume parenteral', '300', 10], // more than 100, not more than 500: 10, as other parenterals (the cap of 10 is only above 500)
    ['large-volume parenteral', '50', 5], // 10 % = 5, at least 4
    ['large-volume parenteral', '1000', 10], // 2 % = 20 → 10
    ['antibiotic solid, bulk package under 5 g', '500', 20],
    ['antibiotic solid, bulk package 5 g or more', '500', 6],
    ['ophthalmic and other non-injectable', '40', 2], // 5 % = 2
    ['ophthalmic and other non-injectable', '100', 5],
    ['ophthalmic and other non-injectable', '250', 10],
    ['bulk solid', '3', 3],
    ['bulk solid', '10', 4], // 20 % = 2, or 4
    ['bulk solid', '30', 6], // 20 % = 6
    ['bulk solid', '200', 10], // 2 % = 4, or 10
    ['bulk solid', '1000', 20], // 2 % = 20
    ['devices', '150', 10],
  ] as const)('L19 sterility containers (Ph.Int 3.2 Table 3): %s, batch %s → %s', (product, batchSize, n) => {
    expect(ok(l19SamplingPlan({ mode: 'sterility containers', batchSize, product, oneContainerForBothMedia: true })).value.toNumber()).toBe(n);
  });

  it('L19 sterility safety (research G014): a batch of 40 read as ophthalmic gives 2 containers, as parenteral 4: the product type comes from the master', () => {
    expect(ok(l19SamplingPlan({ mode: 'sterility containers', batchSize: '40', product: 'ophthalmic and other non-injectable', oneContainerForBothMedia: true })).value.toNumber()).toBe(2);
    expect(ok(l19SamplingPlan({ mode: 'sterility containers', batchSize: '40', product: 'parenteral', oneContainerForBothMedia: true })).value.toNumber()).toBe(4);
  });

  it('L19 sterility: when one container cannot inoculate both media the number doubles (300 parenteral → 20)', () => {
    const r = ok(l19SamplingPlan({ mode: 'sterility containers', batchSize: '300', product: 'parenteral', oneContainerForBothMedia: false }));
    expect(r.value.toNumber()).toBe(20);
    expect(r.shown).toContain('× 2');
  });

  it.each([
    ['liquid', '0.5 mL', '0.5', 'mL'], // whole contents
    ['liquid', '1.5 mL', '1', 'mL'], // half = 0.75, not less than 1
    ['liquid', '10 mL', '5', 'mL'], // half
    ['liquid', '50 mL', '20', 'mL'],
    ['liquid', '150 mL', '20', 'mL'], // 10 % = 15, not less than 20
    ['liquid', '500 mL', '50', 'mL'], // 10 %
    ['antibiotic liquid', '20 mL', '1', 'mL'],
    ['solid', '30 mg', '30', 'mg'],
    ['solid', '80 mg', '50', 'mg'], // half = 40, not less than 50
    ['solid', '200 mg', '100', 'mg'],
    ['solid', '1 g', '150', 'mg'],
    ['solid', '10 g', '500', 'mg'],
    ['insoluble, cream or ointment', '5 g', '200', 'mg'],
  ] as const)('L19 sterility quantity per medium (Table 2): %s %s → %s %s', (product, content, q, unit) => {
    const r = ok(l19SamplingPlan({ mode: 'sterility quantity', product, content }));
    expect(r.value.toString()).toBe(q);
    expect(r.unit).toBe(unit);
  });

  it.each([
    ['10 mL', 1], ['20 mL', 1], ['5 mL', 3], ['3 mL', 5], ['2 mL', 5],
  ])('L19 extractable volume (Ph.Int 5.6): nominal %s → %s containers', (nominal, n) => {
    expect(ok(l19SamplingPlan({ mode: 'extractable volume', nominal })).value.toNumber()).toBe(n);
  });

  it.each([
    [{ mode: 'square root' as const, containers: '0' }, /whole number, 1 or more/],
    [{ mode: 'square root' as const, containers: '2.5' }, /whole number/],
    [{ mode: 'square root' as const, containers: '20 kg' }, /must be a count/],
    [{ mode: 'square root' as const, containers: '20', test: { compositesOf: 0 } }, /per composite/],
    [{ mode: 'sterility containers' as const, batchSize: '100', product: 'parenteral' as const } as never, /enough to inoculate both media/],
    [{ mode: 'sterility quantity' as const, product: 'liquid' as const, content: '5 g' }, /must be a volume/],
    [{ mode: 'sterility quantity' as const, product: 'insoluble, cream or ointment' as const, content: '100 mg' }, /cannot give 200 mg/],
    [{ mode: 'extractable volume' as const, nominal: '0 mL' }, /more than zero/],
  ])('L19 refuses %#', (i, msg) => {
    expect(refused(l19SamplingPlan(i as Parameters<typeof l19SamplingPlan>[0]))).toMatch(msg);
  });
});

// ================================================================ registry
describe('L5-L19 in the template registry', () => {
  it.each(['L5', 'L6', 'L7', 'L8', 'L10', 'L14', 'L17', 'L19'])('L-templates: %s is registered', (id) => {
    expect(TEMPLATES[id]).toBeTypeOf('function');
  });

  it('L6 is called through the registry like any template', () => {
    const r = callTemplate('L6', { mode: 'direct', sample: '0.3050 g', blank: '0.05 mL', titrant: { volume: '15.20 mL', molarity: '0.1 M', factor: '0.9985' }, equivalence: { mass: '20.17 mg', molarity: '0.1 M' } });
    expect(r.ok && r.value.toFixed(2)).toBe('100.04');
  });
});

// ================================================================ inputs added for the result blocks (build step 3)
describe('L5-L10: the inputs a result block passes', () => {
  // The example run, one vessel, as the dissolution step records it: per time point, per vessel set.
  const byTime = (sets: string[][][]) => base({ vessels: undefined, byTime: sets });

  it('L5 responses per time point give the same results as per vessel', () => {
    const r = ok(l5Dissolution(byTime([[['0.300']], [['0.450']], [['0.520']], []])));
    expect(r.vessels[0]!.results.map((x) => x.toFixed(1))).toEqual(['54.0', '81.6', '95.1']);
    // Two vessels, in the same order at every time point.
    const two = ok(l5Dissolution(byTime([[['0.300', '0.310']], [['0.450', '0.460']], [['0.520', '0.530']]])));
    expect(two.perVessel.length).toBe(2);
    expect(two.atTime[0]!.map((x) => d(x).toFixed(1))).toEqual(['54.0', '55.8']);
  });

  it('L5 per time point: refused for a time point the method does not have, a time point left empty, or unequal vessel sets', () => {
    expect(refused(l5Dissolution(byTime([[['0.300']], [['0.450']], [['0.520']], [['0.6']]])))).toMatch(/more time points than the method has \(3\)/);
    expect(refused(l5Dissolution(byTime([[['0.300']], [], [['0.520']]])))).toBe('Give the vessel responses at 20 min');
    expect(refused(l5Dissolution(byTime([[['0.300', '0.310']], [['0.450']], [['0.520', '0.530']]])))).toMatch(/every time point needs the same vessels/);
    expect(refused(l5Dissolution(base({ byTime: [[['0.3']]] })))).toMatch(/either per vessel or per time point/);
  });

  it('L5 the standard as prepared: 25.00 mg of 99.0 % in 50 mL, diluted 50 times = 0.0099 mg/mL', () => {
    // C = response ÷ 0.500 × 0.0099 × 50: the example's results × 0.99 (95.1 % → 94.149 %).
    const r = ok(l5Dissolution(base({ standard: { responses: ['0.500'], prepared: { mass: '25.00 mg', potency: '99.0 %', dilution: { volume: '50 mL', factor: '50' } } } })));
    expect(r.value.toFixed(3)).toBe('94.149');
    expect(r.shown).toContain('0.0099 mg/mL (standard 25.00 mg × 99.0 % ÷ 100 ÷ (50 mL × dilution factor 50)');
    expect(refused(l5Dissolution(base({ standard: { responses: ['0.500'], concentration: '0.01 mg/mL', prepared: { mass: '25.00 mg' } } })))).toMatch(/one of them/);
    // A prepared standard left out entirely is none.
    expect(ok(l5Dissolution(base({ standard: { responses: ['0.500'], concentration: '0.01 mg/mL', prepared: {} } }))).value.toFixed(1)).toBe('95.1');
  });

  it('L5 the sample dilution as the dilute step gives it (a factor in "units")', () => {
    expect(ok(l5Dissolution(base({ dilution: { value: '50.000', unit: 'units' } }))).value.toFixed(1)).toBe('95.1');
  });

  // Six vessels at one time point (30 min), C = the response: % = response × 900 ÷ 500 × 100 = response × 180.
  const six = (rs: string, more?: string) => base({
    vessels: undefined, stages: [{ name: 'medium', volume: '900 mL', times: [{ time: '30 min', aliquot: '10 mL' }] }],
    byTime: [[rs.split(' ').map((x) => x), ...(more ? [more.split(' ')] : [])]],
  });

  it('L5 with the acceptance: C6 on the vessels\' own results, set by set; Q is the lower limit as written', () => {
    // 0.500 × 180 = 90 % in every vessel ≥ Q + 5 = 85 %.
    const pass = ok(l5Dissolution({ ...six('0.500 0.500 0.500 0.500 0.500 0.500'), acceptance: { test: 'dissolution IR', limit: { low: '80', unit: '%' } } }));
    expect([pass.decision, pass.stageReached, pass.check?.pass]).toEqual(['pass', 1, true]);
    // One at 0.450 (81 %): test 6 more; with 6 more at 0.470 (84.6 %): mean of 12 = (2.95 + 2.82) × 180 ÷ 12 = 86.55 % ≥ 80 %: S2 passes.
    const next = ok(l5Dissolution({ ...six('0.500 0.500 0.500 0.500 0.500 0.450'), acceptance: { test: 'dissolution IR', limit: { low: '80', unit: '%' } } }));
    expect([next.decision, next.nextStageUnits, next.check?.pass]).toEqual(['next stage', 6, false]);
    const s2 = ok(l5Dissolution({ ...six('0.500 0.500 0.500 0.500 0.500 0.450', '0.470 0.470 0.470 0.470 0.470 0.470'), acceptance: { test: 'dissolution IR', limit: { low: '80', unit: '%' } } }));
    expect([s2.decision, s2.stageReached, s2.value.toFixed(2)]).toEqual(['pass', 2, '86.55']);
  });

  it('L5 the acceptance is refused without its test, without Q, with a limit not in %, or with ranges that do not match the time points', () => {
    const r = six('0.500 0.500 0.500 0.500 0.500 0.500');
    expect(refused(l5Dissolution({ ...r, acceptance: { limit: { low: '80', unit: '%' } } }))).toMatch(/not the acceptance test/);
    expect(refused(l5Dissolution({ ...r, acceptance: { test: 'dissolution IR', limit: { high: '80', unit: '%' } } }))).toMatch(/Q is the lower limit/);
    expect(refused(l5Dissolution({ ...r, acceptance: { test: 'dissolution IR', limit: { low: '8', unit: 'mg' } } }))).toMatch(/in % of label claim/);
    expect(refused(l5Dissolution({ ...r, acceptance: { test: 'dissolution ER', ranges: [] } }))).toMatch(/one range for each time point \(1\)/);
    // An acceptance left out entirely is none.
    expect(ok(l5Dissolution({ ...r, acceptance: { ranges: [] } })).check).toBeUndefined();
  });

  it('L5 acid stage (A1) by its upper limit, extended release (L1) by the ranges', () => {
    // 0.050 × 180 = 9 %: none above 10 %.
    expect(ok(l5Dissolution({ ...six('0.050 0.050 0.050 0.050 0.050 0.050'), acceptance: { test: 'dissolution DR acid', limit: { high: '10', unit: '%' } } })).decision).toBe('pass');
    // The example's three time points for 6 equal vessels: 54.0, 81.6, 95.1 %; ranges 45-65, 70-90, NLT 85.
    const v = ['0.300', '0.450', '0.520'].map((x) => [Array(6).fill(x) as string[]]);
    const er = ok(l5Dissolution({ ...byTime(v), acceptance: { test: 'dissolution ER', ranges: [{ low: '45', high: '65', unit: '%' }, { low: '70', high: '90', unit: '%' }, { low: '85', unit: '%' }] } }));
    expect([er.decision, er.check?.pass]).toEqual(['pass', true]);
  });

  it('L6 optional groups left out entirely (a VS in excess, an aliquot, a temperature correction, a basis) are none', () => {
    const direct = { mode: 'direct' as const, sample: '500.0 mg', titrant: { volume: '47.475 mL', molarity: '0.1 M', factor: '1.000' }, equivalence: { mass: '10.00 mg', molarity: '0.1 M' } };
    // 47.475 × 0.1 ÷ 0.1 × 10.00 = 474.75 mg ÷ 500.0 mg = 94.95 %.
    const r = ok(l6Titration({ ...direct, excess: {} as never, aliquot: {} as never, temperatureCorrection: {} as never, basis: {} as never }));
    expect(r.value.toFixed(2)).toBe('94.95');
    expect(refused(l6Titration({ ...direct, basis: { loss: '0.5 %' } as never }))).toMatch(/but no basis/);
  });

  it('L7 a drift left out entirely is none; L8 a constant-mass rule left out entirely is none', () => {
    const kf = ok(l7WaterKf({ mode: 'volumetric', sample: '200.0 mg', volume: '1.20 mL', factor: '5.012 mg/mL', drift: {} as never }));
    expect(kf.value.toFixed(4)).toBe('3.0072');
    const lod = ok(l8MassLoss({ mode: 'loss on drying', tare: '25.1234 g', before: '26.1240 g', after: ['26.1195 g'], constantMass: {} as never }));
    expect(lod.constantMass).toBeUndefined();
  });

  it('L10 specific rotation of a solution from the mass weighed and its flask: 2.000 g in 100.0 mL, 2 dm, +2.10° = +52.5°', () => {
    const rot = { mode: 'specific rotation' as const, angle: '2.10 °', pathLength: '2 dm', form: 'solution' as const };
    const r = ok(l10Reading({ ...rot, sample: { mass: '2.000 g', volume: '100.0 mL' } }));
    expect(r.value.toFixed(2)).toBe('52.50');
    expect(r.shown).toContain('g/100 mL (2.000 g in 100.0 mL)');
    expect(ok(l10Reading({ ...rot, concentration: '2.000 %w/v', sample: {} })).value.toFixed(2)).toBe('52.50');
    expect(refused(l10Reading({ ...rot, concentration: '2.000 %w/v', sample: { mass: '2.000 g', volume: '100.0 mL' } }))).toMatch(/one of them/);
    expect(refused(l10Reading({ ...rot, sample: { mass: '2.000 g' } }))).toMatch(/both the mass weighed and the volume/);
    expect(refused(l10Reading({ ...rot, form: 'neat liquid', density: '1.0', sample: { mass: '2.000 g', volume: '100.0 mL' } }))).toMatch(/not made up from a weighed amount/);
  });
});
