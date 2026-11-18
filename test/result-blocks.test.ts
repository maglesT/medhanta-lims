import { describe, expect, it } from 'vitest';
import { findBlock } from '../shared/blocks/index.js';
import { evaluate, type StepEvent, type Value } from '../shared/engine/index.js';
import { masterChecks } from '../shared/master/checks.js';
import { masterSchema, type MasterDoc } from '../shared/master/schema.js';
import { ev, unplaced } from './engine-fixture.js';

// The result blocks of the chemistry lab, run by the engine with worked examples in the style of real monographs
// (invented demo numbers; the arithmetic is in the comments). A method weighs and dilutes in steps before the result
// step, whose settings refer to them; the specification's values ({ spec }) are filled in before an analysis runs
// (applySpec), so here a filled-in spec value is written as the value itself.

type Settings = Record<string, unknown>;
const pct = (low: string, high: string) => ({ low, high, unit: '%' });
const q = (value: string, unit = '') => ({ value, unit });
const list = (text: string, unit = '') => text.split(' ').map((v) => q(v, unit));

/** Settings without the ones a test leaves out (written as undefined). */
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** A method of one stage of steps: [key, block, settings]. */
function method(steps: [string, string, Settings, object?][]): MasterDoc {
  return masterSchema.parse({
    header: { code: 'QC-M-900', name: 'Worked example', technique: 'Other', reference: 'Monograph-style example' },
    stages: [{ key: 'a', name: 'Analysis', kind: 'normal', role: 'Analyst',
      steps: steps.map(([key, id, settings, o]) => ({ key, block: { id, version: 1 }, checker: findBlock({ id, version: 1 })!.checker, settings: defined(settings), ...o })) }],
  });
}
const index = (doc: MasterDoc, key: string) => doc.stages[0]!.steps.findIndex((t) => t.key === key);
/** Records a step's values (with the engine's results) as a value event. */
function record(doc: MasterDoc, events: StepEvent[], key: string, values: Record<string, Value>): StepEvent[] {
  const step = index(doc, key);
  const results = evaluate(doc, events, { stage: 0, sub: 1, step, round: 1 }, values);
  return [...events, ev('value', `0.1.${step}.1`, { payload: { values, results } })];
}
/** The results of a step for these values, after the earlier steps' events. */
const results = (doc: MasterDoc, events: StepEvent[], key: string, values: Record<string, Value>) =>
  evaluate(doc, events, { stage: 0, sub: 1, step: index(doc, key), round: 1 }, defined(values) as Record<string, Value>);
const problems = (doc: MasterDoc) => unplaced(masterChecks(doc)).map((p) => `${p.path}: ${p.message}`);
const weigh = (what: string, unit = 'mg') => ({ what, unit });

// ------------------------------------------------------------------------------------------------ assay (HPLC)
// Tablets of 500 mg, average tablet weight 625.0 mg; external standard of 99.8 % (as is).
// Standard: 50.00 mg in 100 mL, 5 mL to 50 mL (factor 10): 50.00 × 99.8 % ÷ (100 × 10) = 0.0499 mg/mL.
// Sample powder in 100 mL, 5 mL to 50 mL (factor 10).
const ASSAY: Settings = {
  mode: 'external standard', response: 'peak area', responseUnit: '', stdMass: { ref: 'a/weigh-standard/mass' }, stdVolume: '100 mL',
  stdFactor: { ref: 'a/dilute-standard/factor' }, preparations: '2', sample1Mass: { ref: 'a/weigh-sample-1/mass' }, sample2Mass: { ref: 'a/weigh-sample-2/mass' },
  sampleVolume: '100 mL', sample1Factor: { ref: 'a/dilute-sample/factor' }, sample2Factor: { ref: 'a/dilute-sample/factor' },
  per: 'unit', averageWeight: '625.0 mg', labelClaim: { spec: 'labelClaim' }, limit: { spec: 'limit' }, agreementLimit: { high: '2.0', unit: '%' },
};
const DILUTE = { from: 'Stock solution', diluent: 'Mobile phase', aliquot1: '5.0 mL', volume1: '50.0 mL' };
function assayMethod(settings: Settings = ASSAY): MasterDoc {
  return method([
    ['weigh-standard', 'weigh', weigh('Reference standard')], ['dilute-standard', 'dilute', DILUTE],
    ['weigh-sample-1', 'weigh', weigh('Sample')], ['weigh-sample-2', 'weigh', weigh('Sample')], ['dilute-sample', 'dilute', DILUTE],
    ['assay', 'assay', settings],
  ]);
}
const balance = { itemId: 'b-1', code: 'BAL-01', name: 'Analytical balance', version: 1, type: 'Analytical balance', room: 'QC-1', area: 'QC laboratory' };
const done = { classA: 'yes', done: 'yes' };
function assayEvents(doc: MasterDoc): StepEvent[] {
  let e: StepEvent[] = [];
  e = record(doc, e, 'weigh-standard', { balance, mass: q('50.00', 'mg') });
  e = record(doc, e, 'dilute-standard', done);
  e = record(doc, e, 'weigh-sample-1', { balance, mass: q('62.50', 'mg') });
  e = record(doc, e, 'weigh-sample-2', { balance, mass: q('62.40', 'mg') });
  return record(doc, e, 'dilute-sample', done);
}
const ASSAY_VALUES: Record<string, Value> = {
  stdResponses: list('999000 1001000 1000000'), responses1: list('999000 1001000'), responses2: list('1002000 1004000'),
  stdPotency: q('99.8', '%'), stdBasis: 'as is',
};
/** The assay method with the specification's values filled in (as applySpec does before an analysis). */
const specFilled = (extra: Settings = {}) => assayMethod({ ...ASSAY, labelClaim: '500 mg', limit: pct('95.0', '105.0'), ...extra });

