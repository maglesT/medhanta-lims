import { describe, expect, it } from 'vitest';
import {
  analysisRefusal, analysisView, cutShort, evaluate, notYetText, openSteps, review,
  type AnalysisAction, type AnalysisEvent, type AnalysisEventKind, type StepEvent,
} from '../shared/engine/index.js';
import { at, ev, fail, pass, reading, small } from './engine-fixture.js';
import { analysisRecordDoc } from '../server/analysis-record.js';

// The analysis status, its review by a second person and its stop (LIMS-11, LIMS-18, LIMS-41, LIMS-48), computed
// from the step events and the analysis events.

let n = 1000;
const be = (kind: AnalysisEventKind, payload: AnalysisEvent['payload'] = {}): AnalysisEvent => ({ id: n++, kind, payload, person: 5, at: at(900) });
// The analyst is person 1 (records and signs), the checker person 2; the reviewer (person 5) did no part of the analysis.
const people = {
  reviewer: { id: 5, permissions: ['lims.analysis.review'] },
  analyst: { id: 1, permissions: ['lims.analysis.perform', 'lims.analysis.review'] },
  checker: { id: 2, permissions: ['lims.analysis.check', 'lims.analysis.review'] },
  qc: { id: 6, permissions: ['lims.qc.approve'] },
  performer: { id: 7, permissions: ['lims.analysis.perform'] },
};
type Who = keyof typeof people;

// One checked step and one optional step marked not applicable.
const doc = small([{ steps: [{ checker: true }, { flow: { kind: 'optional-with-reason' } }] }]);
const started = [ev('started', '0.1.0.1', { min: 1 }), ev('done', '0.1.0.1', { min: 2 })];
const complete = [...started, ev('checked', '0.1.0.1', { person: 2, min: 3 }), ev('not_applicable', '0.1.1.1', { min: 4, payload: { reason: 'Not needed' } })];
const corrected = [...complete, ev('corrected', '0.1.0.1', { min: 6, payload: { values: {}, reason: 'x' } })];
const deviation = ev('note', '0.1.0.1', { min: 5, payload: { text: 'pH re-measured', reference: 'DEV-26-001' } });
const close = be('deviation_closed', { note: deviation.id, reason: 'Investigation closed' });
const reviewed = [be('reviewed')];
const stopped = [be('stopped', { reason: 'The HPLC pump failed' })];
const view = (events: StepEvent[], analysis: AnalysisEvent[] = [], d = doc) => analysisView(d, events, analysis, at(1000));

describe('the analysis status', () => {
  it.each<[string, StepEvent[], AnalysisEvent[], string]>([
    ['nothing done', [], [], 'in progress'],
    ['a step waits for its check', started, [], 'in progress'],
    ['every step done, checked or not applicable', complete, [], 'complete'],
    ['a correction after the check', corrected, [], 'in progress'],
    ['reviewed', complete, reviewed, 'reviewed'],
    ['stopped while in progress', started, stopped, 'stopped'],
    ['stopped when complete', complete, stopped, 'stopped'],
  ])('%s → %s', (_what, events, analysis, status) => {
    expect(view(events, analysis).status).toBe(status);
  });

  it('LIMS-41 the people of an analysis are everyone who recorded, signed or checked a step', () => {
    expect(view(complete).people.sort()).toEqual([1, 2]);
    expect(view([...complete, ev('demo_wait_skipped', '0.1.0.1', { person: 9, payload: { timer: 'x' } })]).people.sort()).toEqual([1, 2]);
  });
});

