// The sweep: every block of the library in a small method with all its settings set, and the
// test method, worked out with every field filled ("1" for a number, yes, the first option), once with the required
// fields only and once with all, in a first and a second round. A template may refuse what it is given; it must never
// crash on it (a crash is "could not use these inputs": the step could not be signed).
import { describe, expect, it } from 'vitest';
import { BLOCKS, findBlock, type Block } from '../shared/blocks/index.js';
import { evaluate, type StepEvent, type Value } from '../shared/engine/index.js';
import { masterChecks } from '../shared/master/checks.js';
import { masterSchema, type MasterDoc, type Step } from '../shared/master/schema.js';
import { at, ev, method } from './engine-fixture.js';

const pct = (low: string, high: string) => ({ low, high, unit: '%' });
// Every setting of every block that has settings, optional ones too.
const SETTINGS: Record<string, Step['settings']> = {
  weigh: { what: 'Sample', unit: 'mg', target: '100.0 mg', tolerance: '10' },
  mix: { speedLimit: { low: '10', high: '20', unit: 'rpm' } },
  dilute: { from: 'Stock solution', diluent: 'Water', aliquot1: '5.0 mL', volume1: '50.0 mL', aliquot2: '2.0 mL', volume2: '100.0 mL', aliquot3: '1.0 mL', volume3: '10.0 mL' },
  'instrument-run': { conditions: 'C18; 1.0 mL/min; 254 nm' },
  'system-suitability': { rsdLimit: { high: '2.0', unit: '%' }, tailingLimit: { high: '2.0', unit: 'units' }, platesLimit: { low: '2000', unit: 'units' },
    resolutionLimit: { low: '2.0', unit: 'units' }, signalToNoiseLimit: { low: '10', unit: 'units' } },
  check: { what: 'Weight', unit: 'mg', limit: { low: '95', high: '105', unit: 'mg' } },
  'periodic-check': { what: 'Temperature', unit: '°C', limit: { low: '20', high: '25', unit: '°C' } },
  'dry-constant': { conditions: '105 °C, 3 hours', maxChange: '0.5 g' },
  'density-flow': { carrLimit: { high: '20', unit: '%' }, hausnerLimit: { high: '1.25', unit: '' }, reposeLimit: { high: '40', unit: '°' } },
  'sieve-analysis': { sieve1: '850 µm', sieve2: '425 µm', sieve3: '250 µm', sieve4: '180 µm', sieve5: '150 µm', finesBelow: '150 µm', finesLimit: { high: '20.0', unit: '%' },
    recoveryLimit: pct('98.0', '102.0') },
  friability: { lossLimit: { high: '1.0', unit: '%' } },
  disintegration: { maxTime: '15', temperatureLimit: { low: '35', high: '39', unit: '°C' } },
  'uniformity-by-weight': { coating: 'uncoated', labelClaim: '50 mg' },
  'content-uniformity': { coating: 'uncoated' },
  assay: { mode: 'bracketing', response: 'peak area', responseUnit: '', stdMass: '50.00 mg', stdVolume: '100 mL', stdFactor: '10', preparations: '3',
    sample1Mass: '250.0 mg', sample2Mass: '250.0 mg', sample3Mass: '250.0 mg', sampleVolume: '100 mL', sample1Factor: '10', sample2Factor: '10', sample3Factor: '10',
    per: 'unit', averageWeight: '250 mg', labelClaim: '50 mg', basis: 'dried', sampleLod: '0.5 %', sampleWater: '0.4 %', sampleSolvents: '0.1 %',
    limit: pct('95.0', '105.0'), agreementLimit: { high: '2.0', unit: '%' } },
  'assay-absorbance': { specificAbsorbance: '715', form: 'absorptivity', pathLength: '1 cm', preparations: '3', sample1Mass: '25 mg', sample2Mass: '25 mg', sample3Mass: '25 mg',
    sampleVolume: '100 mL', sample1Factor: '10', sample2Factor: '10', sample3Factor: '10', per: 'mass', averageWeight: '250 mg', labelClaim: '10 mg', basis: 'anhydrous',
    sampleLod: '0.5 %', sampleWater: '0.4 %', sampleSolvents: '0.1 %', limit: pct('98.0', '102.0'), agreementLimit: { high: '2.0', unit: '%' } },
  impurities: { mode: 'external standard', areaUnit: '', referencePercent: '0.5 %',
    ...Object.fromEntries([1, 2, 3, 4, 5].flatMap((k) => [[`imp${k}Name`, `Impurity ${k}`], [`imp${k}Low`, `0.${k}0`], [`imp${k}High`, `0.${k}5`],
      [`imp${k}Limit`, { high: '0.2', unit: '%' }], [`imp${k}Factor`, '1.2'], [`imp${k}FactorKind`, k % 2 ? 'correction factor' : 'relative response factor']])),
    unknownLimit: { high: '0.10', unit: '%' }, disregardLimit: '0.05', reportingThreshold: '0.05', exclude1Low: '1.80', exclude1High: '1.90', exclude1Reason: 'Blank peak',
    exclude2Low: '2.10', exclude2High: '2.20', exclude2Reason: 'Placebo peak', limit: { high: '1.0', unit: '%' } },
  dissolution: { tier: 'Tier 1', medium: 'Phosphate buffer pH 6.8', volume: '900 mL', volumeMode: 'no replacement', aliquot: '10 mL', time1: '15 min', time2: '30 min',
    time3: '45 min', time4: '60 min', reportAt: '45 min', responseUnit: 'AU', standardConcentration: '0.0111 mg/mL', stdMass: '25 mg', stdVolume: '100 mL', stdFactor: '20',
    dilution: '2', labelClaim: '10 mg', acceptance: 'dissolution ER', limit: { low: '80', unit: '%' }, range1: pct('10', '30'), range2: pct('30', '50'), range3: pct('50', '70'),
    range4: { low: '80', unit: '%' }, temperatureLimit: { low: '36.5', high: '37.5', unit: '°C' } },
  titration: { mode: 'back', titrant: '0.1 M hydrochloric acid', titrantMolarity: '0.1 M', equivalence: '5.004 mg', equivalenceMolarity: '0.1 M', equivalenceOf: 'excess',
    excessVolume: '50.0 mL', excessMolarity: '0.1 M', reactionRatio: '1', aliquotTotal: '100 mL', aliquotTaken: '50 mL', preparations: '3',
    sample1Mass: '500 mg', sample2Mass: '500 mg', sample3Mass: '500 mg', report: '%', averageWeight: '250 mg', basis: 'dried', basisLoss: '0.5 %',
    limit: pct('98.0', '102.0'), agreementLimit: { high: '0.5', unit: '%' } },
  'water-kf': { mode: 'coulometric', readingUnit: 'µg', waterEquivalent: '5.0 mg/mL', preparations: '3', sample1Mass: '200 mg', sample2Mass: '200 mg', sample3Mass: '200 mg',
    limit: { high: '0.5', unit: '%' }, agreementLimit: { high: '5', unit: '%' } },
  'loss-on-drying': { mode: 'sulfated ash', conditions: '600 °C', dried: '20.5 g', maxChange: '0.5 mg', limit: { high: '0.1', unit: '%' } },
  'optical-rotation': { form: 'solution', pathLength: '100 mm', sampleMass: '1.000 g', volume: '50.0 mL', concentration: '2.0 %w/v', massPercent: '2.0 %', density: '1.02',
    basis: 'dried', basisLoss: '0.5 %', temperatureLimit: { low: '19.5', high: '20.5', unit: '°C' }, limit: { low: '-30', high: '-26', unit: '°' } },
  ph: { readingUnit: '', limit: { low: '5.0', high: '7.0', unit: '' } },
  'relative-density': { mode: 'weight per mL', waterDensity: '0.99820 g/mL', temperatureLimit: { low: '19.5', high: '20.5', unit: '°C' }, limit: { low: '1.010', high: '1.030', unit: 'g/mL' } },
};

