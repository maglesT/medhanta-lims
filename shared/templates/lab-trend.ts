/**
 * Lab calculation template, trends part (Medhanta LIMS library L18, plan 2.11, build step 8): the individuals and moving
 * range (I-MR) control chart of a series of results, with the eight Nelson rules (the Western Electric rules extended;
 * L. S. Nelson, Journal of Quality Technology 16 (1984), paraphrased) and the process capability against the
 * specification.
 *
 * Same rules as every template (README): inputs are text with units, exact decimals, a plain-English refusal, nothing
 * rounded inside the calculation. Fixed constants: d2 = 1.128 and D4 = 3.267 for moving ranges of two (ASTM E2587).
 */
import { checkLimit, type Limit } from './rounding.js';
import { Dec, fmt, parse, refuse, run, sameKind, shownNumber, to, ZERO, type Outcome, type Q } from './core.js';

const d = (x: string | number): Dec => new Dec(x);
/** σ estimated from the mean moving range of two: MR̄ ÷ d2. */
export const D2 = d('1.128');
/** Upper limit of the moving range chart: D4 × MR̄. */
export const D4 = d('3.267');

/** The eight rules, by number, in plain words (paraphrased). */
export const NELSON_RULES: Readonly<Record<number, string>> = {
  1: 'One point more than 3 sigma from the centre line',
  2: 'Nine points in a row on the same side of the centre line',
  3: 'Six points in a row steadily rising or steadily falling',
  4: 'Fourteen points in a row alternating up and down',
  5: 'Two of three points in a row more than 2 sigma from the centre line, on the same side',
  6: 'Four of five points in a row more than 1 sigma from the centre line, on the same side',
  7: 'Fifteen points in a row within 1 sigma of the centre line (on either side)',
  8: 'Eight points in a row more than 1 sigma from the centre line, on both sides',
};

export interface L18Input {
  /** The results in time order (oldest first), each with its unit; all of one kind (converted to the first's unit). */
  readonly points: readonly Q[];
  /**
   * How many of the first points set the centre line and sigma (default: all). A new result is judged against the
   * limits of the results before it: baseline = the number of earlier results.
   */
  readonly baseline?: number;
  /** The specification limit (drawn on the chart; Cpk and Ppk when it has both bounds). */
  readonly limit?: Limit;
  /** Display decimals in the worked line (default 3). */
  readonly decimals?: number;
}

/** One rule break: the rule, its words, and the points (1-based, in the order given) that make it. */
export interface RuleBreak { readonly rule: number; readonly text: string; readonly points: readonly number[] }

export interface L18Output {
  readonly n: number;
  readonly values: readonly Dec[];
  readonly mean: Dec;
  /** Mean moving range of the baseline, and sigma = MR̄ ÷ 1.128. */
  readonly mrBar: Dec;
  readonly sigma: Dec;
  /** The sample standard deviation of all the points (n − 1). */
  readonly sd: Dec;
  readonly min: Dec;
  readonly max: Dec;
  /** Control limits mean ± 3 sigma, and the 1 and 2 sigma zone lines. */
  readonly ucl: Dec;
  readonly lcl: Dec;
  readonly zones: { readonly plus1: Dec; readonly plus2: Dec; readonly minus1: Dec; readonly minus2: Dec };
  /** The moving ranges (point 2 onwards: |x(i) − x(i−1)|), their upper limit D4 × MR̄, and the points whose range is above it. */
  readonly movingRanges: readonly Dec[];
  readonly mrUcl: Dec;
  readonly mrBreaks: readonly number[];
  /** The specification bounds in the points' unit (null when not given). */
  readonly specLow: Dec | null;
  readonly specHigh: Dec | null;
  /** Process capability: Cpk = min(USL − mean, mean − LSL) ÷ 3 sigma; Ppk the same with the standard deviation. Two-sided limits only. */
  readonly cpk: Dec | null;
  readonly ppk: Dec | null;
  /** Every rule break (overlapping windows of one rule joined). */
  readonly breaks: readonly RuleBreak[];
  /** The rules a break of which includes the last point (a new result breaking a rule: out of trend). */
  readonly lastPoint: readonly number[];
  /** The last point outside the specification (the OOS, not a trend). */
  readonly lastOutOfSpec: boolean;
}

