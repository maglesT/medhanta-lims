import type { Block } from './format.js';
import { COMPLIES } from '../templates/index.js';

// Complies / does not comply (owner 21 Nov 2026): a test whose result is a judgement, not a number: description,
// identification, a visual check of packing material. The analyst examines the sample against what the specification
// says it must show (its `conforms` setting, written `{ spec: 'conforms' }`, brings the spec test's own words) and picks one answer.
// The result is the word (template L35); "Does not comply" fails it, so an OOS opens as for a number out of its limit.
export const complies: Block = {
  id: 'complies', version: 1, name: 'Complies / does not comply', checker: false,
  instruction: 'Examine the sample against the requirement and pick Complies or Does not comply. Write what you saw in a note when it does not comply.',
  fields: [{ name: 'answer', label: 'Result', kind: 'choice', options: [...COMPLIES] }],
  settings: [
    { name: 'what', label: 'What is examined (e.g. Description)', kind: 'text' },
    { name: 'conforms', label: 'What the sample must show (the specification gives it)', kind: 'text', optional: true },
  ],
  calcs: [{ name: 'result', label: 'Complies or not', template: 'L35', args: { answer: '$answer', requirement: '$conforms?', what: '$what' } }],
};
