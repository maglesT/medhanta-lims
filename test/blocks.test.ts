import { describe, expect, it } from 'vitest';
import { BLOCKS, findBlock } from '../shared/blocks/index.js';
import { blockProblems } from '../shared/blocks/format.js';
import { doneProblems, evaluate, openSteps, parseKey, type StepEvent, type Value } from '../shared/engine/index.js';
import { masterChecks } from '../shared/master/checks.js';
import type { MasterDoc } from '../shared/master/schema.js';
import { at, ev, method, small, unplaced } from './engine-fixture.js';
// The problems, without the rooms a stage must name (LIMS-12): the fixtures name none.
const checks = (d: Parameters<typeof masterChecks>[0]) => unplaced(masterChecks(d));

// The lab blocks: each is a description that the format accepts and that a small method can use without a method-check
// problem; the engine runs them like any other block.

const pct = (low: string, high: string) => ({ low, high, unit: '%' });

// Each block with the settings a small method gives it (and its step options).
const ALL: [string, Record<string, unknown>, object?][] = [
  ['line-clearance', {}],
  ['weigh', { what: 'Sample', unit: 'mg', target: '100.0 mg', tolerance: '10' }],
  ['mix', { speedLimit: { low: '100', high: '200', unit: 'rpm' } }],
  ['dilute', { from: 'Sample stock solution', diluent: 'Mobile phase', aliquot1: '5.0 mL', volume1: '50.0 mL', aliquot2: '2.0 mL', volume2: '100.0 mL' }],
  ['instrument-run', { conditions: 'C18, 250 x 4.6 mm, 5 µm; 1.0 mL/min; 254 nm' }],
  ['system-suitability', { rsdLimit: { high: '2.0', unit: '%' }, tailingLimit: { high: '2.0', unit: 'units' }, platesLimit: { low: '2000', unit: 'units' } }],
  ['check', { what: 'pH', unit: '', limit: { low: '5.0', high: '7.0', unit: '' } }],
  ['periodic-check', { what: 'Chamber temperature', unit: '°C', limit: { low: '23', high: '27', unit: '°C' } }, { everyMinutes: 60, flow: { kind: 'repeat-until', maxRounds: 24 } }],
  ['dry-constant', { conditions: '105 °C, 3 hours', maxChange: '0.0005 g' }, { flow: { kind: 'repeat-until', maxRounds: 5 } }],
  ['disintegration', { maxTime: '15', temperatureLimit: { low: '35', high: '39', unit: '°C' } }],
  ['friability', { lossLimit: { high: '1.0', unit: '%' } }],
  ['uniformity-by-weight', { coating: 'film-coated', labelClaim: '50 mg' }],
  ['content-uniformity', { coating: 'sugar-coated' }],
  ['density-flow', { carrLimit: { high: '20', unit: '%' }, hausnerLimit: { high: '1.25', unit: '' }, reposeLimit: { high: '40', unit: '°' } }],
  ['sieve-analysis', { sieve1: '850 µm', sieve2: '425 µm', sieve3: '250 µm', sieve4: '180 µm', sieve5: '150 µm', finesBelow: '150 µm', finesLimit: { high: '20.0', unit: '%' } }],
  // The result blocks: in a method the masses are references to the weigh steps; here they are typed.
  ['assay', { mode: 'external standard', response: 'peak area', responseUnit: '', stdMass: '50.00 mg', stdVolume: '100 mL', stdFactor: '10', preparations: '2',
    sample1Mass: '250.0 mg', sample2Mass: '250.0 mg', sampleVolume: '100 mL', sample1Factor: '10', sample2Factor: '10', per: 'mass', limit: pct('98.0', '102.0') }],
  ['assay-absorbance', { specificAbsorbance: '715', form: 'A(1 %, 1 cm)', pathLength: '1 cm', preparations: '1', sample1Mass: '25.0 mg', sampleVolume: '100 mL',
    per: 'unit', averageWeight: '250.0 mg', labelClaim: '10 mg', limit: pct('95.0', '105.0') }],
  ['impurities', { mode: 'area normalisation', areaUnit: '', imp1Name: 'Impurity A', imp1Low: '0.80', imp1High: '0.90', imp1Limit: { high: '0.2', unit: '%' },
    unknownLimit: { high: '0.10', unit: '%' }, disregardLimit: '0.05', limit: { high: '1.0', unit: '%' } }],
  ['dissolution', { medium: '0.1 M hydrochloric acid', volume: '900 mL', volumeMode: 'replace and correct', aliquot: '10 mL', time1: '30 min', responseUnit: 'AU',
    standardConcentration: '0.0111 mg/mL', labelClaim: '10 mg', acceptance: 'dissolution IR', limit: { low: '80', unit: '%' }, temperatureLimit: { low: '36.5', high: '37.5', unit: '°C' } }],
  ['titration', { mode: 'direct', titrant: '0.1 M sodium hydroxide', titrantMolarity: '0.1 M', equivalence: '18.02 mg', equivalenceMolarity: '0.1 M', preparations: '1',
    sample1Mass: '500 mg', limit: pct('99.0', '101.0') }],
  ['water-kf', { mode: 'volumetric', readingUnit: 'mL', waterEquivalent: '5.0 mg/mL', preparations: '1', sample1Mass: '200 mg', limit: { high: '0.5', unit: '%' } }],
  ['loss-on-drying', { mode: 'loss on drying', conditions: '105 °C, 3 hours', limit: { high: '0.5', unit: '%' } }],
  ['optical-rotation', { form: 'solution', pathLength: '1 dm', concentration: '2.0 %w/v', temperatureLimit: { low: '19.5', high: '20.5', unit: '°C' }, limit: { low: '-30', high: '-26', unit: '°' } }],
  ['ph', { readingUnit: '', limit: { low: '5.0', high: '7.0', unit: '' } }],
  ['relative-density', { mode: 'relative density', temperatureLimit: { low: '19.5', high: '20.5', unit: '°C' }, limit: { low: '1.010', high: '1.030', unit: '' } }],
];
const using = (id: string, settings: object, options: object = {}): MasterDoc => {
  const b = findBlock({ id, version: 1 })!;
  return small([{ role: 'Analyst', ...(id === 'instrument-run' ? { machineTypes: ['HPLC'] } : {}), steps: [{ key: id, block: { id, version: 1 }, checker: b.checker, settings, ...options }] }]);
};

