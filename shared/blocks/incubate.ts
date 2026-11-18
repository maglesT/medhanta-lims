import type { Block } from './format.js';

// Incubate (library 2b): plates, tubes or containers with their medium (a usable culture medium lot from the lab
// inventory: growth promotion passed and checked, LIMS-34) in an incubator (fit for use and qualified, LIMS-12), from
// a start timer to an end timer. The method's incubation time (e.g. 3 to 5 days) is a T13 duration: its lower bound
// is a minimum wait, so the step cannot be finished earlier. The lowest and highest temperature of the incubator over
// the time (its chart or log) are checked against the method's range. Two temperatures (e.g. 20-25 °C, then
// 30-35 °C) are two incubate steps. The reading at the end is recorded here; colonies are counted in the count step.
export const incubate: Block = {
  id: 'incubate', version: 1, name: 'Incubate', checker: false,
  instruction: 'Pick the medium lot and the incubator, place the plates or tubes in it and start the timer. At the end of the incubation time stop the timer, record the lowest and highest temperature of the incubator over the time, and the reading.',
  fields: [
    { name: 'medium', label: 'Medium lot (from the inventory)', kind: 'item', itemKinds: ['medium'] },
    { name: 'incubator', label: 'Incubator', kind: 'machine', types: ['incubator'], notTypes: ['shaker'] },
    { name: 'start', label: 'Incubation started', kind: 'timer' },
    { name: 'end', label: 'Incubation ended', kind: 'timer' },
    { name: 'temperatureLow', label: 'Lowest temperature over the incubation (incubator log)', kind: 'number', unit: '°C' },
    { name: 'temperatureHigh', label: 'Highest temperature over the incubation (incubator log)', kind: 'number', unit: '°C' },
    { name: 'reading', label: 'Reading at the end', kind: 'choice', options: ['ready to count', 'growth', 'no growth'] },
  ],
  settings: [
    { name: 'what', label: 'What is incubated (e.g. TAMC plates, casein soya bean digest agar)', kind: 'text' },
    { name: 'atmosphere', label: 'Atmosphere', kind: 'text', options: ['aerobic', 'anaerobic'], optional: true },
    { name: 'temperatureLimit', label: 'Incubation temperature (e.g. 30 to 35 °C)', kind: 'limit' },
    { name: 'timeLimit', label: 'Incubation time (e.g. 3 to 5 days; the lower bound is a minimum)', kind: 'limit' },
  ],
  calcs: [
    { name: 'duration', label: 'Incubation time', template: 'T13', args: { mode: 'duration', start: '$start', end: '$end', unit: 'h', limit: '$timeLimit' } },
    { name: 'temperatureLowCheck', label: 'Lowest temperature against the range', template: 'C1', args: { value: '$temperatureLow', limit: '$temperatureLimit' } },
    { name: 'temperatureHighCheck', label: 'Highest temperature against the range', template: 'C1', args: { value: '$temperatureHigh', limit: '$temperatureLimit' } },
  ],
};
