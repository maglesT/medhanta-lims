// Method skeletons a new method may start from: the usual stages and steps of an analysis, as data. Settings that
// depend on the method (what is weighed, volumes, conditions, limits) are left for the author; the method check lists
// them. The result steps are added from the block library once the method's calculation is chosen.
import { findBlock } from '../../../shared/blocks/index.js';
import type { SettingValue, Stage, Step } from '../../../shared/master/schema.js';
import { stepFrom } from './model.js';

interface StepPlan { block: string; key?: string; name?: string; settings?: Record<string, SettingValue> }
interface StagePlan { key: string; name: string; kind?: Stage['kind']; count?: number; role: string; machineTypes?: string[]; produces?: [string, number]; uses?: string[]; steps: StepPlan[] }

const SKELETONS: { id: string; name: string; text: string; stages: StagePlan[] }[] = [
  {
    id: 'hplc-external-standard', name: 'Chromatography (HPLC/GC) with an external standard',
    text: 'Standard solution, sample solutions in replicate, the instrument run and its system suitability.',
    stages: [
      { key: 'standard', name: 'Standard solution', kind: 'preparation', role: 'Analyst', produces: ['standard solution', 24],
        steps: [{ block: 'weigh', key: 'weigh-standard', name: 'Weigh the reference standard', settings: { what: 'Reference standard', unit: 'mg' } },
          { block: 'mix', key: 'dissolve-standard', name: 'Dissolve the standard' }, { block: 'dilute', key: 'dilute-standard', name: 'Dilute the standard' }] },
      { key: 'sample', name: 'Sample solutions', kind: 'replicate', count: 2, role: 'Analyst',
        steps: [{ block: 'weigh', key: 'weigh-sample', name: 'Weigh the sample', settings: { what: 'Sample', unit: 'mg' } },
          { block: 'mix', key: 'dissolve-sample', name: 'Dissolve the sample' }, { block: 'dilute', key: 'dilute-sample', name: 'Dilute the sample' }] },
      { key: 'run', name: 'Instrument run', role: 'Analyst', uses: ['standard'], machineTypes: ['HPLC', 'GC'],
        steps: [{ block: 'instrument-run', key: 'run' }, { block: 'system-suitability', key: 'sst' }] },
    ],
  },
  {
    id: 'titration', name: 'Titration',
    text: 'Weigh the sample in replicate, dissolve and titrate.',
    stages: [
      { key: 'sample', name: 'Sample', kind: 'replicate', count: 2, role: 'Analyst',
        steps: [{ block: 'weigh', key: 'weigh-sample', name: 'Weigh the sample', settings: { what: 'Sample', unit: 'mg' } },
          { block: 'mix', key: 'dissolve-sample', name: 'Dissolve the sample' }] },
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
