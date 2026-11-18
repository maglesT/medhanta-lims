import type { Block, BlockField, BlockSetting } from './format.js';

// Bacterial endotoxins (L12; Ph.Int 3.4, harmonised with Ph. Eur. 2.6.14 and USP <85>): photometric (kinetic or
// end-point; the standard curve of up to 5 concentrations, |r| ≥ 0.980, λ = its lowest standard), or gel clot (limit
// test with its one repeat, or quantitative with a dilution series 1, 2, 4, 8). The lysate is a usable reagent lot
// from the inventory; its labelled sensitivity λ (gel clot) is recorded from the lot. The MVD = limit × concentration
// ÷ λ is worked out and the sample is never tested beyond it (safety rule S8); the positive product control (spike,
// solution B) and the negative control decide validity: an invalid test gives no result (repeat). The result is
// checked as LESS than the limit; outside it, an OOS (LIMS-38).
const stds = [1, 2, 3, 4, 5] as const;
const pm = ['+', '−'];
const pair = (x: string, label: string, options: string[] = pm): BlockField[] => [1, 2].map((k) => ({ name: `${x}${k}`, label: `${label}, replicate ${k}`, kind: 'choice', options, optional: true }));

export const endotoxin: Block = {
  id: 'endotoxin', version: 1, name: 'Bacterial endotoxins (LAL)', checker: true,
  instruction: 'Pick the lysate lot. Photometric: run the standard curve, the sample (A), the spiked sample (B) and water BET (D) and record the responses. Gel clot: incubate the tubes and record each replicate as + (a firm gel that stays on inversion) or −.',
  fields: [
    { name: 'lysate', label: 'Lysate (LAL reagent) lot (from the inventory)', kind: 'item', itemKinds: ['reagent'] },
    { name: 'reader', label: 'Endotoxin reader or heating block', kind: 'machine', types: ['endotoxin', 'heating block', 'dry bath', 'water bath'] },
    { name: 'lambda', label: 'Gel clot: labelled sensitivity λ of the lysate lot (confirmed)', kind: 'number', unit: 'EU/mL', optional: true },
    ...stds.map((k): BlockField => ({ name: `stdResponses${k}`, label: `Standard ${k}: responses`, kind: 'number', unit: '$responseUnit', count: 3, minCount: 1, optional: true })),
    { name: 'sampleResponses', label: 'Sample (A): responses', kind: 'number', unit: '$responseUnit', count: 4, minCount: 2, optional: true },
    { name: 'spikedResponses', label: 'Spiked sample, positive product control (B): responses', kind: 'number', unit: '$responseUnit', count: 4, minCount: 2, optional: true },
    { name: 'negativeControl', label: 'Negative control (water BET, D) below the lowest standard', kind: 'yes-no', optional: true },
    ...pair('a', 'Gel clot limit test: sample (A)'),
    ...pair('aEnd', 'Gel clot quantitative: sample (A), greatest dilution that clots', ['none positive', '1', '2', '4', '8']),
    ...pair('b', 'Gel clot: positive product control (B)'),
    ...pair('c', 'Gel clot limit test: positive control (C)'),
    ...pair('cEnd', 'Gel clot quantitative: positive control (C), end-point', ['2λ', 'λ', '0.5λ', '0.25λ', 'no clot']),
    ...pair('d', 'Gel clot: negative control (D)'),
    { name: 'repeat', label: 'Gel clot limit test: this is the repeat test', kind: 'yes-no', optional: true },
  ],
  settings: [
    { name: 'mode', label: 'Technique', kind: 'text', options: ['photometric', 'gel clot limit', 'gel clot quantitative'] },
    { name: 'response', label: 'Photometric: response read', kind: 'text', options: ['onset time', 'rate', 'absorbance'], optional: true },
    { name: 'responseUnit', label: 'Photometric: unit of the responses (s for an onset time)', kind: 'text', optional: true },
    ...stds.map((k): BlockSetting => ({ name: `std${k}`, label: `Photometric: standard ${k} concentration (EU/mL; standard 1 the lowest, λ)`, kind: 'quantity', optional: true })),
    { name: 'spike', label: 'Photometric: endotoxin added to B (EU/mL)', kind: 'quantity', optional: true },
    { name: 'concentration', label: 'Concentration of the sample solution in the limit\'s terms (mg/mL for a limit per mg; none for per mL)', kind: 'quantity', optional: true },
    { name: 'dilution', label: 'Dilution of the sample solution tested (1: not diluted)', kind: 'number' },
    { name: 'limit', label: 'Endotoxin limit (less than)', kind: 'limit', optional: true },
  ],
  calcs: [
    { name: 'result', label: 'Bacterial endotoxins', template: 'L12', args: {
      mode: '$mode', lysate: '$lysate', response: '$response?', limit: '$limit?', concentration: '$concentration?', dilution: '$dilution', lambda: '$lambda?',
      standards: stds.map((k) => ({ concentration: `$std${k}?`, responses: `$stdResponses${k}?` })),
      sample: '$sampleResponses?', spiked: '$spikedResponses?', spike: '$spike?', negativeControl: '$negativeControl?',
      a: ['$a1?', '$a2?'], aEndpoints: ['$aEnd1?', '$aEnd2?'], b: ['$b1?', '$b2?'], c: ['$c1?', '$c2?'], cEndpoints: ['$cEnd1?', '$cEnd2?'], dControl: ['$d1?', '$d2?'], repeat: '$repeat?',
    } },
  ],
};
