import { describe, expect, it } from 'vitest';
import { findBlock } from '../shared/blocks/index.js';
import { emptyNote, machineRefusal, roomRefusal } from '../shared/engine/picks.js';
import { SKELETON_LIST, skeletonStages } from '../web/src/designer/skeletons.js';

// Equipment and instrument types as the demo master data names them: the lab's own, and production machines that share
// a word with a lab field and must not be offered there (master data is shared with production).
const TYPES = ['Balance', 'Analytical balance', 'Micro balance', 'Semi-micro balance', 'IPC balance', 'Platform balance', 'HPLC', 'GC',
  'Sonicator', 'Magnetic stirrer', 'Stirrer', 'Incubator shaker', 'Anchor stirrer vessel', 'Rapid mixer granulator', 'Planetary mixer (semi-solid)',
  'Hot air oven', 'Muffle furnace', 'Fluid bed dryer', 'Tray dryer', 'Vacuum tray dryer', 'Friabilator', 'Disintegration tester', 'Sieve shaker',
  'UV-Vis spectrophotometer', 'Dissolution tester', 'Potentiometric titrator', 'Karl Fischer titrator',
  // The microbiology lab (build step 7); a production tablet counter shares the word "counter".
  'Incubator', 'Colony counter', 'Tablet counter', 'Endotoxin reader', 'Heating block'];
const MACHINES = TYPES.map((type, i) => ({ code: `EQ-${i}`, type, room: null }));
const BALANCES = ['Balance', 'Analytical balance', 'Micro balance', 'Semi-micro balance', 'IPC balance'];
// The instrument of a run takes the instrument types the stage allows (the skeleton's run stage: HPLC and GC).
const OFFERS: Record<string, string[]> = {
  'weigh.balance': BALANCES, 'mix.machine': ['Sonicator', 'Magnetic stirrer', 'Stirrer'], 'instrument-run.instrument': ['HPLC', 'GC'],
  'uniformity-by-weight.balance': BALANCES, 'friability.machine': ['Friabilator'], 'disintegration.machine': ['Disintegration tester'],
  // The result blocks' instruments: a Karl Fischer titrator is not offered for a titration, nor a titrator for water.
  'assay-absorbance.spectrophotometer': ['UV-Vis spectrophotometer'], 'dissolution.apparatus': ['Dissolution tester'],
  'titration.titrator': ['Potentiometric titrator'], 'water-kf.titrator': ['Karl Fischer titrator'],
  'loss-on-drying.balance': BALANCES, 'loss-on-drying.oven': ['Hot air oven', 'Muffle furnace'],
  // The micro skeletons: an incubator (never an incubator shaker), a colony counter (never a tablet counter), the endotoxin reader its stage allows.
  'incubate.incubator': ['Incubator'], 'count.counter': ['Colony counter'], 'sterility-test.ftmIncubator': ['Incubator'], 'sterility-test.scdmIncubator': ['Incubator'],
  'endotoxin.reader': ['Endotoxin reader'],
};
const field = (block: string, name: string) => findBlock({ id: block, version: 1 })!.fields.find((f) => f.name === name)!;

