/**
 * Environmental monitoring and water (LIMS-36, LIMS-37; plan 2.9), the Logbook way: the plan's samplings due per
 * period, the excursion level of a reviewed result, an excursion's status from its insert-only entries, and the daily
 * summary report files of the continuous monitoring systems (owner, 18 Nov 2026), read by a FIXED layout per system
 * kind. Pure functions, tested; nothing here is stored.
 */
import { c1WithinLimits } from '../templates/index.js';
import type { Limit } from '../master/schema.js';
import { COLONY_KINDS, type Frequency, type Identify, type MonitoringDoc, type SamplingKind } from '../master/monitoring.js';
import { addDays } from './stability.js';

// ---- The schedule ----

/** The period a frequency counts in, holding a plant date: the day, the week (from Monday) or the month; per batch: none. */
export function periodOf(f: Frequency, date: string): { key: string; from: string; to: string } | null {
  if (f === 'per batch') return null;
  if (f === 'daily' || f === 'per shift') return { key: date, from: date, to: date };
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (f === 'weekly') {
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const from = addDays(date, -dow);
    return { key: `W${from}`, from, to: addDays(from, 6) };
  }
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  return { key: from.slice(0, 7), from, to: addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1) };
}

/** A sampling taken: its point and sampling keys and the plant date it was taken on. */
export interface Take { point: string; sampling: string; on: string }
export type DueState = 'done' | 'due' | 'overdue';
export interface DueRow {
  point: string; sampling: string; frequency: Frequency; period: { key: string; from: string; to: string };
  needed: number; taken: number; state: DueState; missed: string | null;
}

/**
 * The plan's samplings for today (LIMS-36): per sampling of a frequency (not per batch), how many are needed in the
 * current period (per shift: the plan's shifts a day) and how many were taken; due while short; overdue when the
 * previous period (on or after `since`, the day the plan became effective) was short too; the missed period named.
 */
export function dueList(doc: MonitoringDoc, takes: readonly Take[], today: string, since: string): DueRow[] {
  const out: DueRow[] = [];
  for (const p of doc.points) for (const s of p.samplings) {
    const cur = periodOf(s.frequency, today);
    if (!cur) continue;
    const needed = s.frequency === 'per shift' ? doc.header.shifts : 1;
    const count = (from: string, to: string) => takes.filter((t) => t.point === p.key && t.sampling === s.key && t.on >= from && t.on <= to).length;
    const taken = count(cur.from, cur.to);
    const prev = periodOf(s.frequency, addDays(cur.from, -1))!;
    const missed = prev.from >= since && count(prev.from, prev.to) < needed ? prev.key : null;
    out.push({ point: p.key, sampling: s.key, frequency: s.frequency, period: cur, needed, taken, state: taken >= needed ? 'done' : missed ? 'overdue' : 'due', missed });
  }
  return out;
}

// ---- Excursions ----

export type Level = 'none' | 'alert' | 'action';
/**
 * The excursion level of a reviewed result against its test's limit (LIMS-36, library S11): over the action limit,
 * action; over the alert limit, alert (a trend watch); a colony count in a grade A room acts on any colony.
 */
export function excursionLevel(result: { value: string; unit: string }, limit: Limit | undefined, grade: string | null, kind: SamplingKind): { level: Level; why: string } {
  if (grade === 'A' && COLONY_KINDS.includes(kind) && Number(result.value) > 0) return { level: 'action', why: `Grade A: ${result.value} ${result.unit} (any colony is acted on).` };
  if (!limit) return { level: 'none', why: 'No limit.' };
  const r = c1WithinLimits({ value: { value: result.value, unit: result.unit }, limit });
  if (!r.ok || !r.check) return { level: 'none', why: r.ok ? 'No limit.' : r.message };
  return { level: r.check.level === 'fail' ? 'action' : r.check.level === 'alert' ? 'alert' : 'none', why: r.check.shown };
}

export type ExcursionEventKind = 'confirmed' | 'deviation' | 'checked' | 'isolate' | 'closed' | 'note';
export interface ExcursionEvent {
  id: number; kind: ExcursionEventKind; person: number;
  payload: { number?: string; byHand?: boolean; entry?: number; genus?: string; species?: string; method?: string; report?: string; text?: string };
}
export interface ExcursionFacts {
  origin: 'result' | 'import';
  level: 'alert' | 'action';
  recordedBy: number;
  // Isolates to identify: the sampling's rule (no, on action, any growth) and whether there was growth.
  identify: Identify;
  growth: boolean;
}
export type ExcursionStatus = 'to confirm' | 'investigation to open' | 'deviation to check' | 'isolates to identify' | 'open' | 'trend watch' | 'closed';

