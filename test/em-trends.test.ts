import { describe, expect, it } from 'vitest';
import { adverseRule, adverseTrends, newOrganisms, repeatedAlerts, roomAlerts, weekOf, type EmResult, type Isolate } from '../shared/engine/em-trends.js';
import { monitoringChecks, monitoringSchema } from '../shared/master/monitoring.js';
import type { Level } from '../shared/engine/monitoring.js';

// EM adverse trends (LIMS-36; EU Annex 1): repeated alerts at a point, alerts across a room in a week, new organisms.
let id = 0;
const r = (point: string, on: string, level: Level, over: Partial<EmResult> = {}): EmResult =>
  ({ sampleId: ++id, sampleNo: `LS${id}`, on, room: 'B101', point, sampling: 'sp', kind: 'settle plate', grade: 'B', level, ...over });

describe('EM adverse trends', () => {
  it('LIMS-36 the default adverse-trend rule by grade (a starting point the plan can change): A/B 2 in 3, C/D and water 3 in 5', () => {
    expect(adverseRule('A')).toEqual({ n: 2, m: 3 });
    expect(adverseRule('B')).toEqual({ n: 2, m: 3 });
    expect(adverseRule('C')).toEqual({ n: 3, m: 5 });
    expect(adverseRule(null)).toEqual({ n: 3, m: 5 });
    expect(adverseRule('B', { n: 3, m: 4 })).toEqual({ n: 3, m: 4 });
  });

  it('LIMS-36 repeated alerts at one point: grade B, the second alert or action result in 3 samplings is an adverse trend; one in 3 is not', () => {
    const s = [r('SP1', '2026-11-02', 'alert'), r('SP1', '2026-11-03', 'none'), r('SP1', '2026-11-04', 'none'), r('SP1', '2026-11-05', 'action'), r('SP1', '2026-11-06', 'alert')];
    // 02 alert; 05 action (window 03-05: one); 06 alert (window 04-06: two) → one trend, at 06.
    expect(repeatedAlerts(s).map((a) => [a.key, a.samples])).toEqual([[`repeat:SP1:sp:${s[4]!.sampleNo}`, [s[3]!.sampleNo, s[4]!.sampleNo]]]);
    expect(repeatedAlerts(s)[0]!.what).toBe(`SP1 settle plate: 2 alert or action results in the last 3 samplings (adverse trend at 2 in 3): ${s[3]!.sampleNo} action, ${s[4]!.sampleNo} alert`);
    // Grade C (3 in 5): only at 06 (02, 05 and 06 in the last 5); without 02 none. The plan's own setting (2 in 4): at 05 and 06.
    expect(repeatedAlerts(s.map((x) => ({ ...x, grade: 'C' }))).map((a) => a.on)).toEqual(['2026-11-06']);
    expect(repeatedAlerts(s.slice(1).map((x) => ({ ...x, grade: 'C' })))).toEqual([]);
    expect(repeatedAlerts(s.map((x) => ({ ...x, grade: 'C', rule: { n: 2, m: 4 } }))).map((a) => a.on)).toEqual(['2026-11-05', '2026-11-06']);
    // Other points and samplings are counted apart.
    expect(repeatedAlerts([r('SP1', '2026-11-02', 'alert'), r('SP2', '2026-11-03', 'alert'), r('SP1', '2026-11-03', 'alert', { sampling: 'cp' })])).toEqual([]);
  });

  it('LIMS-36 alerts at 2 or more points of one room in the same week (Monday to Sunday)', () => {
    expect(weekOf('2026-11-15')).toBe('2026-11-09');
    expect(weekOf('2026-11-16')).toBe('2026-11-16');
    const s = [r('SP1', '2026-11-10', 'alert'), r('SP2', '2026-11-13', 'action'), r('SP3', '2026-11-16', 'alert'), r('SP4', '2026-11-12', 'none')];
    expect(roomAlerts(s).map((a) => [a.key, a.points])).toEqual([['room:B101:2026-11-09', ['SP1', 'SP2']]]);
    // Another room's alert in that week does not count.
    expect(roomAlerts([r('SP1', '2026-11-10', 'alert'), r('C1', '2026-11-11', 'alert', { room: 'C201' })])).toEqual([]);
  });

  it('LIMS-36 a new organism: genus (or genus and species when given) not identified at the room in the 12 months before', () => {
    const i = (n: number, room: string, genus: string, species: string | null, on: string): Isolate => ({ id: n, room, point: 'SP1', genus, species, on });
    const all = [
      i(1, 'B101', 'Staphylococcus', 'epidermidis', '2025-10-01'),
      i(2, 'B101', 'Staphylococcus', 'epidermidis', '2026-09-01'),   // seen 11 months before: not new
      i(3, 'B101', 'Staphylococcus', 'aureus', '2026-09-15'),        // a new species of a known genus: new
      i(4, 'B101', 'Bacillus', null, '2026-10-01'),                  // new genus
      i(5, 'C201', 'Staphylococcus', 'epidermidis', '2026-10-02'),   // another room: new there
      i(6, 'B101', 'Micrococcus', 'luteus', '2025-01-10'),
      i(7, 'B101', 'Micrococcus', 'luteus', '2026-02-10'),           // last seen 13 months before: new again
    ];
    expect(newOrganisms(all).map((a) => a.key)).toEqual(['flora:1', 'flora:3', 'flora:4', 'flora:5', 'flora:6', 'flora:7']);
    expect(newOrganisms(all).find((a) => a.key === 'flora:3')!.what).toBe('B101, SP1: new organism Staphylococcus aureus (not identified at B101 in the 12 months before)');
    expect(adverseTrends([], all)[0]!.key).toBe('flora:5');
  });

  it('LIMS-36 the plan\'s adverse-trend setting: n not more than m', () => {
    const doc = monitoringSchema.parse({ header: { number: 'EMP-1', name: 'x' }, points: [{ key: 'p1', code: 'SP1', name: '', of: 'room', room: { itemId: 'r', code: 'B101', name: 'x', grade: 'B' },
      samplings: [{ key: 'sp', kind: 'settle plate', frequency: 'daily', state: 'in operation', spec: null, quantity: '1 plate', adverse: { n: 4, m: 3 } }] }] });
    expect(monitoringChecks(doc, () => null).map((p) => p.message)).toContain('SP1, settle plate: the adverse trend is n results in the last m samplings: n (4) cannot be more than m (3).');
  });
});
