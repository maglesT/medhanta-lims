import type { Block } from './format.js';

// A value read at intervals until the test ends (a bath, incubator or oven temperature during a long test; solution
// stability readings): one round every N minutes, each against its limits, until the analyst says the test is over.
export const periodicCheck: Block = {
  id: 'periodic-check', version: 1, name: 'Read a value at intervals', checker: false, stop: 'finished',
  periodic: { maxMinutes: 1440 },
  instruction: 'At each interval, read the value and record it. When the test is over, record that it is finished.',
  fields: [
    { name: 'reading', label: 'Reading', kind: 'number', unit: '$unit' },
    { name: 'testDone', label: 'Test finished', kind: 'yes-no' },
  ],
  settings: [
    { name: 'what', label: 'What is read', kind: 'text' },
    { name: 'unit', label: 'Unit', kind: 'text' },
    { name: 'limit', label: 'Limits', kind: 'limit' },
  ],
  calcs: [
    { name: 'readingCheck', label: 'Reading against limits', template: 'C1', args: { value: '$reading', limit: '$limit' } },
    { name: 'finished', label: 'Test finished', template: 'C4', args: { question: 'Test finished', answers: ['$testDone'], expected: ['yes'] } },
  ],
};
