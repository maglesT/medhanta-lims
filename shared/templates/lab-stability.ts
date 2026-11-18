/**
 * Lab calculation templates, stability part (Medhanta LIMS library 3b and plan 2b, build step 6):
 * L15 ICH Q1E shelf life, L22 prediction interval (out-of-trend early warning), L23 mean kinetic temperature,
 * L24 Arrhenius advisory shelf life, L25 ICH Q1D bracketing and matrixing design check.
 *
 * Same rules as every template (README): inputs are text with units, exact decimals, a plain-English refusal,
 * nothing rounded inside a calculation. Guideline rules are paraphrased; no guideline text is copied.
 * Critical values (Student t) and F-test p-values come from the functions of lab-physchem.ts (L14).
 */
import { checkOf, Dec, fmt, HUNDRED, needKind, ONE, parse, refuse, run, sameKind, to, unitOf, ZERO, type Outcome, type Parsed, type Q } from './core.js';
import { incompleteBeta, tQuantile } from './lab-physchem.js';
import { type Limit } from './rounding.js';

const d = (x: string | number): Dec => new Dec(x);
const TWO = d(2);
const INF = d('Infinity');

// ================================================================ shared: time, points, regression
/** A stability time point in months ("6", "6 months", "6 mo"); never negative. */
export function monthsOf(text: string, what: string): Dec {
  const p = parse(text, what);
  if (p.unit.kind !== 'number' && p.unit.kind !== 'calendar time') refuse(`${what} is a time point in months (e.g. "6" or "6 months"), not "${p.text}"`);
  if (p.v.isNegative()) refuse(`${what} cannot be negative`);
  return p.v;
}

/** Days in a month on average (365.25 ÷ 12): only for a rate or a time written in days or weeks (L24). */
const DAYS_PER_MONTH = d('365.25').div(12);
const DURATION = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z]*)\s*$/;
/** A duration in months: months as written; weeks and days at 365.25 ÷ 12 days per month; hours ÷ 24. */
function durationMonths(text: string, what: string): Dec {
  if (typeof text !== 'string') refuse(`${what} must be given as text (for example "14 days")`);
  const m = DURATION.exec(text);
  if (m === null) refuse(`${what} "${text}" is not a duration (for example "3 months", "4 weeks" or "14 days")`);
  const v = d(m[1] as string);
  const u = (m[2] ?? '').toLowerCase();
  if (['', 'month', 'months', 'mo'].includes(u)) return v;
  if (['week', 'weeks', 'wk', 'w'].includes(u)) return v.times(7).div(DAYS_PER_MONTH);
  if (['day', 'days', 'd'].includes(u)) return v.div(DAYS_PER_MONTH);
  if (['hour', 'hours', 'h'].includes(u)) return v.div(24).div(DAYS_PER_MONTH);
  return refuse(`${what}: "${m[2] ?? ''}" is not a time unit here (months, weeks, days or hours)`);
}

/** One stability result: the time point (months) and the value with its unit. */
export interface StabilityPoint {
  readonly time: string;
  readonly value: Q;
}
/** One batch's results at one storage condition. */
export interface StabilityBatch {
  readonly batch: string;
  readonly points: readonly StabilityPoint[];
}
export type Transform = 'none' | 'log';

interface Read {
  readonly name: string;
  readonly xs: Dec[];
  /** The values regressed: as given, or ln of them. */
  readonly ys: Dec[];
}

/** Reads a batch's points into the unit of `unit` (or the first value's), with the transform. */
function readPoints(points: readonly StabilityPoint[], name: string, transform: Transform, unit: { u?: Parsed }): Read {
  const xs: Dec[] = [];
  const ys: Dec[] = [];
  points.forEach((p, k) => {
    const what = `${name}, point ${k + 1}`;
    xs.push(monthsOf(p.time, `${what}: the time`));
    const v = parse(p.value, `${what}: the value`);
    if (unit.u === undefined) unit.u = v;
    sameKind([unit.u, v], `${what}: the value`);
    const y = to(v, unit.u.unit);
    if (transform === 'log' && !y.gt(0)) refuse(`${what}: a log-transformed fit needs values above zero`);
    ys.push(transform === 'log' ? Dec.ln(y) : y);
  });
  return { name, xs, ys };
}

const distinct = (xs: readonly Dec[]): number => new Set(xs.map((x) => x.toString())).size;

interface Fit {
  readonly n: number;
  readonly xbar: Dec;
  readonly ybar: Dec;
  readonly sxx: Dec;
  readonly sxy: Dec;
  readonly syy: Dec;
  readonly slope: Dec;
  readonly intercept: Dec;
  /** Residual sum of squares. */
  readonly sse: Dec;
}

/** Least-squares line y = intercept + slope × x. */
function fit(xs: readonly Dec[], ys: readonly Dec[]): Fit {
  const n = xs.length;
  const xbar = xs.reduce((s, x) => s.plus(x), ZERO).div(n);
  const ybar = ys.reduce((s, y) => s.plus(y), ZERO).div(n);
  let sxx = ZERO;
  let sxy = ZERO;
  let syy = ZERO;
  xs.forEach((x, k) => {
    const dx = x.minus(xbar);
    const dy = (ys[k] as Dec).minus(ybar);
    sxx = sxx.plus(dx.times(dx));
    sxy = sxy.plus(dx.times(dy));
    syy = syy.plus(dy.times(dy));
  });
  const slope = sxy.div(sxx);
  const sse = Dec.max(ZERO, syy.minus(slope.times(sxy)));
  return { n, xbar, ybar, sxx, sxy, syy, slope, intercept: ybar.minus(slope.times(xbar)), sse };
}

/** Upper-tail probability of F with d1, d2 degrees of freedom: P(F' > F) = I(d2 ÷ (d2 + d1 F); d2/2, d1/2). */
export function fUpperP(F: Dec, d1: Dec, d2: Dec): Dec {
  if (!F.gt(0)) return ONE;
  return incompleteBeta(d2.div(d2.plus(d1.times(F))), d2.div(2), d1.div(2));
}

function confidenceOf(text: string | undefined): { alpha: Dec; text: string } {
  const t = text ?? '95';
  const p = parse(t, 'The confidence level');
  needKind(p, ['number'], 'The confidence level');
  if (!p.v.gt(50) || !p.v.lt(100)) refuse('The confidence level is a % between 50 and 100 (e.g. "95")');
  return { alpha: ONE.minus(p.v.div(HUNDRED)), text: t };
}

/**
 * A regression line with what its confidence (or prediction) band needs: ŷ(t) = intercept + slope × t,
 * var ŷ(t) = s² × (c0 + (t − xbar)² ÷ sxx) (c0 = 1/n for the mean line; 1 + 1/n for a new single result).
 */
interface Line {
  readonly label: string;
  readonly intercept: Dec;
  readonly slope: Dec;
  readonly s: Dec;
  readonly df: Dec;
  readonly c0: Dec;
  readonly xbar: Dec;
  readonly sxx: Dec;
}

const yAt = (l: Line, t: Dec): Dec => l.intercept.plus(l.slope.times(t));
const halfWidth = (l: Line, t: Dec, tq: Dec): Dec => tq.times(l.s).times(l.c0.plus(t.minus(l.xbar).pow(2).div(l.sxx)).sqrt());

