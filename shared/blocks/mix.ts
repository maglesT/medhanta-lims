import type { Block } from './format.js';

// Prepare a solution or mixture by the method's recipe: shake, stir or sonicate at the speed shown; the method step's
// minimum time (minMinutes) stops the step being finished earlier. Master data is shared with production: a mixer
// granulator, a stirred vessel, an incubator shaker or a sieve shaker is not a lab stirrer.
export const mix: Block = {
  id: 'mix', version: 1, name: 'Prepare (mix, shake, sonicate)', checker: false,
  instruction: 'Mix at the speed shown for at least the time shown.',
  fields: [
    { name: 'machine', label: 'Stirrer, shaker or sonicator', kind: 'machine', types: ['stirrer', 'shaker', 'sonicat', 'vortex'], notTypes: ['vessel', 'incubator', 'sieve'] },
    { name: 'speed', label: 'Speed', kind: 'number', unit: 'rpm', optional: true },
  ],
  settings: [{ name: 'speedLimit', label: 'Speed limits', kind: 'limit', optional: true }],
  calcs: [{ name: 'speedCheck', label: 'Speed against limits', template: 'C1', args: { value: '$speed', limit: '$speedLimit' } }],
};
