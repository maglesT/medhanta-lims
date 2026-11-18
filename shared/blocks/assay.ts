import type { Block, BlockField, BlockSetting } from './format.js';

// Assay by external standard (L1), single standard or bracketing standards, for up to 3 sample preparations: each
// preparation's content from its responses, its weighed mass and its dilution (from the weigh and dilute steps
// before it), against the standard's mean response, weighed mass, potency and dilution. Per mass of sample (%, on a
// basis with the sample's own loss on drying or water) or per unit (with the average unit weight, as % of the label
// claim when the specification gives it). The reportable result is the mean of the preparations (T7), checked
// against the limit; the preparations' agreement (% RSD) may have its own limit, and every preparation the method
// sets must have its result (C2). The standard is picked from the lab inventory (a usable reference or working
// standard, LIMS-14): its potency and basis come with it and cannot be typed.
const preps = [1, 2, 3] as const;
const opt = (k: number) => (k > 1 ? { optional: true } : {});

export const assayFields = (unit: string): BlockField[] => preps.map((k) => (
  { name: `responses${k}`, label: `Sample preparation ${k}: responses`, kind: 'number', unit, count: 6, minCount: 1, ...opt(k) }));

/** The settings every assay shares: the preparations, the sample masses and flasks, per mass or per unit, basis, limits. */
export const sampleSettings: BlockSetting[] = [
  { name: 'preparations', label: 'Number of sample preparations', kind: 'text', options: ['1', '2', '3'] },
  ...preps.map((k): BlockSetting => ({ name: `sample${k}Mass`, label: `Sample preparation ${k}: mass weighed (its weigh step)`, kind: 'quantity', ...opt(k) })),
  { name: 'sampleVolume', label: 'Sample: first flask (volume the sample is dissolved in)', kind: 'quantity' },
  ...preps.map((k): BlockSetting => ({ name: `sample${k}Factor`, label: `Sample preparation ${k}: dilution factor after the first flask (its dilute step)`, kind: 'number', optional: true })),
  { name: 'per', label: 'Result per mass of sample (%) or per unit', kind: 'text', options: ['mass', 'unit'] },
  { name: 'averageWeight', label: 'Average unit weight (per unit)', kind: 'quantity', optional: true },
  { name: 'labelClaim', label: 'Label claim per unit (from the specification)', kind: 'quantity', optional: true },
  { name: 'basis', label: 'Result on the basis (per mass)', kind: 'text', options: ['dried', 'anhydrous', 'solvent-free', 'anhydrous and solvent-free'], optional: true },
  { name: 'sampleLod', label: 'Sample: loss on drying (dried basis)', kind: 'quantity', optional: true },
  { name: 'sampleWater', label: 'Sample: water content (anhydrous basis)', kind: 'quantity', optional: true },
  { name: 'sampleSolvents', label: 'Sample: residual solvents (solvent-free basis)', kind: 'quantity', optional: true },
  { name: 'limit', label: 'Limits of the result', kind: 'limit', optional: true },
  { name: 'agreementLimit', label: 'Agreement of the preparations: % RSD limit', kind: 'limit', optional: true },
];

/** The sample part of L1 for preparation k. */
export const sampleArgs = (k: number) => ({
  sample: { mass: `$sample${k}Mass`, averageUnitWeight: '$averageWeight?', dilution: { volume: '$sampleVolume', factor: `$sample${k}Factor?` } },
  per: '$per', labelClaim: '$labelClaim?',
  onBasis: { basis: '$basis?', lod: '$sampleLod?', water: '$sampleWater?', solvents: '$sampleSolvents?' },
});

/** The mean of the preparations (the reportable result) and the check that each preparation the method sets has its result. */
export const meanCalcs = (label: string): Block['calcs'] => [
  { name: 'result', label, template: 'T7', args: { readings: ['$prep1', '$prep2?', '$prep3?'], decimals: 1, limit: '$limit?', rsdLimit: '$agreementLimit?' } },
  { name: 'preparationsCheck', label: 'A result for every preparation', template: 'C2', args: { readings: ['$prep1', '$prep2?', '$prep3?'], required: '$preparations' } },
];

export const assay: Block = {
  id: 'assay', version: 1, name: 'Assay by external standard', checker: true,
  instruction: 'From the run, record the responses of the standard (and of the bracketing standards after the samples) and of each sample preparation. Pick the reference or working standard used: its potency and basis come from the inventory. The masses and dilutions come from the weigh and dilute steps.',
  fields: [
    { name: 'stdResponses', label: 'Standard: responses', kind: 'number', unit: '$responseUnit', count: 6, minCount: 1 },
    { name: 'stdResponsesAfter', label: 'Standard after the samples (bracketing): responses', kind: 'number', unit: '$responseUnit', count: 6, minCount: 1, optional: true },
    ...assayFields('$responseUnit'),
    { name: 'std', label: 'Reference or working standard used', kind: 'item', itemKinds: ['reference', 'working'] },
    { name: 'stdPotency', label: 'Standard: potency (from the inventory)', kind: 'number', unit: '%' },
    { name: 'stdBasis', label: 'Standard: basis of the potency (from the inventory)', kind: 'choice', options: ['as is', 'dried', 'anhydrous'] },
    { name: 'stdLod', label: 'Standard: loss on drying (potency on the dried basis, used as it is)', kind: 'number', unit: '%', optional: true },
    { name: 'stdWater', label: 'Standard: water content (potency on the anhydrous basis, used as it is)', kind: 'number', unit: '%', optional: true },
    { name: 'stdDried', label: 'Standard dried before weighing', kind: 'yes-no', optional: true },
  ],
  settings: [
    { name: 'mode', label: 'Standard', kind: 'text', options: ['external standard', 'bracketing'] },
    { name: 'response', label: 'Response read', kind: 'text', options: ['peak area', 'peak height', 'absorbance'] },
    { name: 'responseUnit', label: 'Unit of the responses (none for a peak area)', kind: 'text' },
    { name: 'stdMass', label: 'Standard: mass weighed (its weigh step)', kind: 'quantity' },
    { name: 'stdVolume', label: 'Standard: first flask (volume the standard is dissolved in)', kind: 'quantity' },
    { name: 'stdFactor', label: 'Standard: dilution factor after the first flask (its dilute step)', kind: 'number', optional: true },
    ...sampleSettings,
  ],
  calcs: [
    ...preps.map((k) => ({
      name: `prep${k}`, label: `Preparation ${k}`, template: 'L1',
      args: {
        mode: '$mode', response: '$response', sampleResponses: `$responses${k}`, standardResponses: '$stdResponses', standardResponsesAfter: '$stdResponsesAfter?',
        standard: { mass: '$stdMass', potency: '$stdPotency', potencyBasis: '$stdBasis', lod: '$stdLod?', water: '$stdWater?', driedBeforeUse: '$stdDried?',
          dilution: { volume: '$stdVolume', factor: '$stdFactor?' } },
        ...sampleArgs(k),
      },
    })),
    ...meanCalcs('Assay (mean of the preparations)'),
  ],
};
