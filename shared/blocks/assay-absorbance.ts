import type { Block } from './format.js';
import { assayFields, meanCalcs, sampleArgs, sampleSettings } from './assay.js';

// Assay by specific absorbance (L1, UV, no reference standard), for up to 3 sample preparations: the content from
// the absorbance, the monograph's figure and the cell's path length. Safety rule S1: the method says whether the figure
// is the specific absorbance A(1 %, 1 cm) or the absorptivity (per g/L), which differ 10 times; the path length is
// never assumed. Per mass or per unit as the assay block; the mean of the preparations is the result.
export const assayAbsorbance: Block = {
  id: 'assay-absorbance', version: 1, name: 'Assay by specific absorbance (UV)', checker: true,
  instruction: 'Measure the absorbance of each sample preparation at the wavelength of the method, against the blank, in the cell of the stated path length. Record the readings of each preparation.',
  fields: [
    { name: 'spectrophotometer', label: 'Spectrophotometer', kind: 'machine', types: ['spectrophotometer'] },
    ...assayFields('AU').map((f) => ({ ...f, count: 3, label: f.label.replace('responses', 'absorbance readings') })),
  ],
  settings: [
    { name: 'specificAbsorbance', label: 'Specific absorbance figure of the monograph (e.g. 715)', kind: 'number' },
    { name: 'form', label: 'The figure is (safety rule S1)', kind: 'text', options: ['A(1 %, 1 cm)', 'absorptivity'] },
    { name: 'pathLength', label: 'Path length of the cell', kind: 'quantity' },
    ...sampleSettings,
  ],
  calcs: [
    ...[1, 2, 3].map((k) => ({
      name: `prep${k}`, label: `Preparation ${k}`, template: 'L1',
      args: {
        mode: 'specific absorbance', sampleResponses: `$responses${k}`,
        specificAbsorbance: { value: '$specificAbsorbance', form: '$form', pathLength: '$pathLength' },
        ...sampleArgs(k),
      },
    })),
    ...meanCalcs('Assay (mean of the preparations)'),
  ],
};
