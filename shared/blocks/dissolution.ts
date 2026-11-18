import type { Block, BlockField, BlockSetting } from './format.js';

// Dissolution (L5, then the stage rules of C6): up to 4 time points (a fixed list the method sets, library 8e), the
// responses of 6 vessels at each, and of 6 more (stage 2) and 12 more (stage 3) when the stage rules call for them.
// The amount dissolved per vessel from the standard (its concentration, or the standard as weighed with its potency
// and dilution), the sample dilution and the volume rule (aliquots replaced and corrected, or not replaced) as % of the
// label claim. The reportable result is the mean % dissolved at the time point the method reports (default the last);
// the acceptance (immediate release S1-S3, delayed release acid A1-A3 and buffer B1-B3, extended release L1-L3 with a
// range per time point) is the result's check. One medium per step: a delayed-release test is two steps (acid, then
// buffer), and Tier 1 / Tier 2 (with enzyme) are two steps too; a Tier 1 failure the method sends to Tier 2 opens no OOS.
const times = [1, 2, 3, 4] as const;
const stages = [[1, 6], [2, 6], [3, 12]] as const;

export const dissolution: Block = {
  id: 'dissolution', version: 1, name: 'Dissolution', checker: true,
  instruction: 'Run the dissolution test as the method says. At each time point withdraw the aliquot from every vessel, filter, and measure it against the standard. Record the responses of the standard and of each vessel, vessel by vessel in the same order at every time point; test more units only when the stage rule asks for them.',
  fields: [
    { name: 'apparatus', label: 'Dissolution apparatus', kind: 'machine', types: ['dissolution'] },
    { name: 'mediumTemperature', label: 'Medium temperature', kind: 'number', unit: '°C' },
    { name: 'standardResponses', label: 'Standard: responses', kind: 'number', unit: '$responseUnit', count: 6, minCount: 1 },
    { name: 'stdPotency', label: 'Standard: potency (from its certificate; a weighed standard)', kind: 'number', unit: '%', optional: true },
    { name: 'stdBasis', label: 'Standard: basis of the potency', kind: 'choice', options: ['as is', 'dried', 'anhydrous'], optional: true },
    ...times.flatMap((t) => stages.map(([s, n]): BlockField => ({
      name: `time${t}Stage${s}`, label: `Time point ${t}: ${s === 1 ? '6 vessels' : s === 2 ? '6 more vessels (stage 2)' : '12 more vessels (stage 3)'}`,
      kind: 'number', unit: '$responseUnit', count: n, ...(t === 1 && s === 1 ? {} : { optional: true }),
    }))),
  ],
  settings: [
    { name: 'tier', label: 'Run (e.g. Tier 1, Tier 2 with pepsin)', kind: 'text', optional: true },
    { name: 'medium', label: 'Medium', kind: 'text' },
    { name: 'volume', label: 'Medium volume', kind: 'quantity' },
    { name: 'volumeMode', label: 'Aliquots', kind: 'text', options: ['replace and correct', 'no replacement', 'replace, no correction'] },
    { name: 'aliquot', label: 'Aliquot withdrawn at each time point', kind: 'quantity' },
    ...times.map((t): BlockSetting => ({ name: `time${t}`, label: `Time point ${t}`, kind: 'quantity', ...(t > 1 ? { optional: true } : {}) })),
    { name: 'reportAt', label: 'Time point reported (default the last)', kind: 'quantity', optional: true },
    { name: 'responseUnit', label: 'Unit of the responses (AU for absorbance; none for a peak area)', kind: 'text' },
    { name: 'standardConcentration', label: 'Standard: concentration (a standard solution of stated strength)', kind: 'quantity', optional: true },
    { name: 'stdMass', label: 'Standard: mass weighed (its weigh step)', kind: 'quantity', optional: true },
    { name: 'stdVolume', label: 'Standard: first flask', kind: 'quantity', optional: true },
    { name: 'stdFactor', label: 'Standard: dilution factor after the first flask (its dilute step)', kind: 'number', optional: true },
    { name: 'dilution', label: 'Sample: dilution factor before measuring', kind: 'number', optional: true },
    { name: 'labelClaim', label: 'Label claim per unit (from the specification)', kind: 'quantity' },
    { name: 'acceptance', label: 'Acceptance (stage rules)', kind: 'text', options: ['dissolution IR', 'dissolution DR acid', 'dissolution DR buffer', 'dissolution ER'], optional: true },
    { name: 'limit', label: 'Limit: Q as the lowest % dissolved (acid stage: the highest)', kind: 'limit', optional: true },
    ...times.map((t): BlockSetting => ({ name: `range${t}`, label: `Extended release: range at time point ${t}`, kind: 'limit', optional: true })),
    { name: 'temperatureLimit', label: 'Medium temperature limits', kind: 'limit', optional: true },
  ],
  calcs: [
    { name: 'temperatureCheck', label: 'Medium temperature', template: 'C1', args: { value: '$mediumTemperature', limit: '$temperatureLimit?' } },
    {
      name: 'result', label: 'Dissolved (mean at the time point reported)', template: 'L5',
      args: {
        labelClaim: '$labelClaim', label: '$tier?', volumeMode: '$volumeMode', dilution: '$dilution?', reportAt: '$reportAt?',
        standard: { responses: '$standardResponses', concentration: '$standardConcentration?',
          prepared: { mass: '$stdMass?', potency: '$stdPotency?', potencyBasis: '$stdBasis?', dilution: { volume: '$stdVolume?', factor: '$stdFactor?' } } },
        stages: [{ name: '$medium', volume: '$volume', times: times.map((t) => ({ time: `$time${t}${t > 1 ? '?' : ''}`, aliquot: '$aliquot' })) }],
        byTime: times.map((t) => stages.map(([s]) => `$time${t}Stage${s}${t === 1 && s === 1 ? '' : '?'}`)),
        acceptance: { test: '$acceptance?', limit: '$limit?', ranges: times.map((t) => `$range${t}?`) },
      },
    },
  ],
};