describe('assay by external standard (HPLC)', () => {
  it('a method with weigh and dilute steps and the assay step passes the method check; the spec values are not asked for', () => {
    expect(problems(assayMethod())).toEqual([]);
  });

  it('LIMS-15 the assay of two preparations through the engine: masses and dilution factors from the earlier steps, % of label claim, mean', () => {
    const doc = specFilled();
    const r = results(doc, assayEvents(doc), 'assay', ASSAY_VALUES);
    // Preparation 1: mean response 1000000 ÷ standard 1000000 × 0.0499 mg/mL = 0.0499 mg/mL × (100 mL × 10) = 49.9 mg;
    // ÷ 62.50 mg × 625.0 mg = 499.0 mg per tablet; ÷ 500 mg × 100 = 99.80 % of label claim.
    expect(r.prep1).toMatchObject({ ok: true, unit: '%' });
    expect(Number(r.prep1!.ok && r.prep1!.value)).toBeCloseTo(99.8, 10);
    expect(r.prep1!.ok && r.prep1!.shown).toContain('100 mL × dilution factor 10');
    expect(r.prep1!.ok && r.prep1!.shown).toContain('= 499 mg per unit');
    expect(r.prep1!.ok && r.prep1!.shown).toContain('÷ label claim 500 mg × 100 = 99.8 % of label claim');
    // Preparation 2: 1003000 ÷ 1000000 × 0.0499 = 0.0500497 mg/mL × 1000 mL = 50.0497 mg ÷ 62.40 mg × 625.0 mg
    // = 501.29908 mg per tablet = 100.25982 % of label claim.
    expect(Number(r.prep2!.ok && r.prep2!.value)).toBeCloseTo(100.25982, 4);
    // Mean (99.80 + 100.25982) ÷ 2 = 100.02991 % → 100.0 %; RSD = 0.45982 ÷ √2 ÷ 100.02991 × 100 = 0.33 %.
    expect(r.result).toMatchObject({ ok: true, unit: '%', check: { pass: true, rounded: '100.0 %' }, rsdCheck: { pass: true } });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(100.02991, 4);
    expect(r.result!.ok && r.result!.shown).toContain('RSD = 0.33 %');
    expect(r.preparationsCheck).toMatchObject({ ok: true, check: { pass: true } });
  });

  it('LIMS-17 a specification value not filled in: the % of label claim and the result wait (a method on its own)', () => {
    const doc = assayMethod();
    const r = results(doc, assayEvents(doc), 'assay', ASSAY_VALUES);
    // Without the label claim the preparations are worked out per tablet in mg; the mean waits for nothing but its
    // limit, which is the spec's: the result has no check yet.
    expect(r.prep1).toMatchObject({ ok: true, unit: 'mg' });
    expect(r.result).toMatchObject({ ok: true, unit: 'mg' });
    expect(r.result!.ok && r.result!.check).toBeUndefined();
    // An optional value the spec gives (the sample's LOD for the dried basis) is not there yet either: the preparation
    // says what it still needs, in plain words.
    const dried = assayMethod({ ...ASSAY, per: 'mass', labelClaim: undefined, averageWeight: undefined, basis: 'dried', sampleLod: { spec: 'lod' } });
    expect(results(dried, assayEvents(dried), 'assay', ASSAY_VALUES).prep1).toEqual({ ok: false, message: 'The result on the dried basis needs the sample\'s own loss on drying' });
  });

  it('LIMS-17 a preparation the method sets but without its responses: the result is flagged, not quietly worked from one', () => {
    const doc = specFilled();
    const r = results(doc, assayEvents(doc), 'assay', { ...ASSAY_VALUES, responses2: undefined } as never);
    expect(r.prep2).toBeUndefined();
    expect(r.preparationsCheck).toMatchObject({ ok: true, check: { pass: false } });
    expect(r.preparationsCheck!.ok && r.preparationsCheck!.shown).toBe('1 readings recorded; exactly 2 required: WRONG NUMBER');
  });

  it('LIMS-17 the agreement of the preparations has its own limit: preparations 2.5 % apart fail an RSD of NMT 1.0 %', () => {
    const doc = specFilled({ agreementLimit: { high: '1.0', unit: '%' } });
    // Preparation 2 at 1025000 → 102.4 % against 99.8 %: RSD 1.82 %.
    const r = results(doc, assayEvents(doc), 'assay', { ...ASSAY_VALUES, responses2: list('1025000') });
    expect(r.result).toMatchObject({ ok: true, check: { pass: true }, rsdCheck: { pass: false } });
  });

  it('LIMS-15 bracketing standards: the mean of the standards before and after', () => {
    // Before 1000000, after 1020000: mean 1010000. Preparation 1: 1000000 ÷ 1010000 × 0.0499 × 1000 ÷ 62.50 × 625.0
    // = 494.0594 mg = 98.81188 % of label claim.
    const doc = specFilled({ mode: 'bracketing' });
    const r = results(doc, assayEvents(doc), 'assay', { ...ASSAY_VALUES, stdResponsesAfter: list('1020000') });
    expect(Number(r.prep1!.ok && r.prep1!.value)).toBeCloseTo(98.81188, 4);
    // Bracketing without the standards after: refused in plain words (the step cannot be signed).
    const r2 = results(doc, assayEvents(doc), 'assay', ASSAY_VALUES);
    expect(r2.prep1).toEqual({ ok: false, message: 'Bracketing needs the standard readings after the samples as well as before' });
  });

  it('LIMS-15 per mass on the dried basis: the sample\'s own loss on drying, from an earlier step', () => {
    // A drug substance: 50.00 mg weighed as the sample, mean response 1000000 → 49.9 mg found ÷ 62.50 mg × 100 = 79.84 %
    // as is (the example's numbers); on the dried basis with LOD 0.50 %: 79.84 × 100 ÷ 99.50 = 80.2412 %.
    const doc = method([
      ['weigh-standard', 'weigh', weigh('Reference standard')], ['dilute-standard', 'dilute', DILUTE],
      ['weigh-sample-1', 'weigh', weigh('Sample')], ['weigh-sample-2', 'weigh', weigh('Sample')], ['dilute-sample', 'dilute', DILUTE],
      ['lod', 'check', { what: 'Loss on drying', unit: '%', limit: { high: '1.0', unit: '%' } }],
      ['assay', 'assay', { ...ASSAY, preparations: '1', sample2Mass: undefined, sample2Factor: undefined, per: 'mass', averageWeight: undefined, labelClaim: undefined,
        limit: pct('79.0', '81.0'), agreementLimit: undefined, basis: 'dried', sampleLod: { ref: 'a/lod/reading' } }],
    ]);
    expect(problems(doc)).toEqual([]);
    const e = record(doc, assayEvents(doc), 'lod', { reading: q('0.50', '%') });
    const r = results(doc, e, 'assay', ASSAY_VALUES);
    expect(Number(r.prep1!.ok && r.prep1!.value)).toBeCloseTo(80.24121, 4);
    expect(r.prep1!.ok && r.prep1!.shown).toContain('on the dried basis: 79.84 % × 100 ÷ (100 − 0.50 %)');
    expect(r.result).toMatchObject({ ok: true, check: { pass: true, rounded: '80.2 %' } });
  });

  it('safety rule S3: a standard dried before use with its dried potency is not corrected with its LOD again', () => {
    const doc = specFilled();
    const r = results(doc, assayEvents(doc), 'assay', { ...ASSAY_VALUES, stdBasis: 'dried', stdDried: 'yes', stdLod: q('0.4', '%') });
    expect(r.prep1).toMatchObject({ ok: false, message: expect.stringMatching(/^Basis applied twice \(safety rule S3\)/) });
    // Dried before use and no LOD: its dried potency is used directly.
    expect(results(doc, assayEvents(doc), 'assay', { ...ASSAY_VALUES, stdBasis: 'dried', stdDried: 'yes' }).prep1).toMatchObject({ ok: true });
    // Dried potency, used as it is, without its LOD: refused.
    expect(results(doc, assayEvents(doc), 'assay', { ...ASSAY_VALUES, stdBasis: 'dried' }).prep1).toMatchObject({ ok: false, message: expect.stringMatching(/give its loss on drying/) });
  });

  it('LIMS-01 a limit in another kind than the result is refused by the method check (mg on a % of label claim)', () => {
    const doc = assayMethod({ ...ASSAY, limit: { low: '475', high: '525', unit: 'mg' } });
    expect(problems(doc)).toEqual([expect.stringMatching(/settings\.limit: Limits of the result: mg is a mass, but the value checked is a percentage/)]);
    // Without a label claim the result per unit is in mg: then a limit in mg is right.
    expect(problems(assayMethod({ ...ASSAY, labelClaim: undefined, limit: { low: '475', high: '525', unit: 'mg' } }))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ assay by specific absorbance
// Tablets of 500 mg, average weight 600.0 mg; A(1 %, 1 cm) = 715 at 257 nm; powder in 200 mL, then diluted 20 times; 1 cm cell.
const UV: Settings = {
  specificAbsorbance: '715', form: 'A(1 %, 1 cm)', pathLength: '1 cm', preparations: '1', sample1Mass: { ref: 'a/weigh-sample-1/mass' }, sampleVolume: '200 mL',
  sample1Factor: '20', per: 'unit', averageWeight: '600.0 mg', labelClaim: '500 mg', limit: pct('95.0', '105.0'),
};
function uvMethod(settings: Settings = UV) {
  const doc = method([['weigh-sample-1', 'weigh', weigh('Sample')], ['uv', 'assay-absorbance', settings]]);
  return { doc, events: record(doc, [], 'weigh-sample-1', { balance, mass: q('60.0', 'mg') }) };
}
const spectro = { itemId: 's-1', code: 'UV-01', name: 'UV-Vis spectrophotometer', version: 1, type: 'UV-Vis spectrophotometer', room: 'QC-2', area: 'QC laboratory' };

describe('assay by specific absorbance (UV)', () => {
  it('LIMS-15 A ÷ (A(1 %, 1 cm) × b) gives g per 100 mL; per tablet and % of label claim', () => {
    const { doc, events } = uvMethod();
    expect(problems(doc)).toEqual([]);
    // Mean A = (0.892 + 0.894) ÷ 2 = 0.893; 0.893 ÷ (715 × 1 cm) = 0.00124895 g/100 mL = 0.0124895 mg/mL;
    // × 200 mL × 20 = 49.958 mg in 60.0 mg of powder; × 600.0 mg ÷ 60.0 mg = 499.58 mg = 99.916 % of label claim.
    const r = results(doc, events, 'uv', { spectrophotometer: spectro, responses1: list('0.892 0.894', 'AU') });
    expect(Number(r.prep1!.ok && r.prep1!.value)).toBeCloseTo(99.91608, 4);
    expect(r.result).toMatchObject({ ok: true, check: { pass: true, rounded: '99.9 %' } });
  });

  it('safety rule S1: the same figure read as an absorptivity gives a result 10 times lower, which fails the limit', () => {
    const { doc, events } = uvMethod({ ...UV, form: 'absorptivity' });
    const r = results(doc, events, 'uv', { spectrophotometer: spectro, responses1: list('0.892 0.894', 'AU') });
    expect(Number(r.prep1!.ok && r.prep1!.value)).toBeCloseTo(9.991608, 5);
    expect(r.result).toMatchObject({ ok: true, check: { pass: false } });
    // The form is a required setting with a fixed list; the method check says so when it is missing.
    expect(problems(uvMethod({ ...UV, form: undefined }).doc)).toContain('stages[0].steps[1].settings.form: The figure is (safety rule S1) is not set');
  });
});

// ------------------------------------------------------------------------------------------------ impurities
const IMP: Settings = {
  mode: 'area normalisation', areaUnit: '', imp1Name: 'Impurity A', imp1Low: '0.80', imp1High: '0.90', imp1Limit: { high: '0.2', unit: '%' },
  unknownLimit: { high: '0.10', unit: '%' }, disregardLimit: '0.05', exclude1Low: '1.80', exclude1High: '1.90', exclude1Reason: 'Blank peak', limit: { high: '1.0', unit: '%' },
};
const impMethod = (settings: Settings = IMP) => method([['related', 'impurities', settings]]);
// Principal peak 1000000; RRT 0.85 (impurity A) 1500; RRT 1.20 800; RRT 1.50 300; RRT 1.85 2000 (a blank peak).
const PEAKS = { principalArea: q('1000000'), rrts: list('0.85 1.20 1.50 1.85'), areas: list('1500 800 300 2000') };

describe('related substances (impurities)', () => {
  it('LIMS-15 area normalisation: blank peak left out, a peak at or below the disregard limit left out, impurity A by its RRT window', () => {
    expect(problems(impMethod())).toEqual([]);
    // Without the blank peak the total is 1002600; RRT 1.50: 300 ÷ 1002600 × 100 = 0.03 % ≤ 0.05 %: disregarded.
    // Total 1002300: impurity A 1500 ÷ 1002300 × 100 = 0.14966 %; unknown at RRT 1.20 800 ÷ 1002300 × 100 = 0.07982 %;
    // total of impurities 0.22948 % → 0.2 % against NMT 1.0 %.
    const r = results(impMethod(), [], 'related', PEAKS);
    expect(r.result).toMatchObject({ ok: true, unit: '%', check: { pass: true }, limitsCheck: { pass: true } });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(0.229472, 5);
    const shown = r.result!.ok ? r.result!.shown : '';
    expect(shown).toContain('Impurity A: 1500 ÷ total 1002300 × 100 = 0.15 %');
    expect(shown).toContain('unknown at RRT 1.20: 800 ÷ total 1002300 × 100 = 0.08 %');
    expect(shown).toContain('excluded: peak at RRT 1.85 (Blank peak)');
  });

  it('LIMS-17 each impurity against its own limit: an unknown of 0.12 % fails NMT 0.10 % though the total is within', () => {
    // RRT 1.20 at 1200: 1200 ÷ 1002700 × 100 = 0.11968 % → 0.12 % > 0.10 %.
    const r = results(impMethod(), [], 'related', { ...PEAKS, areas: list('1500 1200 300 2000') });
    expect(r.result).toMatchObject({ ok: true, check: { pass: true }, limitsCheck: { pass: false }, allPass: false });
    expect(r.result!.ok && (r.result!.limitsCheck as { shown: string }).shown).toMatch(/unknown at RRT 1\.20: .*OUT OF LIMITS/);
  });

  it('safety rule S4: a relative response factor divides the area; a factor without its kind is refused', () => {
    // RRF 0.75: 1500 ÷ 0.75 = 2000; total 1000000 + 2000 + 800 = 1002800; A = 2000 ÷ 1002800 × 100 = 0.19944 % → 0.2 %: within NMT 0.2 %.
    const rrf = results(impMethod({ ...IMP, imp1Factor: '0.75', imp1FactorKind: 'relative response factor' }), [], 'related', PEAKS);
    expect(rrf.result!.ok && rrf.result!.shown).toContain('Impurity A: 1500 ÷ relative response factor 0.75 ÷ total 1002800 × 100 = 0.20 %');
    // As a correction factor the same 0.75 multiplies: 1125.
    const cf = results(impMethod({ ...IMP, imp1Factor: '0.75', imp1FactorKind: 'correction factor' }), [], 'related', PEAKS);
    expect(cf.result!.ok && cf.result!.shown).toContain('1500 × correction factor 0.75');
    const none = results(impMethod({ ...IMP, imp1Factor: '0.75' }), [], 'related', PEAKS);
    expect(none.result).toMatchObject({ ok: false, message: expect.stringMatching(/safety rule S4/) });
  });

  it('LIMS-15 against a diluted reference solution (0.5 % of the test solution)', () => {
    // Reference mean (5000 + 5100) ÷ 2 = 5050; impurity A 1500 ÷ 5050 × 0.5 % = 0.14851 %; RRT 1.20 800 ÷ 5050 × 0.5 =
    // 0.07921 %; RRT 1.50 300 ÷ 5050 × 0.5 = 0.0297 %: disregarded. Total 0.22772 %.
    const doc = impMethod({ ...IMP, mode: 'external standard', referencePercent: '0.5 %' });
    const r = results(doc, [], 'related', { rrts: PEAKS.rrts, areas: PEAKS.areas, referenceResponses: list('5000 5100') });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(0.227723, 5);
    // The reference responses not recorded: refused, so the step cannot be signed without them.
    expect(results(doc, [], 'related', { rrts: PEAKS.rrts, areas: PEAKS.areas }).result).toMatchObject({ ok: false, message: expect.stringMatching(/needs a reference solution/) });
  });

  it('the peak table: one RRT for each area', () => {
    const r = results(impMethod(), [], 'related', { ...PEAKS, rrts: list('0.85 1.20 1.50') });
    expect(r.result).toEqual({ ok: false, message: 'The peak table has 3 relative retention times and 4 areas: give one RRT for each area, in the same order' });
  });
});

// ------------------------------------------------------------------------------------------------ dissolution
// Tablets of 10 mg; 900 mL; UV against a standard of 0.0100 mg/mL reading 0.500 AU. One time point, aliquots replaced
// without correction: % dissolved = A ÷ 0.500 × 0.0100 mg/mL × 900 mL ÷ 10 mg × 100 = A × 180.
const DISS: Settings = {
  medium: '0.1 M hydrochloric acid', volume: '900 mL', volumeMode: 'replace, no correction', aliquot: '10 mL', time1: '30 min', responseUnit: 'AU',
  standardConcentration: '0.0100 mg/mL', labelClaim: { spec: 'labelClaim' }, acceptance: 'dissolution IR', limit: { spec: 'limit' },
  temperatureLimit: { low: '36.5', high: '37.5', unit: '°C' },
};
const dissMethod = (settings: Settings = DISS) => method([['dissolution', 'dissolution', settings]]);
const filledDiss = (extra: Settings = {}) => dissMethod({ ...DISS, labelClaim: '10 mg', limit: { low: '80', unit: '%' }, ...extra });
const apparatus = { itemId: 'd-1', code: 'DT-01', name: 'Dissolution apparatus', version: 1, type: 'Dissolution tester', room: 'QC-2', area: 'QC laboratory' };
const DISS_VALUES: Record<string, Value> = {
  apparatus, mediumTemperature: q('37.0', '°C'), standardResponses: list('0.500', 'AU'), time1Stage1: list('0.500 0.510 0.495 0.505 0.490 0.515', 'AU'),
};

describe('dissolution', () => {
  it('LIMS-15 immediate release S1: % dissolved per vessel, the mean as the result, every unit at least Q + 5', () => {
    expect(problems(dissMethod())).toEqual([]);
    // 90.0, 91.8, 89.1, 90.9, 88.2, 92.7 %: mean 3.015 × 180 ÷ 6 = 90.45 %; all ≥ 85 %: S1 passes.
    const r = results(filledDiss(), [], 'dissolution', DISS_VALUES);
    expect(r.result).toMatchObject({ ok: true, unit: '%', decision: 'pass', stageReached: 1, check: { pass: true } });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(90.45, 10);
    expect(r.result!.ok && r.result!.shown).toContain('S1: all 6 units ≥ Q + 5 = 85 %: PASS');
    expect(r.temperatureCheck).toMatchObject({ ok: true, check: { pass: true } });
  });

  it('LIMS-17 the label claim and Q from the specification not filled in: the result waits', () => {
    expect(results(dissMethod(), [], 'dissolution', DISS_VALUES).result).toBeUndefined();
  });

  it('LIMS-17 S1 not met: test 6 more units; with them S2 passes (mean of 12 ≥ Q, none below Q − 15)', () => {
    // A vessel at 0.460 AU = 82.8 % → 83 % < 85 %: the next stage.
    const s1 = { ...DISS_VALUES, time1Stage1: list('0.500 0.510 0.495 0.505 0.490 0.460', 'AU') };
    const r1 = results(filledDiss(), [], 'dissolution', s1);
    expect(r1.result).toMatchObject({ ok: true, decision: 'next stage', nextStageUnits: 6, check: { pass: false } });
    // 6 more at 0.480 AU = 86.4 %: mean of 12 = (2.96 + 2.88) × 180 ÷ 12 = 87.6 % ≥ 80 %.
    const r2 = results(filledDiss(), [], 'dissolution', { ...s1, time1Stage2: list('0.480 0.480 0.480 0.480 0.480 0.480', 'AU') });
    expect(r2.result).toMatchObject({ ok: true, decision: 'pass', stageReached: 2, check: { pass: true } });
    expect(Number(r2.result!.ok && r2.result!.value)).toBeCloseTo(87.6, 10);
  });

  it('LIMS-15 pharmacopoeia rounding at Q: 84.6 % rounds to 85 % (Q written without decimals) and meets Q + 5', () => {
    // 0.470 AU × 180 = 84.6 % → 85 %.
    const r = results(filledDiss(), [], 'dissolution', { ...DISS_VALUES, time1Stage1: list('0.470 0.500 0.500 0.500 0.500 0.500', 'AU') });
    expect(r.result).toMatchObject({ ok: true, decision: 'pass' });
    // 0.469 AU = 84.42 % → 84 %: not.
    const r2 = results(filledDiss(), [], 'dissolution', { ...DISS_VALUES, time1Stage1: list('0.469 0.500 0.500 0.500 0.500 0.500', 'AU') });
    expect(r2.result).toMatchObject({ ok: true, decision: 'next stage' });
  });

  it('LIMS-15 two time points without replacement, extended release ranges L1 (the amount in earlier aliquots is added)', () => {
    // 1 h: 0.250 AU → 0.0050 mg/mL × 900 mL = 4.5 mg = 45 %. 2 h: 890 mL left; 0.450 AU → 0.0090 × 890 + 0.0050 × 10 mL
    // = 8.06 mg = 80.6 %. Ranges 35-55 % at 1 h, NLT 75 % at 2 h: every unit inside (L1).
    const doc = filledDiss({ volumeMode: 'no replacement', time1: '1 h', time2: '2 h', acceptance: 'dissolution ER', limit: undefined,
      range1: pct('35', '55'), range2: { low: '75', unit: '%' } });
    const r = results(doc, [], 'dissolution', { ...DISS_VALUES, time1Stage1: list('0.250 0.250 0.250 0.250 0.250 0.250', 'AU'), time2Stage1: list('0.450 0.450 0.450 0.450 0.450 0.450', 'AU') });
    expect(r.result).toMatchObject({ ok: true, decision: 'pass', check: { pass: true } });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(80.6, 10);
    // A time point the method sets left without its responses: refused (the step cannot be signed).
    const r2 = results(doc, [], 'dissolution', { ...DISS_VALUES, time1Stage1: list('0.250 0.250 0.250 0.250 0.250 0.250', 'AU') });
    expect(r2.result).toEqual({ ok: false, message: 'Give the vessel responses at 2 h' });
  });

  it('delayed release: the acid stage as its own step (A1: no unit above 10 %), Tier 2 as another step with its own name', () => {
    // 0.040 AU × 180 = 7.2 %: none above 10 %.
    const acid = filledDiss({ acceptance: 'dissolution DR acid', limit: { high: '10', unit: '%' }, time1: '2 h', tier: 'Acid stage' });
    const r = results(acid, [], 'dissolution', { ...DISS_VALUES, time1Stage1: list('0.040 0.040 0.040 0.040 0.040 0.040', 'AU') });
    expect(r.result).toMatchObject({ ok: true, decision: 'pass', check: { pass: true } });
    expect(r.result!.ok && r.result!.shown).toMatch(/^Acid stage: 6 vessels/);
    expect(r.result!.ok && r.result!.shown).toContain('A1: no unit above 10 % dissolved in acid: PASS');
  });

  it('LIMS-15 the standard as weighed: its concentration from mass, potency and dilution', () => {
    // 25.00 mg of 99.0 % standard in 50 mL, diluted 50 times: 25.00 × 0.990 ÷ (50 × 50) = 0.0099 mg/mL.
    // Vessel 0.500 AU against 0.500 AU: 0.0099 × 900 ÷ 10 × 100 = 89.1 %.
    const doc = filledDiss({ standardConcentration: undefined, stdMass: '25.00 mg', stdVolume: '50 mL', stdFactor: '50' });
    const r = results(doc, [], 'dissolution', { ...DISS_VALUES, stdPotency: q('99.0', '%'), time1Stage1: list('0.500 0.500 0.500 0.500 0.500 0.500', 'AU') });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(89.1, 10);
  });
});

// ------------------------------------------------------------------------------------------------ titration
// Ascorbic acid: titrate with 0.05 M iodine; each mL of 0.05 M iodine is equivalent to 8.806 mg of ascorbic acid.
const TIT: Settings = {
  mode: 'direct', titrant: '0.05 M iodine', titrantMolarity: '0.05 M', equivalence: '8.806 mg', equivalenceMolarity: '0.05 M', preparations: '2',
  sample1Mass: { ref: 'a/weigh-sample-1/mass' }, sample2Mass: { ref: 'a/weigh-sample-2/mass' }, limit: pct('99.0', '101.0'),
};
function titMethod(settings: Settings = TIT, masses = ['150.0', '151.2']) {
  const doc = method([['weigh-sample-1', 'weigh', weigh('Sample')], ['weigh-sample-2', 'weigh', weigh('Sample')], ['titration', 'titration', settings]]);
  let e = record(doc, [], 'weigh-sample-1', { balance, mass: q(masses[0]!, 'mg') });
  e = record(doc, e, 'weigh-sample-2', { balance, mass: q(masses[1]!, 'mg') });
  return { doc, events: e };
}

describe('titration', () => {
  it('LIMS-15 a direct titration of two preparations: titre × molarity × factor ÷ the equivalence molarity × E, the mean', () => {
    const { doc, events } = titMethod();
    expect(problems(doc)).toEqual([]);
    // 1: 16.95 mL × 0.05 × 1.002 ÷ 0.05 × 8.806 mg = 149.56022 mg ÷ 150.0 mg × 100 = 99.70681 %.
    // 2: 17.10 mL × 1.002 × 8.806 = 150.88377 mg ÷ 151.2 mg × 100 = 99.79085 %. Mean 99.74883 % → 99.7 %.
    const r = results(doc, events, 'titration', { vsFactor: '1.002', titre1: q('16.95', 'mL'), titre2: q('17.10', 'mL') });
    expect(Number(r.prep1!.ok && r.prep1!.value)).toBeCloseTo(99.706814, 5);
    expect(Number(r.prep2!.ok && r.prep2!.value)).toBeCloseTo(99.790854, 5);
    expect(r.result).toMatchObject({ ok: true, check: { pass: true, rounded: '99.7 %' } });
  });

  it('LIMS-15 rounding at the limit: 94.95 % meets NLT 95.0 %, 94.94 % does not', () => {
    // E 10.00 mg per mL of 0.1 M; 500.0 mg; 47.475 mL × 0.1 × 1.000 ÷ 0.1 × 10.00 = 474.75 mg = 94.95 % → 95.0 %.
    const s = { ...TIT, titrantMolarity: '0.1 M', equivalence: '10.00 mg', equivalenceMolarity: '0.1 M', preparations: '1', sample2Mass: undefined, limit: pct('95.0', '105.0') };
    const { doc, events } = titMethod(s, ['500.0', '500.0']);
    expect(results(doc, events, 'titration', { vsFactor: '1.000', titre1: q('47.475', 'mL') }).result).toMatchObject({ ok: true, check: { pass: true, rounded: '95.0 %' } });
    expect(results(doc, events, 'titration', { vsFactor: '1.000', titre1: q('47.47', 'mL') }).result).toMatchObject({ ok: true, check: { pass: false, rounded: '94.9 %' } });
  });

  it('LIMS-15 a back titration with a blank: (blank − titre) × the titrant\'s molarity and factor; the excess VS cancels', () => {
    // Acetylsalicylic acid style: 50.0 mL of 0.5 M sodium hydroxide added; the excess titrated with 0.5 M hydrochloric
    // acid (factor 0.998); blank 49.80 mL, sample 33.20 mL; each mL of 0.5 M sodium hydroxide ≡ 45.04 mg.
    // (49.80 − 33.20) × 0.5 × 0.998 = 8.2834 mmol; ÷ 0.5 × 45.04 = 746.16867 mg ÷ 750.0 mg × 100 = 99.48916 %.
    const s = { ...TIT, mode: 'back', titrant: '0.5 M hydrochloric acid', titrantMolarity: '0.5 M', equivalence: '45.04 mg', equivalenceMolarity: '0.5 M',
      equivalenceOf: 'excess', preparations: '1', sample2Mass: undefined, limit: pct('99.0', '101.0') };
    const { doc, events } = titMethod(s, ['750.0', '750.0']);
    expect(problems(doc)).toEqual([]);
    const r = results(doc, events, 'titration', { vsFactor: '0.998', titre1: q('33.20', 'mL'), blank: q('49.80', 'mL') });
    expect(Number(r.prep1!.ok && r.prep1!.value)).toBeCloseTo(99.489156, 5);
    expect(r.result).toMatchObject({ ok: true, check: { pass: true } });
    // Without a blank, the excess VS must be given with its own factor (safety rule S5).
    const r2 = results(doc, events, 'titration', { vsFactor: '0.998', titre1: q('33.20', 'mL') });
    expect(r2.prep1).toMatchObject({ ok: false, message: expect.stringMatching(/safety rule S5/) });
  });

  it('safety rule S5: a molarity typed as the VS factor is refused', () => {
    const { doc, events } = titMethod();
    const r = results(doc, events, 'titration', { vsFactor: '0.05', titre1: q('16.95', 'mL'), titre2: q('17.10', 'mL') });
    expect(r.prep1).toMatchObject({ ok: false, message: expect.stringMatching(/^The titrant factor 0\.05 is not near 1/) });
  });
});

// ------------------------------------------------------------------------------------------------ water by Karl Fischer
describe('water by Karl Fischer', () => {
  const kf = { itemId: 'k-1', code: 'KF-01', name: 'Karl Fischer titrator', version: 1, type: 'Karl Fischer titrator', room: 'QC-2', area: 'QC laboratory' };
  const KF: Settings = { mode: 'volumetric', readingUnit: 'mL', waterEquivalent: { ref: 'a/standardise/reading' }, preparations: '2',
    sample1Mass: { ref: 'a/weigh-sample-1/mass' }, sample2Mass: { ref: 'a/weigh-sample-2/mass' }, limit: { high: '3.5', unit: '%' } };
  function kfMethod(settings: Settings = KF) {
    const doc = method([['standardise', 'check', { what: 'Water equivalent F', unit: 'mg/mL', limit: { low: '4.5', high: '5.5', unit: 'mg/mL' } }],
      ['weigh-sample-1', 'weigh', weigh('Sample')], ['weigh-sample-2', 'weigh', weigh('Sample')], ['kf', 'water-kf', settings]]);
    let e = record(doc, [], 'standardise', { reading: q('5.012', 'mg/mL') });
    e = record(doc, e, 'weigh-sample-1', { balance, mass: q('200.0', 'mg') });
    e = record(doc, e, 'weigh-sample-2', { balance, mass: q('210.0', 'mg') });
    return { doc, events: e };
  }

  it('LIMS-15 volumetric: (titre − blank) × F from the standardisation step ÷ the sample, the mean of two', () => {
    const { doc, events } = kfMethod();
    expect(problems(doc)).toEqual([]);
    // 1: (1.25 − 0.05) mL × 5.012 mg/mL = 6.0144 mg ÷ 200.0 mg × 100 = 3.0072 %.
    // 2: (1.32 − 0.05) × 5.012 = 6.36524 mg ÷ 210.0 mg × 100 = 3.031067 %. Mean 3.019133 % → 3.0 %.
    const r = results(doc, events, 'kf', { titrator: kf, reading1: q('1.25', 'mL'), reading2: q('1.32', 'mL'), blank: q('0.05', 'mL') });
    expect(Number(r.prep1!.ok && r.prep1!.value)).toBeCloseTo(3.0072, 10);
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(3.0191333, 6);
    expect(r.result).toMatchObject({ ok: true, check: { pass: true, rounded: '3.0 %' } });
  });

  it('LIMS-15 coulometric: the water found less the blank', () => {
    const { doc, events } = kfMethod({ ...KF, mode: 'coulometric', readingUnit: 'µg', waterEquivalent: undefined, preparations: '1', sample2Mass: undefined });
    // (1250 − 10) µg = 1.240 mg ÷ 200.0 mg × 100 = 0.62 %.
    const r = results(doc, events, 'kf', { titrator: kf, reading1: q('1250', 'µg'), blank: q('10', 'µg') });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(0.62, 10);
  });
});

// ------------------------------------------------------------------------------------------------ loss on drying
describe('loss on drying, residue on ignition', () => {
  it('LIMS-15 loss on drying weighed here: (before − after) ÷ (before − tare) × 100, and constant mass', () => {
    const doc = method([['lod', 'loss-on-drying', { mode: 'loss on drying', maxChange: '0.5 mg', limit: { high: '0.5', unit: '%' } }]]);
    expect(problems(doc)).toEqual([]);
    // (26.1240 − 26.1195) ÷ (26.1240 − 25.1234) × 100 = 0.0045 ÷ 1.0006 × 100 = 0.449730 %, rounded to the limit's decimals: 0.4 % (NMT 0.5 %).
    const r = results(doc, [], 'lod', { balance, tare: q('25.1234', 'g'), before: q('26.1240', 'g'), after1: q('26.1198', 'g'), after2: q('26.1195', 'g') });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(0.4497302, 6);
    expect(r.result).toMatchObject({ ok: true, check: { pass: true, rounded: '0.4 %' } });
    // Still changing by 0.8 mg: not yet at constant mass.
    const r2 = results(doc, [], 'lod', { balance, tare: q('25.1234', 'g'), before: q('26.1240', 'g'), after1: q('26.1203', 'g'), after2: q('26.1195', 'g') });
    expect(r2.result).toMatchObject({ ok: false, message: expect.stringMatching(/^Not yet at constant mass/) });
  });

  it('LIMS-15 sulfated ash after the dry-to-constant-mass step: its last weighing is the mass after', () => {
    const doc = method([
      ['ignite', 'dry-constant', { conditions: '600 °C', maxChange: '0.0005 g' }, { flow: { kind: 'repeat-until', maxRounds: 5 } }],
      ['ash', 'loss-on-drying', { mode: 'sulfated ash', dried: { ref: 'a/ignite/weight' }, limit: { high: '0.1', unit: '%' } }],
    ]);
    expect(problems(doc)).toEqual([]);
    const furnace = { itemId: 'f-1', code: 'MF-01', name: 'Muffle furnace', version: 1, type: 'Muffle furnace', room: 'QC-3', area: 'QC laboratory' };
    const e = [ev('value', '0.1.0.1', { payload: { values: { machine: furnace, weight: q('20.0010', 'g') } } }), ev('value', '0.1.0.2', { payload: { values: { machine: furnace, weight: q('20.0008', 'g') } } })];
    // (20.0008 − 20.0000) ÷ (21.0000 − 20.0000) × 100 = 0.08 %.
    const r = results(doc, e, 'ash', { balance, tare: q('20.0000', 'g'), before: q('21.0000', 'g') });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(0.08, 10);
    expect(r.result).toMatchObject({ ok: true, check: { pass: true } });
  });

  it('no mass after: refused in plain words', () => {
    const doc = method([['lod', 'loss-on-drying', { mode: 'loss on drying' }]]);
    expect(results(doc, [], 'lod', { balance, tare: q('25.1234', 'g'), before: q('26.1240', 'g') }).result).toEqual({ ok: false, message: 'Give the mass after drying or ignition' });
  });
});

// ------------------------------------------------------------------------------------------------ optical rotation, pH, relative density
describe('specific optical rotation, pH, relative density', () => {
  const polarimeter = { itemId: 'p-1', code: 'POL-01', name: 'Polarimeter', version: 1, type: 'Polarimeter', room: 'QC-2', area: 'QC laboratory' };
  const ROT: Settings = { form: 'solution', pathLength: '2 dm', sampleMass: { ref: 'a/weigh-sample-1/mass' }, volume: '100.0 mL',
    temperatureLimit: { low: '19.5', high: '20.5', unit: '°C' }, limit: { low: '52.0', high: '53.0', unit: '°' } };
  function rotMethod(settings: Settings = ROT) {
    const doc = method([['weigh-sample-1', 'weigh', weigh('Sample', 'g')], ['rotation', 'optical-rotation', settings]]);
    return { doc, events: record(doc, [], 'weigh-sample-1', { balance, mass: q('2.000', 'g') }) };
  }

  it('LIMS-15 specific rotation of a solution from the weighed mass: 100 × α ÷ (l × c)', () => {
    const { doc, events } = rotMethod();
    expect(problems(doc)).toEqual([]);
    // c = 2.000 g ÷ 100.0 mL × 100 = 2.000 g/100 mL; [α] = 100 × 2.10° ÷ (2 dm × 2.000) = 52.5°.
    const r = results(doc, events, 'rotation', { polarimeter, angle: q('2.10', '°'), temperature: q('20.0', '°C') });
    expect(r.result).toMatchObject({ ok: true, unit: '°', check: { pass: true } });
    expect(Number(r.result!.ok && r.result!.value)).toBeCloseTo(52.5, 10);
    expect(r.temperatureCheck).toMatchObject({ ok: true, check: { pass: true } });
  });

  it('safety rule S12: the path length in mm is converted; a tube outside 0.1-5 dm is refused', () => {
    const mm = rotMethod({ ...ROT, pathLength: '200 mm' });
    expect(results(mm.doc, mm.events, 'rotation', { polarimeter, angle: q('2.10', '°'), temperature: q('20.0', '°C') }).result).toMatchObject({ ok: true, value: '52.5' });
    const dm = rotMethod({ ...ROT, pathLength: '200 dm' });
    expect(results(dm.doc, dm.events, 'rotation', { polarimeter, angle: q('2.10', '°'), temperature: q('20.0', '°C') }).result)
      .toMatchObject({ ok: false, message: expect.stringMatching(/safety rule S12/) });
  });

  it('LIMS-17 pH: the reading against its limits; refused when the meter was calibrated more than 2 °C away', () => {
    const doc = method([['ph', 'ph', { readingUnit: '', limit: { low: '5.0', high: '7.0', unit: '' } }]]);
    expect(problems(doc)).toEqual([]);
    const meter = { itemId: 'ph-1', code: 'PH-01', name: 'pH meter', version: 1, type: 'pH meter', room: 'QC-2', area: 'QC laboratory' };
    const r = results(doc, [], 'ph', { meter, reading: q('6.52'), temperature: q('25.0', '°C'), calibrationTemperature: q('24.0', '°C') });
    expect(r.result).toMatchObject({ ok: true, check: { pass: true }, shown: 'pH 6.52 at 25.0 °C' });
    // 7.04 rounds to 7.0 (the limit's decimals): within; 7.05 rounds to 7.1: out.
    expect(results(doc, [], 'ph', { meter, reading: q('7.04'), temperature: q('25.0', '°C'), calibrationTemperature: q('25.0', '°C') }).result).toMatchObject({ check: { pass: true } });
    expect(results(doc, [], 'ph', { meter, reading: q('7.05'), temperature: q('25.0', '°C'), calibrationTemperature: q('25.0', '°C') }).result).toMatchObject({ check: { pass: false } });
    expect(results(doc, [], 'ph', { meter, reading: q('6.52'), temperature: q('25.0', '°C'), calibrationTemperature: q('20.0', '°C') }).result)
      .toMatchObject({ ok: false, message: expect.stringMatching(/more than 2 °C from the calibration/) });
  });

  it('LIMS-15 relative density by pycnometer, and the weight per mL with the density of water', () => {
    const doc = method([['density', 'relative-density', { mode: 'relative density', temperatureLimit: { low: '19.5', high: '20.5', unit: '°C' }, limit: { low: '1.005', high: '1.015', unit: '' } }]]);
    expect(problems(doc)).toEqual([]);
    // (45.2500 − 20.0000) ÷ (45.0000 − 20.0000) = 25.25 ÷ 25.00 = 1.0100.
    const v = { balance, empty: q('20.0000', 'g'), withWater: q('45.0000', 'g'), withSample: q('45.2500', 'g'), temperature: q('20.0', '°C') };
    const r = results(doc, [], 'density', v);
    expect(r.result).toMatchObject({ ok: true, value: '1.01', check: { pass: true } });
    // Weight per mL: 1.0100 × 0.99820 g/mL = 1.008182 g/mL.
    const w = method([['density', 'relative-density', { mode: 'weight per mL', waterDensity: '0.99820 g/mL', limit: { low: '1.000', high: '1.020', unit: 'g/mL' } }]]);
    expect(results(w, [], 'density', v).result).toMatchObject({ ok: true, value: '1.008182', unit: 'g/mL' });
  });
});