const deviationOf = (events: readonly ExcursionEvent[]) => events.filter((e) => e.kind === 'deviation').at(-1);
/** Whether the isolates must be identified: the sampling says so (on action excursions, or on any growth). */
export const needsIsolates = (x: ExcursionFacts) => x.growth && (x.identify === 'any growth' || (x.identify === 'on action' && x.level === 'action'));

/**
 * The status, from the entries: an alarm imported from a monitoring system waits for a second person to confirm it;
 * an action excursion waits for its investigation (a deviation number, checked by a second person when typed by hand),
 * then the isolates where the sampling says, then QA's closure; an alert is a trend watch (its isolates identified
 * where the sampling says so on any growth).
 */
export function excursionStatus(x: ExcursionFacts, events: readonly ExcursionEvent[]): ExcursionStatus {
  if (events.some((e) => e.kind === 'closed')) return 'closed';
  if (x.origin === 'import' && !events.some((e) => e.kind === 'confirmed')) return 'to confirm';
  if (x.level === 'alert') return needsIsolates(x) && !events.some((e) => e.kind === 'isolate') ? 'isolates to identify' : 'trend watch';
  const dev = deviationOf(events);
  if (!dev) return 'investigation to open';
  if (dev.payload.byHand && !events.some((e) => e.kind === 'checked' && e.payload.entry === dev.id)) return 'deviation to check';
  if (needsIsolates(x) && !events.some((e) => e.kind === 'isolate')) return 'isolates to identify';
  return 'open';
}

export type ExcursionAction = 'confirm' | 'deviation' | 'check' | 'isolate' | 'close';
/**
 * Why this person may not take this action now (plain words); null when they may. `deviationClosed`: Deviations' word
 * on the excursion's deviation (true closed, false open, null not read: link absent or down).
 */
export function excursionRefusal(action: ExcursionAction, x: ExcursionFacts, events: readonly ExcursionEvent[], person: number, deviationClosed: boolean | null = null): string | null {
  const status = excursionStatus(x, events);
  if (status === 'closed') return 'The excursion is closed.';
  const dev = deviationOf(events);
  switch (action) {
    case 'confirm':
      if (x.origin !== 'import') return 'Only an alarm imported from a monitoring system is confirmed.';
      if (status !== 'to confirm') return 'A second person has already confirmed it.';
      if (person === x.recordedBy) return 'You imported the report: a second person confirms the alarm.';
      return null;
    case 'deviation':
      if (status === 'to confirm') return 'A second person confirms the alarm first.';
      if (x.level !== 'action') return 'An alert is a trend watch: no investigation is opened.';
      if (dev) return `The investigation is deviation ${dev.payload.number}.`;
      return null;
    case 'check':
      if (!dev?.payload.byHand) return 'There is no deviation number typed by hand to check.';
      if (events.some((e) => e.kind === 'checked' && e.payload.entry === dev.id)) return 'A second person has already checked the deviation number.';
      if (person === dev.person) return 'You typed the deviation number: a second person checks it.';
      return null;
    case 'isolate':
      if (!x.growth) return 'No growth: there is nothing to identify.';
      if (status === 'to confirm') return 'A second person confirms the alarm first.';
      return null;
    case 'close':
      if (status === 'to confirm') return 'A second person confirms the alarm first.';
      if (status === 'investigation to open') return 'Open the investigation first: the deviation number.';
      if (status === 'deviation to check') return 'A second person checks the deviation number typed by hand first.';
      if (status === 'isolates to identify') return 'Identify the isolates first (genus and species from the identification report).';
      if (dev && deviationClosed === false) return `Deviation ${dev.payload.number} is still open in Deviations: it is closed there first.`;
      if (dev?.payload.byHand && person === dev.person) return 'You typed the deviation number: another QA person closes the excursion.';
      return null;
  }
}

// ---- The daily summary reports of the continuous monitoring systems (owner, 18 Nov 2026) ----