/**
 * The first time t ≥ 0 at which the bound (ŷ − hw for a lower criterion, ŷ + hw for an upper one) meets the limit;
 * Infinity when it never does. With D(t) = ±(ŷ(t) − limit) (positive while inside), the bound meets the limit where
 * D(t) = hw(t), i.e. D(t)² = hw(t)² with D(t) ≥ 0: a quadratic A t² + B t + C = 0.
 */
function crossing(l: Line, side: 'lower' | 'upper', limit: Dec, tq: Dec): Dec {
  const sg = side === 'lower' ? ONE : ONE.neg();
  const p = sg.times(l.intercept.minus(limit));
  const q = sg.times(l.slope);
  const K = tq.pow(2).times(l.s.pow(2));
  if (!p.gt(halfWidth(l, ZERO, tq))) return ZERO; // already outside at month 0
  const A = q.pow(2).minus(K.div(l.sxx));
  const B = TWO.times(p).times(q).plus(TWO.times(K).times(l.xbar).div(l.sxx));
  const C = p.pow(2).minus(K.times(l.c0.plus(l.xbar.pow(2).div(l.sxx))));
  let roots: Dec[];
  if (A.isZero()) {
    roots = B.isZero() ? [] : [C.neg().div(B)];
  } else {
    const disc = B.pow(2).minus(TWO.times(TWO).times(A).times(C));
    if (disc.isNegative()) return INF;
    const r = disc.sqrt();
    roots = [B.neg().minus(r).div(TWO.times(A)), B.neg().plus(r).div(TWO.times(A))];
  }
  const ok = roots.filter((t) => t.gt(0) && !p.plus(q.times(t)).isNegative()).sort((a, b) => a.comparedTo(b));
  return ok[0] ?? INF;
}

const months = (t: Dec, dp = 1): string => (t.isFinite() ? `${fmt(t, dp)} months` : 'never');

// ================================================================ L15 ICH Q1E shelf life
/**
 * The Q1E extrapolation inputs (Appendix A decision tree). X = the period the long-term data cover.
 * - storage: room temperature (long-term 25 °C or 30 °C), refrigerated (5 °C, accelerated 25 °C), frozen.
 * - accelerated / intermediate: whether a "significant change" (Q1A definition) was seen there.
 * - change: whether the long-term and accelerated data show little or no change over time and little or no
 *   variability (the "statistics normally unnecessary" branch) or show change or variability.
 * - statistics: the long-term data are amenable to statistical analysis and it is performed (this template performs
 *   it), or they are not amenable (the proposal then rests on relevant supporting data).
 */
export interface L15Extrapolation {
  readonly storage: 'room temperature' | 'refrigerated' | 'frozen';
  readonly accelerated?: 'no significant change' | 'significant change';
  readonly intermediate?: 'no significant change' | 'significant change';
  readonly change?: 'little or none' | 'change or variability';
  readonly statistics?: 'performed' | 'not amenable';
  /** X: months covered by the long-term data (default: the latest time point given). */
  readonly longTerm?: string;
}

export interface L15Input {
  /** Long-term results per batch (at least 3 time points each). */
  readonly batches: readonly StabilityBatch[];
  /** The acceptance criterion: lower, upper or both (both: two-sided confidence limits). */
  readonly criterion: { readonly lower?: Q; readonly upper?: Q };
  /** 'log': ln(value) regressed on time (a decreasing first-order attribute such as an assay). Default none. */
  readonly transform?: Transform;
  /** Confidence level in % (default 95). */
  readonly confidence?: string;
  /** Significance level of the poolability tests (default "0.25"). */
  readonly poolingLevel?: string;
  /** The residual SD of a batch line when the batches are not poolable: its own (default) or of all batches. */
  readonly separateMse?: 'each batch' | 'all batches';
  readonly extrapolation?: L15Extrapolation;
}

export interface L15Batch {
  readonly batch: string;
  readonly n: number;
  readonly slope: Dec;
  readonly intercept: Dec;
  readonly residualSd: Dec;
}
export interface L15BoundLine {
  /** The batch the line belongs to, or "all batches" when pooled. */
  readonly line: string;
  readonly intercept: Dec;
  readonly slope: Dec;
  readonly residualSd: Dec;
  readonly df: Dec;
  readonly t: Dec;
  readonly side: 'lower' | 'upper';
  /** Months at which the bound meets the criterion (Infinity: never). */
  readonly meets: Dec;
}
export interface L15Extra {
  /** The statistical estimate in months (full precision; Infinity when the bound never meets the criterion). */
  readonly estimate: Dec;
  readonly model: 'single batch' | 'pooled' | 'common slope' | 'separate';
  readonly batches: readonly L15Batch[];
  readonly slopesP?: Dec;
  readonly interceptsP?: Dec;
  readonly lines: readonly L15BoundLine[];
  /** The line and side that gave the estimate. */
  readonly limiting: string;
  readonly branch?: string;
  /** X, the months the long-term data cover. */
  readonly longTerm?: Dec;
  /** The extrapolation cap Y (months). */
  readonly cap?: Dec;
  /** min(estimate, cap) rounded down to whole months. */
  readonly proposed?: Dec;
}

/** The Q1E Appendix A branch and its cap, in months, for X months of long-term data. */
function q1eCap(e: L15Extrapolation, X: Dec): { branch: string; cap: Dec; rule: string } {
  const twoX12 = { cap: Dec.min(X.times(2), X.plus(12)), rule: 'up to 2X, not more than X + 12 months' };
  const oneHalf6 = { cap: Dec.min(X.times('1.5'), X.plus(6)), rule: 'up to 1.5X, not more than X + 6 months' };
  const plus3 = { cap: X.plus(3), rule: 'up to X + 3 months' };
  const none = { cap: X, rule: 'no extrapolation: not beyond X' };
  const stats = e.statistics ?? 'performed';
  if (e.storage === 'frozen') return { branch: 'frozen storage: based on the long-term data only', ...none };
  if (e.accelerated === undefined) refuse('Q1E extrapolation: say whether the accelerated condition showed a significant change');
  if (e.storage === 'refrigerated') {
    if (e.accelerated === 'significant change') return { branch: 'refrigerated, significant change at accelerated', ...none };
    if (e.change === undefined) refuse('Q1E extrapolation: say whether the data show little or no change and variability');
    if (e.change === 'little or none') return { branch: 'refrigerated, no significant change at accelerated, little or no change or variability', ...oneHalf6 };
    if (stats === 'performed') return { branch: 'refrigerated, no significant change at accelerated, change or variability, statistical analysis performed', ...oneHalf6 };
    return { branch: 'refrigerated, no significant change at accelerated, change or variability, not amenable to statistics', ...plus3 };
  }
  if (e.accelerated === 'significant change') {
    if (e.intermediate === undefined) refuse('Q1E extrapolation: with a significant change at the accelerated condition, say whether the intermediate condition showed one');
    if (e.intermediate === 'significant change') return { branch: 'room temperature, significant change at accelerated and at intermediate', ...none };
    if (stats === 'performed') return { branch: 'room temperature, significant change at accelerated, none at intermediate, statistical analysis performed', ...oneHalf6 };
    return { branch: 'room temperature, significant change at accelerated, none at intermediate, not amenable to statistics', ...plus3 };
  }
  if (e.change === undefined) refuse('Q1E extrapolation: say whether the data show little or no change and variability');
  if (e.change === 'little or none') return { branch: 'room temperature, no significant change at accelerated, little or no change or variability', ...twoX12 };
  if (stats === 'performed') return { branch: 'room temperature, no significant change at accelerated, change or variability, statistical analysis performed', ...twoX12 };
  return { branch: 'room temperature, no significant change at accelerated, change or variability, not amenable to statistics', ...oneHalf6 };
}

