import { describe, expect, it } from 'vitest';
import { BLOCKS } from '../shared/blocks/index.js';
import { masterChecks, plainWords } from '../shared/master/checks.js';
import { placeChecks } from '../shared/master/places.js';
import { masterSchema, type MasterDoc } from '../shared/master/schema.js';
import { describeMaster } from '../web/src/designer/describe.js';
import { verdictless } from '../web/src/designer/example.js';
import { grouped, qtyText, stageRoomChoices, unitsOf } from '../web/src/designer/model.js';
import { sentence, sentenceText } from '../web/src/designer/sentences.js';
import { SKELETON_LIST, skeletonStages } from '../web/src/designer/skeletons.js';
import { method } from './engine-fixture.js';

// The designer findings of the full demo run (what the method check reports, the plain view's words, and the pick
// lists offered from master data), on the lab method.

const block = (id: string) => BLOCKS.find((b) => b.id === id)!;
const header = method().header;
const room = (code: string, name: string, area: string | null, active = true) => ({ itemId: code, code, name, version: 1, active, area, grade: 'D' });
const machine = (code: string, type: string | null, at: string | null, active = true) => ({ itemId: code, code, name: code, version: 1, active, kind: 'instrument' as const, type, room: at });
const MD = {
  rooms: [room('RM-110', 'QC instrument laboratory', 'QC'), room('RM-111', 'QC wet chemistry laboratory', 'QC'), room('RM-120', 'Microbiology laboratory', 'Micro'),
    room('RM-999', 'Old laboratory', 'QC', false)],
  equipment: [machine('IN-BAL-01', 'Balance', 'RM-111'), machine('IN-HPLC-01', 'HPLC', 'RM-110'), machine('IN-OV-01', 'Oven', 'RM-111'),
    machine('IN-SON-01', 'Sonicator', 'RM-111'), machine('IN-DT-01', 'Disintegration tester', 'RM-120'), machine('IN-HPLC-02', 'HPLC', 'RM-999', false)],
};
/** The fixture with the rooms each stage may run in. */
const roomed = (rooms: string[][]): MasterDoc => { const d = method(); d.stages.forEach((s, i) => { s.roomTypes = rooms[i] ?? []; }); return d; };
const physical = () => masterSchema.parse({ header, stages: skeletonStages('physical-tests') });

