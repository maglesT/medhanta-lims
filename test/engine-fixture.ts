import { masterSchema, type MasterDoc } from '../shared/master/schema.js';
import type { EventKind, Payload, StepEvent, StepKey } from '../shared/engine/index.js';

// An invented HPLC assay method (external standard): a standard solution made once and used by the run, the sample
// solutions in duplicate, loss on drying to constant mass, and the instrument run with its system suitability and a
// column temperature read every 30 minutes until the run is over.
export const method = (): MasterDoc => masterSchema.parse({
  header: { code: 'QC-M-001', name: 'Examplol assay by HPLC', technique: 'HPLC', reference: 'In-house method QC-M-001', edition: 'version 1' },
  stages: [
    {
      key: 'standard', name: 'Standard solution', kind: 'preparation', machineTypes: ['balance', 'sonicator'], role: 'Analyst',
      produces: { name: 'standard solution', holdHours: 24 },
      steps: [
        { key: 'weigh-std', block: { id: 'weigh', version: 1 }, checker: true, critical: true, settings: { what: 'Reference standard', unit: 'mg', target: '50.0 mg', tolerance: '10' } },
        { key: 'dissolve', block: { id: 'mix', version: 1 }, checker: false, minMinutes: 10 },
      ],
    },
    {
      key: 'drying', name: 'Loss on drying', kind: 'normal', machineTypes: ['balance', 'oven'], role: 'Analyst',
      steps: [
        { key: 'lod', block: { id: 'dry-constant', version: 1 }, checker: false, flow: { kind: 'repeat-until', maxRounds: 5 }, settings: { maxChange: '0.0005 g' } },
      ],
    },
    {
      key: 'run', name: 'Instrument run', kind: 'normal', machineTypes: ['hplc'], uses: ['standard'], role: 'Analyst',
      steps: [
        { key: 'run', block: { id: 'instrument-run', version: 1 }, checker: false, settings: { conditions: 'C18, 250 x 4.6 mm, 5 µm; 1.0 mL/min; 254 nm' } },
        { key: 'sst', block: { id: 'system-suitability', version: 1 }, checker: true, settings: { rsdLimit: { high: '2.0', unit: '%' }, tailingLimit: { high: '2.0', unit: 'units' } } },
        { key: 'temp', block: { id: 'periodic-check', version: 1 }, checker: false, everyMinutes: 30, flow: { kind: 'repeat-until', maxRounds: 40 },
          settings: { what: 'Column temperature', unit: '°C', limit: { low: '28', high: '32', unit: '°C' } } },
      ],
    },
    {
      key: 'sample', name: 'Sample solutions', kind: 'replicate', count: 2, machineTypes: ['balance'], role: 'Analyst',
      steps: [
        { key: 'weigh-sample', block: { id: 'weigh', version: 1 }, checker: true, settings: { what: 'Sample', unit: 'mg', target: '100.0 mg', tolerance: '10' } },
        { key: 'dilute', block: { id: 'dilute', version: 1 }, checker: false, settings: { from: 'Sample stock solution', diluent: 'Mobile phase', aliquot1: '5.0 mL', volume1: '50.0 mL' } },
        { key: 'result', block: { id: 'check', version: 1 }, checker: true, settings: { what: 'Assay', unit: '%', limit: { low: '95.0', high: '105.0', unit: '%' } } },
      ],
    },
  ],
});

/**
 * The fixture as a method names where its stages run (LIMS-12): each stage allows the rooms of its own name as an
 * area, and starts with bench clearance. Most tests leave this out: their checks are filtered by `unplaced`.
 */
export function placed(doc: MasterDoc): MasterDoc {
  const clearance = { key: 'clearance', block: { id: 'line-clearance', version: 1 }, settings: {}, checker: true, waitForCheck: false, critical: false, flow: { kind: 'none' as const } };
  return { ...doc, stages: doc.stages.map((s) => ({ ...s, roomTypes: s.roomTypes.length ? s.roomTypes : [s.name],
    steps: s.steps.some((t) => t.block.id === 'line-clearance') ? s.steps : [clearance, ...s.steps] })) };
}
/** Leaves out the problems of stages that name no rooms (LIMS-12, tested in master-checks.test.ts). */
export const unplaced = <T extends { rule?: string; path: string }>(problems: T[]) => problems.filter((p) => !(p.rule === 'LIMS-12' && p.path.endsWith('.roomTypes')));

/** A small method with the given stages; each step defaults to a "check a value" step without a checker. */
export function small(stages: object[]): MasterDoc {
  return masterSchema.parse({
    header: { code: 'M', name: 'M', technique: 'Other', reference: 'R' },
    stages: stages.map((s, i) => ({ key: `s${i}`, name: `Stage ${i}`, kind: 'normal', ...s,
      steps: ((s as { steps?: object[] }).steps ?? [{}]).map((t, j) => ({ key: `t${j}`, block: { id: 'check', version: 1 }, checker: false,
        settings: { what: 'pH', unit: '', limit: { low: '5.0', high: '7.0', unit: '' } }, ...t })) })),
  });
}

export const T0 = new Date('2026-11-15T08:00:00Z');
export const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** An event list builder: ev('done', '0.1.0.1', { person: 2, min: 5 }). */
let next = 1;
export function ev(kind: EventKind, key: string, o: { person?: number | null; min?: number; payload?: Payload } = {}): StepEvent {
  const [stage, sub, step, round] = key.split('.').map(Number) as [number, number, number, number];
  const k: StepKey = { stage, sub, step, round };
  return { id: next++, ...k, kind, payload: o.payload ?? {}, person: o.person === undefined ? 1 : o.person, at: at(o.min ?? next) };
}
/** A value event whose results are those of the engine for these values. */
export const reading = (key: string, results: Record<string, unknown>, o: { person?: number; min?: number } = {}) =>
  ev('value', key, { ...o, payload: { values: {}, results: results as Payload['results'] } });
export const pass = { ok: true, value: '1', unit: '', shown: '', check: { pass: true, level: 'pass', shown: '' } };
export const fail = { ok: true, value: '9', unit: '', shown: '', check: { pass: false, level: 'fail', shown: '' } };