/**
 * L15 ICH Q1E shelf life. Per batch, a least-squares line of the attribute (or its ln) on time in months. Batches are
 * pooled by analysis of covariance at the pooling level (default 0.25): first equality of slopes, then of intercepts,
 * each F tested against the mean square error of the full model (separate lines). Model used: one line through all
 * batches (both p ≥ 0.25), a common slope with each batch's own intercept (slopes p ≥ 0.25, intercepts p < 0.25), or
 * each batch on its own (slopes p < 0.25). The shelf life is the earliest time at which the 95 % confidence bound of
 * the MEAN line meets the acceptance criterion: one-sided lower for a lower criterion, one-sided upper for an upper
 * one, two-sided (α/2 each side) when both are given; the shortest line when batches are not pooled. Optional: the
 * Q1E Appendix A extrapolation cap; the proposed shelf life is the estimate, not beyond the cap, rounded down to
 * whole months.
 */
export function l15ShelfLife(i: L15Input): Outcome<L15Extra> {
  return run(() => {
    const transform = i.transform ?? 'none';
    if (!Array.isArray(i.batches) || i.batches.length === 0) refuse('Give the results of at least one batch');
    const unit: { u?: Parsed } = {};
    const reads = i.batches.map((b) => {
      if (typeof b.batch !== 'string' || b.batch.trim() === '') refuse('Every batch needs its name');
      const r = readPoints(b.points ?? [], b.batch, transform, unit);
      if (distinct(r.xs) < 3) refuse(`Batch ${b.batch} has fewer than 3 time points: Q1E regression needs at least 3`);
      return r;
    });
    if (new Set(reads.map((r) => r.name)).size !== reads.length) refuse('A batch is given twice');
    const vu = unit.u as Parsed;
    const u = vu.unit.symbol;
    const lim = (q: Q | undefined, what: string): Dec | undefined => {
      if (q === undefined) return undefined;
      const p = parse(q, what);
      sameKind([vu, p], what);
      const v = to(p, vu.unit);
      if (transform === 'log' && !v.gt(0)) refuse(`${what} must be above zero for a log-transformed fit`);
      return v;
    };
    const lower = lim(i.criterion?.lower, 'The lower acceptance criterion');
    const upper = lim(i.criterion?.upper, 'The upper acceptance criterion');
    if (lower === undefined && upper === undefined) refuse('Give the acceptance criterion (lower, upper or both)');
    if (lower !== undefined && upper !== undefined && !lower.lt(upper)) refuse('The lower acceptance criterion must be below the upper one');
    const tf = (v: Dec): Dec => (transform === 'log' ? Dec.ln(v) : v);
    const { alpha, text: conf } = confidenceOf(i.confidence);
    const twoSided = lower !== undefined && upper !== undefined;
    const pLevel = parse(i.poolingLevel ?? '0.25', 'The pooling level').v;
    if (!pLevel.gt(0) || !pLevel.lt(1)) refuse('The pooling level is a probability between 0 and 1 (Q1E: 0.25)');

    const fits = reads.map((r) => fit(r.xs, r.ys));
    const k = fits.length;
    const N = fits.reduce((s, f) => s + f.n, 0);
    const sseFull = fits.reduce((s, f) => s.plus(f.sse), ZERO);
    const dfFull = d(N - 2 * k);
    if (sseFull.isZero()) refuse('The results lie exactly on straight lines (no scatter at all): a confidence bound cannot be estimated; check the data');
    const mseFull = sseFull.div(dfFull);
    const batches: L15Batch[] = fits.map((f, n) => ({ batch: (reads[n] as Read).name, n: f.n, slope: f.slope, intercept: f.intercept, residualSd: f.sse.div(f.n - 2).sqrt() }));

    let model: L15Extra['model'] = 'single batch';
    let slopesP: Dec | undefined;
    let interceptsP: Dec | undefined;
    let lines: Line[];
    const sep = (): Line[] => fits.map((f, n) => {
      const name = (reads[n] as Read).name;
      const own = (i.separateMse ?? 'each batch') === 'each batch';
      if (own && f.sse.isZero()) refuse(`Batch ${name} lies exactly on a straight line (no scatter): use the residual SD of all batches (separateMse "all batches")`);
      return { label: name, intercept: f.intercept, slope: f.slope, s: own ? f.sse.div(f.n - 2).sqrt() : mseFull.sqrt(), df: own ? d(f.n - 2) : dfFull, c0: ONE.div(f.n), xbar: f.xbar, sxx: f.sxx };
    });
    if (k === 1) {
      lines = sep();
    } else {
      const sumSxx = fits.reduce((s, f) => s.plus(f.sxx), ZERO);
      const sumSxy = fits.reduce((s, f) => s.plus(f.sxy), ZERO);
      const sumSyy = fits.reduce((s, f) => s.plus(f.syy), ZERO);
      const bc = sumSxy.div(sumSxx);
      const sseCs = Dec.max(sseFull, sumSyy.minus(bc.times(sumSxy)));
      const all = fit(reads.flatMap((r) => r.xs), reads.flatMap((r) => r.ys));
      const ssePool = Dec.max(sseCs, all.sse);
      const dk = d(k - 1);
      slopesP = fUpperP(sseCs.minus(sseFull).div(dk).div(mseFull), dk, dfFull);
      interceptsP = fUpperP(ssePool.minus(sseCs).div(dk).div(mseFull), dk, dfFull);
      if (slopesP.lt(pLevel)) {
        model = 'separate';
        lines = sep();
      } else if (interceptsP.lt(pLevel)) {
        model = 'common slope';
        const df = d(N - k - 1);
        const s = sseCs.div(df).sqrt();
        lines = fits.map((f, n) => ({ label: (reads[n] as Read).name, intercept: f.ybar.minus(bc.times(f.xbar)), slope: bc, s, df, c0: ONE.div(f.n), xbar: f.xbar, sxx: sumSxx }));
      } else {
        model = 'pooled';
        lines = [{ label: 'all batches', intercept: all.intercept, slope: all.slope, s: all.sse.div(N - 2).sqrt(), df: d(N - 2), c0: ONE.div(N), xbar: all.xbar, sxx: all.sxx }];
      }
    }

    const bound: L15BoundLine[] = [];
    for (const l of lines) {
      const tq = tQuantile(ONE.minus(twoSided ? alpha.div(2) : alpha), l.df);
      for (const [side, limit] of [['lower', lower], ['upper', upper]] as const) {
        if (limit === undefined) continue;
        bound.push({ line: l.label, intercept: l.intercept, slope: l.slope, residualSd: l.s, df: l.df, t: tq, side, meets: crossing(l, side, tf(limit), tq) });
      }
    }
    const first = bound.reduce((a, b) => (b.meets.lt(a.meets) ? b : a));
    const estimate = first.meets;
    const limiting = `${first.line} (${first.side})`;

    const dp = 4;
    const slopeUnit = transform === 'log' ? 'ln per month' : `${u} per month`;
    const parts: string[] = [];
    parts.push(`${k} batch${k === 1 ? '' : 'es'}, ${N} results${transform === 'log' ? ', ln(value) regressed on time' : ''}; slopes ${batches.map((b) => `${b.batch} ${fmt(b.slope, dp + 1)}`).join(', ')} ${slopeUnit}`);
    if (k > 1) {
      const p3 = (p: Dec): string => fmt(p, 3);
      parts.push(`poolability (ANCOVA, level ${pLevel.toString()}): slopes p = ${p3(slopesP as Dec)}${(slopesP as Dec).lt(pLevel) ? ' (differ)' : ''}, intercepts p = ${p3(interceptsP as Dec)}${(slopesP as Dec).lt(pLevel) ? ' (not used)' : (interceptsP as Dec).lt(pLevel) ? ' (differ)' : ''}: ${model === 'pooled' ? 'batches pooled, one line' : model === 'common slope' ? 'common slope, each batch its own intercept, the earliest batch counts' : 'each batch on its own, the shortest batch counts'}`);
    }
    const sideText = twoSided ? `two-sided ${conf} % confidence limits` : `one-sided ${conf} % ${lower !== undefined ? 'lower' : 'upper'} confidence bound`;
    const crit = [lower !== undefined ? `NLT ${fmt(lower, Math.max(1, decOf(i.criterion.lower)))} ${u}` : '', upper !== undefined ? `NMT ${fmt(upper, Math.max(1, decOf(i.criterion.upper)))} ${u}` : ''].filter((x) => x !== '').join(' and ');
    const lineText = `${first.line === 'all batches' ? 'the pooled line' : `batch ${first.line}`}: ${transform === 'log' ? 'ln y' : 'y'} = ${fmt(first.intercept, dp + 1)} ${first.slope.isNegative() ? '−' : '+'} ${fmt(first.slope.abs(), dp + 1)} × t, s = ${fmt(first.residualSd, dp + 1)}, df ${first.df.toString()}, t = ${fmt(first.t, 3)}`;
    if (estimate.isFinite()) {
      parts.push(`the ${sideText} of the mean (${lineText}) meets ${crit} at ${months(estimate)}${estimate.isZero() ? ' (already outside at month 0)' : ''}`);
    } else {
      parts.push(`the ${sideText} of the mean never meets ${crit} (${lineText}): this attribute does not limit the shelf life`);
    }

    const extra: { -readonly [K in keyof L15Extra]?: L15Extra[K] } = { estimate, model, batches, lines: bound, limiting, ...(slopesP ? { slopesP, interceptsP } : {}) };
    let value = estimate;
    if (i.extrapolation !== undefined) {
      const latest = reads.flatMap((r) => r.xs).reduce((a, b) => Dec.max(a, b));
      const X = i.extrapolation.longTerm === undefined ? latest : monthsOf(i.extrapolation.longTerm, 'The period covered by the long-term data');
      if (X.lt(latest)) refuse(`The long-term data cover ${fmt(latest, 0)} months (latest time point), not ${X.toString()}`);
      if (!X.gt(0)) refuse('The period covered by the long-term data must be more than zero');
      const c = q1eCap(i.extrapolation, X);
      const proposed = Dec.min(estimate, c.cap).floor();
      Object.assign(extra, { branch: c.branch, longTerm: X, cap: c.cap, proposed });
      value = proposed;
      parts.push(`Q1E decision tree: ${c.branch}: ${c.rule} = ${months(c.cap, 1)} (X = ${X.toString()} months); proposed shelf life ${proposed.toString()} months (${estimate.lt(c.cap) ? 'the statistical estimate' : 'the extrapolation cap'}, rounded down to whole months)`);
    } else if (estimate.isFinite()) {
      parts.push(`estimated shelf life ${estimate.floor().toString()} months (rounded down)`);
    }
    return { ok: true, value, unit: 'months', shown: parts.join('; '), ...(extra as L15Extra) };
  });
}