describe('designer findings on the lab method', () => {
  it('LIMS-12 the method check warns when no machine of a step\'s type stands in the rooms its stage allows, and says where it stands', () => {
    const doc = roomed([['QC'], ['RM-111'], ['RM-111'], []]);
    expect(placeChecks(doc, MD)).toEqual([{ level: 'warning', rule: 'LIMS-12', path: 'stages[2].steps[0]',
      message: 'No instrument stands in a room this stage allows (RM-111): IN-HPLC-01 stands in RM-110. Allow its room in the stage settings, or engineering moves it in master data' }]);
    // Allowed by its area: no warning. The balances of the sample stage (no rooms named) are found anywhere.
    expect(placeChecks(roomed([['QC'], ['RM-111'], ['QC'], []]), MD)).toEqual([]);
    // Master data without an active machine of the stage's type: said so (an inactive one does not count).
    expect(placeChecks(doc, { ...MD, equipment: MD.equipment.filter((m) => m.code !== 'IN-HPLC-01') }).map((p) => p.message))
      .toEqual(['Master data has no instrument (no machine of its type): the floor could not record this step. Engineering adds it in master data']);
    // A machine of the field's type the stage's machine types leave out.
    const noOven = roomed([['QC'], ['RM-111'], ['QC'], []]);
    noOven.stages[1]!.machineTypes = ['balance'];
    expect(placeChecks(noOven, MD).map((p) => `${p.path}: ${p.message}`))
      .toEqual(['stages[1].steps[0]: No oven or furnace is offered on the floor: the stage allows only the machine types balance. Add its type to the stage\'s machine types (IN-OV-01 stands in RM-111)']);
  });

  it('a temperature recorded without its optional limits is a warning until they are set', () => {
    const doc = physical();
    expect(masterChecks(doc).filter((p) => /recorded but not checked/.test(p.message)).map((p) => `${p.path}: ${p.message}`))
      .toEqual(['stages[0].steps[2].settings.temperatureLimit: Medium temperature is recorded but not checked: set the medium temperature limits']);
    doc.stages[0]!.steps[2]!.settings.temperatureLimit = { low: '35', high: '39', unit: '°C' };
    expect(masterChecks(doc).filter((p) => /recorded but not checked/.test(p.message))).toEqual([]);
  });

  it('the method check reports everything the plain view shows as not set; optional settings left empty are left out of the sentences', () => {
    for (const s of SKELETON_LIST) {
      const doc = masterSchema.parse({ header, stages: skeletonStages(s.id).map((st, i) => (i === 0 ? { ...st, role: '' } : st)) });
      const problems = masterChecks(doc);
      for (const [si, sec] of describeMaster(doc).filter((x) => x.key.startsWith('stage:')).entries()) {
        for (const [li, line] of sec.lines.entries()) {
          if (!/not set|not chosen|\?/.test(line.text)) continue;
          const path = li === 0 ? `stages[${si}]` : `stages[${si}].steps[${li - 1}]`;
          expect(problems.some((p) => p.path === path || p.path.startsWith(`${path}.`)), `${s.id}: ${line.text}`).toBe(true);
        }
      }
    }
    // A dilution with only its first step: no "(not set)" for the optional second and third.
    const dl = block('dilute');
    const one = { from: 'Stock', diluent: 'Water', aliquot1: '5.0 mL', volume1: '50.0 mL' };
    expect(sentenceText(method(), dl, one, sentence(dl, dl.calcs[1]!))).toBe('The dilution factor is worked out from 5.0 mL, 50.0 mL.');
    // The disintegration medium's temperature: no sentence while its limits are empty.
    const di = block('disintegration');
    expect(sentenceText(method(), di, { maxTime: '15' }, sentence(di, di.calcs[0]!))).toBe('');
    // A stage without a responsible role is reported.
    const d = method();
    expect(masterChecks({ ...d, stages: d.stages.map((s, i) => (i === 0 ? { ...s, role: '' } : s)) }).some((p) => p.path === 'stages[0]' && /no responsible role/.test(p.message))).toBe(true);
  });

  it('the plain view gives numbers with their units and plain sentences', () => {
    const di = block('disintegration');
    expect(sentenceText(method(), di, { maxTime: '15' }, sentence(di, di.calcs[1]!)))
      .toBe('Each of the times of 6 tablets must be at most 15 min; when one or two are not, the times of 12 more tablets are recorded too, and at least 16 of the 18 must be.');
    const d = method();
    const lines = describeMaster(d).flatMap((s) => s.lines.map((l) => l.text));
    expect(lines).toContain('A preparation, the responsibility of the Analyst. Machine types: balance, sonicator. Rooms: any. Produces standard solution, to be used within 24 hours.');
    expect(lines).toContain('Done in 2 replicates, the responsibility of the Analyst. Machine types: balance. Rooms: any. Produces no intermediate.');
    expect(lines.find((l) => l.startsWith('A stage') && l.includes('Uses '))).toBe('A stage, the responsibility of the Analyst. Machine types: hplc. Rooms: any. Uses standard solution from Standard solution. Produces no intermediate.');
    d.stages[0]!.produces!.holdHours = 720;
    expect(describeMaster(d).flatMap((s) => s.lines.map((l) => l.text)).find((l) => l.includes('Produces standard solution'))).toMatch(/to be used within 720 hours \(30 days\)\./);
    // A step by its title as on the floor, never its internal key.
    const weigh = lines.find((l) => l.startsWith('1. Weigh: Reference standard:'))!;
    expect(weigh).toContain('The net mass must be within ± 10 % of 50.0 mg. Signed by the analyst and checked by a second person. Critical step.');
    expect(weigh).not.toContain('weigh-std');
    expect(lines.find((l) => l.includes('Read a value at intervals'))).toContain('Repeated until the check "Test finished" passes, at most 40 rounds, a round every 30 minutes.');
    expect(grouped('600.0 mg × 50000 units = 30.000 kg')).toBe('600.0 mg × 50,000 units = 30.000 kg');
    expect(grouped('CC-2026-0016, 49225.7 units, 100000 units')).toBe('CC-2026-0016, 49225.7 units, 1,00,000 units');
  });

  it('no internal codes of rules, templates or failure cases in what the method check says', () => {
    expect(plainWords('The dilution factor (L21) and the precision (T7)')).toBe('The dilution factor and the precision');
    for (const s of SKELETON_LIST) {
      for (const p of masterChecks(masterSchema.parse({ header, stages: skeletonStages(s.id) }))) expect(p.message).not.toMatch(/\bT\d+\b|\bL\d+\b|\bLIMS-\d+|\bF0\d{3}\b/);
    }
  });

  it('the worked example gives its verdict once, in the chip', () => {
    expect(verdictless('All 6 units disintegrated within 15 min: PASS')).toBe('All 6 units disintegrated within 15 min');
    expect(verdictless('6.0 within limits')).toBe('6.0 within limits');
  });

  it('pick lists offer the rooms where a stage\'s machines stand first, by area and by room', () => {
    const run = method().stages.find((s) => s.key === 'run')!;
    const st = stageRoomChoices(run, MD);
    expect(st.groups).toEqual([{ label: "Where this stage's machines stand", options: ['QC', 'RM-110'] },
      { label: 'Other areas', options: ['Micro'] }, { label: 'Other rooms', options: ['RM-111', 'RM-120'] }]);
    expect(st.text('RM-110')).toBe('RM-110 · QC instrument laboratory (QC)');
    // A stage that only weighs on a balance: no machines to place it by.
    const sample = method().stages.find((s) => s.key === 'sample')!;
    expect(stageRoomChoices(sample, MD).groups[0]!.options).toEqual([]);
  });

  it('a small quantity reads in g; the unit lists offer every unit of the unit table', () => {
    expect(qtyText({ ok: true, value: '0.0025', unit: 'kg', shown: '' })).toBe('2.500 g');
    expect(qtyText({ ok: true, value: '1.2625', unit: 'kg', shown: '' })).toBe('1.263 kg');
    expect(qtyText({ ok: false, message: 'x' })).toBe('—');
    expect(unitsOf('temperature').map((u) => u.symbol)).toEqual(['°C', 'K', '°F']);
    expect(unitsOf('volume').map((u) => u.symbol)).toContain('mL');
  });
});