describe('the lab blocks', () => {
  it('every block of the library is listed here', () => {
    expect(ALL.map(([id]) => id).sort()).toEqual(BLOCKS.map((b) => b.id).sort());
  });

  it.each(ALL)('the %s block is a valid description, and a small method using it passes the method check', (id, settings, options) => {
    expect(blockProblems(findBlock({ id, version: 1 })!)).toEqual([]);
    expect(checks(using(id, settings, options)).map((p) => `${p.path}: ${p.message}`)).toEqual([]);
  });

  it('a dilution factor is worked out from the method alone, before any analysis: 50.0/5.0 × 100.0/2.0 = 500', () => {
    const r = evaluate(using('dilute', ALL[3]![1]), [], { stage: 0, sub: 1, step: 0, round: 1 }, {});
    expect(r.factor).toMatchObject({ ok: true, value: '500' });
  });

  it('LIMS-17 an optional limit the method leaves out checks nothing; an optional reading left blank is not asked for', () => {
    const d = using('system-suitability', { rsdLimit: { high: '2.0', unit: '%' } });
    const responses = ['100', '101', '100', '99', '100'].map((value) => ({ value, unit: 'units' }));
    const r = evaluate(d, [], { stage: 0, sub: 1, step: 0, round: 1 }, { responses, tailing: { value: '1.2', unit: 'units' } });
    expect(Object.keys(r)).toEqual(['precision']);
    expect(r.precision).toMatchObject({ ok: true, rsdCheck: { pass: true, rounded: '0.7 %' } });
    const events = [ev('started', '0.1.0.1', { min: 0 }), ev('value', '0.1.0.1', { min: 1, payload: { values: { responses }, results: r } })];
    expect(doneProblems(d, openSteps(d, events, at(5)).steps[0]!, at(5))).toEqual([]);
  });

  it('LIMS-16 system suitability: at least 5 of the 6 replicate injections; an RSD over its limit fails the run', () => {
    const d = using('system-suitability', { rsdLimit: { high: '2.0', unit: '%' } });
    const k = { stage: 0, sub: 1, step: 0, round: 1 };
    const of = (s: string) => s.split(' ').map((value) => ({ value, unit: 'units' }));
    expect(evaluate(d, [], k, { responses: of('100 104 96 100 108') }).precision).toMatchObject({ ok: true, rsdCheck: { pass: false } });
    const f = findBlock({ id: 'system-suitability', version: 1 })!.fields.find((x) => x.name === 'responses')!;
    expect([f.count, f.minCount]).toEqual([6, 5]);
  });
});

/** Records a step's values (results from the engine) and signs it done, checked by a second person when it needs it. */
function walk(doc: MasterDoc, events: StepEvent[], key: string, values: Record<string, Value>): StepEvent[] {
  const k = parseKey(key)!;
  const uses: number[] = [];
  const results = evaluate(doc, events, k, values, uses);
  const recorded = [...events, ev('started', key), ev('value', key, { payload: { values, results, uses } })];
  const view = openSteps(doc, recorded, at(10_000)).steps.find((s) => s.id === key)!;
  expect(doneProblems(doc, view, at(10_000)), key).toEqual([]);
  const done = [...recorded, ev('done', key)];
  return doc.stages[k.stage]!.steps[k.step]!.checker ? [...done, ev('checked', key, { person: 2 })] : done;
}
const q = (value: string, unit: string) => ({ value, unit });
const n = (values: string, unit: string) => values.split(' ').map((value) => ({ value, unit }));

