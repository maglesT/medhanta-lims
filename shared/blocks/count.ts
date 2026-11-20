import type { Block, BlockField, BlockSetting } from './format.js';

// Count colonies (L11, library 2b): the colonies on each plate (or membrane) of up to 3 dilutions, or "too numerous to
// count"; the dilution with the highest count within the method's counting range (TAMC fewer than 250, TYMC fewer than
// 50 per plate, or the range the method names) gives mean × dilution ÷ amount plated; "less than" when none grows at
// the lowest dilution. Or the most-probable-number method (3 tubes at 3 levels, the published table). The result is
// checked against the limit with its alert and action levels (C1 tiers); a criterion 10^n is read as NMT 2 × 10^n.
const levels = [1, 2, 3] as const;
const opt = (k: number) => (k > 1 ? { optional: true } : {});

/** The plates of up to 3 dilutions: colonies per plate, or too numerous to count. */
export const plateFields: BlockField[] = levels.flatMap((k): BlockField[] => [
  { name: `plates${k}`, label: `Dilution ${k}: colonies on each plate`, kind: 'number', unit: 'CFU', count: 4, minCount: 1, optional: true },
  { name: `tntc${k}`, label: `Dilution ${k}: too numerous to count`, kind: 'yes-no', optional: true },
]);
/** The dilutions the method sets, the amount plated, per what, the counting range, how the limit is read, the limit. */
export const countSettings: BlockSetting[] = [
  ...levels.map((k): BlockSetting => ({ name: `dilution${k}`, label: `Dilution ${k}: dilution factor (1 undiluted, 10 for 1 in 10)`, kind: 'number', ...opt(k) })),
  { name: 'amount', label: 'Amount plated or filtered at each dilution (mL; air sampled for per m³)', kind: 'quantity', optional: true },
  { name: 'per', label: 'Result per', kind: 'text', options: ['CFU/g', 'CFU/mL', 'CFU/m³', 'CFU'] },
  { name: 'countable', label: 'Counting range', kind: 'text', options: ['TAMC: fewer than 250 per plate', 'TYMC: fewer than 50 per plate', '30 to 300 per plate', '25 to 250 per plate', '15 to 150 per plate', 'membrane: up to 100'] },
  { name: 'acceptance', label: 'How the limit is read (10^n: a limit of 10^n is met up to 2 × 10^n, so 1000 CFU/g up to 2000)', kind: 'text', options: ['10^n', 'as written'] },
  { name: 'limit', label: 'Limit as the specification writes it (with the alert level when it has one)', kind: 'limit', optional: true },
];
/** The L11 plate-count levels, by number (a level whose dilution the method leaves out is not used). */
export const levelArgs = Object.fromEntries(levels.map((k) => [String(k), { dilution: k === 1 ? '$dilution1' : `$dilution${k}?`, counts: `$plates${k}?`, tntc: `$tntc${k}?` }]));

export const count: Block = {
  id: 'count', version: 1, name: 'Count colonies (microbial count)', checker: true,
  instruction: 'Count the colonies on each plate of each dilution (or mark the dilution too numerous to count), or record the tubes with growth for the MPN method. Record the negative control.',
  fields: [
    { name: 'counter', label: 'Colony counter', kind: 'machine', types: ['colony counter'], optional: true },
    ...plateFields,
    ...levels.map((k): BlockField => ({ name: `tubes${k}`, label: `MPN level ${k}: tubes with growth (of 3)`, kind: 'number', unit: 'units', optional: true })),
    { name: 'negativeControl', label: 'Negative control (diluent only)', kind: 'choice', options: ['no growth', 'growth'] },
  ],
  settings: [
    { name: 'method', label: 'Method', kind: 'text', options: ['plate count', 'MPN'] },
    ...countSettings,
    { name: 'mpnFirstLevel', label: 'MPN: product per tube at the first level (the table is for 0.1 g or mL)', kind: 'quantity', optional: true },
  ],
  calcs: [
    { name: 'result', label: 'Microbial count', template: 'L11', args: {
      mode: '$method', levels: levelArgs, amount: '$amount?', per: '$per', countable: '$countable', acceptance: '$acceptance', limit: '$limit?', negativeControl: '$negativeControl',
      positives: ['$tubes1?', '$tubes2?', '$tubes3?'], firstLevel: '$mpnFirstLevel?' } },
  ],
};
