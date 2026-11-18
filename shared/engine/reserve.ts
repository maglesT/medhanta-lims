/**
 * Reserve (retention) samples (LIMS-30), the Logbook way: a row (the lot's or batch's release sample it was kept from,
 * how much, where, and until when, with the rule that sets that date) and insert-only entries (the yearly visual
 * inspection, withdrawals, the destruction, a second person's check of a withdrawal or the destruction, notes). Its
 * status is computed here, never stored: kept, visual inspection overdue, below the required quantity, or destroyed.
 * The required quantity is the specification's (header reserveQuantity: at least twice the quantity needed for all its
 * tests except sterility and pyrogen, US 211.170(a)); QC approval of a release sample waits for it (reserveShortfall).
 */
import { Decimal } from 'decimal.js';
import { dayWords } from './items.js';

/** A quantity with its unit, as a specification or a reserve sample gives it ("60 tablets", "25 g"). */
export interface Qty { amount: string; unit: string }
const QTY = /^(\d+(?:\.\d+)?)\s*(\S.*)$/;
export const QTY_PATTERN = /^\d+(\.\d+)?\s*\S.*$/;
export function parseQty(text: string | undefined | null): Qty | null {
  const m = QTY.exec((text ?? '').trim());
  return m ? { amount: m[1]!, unit: m[2]!.trim() } : null;
}
const sameUnit = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const qtyWords = (q: Qty) => `${q.amount} ${q.unit}`;

/**
 * How long a reserve sample is kept: the rule picked, the date it counts from (typed from the batch record or MMS: LIMS
 * does not hold it) and the kept-until date typed, which must be at least that date plus the rule's years.
 */
export const KEEP_RULES = {
  expiry: { years: 1, from: 'Expiry date of the lot or batch', words: '1 year after the expiry date of the lot or batch', clauses: 'US 211.170(a),(b); EU C6 6.14, Annex 19; IN SCHM 19.8.2; API Q7 11.71' },
  distribution: { years: 3, from: 'Date the batch was completely distributed', words: '3 years after the batch is completely distributed (an API with a retest date)', clauses: 'API Q7 11.71' },
  'starting material': { years: 2, from: 'Release date of the material', words: '2 years after release (other starting materials)', clauses: 'IN SCHM 19.8.2 (no. to verify)' },
} as const;
export type KeepRule = keyof typeof KEEP_RULES;
export const KEEP_RULE_NAMES = Object.keys(KEEP_RULES) as KeepRule[];

