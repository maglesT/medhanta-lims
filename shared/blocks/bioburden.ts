import type { Block } from './format.js';
import { countSettings, levelArgs, plateFields } from './count.js';

// Bioburden (L11): the viable count on a product, component or in-process sample before sterilisation, by pour plate,
// spread plate or membrane filtration; the medium lot from the inventory; the count as the count step works it out,
// multiplied by the recovery (correction) factor of the validated method when it has one; against the limit.
export const bioburden: Block = {
  id: 'bioburden', version: 1, name: 'Bioburden', checker: true,
  instruction: 'Plate or filter the sample as the method says, incubate (incubate step), then count the colonies of each dilution (or mark them too numerous to count). Record the negative control.',
  fields: [
    { name: 'medium', label: 'Medium lot (from the inventory)', kind: 'item', itemKinds: ['medium'] },
    ...plateFields,
    { name: 'negativeControl', label: 'Negative control', kind: 'choice', options: ['no growth', 'growth'] },
  ],
  settings: [
    { name: 'technique', label: 'Technique', kind: 'text', options: ['pour plate', 'spread plate', 'membrane filtration'] },
    ...countSettings,
    { name: 'recoveryFactor', label: 'Recovery (correction) factor of the validated method', kind: 'number', optional: true },
  ],
  calcs: [
    { name: 'result', label: 'Bioburden', template: 'L11', args: {
      mode: 'plate count', levels: levelArgs, amount: '$amount?', per: '$per', countable: '$countable', acceptance: '$acceptance', limit: '$limit?', negativeControl: '$negativeControl', recoveryFactor: '$recoveryFactor?' } },
  ],
};
