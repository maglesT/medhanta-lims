import type { Block, BlockField, BlockSetting } from './format.js';

// Microbial assay of antibiotics (L13; Ph.Int 3.1, statistics as Ph. Eur. 5.3): the test organism (a culture from the
// inventory, not beyond passage 5, LIMS-35) in its medium lot; 2 or 3 doses of the standard and of the test (made at
// the test's assumed potency) in geometric progression; the zone diameters (diffusion) or the turbidity of each
// replicate (plate or tube). Parallel-line analysis: the regression significant, no significant deviation from
// parallelism (or linearity), each by the F test at p = 0.05 (otherwise not valid: repeat); the potency with its 95 %
// fiducial limits, checked against the limit on the estimate or on a fiducial limit as the monograph says, and the
// fiducial limits against the precision the monograph requires.
const doses = [1, 2, 3] as const;
const opt = (k: number) => (k > 2 ? { optional: true } : {});

export const microbialAssay: Block = {
  id: 'microbial-assay', version: 1, name: 'Microbial assay of antibiotics', checker: true,
  instruction: 'Pick the test organism and the medium lot. Apply the doses of the standard and the test as the layout of the method says, incubate (incubate step), then measure each zone diameter (or read each tube) and record them by dose.',
  fields: [
    { name: 'culture', label: 'Test organism (culture, from the inventory)', kind: 'item', itemKinds: ['culture'] },
    { name: 'medium', label: 'Medium lot (from the inventory)', kind: 'item', itemKinds: ['medium'] },
    { name: 'reader', label: 'Zone reader or photometer', kind: 'machine', types: ['zone reader', 'spectrophotometer'], optional: true },
    ...doses.map((k): BlockField => ({ name: `s${k}`, label: `Standard, dose ${k}: responses`, kind: 'number', unit: '$responseUnit', count: 8, minCount: 2, ...opt(k) })),
    ...doses.map((k): BlockField => ({ name: `t${k}`, label: `Test, dose ${k}: responses`, kind: 'number', unit: '$responseUnit', count: 8, minCount: 2, ...opt(k) })),
  ],
  settings: [
    { name: 'design', label: 'Design', kind: 'text', options: ['completely randomised', 'randomised blocks'] },
    { name: 'responseUnit', label: 'Unit of the responses (mm for zone diameters, AU for turbidity)', kind: 'text' },
    ...doses.map((k): BlockSetting => ({ name: `stdDose${k}`, label: `Standard, dose ${k} (lowest first, e.g. 1 IU/mL)`, kind: 'quantity', ...opt(k) })),
    ...doses.map((k): BlockSetting => ({ name: `testDose${k}`, label: `Test, dose ${k} at the assumed potency (lowest first)`, kind: 'quantity', ...opt(k) })),
    { name: 'assumedPotency', label: 'Potency assumed for the test (e.g. 1000 IU/mg)', kind: 'quantity' },
    { name: 'checkOn', label: 'The limit is checked on', kind: 'text', options: ['estimate', 'lower fiducial limit', 'upper fiducial limit'], optional: true },
    { name: 'precision', label: 'Precision: fiducial limits as % of the estimate (e.g. 95 to 105 %)', kind: 'limit', optional: true },
    { name: 'limit', label: 'Limits of the potency', kind: 'limit', optional: true },
  ],
  calcs: [
    { name: 'result', label: 'Potency', template: 'L13', args: {
      design: '$design', assumedPotency: '$assumedPotency', checkOn: '$checkOn?', precision: '$precision?', limit: '$limit?',
      standard: { doses: ['$stdDose1', '$stdDose2', '$stdDose3?'], responses: ['$s1', '$s2', '$s3?'] },
      test: { doses: ['$testDose1', '$testDose2', '$testDose3?'], responses: ['$t1', '$t2', '$t3?'] },
    } },
  ],
};