type Window = { from: number; to: number; points: number[] };

/** The eight rules over the values with the centre line and sigma given. Points are 0-based here. */
function nelson(x: readonly Dec[], mean: Dec, sigma: Dec): RuleBreak[] {
  const n = x.length;
  const z = x.map((v) => v.minus(mean).div(sigma)); // distance from the centre line in sigma
  const side = z.map((v) => (v.gt(0) ? 1 : v.lt(0) ? -1 : 0));
  const out: Record<number, Window[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [] };
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  for (let i = 0; i < n; i++) {
    // 1: beyond 3 sigma.
    if (z[i]!.abs().gt(3)) out[1]!.push({ from: i, to: i, points: [i] });
    // 2: nine in a row on one side (a point on the centre line is on neither).
    if (i >= 8) {
      const s = side.slice(i - 8, i + 1);
      if (s[0] !== 0 && s.every((v) => v === s[0])) out[2]!.push({ from: i - 8, to: i, points: range(i - 8, i) });
    }
    // 3: six in a row rising (five rises) or falling (five falls); equal neighbours break it.
    if (i >= 5) {
      const w = range(i - 5, i);
      const up = w.slice(1).every((k) => x[k]!.gt(x[k - 1]!));
      const down = w.slice(1).every((k) => x[k]!.lt(x[k - 1]!));
      if (up || down) out[3]!.push({ from: i - 5, to: i, points: w });
    }
    // 4: fourteen in a row alternating (thirteen changes, each the other way to the one before).
    if (i >= 13) {
      const w = range(i - 13, i);
      const dir = w.slice(1).map((k) => x[k]!.cmp(x[k - 1]!));
      if (dir.every((v, k) => v !== 0 && (k === 0 || v === -dir[k - 1]!))) out[4]!.push({ from: i - 13, to: i, points: w });
    }
    // 5: two of three beyond 2 sigma on the same side; the points beyond make it.
    if (i >= 2) for (const s of [1, -1]) {
      const beyond = range(i - 2, i).filter((k) => z[k]!.times(s).gt(2));
      if (beyond.length >= 2) out[5]!.push({ from: i - 2, to: i, points: beyond });
    }
    // 6: four of five beyond 1 sigma on the same side; the points beyond make it.
    if (i >= 4) for (const s of [1, -1]) {
      const beyond = range(i - 4, i).filter((k) => z[k]!.times(s).gt(1));
      if (beyond.length >= 4) out[6]!.push({ from: i - 4, to: i, points: beyond });
    }
    // 7: fifteen in a row within 1 sigma (on the line counts as within).
    if (i >= 14 && range(i - 14, i).every((k) => z[k]!.abs().lte(1))) out[7]!.push({ from: i - 14, to: i, points: range(i - 14, i) });
    // 8: eight in a row beyond 1 sigma, some above and some below.
    if (i >= 7) {
      const w = range(i - 7, i);
      if (w.every((k) => z[k]!.abs().gt(1)) && w.some((k) => side[k] === 1) && w.some((k) => side[k] === -1)) out[8]!.push({ from: i - 7, to: i, points: w });
    }
  }
  // Overlapping windows of one rule are one break (a long run is one finding, with all its points).
  const breaks: RuleBreak[] = [];
  for (let rule = 1; rule <= 8; rule++) {
    let cur: Window | null = null;
    const flush = () => { if (cur) breaks.push({ rule, text: NELSON_RULES[rule]!, points: [...new Set(cur.points)].sort((a, b) => a - b).map((k) => k + 1) }); };
    for (const w of out[rule]!) {
      if (cur && w.from <= cur.to) cur = { from: cur.from, to: Math.max(cur.to, w.to), points: [...cur.points, ...w.points] };
      else { flush(); cur = { ...w, points: [...w.points] }; }
    }
    flush();
  }
  return breaks;
}

