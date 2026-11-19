import type { Block } from './format.js';

// Blend uniformity (in-process, owner 19 Nov 2026): the content at each sampling location of the blender, in location
// order; the mean against its limit and the % RSD against its limit (T7), and each location inside its band (C3).
export const blendUniformity: Block = {
  id: 'blend-uniformity', version: 1, name: 'Blend uniformity', checker: true,
  instruction: 'Take the blend samples with the sampling thief at the locations of the sampling plan (top, middle and bottom, front and back), one unit dose each. Assay each sample by the method and record its content in location order.',
  fields: [{ name: 'results', label: 'Content at each sampling location (% of label claim)', kind: 'number', unit: '%', count: 10, minCount: 6 }],
  units: ['results'],
  settings: [
    { name: 'limit', label: 'Limits of the mean', kind: 'limit' },
    { name: 'rsdLimit', label: '% RSD limit', kind: 'limit' },
    { name: 'individualLimit', label: 'Limits of each location', kind: 'limit' },
  ],
  calcs: [
    { name: 'result', label: 'Blend uniformity: mean and % RSD', template: 'T7', args: { readings: '$results', decimals: 1, limit: '$limit', rsdLimit: '$rsdLimit' } },
    { name: 'locations', label: 'Each location against its limits', template: 'C3', args: { readings: '$results', band: { limit: '$individualLimit' }, noun: 'locations' } },
  ],
};