/** A date plus whole years (29 February becomes 28 February). */
export function addYears(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const leap = (n: number) => (n % 4 === 0 && n % 100 !== 0) || n % 400 === 0;
  const dd = m === 2 && d === 29 && !leap(y + years) ? 28 : d;
  return `${String(y + years).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** What is recorded when the reserve sample is logged. day: the plant date it was logged. */
export interface ReserveFacts {
  amount: string; unit: string; location: string; rule: KeepRule; fromDate: string; keptUntil: string; loggedBy: number; day: string;
}
export const FINDINGS = ['no deterioration', 'deterioration'] as const;
export type Finding = (typeof FINDINGS)[number];
export const RESERVE_EVENT_KINDS = ['inspected', 'withdrawn', 'destroyed', 'checked', 'note'] as const;
export type ReserveEventKind = (typeof RESERVE_EVENT_KINDS)[number];
export interface ReservePayload {
  // inspected: the yearly visual inspection's finding (a deterioration with its reason).
  finding?: Finding;
  // withdrawn: how much (in the reserve's unit); withdrawn, destroyed, a deterioration: why.
  amount?: string; reason?: string;
  // checked: the withdrawal or destruction checked by a second person.
  of?: number;
  text?: string;
}
export interface ReserveEvent { id: number; kind: ReserveEventKind; person: number; day: string; payload: ReservePayload }

/** The actions on a reserve sample and the entry each adds. */
export const RESERVE_ACTIONS = { inspect: 'inspected', withdraw: 'withdrawn', destroy: 'destroyed', check: 'checked', note: 'note' } as const satisfies Record<string, ReserveEventKind>;
export type ReserveAction = keyof typeof RESERVE_ACTIONS;
export const RESERVE_ACTION_NAMES = Object.keys(RESERVE_ACTIONS) as ReserveAction[];

export type ReserveStatusName = 'kept' | 'visual inspection overdue' | 'below the required quantity' | 'destroyed';
export interface ReserveState {
  status: ReserveStatusName;
  // What is left: the amount logged less every withdrawal, in the reserve's unit.
  left: string;
  // The next yearly visual inspection: a year after the last one (or after logging).
  inspectionDue: string;
  // Every point to know, in plain words (empty: kept, nothing to do).
  why: string[];
}

const checkedBy = (events: readonly ReserveEvent[], e: ReserveEvent) => events.some((x) => x.kind === 'checked' && x.payload.of === e.id);
/** The withdrawal or destruction waiting for a second person's check, if any. */
export function reserveWaitingCheck(events: readonly ReserveEvent[]): ReserveEvent | null {
  return events.find((e) => (e.kind === 'withdrawn' || e.kind === 'destroyed') && !checkedBy(events, e)) ?? null;
}
const leftOf = (r: ReserveFacts, events: readonly ReserveEvent[]) =>
  events.filter((e) => e.kind === 'withdrawn').reduce((n, e) => n.minus(new Decimal(e.payload.amount ?? '0')), new Decimal(r.amount));

/** Is the reserve below the specification's required quantity (or in another unit)? The words, or null. */
function shortWords(left: Decimal, unit: string, required: Qty | null): string | null {
  if (!required) return null;
  if (!sameUnit(unit, required.unit)) return `it is logged in ${unit}, the specification asks for ${qtyWords(required)}`;
  return left.lessThan(new Decimal(required.amount)) ? `${left.toString()} ${unit} left, the specification asks for at least ${qtyWords(required)}` : null;
}

/** The status of a reserve sample today (the plant date). */
export function reserveStatus(r: ReserveFacts, events: readonly ReserveEvent[], required: Qty | null, today: string): ReserveState {
  const left = leftOf(r, events);
  const inspected = events.filter((e) => e.kind === 'inspected').at(-1);
  const inspectionDue = addYears(inspected?.day ?? r.day, 1);
  const why: string[] = [];
  const waiting = reserveWaitingCheck(events);
  if (waiting) why.push(`the ${waiting.kind === 'withdrawn' ? `withdrawal of ${waiting.payload.amount} ${r.unit}` : 'destruction'} of ${dayWords(waiting.day)} waits for a second person's check`);
  const destroyed = events.find((e) => e.kind === 'destroyed');
  if (destroyed) return { status: 'destroyed', left: left.toString(), inspectionDue, why: [`destroyed on ${dayWords(destroyed.day)}: ${destroyed.payload.reason ?? ''}`.trim(), ...why] };
  const short = shortWords(left, r.unit, required);
  if (short) why.unshift(`below the required quantity: ${short}`);
  const overdue = inspectionDue < today;
  if (overdue) why.push(`the yearly visual inspection was due on ${dayWords(inspectionDue)}`);
  if (inspected?.payload.finding === 'deterioration') why.push(`deterioration seen on ${dayWords(inspected.day)}: ${inspected.payload.reason ?? ''}`.trim());
  if (r.keptUntil < today) why.push(`kept until ${dayWords(r.keptUntil)}: it may now be destroyed`);
  return { status: short ? 'below the required quantity' : overdue ? 'visual inspection overdue' : 'kept', left: left.toString(), inspectionDue, why };
}

