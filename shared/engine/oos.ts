/**
 * OOS investigations (LIMS-23, LIMS-24; FDA guidance "Investigating OOS test results", 2022), the Logbook way: a row
 * (opened at once when a signed result of a spec test is out of its limit) and insert-only entries. Its status and
 * what each person may do next are computed here from the entries, never stored.
 *
 * Phase I (the laboratory): the analyst answers a fixed checklist (Ia) and may test a hypothesis by re-measuring, only
 * as planned in writing before it is done (Ib); every result stays and is shown, none is averaged with another. The
 * analyst concludes (an assignable laboratory error found, with its cause, or none); a supervisor who did no part of
 * the analysis reviews it (e-signature 'reviewed') or returns it.
 * Laboratory error: QA invalidates the result (e-signature 'oos_approved'); the analysis stays, marked invalidated
 * (LIMS-48), and QA authorises the retests, each a new analysis of the sample linked to the OOS.
 * No laboratory error: phase II (manufacturing) is a deviation in Deviations; QA concludes ("OOS confirmed" or, with an
 * assignable laboratory cause found there, "invalidated") once that deviation is closed.
 */

export const OOS_EVENT_KINDS = ['checklist', 'plan', 'remeasured', 'phase1_concluded', 'phase1_returned', 'phase1_reviewed',
  'phase2', 'phase2_checked', 'concluded', 'retest'] as const;
export type OosEventKind = (typeof OOS_EVENT_KINDS)[number];

/** Phase Ia: the fixed checklist; each answered yes or no, a "no" with its comment. */
export const OOS_CHECKLIST = [
  ['calculation', 'The calculation was checked and is correct'],
  ['suitability', 'System suitability passed'],
  ['standards', 'Standards and reagents were in date and made as written'],
  ['instrument', 'The instrument was fit for use and calibrated'],
  ['method', 'The method was followed as written'],
  ['preparation', 'The sample preparation was correct'],
  ['analyst', 'The analyst is trained in the method'],
  ['equipment', 'No glassware or equipment fault was seen'],
] as const;
export type ChecklistKey = (typeof OOS_CHECKLIST)[number][0];
export type Answers = Partial<Record<ChecklistKey, { yes: boolean; comment?: string }>>;

export type OosOutcome = 'confirmed' | 'invalidated';
export interface OosPayload {
  answers?: Answers;
  // plan: what is re-measured and by whom; remeasured: its plan (entry id), the value and where its raw data are.
  what?: string; by?: string; plan?: number; value?: string; reference?: string; pass?: boolean; shown?: string;
  // phase1_concluded: an assignable laboratory error found (with its cause) or not.
  labError?: boolean; cause?: string;
  reason?: string;
  // phase2: the deviation number, picked from Deviations or typed by hand while it was not reachable.
  source?: { from: 'deviations' } | { from: 'hand'; state: 'absent' | 'down' };
  // concluded: the outcome; an invalidation names the retests QA authorises.
  outcome?: OosOutcome; retests?: number;
  // phase2_checked: the phase2 entry checked.
  entry?: number;
  // retest: the analysis started.
  analysis?: number; analysisNo?: string;
  // phase1_concluded of an outside result's OOS (LIMS-22): the contract lab's investigation report, named by its file.
  report?: { reportNo: string; fileName: string; size: number; sha256: string };
}
export interface OosEvent { id: number; kind: OosEventKind; payload: OosPayload; person: number }
export interface OosFacts {
  // Everyone who recorded, signed or checked a step of the analysis (the analyst first).
  analysisPeople: readonly number[];
  // An OOS of an outside (contract) lab's result: its phase I is the contract lab's investigation report.
  outside?: boolean;
  // The deviation Deviations filed from this OOS (its source_ref names it), read live: it is the phase II deviation
  // without anyone picking it (owner 19 Nov 2026: pull, don't type).
  filedDeviation?: string | null;
}

export const OOS_STATUSES = ['phase I', 'phase I review', 'QA approval', 'phase II', 'confirmed', 'invalidated'] as const;
export type OosStatus = (typeof OOS_STATUSES)[number];
export const OOS_STATUS_WORDS: Record<OosStatus, string> = {
  'phase I': 'Phase I: laboratory investigation', 'phase I review': 'Phase I: waiting for the supervisor\'s review',
  'QA approval': 'Laboratory error: waiting for QA', 'phase II': 'Phase II: manufacturing investigation (Deviations)',
  confirmed: 'Concluded: OOS confirmed', invalidated: 'Concluded: invalidated (laboratory error)',
};
export const oosClosed = (s: OosStatus) => s === 'confirmed' || s === 'invalidated';