const decOf = (q: Q | undefined): number => {
  if (q === undefined) return 0;
  const t = (typeof q === 'string' ? q.trim().split(/\s+/)[0] : q.value) ?? '';
  const n = t.indexOf('.');
  return n < 0 ? 0 : t.length - n - 1;
};

// ================================================================ L22 prediction interval (OOT)
export interface L22Input {
  /** The batch's earlier results at this condition (the new one not included). */
  readonly batch?: readonly StabilityPoint[];
  /** The new result to judge. */
  readonly result: StabilityPoint;
  /** Optional: the product's historical batches at the same condition, pooled into one line. */
  readonly historical?: readonly StabilityBatch[];
  readonly transform?: Transform;
  /** Confidence level in % (default 95), two-sided. */
  readonly confidence?: string;
  readonly decimals?: number;
}
export interface PredictionInterval {
  readonly low: Dec;
  readonly high: Dec;
  readonly predicted: Dec;
  readonly within: boolean;
}
export interface L22Extra {
  readonly batchInterval?: PredictionInterval;
  readonly historicalInterval?: PredictionInterval;
  /** true when the new result is outside any interval computed: an out-of-trend flag (LIMS-25). */
  readonly oot: boolean;
}

/**
 * L22 Prediction interval (out-of-trend early warning). The new result at time t against the two-sided prediction
 * interval of a single new result from the batch's own earlier results: ŷ(t) ± t(1 − α/2; n − 2) × s ×
 * √(1 + 1/n + (t − x̄)² ÷ Sxx); and, when given, from the product's historical batches pooled into one line (all
 * their results together). Outside either = out of trend. With the log transform the interval is computed on ln
 * values and shown back in the value's unit.
 */