describe('the review and the stop', () => {
  const refused = (a: AnalysisAction, who: Who, events: StepEvent[], analysis: AnalysisEvent[] = [], note?: number) =>
    analysisRefusal(a, view(events, analysis), people[who], note);
  it.each<[string, AnalysisAction, Who, StepEvent[], AnalysisEvent[], string | null]>([
    ['LIMS-11 review while a check is open', 'review', 'reviewer', started, [], 'Stage 0 › Check a value against limits: pH is waiting for its check'],
    ['LIMS-11 review of a step that needs signing again', 'review', 'reviewer', corrected, [], 'Stage 0 › Check a value against limits: pH needs signing again'],
    ['LIMS-18 review without the review permission', 'review', 'performer', complete, [], 'You do not have the permission for this action.'],
    ['LIMS-18 a second person reviews a complete record', 'review', 'reviewer', complete, [], null],
    ['LIMS-18 review twice', 'review', 'reviewer', complete, reviewed, 'The analysis is reviewed.'],
    ['LIMS-41 the analyst who recorded and signed a step does not review it', 'review', 'analyst', complete, [], 'You recorded or signed steps of this analysis: another person reviews it.'],
    ['LIMS-41 the checker of a step does not review it', 'review', 'checker', complete, [], 'You recorded or signed steps of this analysis: another person reviews it.'],
    ['LIMS-48 an analysis in progress is stopped with a reason', 'stop', 'reviewer', started, [], null],
    ['LIMS-48 a complete analysis with an open deviation is stopped', 'stop', 'reviewer', [...complete, deviation], [], null],
    ['LIMS-48 stop without the review permission', 'stop', 'performer', started, [], 'You do not have the permission for this action.'],
    ['LIMS-48 stop a reviewed analysis', 'stop', 'reviewer', complete, reviewed, 'The analysis is reviewed.'],
    ['LIMS-48 stop twice', 'stop', 'reviewer', started, stopped, 'The analysis is stopped.'],
    ['LIMS-48 review after the stop', 'review', 'reviewer', complete, stopped, 'The analysis is stopped.'],
  ])('%s → %s', (_what, action, who, events, analysis, want) => {
    expect(refused(action, who, events, analysis)?.problems[0] ?? null).toBe(want);
  });

  it('LIMS-41 a reviewer who did part of the analysis is refused with 403 own_work', () => {
    expect(refused('review', 'checker', complete)).toMatchObject({ status: 403, error: 'own_work' });
    expect(refused('review', 'reviewer', started)).toMatchObject({ status: 409, error: 'not_ready' });
  });

  it.each<[string, AnalysisEvent[], number, string | null]>([
    ['an open deviation note', [], deviation.id, null],
    ['a note closed already', [close], deviation.id, 'There is no open deviation note with this number.'],
    ['a step event that is not a deviation note', [], complete[0]!.id, 'There is no open deviation note with this number.'],
    ['after the review', reviewed, deviation.id, 'The analysis is reviewed.'],
  ])('LIMS-20 QC closes %s with a reason → %s', (_what, analysis, note, want) => {
    expect(refused('close-deviation', 'qc', [...complete, deviation], analysis, note)?.problems[0] ?? null).toBe(want);
  });

  it('LIMS-41 the person who typed the deviation number does not close it by hand', () => {
    const own = { id: 1, permissions: ['lims.qc.approve'] };
    expect(analysisRefusal('close-deviation', view([...complete, deviation]), own, deviation.id)).toMatchObject({ status: 403, error: 'own_work' });
  });

  it('LIMS-20 a deviation read from the Deviations system is closed there, not by hand', () => {
    const read = new Map([['DEV-26-001', { status: 'investigation', closedAt: null }]]);
    const v = analysisView(doc, [...complete, deviation], [], at(1000), read);
    expect(v.deviations).toMatchObject([{ reference: 'DEV-26-001', open: true, status: 'investigation' }]);
    expect(analysisRefusal('close-deviation', v, people.qc, deviation.id)?.problems).toEqual(['The status of DEV-26-001 comes from the Deviations system (now under investigation): it is closed there.']);
  });

  it('LIMS-44 the review is refused while a check made late has no deviation note', () => {
    const d = small([{ steps: [{ everyMinutes: 30, flow: { kind: 'repeat-until', maxRounds: 3, stop: 'readingCheck' } }] }]);
    const r = (round: number, start: number, pass: boolean) => [ev('started', `0.1.0.${round}`, { min: start }),
      ev('value', `0.1.0.${round}`, { min: start + 1, payload: { values: {}, results: evaluate(d, [], { stage: 0, sub: 1, step: 0, round }, { reading: { value: pass ? '6.0' : '8.0', unit: '' } }) } }),
      ev('done', `0.1.0.${round}`, { min: start + 2 })];
    // Round 1 out of limits, round 2 started at 40 min: 10 minutes late.
    const events = [...r(1, 0, false), ...r(2, 40, true)];
    const v = view(events, [], d);
    expect(v.status).toBe('complete');
    expect(analysisRefusal('review', v, people.reviewer)?.problems).toEqual(['Check 2 of “Check a value against limits: pH” (every 30 min) ran over: a deviation note is needed']);
    const noted = view([...events, ev('note', '0.1.0.2', { min: 45, payload: { text: 'Column oven door left open' } })], [], d);
    expect(analysisRefusal('review', noted, people.reviewer)).toBeNull();
  });
});

