/**
 * A sample (LIMS-05, LIMS-07), the Logbook way: a row (what, which lot or batch, which specification version, how much)
 * and insert-only entries. Its status is computed from the entries here, never stored. A sample registered by hand
 * (its link absent or down) waits for a second person's check before anything else (LIMS-41, LIMS-50).
 */

export const SAMPLE_PURPOSES = ['release', 'retest', 'stability', 'investigation'] as const;
export type SamplePurpose = (typeof SAMPLE_PURPOSES)[number];
export const SAMPLE_EVENT_KINDS = ['checked', 'received', 'stored', 'handed_over', 'disposed', 'note'] as const;
export type SampleEventKind = (typeof SAMPLE_EVENT_KINDS)[number];

// 'approved' and 'rejected' are QC's decision (build step 3, round 5); nothing computes them yet.
export type SampleStatus = 'waiting for check' | 'registered' | 'received' | 'stored' | 'handed over' | 'disposed' | 'approved' | 'rejected';

export interface SampleEvent {
  kind: SampleEventKind;
  person: number;
  payload: { condition?: string; where?: string; to?: string; reason?: string; method?: string; text?: string };
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
