import type { Block } from './format.js';

// Dry (or ignite) to constant mass: used as repeat-until, a new round of drying, cooling in a desiccator and weighing
// until the mass has not changed by more than the largest change allowed since the previous round (F2 "no further
// change"), as the pharmacopoeia defines constant mass. A lab oven or furnace: master data's production dryers (fluid
// bed, tray, spray ...) are not offered. The loss or residue is worked out by the result step.
export const dryConstant: Block = {
  id: 'dry-constant', version: 1, name: 'Dry to constant mass', checker: false, stop: 'constant',
  instruction: 'Dry (or ignite) at the conditions shown, cool in a desiccator, weigh, and record the mass of the container with the sample.',
  fields: [
    { name: 'machine', label: 'Oven or furnace', kind: 'machine', types: ['oven', 'furnace'] },
    { name: 'weight', label: 'Container with sample', kind: 'number', unit: 'g' },
  ],
  settings: [
    { name: 'conditions', label: 'Drying conditions (e.g. 105 °C, 3 hours)', kind: 'text', optional: true },
    { name: 'maxChange', label: 'Largest change between weighings', kind: 'quantity' },
  ],
  calcs: [{ name: 'constant', label: 'No further change', template: 'F2', args: { previous: '$prev.weight', current: '$weight', limit: { maxChange: '$maxChange' } } }],
};
