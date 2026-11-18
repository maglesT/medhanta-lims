/**
 * A sample (LIMS-05, LIMS-07), the Logbook way: a row (what, which lot or batch, which specification version, how much)
 * and insert-only entries. Its status is computed from the entries here, never stored. A sample registered by hand
 * (its link absent or down) waits for a second person's check before anything else (LIMS-41, LIMS-50).
 */

export const SAMPLE_PURPOSES = ['release', 'retest', 'stability', 'investigation'] as const;
export type SamplePurpose = (typeof SAMPLE_PURPOSES)[number];
export const SAMPLE_EVENT_KINDS = ['checked', 'received', 'stored', 'handed_over', 'disposed', 'note', 'approved', 'rejected'] as const;
export type SampleEventKind = (typeof SAMPLE_EVENT_KINDS)[number];

// The custody status; QC's decision (approved or rejected) is told apart by sampleDecision.
export type SampleStatus = 'waiting for check' | 'registered' | 'received' | 'stored' | 'handed over' | 'disposed' | 'approved' | 'rejected';

export interface SampleEvent {
  kind: SampleEventKind;
  person: number;
  payload: { condition?: string; where?: string; to?: string; reason?: string; method?: string; text?: string; coaNo?: string };
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
  reviewed: { analysisNo: string; hasResult: boolean; pass?: boolean; shown?: string; people: number[]; openDeviations: number } | null;
}

/**
 * Why QC may not approve the sample now (plain words, all at once); empty when it may. Approval needs the sample in QC,
 * a reviewed result for every test that applies (LIMS-11), every result within its limit (an out-of-limit result is
 * investigated, LIMS-23: the sample cannot be approved), no open deviation in those analyses, and an approver who did
 * no part of them (LIMS-41).
 */
export function approvalProblems(s: SampleFacts, events: readonly SampleEvent[], tests: readonly TestState[], person: number): string[] {
  const d = sampleDecision(events);
  if (d) return [`The sample is already ${d}.`];
  const status = sampleStatus(s, events);
  if (status === 'waiting for check' || status === 'registered') return ['QC has not received the sample yet.'];
  const out: string[] = [];
  for (const t of tests.filter((x) => x.applies)) {
    const r = t.reviewed;
    if (!r) { out.push(`${t.name}: no reviewed result yet.`); continue; }
    if (!r.hasResult) out.push(`${t.name}: analysis ${r.analysisNo} has no result.`);
    else if (r.pass === false) out.push(`${t.name}: ${r.shown ?? 'the result'} is out of limits (analysis ${r.analysisNo}): it is investigated as an OOS result; the sample cannot be approved.`);
    if (r.openDeviations) out.push(`${t.name}: analysis ${r.analysisNo} has ${r.openDeviations} open deviation${r.openDeviations === 1 ? '' : 's'}.`);
    if (r.people.includes(person)) out.push(`${t.name}: you worked on analysis ${r.analysisNo}; another person approves the sample.`);
  }
  return out;
}

/** Why QC may not reject the sample now; null when it may (a rejection may come at any time, with its reason). */
export function rejectionRefusal(events: readonly SampleEvent[]): string | null {
  const d = sampleDecision(events);
  return d ? `The sample is already ${d}.` : null;
}
