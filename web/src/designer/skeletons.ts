// Method skeletons a new method may start from: the usual stages and steps of an analysis, as data. Settings that
// depend on the method (what is weighed, volumes, conditions) are left for the author; the method check lists them.
// Each ends with its result step, wired to the weighings and dilutions before it.
import { findBlock } from '../../../shared/blocks/index.js';
import type { SettingValue, Stage, Step } from '../../../shared/master/schema.js';
import { stepFrom } from './model.js';

interface StepPlan { block: string; key?: string; name?: string; settings?: Record<string, SettingValue> }
interface StagePlan { key: string; name: string; kind?: Stage['kind']; count?: number; role: string; machineTypes?: string[]; produces?: [string, number]; uses?: string[]; steps: StepPlan[] }

const ref = (stage: string, step: string, name: string): SettingValue => ({ ref: `${stage}/${step}/${name}` });
const spec = (name: string): SettingValue => ({ spec: name });
const weighSample = (k: number, unit = 'mg'): StepPlan => ({ block: 'weigh', key: `weigh-sample-${k}`, name: `Weigh sample ${k}`, settings: { what: `Sample ${k}`, unit } });
// The result steps end each skeleton: their masses and dilution factors refer to the weigh and dilute steps before
// them, and the result's limit (and the label claim) is the specification's.
const SKELETONS: { id: string; name: string; text: string; stages: StagePlan[] }[] = [
  {
    id: 'hplc-external-standard', name: 'Chromatography (HPLC/GC) with an external standard',
    text: 'Standard solution, two sample solutions, the instrument run and its system suitability, then the assay.',
    stages: [
      { key: 'standard', name: 'Standard solution', kind: 'preparation', role: 'Analyst', produces: ['standard solution', 24],
        steps: [{ block: 'weigh', key: 'weigh-standard', name: 'Weigh the reference standard', settings: { what: 'Reference standard', unit: 'mg' } },
          { block: 'mix', key: 'dissolve-standard', name: 'Dissolve the standard' }, { block: 'dilute', key: 'dilute-standard', name: 'Dilute the standard' }] },
      { key: 'sample', name: 'Sample solutions', role: 'Analyst',
        steps: [weighSample(1), weighSample(2), { block: 'mix', key: 'dissolve-sample', name: 'Dissolve the samples' }, { block: 'dilute', key: 'dilute-sample', name: 'Dilute the samples' }] },
      { key: 'run', name: 'Instrument run', role: 'Analyst', uses: ['standard'], machineTypes: ['HPLC', 'GC'],
        steps: [{ block: 'instrument-run', key: 'run' }, { block: 'system-suitability', key: 'sst' },
          { block: 'assay', key: 'assay', settings: { mode: 'external standard', response: 'peak area', responseUnit: '', preparations: '2',
            stdMass: ref('standard', 'weigh-standard', 'mass'), stdFactor: ref('standard', 'dilute-standard', 'factor'),
            sample1Mass: ref('sample', 'weigh-sample-1', 'mass'), sample2Mass: ref('sample', 'weigh-sample-2', 'mass'),
            sample1Factor: ref('sample', 'dilute-sample', 'factor'), sample2Factor: ref('sample', 'dilute-sample', 'factor'), limit: spec('limit') } }] },
    ],
  },
  {
    id: 'titration', name: 'Titration',
    text: 'Weigh the sample twice, dissolve and titrate.',
    stages: [
      { key: 'sample', name: 'Sample', role: 'Analyst',
        steps: [weighSample(1), weighSample(2), { block: 'mix', key: 'dissolve-sample', name: 'Dissolve the samples' },
          { block: 'titration', key: 'titration', settings: { preparations: '2', sample1Mass: ref('sample', 'weigh-sample-1', 'mass'),
            sample2Mass: ref('sample', 'weigh-sample-2', 'mass'), limit: spec('limit') } }] },
    ],
  },
  {
    id: 'uv-specific-absorbance', name: 'UV assay by specific absorbance',
    text: 'Weigh the sample twice, dissolve and dilute, and read the absorbance against the monograph\'s specific absorbance.',
    stages: [
      { key: 'sample', name: 'Sample solutions', role: 'Analyst',
        steps: [weighSample(1), weighSample(2), { block: 'mix', key: 'dissolve-sample', name: 'Dissolve the samples' }, { block: 'dilute', key: 'dilute-sample', name: 'Dilute the samples' },
          { block: 'assay-absorbance', key: 'assay', settings: { preparations: '2', sample1Mass: ref('sample', 'weigh-sample-1', 'mass'),
            sample2Mass: ref('sample', 'weigh-sample-2', 'mass'), sample1Factor: ref('sample', 'dilute-sample', 'factor'),
            sample2Factor: ref('sample', 'dilute-sample', 'factor'), limit: spec('limit') } }] },
    ],
  },
  {
    id: 'related-substances', name: 'Related substances by HPLC',
    text: 'Test solution and its diluted reference solution, the instrument run and its system suitability, then the impurities.',
    stages: [
      { key: 'test', name: 'Test and reference solutions', kind: 'preparation', role: 'Analyst', produces: ['test solution', 24],
        steps: [{ block: 'weigh', key: 'weigh-sample', name: 'Weigh the sample', settings: { what: 'Sample', unit: 'mg' } },
          { block: 'mix', key: 'dissolve-sample', name: 'Dissolve the sample' }, { block: 'dilute', key: 'dilute-reference', name: 'Dilute to the reference solution' }] },
      { key: 'run', name: 'Instrument run', role: 'Analyst', uses: ['test'], machineTypes: ['HPLC', 'GC'],
        steps: [{ block: 'instrument-run', key: 'run' }, { block: 'system-suitability', key: 'sst' },
          { block: 'impurities', key: 'impurities', settings: { mode: 'external standard', areaUnit: '', limit: spec('limit') } }] },
    ],
  },
  {
    id: 'dissolution', name: 'Dissolution',
    text: 'Standard solution, then the dissolution run with its time points and stage rules.',
    stages: [
      { key: 'standard', name: 'Standard solution', kind: 'preparation', role: 'Analyst', produces: ['standard solution', 24],
        steps: [{ block: 'weigh', key: 'weigh-standard', name: 'Weigh the reference standard', settings: { what: 'Reference standard', unit: 'mg' } },
          { block: 'mix', key: 'dissolve-standard', name: 'Dissolve the standard' }, { block: 'dilute', key: 'dilute-standard', name: 'Dilute the standard' }] },
      { key: 'dissolution', name: 'Dissolution', role: 'Analyst', uses: ['standard'],
        steps: [{ block: 'dissolution', key: 'dissolution', settings: { stdMass: ref('standard', 'weigh-standard', 'mass'), stdFactor: ref('standard', 'dilute-standard', 'factor'),
          labelClaim: spec('labelClaim'), acceptance: 'dissolution IR', limit: spec('limit'), temperatureLimit: { low: '36.5', high: '37.5', unit: '°C' } } }] },
    ],
  },
  {
    id: 'water-kf', name: 'Water by Karl Fischer',
    text: 'Weigh the sample twice and titrate each with the Karl Fischer reagent.',
    stages: [
      { key: 'water', name: 'Water', role: 'Analyst',
        steps: [weighSample(1), weighSample(2), { block: 'water-kf', key: 'water', settings: { preparations: '2', sample1Mass: ref('water', 'weigh-sample-1', 'mass'),
          sample2Mass: ref('water', 'weigh-sample-2', 'mass'), limit: spec('limit') } }] },
    ],
  },
  {
    id: 'loss-on-drying', name: 'Loss on drying',
    text: 'Weigh the container and the sample, dry, and weigh again until the mass is constant.',
    stages: [
      { key: 'drying', name: 'Loss on drying', role: 'Analyst',
        steps: [{ block: 'loss-on-drying', key: 'lod', settings: { mode: 'loss on drying', maxChange: '0.5 mg', limit: spec('limit') } }] },
    ],
  },
  {
    id: 'physical-tests', name: 'Physical tests of tablets',
    text: 'Uniformity of mass, friability and disintegration.',
    stages: [
      { key: 'physical', name: 'Physical tests', role: 'Analyst',
        steps: [{ block: 'uniformity-by-weight' }, { block: 'friability' }, { block: 'disintegration' }] },
    ],
  },
];
export const SKELETON_LIST = SKELETONS.map(({ id, name, text }) => ({ id, name, text }));

/** The stages of a skeleton. */
export function skeletonStages(id: string): Stage[] {
  const sk = SKELETONS.find((s) => s.id === id);
  if (!sk) return [];
  return sk.stages.map((p) => ({
    key: p.key, name: p.name, kind: p.kind ?? 'normal', ...(p.count ? { count: p.count } : {}), roomTypes: [], machineTypes: p.machineTypes ?? [], role: p.role, uses: p.uses ?? [],
    ...(p.produces ? { produces: { name: p.produces[0], holdHours: p.produces[1] } } : {}),
    steps: p.steps.reduce<Step[]>((steps, sp) => {
      const block = findBlock({ id: sp.block, version: 1 })!;
      const base = stepFrom(block, steps.map((t) => t.key));
      return [...steps, { ...base, ...(sp.key ? { key: sp.key } : {}), ...(sp.name ? { name: sp.name } : {}), settings: { ...base.settings, ...sp.settings } }];
    }, []),
  }));
}
