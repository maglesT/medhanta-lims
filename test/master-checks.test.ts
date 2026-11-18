import { describe, expect, it } from 'vitest';
import { BLOCKS } from '../shared/blocks/index.js';
import { blockProblems, type Block } from '../shared/blocks/format.js';
import { evaluate } from '../shared/engine/index.js';
import { blocking, masterChecks, plainWords, type Problem } from '../shared/master/checks.js';
import { masterSchema, type MasterDoc, type Step } from '../shared/master/schema.js';
import { placed, method, unplaced } from './engine-fixture.js';
// The problems, without the rooms a stage must name (LIMS-12): the fixtures name none.
const checks = (d: Parameters<typeof masterChecks>[0]) => unplaced(masterChecks(d));

/** The fixture with one change; the problems that change makes. */
function after(change: (d: MasterDoc) => void) {
  const d = method();
  change(d);
  return checks(d).map((p) => `${p.level} ${p.rule ?? '-'} ${p.path}: ${p.message}`);
}
const errors = (change: (d: MasterDoc) => void) => after(change).filter((p) => p.startsWith('error'));
const step = (d: MasterDoc, stage: string, key: string) => d.stages.find((s) => s.key === stage)!.steps.find((t) => t.key === key)!;
const clearance: Step = { key: 'clearance', block: { id: 'line-clearance', version: 1 }, checker: true, waitForCheck: false, critical: false, settings: {}, flow: { kind: 'none' } };

describe('blocks are data', () => {
  it.each(BLOCKS.map((b) => [b.id, b] as const))('the %s block is a valid description', (_id, b) => {
    expect(blockProblems(b)).toEqual([]);
  });

  it('no calculation label states its own outcome (the record never reads "Within limits: … OUT OF LIMITS")', () => {
    const labels = BLOCKS.flatMap((b) => b.calcs.map((c) => c.label));
    expect(labels.filter((l) => /within|out of|pass|fail/i.test(l))).toEqual([]);
    expect(labels).toContain('Result against limits');
  });

  it('a block naming an unknown template, field or stop check is refused', () => {
    const bad: Block = { ...BLOCKS[0]!, calcs: [{ name: 'x', label: 'X', template: 'T99', args: { a: '$nothing' } }], stop: 'y' };
    expect(blockProblems(bad)).toEqual(['calculation x: unknown template T99', 'calculation x: "$nothing" is not a field, setting or earlier calculation', 'stop: no calculation y']);
  });

  it('the library has only lab blocks: no production block is left', () => {
    expect(BLOCKS.map((b) => b.id)).toEqual(['line-clearance', 'weigh', 'mix', 'dilute', 'instrument-run', 'system-suitability', 'check', 'periodic-check',
      'dry-constant', 'disintegration', 'friability', 'uniformity-by-weight', 'content-uniformity', 'density-flow', 'sieve-analysis']);
  });
});

