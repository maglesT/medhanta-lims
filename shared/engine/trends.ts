/**
 * Trends, KPIs and the workload (plan 2.10, 2.11; LIMS-25, LIMS-42), the simple way: pure functions over rows the
 * server reads from this product's own tables; nothing is stored but the turnaround targets and the assignments. The
 * control chart is template L18 (shared/templates/lab-trend.ts).
 */
import { l18ControlChart, NELSON_RULES } from '../templates/lab-trend.js';
import type { Limit } from '../templates/rounding.js';
import { Dec } from '../templates/dec.js';
import { PLANT_TZ } from '../plant-time.js';
import type { SamplePurpose } from './sample.js';

// ---------------------------------------------------------------- control chart: a new result out of trend
/** A new result is judged against at least this many earlier decided results of the same item (or point) and test. */
export const TREND_MIN_HISTORY = 10;
/** And at most the latest this many (the limits follow the process as it is now). */
export const TREND_WINDOW = 30;

/**
 * LIMS-25: the control-chart flag of a new result (null: none). The chart's limits come from the earlier decided results
 * (`history`, oldest first, the same unit kind); the new result is out of trend when a Nelson rule break includes it.
 * A result outside the specification is an OOS, not a trend: no flag. Fewer earlier results than TREND_MIN_HISTORY:
 * not trended yet (null).
 */
export function chartTrend(history: readonly { value: string; unit: string }[], result: { value: string; unit: string }, limit?: Limit): string | null {
  const h = history.slice(-TREND_WINDOW);
  if (h.length < TREND_MIN_HISTORY) return null;
  const r = l18ControlChart({ points: [...h, result].map((p) => ({ value: p.value, unit: p.unit })), baseline: h.length, ...(limit ? { limit } : {}) });
  if (!r.ok || r.lastOutOfSpec || !r.lastPoint.length) return null;
  return `control chart of the last ${h.length} decided results: ${r.lastPoint.map((n) => `Nelson rule ${n} (${NELSON_RULES[n]!.toLowerCase()})`).join('; ')}`;
}

// ---------------------------------------------------------------- results summary (APQR)
export interface Summary { n: number; min: string | null; max: string | null; mean: string | null; sd: string | null; cpk: string | null; rules: number[] }
/** n, min, max, mean, sd and Cpk (two-sided specification) of decided results, by L18; one result or no spread still summarised. */
export function summaryOf(values: readonly { value: string; unit: string }[], limit?: Limit, dp = 3): Summary {
  const f = (x: Dec | null) => (x === null ? null : x.toFixed(dp, Dec.ROUND_HALF_UP));
  if (!values.length) return { n: 0, min: null, max: null, mean: null, sd: null, cpk: null, rules: [] };
  const r = l18ControlChart({ points: values.map((p) => ({ value: p.value, unit: p.unit })), ...(limit ? { limit } : {}) });
  if (r.ok) return { n: r.n, min: f(r.min), max: f(r.max), mean: f(r.mean), sd: f(r.sd), cpk: r.cpk ? r.cpk.toFixed(2, Dec.ROUND_HALF_UP) : null, rules: [...new Set(r.breaks.map((b) => b.rule))] };
  // One result, or results that do not vary: the plain figures (no sigma, no Cpk).
  const xs = values.map((p) => new Dec(p.value));
  const mean = xs.reduce((s, v) => s.plus(v), new Dec(0)).div(xs.length);
  return { n: xs.length, min: f(Dec.min(...xs)), max: f(Dec.max(...xs)), mean: f(mean), sd: xs.length > 1 ? f(new Dec(0)) : null, cpk: null, rules: [] };
}

// ---------------------------------------------------------------- turnaround targets
/** Product defaults (calendar days from receipt in QC to QC's decision), until QC sets its own on the KPI screen. */
export const TAT_DEFAULT_DAYS: Readonly<Record<SamplePurpose, number>> = { release: 10, retest: 10, stability: 15, investigation: 15, monitoring: 7 };

const DAY = 86_400_000;
/** The plant date (YYYY-MM-DD) of an instant. */
export const plantDay = (t: Date) => t.toLocaleDateString('en-CA', { timeZone: PLANT_TZ });
/** The plant month (YYYY-MM) of an instant. */
export const plantMonth = (t: Date) => plantDay(t).slice(0, 7);
/** A plant date plus whole days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Whole days from one plant date to another. */
export const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
/** The due date of a sample's tests: the plant date it was received plus its purpose's target. */
export const dueOn = (receivedAt: Date, days: number) => addDays(plantDay(receivedAt), days);

