import type { Block, BlockField, BlockSetting } from './format.js';

// The method validation blocks (plan 2.12; ICH Q2(R2), USP <1225>, <1226>, <1224>; templates L27-L34). A validation,
// verification or transfer protocol is a method whose header says "validation worksheet": its analyses are run
// without a sample, and their results go into the validation report (shared/engine/method-validation.ts). The
// acceptance criteria are the protocol's settings (limits). Each block's reportable value is its `result`.

const opt = (k: number, from: number) => (k >= from ? { optional: true } : {});
const ks = (n: number) => Array.from({ length: n }, (_, j) => j + 1);

export const specificity: Block = {
  id: 'specificity', version: 1, name: 'Specificity', checker: true,
  instruction: 'Inject the blank, the placebo and each known impurity or degradant alone, then the standard at 100 %. Record the response at the analyte\'s position in each (0 when there is no peak), the resolution of the closest pair and, for stressed samples, whether peak purity passes.',
  fields: [
    { name: 'standard', label: 'Analyte response at 100 %', kind: 'number', unit: 'units' },
    { name: 'interferences', label: 'Responses at the analyte\'s position (blank, placebo, impurities)', kind: 'number', unit: 'units', count: 10, minCount: 1 },
    { name: 'resolution', label: 'Resolution of the closest pair', kind: 'number', unit: 'units', optional: true },
    { name: 'purity', label: 'Peak purity passes in the stressed samples', kind: 'yes-no', optional: true },
  ],
  settings: [
    { name: 'limit', label: 'Largest interference, % of the analyte response: limit (e.g. NMT 0.5 %)', kind: 'limit' },
    { name: 'resolutionLimit', label: 'Resolution of the closest pair: limit', kind: 'limit', optional: true },
  ],
  calcs: [{ name: 'result', label: 'Specificity', template: 'L34', args: { standard: '$standard', interferences: { readings: '$interferences' }, limit: '$limit', resolution: '$resolution?', resolutionLimit: '$resolutionLimit?', purity: '$purity?' } }],
};

const RANGE_USES = ['assay', 'content uniformity', 'dissolution', 'impurity', 'as written'];
export const linearity: Block = {
  id: 'linearity', version: 1, name: 'Linearity (response)', checker: true,
  instruction: 'Prepare at least 5 levels across the range and record each level and its response, in the same order.',
  fields: [
    { name: 'levels', label: 'Levels (concentration or % of the test concentration)', kind: 'number', unit: '$levelUnit', count: 12, minCount: 5 },
    { name: 'responses', label: 'Responses (same order)', kind: 'number', unit: 'units', count: 12, minCount: 5 },
  ],
  settings: [
    { name: 'levelUnit', label: 'Unit of the levels (% of the test concentration, or a concentration such as mg/mL)', kind: 'text' },
    { name: 'target', label: 'The 100 % level (the test concentration), when the levels are concentrations', kind: 'quantity', optional: true },
    { name: 'scale', label: 'Scale', kind: 'text', options: ['linear', 'log'], optional: true },
    { name: 'limit', label: 'Correlation coefficient r: limit (e.g. NLT 0.999)', kind: 'limit' },
    { name: 'r2Limit', label: 'r²: limit', kind: 'limit', optional: true },
    { name: 'interceptLimit', label: 'y-intercept, % of the response at 100 %: limit', kind: 'limit', optional: true },
    // The range the procedure's use requires (ICH Q2(R2) Table 2), checked in the report by L31.
    { name: 'use', label: 'Range required for (ICH Q2 Table 2)', kind: 'text', options: RANGE_USES },
    { name: 'q', label: 'Dissolution: Q', kind: 'quantity', optional: true },
    { name: 'reportingThreshold', label: 'Impurity: reporting threshold', kind: 'quantity', optional: true },
    { name: 'specLimit', label: 'Impurity: its specification limit', kind: 'quantity', optional: true },
    { name: 'rangeLow', label: 'As written: low end of the range (%)', kind: 'quantity', optional: true },
    { name: 'rangeHigh', label: 'As written: high end of the range (%)', kind: 'quantity', optional: true },
  ],
  calcs: [{ name: 'result', label: 'Linearity', template: 'L27', args: { x: { readings: '$levels' }, y: { readings: '$responses' }, target: '$target?', scale: '$scale?',
    limit: '$limit', r2Limit: '$r2Limit?', interceptLimit: '$interceptLimit?' } }],
};

