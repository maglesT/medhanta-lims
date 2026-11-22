/**
 * The analysis's own status and what the reviewer reviews, computed from the step events and the analysis events
 * (reviewed, stopped, a deviation note closed by hand). Nothing is stored but the events.
 */
import type { Permission } from '../../server/auth.js';
import type { MasterDoc } from '../master/schema.js';
import { openSteps, outOfLimits, stepLabel, timers, type StepView, type Timer } from './analysis.js';
import { keyId, parseKey, type State, type StepEvent, type StepKey } from './state.js';
import { findBlock } from '../blocks/index.js';
import { failed } from './values.js';
import { isCaptured, isHand, PROVIDER_NAME, type LinkState, type Source } from './links.js';
import { trainingTyped } from './training.js';

// 'invalidated': QA invalidated its result in an OOS investigation (LIMS-24); the record stays, marked (LIMS-48).
export const ANALYSIS_EVENT_KINDS = ['reviewed', 'stopped', 'deviation_closed', 'invalidated'] as const;
export type AnalysisEventKind = (typeof ANALYSIS_EVENT_KINDS)[number];
// An analysis stopped before it is complete keeps its record (LIMS-48: aborted tests are kept), with the reason.
export interface AnalysisEvent { id: number; kind: AnalysisEventKind; payload: { note?: number; reason?: string; oos?: number; oosNo?: string }; person: number; at: Date }