export function l22PredictionInterval(i: L22Input): Outcome<L22Extra> {
  return run(() => {
    const transform = i.transform ?? 'none';
    const unit: { u?: Parsed } = {};
    const now = readPoints([i.result], 'The new result', transform, unit);
    const t = now.xs[0] as Dec;
    const y = now.ys[0] as Dec;
    const vu = unit.u as Parsed;
    const dp = i.decimals ?? Math.max(1, decOf(i.result.value));
    const { alpha, text: conf } = confidenceOf(i.confidence);
    const back = (v: Dec): Dec => (transform === 'log' ? Dec.exp(v) : v);
    const interval = (xs: Dec[], ys: Dec[], what: string): PredictionInterval => {
      const f = fit(xs, ys);
      if (f.sse.isZero()) refuse(`${what} lie exactly on a straight line (no scatter): a prediction interval cannot be estimated`);
      const l: Line = { label: what, intercept: f.intercept, slope: f.slope, s: f.sse.div(f.n - 2).sqrt(), df: d(f.n - 2), c0: ONE.plus(ONE.div(f.n)), xbar: f.xbar, sxx: f.sxx };
      const tq = tQuantile(ONE.minus(alpha.div(2)), l.df);
      const p = yAt(l, t);
      const h = halfWidth(l, t, tq);
      return { low: back(p.minus(h)), high: back(p.plus(h)), predicted: back(p), within: !y.lt(p.minus(h)) && !y.gt(p.plus(h)) };
    };
    const parts: string[] = [];
    const extra: { batchInterval?: PredictionInterval; historicalInterval?: PredictionInterval } = {};
    const own = readPoints(i.batch ?? [], 'This batch', transform, unit);
    const hasHist = i.historical !== undefined && i.historical.length > 0;
    const show = (pi: PredictionInterval): string => `predicted ${fmt(pi.predicted, dp)}, ${conf} % prediction interval ${fmt(pi.low, dp)} to ${fmt(pi.high, dp)} ${vu.unit.symbol}: ${pi.within ? 'within' : 'OUTSIDE'}`;
    if (distinct(own.xs) >= 3) {
      extra.batchInterval = interval(own.xs, own.ys, 'This batch\'s earlier results');
      parts.push(`this batch (${own.xs.length} earlier results): ${show(extra.batchInterval)}`);
    } else if (!hasHist) {
      refuse('The batch has fewer than 3 earlier time points: a prediction interval needs at least 3 (or give the product\'s historical batches)');
    } else {
      parts.push(`this batch has fewer than 3 earlier time points: judged on the historical batches only`);
    }
    if (hasHist) {
      const hs = (i.historical as readonly StabilityBatch[]).map((b) => readPoints(b.points ?? [], `Historical batch ${b.batch}`, transform, unit));
      const xs = hs.flatMap((r) => r.xs);
      if (distinct(xs) < 3) refuse('The historical batches have fewer than 3 time points together');
      extra.historicalInterval = interval(xs, hs.flatMap((r) => r.ys), 'The historical results');
      parts.push(`historical batches pooled (${hs.length} batches, ${xs.length} results): ${show(extra.historicalInterval)}`);
    }
    const oot = [extra.batchInterval, extra.historicalInterval].some((x) => x !== undefined && !x.within);
    const v = to(parse(i.result.value, 'The new result'), vu.unit);
    const shown = `result ${fmt(v, dp)} ${vu.unit.symbol} at ${t.toString()} months: ${parts.join('; ')}${oot ? ': OUT OF TREND' : ': in trend'}`;
    return { ok: true, value: v, unit: vu.unit.symbol, shown, oot, ...extra };
  });
}

// ================================================================ L23 mean kinetic temperature
export interface L23Input {
  /** Temperature readings taken at equal intervals (°C, K or °F). */
  readonly readings: readonly Q[];
  /** Optional reading times (ISO date-times, same count): checked to be at equal intervals. */
  readonly times?: readonly string[];
  /** Activation energy ΔH (default 83.144 kJ/mol, USP). */
  readonly deltaH?: Q;
  readonly decimals?: number;
  /** The storage condition's limit on the MKT (e.g. NMT 25 °C). */
  readonly limit?: Limit;
}

/** USP <1160> gas constant, 8.3144 J/(mol·K) (with the default ΔH 83.144 kJ/mol, ΔH ÷ R = 10 000 K). */
const R_USP = d('0.0083144'); // kJ/(mol·K)

/**
 * L23 Mean kinetic temperature (USP <1160>, <1079.2>): MKT = (ΔH ÷ R) ÷ (−ln((Σ e^(−ΔH ÷ (R × Tᵢ))) ÷ n)),
 * Tᵢ in kelvin (°C + 273.15 exactly), readings at equal intervals; reported in °C and checked against the storage
 * condition's limit.
 */
export function l23Mkt(i: L23Input): Outcome<{ readonly kelvin: Dec; readonly mean: Dec; readonly highest: Dec }> {
  return run(() => {
    if (!Array.isArray(i.readings) || i.readings.length < 2) refuse('The mean kinetic temperature needs at least two readings taken at equal intervals');
    const ts = i.readings.map((q, k) => {
      const p = parse(q, `Reading ${k + 1}`);
      needKind(p, ['temperature'], `Reading ${k + 1}`);
      const K = to(p, 'K');
      if (!K.gt(0)) refuse(`Reading ${k + 1} is at or below absolute zero`);
      return K;
    });
    if (i.times !== undefined) {
      if (i.times.length !== ts.length) refuse('Give one time per reading (or no times)');
      const ms = i.times.map((t, k) => {
        const v = Date.parse(t);
        if (Number.isNaN(v)) refuse(`Time ${k + 1} "${t}" is not a date and time`);
        return v;
      });
      const step = (ms[1] as number) - (ms[0] as number);
      if (!(step > 0)) refuse('The reading times must rise');
      ms.forEach((m, k) => {
        if (k > 0 && m - (ms[k - 1] as number) !== step) refuse(`MKT needs readings at equal intervals: reading ${k + 1} is not ${step / 60000} min after the one before`);
      });
    }
    const dh = parse(i.deltaH ?? '83.144 kJ/mol', 'ΔH');
    needKind(dh, ['molar energy'], 'ΔH');
    const dhK = to(dh, 'kJ/mol');
    if (!dhK.gt(0)) refuse('ΔH must be more than zero');
    const ratio = dhK.div(R_USP); // K
    const n = ts.length;
    const sum = ts.reduce((s, T) => s.plus(Dec.exp(ratio.neg().div(T))), ZERO);
    const kelvin = ratio.div(Dec.ln(sum.div(n)).neg());
    const c = to({ v: kelvin, unit: unitOf('K'), text: '' }, '°C');
    const mean = ts.reduce((s, T) => s.plus(T), ZERO).div(n).minus('273.15');
    const highest = ts.reduce((a, b) => Dec.max(a, b)).minus('273.15');
    const dp = i.decimals ?? 2;
    const shown = `MKT = ${fmt(ratio, 1)} K ÷ −ln(Σ e^(−${fmt(ratio, 1)} ÷ T) ÷ ${n}) = ${fmt(kelvin, dp)} K = ${fmt(c, dp)} °C (${n} readings; arithmetic mean ${fmt(mean, dp)} °C, highest ${fmt(highest, dp)} °C; ΔH ${dh.text})`;
    return { ok: true, value: c, unit: '°C', shown, kelvin, mean, highest, ...checkOf(c, '°C', i.limit) };
  });
}

// ================================================================ L24 Arrhenius advisory shelf life
export interface L24Point {
  readonly temperature: Q;
  /** Relative humidity (%RH): give it on every point, or on none. */
  readonly rh?: Q;
  /** The degradation rate, e.g. "0.12 %/day", "0.8 %/week", "1.5 %/month". */
  readonly rate?: string;
  /** Or the time to reach the allowed change at this condition (isoconversion), e.g. "14 days". */
  readonly timeToLimit?: string;
}
export interface L24Input {
  readonly points: readonly L24Point[];
  /** The change the specification allows (e.g. "0.5 %" degradant growth or "5 %" assay loss). */
  readonly allowedChange: Q;
  readonly storage: { readonly temperature: Q; readonly rh?: Q };
  readonly decimals?: number;
}
export interface L24Extra {
  readonly advisory: true;
  /** Activation energy, kJ/mol. */
  readonly ea: Dec;
  /** Humidity sensitivity B (per %RH), when humidities were given. */
  readonly b?: Dec;
  readonly lnA: Dec;
  /** Predicted rate at the storage condition, per month (in the allowed change's unit). */
  readonly rateAtStorage: Dec;
  readonly r2: Dec;
}