export const accuracy: Block = {
  id: 'accuracy', version: 1, name: 'Accuracy (recovery)', checker: true,
  instruction: 'At each level, record the amount added (or the theoretical amount) and the amount found for each determination, in the same order; for standard addition also the unspiked results.',
  fields: ks(5).flatMap((k): BlockField[] => [
    { name: `added${k}`, label: `Level ${k}: amounts added`, kind: 'number', unit: '$amountUnit', count: 6, minCount: 1, ...opt(k, 4) },
    { name: `found${k}`, label: `Level ${k}: amounts found`, kind: 'number', unit: '$amountUnit', count: 6, minCount: 1, ...opt(k, 4) },
    { name: `unspiked${k}`, label: `Level ${k}: unspiked results (standard addition)`, kind: 'number', unit: '$amountUnit', count: 6, minCount: 1, optional: true },
  ]),
  settings: [
    { name: 'mode', label: 'Recovery', kind: 'text', options: ['recovery', 'standard addition'] },
    { name: 'amountUnit', label: 'Unit of the amounts (e.g. mg)', kind: 'text' },
    ...ks(5).map((k): BlockSetting => ({ name: `level${k}`, label: `Level ${k} (% of the test concentration or of the limit)`, kind: 'quantity', ...opt(k, 4) })),
    { name: 'limit', label: 'Mean recovery: limit (e.g. 98.0 to 102.0 %)', kind: 'limit' },
    { name: 'levelLimit', label: 'Mean recovery of each level: limit', kind: 'limit', optional: true },
    { name: 'ciLimit', label: '95 % confidence interval of the mean recovery: limit', kind: 'limit', optional: true },
    { name: 'rsdLimit', label: '% RSD of each level: limit', kind: 'limit', optional: true },
  ],
  calcs: [{ name: 'result', label: 'Accuracy', template: 'L28', args: {
    mode: '$mode', limit: '$limit', levelLimit: '$levelLimit?', ciLimit: '$ciLimit?', rsdLimit: '$rsdLimit?',
    levels: ks(5).map((k) => (k >= 4
      ? { level: `$level${k}?`, added: { readings: `$added${k}?` }, found: { readings: `$found${k}?` }, unspiked: { readings: `$unspiked${k}?` } }
      : { level: `$level${k}`, added: { readings: `$added${k}` }, found: { readings: `$found${k}` }, unspiked: { readings: `$unspiked${k}?` } })),
  } }],
};

export const precision: Block = {
  id: 'precision', version: 1, name: 'Precision', checker: true,
  instruction: 'Repeatability: record the determinations of one run. Intermediate precision: record each run (another day, analyst or instrument) in its own list.',
  fields: ks(6).map((k): BlockField => ({ name: `run${k}`, label: `Run ${k}: results`, kind: 'number', unit: '$resultUnit', count: 12, minCount: 2, ...opt(k, 2) })),
  settings: [
    { name: 'mode', label: 'Precision', kind: 'text', options: ['repeatability', 'intermediate precision'] },
    { name: 'resultUnit', label: 'Unit of the results (e.g. %)', kind: 'text' },
    { name: 'runs', label: 'What changes between the runs (days, analysts, instruments)', kind: 'text', optional: true },
    { name: 'limit', label: '% RSD (repeatability, or intermediate precision): limit', kind: 'limit' },
    { name: 'repeatabilityLimit', label: 'Intermediate precision: repeatability % RSD within runs: limit', kind: 'limit', optional: true },
    { name: 'differenceLimit', label: 'Intermediate precision: largest difference of the run means, % of the mean: limit', kind: 'limit', optional: true },
  ],
  calcs: [{ name: 'result', label: 'Precision', template: 'L29', args: {
    mode: '$mode', limit: '$limit', repeatabilityLimit: '$repeatabilityLimit?', differenceLimit: '$differenceLimit?', readings: { readings: '$run1' },
    groups: ks(6).map((k) => ({ readings: k === 1 ? '$run1' : `$run${k}?` })),
  } }],
};

export const lodLoq: Block = {
  id: 'lod-loq', version: 1, name: 'Detection and quantitation limits (calibration)', checker: true,
  instruction: 'Record the low-range levels and their responses, in the same order (and the blank responses when σ is the blank SD).',
  fields: [
    { name: 'levels', label: 'Low-range levels', kind: 'number', unit: '$levelUnit', count: 12, minCount: 3 },
    { name: 'responses', label: 'Responses (same order)', kind: 'number', unit: 'units', count: 12, minCount: 3 },
    { name: 'blanks', label: 'Blank responses', kind: 'number', unit: 'units', count: 12, minCount: 2, optional: true },
  ],
  settings: [
    { name: 'levelUnit', label: 'Unit of the levels (e.g. µg/mL)', kind: 'text' },
    { name: 'sigma', label: 'σ is', kind: 'text', options: ['residual SD', 'intercept SD', 'blank SD'] },
    { name: 'limit', label: 'Quantitation limit: limit (e.g. NMT the reporting threshold)', kind: 'limit', optional: true },
    { name: 'lodLimit', label: 'Detection limit: limit', kind: 'limit', optional: true },
  ],
  calcs: [{ name: 'result', label: 'Detection and quantitation limits', template: 'L30', args: {
    mode: 'calibration', x: { readings: '$levels' }, y: { readings: '$responses' }, sigma: '$sigma', blanks: { readings: '$blanks?' }, limit: '$limit?', lodLimit: '$lodLimit?',
  } }],
};