describe('the review list', () => {
  it('LIMS-19 lists corrections, sent-backs, values out of limits with their notes, deviations with status and steps not applicable', () => {
    const value = (v: string, pass: boolean) => ({ values: { reading: { value: v, unit: '' } }, results: { readingCheck: { ok: true as const, value: v, unit: '', shown: `${v} …`, check: { pass, level: pass ? 'pass' : 'fail', shown: '' } } } });
    const events = [
      ev('started', '0.1.0.1'), ev('value', '0.1.0.1', { payload: value('6.1', true) }), ev('done', '0.1.0.1'),
      ev('sent_back', '0.1.0.1', { person: 2, payload: { reason: 'Reading looks wrong' } }),
      ev('corrected', '0.1.0.1', { payload: { ...value('7.5', false), reason: 'Re-read the meter' } }), deviation, ev('done', '0.1.0.1'),
      ev('not_applicable', '0.1.1.1', { payload: { reason: 'Not needed' } }),
    ];
    const r = review(doc, events, [close], at(1000));
    expect(r.corrections).toMatchObject([{ step: '0.1.0.1', field: 'reading', was: { value: '6.1' }, now: { value: '7.5' }, reason: 'Re-read the meter' }]);
    expect(r.sentBack).toMatchObject([{ payload: { reason: 'Reading looks wrong' }, person: 2 }]);
    expect(r.outOfLimits).toMatchObject([{ step: '0.1.0.1', calc: 'readingCheck', shown: '7.5 …', notes: [{ payload: { reference: 'DEV-26-001' } }] }]);
    expect(r.deviations).toMatchObject([{ reference: 'DEV-26-001', open: false, closed: { payload: { reason: 'Investigation closed' } } }]);
    expect(r.notApplicable).toMatchObject([{ step: 1, payload: { reason: 'Not needed' } }]);
    expect(r.late).toEqual([]);
    expect(r.analysisEvents).toEqual([close]);
  });

  it('LIMS-17 a repeat-until round whose stop check is "not yet" is not out of limits; the last allowed round failing is', () => {
    const d = small([{ steps: [{ flow: { kind: 'repeat-until', maxRounds: 3, stop: 'readingCheck' } }] }]);
    const round = (r: number, ok: boolean) => [ev('started', `0.1.0.${r}`), reading(`0.1.0.${r}`, { readingCheck: ok ? pass : fail }), ev('done', `0.1.0.${r}`)];
    const dried = [...round(1, false), ...round(2, true)];
    expect(review(d, dried, [], at(1000)).outOfLimits).toEqual([]);
    expect(analysisView(d, dried, [], at(1000)).open).toEqual([]);
    const never = [...round(1, false), ...round(2, false), ...round(3, false)];
    expect(review(d, never, [], at(1000)).outOfLimits.map((o) => o.step)).toEqual(['0.1.0.3']);
    expect(notYetText('2.150 % rounded to 1 decimal = 2.2 %; limit 2.5 to 3.5 %: OUT OF LIMITS (below the lower limit)')).toBe('2.150 % rounded to 1 decimal = 2.2 %; limit 2.5 to 3.5 %: not reached yet, the rounds go on');
    expect(notYetText('Constant mass reached: no: FAIL')).toBe('Constant mass reached: no: not yet, the rounds go on');
    // A stopped analysis: the rounds do not go on (owner, 16 Nov 2026).
    expect(notYetText('limit 2.5 to 3.5 %: OUT OF LIMITS (below the lower limit)', true)).toBe('limit 2.5 to 3.5 %: not reached (stopped)');
    expect(notYetText('Constant mass reached: no: FAIL', true)).toBe('Constant mass reached: no: not reached (stopped)');
  });

  it('LIMS-48 a stopped analysis keeps its record: only the last round left unfinished reads "not reached"; an earlier round followed by another went on', () => {
    const d = small([{ steps: [{ flow: { kind: 'repeat-until', maxRounds: 3, stop: 'readingCheck' } }] }]);
    const notPassed = { ...fail, shown: 'pH = 9: FAIL' };
    // Round 1 did not pass and round 2 followed; round 2 was started and did not pass when the analysis was stopped.
    const events = [ev('started', '0.1.0.1'), reading('0.1.0.1', { readingCheck: notPassed }), ev('done', '0.1.0.1'), ev('started', '0.1.0.2'), reading('0.1.0.2', { readingCheck: notPassed })];
    const { steps } = openSteps(d, events, at(1000));
    expect(steps.map((v) => [v.id, v.notYet, cutShort(true, v, steps), cutShort(false, v, steps)])).toEqual([['0.1.0.1', 'readingCheck', false, false], ['0.1.0.2', 'readingCheck', true, false]]);
    const record = (analysisEvents: AnalysisEvent[]) => JSON.stringify(analysisRecordDoc({ analysis: { id: 1, analysisNo: 'LA2600099', masterVersionId: 1, issuedBy: 1, issuedAt: at(0), sampleId: null, tests: [] }, sample: null, doc: d,
      events: events.map((e) => ({ ...e, personName: 'ANALYST A' })), analysisEvents: analysisEvents.map((b) => ({ ...b, personName: 'REVIEWER R' })), now: at(1000), versionNo: 1, issuedByName: 'ANALYST A', signatures: [] }, 'QC'));
    const ended = record([be('stopped', { reason: 'The oven broke down' })]);
    expect(ended).toContain('The oven broke down');
    expect(ended.match(/pH = 9: not yet, the rounds go on/g)).toHaveLength(1);
    expect(ended.match(/NOT YET: the rounds go on/g)).toHaveLength(1);
    expect(ended.match(/pH = 9: not reached \(stopped\)/g)).toHaveLength(1);
    expect(ended.match(/NOT REACHED: stopped/g)).toHaveLength(1);
    expect(ended.indexOf('the rounds go on')).toBeLessThan(ended.indexOf('not reached (stopped)'));
    // In progress both rounds read as before.
    const live = record([]);
    expect(live.match(/NOT YET: the rounds go on/g)).toHaveLength(2);
    expect(live).not.toContain("not reached (stopped)");
    // Round 2 signed done without passing, round 3 opened but never started, then stopped: round 2 was cut short.
    const events3 = [...events, ev('done', '0.1.0.2')];
    const { steps: steps3 } = openSteps(d, events3, at(1000));
    const r3 = steps3.find((v) => v.id === '0.1.0.3');
    expect(r3 && ['waiting', 'open'].includes(r3.state)).toBe(true);
    expect(steps3.filter((v) => v.id !== '0.1.0.3').map((v) => [v.id, cutShort(true, v, steps3)])).toEqual([['0.1.0.1', false], ['0.1.0.2', true]]);
  });
});