const ADVISORY = 'advisory: for development decisions, not for the label (the label shelf life is ICH Q1E)';
/** The gas constant, J/(mol·K) (SI, exact). */
const R_SI = d('8.31446261815324');

/** Solves the normal equations of least squares with an intercept (1 or 2 predictors), by centred sums. */
function multiFit(xs: readonly (readonly Dec[])[], ys: readonly Dec[]): { b0: Dec; b: Dec[]; r2: Dec } {
  const n = ys.length;
  const p = (xs[0] as readonly Dec[]).length;
  const mean = (v: readonly Dec[]): Dec => v.reduce((s, x) => s.plus(x), ZERO).div(v.length);
  const mx = Array.from({ length: p }, (_, j) => mean(xs.map((r) => r[j] as Dec)));
  const my = mean(ys);
  const S = Array.from({ length: p }, (_, a) => Array.from({ length: p }, (_, b) => xs.reduce((s, r) => s.plus((r[a] as Dec).minus(mx[a] as Dec).times((r[b] as Dec).minus(mx[b] as Dec))), ZERO)));
  const Sy = Array.from({ length: p }, (_, a) => xs.reduce((s, r, k) => s.plus((r[a] as Dec).minus(mx[a] as Dec).times((ys[k] as Dec).minus(my))), ZERO));
  let b: Dec[];
  if (p === 1) {
    b = [(Sy[0] as Dec).div((S[0] as Dec[])[0] as Dec)];
  } else {
    const [a11, a12] = S[0] as Dec[];
    const [, a22] = S[1] as Dec[];
    const det = (a11 as Dec).times(a22 as Dec).minus((a12 as Dec).pow(2));
    if (det.abs().lte((a11 as Dec).times(a22 as Dec).times('1e-30'))) refuse('Temperature and humidity vary together in these conditions: their effects cannot be told apart; add conditions where they vary independently');
    b = [(a22 as Dec).times(Sy[0] as Dec).minus((a12 as Dec).times(Sy[1] as Dec)).div(det), (a11 as Dec).times(Sy[1] as Dec).minus((a12 as Dec).times(Sy[0] as Dec)).div(det)];
  }
  const b0 = my.minus(b.reduce((s, bj, j) => s.plus(bj.times(mx[j] as Dec)), ZERO));
  const syy = ys.reduce((s, y) => s.plus(y.minus(my).pow(2)), ZERO);
  const sse = ys.reduce((s, y, k) => s.plus(y.minus(b0.plus(b.reduce((t, bj, j) => t.plus(bj.times((xs[k] as readonly Dec[])[j] as Dec)), ZERO))).pow(2)), ZERO);
  return { b0, b, r2: syy.isZero() ? ONE : ONE.minus(sse.div(syy)) };
}

/**
 * L24 Arrhenius advisory shelf life (accelerated predictive stability, ASAP style). From degradation rates k at
 * three or more elevated temperatures (a rate, or the allowed change ÷ the time to reach it), least squares of
 * ln k = ln A − Ea ÷ (R T) (and + B × RH, the humidity-corrected Arrhenius equation, when humidities are given);
 * k at the storage condition; the time to the allowed change = allowed change ÷ k (zero-order in the attribute).
 * Advisory only, for development decisions; the label shelf life is ICH Q1E (L15).
 */
export function l24Arrhenius(i: L24Input): Outcome<L24Extra> {
  return run(() => {
    if (!Array.isArray(i.points) || i.points.length === 0) refuse('Give the degradation rates at three or more temperatures');
    const allowed = parse(i.allowedChange, 'The allowed change');
    if (!allowed.v.gt(0)) refuse('The allowed change must be more than zero');
    const withRh = i.points.filter((p) => p.rh !== undefined).length;
    if (withRh !== 0 && withRh !== i.points.length) refuse('Give the humidity on every condition, or on none');
    const humid = withRh > 0;
    if (humid && i.storage.rh === undefined) refuse('The rates depend on humidity: give the storage humidity too');
    const kelvin = (q: Q, what: string): Dec => {
      const p = parse(q, what);
      needKind(p, ['temperature'], what);
      const K = to(p, 'K');
      if (!K.gt(0)) refuse(`${what} is at or below absolute zero`);
      return K;
    };
    const rhOf = (q: Q, what: string): Dec => {
      const p = parse(q, what);
      if (p.unit.kind !== 'number') needKind(p, ['relative humidity'], what);
      if (p.v.isNegative() || p.v.gt(100)) refuse(`${what} must be 0 to 100 %RH`);
      return p.v;
    };
    const rows = i.points.map((pt, k) => {
      const what = `Condition ${k + 1}`;
      const T = kelvin(pt.temperature, `${what}: the temperature`);
      let rate: Dec;
      if ((pt.rate === undefined) === (pt.timeToLimit === undefined)) refuse(`${what}: give either the rate or the time to the allowed change`);
      if (pt.rate !== undefined) {
        const cut = pt.rate.lastIndexOf('/');
        if (cut < 0) refuse(`${what}: write the rate per time, e.g. "0.12 %/day"`);
        const amount = parse(pt.rate.slice(0, cut), `${what}: the rate`);
        sameKind([allowed, amount], `${what}: the rate`);
        rate = to(amount, allowed.unit).div(durationMonths(`1 ${pt.rate.slice(cut + 1).trim()}`, `${what}: the rate's time unit`));
      } else {
        const m = durationMonths(pt.timeToLimit as string, `${what}: the time to the allowed change`);
        if (!m.gt(0)) refuse(`${what}: the time to the allowed change must be more than zero`);
        rate = allowed.v.div(m);
      }
      if (!rate.gt(0)) refuse(`${what}: the degradation rate must be more than zero`);
      return { T, rh: humid ? rhOf(pt.rh as Q, `${what}: the humidity`) : ZERO, rate };
    });
    const temps = new Set(rows.map((r) => r.T.toString())).size;
    if (temps < 3) refuse(`Arrhenius needs rates at three or more different temperatures (${temps} given)`);
    if (humid && new Set(rows.map((r) => r.rh.toString())).size < 2) refuse('The humidity-corrected fit needs at least two different humidities');
    if (humid && rows.length < 4) refuse('The humidity-corrected fit (three constants) needs at least four conditions');
    const xs = rows.map((r) => (humid ? [ONE.div(r.T), r.rh] : [ONE.div(r.T)]));
    const f = multiFit(xs, rows.map((r) => Dec.ln(r.rate)));
    const slope = f.b[0] as Dec; // = −Ea ÷ R
    const ea = slope.neg().times(R_SI).div(1000);
    if (!ea.gt(0)) refuse('The rates do not rise with temperature: this is not Arrhenius behaviour, no prediction is made');
    const Ts = kelvin(i.storage.temperature, 'The storage temperature');
    const rhS = humid ? rhOf(i.storage.rh as Q, 'The storage humidity') : ZERO;
    const lnK = f.b0.plus(slope.div(Ts)).plus(humid ? (f.b[1] as Dec).times(rhS) : ZERO);
    const k = Dec.exp(lnK);
    const time = allowed.v.div(k);
    const dp = i.decimals ?? 1;
    const u = allowed.unit.symbol;
    const sT = `${fmt(Ts.minus('273.15'), 1)} °C${humid ? `/${fmt(rhS, 0)} %RH` : ''}`;
    const shown = `${ADVISORY}. ln k = ${fmt(f.b0, 3)} − ${fmt(slope.neg(), 1)} ÷ T${humid ? ` ${(f.b[1] as Dec).isNegative() ? '−' : '+'} ${fmt((f.b[1] as Dec).abs(), 4)} × RH` : ''} (${rows.length} conditions, R² = ${fmt(f.r2, 4)}); Ea = ${fmt(ea, 1)} kJ/mol${humid ? `, B = ${fmt(f.b[1] as Dec, 4)} per %RH` : ''}; k at ${sT} = ${fmt(k, 5)} ${u} per month; time to ${allowed.text} = ${fmt(time, dp)} months`;
    return { ok: true, value: time, unit: 'months', shown, advisory: true, ea, lnA: f.b0, rateAtStorage: k, r2: f.r2, ...(humid ? { b: f.b[1] as Dec } : {}) };
  });
}

