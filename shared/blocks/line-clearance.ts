import type { Block } from './format.js';

// Bench clearance (optional in a method): the bench and instrument are clear of the previous analysis before this one
// starts, by the analyst and checked by a second person. The cleaning facts come from the Logbook while its link
// answers (server/pull.ts); without it they are typed from the status label.
export const lineClearance: Block = {
  id: 'line-clearance', version: 1, name: 'Bench clearance', gmp: 'line-clearance', checker: true,
  instruction: 'Check the bench and instrument before the analysis starts: nothing of the previous sample, clean, and no solutions or documents of other analyses.',
  fields: [
    { name: 'room', label: 'Room', kind: 'room' },
    { name: 'previous', label: 'Previous sample or analysis', kind: 'text', optional: true },
    { name: 'previousRemoved', label: 'Previous samples and solutions removed', kind: 'yes-no' },
    { name: 'clean', label: 'Area and equipment clean (status label)', kind: 'yes-no' },
    { name: 'cleanedOn', label: 'Cleaned on (date and time on the label)', kind: 'text' },
    { name: 'cleanedBy', label: 'Cleaned by (name on the label)', kind: 'text' },
    { name: 'noOther', label: 'No solutions or documents of other analyses', kind: 'yes-no' },
  ],
  settings: [],
  calcs: [
    { name: 'clearance', label: 'Bench clear', template: 'C4',
      args: { question: 'Bench clear', answers: ['$previousRemoved', '$clean', '$noOther'], expected: ['yes'] } },
  ],
};