/** The entries of the phase I now in force: those after the last return. */
function current(events: readonly OosEvent[]): OosEvent[] {
  const i = events.map((e) => e.kind).lastIndexOf('phase1_returned');
  return events.slice(i + 1);
}
const last = (events: readonly OosEvent[], kind: OosEventKind) => events.filter((e) => e.kind === kind).at(-1);

/** The status, from the entries in order. */
export function oosStatus(events: readonly OosEvent[]): OosStatus {
  const c = events.find((e) => e.kind === 'concluded');
  if (c) return c.payload.outcome === 'invalidated' ? 'invalidated' : 'confirmed';
  const now = current(events);
  const conclusion = last(now, 'phase1_concluded');
  if (!conclusion) return 'phase I';
  if (!now.some((e) => e.kind === 'phase1_reviewed')) return 'phase I review';
  return conclusion.payload.labError ? 'QA approval' : 'phase II';
}

/** The phase I conclusion in force (after the last return), if any. */
export const phase1Conclusion = (events: readonly OosEvent[]) => last(current(events), 'phase1_concluded');
/** The plans of phase Ib with their re-measurement, if done; every result is listed, none averaged away. */
export function plans(events: readonly OosEvent[]): { plan: OosEvent; result: OosEvent | null }[] {
  return events.filter((e) => e.kind === 'plan').map((plan) => ({ plan, result: events.find((e) => e.kind === 'remeasured' && e.payload.plan === plan.id) ?? null }));
}
/** The phase II deviation number in force (the latest), whether typed by hand, and whether a second person checked it. */
export function phase2(events: readonly OosEvent[], filed?: string | null): { event: OosEvent | null; reference: string; typed: boolean; checked: boolean; filed?: boolean } | null {
  const e = last(events, 'phase2');
  // Not picked: the deviation Deviations filed from this OOS, if any.
  if (!e) return filed ? { event: null, reference: filed, typed: false, checked: true, filed: true } : null;
  const typed = e.payload.source?.from === 'hand';
  return { event: e, reference: e.payload.reference ?? '', typed, checked: events.some((x) => x.kind === 'phase2_checked' && x.payload.entry === e.id) };
}
/** The retests QA authorised (on invalidation) and those started. */
export function retests(events: readonly OosEvent[]): { authorised: number; started: OosEvent[]; by: number | null } {
  const c = events.find((e) => e.kind === 'concluded' && e.payload.outcome === 'invalidated');
  return { authorised: c?.payload.retests ?? 0, started: events.filter((e) => e.kind === 'retest'), by: c?.person ?? null };
}

/** Checklist answers complete: every item yes or no, every "no" with its comment. Problems in plain words. */
export function checklistProblems(a: Answers): string[] {
  return OOS_CHECKLIST.flatMap(([k, label]) => {
    const x = a[k];
    if (!x) return [`${label}: answer yes or no.`];
    if (!x.yes && !x.comment?.trim()) return [`${label}: you answered no; say what was found.`];
    return [];
  });
}

export type OosAction = 'checklist' | 'plan' | 'remeasure' | 'conclude-phase1' | 'return' | 'review' | 'phase2' | 'check-phase2' | 'conclude';
export const OOS_ACTIONS: Record<OosAction, { event: OosEventKind; permissions: readonly string[]; meaning?: 'reviewed' | 'oos_approved' }> = {
  checklist: { event: 'checklist', permissions: ['lims.analysis.perform'] },
  plan: { event: 'plan', permissions: ['lims.analysis.perform'] },
  remeasure: { event: 'remeasured', permissions: ['lims.analysis.perform'] },
  'conclude-phase1': { event: 'phase1_concluded', permissions: ['lims.analysis.perform'] },
  return: { event: 'phase1_returned', permissions: ['lims.analysis.review', 'lims.oos.approve'] },
  review: { event: 'phase1_reviewed', permissions: ['lims.analysis.review'], meaning: 'reviewed' },
  phase2: { event: 'phase2', permissions: ['lims.analysis.review', 'lims.oos.approve'] },
  'check-phase2': { event: 'phase2_checked', permissions: ['lims.analysis.review', 'lims.oos.approve'] },
  conclude: { event: 'concluded', permissions: ['lims.oos.approve'], meaning: 'oos_approved' },
};
export const OOS_ACTION_NAMES = Object.keys(OOS_ACTIONS) as OosAction[];

/** A phase II deviation QA concludes the OOS after: closed, or cancelled in Deviations as not a deviation (owner, 20 Nov 2026). */
export const OOS_DEVIATION_ENDED = ['closed', 'cancelled'];
/** What the server read of the phase II deviation now: its status in Deviations, or the link's state when it did not answer. */
export type DeviationNow = { state: 'ok'; status: string | null } | { state: 'absent' | 'down' };

/**
 * Why this person may not take this action on the OOS now (plain words); null when they may. `input`: what the action
 * would record (for the conclusion: its outcome and cause; for a re-measurement: its plan).
 */