// ================================================================ L25 ICH Q1D design check
export interface L25Level {
  readonly name: string;
  /** The quantity that orders the levels (strength, fill, container size, or a pack's ratio that makes it an extreme). */
  readonly size?: Q;
  /** Placed on stability (tested) in this design. */
  readonly tested: boolean;
}
export interface L25Factor {
  readonly name: string;
  readonly kind: 'strength' | 'container size' | 'fill' | 'pack';
  readonly levels: readonly L25Level[];
  /** Strength: the formulations of the levels are identical, closely related or different. */
  readonly formulation?: 'identical' | 'closely related' | 'different';
  /** Container size, fill, pack: the same container closure system across the levels. */
  readonly sameClosureSystem?: boolean;
  /** Pack: why the tested packs are the extremes (e.g. surface area to volume, wall thickness). */
  readonly justification?: string;
}
export interface L25Row {
  readonly batch: string;
  /** The factor levels of this combination, by factor name. */
  readonly levels?: Readonly<Record<string, string>>;
  /** The time points (months) this combination is tested at. */
  readonly times: readonly string[];
}
export interface L25Input {
  readonly design: 'full' | 'bracketing' | 'matrixing' | 'bracketing and matrixing';
  readonly factors?: readonly L25Factor[];
  readonly condition?: 'long-term' | 'intermediate' | 'accelerated';
  /** The protocol's full schedule of time points (months). */
  readonly timePoints?: readonly string[];
  readonly schedule?: readonly L25Row[];
  /** Matrixing: the stated reduction of the intermediate time points, as a fraction ("1/2", "1/3"). */
  readonly reduction?: string;
  /** Matrixing: full long-term data up to the proposed shelf life will be available before approval. */
  readonly fullDataBeforeApproval?: boolean;
  /** Matrixing: the last time point before submission (default 12 months). */
  readonly submissionTime?: string;
  /** Matrixing: the variability the supporting data show. */
  readonly variability?: 'small' | 'moderate' | 'large';
  /** Matrixing with moderate variability: the design is statistically justified. */
  readonly statisticallyJustified?: boolean;
}

/**
 * L25 ICH Q1D design check (rules paraphrased). Bracketing: only the extremes of a factor need be tested when every
 * untested level lies between tested extremes; strengths need identical or closely related formulations; container
 * size or fill need the same container closure system, one of the two varying while the other stays; packs need a
 * stated reason why the tested ones are the extremes. Matrixing: every selected combination is tested at the initial
 * and final time points (and at the last time point before submission, 12 months by default, unless full long-term
 * data will be available before approval); at least three time points, including initial, in the first 12 months
 * (long-term) or including initial and final (accelerated, intermediate); the stated reduction of the intermediate
 * time points is met and the design is balanced; not with large variability; moderate variability needs a
 * statistical justification. Full design: every combination at every time point. The value is the number of problems.
 */
