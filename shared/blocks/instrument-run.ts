import type { Block } from './format.js';

// Run the instrument: which instrument (fit for use, LIMS-12), the column (a usable one from the lab inventory, LIMS-12;
// each run that names it counts one use in its usage log), and the run or sequence id that
// links this worksheet to the instrument's own raw data (the CDS stays the original record, LIMS-49). The responses
// are recorded in the system suitability and result steps.
export const instrumentRun: Block = {
  id: 'instrument-run', version: 1, name: 'Instrument run', checker: false,
  instruction: 'Set up the instrument with the conditions shown, equilibrate, and run the sequence. Record the run id.',
  fields: [
    { name: 'instrument', label: 'Instrument', kind: 'machine' },
    { name: 'column', label: 'Column (from the inventory)', kind: 'item', itemKinds: ['column'], optional: true },
    { name: 'runId', label: 'Run or sequence id (in the instrument software)', kind: 'text' },
    { name: 'asWritten', label: 'Conditions as written in the method', kind: 'yes-no' },
  ],
  settings: [
    { name: 'conditions', label: 'Conditions (column, mobile phase, flow, detection …)', kind: 'text' },
  ],
  calcs: [
    { name: 'conditionsCheck', label: 'Conditions as written', template: 'C4', args: { question: 'Conditions as written in the method', answers: ['$asWritten'], expected: ['yes'] } },
  ],
};
