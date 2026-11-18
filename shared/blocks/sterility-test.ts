import type { Block, BlockField } from './format.js';

// Test for sterility (Ph.Int 3.2, harmonised with Ph. Eur. 2.6.1 and USP <71>; paraphrased): membrane filtration or
// direct inoculation into fluid thioglycollate medium (FTM, 30-35 °C) and soya-bean casein digest medium (SCDM,
// 20-25 °C), each a usable medium lot from the inventory (LIMS-34), incubated NLT 14 days (a T13 duration whose lower
// bound is a minimum wait) with the containers observed at intervals; negative controls. The number of containers
// tested is checked against the number the batch size requires (L19, sterility table). The result: no growth in
// either medium conforms. Growth is the step's result check failing: an OOS opens when the step is signed, and the
// result is invalidated only through the OOS (an assignable laboratory cause in phase I, reviewed, and QA's
// signature with lims.oos.approve; LIMS-38). The reportable value is `result`: the number of media with growth.
const media = [['ftm', 'FTM'], ['scdm', 'SCDM']] as const;

export const sterilityTest: Block = {
  id: 'sterility-test', version: 1, name: 'Test for sterility', checker: true,
  instruction: 'Test the containers by the method shown (membrane filtration or direct inoculation) in an EM-monitored aseptic area. Pick the FTM and SCDM lots and the incubators, start each medium\'s timer, and record at each reading the number of containers (or canisters) showing growth. At the end (not before 14 days) record the final reading of each medium and its negative control.',
  fields: [
    { name: 'batchSize', label: 'Batch size (containers in the batch)', kind: 'number', unit: 'units' },
    { name: 'containers', label: 'Containers tested', kind: 'number', unit: 'units' },
    ...media.flatMap(([m, M]): BlockField[] => [
      { name: `${m}Medium`, label: `${M} lot (from the inventory)`, kind: 'item', itemKinds: ['medium'] },
      { name: `${m}Incubator`, label: `${M} incubator`, kind: 'machine', types: ['incubator'], notTypes: ['shaker'] },
      { name: `${m}Start`, label: `${M} incubation started`, kind: 'timer' },
      { name: `${m}Readings`, label: `${M}: containers with growth at each reading`, kind: 'number', unit: 'units', count: 14, minCount: 1, optional: true },
      { name: `${m}End`, label: `${M} incubation ended`, kind: 'timer' },
      { name: `${m}TemperatureLow`, label: `${M} incubator: lowest temperature over the incubation`, kind: 'number', unit: '°C' },
      { name: `${m}TemperatureHigh`, label: `${M} incubator: highest temperature over the incubation`, kind: 'number', unit: '°C' },
      { name: `${m}Result`, label: `${M}: final reading (all containers)`, kind: 'choice', options: ['no growth', 'growth'] },
      { name: `${m}Negative`, label: `${M} negative control`, kind: 'choice', options: ['no growth', 'growth'] },
    ]),
    { name: 'organism', label: 'Organism found (when growth: its identity, from the micro lab)', kind: 'text', optional: true },
  ],
  settings: [
    { name: 'method', label: 'Method', kind: 'text', options: ['membrane filtration', 'direct inoculation'] },
    { name: 'productType', label: 'Product type (the sterility table)', kind: 'text', options: ['parenteral', 'large-volume parenteral', 'antibiotic solid, bulk package under 5 g', 'antibiotic solid, bulk package 5 g or more', 'ophthalmic and other non-injectable', 'devices', 'bulk solid'] },
    { name: 'bothMedia', label: 'The contents of one container are enough for both media', kind: 'text', options: ['yes', 'no'] },
    { name: 'quantity', label: 'Quantity per container for each medium (e.g. the whole contents)', kind: 'text', optional: true },
    { name: 'ftmTemperatureLimit', label: 'FTM incubation temperature (30 to 35 °C)', kind: 'limit' },
    { name: 'scdmTemperatureLimit', label: 'SCDM incubation temperature (20 to 25 °C)', kind: 'limit' },
    { name: 'incubationTime', label: 'Incubation time (not less than 14 days)', kind: 'limit', optional: true },
  ],
  calcs: [
    { name: 'required', label: 'Containers required (sterility table) against those tested', template: 'L19', args: {
      mode: 'sterility containers', batchSize: '$batchSize', product: '$productType', oneContainerForBothMedia: '$bothMedia', tested: '$containers' } },
    ...media.flatMap(([m, M]) => [
      { name: `${m}Duration`, label: `${M} incubation time`, template: 'T13', args: { mode: 'duration', start: `$${m}Start`, end: `$${m}End`, unit: 'd', limit: '$incubationTime?' } },
      { name: `${m}TemperatureLowCheck`, label: `${M}: lowest temperature against the range`, template: 'C1', args: { value: `$${m}TemperatureLow`, limit: `$${m}TemperatureLimit` } },
      { name: `${m}TemperatureHighCheck`, label: `${M}: highest temperature against the range`, template: 'C1', args: { value: `$${m}TemperatureHigh`, limit: `$${m}TemperatureLimit` } },
      { name: `${m}NegativeCheck`, label: `${M} negative control`, template: 'C4', args: { question: `${M} negative control`, answers: [`$${m}Negative`], expected: ['no growth'], options: ['no growth', 'growth'] } },
    ]),
    { name: 'result', label: 'Sterility', template: 'C4', args: {
      question: 'No growth in FTM or SCDM', answers: ['$ftmResult', '$scdmResult'], expected: ['no growth'], options: ['no growth', 'growth'] } },
  ],
};