export function l25DesignCheck(i: L25Input): Outcome<{ readonly pass: boolean; readonly problems: readonly string[]; readonly notes: readonly string[] }> {
  return run(() => {
    const problems: string[] = [];
    const notes: string[] = [];
    const bracketing = i.design === 'bracketing' || i.design === 'bracketing and matrixing';
    const matrixing = i.design === 'matrixing' || i.design === 'bracketing and matrixing';
    if (!['full', 'bracketing', 'matrixing', 'bracketing and matrixing'].includes(i.design)) refuse('The design is full, bracketing, matrixing or bracketing and matrixing');
    const factors = i.factors ?? [];
    if (bracketing && factors.length === 0) refuse('Bracketing needs the factors (strengths, container sizes, fills, packs) with their levels');
    const names = new Set<string>();
    for (const f of factors) {
      if (names.has(f.name)) refuse(`The factor ${f.name} is given twice`);
      names.add(f.name);
      if (f.levels.length < 1) refuse(`The factor ${f.name} has no levels`);
      if (new Set(f.levels.map((l) => l.name)).size !== f.levels.length) refuse(`The factor ${f.name} has a level twice`);
    }

    // ---- bracketing
    const bracketed = factors.filter((f) => f.levels.some((l) => !l.tested));
    if (!bracketing) {
      for (const f of bracketed) problems.push(`${f.name}: levels ${f.levels.filter((l) => !l.tested).map((l) => l.name).join(', ')} are not tested, but the design is not bracketing (a ${i.design} design tests every level)`);
    } else {
      if (bracketed.length === 0) notes.push('bracketing: every level is tested (no level is left out)');
      for (const f of bracketed) {
        if (f.levels.some((l) => l.size === undefined)) refuse(`Bracketing ${f.name}: give the quantity of every level (what makes the tested ones the extremes)`);
        const ps = f.levels.map((l) => parse(l.size as Q, `${f.name} ${l.name}`));
        sameKind(ps, `${f.name}`);
        const vs = ps.map((p) => to(p, (ps[0] as Parsed).unit));
        const lo = vs.reduce((a, b) => Dec.min(a, b));
        const hi = vs.reduce((a, b) => Dec.max(a, b));
        const missing = f.levels.filter((l, k) => !l.tested && ((vs[k] as Dec).eq(lo) || (vs[k] as Dec).eq(hi)));
        if (missing.length > 0) problems.push(`${f.name}: the extremes must be tested; ${missing.map((l) => l.name).join(', ')} ${missing.length === 1 ? 'is an extreme' : 'are extremes'} and not tested`);
        else notes.push(`${f.name}: extremes tested, ${f.levels.filter((l) => !l.tested).map((l) => l.name).join(', ')} bracketed between them`);
        if (f.kind === 'strength') {
          if (f.formulation === undefined) problems.push(`${f.name}: state whether the formulations of the strengths are identical, closely related or different`);
          else if (f.formulation === 'different') problems.push(`${f.name}: bracketing of strengths needs identical or closely related formulations (e.g. one granulation compressed to different weights); these differ`);
        } else {
          if (f.sameClosureSystem !== true) problems.push(`${f.name}: bracketing of ${f.kind} needs the same container closure system across the levels`);
          if (f.kind === 'pack' && (f.justification ?? '').trim() === '') problems.push(`${f.name}: bracketing of packs needs the reason why the tested packs are the extremes (e.g. surface area to volume, wall thickness)`);
        }
      }
      if (bracketed.some((f) => f.kind === 'container size') && bracketed.some((f) => f.kind === 'fill')) {
        problems.push('bracketing on container size and fill together: Q1D allows it when one of them varies while the other stays the same');
      }
    }

    // ---- schedule
    const tp = (i.timePoints ?? []).map((t, k) => monthsOf(t, `Time point ${k + 1}`));
    const rows = i.schedule ?? [];
    if ((matrixing || rows.length > 0) && tp.length < 2) refuse('Give the protocol\'s time points (at least the initial and the final)');
    if (matrixing && rows.length === 0) refuse('Matrixing needs the schedule: which time points each batch and combination is tested at');
    const key = (v: Dec): string => v.toString();
    const tpSet = new Set(tp.map(key));
    const initial = tp.length > 0 ? tp.reduce((a, b) => Dec.min(a, b)) : ZERO;
    const final = tp.length > 0 ? tp.reduce((a, b) => Dec.max(a, b)) : ZERO;
    const combo = (r: L25Row): string => `${r.batch}${r.levels ? ` ${Object.entries(r.levels).map(([, v]) => v).join(' ')}` : ''}`;
    const rowTimes = rows.map((r) => {
      const ts = r.times.map((t, k) => monthsOf(t, `${combo(r)}: time ${k + 1}`));
      for (const t of ts) if (!tpSet.has(key(t))) refuse(`${combo(r)}: ${t.toString()} months is not a time point of the protocol`);
      for (const [fname, lv] of Object.entries(r.levels ?? {})) {
        const f = factors.find((x) => x.name === fname);
        if (f === undefined) refuse(`${combo(r)}: there is no factor ${fname}`);
        const level = f.levels.find((l) => l.name === lv);
        if (level === undefined) refuse(`${combo(r)}: ${fname} has no level ${lv}`);
        if (!level.tested) problems.push(`${combo(r)}: ${fname} ${lv} is scheduled but marked as not tested`);
      }
      return new Set(ts.map(key));
    });
    if (new Set(rows.map(combo)).size !== rows.length) refuse('A combination of batch and levels is scheduled twice');
    if (rows.length > 0) {
      for (const f of factors) for (const l of f.levels.filter((x) => x.tested)) {
        if (!rows.some((r) => r.levels?.[f.name] === l.name)) problems.push(`${f.name} ${l.name} is to be tested but no batch is scheduled for it`);
      }
    }

    if (!matrixing && rows.length > 0) {
      rows.forEach((r, k) => {
        const lacks = tp.filter((t) => !(rowTimes[k] as Set<string>).has(key(t)));
        if (lacks.length > 0) problems.push(`${combo(r)}: a ${i.design} design tests every time point; missing ${lacks.map((t) => t.toString()).join(', ')} months`);
      });
    }
    if (matrixing) {
      const condition = i.condition ?? 'long-term';
      const needSub = condition === 'long-term' && i.fullDataBeforeApproval !== true;
      const sub = needSub ? monthsOf(i.submissionTime ?? '12', 'The last time point before submission') : undefined;
      if (sub !== undefined && !tpSet.has(key(sub))) refuse(`The last time point before submission (${sub.toString()} months) is not a time point of the protocol`);
      rows.forEach((r, k) => {
        const has = rowTimes[k] as Set<string>;
        const lacks = [initial, final, ...(sub ? [sub] : [])].filter((t) => !has.has(key(t)));
        if (lacks.length > 0) problems.push(`${combo(r)}: every combination is tested at the initial and final time points${sub ? ` and at ${sub.toString()} months (the last before submission)` : ''}; missing ${[...new Set(lacks.map(key))].join(', ')} months`);
        if (condition === 'long-term') {
          const early = tp.filter((t) => t.lte(12) && has.has(key(t)));
          if (early.length < 3 || !has.has(key(initial))) problems.push(`${combo(r)}: at least three time points including the initial are needed in the first 12 months (${early.length} tested)`);
        } else if (has.size < 3) {
          problems.push(`${combo(r)}: at the ${condition} condition at least three time points including the initial and final are needed (${has.size} tested)`);
        }
      });
      const fixed = new Set([initial, final, ...(sub ? [sub] : [])].map(key));
      const middle = tp.filter((t) => !fixed.has(key(t)));
      if (i.reduction === undefined) problems.push('matrixing: state the reduction of the intermediate time points (e.g. "1/2" or "1/3")');
      else if (middle.length > 0) {
        const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(i.reduction);
        if (m === null) refuse('The reduction is a fraction such as "1/2" or "1/3"');
        const r = d(m[1] as string).div(m[2] as string);
        if (!r.gt(0) || !r.lt(1)) refuse('The reduction is a fraction between 0 and 1');
        const counts = rows.map((_, k) => middle.filter((t) => (rowTimes[k] as Set<string>).has(key(t))).length);
        const cells = d(rows.length * middle.length);
        const tested = d(counts.reduce((s, c) => s + c, 0));
        const want = cells.times(ONE.minus(r));
        if (!tested.eq(want)) problems.push(`matrixing: a ${i.reduction} reduction tests ${fmt(want, 1)} of the ${cells.toString()} intermediate tests (${middle.map((t) => t.toString()).join(', ')} months × ${rows.length} combinations); the schedule tests ${tested.toString()}`);
        else notes.push(`matrixing: ${tested.toString()} of ${cells.toString()} intermediate tests (${i.reduction} reduction)`);
        if (Math.max(...counts) - Math.min(...counts) > 1) problems.push('matrixing: the design is not balanced (combinations are tested at very different numbers of intermediate time points)');
        for (const t of middle) if (!rows.some((_, k) => (rowTimes[k] as Set<string>).has(key(t)))) problems.push(`matrixing: no combination is tested at ${t.toString()} months`);
      }
      if (i.variability === undefined) problems.push('matrixing: state the variability the supporting data show (small, moderate or large)');
      else if (i.variability === 'large') problems.push('matrixing: the supporting data show large variability; matrixing should not be applied');
      else if (i.variability === 'moderate' && i.statisticallyJustified !== true) problems.push('matrixing: with moderate variability the design needs a statistical justification');
    }

    const pass = problems.length === 0;
    const shown = `ICH Q1D ${i.design} design: ${pass ? 'PASS' : `FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'})`}${problems.length > 0 ? `: ${problems.join('; ')}` : ''}${notes.length > 0 ? `${problems.length > 0 ? '. Notes' : ''}: ${notes.join('; ')}` : ''}`;
    return { ok: true, value: d(problems.length), unit: '', shown, pass, problems, notes };
  });
}