describe('method checks', () => {
  it('the fixture method passes every check', () => {
    expect(checks(method())).toEqual([]);
    expect(masterChecks(placed(method()))).toEqual([]);
  });

  it('LIMS-12 a stage that works machines or names a room, with no rooms chosen, is an error; balances alone are not', () => {
    expect(masterChecks(method()).filter((p) => p.rule === 'LIMS-12').map((p) => `${p.path}: ${p.message}`)).toEqual(['Standard solution', 'Loss on drying', 'Instrument run']
      .map((name, i) => `stages[${i}].roomTypes: Stage ${name}: choose the rooms this stage may run in (an area or a room of master data, in the stage settings)`));
    // The sample stage weighs on a balance only: no rooms needed. Bench clearance names a room: then they are.
    const d = placed(method());
    d.stages[0]!.roomTypes = [];
    d.stages[0]!.steps = d.stages[0]!.steps.filter((t) => t.block.id === 'weigh');
    expect(masterChecks(d).filter((p) => p.rule === 'LIMS-12')).toEqual([]);
    d.stages[0]!.steps.unshift(clearance);
    expect(masterChecks(d).filter((p) => p.rule === 'LIMS-12').map((p) => p.path)).toEqual(['stages[0].roomTypes']);
  });

  it('a draft may be incomplete, but its shape is checked; a method has no tablet header and no formula', () => {
    expect(masterSchema.safeParse({ ...method(), stages: [{ key: 'X Y' }] }).success).toBe(false);
    expect(masterSchema.safeParse({ ...method(), formula: [] }).success).toBe(false);
    expect(masterSchema.safeParse({ ...method(), header: { ...method().header, batchSize: '100000' } }).success).toBe(false);
    expect(masterSchema.safeParse({ ...method(), header: { ...method().header, technique: 'Tablet press' } }).success).toBe(false);
  });

  it('a method without stages is an error', () => {
    expect(after((d) => { d.stages = []; })).toEqual(['error - stages: The method has no steps']);
  });

  it.each<[string, (d: MasterDoc) => void, string]>([
    ['weighing of the standard', (d) => { step(d, 'standard', 'weigh-std').checker = false; }, 'error LIMS-41 stages[0].steps[0]: A weighing step needs a second-person check'],
    ['weighing of the sample', (d) => { step(d, 'sample', 'weigh-sample').checker = false; }, 'error LIMS-41 stages[3].steps[0]: A weighing step needs a second-person check'],
    ['critical', (d) => { step(d, 'standard', 'dissolve').critical = true; }, 'error LIMS-41 stages[0].steps[1]: A critical step needs a second-person check'],
    ['bench clearance', (d) => { d.stages[2]!.steps.unshift({ ...clearance, checker: false }); }, 'error LIMS-41 stages[2].steps[0]: A bench clearance step needs a second-person check'],
  ])('LIMS-41 a %s step without a second-person check is an error', (_what, change, want) => {
    expect(after(change)).toEqual([want]);
  });

  it('bench clearance is optional; when a stage has one that is not its first step, it is a warning', () => {
    expect(after((d) => { d.stages[2]!.steps.unshift(clearance); })).toEqual([]);
    expect(after((d) => { d.stages[2]!.steps.push(clearance); })).toEqual(['warning - stages[2].steps[3]: Bench clearance is not the first step of Instrument run']);
  });

  it('LIMS-01 an intermediate without a hold time is an error', () => {
    expect(after((d) => { delete d.stages[0]!.produces!.holdHours; })).toEqual(['error LIMS-01 stages[0].produces: The intermediate standard solution has no hold time']);
  });

  it('a replicate stage without the number of replicates is an error', () => {
    expect(after((d) => { delete d.stages[3]!.count; })).toEqual(['error - stages[3]: A replicate stage needs the number of replicates']);
  });

  it('a critical step cannot be optional; waiting for a check the step does not have, or a stage without a role, is a warning', () => {
    expect(after((d) => { step(d, 'standard', 'weigh-std').flow = { kind: 'optional-with-reason' }; })).toEqual(['error - stages[0].steps[0].flow: A critical step cannot be optional']);
    expect(after((d) => { step(d, 'standard', 'dissolve').waitForCheck = true; })).toEqual(['warning - stages[0].steps[1]: The next step waits for a check this step does not have']);
    expect(after((d) => { d.stages[1]!.role = ' '; })).toEqual(['warning - stages[1]: Stage Loss on drying names no responsible role']);
  });

  it('a setting the block does not have, or a value not in its list, is an error', () => {
    expect(after((d) => { step(d, 'standard', 'weigh-std').settings.extra = 'x'; })).toEqual(['error - stages[0].steps[0].settings.extra: The block Weigh has no setting extra']);
    expect(after((d) => { step(d, 'standard', 'weigh-std').settings.unit = 'kg'; })).toEqual(['error - stages[0].steps[0].settings.unit: Unit: choose one of mg, g']);
  });

  it('a limit the library refuses is an error', () => {
    expect(after((d) => { step(d, 'run', 'temp').settings.limit = { low: '32', high: '28', unit: '°C' }; }))
      .toEqual(['error - stages[2].steps[2].settings.limit: The lower limit 32 is above the upper limit 28']);
  });

  it('LIMS-01 a limit or a typed target in a unit of another kind than the value it checks is an error (every reading would be refused)', () => {
    expect(errors((d) => { step(d, 'run', 'temp').settings.limit = { low: '28', high: '32', unit: 'min' }; }))
      .toEqual(['error LIMS-01 stages[2].steps[2].settings.limit: Limits: min is a time, but the value checked is a temperature. Choose a unit of that kind (in min every reading would be refused at analysis time)']);
    expect(errors((d) => { step(d, 'sample', 'result').settings.limit = { low: '95.0', high: '105.0', unit: 'mg' }; }))
      .toEqual(['error LIMS-01 stages[3].steps[2].settings.limit: Limits: mg is a mass, but the value checked is a percentage. Choose a unit of that kind (in mg every reading would be refused at analysis time)']);
    // The %RSD limit of the system suitability is a percentage, whatever the responses are in.
    expect(errors((d) => { step(d, 'run', 'sst').settings.rsdLimit = { high: '2.0', unit: 'mg' }; })).toEqual([expect.stringMatching(/^error LIMS-01 stages\[2\]\.steps\[1\]\.settings\.rsdLimit: .*mg is a mass, but the value checked is a percentage/)]);
    expect(errors((d) => { step(d, 'standard', 'weigh-std').settings.target = '50.0 min'; })).toEqual([expect.stringMatching(/^error LIMS-01 stages\[0\]\.steps\[0\]\.settings\.target: .*min is a time, but the value checked is a mass/)]);
    // A unit not in the list is refused as before; a unit of the same kind is not a kind problem.
    expect(errors((d) => { step(d, 'run', 'temp').settings.limit = { low: '28', high: '32', unit: 'F-min' }; })).toEqual([expect.stringMatching(/"F-min" is not in the unit list/)]);
    expect(errors((d) => { step(d, 'standard', 'weigh-std').settings.target = '0.050 g'; })).toEqual([]);
    expect(errors((d) => { step(d, 'sample', 'result').settings.limit = { low: '95.0', high: '105.0', unit: '%' }; })).toEqual([]);
  });

  it('a limit of the wrong unit kind is refused at analysis time too: C1 and T7 refuse the reading, nothing is compared', () => {
    const d = method();
    step(d, 'run', 'temp').settings.limit = { low: '28', high: '32', unit: 'min' };
    expect(evaluate(d, [], { stage: 2, sub: 1, step: 2, round: 1 }, { reading: { value: '30', unit: '°C' } }).readingCheck)
      .toEqual({ ok: false, message: '°C (temperature) cannot be converted to min (time)' });
    const e = method();
    step(e, 'run', 'sst').settings.rsdLimit = { high: '2.0', unit: 'mg' };
    expect(evaluate(e, [], { stage: 2, sub: 1, step: 1, round: 1 }, { responses: Array(6).fill({ value: '1000', unit: 'units' }) }).precision)
      .toEqual({ ok: false, message: '% (fraction) cannot be converted to mg (mass)' });
  });

  it('a value the specification gives is accepted in a setting: it is filled in before the analysis runs', () => {
    expect(after((d) => { step(d, 'sample', 'result').settings.limit = { spec: 'assayLimit' }; })).toEqual([]);
    expect(after((d) => { step(d, 'standard', 'weigh-std').settings.target = { spec: 'standardMass' }; })).toEqual([]);
  });

  it('a calculation that needs no recorded value is worked out on the method, and a refusal is an error (the dilution factor)', () => {
    expect(after((d) => { step(d, 'sample', 'dilute').settings.aliquot1 = '60.0 mL'; }))
      .toEqual(['error - stages[3].steps[1]: Dilution factor: Dilution 1: the aliquot (60.0 mL) is more than the flask volume (50.0 mL); check the method']);
    expect(after((d) => { step(d, 'sample', 'dilute').settings.aliquot1 = '5.0 g'; }))
      .toEqual(['error - stages[3].steps[1]: Dilution factor: The aliquot of dilution 1 must be a volume; "5.0 g" is a mass']);
  });

  it('periodic readings more than the block allows apart, with no interval, or not repeated, are an error', () => {
    expect(after((d) => { step(d, 'run', 'temp').everyMinutes = 2000; }))
      .toEqual(['error - stages[2].steps[2].everyMinutes: Periodic checks every 2000 min: they must be at least every 1440 min']);
    expect(after((d) => { delete step(d, 'run', 'temp').everyMinutes; }))
      .toEqual(['error - stages[2].steps[2].everyMinutes: Read a value at intervals needs the interval of its periodic checks']);
    expect(after((d) => { step(d, 'run', 'temp').flow = { kind: 'none' }; }))
      .toEqual(['error - stages[2].steps[2].everyMinutes: Checks every N minutes need a repeat-until step']);
    expect(after((d) => { step(d, 'run', 'temp').everyMinutesLater = { afterMinutes: 60, everyMinutes: 2000 }; }))
      .toEqual(['error - stages[2].steps[2].everyMinutesLater: Periodic checks every 2000 min: they must be at least every 1440 min']);
    expect(after((d) => { step(d, 'run', 'temp').everyMinutesLater = { afterMinutes: 60, everyMinutes: 60 }; })).toEqual([]);
    expect(after((d) => { step(d, 'run', 'temp').everyMinutes = 1440; })).toEqual([]);
  });

  it('a repeat-until step without the most rounds, or without a stop check, is an error', () => {
    expect(after((d) => { step(d, 'drying', 'lod').flow = { kind: 'repeat-until' }; }))
      .toEqual(['error - stages[1].steps[0].flow: A repeat-until step needs the most rounds allowed']);
    expect(after((d) => { step(d, 'drying', 'lod').flow = { kind: 'repeat-until', maxRounds: 3, stop: 'nothing' }; }))
      .toEqual(['error - stages[1].steps[0].flow: A repeat-until step needs a stop check (a calculation of its block)']);
  });

  it('a reference to a field that does not exist, comes later, or is inside another replicate stage is an error', () => {
    const ref = (r: string) => after((d) => { step(d, 'sample', 'dilute').settings.aliquot1 = { ref: r }; });
    expect(ref('sample/weigh-sample/nothing')).toEqual(['error - stages[3].steps[1].settings.aliquot1: sample/weigh-sample/nothing: step weigh-sample has no field or calculation nothing']);
    expect(ref('sample/result/reading')).toEqual(['error - stages[3].steps[1].settings.aliquot1: sample/result/reading comes later than this step']);
    expect(ref('nowhere/x/y')).toEqual(['error - stages[3].steps[1].settings.aliquot1: nowhere/x/y: no such stage and step']);
    expect(after((d) => { d.stages[1]!.kind = 'replicate'; d.stages[1]!.count = 2; step(d, 'sample', 'dilute').settings.aliquot1 = { ref: 'drying/lod/weight' }; }))
      .toEqual(['error - stages[3].steps[1].settings.aliquot1: drying/lod/weight is inside the replicate stage Loss on drying: refer to it from that stage only']);
  });

  it('unknown blocks, missing settings and stages used before they exist or producing nothing are errors; an unused preparation is a warning', () => {
    expect(after((d) => { step(d, 'drying', 'lod').block.version = 9; })).toEqual(['error - stages[1].steps[0].block: No block dry-constant version 9']);
    expect(after((d) => { delete step(d, 'drying', 'lod').settings.maxChange; })).toEqual(['error - stages[1].steps[0].settings.maxChange: Largest change between weighings is not set']);
    expect(after((d) => { d.stages[2]!.uses = ['sample']; })).toEqual(['warning - stages[0]: No stage uses the preparation Standard solution', 'error - stages[2].uses: sample is not an earlier stage']);
    expect(after((d) => { d.stages[3]!.uses = ['run']; })).toEqual(['error - stages[3].uses: Stage Instrument run produces no intermediate']);
  });

  it('a key used twice is an error', () => {
    expect(after((d) => { d.stages[1]!.key = 'standard'; d.stages[2]!.uses = []; }).filter((p) => p.includes('twice'))).toEqual(['error - stages[1]: The key standard is used twice']);
    expect(after((d) => { step(d, 'sample', 'dilute').key = 'weigh-sample'; })).toEqual(['error - stages[3].steps[1]: The key weigh-sample is used twice']);
  });
});

describe('what the method check says', () => {
  it('no internal codes of rules or templates in the messages', () => {
    expect(plainWords('A line is adjusted for potency (T9) or for a dilution (L21), not both')).toBe('A line is adjusted for potency or for a dilution, not both');
    for (const p of masterChecks(method())) expect(p.message).not.toMatch(/\((T|L)\d+\)/);
  });

  it('what blocks "Send for review": an error, or a warning that needs an answer and has none', () => {
    const warning: Problem = { level: 'warning', path: 'stages[0]', message: 'w' };
    const question = { key: 'k', options: ['a'], needsReason: true };
    expect(blocking({ ...warning, level: 'error' })).toBe(true);
    expect(blocking(warning)).toBe(false);
    expect(blocking({ ...warning, question })).toBe(true);
    expect(blocking({ ...warning, question: { ...question, answer: { about: 'w', choice: 'a', reason: 'r' } } })).toBe(false);
  });
});