export const signalToNoise: Block = {
  id: 'signal-to-noise', version: 1, name: 'Detection or quantitation limit (signal to noise)', checker: true,
  instruction: 'At the level tested record the peak height H and the peak-to-peak noise h of the blank (same scale); at the quantitation limit also the replicate results.',
  fields: [
    { name: 'signal', label: 'Peak height H', kind: 'number', unit: 'mm' },
    { name: 'noise', label: 'Peak-to-peak noise h', kind: 'number', unit: 'mm' },
    { name: 'readings', label: 'Replicate results at the level', kind: 'number', unit: '$levelUnit', count: 10, minCount: 2, optional: true },
  ],
  settings: [
    { name: 'level', label: 'The level tested is the', kind: 'text', options: ['detection limit', 'quantitation limit'] },
    { name: 'levelUnit', label: 'Unit of the level (e.g. %)', kind: 'text' },
    { name: 'concentration', label: 'The level tested (e.g. 0.05 %)', kind: 'quantity' },
    { name: 'limit', label: 'S/N: limit (default NLT 3 at the detection limit, NLT 10 at the quantitation limit)', kind: 'limit', optional: true },
    { name: 'rsdLimit', label: '% RSD of the replicate results: limit', kind: 'limit', optional: true },
  ],
  calcs: [{ name: 'result', label: 'Signal to noise', template: 'L30', args: {
    mode: 'signal to noise', level: '$level', concentration: '$concentration', signal: '$signal', noise: '$noise', readings: { readings: '$readings?' }, rsdLimit: '$rsdLimit?', limit: '$limit?',
  } }],
};

export const robustness: Block = {
  id: 'robustness', version: 1, name: 'Robustness', checker: true,
  instruction: 'Run at the nominal conditions, then with each factor varied as the protocol says; record the results and whether system suitability was met at each.',
  fields: [
    { name: 'nominal', label: 'Results at the nominal conditions', kind: 'number', unit: '$resultUnit', count: 6, minCount: 1 },
    ...ks(6).flatMap((k): BlockField[] => [
      { name: `results${k}`, label: `Factor ${k}: results`, kind: 'number', unit: '$resultUnit', count: 6, minCount: 1, ...opt(k, 2) },
      { name: `suitability${k}`, label: `Factor ${k}: system suitability met`, kind: 'yes-no', ...opt(k, 2) },
    ]),
  ],
  settings: [
    { name: 'resultUnit', label: 'Unit of the results (e.g. %)', kind: 'text' },
    ...ks(6).map((k): BlockSetting => ({ name: `factor${k}`, label: `Factor ${k}: what is varied (e.g. flow 1.0 → 1.1 mL/min)`, kind: 'text', ...opt(k, 2) })),
    { name: 'limit', label: 'Largest difference from the nominal mean: limit (e.g. NMT 2.0 %)', kind: 'limit' },
  ],
  calcs: [{ name: 'result', label: 'Robustness', template: 'L32', args: {
    nominal: { readings: '$nominal' }, limit: '$limit',
    factors: ks(6).map((k) => (k === 1 ? { name: '$factor1', results: { readings: '$results1' }, suitability: '$suitability1' }
      : { name: `$factor${k}?`, results: { readings: `$results${k}?` }, suitability: `$suitability${k}?` })),
  } }],
};

export const transferComparison: Block = {
  id: 'transfer-comparison', version: 1, name: 'Method transfer: comparative testing', checker: true,
  instruction: 'Record the sending laboratory\'s results (from its report) and the receiving laboratory\'s results on the same batches.',
  fields: [
    { name: 'sending', label: 'Sending laboratory: results', kind: 'number', unit: '$resultUnit', count: 12, minCount: 2 },
    { name: 'receiving', label: 'Receiving laboratory: results', kind: 'number', unit: '$resultUnit', count: 12, minCount: 2 },
  ],
  settings: [
    { name: 'mode', label: 'Compared by', kind: 'text', options: ['equivalence (TOST)', 'difference'] },
    { name: 'resultUnit', label: 'Unit of the results (e.g. %)', kind: 'text' },
    { name: 'margin', label: 'Acceptance margin, ± in the results\' unit (e.g. 2.0 %)', kind: 'quantity' },
    { name: 'rsdLimit', label: 'Receiving laboratory % RSD: limit', kind: 'limit', optional: true },
  ],
  calcs: [{ name: 'result', label: 'Transfer comparison', template: 'L33', args: { mode: '$mode', sending: { readings: '$sending' }, receiving: { readings: '$receiving' }, margin: '$margin', rsdLimit: '$rsdLimit?' } }],
};

/** The validation blocks, in the order a protocol usually runs them. */
export const VALIDATION_BLOCKS: readonly Block[] = [specificity, linearity, accuracy, precision, lodLoq, signalToNoise, robustness, transferComparison];
