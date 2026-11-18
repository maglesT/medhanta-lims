import type { Block } from './format.js';
import { CDS_PEAK } from './assay.js';

// System suitability (LIMS-16): the method's fixed checks on the standard injections, each against its limit. A
// failed check means the run is not valid: the result steps after it cannot be used without a deviation note.
export const systemSuitability: Block = {
  id: 'system-suitability', version: 1, name: 'System suitability', checker: true,
  instruction: 'Import the CDS result file of the run: the responses of the replicate injections of the standard and the values the method checks come from it. If it cannot be exported, type them from the CDS report; a second person checks them.',
  fields: [
    { name: 'responses', label: 'Responses of the replicate injections', kind: 'number', unit: 'units', count: 6, minCount: 5, capture: 'cds' },
    { name: 'tailing', label: 'Tailing factor', kind: 'number', unit: 'units', optional: true, capture: 'cds' },
    { name: 'plates', label: 'Theoretical plates', kind: 'number', unit: 'units', optional: true, capture: 'cds' },
    { name: 'resolution', label: 'Resolution', kind: 'number', unit: 'units', optional: true, capture: 'cds' },
    { name: 'signalToNoise', label: 'Signal-to-noise ratio', kind: 'number', unit: 'units', optional: true, capture: 'cds' },
  ],
  settings: [
    { name: 'rsdLimit', label: '% RSD of the responses: limit', kind: 'limit' },
    { name: 'tailingLimit', label: 'Tailing factor limit', kind: 'limit', optional: true },
    { name: 'platesLimit', label: 'Theoretical plates limit', kind: 'limit', optional: true },
    { name: 'resolutionLimit', label: 'Resolution limit', kind: 'limit', optional: true },
    { name: 'signalToNoiseLimit', label: 'Signal-to-noise limit', kind: 'limit', optional: true },
    CDS_PEAK,
  ],
  calcs: [
    { name: 'precision', label: 'Replicate injections', template: 'T7', args: { readings: '$responses', rsdLimit: '$rsdLimit' } },
    { name: 'tailingCheck', label: 'Tailing factor', template: 'C1', args: { value: '$tailing', limit: '$tailingLimit' } },
    { name: 'platesCheck', label: 'Theoretical plates', template: 'C1', args: { value: '$plates', limit: '$platesLimit' } },
    { name: 'resolutionCheck', label: 'Resolution', template: 'C1', args: { value: '$resolution', limit: '$resolutionLimit' } },
    { name: 'signalToNoiseCheck', label: 'Signal-to-noise ratio', template: 'C1', args: { value: '$signalToNoise', limit: '$signalToNoiseLimit' } },
  ],
};
