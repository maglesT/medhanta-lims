import type { Block } from './format.js';

// System suitability (LIMS-16): the method's fixed checks on the standard injections, each against its limit. A
// failed check means the run is not valid: the result steps after it cannot be used without a deviation note.
export const systemSuitability: Block = {
  id: 'system-suitability', version: 1, name: 'System suitability', checker: true,
  instruction: 'From the replicate injections of the standard, record the responses and the values the method checks.',
  fields: [
    { name: 'responses', label: 'Responses of the replicate injections', kind: 'number', unit: 'units', count: 6, minCount: 5 },
    { name: 'tailing', label: 'Tailing factor', kind: 'number', unit: 'units', optional: true },
    { name: 'plates', label: 'Theoretical plates', kind: 'number', unit: 'units', optional: true },
    { name: 'resolution', label: 'Resolution', kind: 'number', unit: 'units', optional: true },
    { name: 'signalToNoise', label: 'Signal-to-noise ratio', kind: 'number', unit: 'units', optional: true },
  ],
  settings: [
    { name: 'rsdLimit', label: '% RSD of the responses: limit', kind: 'limit' },
    { name: 'tailingLimit', label: 'Tailing factor limit', kind: 'limit', optional: true },
    { name: 'platesLimit', label: 'Theoretical plates limit', kind: 'limit', optional: true },
    { name: 'resolutionLimit', label: 'Resolution limit', kind: 'limit', optional: true },
    { name: 'signalToNoiseLimit', label: 'Signal-to-noise limit', kind: 'limit', optional: true },
  ],
  calcs: [
    { name: 'precision', label: 'Replicate injections', template: 'T7', args: { readings: '$responses', rsdLimit: '$rsdLimit' } },
    { name: 'tailingCheck', label: 'Tailing factor', template: 'C1', args: { value: '$tailing', limit: '$tailingLimit' } },
    { name: 'platesCheck', label: 'Theoretical plates', template: 'C1', args: { value: '$plates', limit: '$platesLimit' } },
    { name: 'resolutionCheck', label: 'Resolution', template: 'C1', args: { value: '$resolution', limit: '$resolutionLimit' } },
    { name: 'signalToNoiseCheck', label: 'Signal-to-noise ratio', template: 'C1', args: { value: '$signalToNoise', limit: '$signalToNoiseLimit' } },
  ],
};
