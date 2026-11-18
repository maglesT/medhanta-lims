import type { Block, BlockField, BlockSetting } from './format.js';
import { meanCalcs } from './assay.js';

// Titration (L6), direct or back, for up to 3 sample preparations: the titre of each (less the blank), the VS's
// stated molarity times its factor (the VS picked from the lab inventory: its factor, from its checked standardisation,
// comes with it and cannot be typed, LIMS-13; safety rule S5:
// the equivalence follows the VS's molarity, and a back titration without a blank uses each VS's own factor), the
// equivalence (mg per mL of VS of the molarity it is written for), an aliquot titrated, % of the sample (on a basis)
// or per unit. The mean of the preparations is the result.
const preps = [1, 2, 3] as const;
const opt = (k: number) => (k > 1 ? { optional: true } : {});

export const titration: Block = {
  id: 'titration', version: 1, name: 'Titration', checker: true,
  instruction: 'Titrate each sample preparation with the volumetric solution (VS) to the end point the method gives, and record the titre. Record the blank titration when the method has one, and pick each VS used from the inventory: its factor comes with it.',
  fields: [
    { name: 'titrator', label: 'Titrator', kind: 'machine', types: ['titrator'], notTypes: ['karl fischer'], optional: true },
    { name: 'vs', label: 'VS titrated', kind: 'item', itemKinds: ['vs'] },
    { name: 'vsFactor', label: 'VS titrated: factor (from the inventory)', kind: 'text' },
    ...preps.map((k): BlockField => ({ name: `titre${k}`, label: `Preparation ${k}: titre`, kind: 'number', unit: 'mL', capture: 'titrator', ...opt(k) })),
    { name: 'blank', label: 'Blank titration: titre', kind: 'number', unit: 'mL', optional: true },
    { name: 'excess', label: 'VS added in excess (back titration)', kind: 'item', itemKinds: ['vs'], optional: true },
    { name: 'excessFactor', label: 'VS added in excess: factor (from the inventory)', kind: 'text', optional: true },
  ],
  settings: [
    { name: 'mode', label: 'Titration', kind: 'text', options: ['direct', 'back'] },
    { name: 'titrant', label: 'VS titrated (e.g. 0.1 M sodium hydroxide)', kind: 'text' },
    { name: 'titrantMolarity', label: 'VS titrated: stated molarity', kind: 'quantity' },
    { name: 'equivalence', label: 'Equivalence: mg of substance per mL of VS', kind: 'quantity' },
    { name: 'equivalenceMolarity', label: 'Equivalence: the molarity it is written for', kind: 'quantity' },
    { name: 'equivalenceOf', label: 'Equivalence written for (back titration)', kind: 'text', options: ['titrant', 'excess'], optional: true },
    { name: 'excessVolume', label: 'VS added in excess: volume (back titration without a blank)', kind: 'quantity', optional: true },
    { name: 'excessMolarity', label: 'VS added in excess: stated molarity', kind: 'quantity', optional: true },
    { name: 'reactionRatio', label: 'Back titration: mol of the excess VS one mol of titrant takes up', kind: 'number', optional: true },
    { name: 'aliquotTotal', label: 'Aliquot titrated: the whole sample solution', kind: 'quantity', optional: true },
    { name: 'aliquotTaken', label: 'Aliquot titrated: the part taken', kind: 'quantity', optional: true },
    { name: 'preparations', label: 'Number of sample preparations', kind: 'text', options: ['1', '2', '3'] },
    ...preps.map((k): BlockSetting => ({ name: `sample${k}Mass`, label: `Sample preparation ${k}: mass weighed (its weigh step)`, kind: 'quantity', ...opt(k) })),
    { name: 'report', label: 'Result as', kind: 'text', options: ['%', 'mg per unit'], optional: true },
    { name: 'averageWeight', label: 'Average unit weight (per unit)', kind: 'quantity', optional: true },
    { name: 'basis', label: 'Result on the basis', kind: 'text', options: ['dried', 'anhydrous', 'ignited'], optional: true },
    { name: 'basisLoss', label: 'Sample: loss on drying, water or loss on ignition for the basis', kind: 'quantity', optional: true },
    { name: 'limit', label: 'Limits of the result', kind: 'limit', optional: true },
    { name: 'agreementLimit', label: 'Agreement of the preparations: % RSD limit', kind: 'limit', optional: true },
  ],
  calcs: [
    ...preps.map((k) => ({
      name: `prep${k}`, label: `Preparation ${k}`, template: 'L6',
      args: {
        mode: '$mode', sample: `$sample${k}Mass`,
        titrant: { volume: `$titre${k}`, molarity: '$titrantMolarity', factor: '$vsFactor' }, blank: '$blank?',
        excess: { volume: '$excessVolume?', molarity: '$excessMolarity?', factor: '$excessFactor?' }, reactionRatio: '$reactionRatio?',
        equivalence: { mass: '$equivalence', molarity: '$equivalenceMolarity', of: '$equivalenceOf?' },
        aliquot: { total: '$aliquotTotal?', taken: '$aliquotTaken?' },
        report: '$report?', unitWeight: '$averageWeight?', basis: { as: '$basis?', loss: '$basisLoss?' },
      },
    })),
    ...meanCalcs('Content (mean of the preparations)'),
  ],
};