export const ANALYSIS_STATUSES = ['in progress', 'complete', 'reviewed', 'stopped', 'invalidated'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export type AnalysisAction = 'review' | 'stop' | 'close-deviation';
export const ANALYSIS_ACTIONS: Record<AnalysisAction, { event: AnalysisEventKind; permission: Permission; from?: AnalysisStatus; meaning?: 'reviewed' | 'stopped' }> = {
  // LIMS-18, LIMS-19: a second person reviews the complete record with its audit trail.
  review: { event: 'reviewed', permission: 'lims.analysis.review', from: 'complete', meaning: 'reviewed' },
  // An analysis that cannot be finished (a broken instrument, a spilled sample) is stopped with a reason; it stays.
  stop: { event: 'stopped', permission: 'lims.analysis.review', meaning: 'stopped' },
  'close-deviation': { event: 'deviation_closed', permission: 'lims.qc.approve' },
};

/** "Stopped by … at …: reason" (screens and PDF). */
export function stoppedText<T extends string | Date>(t: { personName: string; at: T; payload: { reason?: string } }, clock: (at: T) => string): string {
  return `Stopped by ${t.personName} at ${clock(t.at)}: ${t.payload.reason ?? ''}`;
}

/**
 * A note with a reference is a linked deviation. While the Deviations link answers, its status is Deviations' (LIMS-20):
 * open until closed, rejected or cancelled ('Not a deviation', owner 20 Nov 2026) there. Otherwise it is open until QA closes it by hand with a reason.
 * The number comes back too (owner, 17 Nov 2026): a note written without a number that Deviations filed a deviation
 * from (its deviation_v1.source_ref names the note, deviation_note_v1) is that deviation, read live while the link
 * answers (`filed`). `typed`: the number was typed by hand while the link was off or down.
 */
export interface Deviation { note: number; step: string; reference: string; text: string; open: boolean; by: number | null; closed?: AnalysisEvent; status?: string; closedAt?: string | null; where?: string;
  filed?: boolean; typed?: boolean }
/** A deviation as read from the Deviations system now (server/links.ts); `number` for one found by the note it was filed from. */
export interface DeviationStatus { status: string; closedAt: string | null; number?: string }
/** The key, in the deviations read, of the deviation filed from a note (its number is not in the note). */
export const filedKey = (note: number) => `note:${note}`;
export const DEVIATION_DONE = ['closed', 'rejected', 'cancelled'];
const DEVIATION_WORDS: Record<string, string> = { classification: 'waiting for classification', investigation: 'under investigation', capa: 'waiting for its CAPA', closure: 'waiting for closure', cancelled: 'cancelled as not a deviation' };
/** A status of the Deviations system in plain words (its workflow step names are not shown as keys). */
export const deviationStatusWords = (s: string) => DEVIATION_WORDS[s] ?? s.replaceAll('_', ' ');
export function deviations(events: readonly StepEvent[], analysisEvents: readonly AnalysisEvent[], read?: ReadonlyMap<string, DeviationStatus> | null): Deviation[] {
  return events.filter((e) => e.kind === 'note').flatMap((e) => {
    const filed = e.payload.reference ? undefined : read?.get(filedKey(e.id));
    const reference = e.payload.reference ?? filed?.number;
    if (!reference) return [];
    const closed = analysisEvents.find((b) => b.kind === 'deviation_closed' && b.payload.note === e.id);
    const r = filed ?? read?.get(reference);
    const base = { note: e.id, step: keyId(e), reference, text: e.payload.text ?? '', by: e.person, ...(closed ? { closed } : {}),
      ...(filed ? { filed: true } : {}), ...(isHand(e.payload.source?.reference) ? { typed: true } : {}) };
    return [r ? { ...base, open: !DEVIATION_DONE.includes(r.status), status: r.status, closedAt: r.closedAt } : { ...base, open: !closed }];
  });
}
/**
 * A deviation's number and status in words, as the step, the release review and the PDF show it:
 * "DEV-26-0001 · under investigation (Deviations)", "DEV-7 (typed by hand) · open", "… · closed by QA".
 */
export function deviationText(d: Pick<Deviation, 'reference' | 'open' | 'status' | 'filed' | 'typed'>): string {
  const status = d.status !== undefined ? `${deviationStatusWords(d.status)} (DIVE)` : d.open ? 'open' : 'closed by QA';
  return `${deviationNumber(d)} · ${status}`;
}
/** The number, and where it came from when it was not picked from Deviations: typed by hand, or filed there from the note. */
export const deviationNumber = (d: Pick<Deviation, 'reference' | 'filed' | 'typed'>) =>
  `${d.reference}${d.typed ? ' (typed by hand)' : ''}${d.filed ? ' (filed in DIVE from this note)' : ''}`;

/** Every timer that ran over, with the deviation notes made after it (a hold: in the using stage; a check: on it). */
export function lateItems(doc: MasterDoc, events: readonly StepEvent[], now: Date): { timer: Timer; notes: StepEvent[] }[] {
  return timers(doc, events, now).filter((t) => t.state === 'late').map((timer) => ({
    timer,
    notes: events.filter((e) => e.kind === 'note' && e.at > timer.at && e.stage === timer.key.stage && (timer.kind === 'hold' || keyId(e) === keyId(timer.key))),
  }));
}

const FINISHED = ['done', 'checked', 'not_applicable'];
const STATE_WORDS: Record<State, string> = { waiting: 'is not started', open: 'is not started', in_progress: 'is in progress', done_awaiting_check: 'is waiting for its check', done: 'is done', checked: 'is checked', not_applicable: 'is not applicable' };

// `people`: everyone who recorded, signed or checked a step: none of them reviews the analysis (LIMS-41).
export interface AnalysisView { status: AnalysisStatus; open: string[]; late: string[]; deviations: Deviation[]; people: number[] }

/** The analysis status, and what stands in the way of the review; `read`: the deviations as Deviations has them now. */
export function analysisView(doc: MasterDoc, events: readonly StepEvent[], analysisEvents: readonly AnalysisEvent[], now: Date, read?: ReadonlyMap<string, DeviationStatus> | null): AnalysisView {
  const { stages, steps } = openSteps(doc, events, now);
  const open = [
    ...steps.filter((s) => !FINISHED.includes(s.state)).map((s) => `${stepLabel(doc, s.key)} ${s.needsResign ? 'needs signing again' : STATE_WORDS[s.state]}`),
    ...stages.filter((s) => !s.closed).map((s) => `Stage ${s.name} is not closed`),
  ];
  const late = lateItems(doc, events, now).filter((l) => !l.notes.length).map((l) => `${l.timer.label} ran over: a deviation note is needed`);
  const devs = deviations(events, analysisEvents, read).map((d) => ({ ...d, where: stepLabel(doc, parseKey(d.step)!) }));
  const has = (k: AnalysisEventKind) => analysisEvents.some((e) => e.kind === k);
  const status: AnalysisStatus = has('invalidated') ? 'invalidated' : has('stopped') ? 'stopped' : has('reviewed') ? 'reviewed' : open.length ? 'in progress' : 'complete';
  const people = [...new Set(events.filter((e) => e.person !== null && e.kind !== 'demo_wait_skipped').map((e) => e.person!))];
  return { status, open, late, deviations: devs, people };
}

/** An analysis status in words for people; `capital`: the first letter in capitals. */
export function statusWords(status: string, capital = false): string {
  return capital ? status.charAt(0).toUpperCase() + status.slice(1) : status;
}

/** Why the person may not do the analysis action now; null when they may. */
export function analysisRefusal(action: AnalysisAction, v: AnalysisView, user: { id?: number; permissions: readonly string[] }, note?: number): { status: 403 | 409; error: string; problems: string[] } | null {
  const rule = ANALYSIS_ACTIONS[action];
  if (!user.permissions.includes(rule.permission)) return { status: 403, error: 'forbidden', problems: ['You do not have the permission for this action.'] };
  const no = (...problems: string[]) => (problems.length ? { status: 409 as const, error: 'not_ready', problems } : null);
  const words = statusWords(v.status);
  if (v.status === 'reviewed' || v.status === 'stopped' || v.status === 'invalidated') return no(`The analysis is ${words}.`);
  if (action === 'stop') return null;
  if (action === 'close-deviation') {
    const d = v.deviations.find((x) => x.note === note && x.open);
    if (!d) return no('There is no open deviation note with this number.');
    if (d.status !== undefined) return no(`The status of ${d.reference} comes from the DIVE system (now ${deviationStatusWords(d.status)}): it is closed there.`);
    // By hand: a second person, who checked the closure in the deviation system or its paper record.
    if (d.by === user.id) return { status: 403, error: 'own_work', problems: ['You typed this deviation number: another person closes it.'] };
    return null;
  }
  // LIMS-11: the record is complete before it is reviewed; LIMS-41: the reviewer did no part of it.
  if (v.status === 'in progress') return no(...v.open);
  if (user.id !== undefined && v.people.includes(user.id)) return { status: 403, error: 'own_work', problems: ['You recorded or signed steps of this analysis: another person reviews it.'] };
  return no(...v.late);
}

/** What the reviewer reviews (LIMS-18, LIMS-19): every change, departure and finding of the analysis. Signatures are the server's. */
export function review(doc: MasterDoc, events: readonly StepEvent[], analysisEvents: readonly AnalysisEvent[], now: Date, read?: ReadonlyMap<string, DeviationStatus> | null) {
  const { steps } = openSteps(doc, events, now);
  const notes = (s: StepView) => s.events.filter((e) => e.kind === 'note');
  return {
    corrections: steps.flatMap((s) => s.replaced.map((r) => ({ step: s.id, ...r }))),
    sentBack: events.filter((e) => e.kind === 'sent_back'),
    late: lateItems(doc, events, now),
    outOfLimits: steps.flatMap((s) => outOfLimits(s).map(([calc, r]) => ({ step: s.id, calc, shown: r.ok ? r.shown : '', notes: notes(s) }))),
    inputChanged: steps.filter((s) => s.inputChanged.length).map((s) => ({ step: s.id, changes: s.inputChanged })),
    deviations: deviations(events, analysisEvents, read),
    // Every value typed by hand because a link was absent or down (owner 15 Nov 2026), and who typed it.
    hand: events.flatMap((e) => Object.entries(e.payload.source ?? {}).filter(([, x]) => isHand(x))
      .map(([field, x]) => ({ step: keyId(e), event: e.id, kind: e.kind, field, ...(x as Extract<Source, { from: 'hand' }>), person: e.person, at: e.at }))),
    // LIMS-19, LIMS-32, LIMS-33: every value read from an instrument (one per field, with the raw line) and every CDS
    // result file imported (one per import, with its file, hash and run, and the reason of a re-import).
    captured: events.flatMap((e) => {
      const got = Object.entries(e.payload.source ?? {}).filter((x): x is [string, Exclude<Source, { from: 'hand' }>] => isCaptured(x[1]));
      const base = { step: keyId(e), event: e.id, kind: e.kind, person: e.person, at: e.at, ...(e.payload.reason ? { reason: e.payload.reason } : {}) };
      const cds = got.filter(([, x]) => x.from === 'cds');
      return [
        ...got.filter(([, x]) => x.from === 'instrument').map(([field, x]) => ({ ...base, from: 'instrument' as const, fields: [field], shown: x.shown })),
        ...(cds.length ? [{ ...base, from: 'cds' as const, fields: inBlockOrder(doc, e, cds.map(([f]) => f)), shown: cds[0]![1].shown }] : []),
      ];
    }),
    notApplicable: events.filter((e) => e.kind === 'not_applicable'),
    // Every signature whose training was typed by hand because Recruitment was not reachable (owner, 17 Nov 2026).
    trainingTyped: trainingTyped(events),
    // Demo installations only: every wait ended at once by a person (server/demo.ts).
    demoSkips: events.filter((e) => e.kind === 'demo_wait_skipped'),
    analysisEvents,
  };
}

/** Field names of a step event in the order its block lists them (the database keeps a payload's keys in its own order). */
function inBlockOrder(doc: MasterDoc, e: StepKey, names: string[]): string[] {
  const order = findBlock(doc.stages[e.stage]!.steps[e.step]!.block)?.fields.map((f) => f.name) ?? [];
  return [...names].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