/**
 * The fixed layouts (docs/design.md, "EM and water"): a CSV with this header row, one row per room and size channel
 * (particle counter) or per water point (online TOC and conductivity), all of one plant date; alarm empty, ALERT or
 * ACTION. Counts are per m³ (a per ft³ column is refused, library S11); TOC in ppb; conductivity in µS/cm as the
 * monitor reports it.
 */
export const REPORT_LAYOUTS = {
  particle: { name: 'Particle counter daily summary', header: ['date', 'room', 'channel_um', 'count_per_m3', 'max_per_m3', 'alarm'] },
  water: { name: 'Online water monitor daily summary', header: ['date', 'point', 'toc_ppb', 'conductivity_us_cm', 'alarm'] },
} as const;
export type ReportKind = keyof typeof REPORT_LAYOUTS;
export interface ReportRow { where: string; channel?: string; values: Record<string, string>; alarm: 'ALERT' | 'ACTION' | null }
export type Parsed = { ok: true; date: string; rows: ReportRow[] } | { ok: false; message: string };
const MAX_ROWS = 2000;
const NUMBER = /^\d+(\.\d+)?$/;

/** Reads a daily summary report by its layout; refuses anything else with the line and the reason. */
export function parseReport(kind: ReportKind, text: string): Parsed {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cells = (l: string) => l.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const layout = REPORT_LAYOUTS[kind];
  const head = cells(lines[0] ?? '').map((c) => c.toLowerCase());
  if (head.some((c) => /ft3|ft³|cu_?ft/.test(c))) return { ok: false, message: 'The report gives counts per cubic foot: the layout is per m³ (1 per ft³ = 35.3 per m³); export it per m³.' };
  if (head.join(',') !== layout.header.join(',')) return { ok: false, message: `Line 1 is not the ${layout.name.toLowerCase()} layout: the header must be ${layout.header.join(',')}.` };
  if (lines.length < 2) return { ok: false, message: 'The report has no rows.' };
  if (lines.length - 1 > MAX_ROWS) return { ok: false, message: `The report has more than ${MAX_ROWS} rows: a daily summary, not a database.` };
  let date = '';
  const rows: ReportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = cells(lines[i]!);
    const at = `Line ${i + 1}`;
    if (c.length !== layout.header.length) return { ok: false, message: `${at}: ${c.length} values, the layout has ${layout.header.length}.` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[0]!)) return { ok: false, message: `${at}: the date ${c[0]} is not YYYY-MM-DD.` };
    if (date && c[0] !== date) return { ok: false, message: `${at}: the date ${c[0]} differs from ${date}: one report is one day.` };
    date = c[0]!;
    if (!c[1]) return { ok: false, message: `${at}: no ${kind === 'particle' ? 'room' : 'point'}.` };
    const alarm = c.at(-1)!.toUpperCase();
    if (alarm && alarm !== 'ALERT' && alarm !== 'ACTION') return { ok: false, message: `${at}: the alarm ${c.at(-1)} is not ALERT or ACTION.` };
    const nums = c.slice(kind === 'particle' ? 3 : 2, -1);
    const bad = nums.find((n) => !NUMBER.test(n));
    if (bad !== undefined) return { ok: false, message: `${at}: ${bad || 'an empty value'} is not a number.` };
    if (kind === 'particle') {
      if (c[2] !== '0.5' && c[2] !== '5.0' && c[2] !== '5') return { ok: false, message: `${at}: the size channel ${c[2]} µm is not 0.5 or 5.0.` };
      rows.push({ where: c[1]!, channel: c[2] === '0.5' ? '0.5' : '5.0', values: { count: c[3]!, max: c[4]! }, alarm: (alarm || null) as ReportRow['alarm'] });
    } else {
      rows.push({ where: c[1]!, values: { toc: c[2]!, conductivity: c[3]! }, alarm: (alarm || null) as ReportRow['alarm'] });
    }
  }
  return { ok: true, date, rows };
}

/** A report row in words: "B101 0.5 µm: 2 900 per m³ (max 3 400)", "PW-04: TOC 120 ppb, 0.9 µS/cm". */
export const rowWords = (kind: ReportKind, r: ReportRow) => (kind === 'particle'
  ? `${r.where} ${r.channel} µm: ${r.values.count} per m³ (max ${r.values.max} per m³)`
  : `${r.where}: TOC ${r.values.toc} ppb, conductivity ${r.values.conductivity} µS/cm`);
