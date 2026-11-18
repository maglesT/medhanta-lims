import { reserveShortfall, type ReserveNeed } from './reserve.js';

/**
 * A sample (LIMS-05, LIMS-07), the Logbook way: a row (what, which lot or batch, which specification version, how much)
 * and insert-only entries. Its status is computed from the entries here, never stored. A sample registered by hand
 * (its link absent or down) waits for a second person's check before anything else (LIMS-41, LIMS-50).
 */

export const SAMPLE_PURPOSES = ['release', 'retest', 'stability', 'investigation'] as const;
export type SamplePurpose = (typeof SAMPLE_PURPOSES)[number];
export const SAMPLE_EVENT_KINDS = ['checked', 'received', 'stored', 'handed_over', 'disposed', 'note', 'approved', 'rejected', 'oot_answered'] as const;
export type SampleEventKind = (typeof SAMPLE_EVENT_KINDS)[number];

// The custody status; QC's decision (approved or rejected) is told apart by sampleDecision.
export type SampleStatus = 'waiting for check' | 'registered' | 'received' | 'stored' | 'handed over' | 'disposed' | 'approved' | 'rejected';

export interface SampleEvent {
  kind: SampleEventKind;
  person: number;
  payload: { condition?: string; where?: string; to?: string; reason?: string; method?: string; text?: string; coaNo?: string;
    // oot_answered (LIMS-25): the test and analysis whose out-of-trend result QC answered, and the answer.
    test?: string; analysisNo?: string; answer?: OotAnswer };
}
export interface SampleFacts {
  registeredBy: number;
  // Registered by hand while its link was absent or down.
  byHand: boolean;
}

/** The actions on a sample and the entry each adds. */
export const SAMPLE_ACTIONS = {
  check: 'checked',
  receive: 'received',
  store: 'stored',
  'hand-over': 'handed_over',
  dispose: 'disposed',
  note: 'note',
} as const satisfies Record<string, SampleEventKind>;
export type SampleAction = keyof typeof SAMPLE_ACTIONS;
export const SAMPLE_ACTION_NAMES = Object.keys(SAMPLE_ACTIONS) as SampleAction[];

/** The status, from the entries in order: registered → received → stored or handed over → disposed. */
export function sampleStatus(s: SampleFacts, events: readonly SampleEvent[]): SampleStatus {
  if (events.some((e) => e.kind === 'disposed')) return 'disposed';
  const where = events.filter((e) => e.kind === 'stored' || e.kind === 'handed_over').at(-1);
  if (where) return where.kind === 'stored' ? 'stored' : 'handed over';
  if (events.some((e) => e.kind === 'received')) return 'received';
  if (s.byHand && !events.some((e) => e.kind === 'checked')) return 'waiting for check';
  return 'registered';
}

/** Why this person may not take this action on the sample now (plain words); null when they may. */
export function sampleRefusal(action: SampleAction, s: SampleFacts, events: readonly SampleEvent[], person: number): string | null {
  const status = sampleStatus(s, events);
  if (status === 'disposed') return 'The sample is disposed of: nothing more is recorded.';
  switch (action) {
    case 'check':
      if (!s.byHand) return 'The sample was pulled from its source: there is nothing typed by hand to check.';
      if (events.some((e) => e.kind === 'checked')) return 'A second person has already checked this sample.';
      if (person === s.registeredBy) return 'The person who typed the sample in cannot check it: a second person checks it.';
      return null;
    case 'receive':
      if (status === 'waiting for check') return 'The sample was typed by hand: a second person checks it before it is received.';
      if (events.some((e) => e.kind === 'received')) return 'The sample is already received in QC.';
      return null;
    case 'store':
    case 'hand-over':
      if (!events.some((e) => e.kind === 'received')) return 'Receive the sample in QC first.';
      return null;
    case 'dispose':
    case 'note':
      return null;
  }
}

// ---- QC's decision (LIMS-11, LIMS-20, LIMS-41) ----
export type Decision = 'approved' | 'rejected';
/** QC's decision on the sample, once made; one per sample. */
export const sampleDecision = (events: readonly SampleEvent[]): Decision | null =>
  (events.find((e) => e.kind === 'approved' || e.kind === 'rejected')?.kind as Decision | undefined) ?? null;

