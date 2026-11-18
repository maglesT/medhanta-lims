/**
 * EM adverse trends (LIMS-36; EU Annex 1: adverse trends in environmental monitoring are found and investigated), the
 * simple way: three fixed checks over the decided EM and water results and the isolates identified, pure and tested.
 * Each finding is an "adverse trend" entry with a stable key; QC acknowledges it (an insert-only answer, as the OOT
 * answer). Nothing here is stored.
 *  1. Repeated alerts at one point: n alert-or-action results in the last m samplings of a point's sampling (the plan's
 *     setting, else the default by grade).
 *  2. Alerts at 2 or more points of one room in the same week (Monday to Sunday, plant dates).
 *  3. A new organism: an isolate whose genus (or genus and species, when the species is given) was not identified at
 *     that room (or water system) in the 12 months before it.
 */
import type { Level } from './monitoring.js';

export interface AdverseRule { n: number; m: number }
/** The starting point when the plan's sampling names none (the plan's author can change it): grade A/B 2 in 3; C/D and water 3 in 5. */
export function adverseRule(grade: string | null, set?: AdverseRule): AdverseRule {
  if (set) return set;
  return grade === 'A' || grade === 'B' ? { n: 2, m: 3 } : { n: 3, m: 5 };
}

/** One decided result of a point's sampling, oldest first. */
export interface EmResult { sampleId: number; sampleNo: string; on: string; room: string; point: string; sampling: string; kind: string; grade: string | null; level: Level; rule?: AdverseRule }
export interface Isolate { id: number; room: string; point: string; genus: string; species: string | null; on: string }
export type AdverseKind = 'repeated alerts' | 'alerts across a room' | 'new organism';
export interface Adverse { key: string; kind: AdverseKind; room: string; points: string[]; on: string; what: string; samples: string[] }

const adverse = (l: Level) => l === 'alert' || l === 'action';
/** The Monday of a plant date's week. */
export function weekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Check 1: at each alert or action result, n or more of the last m samplings (it included) were alert or action. */
export function repeatedAlerts(results: readonly EmResult[]): Adverse[] {
  const out: Adverse[] = [];
  const groups = new Map<string, EmResult[]>();
  for (const r of results) groups.set(`${r.point}|${r.sampling}`, [...(groups.get(`${r.point}|${r.sampling}`) ?? []), r]);
  for (const rs of groups.values()) rs.forEach((r, k) => {
    if (!adverse(r.level)) return;
    const { n, m } = adverseRule(r.grade, r.rule);
    const window = rs.slice(Math.max(0, k - m + 1), k + 1);
    const bad = window.filter((x) => adverse(x.level));
    if (bad.length < n) return;
    out.push({ key: `repeat:${r.point}:${r.sampling}:${r.sampleNo}`, kind: 'repeated alerts', room: r.room, points: [r.point], on: r.on, samples: bad.map((x) => x.sampleNo),
      what: `${r.point} ${r.kind}: ${bad.length} alert or action results in the last ${window.length} samplings (adverse trend at ${n} in ${m}): ${bad.map((x) => `${x.sampleNo} ${x.level}`).join(', ')}` });
  });
  return out;
}

/** Check 2: alert or action results at 2 or more points of one room in the same week. */
export function roomAlerts(results: readonly EmResult[]): Adverse[] {
  const out: Adverse[] = [];
  const groups = new Map<string, EmResult[]>();
  for (const r of results.filter((x) => adverse(x.level))) groups.set(`${r.room}|${weekOf(r.on)}`, [...(groups.get(`${r.room}|${weekOf(r.on)}`) ?? []), r]);
  for (const [k, rs] of groups) {
    const points = [...new Set(rs.map((r) => r.point))].sort();
    if (points.length < 2) continue;
    const [room, week] = k.split('|') as [string, string];
    out.push({ key: `room:${room}:${week}`, kind: 'alerts across a room', room, points, on: rs.at(-1)!.on, samples: rs.map((r) => r.sampleNo),
      what: `${room}: alert or action results at ${points.length} points in the week of ${week} (${points.join(', ')})` });
  }
  return out;
}

const DAY = 86_400_000;
/** Check 3: an isolate not seen at its room in the 12 months (365 days) before it, by genus, or genus and species when given. */
export function newOrganisms(isolates: readonly Isolate[]): Adverse[] {
  const name = (i: Isolate) => (i.species ? `${i.genus} ${i.species}` : i.genus);
  const same = (a: Isolate, b: Isolate) => a.genus.toLowerCase() === b.genus.toLowerCase() && (!a.species || (b.species ?? '').toLowerCase() === a.species.toLowerCase());
  return isolates.flatMap((i) => {
    const t = Date.parse(`${i.on}T00:00:00Z`);
    const seen = isolates.some((o) => {
      const to = Date.parse(`${o.on}T00:00:00Z`);
      return o !== i && o.room === i.room && same(i, o) && (to < t || (to === t && o.id < i.id)) && t - to <= 365 * DAY;
    });
    return seen ? [] : [{ key: `flora:${i.id}`, kind: 'new organism' as const, room: i.room, points: [i.point], on: i.on, samples: [],
      what: `${i.room}, ${i.point}: new organism ${name(i)} (not identified at ${i.room} in the 12 months before)` }];
  });
}

/** All adverse trends, newest first. */
export const adverseTrends = (results: readonly EmResult[], isolates: readonly Isolate[]) =>
  [...repeatedAlerts(results), ...roomAlerts(results), ...newOrganisms(isolates)].sort((a, b) => b.on.localeCompare(a.on) || a.key.localeCompare(b.key));
