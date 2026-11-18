import type { Block } from './format.js';

// pH (L10): the reading with the temperature of the sample; refused when the meter was calibrated more than 2 °C from
// the sample's temperature (Ph.Int 1.13). The reading is a plain number: its unit setting is left empty ("none").
export const ph: Block = {
  id: 'ph', version: 1, name: 'pH', checker: false,
  instruction: 'Calibrate the pH meter with the buffers the method gives, at the temperature of the sample. Measure the sample solution and record the reading and the temperature.',
  fields: [
    { name: 'meter', label: 'pH meter', kind: 'machine', types: ['ph meter'] },
    { name: 'reading', label: 'pH reading', kind: 'number', unit: '$readingUnit', capture: 'ph' },
    { name: 'temperature', label: 'Temperature of the sample', kind: 'number', unit: '°C', capture: 'ph-temperature' },
    { name: 'calibrationTemperature', label: 'Temperature at calibration', kind: 'number', unit: '°C' },
  ],
  settings: [
    { name: 'readingUnit', label: 'Unit of the reading (none: pH is a plain number)', kind: 'text' },
    { name: 'limit', label: 'Limits of the pH', kind: 'limit', optional: true },
  ],
  calcs: [{ name: 'result', label: 'pH', template: 'L10', args: { mode: 'pH', reading: '$reading', temperature: '$temperature', calibrationTemperature: '$calibrationTemperature', limit: '$limit?' } }],
};
