import type { Block, BlockField, BlockSetting } from './format.js';
import { meanCalcs } from './assay.js';

// Water by Karl Fischer (L7), volumetric (the titre × the water equivalent F of the reagent, from the step or record
// that standardised it) or coulometric (the water the instrument reads), less the blank, for up to 3 determinations;
// the mean is the result.
const dets = [1, 2, 3] as const;
const opt = (k: number) => (k > 1 ? { optional: true } : {});

export const waterKf: Block = {
  id: 'water-kf', version: 1, name: 'Water by Karl Fischer', checker: true,
  instruction: 'Titrate the solvent to the end point, add the weighed sample and titrate again. Record the titre (volumetric) or the water found (coulometric) of each determination, and the blank when the method has one.',
  fields: [
    { name: 'titrator', label: 'Karl Fischer titrator', kind: 'machine', types: ['karl fischer'] },
    ...dets.map((k): BlockField => ({ name: `reading${k}`, label: `Determination ${k}: titre or water found`, kind: 'number', unit: '$readingUnit', ...opt(k) })),
    { name: 'blank', label: 'Blank', kind: 'number', unit: '$readingUnit', optional: true },
  ],
  settings: [
    { name: 'mode', label: 'Method', kind: 'text', options: ['volumetric', 'coulometric'] },
    { name: 'readingUnit', label: 'Unit of the readings (mL volumetric; µg or mg coulometric)', kind: 'text' },
    { name: 'waterEquivalent', label: 'Water equivalent F of the reagent (volumetric: its standardisation step)', kind: 'quantity', optional: true },
    { name: 'preparations', label: 'Number of determinations', kind: 'text', options: ['1', '2', '3'] },
    ...dets.map((k): BlockSetting => ({ name: `sample${k}Mass`, label: `Determination ${k}: sample mass (its weigh step)`, kind: 'quantity', ...opt(k) })),
    { name: 'limit', label: 'Limits of the water content', kind: 'limit', optional: true },
    { name: 'agreementLimit', label: 'Agreement of the determinations: % RSD limit', kind: 'limit', optional: true },
  ],
  calcs: [
    ...dets.map((k) => ({
      name: `prep${k}`, label: `Determination ${k}`, template: 'L7',
      // The reading is the titre (volumetric) or the water found (coulometric); the other input is not used.
      args: { mode: '$mode', sample: `$sample${k}Mass`, volume: `$reading${k}`, water: `$reading${k}`, factor: '$waterEquivalent?', blank: '$blank?' },
    })),
    ...meanCalcs('Water (mean of the determinations)'),
  ],
};
