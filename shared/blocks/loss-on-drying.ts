import type { Block } from './format.js';

// Loss on drying, loss on ignition, residue on ignition, sulfated ash (L8): the empty container (tare), the container
// with the sample before, and after drying or ignition: weighed here (two weighings for constant mass), or the last
// weighing of the dry-to-constant-mass step before it. The last weighing after is used.
export const lossOnDrying: Block = {
  id: 'loss-on-drying', version: 1, name: 'Loss on drying / residue on ignition', checker: true,
  instruction: 'Weigh the empty container, then the container with the sample. Dry or ignite as the method says, cool in a desiccator and weigh again (twice, when the method asks for constant mass).',
  fields: [
    { name: 'balance', label: 'Balance', kind: 'machine', types: ['balance'], notTypes: ['platform'] },
    { name: 'oven', label: 'Oven or furnace (dried in this step)', kind: 'machine', types: ['oven', 'furnace'], optional: true },
    { name: 'tare', label: 'Empty container', kind: 'number', unit: 'g' },
    { name: 'before', label: 'Container with the sample, before', kind: 'number', unit: 'g' },
    { name: 'after1', label: 'Container with the sample, after', kind: 'number', unit: 'g', optional: true },
    { name: 'after2', label: 'Container with the sample, after (again, for constant mass)', kind: 'number', unit: 'g', optional: true },
  ],
  settings: [
    { name: 'mode', label: 'Test', kind: 'text', options: ['loss on drying', 'loss on ignition', 'residue on ignition', 'sulfated ash', 'residue'] },
    { name: 'conditions', label: 'Conditions (e.g. 105 °C, 3 hours)', kind: 'text', optional: true },
    { name: 'dried', label: 'Container with the sample after drying (the dry-to-constant-mass step)', kind: 'quantity', optional: true },
    { name: 'maxChange', label: 'Constant mass: largest change between the two weighings after', kind: 'quantity', optional: true },
    { name: 'limit', label: 'Limits of the result', kind: 'limit', optional: true },
  ],
  calcs: [{
    name: 'result', label: 'Result', template: 'L8',
    args: { mode: '$mode', tare: '$tare', before: '$before', after: ['$dried?', '$after1?', '$after2?'], constantMass: { maxChange: '$maxChange?' }, limit: '$limit?' },
  }],
};
