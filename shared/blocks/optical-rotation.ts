import type { Block } from './format.js';

// Specific optical rotation (L10): the observed angle (corrected for the blank, with its sign) in a tube of the stated
// path length (safety rule S12: with its unit; a tube outside 0.1-5 dm is refused), of a solution (the weighed mass in
// its flask, or the stated concentration), a neat liquid or a solution by mass (with the relative density), on the
// dried or anhydrous basis when the method says so. The temperature of the reading is recorded and checked.
export const opticalRotation: Block = {
  id: 'optical-rotation', version: 1, name: 'Specific optical rotation', checker: true,
  instruction: 'Set the polarimeter to zero with the blank. Fill the tube with the solution, read the angle of rotation at the temperature the method gives, and record it with its sign, corrected for the blank.',
  fields: [
    { name: 'polarimeter', label: 'Polarimeter', kind: 'machine', types: ['polarimeter'] },
    { name: 'angle', label: 'Observed angle (corrected for the blank, with its sign)', kind: 'number', unit: '°' },
    { name: 'temperature', label: 'Temperature of the reading', kind: 'number', unit: '°C' },
  ],
  settings: [
    { name: 'form', label: 'Sample measured as', kind: 'text', options: ['solution', 'neat liquid', 'solution by mass'] },
    { name: 'pathLength', label: 'Path length of the tube (with its unit, e.g. 1 dm)', kind: 'quantity' },
    { name: 'sampleMass', label: 'Solution: mass weighed (its weigh step)', kind: 'quantity', optional: true },
    { name: 'volume', label: 'Solution: volume it is dissolved in', kind: 'quantity', optional: true },
    { name: 'concentration', label: 'Solution: stated concentration (g per 100 mL), instead of mass and volume', kind: 'quantity', optional: true },
    { name: 'massPercent', label: 'Solution by mass: g per 100 g', kind: 'quantity', optional: true },
    { name: 'density', label: 'Relative density (neat liquid, solution by mass)', kind: 'quantity', optional: true },
    { name: 'basis', label: 'Result on the basis', kind: 'text', options: ['dried', 'anhydrous'], optional: true },
    { name: 'basisLoss', label: 'Sample: loss on drying or water for the basis', kind: 'quantity', optional: true },
    { name: 'temperatureLimit', label: 'Temperature limits', kind: 'limit', optional: true },
    { name: 'limit', label: 'Limits of the specific rotation', kind: 'limit', optional: true },
  ],
  calcs: [
    { name: 'temperatureCheck', label: 'Temperature', template: 'C1', args: { value: '$temperature', limit: '$temperatureLimit?' } },
    {
      name: 'result', label: 'Specific optical rotation', template: 'L10',
      args: { mode: 'specific rotation', angle: '$angle', pathLength: '$pathLength', form: '$form', concentration: '$concentration?',
        sample: { mass: '$sampleMass?', volume: '$volume?' }, massPercent: '$massPercent?', density: '$density?',
        basis: { as: '$basis?', loss: '$basisLoss?' }, limit: '$limit?' },
    },
  ],
};