describe('machine pickers on the demo master-data types', () => {
  // The types alone: here every stage allows any room (the rooms are tested below).
  const stages = SKELETON_LIST.flatMap((s) => skeletonStages(s.id)).map((s) => ({ ...s, roomTypes: [] }));

  it('LIMS-12 every machine field of the method skeletons offers the machines of its kind, never a production machine that shares a word', () => {
    const seen = new Set<string>();
    for (const stage of stages) for (const st of stage.steps) {
      for (const f of findBlock(st.block)!.fields.filter((x) => x.kind === 'machine')) {
        const key = `${st.block.id}.${f.name}`;
        seen.add(key);
        expect([key, MACHINES.filter((m) => !machineRefusal(stage, f, m, [])).map((m) => m.type)]).toEqual([key, OFFERS[key]]);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(OFFERS).sort());
  });

  it('LIMS-12 drying to constant mass offers a lab oven or furnace, never a production dryer', () => {
    const oven = field('dry-constant', 'machine');
    expect(MACHINES.filter((m) => !machineRefusal(stages[0]!, oven, m, [])).map((m) => m.type)).toEqual(['Hot air oven', 'Muffle furnace']);
    expect(machineRefusal(stages[0]!, oven, { code: 'EQ-FBD-1', type: 'Fluid bed dryer', room: null }, [])).toBe('EQ-FBD-1 is not a oven or furnace (master data: Fluid bed dryer)');
  });

  it('LIMS-12 a production platform balance is refused for a lab weighing, with the reason', () => {
    expect(machineRefusal(stages[0]!, field('weigh', 'balance'), { code: 'IN-BAL-09', type: 'Platform balance', room: null }, [])).toBe('IN-BAL-09 is not a balance (master data: Platform balance)');
    expect(machineRefusal(stages[0]!, field('weigh', 'balance'), { code: 'BAL-X', type: null, room: null }, [])).toBe('BAL-X has no type in master data, so it is not offered as a balance');
  });

  it('LIMS-12 the instrument of a run is one of the instrument types the stage allows', () => {
    const stage = { ...stages[0]!, machineTypes: ['HPLC', 'UHPLC'] };
    expect(MACHINES.filter((m) => !machineRefusal(stage, field('instrument-run', 'instrument'), m, [])).map((m) => m.type)).toEqual(['HPLC']);
    expect(machineRefusal(stage, field('instrument-run', 'instrument'), { code: 'INQ-GC-01', type: 'GC', room: null }, [])).toBe('INQ-GC-01 is not one of the machine types this stage allows (HPLC, UHPLC)');
    // A balance is not one of the stage's instruments: any balance of the right kind is offered.
    expect(machineRefusal(stage, field('weigh', 'balance'), { code: 'INQ-BAL-01', type: 'Analytical balance', room: null }, [])).toBeNull();
  });

  // The demo's lab rooms (master data): RM-110 (QC), RM-112 (Instrument room), RM-601 (Microbiology); RM-101 is Dispensing.
  const ROOMS = [{ code: 'RM-101', area: 'Dispensing' }, { code: 'RM-110', area: 'QC' }, { code: 'RM-112', area: 'Instrument room' }, { code: 'RM-601', area: 'Microbiology' }];
  const BALS = [['IN-BAL-03', 'RM-101'], ['INQ-BAL-01', 'RM-110'], ['INQ-BAL-02', 'RM-112'], ['INQ-BAL-07', 'RM-601'], ['INQ-BAL-08', null]]
    .map(([code, room]) => ({ code: code!, type: 'Analytical balance', room }));

  it('LIMS-12 a balance is offered only in a room the stage allows (by area or by room code)', () => {
    const stage = { ...stages[0]!, roomTypes: ['QC', 'RM-112'] };
    const offered = (s = stage) => BALS.filter((b) => !machineRefusal(s, field('weigh', 'balance'), b, ROOMS)).map((b) => b.code);
    expect(offered()).toEqual(['INQ-BAL-01', 'INQ-BAL-02']);
    expect(offered({ ...stage, roomTypes: [] })).toEqual(BALS.map((b) => b.code));
    expect(machineRefusal(stage, field('weigh', 'balance'), BALS[0]!, ROOMS)).toBe('IN-BAL-03 stands in RM-101, not in a room this stage allows (QC, RM-112)');
    expect(machineRefusal(stage, field('weigh', 'balance'), BALS[4]!, ROOMS)).toBe('INQ-BAL-08 stands in no room in master data, so it is not in a room this stage allows (QC, RM-112)');
    expect(roomRefusal(stage, ROOMS[3]!)).toBe('RM-601 is not one of the rooms this stage allows (QC, RM-112)');
    expect(roomRefusal(stage, ROOMS[2]!)).toBeNull();
  });

  it('LIMS-12 an empty machine picker says why: where the machines of its type stand, or that master data has none (17 Nov 2026 run, F17)', () => {
    const stage = { ...stages[0]!, roomTypes: ['RM-112'] };
    const tester = field('disintegration', 'machine');
    const all = [{ code: 'INQ-DT-01', type: 'Disintegration tester', room: 'RM-110' }, { code: 'BAL-X', type: null, room: null }, { code: 'INQ-HPLC-01', type: 'HPLC', room: 'RM-112' }];
    expect(emptyNote(stage, tester, all, ROOMS)).toBe('No disintegration tester can be used here: INQ-DT-01 stands in RM-110, not in a room this stage allows (RM-112). '
      + '1 machine has no type in master data, so it is not offered. Engineering moves one into a room this stage allows, or adds one, in master data (the Logbook shows where each stands).');
    expect(emptyNote(stage, tester, all.slice(1), ROOMS)).toBe('Master data has no active disintegration tester. 1 machine has no type in master data, so it is not offered. Engineering adds it in master data.');
  });
});