describe('the engine runs the lab blocks like any other', () => {
  it('record → done, step by step: the HPLC assay of the fixture, from the standard solution to both sample replicates', () => {
    const doc = method();
    expect(checks(doc)).toEqual([]);
    let e: StepEvent[] = walk(doc, [], '0.1.0.1', { balance: 'INQ-BAL-01', mass: q('50.12', 'mg') });
    e = walk(doc, e, '0.1.1.1', { machine: 'INQ-SON-01' });
    // Loss on drying to constant mass: round 1 has nothing to compare with, round 2 changed 0.0003 g (at most 0.0005 g).
    e = walk(doc, e, '1.1.0.1', { machine: 'INQ-OVN-01', weight: q('25.1234', 'g') });
    expect(evaluate(doc, e, parseKey('1.1.0.2')!, { machine: 'INQ-OVN-01', weight: q('25.1231', 'g') }).constant).toMatchObject({ ok: true, check: { pass: true } });
    e = walk(doc, e, '1.1.0.2', { machine: 'INQ-OVN-01', weight: q('25.1231', 'g') });
    e = walk(doc, e, '2.1.0.1', { instrument: 'INQ-HPLC-01', runId: 'SEQ-0042', asWritten: 'yes' });
    e = walk(doc, e, '2.1.1.1', { responses: n('1520331 1518720 1522010 1519985 1521140 1520667', 'units'), tailing: q('1.1', 'units') });
    e = walk(doc, e, '2.1.2.1', { reading: q('30.1', '°C'), testDone: 'yes' });
    for (const r of [1, 2]) {
      e = walk(doc, e, `3.${r}.0.1`, { balance: 'INQ-BAL-01', mass: q(r === 1 ? '100.21' : '99.87', 'mg') });
      e = walk(doc, e, `3.${r}.1.1`, { classA: 'yes', done: 'yes' });
      e = walk(doc, e, `3.${r}.2.1`, { reading: q(r === 1 ? '99.6' : '100.2', '%') });
    }
    const { stages, steps } = openSteps(doc, e, at(10_000));
    expect(stages.map((s) => s.closed)).toEqual([true, true, true, true]);
    expect(steps.map((s) => `${s.id} ${s.state}`)).toEqual(['0.1.0.1 checked', '0.1.1.1 done', '1.1.0.1 done', '1.1.0.2 done', '2.1.0.1 done', '2.1.1.1 checked', '2.1.2.1 done',
      '3.1.0.1 checked', '3.1.1.1 done', '3.1.2.1 checked', '3.2.0.1 checked', '3.2.1.1 done', '3.2.2.1 checked']);
  });

  it('LIMS-17 friability: a broken tablet fails the check, so the step needs a deviation note before it is signed', () => {
    const d = using('friability', ALL[10]![1]);
    const values = { machine: 'INQ-FRB-01', before: q('6.512', 'g'), after: q('6.498', 'g'), intact: 'no' };
    const r = evaluate(d, [], parseKey('0.1.0.1')!, values);
    expect(r.lossCheck).toMatchObject({ ok: true, check: { pass: true } });
    expect(r.intactCheck).toMatchObject({ ok: true, check: { pass: false } });
    const events = [ev('started', '0.1.0.1', { min: 0 }), ev('value', '0.1.0.1', { min: 1, payload: { values, results: r } })];
    const v = (x: StepEvent[]) => doneProblems(d, openSteps(d, x, at(5)).steps[0]!, at(5));
    expect(v(events)).toEqual(['Out of limits: Tablets intact. Add a deviation note first.']);
    expect(v([...events, ev('note', '0.1.0.1', { min: 2, payload: { text: 'One tablet capped; test repeated as the method says' } })])).toEqual([]);
  });

  it('a staged test: disintegration needs the 12 more tablets only when 1 or 2 of the first 6 fail', () => {
    const d = using('disintegration', ALL[9]![1]);
    const key = { stage: 0, sub: 1, step: 0, round: 1 };
    const times = (s: string) => n(s, 'min');
    const t = { temperature: q('37', '°C') };
    expect(evaluate(d, [], key, { ...t, times: times('5 6 7 8 9 10') }).stages).toMatchObject({ ok: true, decision: 'pass' });
    expect(evaluate(d, [], key, { ...t, times: times('5 6 7 8 9 16') }).stages).toMatchObject({ ok: true, decision: 'next stage', nextStageUnits: 12 });
    expect(evaluate(d, [], key, { ...t, times: times('5 6 7 8 9 16'), moreTimes: times('5 6 7 8 9 10 5 6 7 8 9 10') }).stages).toMatchObject({ ok: true, decision: 'pass' });
  });
});