/** A test of the sample's specification as QC decides on it: its latest reviewed analysis, if any. */
export interface TestState {
  key: string; name: string; applies: boolean;
  // A test whose limit type has no limit (report only, conforms) passes when it has a result.
  reviewed: { analysisNo: string; hasResult: boolean; pass?: boolean; shown?: string; people: number[]; openDeviations: number;
    // LIMS-25: within the limit but outside the spec's trend limit, or a stability result outside its prediction interval (in words).
    outOfTrend?: string } | null;
}

// ---- OOS and OOT (LIMS-23, LIMS-24, LIMS-25) ----
/** An OOS of the sample as the decision sees it: open (phase I or II), or concluded. */
export interface SampleOos { oosNo: string; testName: string; status: 'open' | 'confirmed' | 'invalidated' }
export const OOT_ANSWERS = ['no action', 'investigation'] as const;
export type OotAnswer = (typeof OOT_ANSWERS)[number];
/** QC's answer to the out-of-trend flag of a test's result in an analysis, if given. */
export const ootAnswer = (events: readonly SampleEvent[], test: string, analysisNo: string) =>
  events.find((e) => e.kind === 'oot_answered' && e.payload.test === test && e.payload.analysisNo === analysisNo) ?? null;

/**
 * Why QC may not approve the sample now (plain words, all at once); empty when it may. Approval needs the sample in QC,
 * a reviewed result for every test that applies (LIMS-11; an invalidated analysis no longer counts, LIMS-24), every
 * result within its limit (an out-of-limit result is investigated, LIMS-23: the sample cannot be approved), no OOS of the
 * sample open and none confirmed (then only rejection is left), every out-of-trend flag answered (LIMS-25), no open
 * deviation in those analyses, an approver who did no part of them (LIMS-41), and for a release sample whose specification
 * names a reserve quantity, its lot's reserve sample logged at least at that quantity (LIMS-30; reserve: the caller
 * passes it for release samples only).
 */
export function approvalProblems(s: SampleFacts, events: readonly SampleEvent[], tests: readonly TestState[], person: number, oos: readonly SampleOos[] = [], reserve?: ReserveNeed): string[] {
  const d = sampleDecision(events);
  if (d) return [`The sample is already ${d}.`];
  const status = sampleStatus(s, events);
  if (status === 'waiting for check' || status === 'registered') return ['QC has not received the sample yet.'];
  const out: string[] = [];
  for (const o of oos) {
    if (o.status === 'open') out.push(`${o.oosNo} (${o.testName}) is open: the sample is approved only after the OOS is concluded.`);
    if (o.status === 'confirmed') out.push(`${o.oosNo} (${o.testName}) is a confirmed OOS: the sample can only be rejected.`);
  }
  for (const t of tests.filter((x) => x.applies)) {
    const r = t.reviewed;
    if (!r) { out.push(`${t.name}: no reviewed result yet.`); continue; }
    if (!r.hasResult) out.push(`${t.name}: analysis ${r.analysisNo} has no result.`);
    else if (r.pass === false) out.push(`${t.name}: ${r.shown ?? 'the result'} is out of limits (analysis ${r.analysisNo}): it is investigated as an OOS result; the sample cannot be approved.`);
    else if (r.outOfTrend && !ootAnswer(events, t.key, r.analysisNo)) out.push(`${t.name}: ${r.shown ?? 'the result'} is out of trend (${r.outOfTrend}, analysis ${r.analysisNo}): QC answers the flag first.`);
    if (r.openDeviations) out.push(`${t.name}: analysis ${r.analysisNo} has ${r.openDeviations} open deviation${r.openDeviations === 1 ? '' : 's'}.`);
    if (r.people.includes(person)) out.push(`${t.name}: you worked on analysis ${r.analysisNo}; another person approves the sample.`);
  }
  const short = reserve ? reserveShortfall(reserve) : null;
  if (short) out.push(short);
  return out;
}

/** Why QC may not answer the out-of-trend flag of this test now; null when it may. */
export function ootRefusal(events: readonly SampleEvent[], tests: readonly TestState[], test: string): string | null {
  const d = sampleDecision(events);
  if (d) return `The sample is already ${d}.`;
  const r = tests.find((t) => t.key === test)?.reviewed;
  if (!r?.outOfTrend || r.pass === false) return 'This test has no out-of-trend result to answer.';
  if (ootAnswer(events, test, r.analysisNo)) return 'QC has already answered this flag.';
  return null;
}

/** Why QC may not reject the sample now; null when it may (a rejection may come at any time, with its reason). */
export function rejectionRefusal(events: readonly SampleEvent[]): string | null {
  const d = sampleDecision(events);
  return d ? `The sample is already ${d}.` : null;
}