// ================================================================ L18 control chart
export function l18ControlChart(i: L18Input): Outcome<L18Output> {
  return run(() => {
    if (!Array.isArray(i.points) || i.points.length < 2) refuse('A control chart needs at least two results (one moving range)');
    const ps = i.points.map((q, k) => parse(q, `Result ${k + 1}`));
    sameKind(ps, 'The results');
    const unit = ps[0]!.unit;
    const x = ps.map((p) => to(p, unit));
    const n = x.length;
    const base = i.baseline ?? n;
    if (!Number.isInteger(base) || base < 2 || base > n) refuse(`The baseline is the number of first results that set the limits: a whole number from 2 to ${n}, not ${String(i.baseline)}`);
    const b = x.slice(0, base);
    const mean = b.reduce((s, v) => s.plus(v), ZERO).div(base);
    const movingRanges = x.slice(1).map((v, k) => v.minus(x[k]!).abs());
    const mrBar = movingRanges.slice(0, base - 1).reduce((s, v) => s.plus(v), ZERO).div(base - 1);
    if (mrBar.isZero()) refuse(`The ${base === n ? '' : `first ${base} `}results do not vary (every moving range is 0): there are no control limits to draw`);
    const sigma = mrBar.div(D2);
    const mrUcl = D4.times(mrBar);
    const allMean = x.reduce((s, v) => s.plus(v), ZERO).div(n);
    const sd = x.reduce((s, v) => s.plus(v.minus(allMean).pow(2)), ZERO).div(n - 1).sqrt();
    const at = (k: number) => mean.plus(sigma.times(k));
    // The specification bounds in the results' unit.
    const bound = (v: string | undefined, what: string) => (v === undefined ? null : to(parse(`${v} ${i.limit!.unit}`.trim(), what), unit));
    const specLow = i.limit ? bound(i.limit.low, 'The lower specification limit') : null;
    const specHigh = i.limit ? bound(i.limit.high, 'The upper specification limit') : null;
    if (specLow && specHigh && !specHigh.gt(specLow)) refuse('The upper specification limit must be above the lower one');
    const two = specLow !== null && specHigh !== null;
    const cap = (s: Dec) => (two ? Dec.min(specHigh!.minus(allMean), allMean.minus(specLow!)).div(s.times(3)) : null);
    const breaks = nelson(x, mean, sigma);
    const last = n;
    const lastPoint = [...new Set(breaks.filter((r) => r.points.includes(last)).map((r) => r.rule))].sort((a, c) => a - c);
    const lastOutOfSpec = i.limit ? checkLimit(x[n - 1]!, unit.symbol, i.limit).pass === false : false;
    const dp = i.decimals ?? 3;
    const u = unit.symbol ? ` ${unit.symbol}` : '';
    const shown = `Individuals chart of ${n} results: centre line ${fmt(mean, dp)}${u}${base < n ? ` (first ${base} results)` : ''}, sigma = MR̄ ${shownNumber(mrBar, unit.symbol)} ÷ 1.128 = ${fmt(sigma, dp + 1)}${u}, `
      + `control limits ${fmt(at(-3), dp)} to ${fmt(at(3), dp)}${u}; ${breaks.length ? `${breaks.length} rule break${breaks.length === 1 ? '' : 's'} (${[...new Set(breaks.map((r) => r.rule))].map((r) => `rule ${r}`).join(', ')})` : 'no Nelson rule broken'}`;
    return {
      ok: true, value: mean, unit: unit.symbol, shown, n, values: x, mean, mrBar, sigma, sd, min: Dec.min(...x), max: Dec.max(...x),
      ucl: at(3), lcl: at(-3), zones: { plus1: at(1), plus2: at(2), minus1: at(-1), minus2: at(-2) },
      movingRanges, mrUcl, mrBreaks: movingRanges.flatMap((r, k) => (r.gt(mrUcl) ? [k + 2] : [])),
      specLow, specHigh, cpk: cap(sigma), ppk: sd.isZero() ? null : cap(sd), breaks, lastPoint, lastOutOfSpec,
    };
  });
}
