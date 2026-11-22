/**
 * Stability studies (LIMS-26, LIMS-27, LIMS-28), the Logbook way: a study is a row (one approved protocol version applied
 * to one batch or lot, placed on a date: T0) and insert-only entries (placed per condition in a chamber, extra placement
 * and its QA approval, pulls, second-person checks, notes). The schedule, the stock, what is due and what is overdue are
 * computed here from the protocol and the entries, never stored.
 */
import { conditionLabel, type ProtocolDoc } from '../master/protocol.js';

// ---- Dates (plant calendar dates, "2026-11-18") ----
const parse = (d: string) => { const [y, m, x] = d.split('-').map(Number) as [number, number, number]; return { y, m, x }; };
const iso = (y: number, m: number, x: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(x).padStart(2, '0')}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** The date `months` calendar months after a date; the 31st becomes the month's last day (31 Aug + 6 months = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const { y, m, x } = parse(date);
  const t = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(t / 12);
  const nm = (t % 12) + 1;
  return iso(ny, nm, Math.min(x, daysIn(ny, nm)));
}
export function addDays(date: string, days: number): string {
  const { y, m, x } = parse(date);
  const d = new Date(Date.UTC(y, m - 1, x + days));
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// ---- The schedule ----
export interface TimePoint { condition: string; label: string; month: number; due: string; from: string; to: string }

/**
 * The time points of a study placed on `t0`: for each condition its months (a matrixing cell's own months for that
 * condition, when the study is that cell), each due `month` months after T0 with its pull window (± days).
 */
export function schedule(doc: ProtocolDoc, t0: string, cell?: string | null): TimePoint[] {
  return doc.conditions.flatMap((c) => {
    const own = cell ? doc.design.matrix.find((m) => m.cell === cell && m.condition === c.key) : undefined;
    return (own?.months ?? c.months).map((month) => {
      const due = addMonths(t0, month);
      return { condition: c.key, label: conditionLabel(c), month, due, from: addDays(due, -doc.pullWindowDays), to: addDays(due, doc.pullWindowDays) };
    });
  });
}

// ---- The entries ----
export const STUDY_EVENT_KINDS = ['placed', 'extra', 'extra_approved', 'pulled', 'checked', 'note'] as const;
export type StudyEventKind = (typeof STUDY_EVENT_KINDS)[number];
export interface ChamberRef { itemId: string; code: string; name: string }
export interface StudyEvent {
  id: number;
  kind: StudyEventKind;
  person: number;
  payload: {
    // placed, extra, pulled: the condition (its key in the protocol).
    condition?: string;
    // placed: the chamber (equipment of master data) and whether its Logbook status was typed by hand; the units placed.
    chamber?: ChamberRef; chamberByHand?: boolean; quantity?: string;
    // extra: why more is placed; extra_approved and checked: the entry approved or checked (0: the study itself).
    reason?: string; entry?: number;
    // pulled: the time point, the stability sample made, and for a late pull its reason and deviation.
    month?: number; due?: string; sampleId?: number; sampleNo?: string;
    late?: { reason: string; deviation: string; byHand: boolean };
    text?: string;
  };
}
export interface StudyFacts { createdBy: number; byHand: boolean; t0: string }

const amount = (s: string | undefined) => Number(s ?? 0);
const round = (n: number) => Math.round(n * 1000) / 1000;
/** Whether a second person has checked an entry (0: the study typed by hand). */
export const isChecked = (events: readonly StudyEvent[], entry: number) => events.some((e) => e.kind === 'checked' && e.payload.entry === entry);
export const pullOf = (events: readonly StudyEvent[], condition: string, month: number) =>
  events.find((e) => e.kind === 'pulled' && e.payload.condition === condition && e.payload.month === month);
export const placementOf = (events: readonly StudyEvent[], condition: string) => events.find((e) => e.kind === 'placed' && e.payload.condition === condition);

// ---- The stock (plan 2b-5): placed (and extra placement once QA approved it) − pulled, per condition ----
export interface Stock { condition: string; label: string; placed: number; used: number; left: number; needed: number; perPull: number; unit: string; extraWaiting: number }
export function stock(doc: ProtocolDoc, t0: string, events: readonly StudyEvent[], cell?: string | null): Stock[] {
  const per = amount(doc.quantity.amount);
  const points = schedule(doc, t0, cell);
  return doc.conditions.map((c) => {
    const approved = new Set(events.filter((e) => e.kind === 'extra_approved').map((e) => e.payload.entry));
    const extra = events.filter((e) => e.kind === 'extra' && e.payload.condition === c.key);
    const placed = amount(placementOf(events, c.key)?.payload.quantity) + extra.filter((e) => approved.has(e.id)).reduce((s, e) => s + amount(e.payload.quantity), 0);
    const pulls = events.filter((e) => e.kind === 'pulled' && e.payload.condition === c.key).length;
    const open = points.filter((p) => p.condition === c.key && !pullOf(events, c.key, p.month)).length;
    return { condition: c.key, label: conditionLabel(c), placed: round(placed), used: round(pulls * per), left: round(placed - pulls * per), needed: round(open * per), perPull: per,
      unit: doc.quantity.unit, extraWaiting: round(extra.filter((e) => !approved.has(e.id)).reduce((s, e) => s + amount(e.payload.quantity), 0)) };
  });
}

// ---- What is due ----
export type PointState = 'pulled' | 'due' | 'overdue' | 'not yet';
export function pointState(p: TimePoint, events: readonly StudyEvent[], today: string): PointState {
  if (pullOf(events, p.condition, p.month)) return 'pulled';
  if (today > p.to) return 'overdue';
  if (today >= p.from) return 'due';
  return 'not yet';
}

/**
 * Why this pull may not be made now (LIMS-28), in plain words; null when it may. A pull is made within its window; a late
 * one only with its reason and a deviation number; never before the window opens. The study typed by hand, and a
 * chamber whose Logbook status was typed by hand, are checked by a second person first. A pull that would leave a later
 * time point of the condition short is refused until QA approves more placement (plan 2b-5).
 */
export function pullRefusal(doc: ProtocolDoc, s: StudyFacts, events: readonly StudyEvent[], condition: string, month: number, today: string,
  late?: { reason?: string; deviation?: string }, cell?: string | null): string | null {
  if (s.byHand && !isChecked(events, 0)) return 'The batch of this study was typed by hand: a second person checks the study first.';
  const p = schedule(doc, s.t0, cell).find((x) => x.condition === condition && x.month === month);
  if (!p) return 'The protocol has no such time point.';
  const placed = placementOf(events, condition);
  if (!placed) return `Nothing is placed at ${p.label}.`;
  if (placed.payload.chamberByHand && !isChecked(events, placed.id)) return `The chamber ${placed.payload.chamber?.code ?? ''} was accepted without LEAD: a second person checks its status label first.`;
  const done = pullOf(events, condition, month);
  if (done) return `The ${month}-month pull at ${p.label} is done (${done.payload.sampleNo ?? ''}).`;
  if (today < p.from) return `The ${month}-month pull at ${p.label} is due on ${p.due}: its window opens on ${p.from}.`;
  if (today > p.to && !(late?.reason?.trim() && late.deviation?.trim())) return `The ${month}-month pull at ${p.label} is late (its window closed on ${p.to}): give the reason and the deviation number.`;
  const st = stock(doc, s.t0, events, cell).find((x) => x.condition === condition)!;
  const later = st.needed - st.perPull;
  if (st.left - st.perPull < later - 1e-9) {
    return `This pull would leave ${round(st.left - st.perPull)} ${st.unit} at ${p.label} for later time points that need ${round(later)} ${st.unit}: QA approves more placement first.`;
  }
  return null;
}

/** Why this person may not check this entry (0: the study itself) now; null when they may. */
export function checkRefusal(s: StudyFacts, events: readonly StudyEvent[], entry: number, person: number): string | null {
  if (entry === 0) {
    if (!s.byHand) return 'The batch was read from its link: there is nothing typed by hand to check.';
    if (isChecked(events, 0)) return 'A second person has already checked this study.';
    if (person === s.createdBy) return 'The person who typed the batch in cannot check it: a second person checks it.';
    return null;
  }
  const e = events.find((x) => x.id === entry);
  const typed = e && ((e.kind === 'placed' && e.payload.chamberByHand) || (e.kind === 'pulled' && e.payload.late?.byHand));
  if (!typed) return 'That entry has nothing typed by hand to check.';
  if (isChecked(events, entry)) return 'A second person has already checked it.';
  if (e.person === person) return 'You typed it: a second person checks it.';
  return null;
}

/** Why this person may not approve the extra placement now; null when they may (QA, not the person who placed it). */
export function extraRefusal(events: readonly StudyEvent[], entry: number, person: number): string | null {
  const e = events.find((x) => x.id === entry && x.kind === 'extra');
  if (!e) return 'There is no such extra placement.';
  if (events.some((x) => x.kind === 'extra_approved' && x.payload.entry === entry)) return 'QA has already approved this extra placement.';
  if (e.person === person) return 'You placed it: another person approves it (QA).';
  return null;
}

// ---- Ongoing stability (LIMS-27) ----
/** The pack QA answers for when the product has no on-going protocol at all. */
export const ANY_PACK = 'any';
export interface OngoingFlag { productCode: string; productName: string; pack: string | null; released: string[]; studies: string[]; answer: { text: string; by: string } | null; flag: string | null }
/**
 * Per product (a strength in master data) and primary pack: the batches TrueBatch released this year, and the
 * on-going studies started this year. Flagged when batches were released but no on-going study was started (and QA has
 * not answered it), or when the product has no effective on-going protocol at all.
 */
export function ongoingFlags(released: readonly { productCode: string; productName: string; batch: string }[],
  protocols: readonly { productCode: string; pack: string }[], studies: readonly { productCode: string; pack: string; studyNo: string }[],
  answers: readonly { productCode: string; pack: string; text: string; by: string }[]): OngoingFlag[] {
  const products = [...new Map(released.map((r) => [r.productCode, r.productName])).entries()].sort(([a], [b]) => a.localeCompare(b));
  return products.flatMap(([productCode, productName]): OngoingFlag[] => {
    const batches = released.filter((r) => r.productCode === productCode).map((r) => r.batch);
    const packs = [...new Set(protocols.filter((p) => p.productCode === productCode).map((p) => p.pack))];
    if (!packs.length) {
      const a = answers.find((x) => x.productCode === productCode && x.pack === ANY_PACK);
      return [{ productCode, productName, pack: null, released: batches, studies: [], answer: a ? { text: a.text, by: a.by } : null,
        flag: a ? null : `${batches.length} batch${batches.length === 1 ? '' : 'es'} released this year and no effective on-going stability protocol.` }];
    }
    return packs.map((pack) => {
      const on = studies.filter((s) => s.productCode === productCode && s.pack === pack).map((s) => s.studyNo);
      const a = answers.find((x) => x.productCode === productCode && x.pack === pack);
      return { productCode, productName, pack, released: batches, studies: on, answer: a ? { text: a.text, by: a.by } : null,
        flag: on.length || a ? null : `No on-going study started this year for ${pack}: put a batch on study, or QA records why not.` };
    });
  });
}

// ---- Chamber capacity (plan 2b-6) ----
export interface CapacityRow { chamber: ChamberRef; condition: string; studies: string[]; now: number; byYear: Record<number, number>; unit: string }
/**
 * Units booked per chamber and condition: what is in it now (placed and not pulled) and what stays in it at the start of
 * each coming year (the time points still to be pulled then). Units of different studies are added only in the same unit.
 */
export function capacity(studies: readonly { studyNo: string; doc: ProtocolDoc; t0: string; cell?: string | null; events: readonly StudyEvent[] }[],
  today: string, years: number[]): CapacityRow[] {
  const rows = new Map<string, CapacityRow>();
  for (const s of studies) {
    const st = stock(s.doc, s.t0, s.events, s.cell);
    const points = schedule(s.doc, s.t0, s.cell);
    for (const c of s.doc.conditions) {
      const place = placementOf(s.events, c.key);
      if (!place?.payload.chamber) continue;
      const k = `${place.payload.chamber.itemId}|${conditionLabel(c)}|${s.doc.quantity.unit}`;
      const row = rows.get(k) ?? { chamber: place.payload.chamber, condition: conditionLabel(c), studies: [], now: 0, byYear: Object.fromEntries(years.map((y) => [y, 0])), unit: s.doc.quantity.unit };
      const left = st.find((x) => x.condition === c.key)!.left;
      if (left <= 0) continue;
      row.studies.push(s.studyNo);
      row.now = round(row.now + left);
      const per = amount(s.doc.quantity.amount);
      for (const y of years) {
        const start = `${y}-01-01`;
        if (start <= today) continue;
        // What is still to be pulled on or after 1 January of that year; the spare beyond the time points leaves with the last.
        const still = points.filter((p) => p.condition === c.key && !pullOf(s.events, c.key, p.month) && p.due >= start).length;
        const spare = Math.max(0, left - st.find((x) => x.condition === c.key)!.needed);
        row.byYear[y] = round(row.byYear[y]! + still * per + (still ? spare : 0));
      }
      rows.set(k, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.chamber.code.localeCompare(b.chamber.code) || a.condition.localeCompare(b.condition));
}

// ---- Excursions (plan 2b-2) ----
export interface Reading { at: string; temperature: string; humidity?: string }
/**
 * The studies and time points an excursion of a chamber touches: each condition placed in that chamber on or before the
 * excursion's end, with its time points not pulled before the excursion began (the samples that were inside).
 */
export function affectedBy(x: { chamberItemId: string; fromDate: string; toDate: string },
  studies: readonly { id: number; studyNo: string; doc: ProtocolDoc; t0: string; cell?: string | null; events: readonly StudyEvent[]; pulledOn: Record<number, string> }[]) {
  return studies.flatMap((s) => s.doc.conditions.flatMap((c) => {
    const place = placementOf(s.events, c.key);
    if (place?.payload.chamber?.itemId !== x.chamberItemId || s.t0 > x.toDate) return [];
    const months = schedule(s.doc, s.t0, s.cell).filter((p) => p.condition === c.key).filter((p) => {
      const pull = pullOf(s.events, c.key, p.month);
      return !pull || (s.pulledOn[pull.id] ?? '') >= x.fromDate;
    }).map((p) => p.month);
    return months.length ? [{ studyId: s.id, studyNo: s.studyNo, condition: conditionLabel(c), months }] : [];
  }));
}

/** min and max of the readings, as written (the mean kinetic temperature is template L23's). */
export function readingRange(readings: readonly Reading[]): { min: string; max: string } | null {
  if (!readings.length) return null;
  const t = [...readings].sort((a, b) => Number(a.temperature) - Number(b.temperature));
  return { min: t[0]!.temperature, max: t.at(-1)!.temperature };
}