/** What is typed when the reserve sample is logged. */
export interface ReserveInput { quantity: string; location: string; rule: KeepRule; fromDate: string; keptUntil: string }
/** Why the reserve sample cannot be logged as typed (all at once); empty when it can. */
export function reserveLogProblems(b: ReserveInput, required: Qty | null, today: string): string[] {
  const out: string[] = [];
  const q = parseQty(b.quantity);
  if (!q || new Decimal(q.amount).lessThanOrEqualTo(0)) out.push('Give the quantity kept with its unit, e.g. 60 tablets.');
  else if (required && !sameUnit(q.unit, required.unit)) out.push(`The specification asks for the reserve in ${required.unit} (${qtyWords(required)}): give the quantity kept in ${required.unit}.`);
  // Logged at least at the required quantity (US 211.170(a)): what is kept is counted once, when it is put away.
  else if (required && new Decimal(q.amount).lessThan(new Decimal(required.amount))) out.push(`The specification asks for at least ${qtyWords(required)}: keep at least that much (US 211.170(a)).`);
  if (!b.location.trim()) out.push('Give the storage location.');
  const rule = KEEP_RULES[b.rule];
  if (!isDay(b.fromDate)) out.push(`Give the ${rule.from.toLowerCase()}.`);
  if (!isDay(b.keptUntil)) out.push('Give the date it is kept until.');
  else if (b.keptUntil <= today) out.push('The kept-until date must be after today.');
  else if (isDay(b.fromDate) && b.keptUntil < addYears(b.fromDate, rule.years)) out.push(`Kept until must be on or after ${dayWords(addYears(b.fromDate, rule.years))}: ${rule.words}.`);
  return out;
}

/** Why this person may not add this entry now (plain words); null when they may. */
export function reserveRefusal(action: ReserveAction, r: ReserveFacts, events: readonly ReserveEvent[], person: number, p: ReservePayload, today: string): string | null {
  const waiting = reserveWaitingCheck(events);
  if (action === 'check') {
    if (!waiting) return 'There is no withdrawal or destruction waiting for a second person\'s check.';
    if (waiting.person === person) return 'The person who recorded the entry cannot check it: a second person checks it.';
    return null;
  }
  if (events.some((e) => e.kind === 'destroyed')) return 'The reserve sample is destroyed: nothing more is recorded.';
  switch (action) {
    case 'inspect':
      if (!p.finding || !FINDINGS.includes(p.finding)) return 'Give the finding: no deterioration, or deterioration.';
      if (p.finding === 'deterioration' && !p.reason?.trim()) return 'Say what deterioration was seen.';
      return null;
    case 'withdraw': {
      if (waiting) return `Entry ${waiting.id} waits for a second person's check first.`;
      const a = /^\d+(\.\d+)?$/.test(p.amount ?? '') ? new Decimal(p.amount!) : null;
      if (!a || a.lessThanOrEqualTo(0)) return `Give the quantity withdrawn in ${r.unit}, e.g. 10.`;
      const left = leftOf(r, events);
      if (a.greaterThan(left)) return `Only ${left.toString()} ${r.unit} is left.`;
      if (!p.reason?.trim()) return 'Give the reason for the withdrawal.';
      return null;
    }
    case 'destroy':
      if (waiting) return `Entry ${waiting.id} waits for a second person's check first.`;
      if (today <= r.keptUntil) return `The reserve sample is kept until ${dayWords(r.keptUntil)}: it is not destroyed earlier.`;
      if (!p.reason?.trim()) return 'Give the reason for the destruction.';
      return null;
    case 'note':
      return p.text?.trim() ? null : 'Write the note.';
  }
}

/** What the QC decision of a release sample needs to know about its lot's reserve sample. */
export interface ReserveNeed {
  // The specification's reserve quantity (null: it names none, and nothing is checked).
  required: Qty | null;
  reserve: { left: string; unit: string; destroyed: boolean } | null;
}
/**
 * LIMS-30 (owner, plan section 9 question 5): a release sample whose specification names a reserve quantity is approved
 * only once a reserve sample of its lot or batch is logged with at least that quantity ("shall": US 211.170, EU Annex
 * 19). The words that stand in the way, or null.
 */
export function reserveShortfall(n: ReserveNeed): string | null {
  if (!n.required) return null;
  const need = qtyWords(n.required);
  if (!n.reserve) return `No reserve sample of this lot or batch is logged: the specification asks for at least ${need} (US 211.170, EU Annex 19).`;
  if (n.reserve.destroyed) return `The reserve sample of this lot or batch is destroyed: the specification asks for at least ${need}.`;
  const short = shortWords(new Decimal(n.reserve.left), n.reserve.unit, n.required);
  return short ? `The reserve sample is below the required quantity: ${short}.` : null;
}