// ---------------------------------------------------------------- KPIs
export interface KpiAnalysis {
  analysisNo: string; method: string; analyst: string; issuedAt: Date;
  // When it was reviewed, stopped or invalidated (the first of them), null while open.
  finishedAt: Date | null; reviewed: boolean; stopped: boolean; invalidated: boolean;
  // A step value corrected or a step sent back by the checker.
  corrected: boolean; oos: boolean;
}
export interface KpiSample { sampleNo: string; purpose: SamplePurpose; receivedAt: Date | null; decidedAt: Date | null; disposed: boolean }
export interface KpiCounts {
  // Analyses finished (reviewed, stopped or invalidated); right first time: reviewed, not invalidated, never corrected or sent back.
  finished: number; rightFirstTime: number; rftPct: number | null;
  // Reviewed analyses that opened an OOS; invalid runs: stopped or invalidated.
  reviewed: number; oos: number; oosPct: number | null; invalid: number; invalidPct: number | null;
}
export interface KpiMonth extends KpiCounts { month: string; decided: number; tatMeanDays: number | null; tatWithin: number; tatPct: number | null }
export interface BacklogRow { sampleNo: string; purpose: SamplePurpose; received: string; ageDays: number; targetDays: number; due: string; over: boolean }
export interface Kpis {
  months: KpiMonth[]; byAnalyst: (KpiCounts & { analyst: string })[]; byTest: (KpiCounts & { method: string })[];
  backlog: BacklogRow[]; buckets: { label: string; count: number; over: number }[];
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
function counts(as: readonly KpiAnalysis[]): KpiCounts {
  const finished = as.filter((a) => a.finishedAt);
  const reviewed = finished.filter((a) => a.reviewed);
  const rft = reviewed.filter((a) => !a.invalidated && !a.corrected).length;
  const oos = reviewed.filter((a) => a.oos).length;
  const invalid = finished.filter((a) => a.stopped || a.invalidated).length;
  return { finished: finished.length, rightFirstTime: rft, rftPct: pct(rft, finished.length), reviewed: reviewed.length, oos, oosPct: pct(oos, reviewed.length),
    invalid, invalidPct: pct(invalid, finished.length) };
}
const BUCKETS: [string, number, number][] = [['0 to 7 days', 0, 7], ['8 to 14 days', 8, 14], ['15 to 30 days', 15, 30], ['over 30 days', 31, Infinity]];

/**
 * The KPIs of the months `from` to `to` (YYYY-MM, plant months): per month right-first-time, OOS rate, invalid-run rate
 * (analyses by the month they finished) and turnaround (samples by the month QC decided: days from receipt, against
 * the purpose's target); per analyst (who started the analysis) and per test method over the whole period; the backlog
 * today (samples received, not decided, not disposed) by age.
 */
export function kpis(analyses: readonly KpiAnalysis[], samples: readonly KpiSample[], o: { from: string; to: string; targets: Readonly<Record<string, number>>; today: string }): Kpis {
  const inPeriod = (t: Date | null) => !!t && plantMonth(t) >= o.from && plantMonth(t) <= o.to;
  const months: string[] = [];
  for (let m = o.from; m <= o.to && months.length < 60; m = addDays(`${m}-28`, 7).slice(0, 7)) months.push(m);
  const done = analyses.filter((a) => inPeriod(a.finishedAt));
  const decided = samples.filter((s) => s.receivedAt && inPeriod(s.decidedAt));
  const tat = (s: KpiSample) => (s.decidedAt!.getTime() - s.receivedAt!.getTime()) / DAY;
  const target = (p: string) => o.targets[p] ?? TAT_DEFAULT_DAYS[p as SamplePurpose] ?? 10;
  const group = <K extends string>(key: (a: KpiAnalysis) => string, name: K) => [...new Set(done.map(key))].sort()
    .map((k) => ({ [name]: k, ...counts(done.filter((a) => key(a) === k)) }) as KpiCounts & Record<K, string>);
  const backlog = samples.filter((s) => s.receivedAt && !s.decidedAt && !s.disposed).map((s) => {
    const received = plantDay(s.receivedAt!);
    const ageDays = daysFrom(received, o.today);
    const targetDays = target(s.purpose);
    return { sampleNo: s.sampleNo, purpose: s.purpose, received, ageDays, targetDays, due: addDays(received, targetDays), over: ageDays > targetDays };
  }).sort((a, b) => b.ageDays - a.ageDays);
  return {
    months: months.map((month) => {
      const ds = decided.filter((s) => plantMonth(s.decidedAt!) === month);
      const within = ds.filter((s) => tat(s) <= target(s.purpose)).length;
      return { month, ...counts(done.filter((a) => plantMonth(a.finishedAt!) === month)), decided: ds.length,
        tatMeanDays: ds.length ? Math.round((ds.reduce((n, s) => n + tat(s), 0) / ds.length) * 10) / 10 : null, tatWithin: within, tatPct: pct(within, ds.length) };
    }),
    byAnalyst: group((a) => a.analyst, 'analyst'),
    byTest: group((a) => a.method, 'method'),
    backlog,
    buckets: BUCKETS.map(([label, lo, hi]) => {
      const rows = backlog.filter((b) => b.ageDays >= lo && b.ageDays <= hi);
      return { label, count: rows.length, over: rows.filter((b) => b.over).length };
    }),
  };
}

// ---------------------------------------------------------------- workload
/**
 * Why this person may not be assigned a method's analysis (null: may). `skills`: the trainings the method's steps name;
 * `read`: the person's training in each, as Recruitment answers now (absent or down: not checked, said with the
 * assignment).
 */
export function assignRefusal(name: string, skills: readonly { code: string; title?: string }[], read: { state: 'ok'; qualified: Readonly<Record<string, boolean>> } | { state: 'absent' | 'down' }): string | null {
  if (read.state !== 'ok') return null;
  const missing = skills.filter((s) => !read.qualified[s.code]);
  return missing.length ? `${name} has no valid training in ${missing.map((s) => (s.title ? `${s.code} ${s.title}` : s.code)).join(', ')} (Recruitment).` : null;
}
