import type { Block } from './format.js';

// Weigh a sample or a standard on a lab balance: the net mass read from the tared balance. When the method gives a
// target ("about 50 mg, accurately weighed"), the mass is checked against it ± the tolerance (C1). A typed weighing is
// checked by a second person (LIMS-32); the balance must be fit for use (LIMS-12). A production platform balance is
// not a lab balance.
export const weigh: Block = {
  id: 'weigh', version: 1, name: 'Weigh', gmp: 'weighing', checker: true,
  instruction: 'Tare the container on the balance, add the material and record the net mass shown.',
  fields: [
    { name: 'balance', label: 'Balance', kind: 'machine', types: ['balance'], notTypes: ['platform'] },
    { name: 'mass', label: 'Net mass', kind: 'number', unit: '$unit', capture: 'balance' },
  ],
  settings: [
    { name: 'what', label: 'What is weighed (e.g. sample, reference standard)', kind: 'text' },
    { name: 'unit', label: 'Unit', kind: 'text', options: ['mg', 'g'] },
    { name: 'target', label: 'Target mass', kind: 'quantity', optional: true },
    { name: 'tolerance', label: 'Tolerance (± %)', kind: 'number', optional: true },
  ],
  calcs: [
    { name: 'massCheck', label: 'Mass against target', template: 'C1', args: { value: '$mass', around: { centre: '$target', name: 'target', plusMinusPercent: '$tolerance' } } },
  ],
};
