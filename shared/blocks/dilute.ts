import type { Block } from './format.js';

// Dilute: from a solution, take the aliquot with a pipette into a volumetric flask and make up to volume; up to two
// more dilutions after it. The method gives the volumes; the analyst confirms each was done and names the glassware.
// The overall dilution factor (L21) goes to the result step.
export const dilute: Block = {
  id: 'dilute', version: 1, name: 'Dilute', checker: false,
  instruction: 'Pipette the volume shown into the volumetric flask, make up to volume with the diluent and mix. Repeat for each further dilution shown.',
  fields: [
    { name: 'glassware', label: 'Pipettes and flasks used (IDs)', kind: 'text', optional: true },
    { name: 'classA', label: 'Class A volumetric glassware used', kind: 'yes-no' },
    { name: 'done', label: 'Each dilution made up to volume and mixed', kind: 'yes-no' },
  ],
  settings: [
    { name: 'from', label: 'Solution diluted', kind: 'text' },
    { name: 'diluent', label: 'Diluent', kind: 'text' },
    { name: 'aliquot1', label: 'Aliquot (1st dilution)', kind: 'quantity' },
    { name: 'volume1', label: 'Flask volume (1st dilution)', kind: 'quantity' },
    { name: 'aliquot2', label: 'Aliquot (2nd dilution)', kind: 'quantity', optional: true },
    { name: 'volume2', label: 'Flask volume (2nd dilution)', kind: 'quantity', optional: true },
    { name: 'aliquot3', label: 'Aliquot (3rd dilution)', kind: 'quantity', optional: true },
    { name: 'volume3', label: 'Flask volume (3rd dilution)', kind: 'quantity', optional: true },
  ],
  calcs: [
    { name: 'glasswareCheck', label: 'Glassware and make-up', template: 'C4', args: { question: 'Dilution made as written', answers: ['$classA', '$done'], expected: ['yes'] } },
    { name: 'factor', label: 'Dilution factor', template: 'L21',
      args: { steps: [{ aliquot: '$aliquot1', volume: '$volume1' }, { aliquot: '$aliquot2?', volume: '$volume2?' }, { aliquot: '$aliquot3?', volume: '$volume3?' }] } },
  ],
};
