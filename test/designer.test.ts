import { describe, expect, it } from 'vitest';
import { BLOCKS, findBlock } from '../shared/blocks/index.js';
import { masterChecks, type Problem } from '../shared/master/checks.js';
import { masterSchema } from '../shared/master/schema.js';
import { describeMaster, diffMasters, stepText } from '../web/src/designer/describe.js';
import { workedExample } from '../web/src/designer/example.js';
import { answerDoc, earlierRefs, neededKind, stepFrom } from '../web/src/designer/model.js';
import { sentence, sentenceText } from '../web/src/designer/sentences.js';
import { SKELETON_LIST, skeletonStages } from '../web/src/designer/skeletons.js';
import { method } from './engine-fixture.js';

// The designer's pure parts: sentences instead of formulas, inputs offered by kind, worked examples through the
// engine, method skeletons, and the changes view.

const block = (id: string) => BLOCKS.find((b) => b.id === id)!;

describe('method designer', () => {
  it('every calculation of the block library reads as a sentence, never a formula', () => {
    for (const b of BLOCKS) for (const c of b.calcs) {
      const words = sentence(b, c).filter((p) => typeof p === 'string').join('');
      expect(words, `${b.id}.${c.name}`).not.toMatch(/[×÷=]|\$|T\d|C\d/);
    }
    const d = method();
    const weigh = d.stages[0]!.steps[0]!;
    expect(sentenceText(d, block('weigh'), weigh.settings, sentence(block('weigh'), block('weigh').calcs[0]!))).toBe('The net mass must be within ± 10 % of 50.0 mg.');
  });

  it('every block reads in words with its default settings: a limit written in the block too, never [object Object]', () => {
    const d = method();
    for (const b of BLOCKS) {
      const t = stepFrom(b, []);
      const text = [stepText(d, t, 0), ...b.calcs.map((c) => sentenceText(d, b, t.settings, sentence(b, c)))].join(' ');
      expect(text, `${b.id} v${b.version}`).not.toMatch(/\[object Object\]|undefined|NaN/);
    }
    // Any shape written into a block reads in words too.
    const check = block('check');
    const said = (limit: unknown) => sentenceText(d, check, {}, sentence(check, { name: 'x', label: 'x', template: 'C1', args: { value: '$reading', limit } }));
    expect(said({ high: '0' })).toBe('The reading must be 0: none allowed.');
    expect(said({ max: 0 })).toBe('The reading must be at most 0.');
    expect(said({ low: '2', high: '5', unit: 'mg' })).toBe('The reading must be within 2 to 5 mg.');
    expect(said([{ high: '$limit', highStrict: true }, { min: 1 }])).toBe('The reading must be less than the limits and at least 1.');
  });

  it('a check around an optional target that is not set is left out whole, as the engine leaves it out', () => {
    const d = method();
    const w = block('weigh');
    expect(sentenceText(d, w, { what: 'Sample', unit: 'mg', tolerance: '10' }, sentence(w, w.calcs[0]!))).toBe('');
    expect(stepText(d, { ...stepFrom(w, []), settings: { what: 'Sample', unit: 'mg', tolerance: '10' } }, 0)).not.toMatch(/must be/);
  });

  it('a quantity or limit is offered only from values of a compatible kind', () => {
    expect(neededKind(block('weigh'), 'target', { unit: 'mg' })).toBe('mass');
    expect(neededKind(block('dry-constant'), 'maxChange')).toBe('mass');
    expect(neededKind(block('check'), 'limit', { unit: '%' })).toBe('fraction');
    expect(neededKind(block('periodic-check'), 'limit', { unit: '°C' })).toBe('temperature');
    // A limit on a result whose template sets its kind: the %RSD is a percentage, whatever the responses are in.
    expect(neededKind(block('system-suitability'), 'rsdLimit')).toBe('fraction');
    expect(['speedLimit', 'temperatureLimit', 'tailingLimit'].map((n) => neededKind(BLOCKS.find((b) => b.settings.some((x) => x.name === n))!, n)))
      .toEqual(['rotation speed', 'temperature', 'count']);
    const masses = earlierRefs(method(), 3, 1).filter((r) => r.kind === 'mass').map((r) => r.ref);
    expect(masses).toEqual(['standard/weigh-std/mass', 'drying/lod/weight', 'sample/weigh-sample/mass']);
    // A later step, or a step inside another replicate stage, is never offered; nor is a check.
    expect(earlierRefs(method(), 3, 1).map((r) => r.ref)).not.toContain('sample/result/reading');
    expect(earlierRefs(method(), 3, 1).map((r) => r.ref)).not.toContain('run/temp/readingCheck');
    expect(earlierRefs(method(), 2, 0).map((r) => r.ref)).toEqual(['standard/weigh-std/mass', 'standard/dissolve/speed', 'drying/lod/weight']);
    const replicate = method();
    replicate.stages[1]!.kind = 'replicate';
    replicate.stages[1]!.count = 2;
    expect(earlierRefs(replicate, 3, 1).map((r) => r.ref).some((r) => r.startsWith('drying/'))).toBe(false);
  });

  it('worked examples run the engine on example values: the weighing meets its target, the readings are in limits', () => {
    const d = method();
    const std = workedExample(d, 0, 0);
    expect(std.values.mass).toEqual({ value: '50.0', unit: 'mg' });
    expect(std.results.massCheck).toMatchObject({ ok: true, check: { pass: true } });
    expect(workedExample(d, 3, 0).results.massCheck).toMatchObject({ ok: true, check: { pass: true } });
    expect(workedExample(d, 1, 0).results.constant).toMatchObject({ ok: true, check: { pass: true } });
    expect(workedExample(d, 2, 1).results.precision).toMatchObject({ ok: true, rsdCheck: { pass: true } });
    expect(workedExample(d, 2, 2).results.readingCheck).toMatchObject({ ok: true, check: { pass: true } });
    expect(workedExample(d, 3, 1).results.factor).toMatchObject({ ok: true, value: '10', shown: 'Dilution factor = 50.0 mL ÷ 5.0 mL = 10' });
    expect(workedExample(d, 3, 2).results.readingCheck).toMatchObject({ ok: true, check: { pass: true } });
    // A value typed over the example is used as typed.
    expect(workedExample(d, 3, 2, { reading: { value: '94.0', unit: '%' } }).results.readingCheck).toMatchObject({ ok: true, check: { pass: false } });
    expect(workedExample(d, 0, 0, { mass: { value: '60.0', unit: 'mg' } }).results.massCheck).toMatchObject({ ok: true, check: { pass: false } });
  });

  it('the method skeletons are valid drafts; what they leave open is listed by the method check', () => {
    expect(SKELETON_LIST.map((s) => s.id)).toEqual(['hplc-external-standard', 'titration', 'uv-specific-absorbance', 'related-substances', 'dissolution', 'water-kf',
      'loss-on-drying', 'physical-tests', 'microbial-limits', 'sterility-membrane', 'endotoxin-kinetic', 'bioburden']);
    const header = method().header;
    for (const s of SKELETON_LIST) {
      const doc = masterSchema.parse({ header, stages: skeletonStages(s.id) });
      expect(doc.stages.every((st) => st.steps.every((t) => findBlock(t.block)))).toBe(true);
      expect(masterChecks(doc).filter((p) => !/not set|not checked|choose the rooms/.test(p.message)), s.id).toEqual([]);
    }
    expect(skeletonStages('nothing')).toEqual([]);
    const hplc = skeletonStages('hplc-external-standard');
    expect(hplc.map((s) => `${s.key} ${s.kind} ${s.count ?? ''} ${s.uses.join()}: ${s.steps.map((t) => t.key).join(' ')}`)).toEqual([
      'standard preparation  : weigh-standard dissolve-standard dilute-standard',
      'sample normal  : weigh-sample-1 weigh-sample-2 dissolve-sample dilute-sample',
      'run normal  standard: run sst assay',
    ]);
    // The assay refers to the weighings and dilutions before it; its limit is the specification's.
    expect(hplc[2]!.steps[2]!.settings).toMatchObject({ stdMass: { ref: 'standard/weigh-standard/mass' }, sample2Mass: { ref: 'sample/weigh-sample-2/mass' },
      sample1Factor: { ref: 'sample/dilute-sample/factor' }, limit: { spec: 'limit' } });
    // Each skeleton ends with its result step, whose reportable value is its `result`.
    expect(SKELETON_LIST.map((s) => skeletonStages(s.id).at(-1)!.steps.at(-1)!.block.id)).toEqual(['assay', 'titration', 'assay-absorbance', 'impurities', 'dissolution',
      'water-kf', 'loss-on-drying', 'disintegration', 'count', 'sterility-test', 'endotoxin', 'bioburden']);
    expect(hplc[0]!.produces).toEqual({ name: 'standard solution', holdHours: 24 });
    // The weighings start with what is weighed, the unit and the usual tolerance; they are checked by a second person.
    expect(hplc[0]!.steps[0]).toMatchObject({ name: 'Weigh the reference standard', checker: true, settings: { tolerance: '10', what: 'Reference standard', unit: 'mg' } });
    expect(skeletonStages('physical-tests')[0]!.steps.map((t) => t.block.id)).toEqual(['uniformity-by-weight', 'friability', 'disintegration']);
  });

  it('a step added from the library starts with its block\'s defaults: the usual weighing tolerance, a repeat-until for a stop check, a periodic interval', () => {
    expect(stepFrom(block('weigh'), []).settings).toEqual({ tolerance: '10' });
    expect(stepFrom(block('mix'), []).settings).toEqual({});
    expect(stepFrom(block('weigh'), ['weigh']).key).toBe('weigh-2');
    expect(stepFrom(block('dry-constant'), []).flow).toEqual({ kind: 'repeat-until', maxRounds: 10 });
    expect(stepFrom(block('periodic-check'), [])).toMatchObject({ flow: { kind: 'repeat-until', maxRounds: 10 }, everyMinutes: 1440 });
  });

  it('the changes view shows what changed, was added or removed since the previous version', () => {
    const prev = method();
    const next = method();
    next.header.reference = 'Ph. Int. monograph';
    next.stages[3]!.steps.pop();
    next.stages[0]!.produces!.holdHours = 48;
    const diff = diffMasters(prev, next);
    const lines = diff.flatMap((s) => s.lines.filter((l) => l.change !== 'same').map((l) => `${s.title} ${l.key} ${l.change}`));
    expect(lines).toEqual(['Header technique changed', 'Stage 1: Standard solution about changed', 'Stage 4: Sample solutions result removed']);
    expect(describeMaster(prev).map((s) => s.title)).toEqual(['Header', 'Stage 1: Standard solution', 'Stage 2: Loss on drying', 'Stage 3: Instrument run', 'Stage 4: Sample solutions']);
    expect(describeMaster(prev)[0]!.lines.map((l) => l.text)).toEqual(['Method QC-M-001, Examplol assay by HPLC.', 'Technique HPLC. Reference In-house method QC-M-001, version 1.']);
    expect(diffMasters(prev, method()).every((s) => s.change === 'same')).toBe(true);
  });

  it('an author\'s answer to a warning is kept in the method document with the warning as answered', () => {
    const prev = method();
    const warning: Problem = { level: 'warning', path: 'stages[0].steps[0]', message: 'Is the standard dried first?', question: { key: 'dried/weigh-std', options: ['yes', 'no'], needsReason: true } };
    const next = answerDoc(prev, warning, 'yes', '  Dried at 105 °C for 3 hours ');
    expect(next.answers).toEqual({ 'dried/weigh-std': { about: 'Is the standard dried first?', choice: 'yes', reason: 'Dried at 105 °C for 3 hours' } });
    expect(masterSchema.parse(next).answers).toEqual(next.answers);
    // A problem without a question is not answered.
    expect(answerDoc(prev, { ...warning, question: undefined }, 'yes', 'r')).toBe(prev);
  });
});
