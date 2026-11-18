import type { Block, BlockSetting } from './format.js';

// Related substances by chromatography (L4): the peak table typed from the chromatogram (relative retention times and
// areas in the same order), the method's named impurities with their RRT windows, limits and factors (safety rule S4:
// a correction factor multiplies the area, a relative response factor divides it; the method says which), peaks
// excluded by RRT (blank, placebo), the disregard limit and the reporting threshold. By area normalisation (the
// principal peak's area), or against a diluted reference solution of the test solution (its responses and its %).
// The reportable result is the total of impurities against the limit; each impurity's own limit is checked too.
const named = [1, 2, 3, 4, 5] as const;
const excluded = [1, 2] as const;

export const impurities: Block = {
  id: 'impurities', version: 1, name: 'Related substances (impurities)', checker: true,
  instruction: 'From the chromatogram of the test solution, record the relative retention time and the area of every peak other than the principal peak, in the same order, and the area of the principal peak. Against a reference solution, record its responses.',
  fields: [
    { name: 'principalArea', label: 'Principal peak: area (area normalisation)', kind: 'number', unit: '$areaUnit', optional: true },
    { name: 'rrts', label: 'Peaks: relative retention times', kind: 'number', unit: '$areaUnit', count: 30, minCount: 1 },
    { name: 'areas', label: 'Peaks: areas (in the same order)', kind: 'number', unit: '$areaUnit', count: 30, minCount: 1 },
    { name: 'referenceResponses', label: 'Reference solution: responses', kind: 'number', unit: '$areaUnit', count: 6, minCount: 1, optional: true },
  ],
  settings: [
    { name: 'mode', label: 'Calculation', kind: 'text', options: ['area normalisation', 'external standard'] },
    { name: 'areaUnit', label: 'Unit of the areas and RRTs (none: plain numbers)', kind: 'text' },
    { name: 'referencePercent', label: 'Reference solution: % of the test solution (e.g. 0.5 %)', kind: 'quantity', optional: true },
    ...named.flatMap((k): BlockSetting[] => [
      { name: `imp${k}Name`, label: `Named impurity ${k}: name`, kind: 'text', optional: true },
      { name: `imp${k}Low`, label: `Named impurity ${k}: RRT from`, kind: 'number', optional: true },
      { name: `imp${k}High`, label: `Named impurity ${k}: RRT to`, kind: 'number', optional: true },
      { name: `imp${k}Limit`, label: `Named impurity ${k}: limit`, kind: 'limit', optional: true },
      { name: `imp${k}Factor`, label: `Named impurity ${k}: factor`, kind: 'number', optional: true },
      { name: `imp${k}FactorKind`, label: `Named impurity ${k}: the factor is a (safety rule S4)`, kind: 'text', options: ['correction factor', 'relative response factor'], optional: true },
    ]),
    { name: 'unknownLimit', label: 'Any other (unknown) impurity: limit', kind: 'limit', optional: true },
    { name: 'disregardLimit', label: 'Disregard limit (%): peaks at or below it are left out', kind: 'number', optional: true },
    { name: 'reportingThreshold', label: 'Reporting threshold (%)', kind: 'number', optional: true },
    ...excluded.flatMap((k): BlockSetting[] => [
      { name: `exclude${k}Low`, label: `Peaks left out ${k}: RRT from`, kind: 'number', optional: true },
      { name: `exclude${k}High`, label: `Peaks left out ${k}: RRT to`, kind: 'number', optional: true },
      { name: `exclude${k}Reason`, label: `Peaks left out ${k}: why (blank, placebo …)`, kind: 'text', optional: true },
    ]),
    { name: 'limit', label: 'Total of impurities: limit', kind: 'limit', optional: true },
  ],
  calcs: [{
    name: 'result', label: 'Total of impurities', template: 'L4',
    args: {
      mode: '$mode',
      table: { rrts: '$rrts', areas: '$areas', principal: '$principalArea?' },
      // Left out of the list unless both are given (area normalisation uses none).
      references: [{ name: 'reference solution', responses: '$referenceResponses?', percentOfTest: '$referencePercent?' }],
      // A named impurity counts when its name, window and limit are set; its factor is optional.
      named: named.map((k) => ({ name: `$imp${k}Name?`, rrtLow: `$imp${k}Low?`, rrtHigh: `$imp${k}High?`, limit: `$imp${k}Limit?`,
        factor: { kind: `$imp${k}FactorKind?`, value: `$imp${k}Factor?` } })),
      excludeRrt: excluded.map((k) => ({ low: `$exclude${k}Low?`, high: `$exclude${k}High?`, reason: `$exclude${k}Reason?` })),
      disregardLimit: '$disregardLimit?', reportingThreshold: '$reportingThreshold?', unknownLimit: '$unknownLimit?', limit: '$limit?',
    },
  }],
};
