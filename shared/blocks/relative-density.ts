import type { Block } from './format.js';

// Relative density or weight per mL by pycnometer (L10): the empty pycnometer, filled with water and filled with the
// sample, at the temperature the method gives (recorded and checked); the weight per mL with the density of water at
// that temperature (from the reference table).
export const relativeDensity: Block = {
  id: 'relative-density', version: 1, name: 'Relative density (pycnometer)', checker: true,
  instruction: 'Weigh the clean, dry pycnometer, then filled with water, then filled with the sample, each at the temperature the method gives.',
  fields: [
    { name: 'balance', label: 'Balance', kind: 'machine', types: ['balance'], notTypes: ['platform'] },
    { name: 'empty', label: 'Empty pycnometer', kind: 'number', unit: 'g' },
    { name: 'withWater', label: 'Pycnometer filled with water', kind: 'number', unit: 'g' },
    { name: 'withSample', label: 'Pycnometer filled with the sample', kind: 'number', unit: 'g' },
    { name: 'temperature', label: 'Temperature', kind: 'number', unit: '°C' },
  ],
  settings: [
    { name: 'mode', label: 'Result', kind: 'text', options: ['relative density', 'weight per mL'] },
    { name: 'waterDensity', label: 'Density of water at the temperature (weight per mL)', kind: 'quantity', optional: true },
    { name: 'temperatureLimit', label: 'Temperature limits', kind: 'limit', optional: true },
    { name: 'limit', label: 'Limits of the result', kind: 'limit', optional: true },
  ],
  calcs: [
    { name: 'temperatureCheck', label: 'Temperature', template: 'C1', args: { value: '$temperature', limit: '$temperatureLimit?' } },
    { name: 'result', label: 'Result', template: 'L10',
      args: { mode: '$mode', empty: '$empty', withWater: '$withWater', withSample: '$withSample', waterDensity: '$waterDensity?', temperature: '$temperature', limit: '$limit?' } },
  ],
};
