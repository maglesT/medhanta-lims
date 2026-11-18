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