const item = { itemId: 'eq-1', code: 'EQ-01', name: 'Equipment', version: 1, type: 'balance', room: 'RM-1', area: 'Area' };
/** Every field filled (or the required ones only): "1" in its unit, yes, the first option, a time a few minutes apart. */
function filled(b: Block, settings: Step['settings'], all: boolean): Record<string, Value> {
  let minute = 0;
  const one = (f: Block['fields'][number]): Value => {
    if (f.kind === 'number') {
      const u = f.unit?.startsWith('$') ? settings[f.unit.slice(1)] : f.unit;
      const q = { value: '1', unit: typeof u === 'string' ? u : '' };
      return f.count ? Array.from({ length: f.count }, () => q) : q;
    }
    if (f.kind === 'yes-no') return 'yes';
    if (f.kind === 'choice') return f.options![0]!;
    if (f.kind === 'timer') return `${at(minute += 11).toISOString().slice(0, 19)}Z`;
    if (f.kind === 'machine' || f.kind === 'room') return item;
    if (f.kind === 'lot') return 'L-1';
    return f.date ? '2026-11-03' : '1';
  };
  return Object.fromEntries(b.fields.filter((f) => all || !f.optional).map((f) => [f.name, one(f)]));
}

/** The calculations that crashed, as "step calc: message". */
function crashes(doc: MasterDoc, all: boolean): string[] {
  const events: StepEvent[] = [];
  const out: string[] = [];
  for (const [si, s] of doc.stages.entries()) for (const [ti, t] of s.steps.entries()) {
    const b = findBlock(t.block)!;
    const values = filled(b, t.settings, all);
    for (const round of [1, 2]) {
      const key = `${si}.1.${ti}.${round}`;
      const results = evaluate(doc, events, { stage: si, sub: 1, step: ti, round }, values);
      for (const [n, r] of Object.entries(results)) if (!r.ok && /could not use these inputs/.test(r.message)) out.push(`${s.key}/${t.key} ${n}: ${r.message}`);
      events.push(ev('started', key), ev('value', key, { payload: { values, results } }));
    }
  }
  return out;
}

/** A small method of one block with all its settings set. */
function using(b: Block): MasterDoc {
  const step = (x: Block) => ({ key: x.id, block: { id: x.id, version: x.version }, checker: x.checker, settings: SETTINGS[x.id] ?? {} });
  return masterSchema.parse({ header: { code: 'M', name: 'M', technique: 'Other', reference: 'R' }, stages: [{ key: 's', name: 'Stage', kind: 'normal', steps: [step(b)] }] });
}

describe('the sweep: no template crashes on any block or test method', () => {
  it.each(BLOCKS.map((b) => [b.id, b] as const))('%s: all its settings set, its fields filled, required only or all, in two rounds', (id, b) => {
    expect(Object.keys(SETTINGS[id] ?? {}).sort()).toEqual(b.settings.map((s) => s.name).sort());
    for (const all of [false, true]) expect(crashes(using(b), all)).toEqual([]);
    // Its limits and targets are of the kinds of the values they check (LIMS-01).
    expect(masterChecks(using(b)).filter((p) => /every reading would be refused/.test(p.message))).toEqual([]);
  });

  it.each([['method', method()]] as const)('the %s test method', (_name, doc) => {
    for (const all of [false, true]) expect(crashes(doc, all)).toEqual([]);
    expect(masterChecks(doc).filter((p) => /every reading would be refused/.test(p.message))).toEqual([]);
  });
});