export function oosRefusal(action: OosAction, f: OosFacts, events: readonly OosEvent[], user: { id: number; permissions: readonly string[] },
  input: OosPayload = {}, deviation?: DeviationNow): string | null {
  const rule = OOS_ACTIONS[action];
  if (!rule.permissions.some((p) => user.permissions.includes(p))) return 'You do not have the permission for this action.';
  const status = oosStatus(events);
  if (oosClosed(status)) return `The OOS is concluded (${status === 'invalidated' ? 'invalidated' : 'OOS confirmed'}).`;
  const now = current(events);
  if (f.outside && (action === 'checklist' || action === 'plan' || action === 'remeasure')) return 'Phase I of an outside lab\'s result is the contract lab\'s own investigation: record its report.';
  switch (action) {
    case 'checklist':
      return status === 'phase I' ? null : 'Phase I is concluded: the checklist is recorded again only after a return.';
    case 'plan':
      if (status !== 'phase I') return 'Phase I is concluded: no more re-measurements.';
      if (!events.some((e) => e.kind === 'checklist')) return 'Answer the phase Ia checklist first.';
      return null;
    case 'remeasure': {
      if (status !== 'phase I') return 'Phase I is concluded: no more re-measurements.';
      const p = plans(events).find((x) => x.plan.id === input.plan);
      if (!p) return 'A re-measurement is done only as planned in writing before: write the plan first.';
      if (p.result) return 'This plan\'s re-measurement is already recorded.';
      return null;
    }
    case 'conclude-phase1':
      if (status !== 'phase I') return 'Phase I is already concluded.';
      if (f.outside) return input.report ? null : 'Attach the contract lab\'s investigation report with its number.';
      if (!now.some((e) => e.kind === 'checklist')) return 'Answer the phase Ia checklist first.';
      if (plans(events).some((x) => !x.result)) return 'Every planned re-measurement is recorded before phase I is concluded.';
      return null;
    case 'return':
      return status === 'phase I review' || status === 'QA approval' ? null : 'Only a phase I waiting for its review or for QA is returned.';
    case 'review': {
      if (status !== 'phase I review') return 'Phase I is not waiting for its review.';
      const by = [last(now, 'checklist')?.person, last(now, 'phase1_concluded')?.person];
      if (by.includes(user.id) || f.analysisPeople.includes(user.id)) return 'You worked on this analysis or its phase I: a supervisor who did not reviews it.';
      return null;
    }
    case 'phase2': {
      if (status !== 'phase II') return 'Phase II starts when the reviewed phase I found no laboratory error.';
      const p = phase2(events, f.filedDeviation);
      if (p && (!p.typed || p.checked)) return `The phase II deviation is ${p.reference}.`;
      return null;
    }
    case 'check-phase2': {
      const p = phase2(events, f.filedDeviation);
      if (!p?.typed) return 'There is no deviation number typed by hand to check.';
      if (p.checked) return 'A second person has already checked the deviation number.';
      if (p.event?.person === user.id) return 'You typed the deviation number: a second person checks it.';
      return null;
    }
    case 'conclude': {
      if (f.analysisPeople.includes(user.id)) return 'You worked on this analysis: another person in QA concludes the OOS.';
      if (status === 'QA approval') {
        if (input.outcome && input.outcome !== 'invalidated') return 'Phase I found a laboratory error: QA invalidates the result, or returns phase I.';
        return null;
      }
      if (status !== 'phase II') return 'QA concludes after the reviewed phase I.';
      const p = phase2(events, f.filedDeviation);
      if (!p) return 'Phase II needs its deviation number in Deviations first.';
      if (p.typed && !p.checked) return 'A second person checks the deviation number typed by hand first.';
      if (deviation?.state === 'ok') {
        if (deviation.status === null) return `${p.reference} is not in the Deviations system.`;
        if (!OOS_DEVIATION_ENDED.includes(deviation.status)) return `${p.reference} is ${deviation.status.replaceAll('_', ' ')} in Deviations: QA concludes once it is closed there.`;
      }
      // LIMS-24: an invalidation needs an assignable laboratory cause, here one found by the phase II investigation.
      if (input.outcome === 'invalidated' && !input.cause?.trim()) return 'An invalidation needs the assignable laboratory cause found.';
      return null;
    }
  }
}

/** Why a retest of the OOS may not start now; null when it may (one of those QA authorised on invalidation). */
export function retestRefusal(events: readonly OosEvent[]): string | null {
  if (oosStatus(events) !== 'invalidated') return 'A retest starts only after QA invalidated the result for an assignable laboratory cause.';
  const r = retests(events);
  if (r.started.length >= r.authorised) return `QA authorised ${r.authorised} retest${r.authorised === 1 ? '' : 's'}: ${r.started.length} started.`;
  return null;
}
