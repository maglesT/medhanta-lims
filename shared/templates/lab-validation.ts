/**
 * Lab calculation templates, method validation (Medhanta LIMS plan 2.12; library L16 "method validation statistics",
 * ICH Q2(R2); USP <1225>, <1226> and <1224> as the standard practice): L27 linearity, L28 accuracy, L29 precision,
 * L30 detection and quantitation limits, L31 range, L32 robustness, L33 method transfer comparison, L34 specificity.
 *
 * Same rules as every template (README): inputs are text with units, exact decimals, a plain-English refusal, nothing
 * rounded inside a calculation; pharmacopoeia rounding only when a limit is checked. The acceptance criteria are the
 * validation protocol's settings (limits), never formulas. Guideline rules are paraphrased; no guideline text is copied.
 * Student t quantiles come from lab-physchem.ts (L14).
 */
import { checkOf, Dec, fmt, given, HUNDRED, needKind, ONE, parse, refuse, run, sameKind, show, to, ZERO, type Outcome, type Parsed, type Q } from './core.js';
import { checkLimit, type Check, type Limit } from './rounding.js';
import { readSeries, type Series } from './series.js';
import { tQuantile } from './lab-physchem.js';

const d = (x: string | number): Dec => new Dec(x);
const TEN = d(10);

// ================================================================ shared
interface Read { xs: Dec[]; unit: string; ps: Parsed[] }
function read(s: Series | undefined, what: string, least = 1): Read {
  if (!given(s)) refuse(`${what}: give the values`);
  const ps = readSeries(s, what);
  if (ps.length < least) refuse(`${what}: at least ${least} value${least === 1 ? '' : 's'} are needed, ${ps.length} given`);
  const u = ps[0]!.unit;
  return { xs: ps.map((p) => to(p, u)), unit: u.symbol, ps };
}
const meanOf = (xs: readonly Dec[]): Dec => xs.reduce((a, b) => a.plus(b), ZERO).div(xs.length);
const ssOf = (xs: readonly Dec[], m = meanOf(xs)): Dec => xs.reduce((a, x) => a.plus(x.minus(m).pow(2)), ZERO);
const sdOf = (xs: readonly Dec[]): Dec => ssOf(xs).div(xs.length - 1).sqrt();
const rsdOf = (xs: readonly Dec[]): Dec => {
  const m = meanOf(xs);
  if (m.isZero()) refuse('A % RSD needs a mean other than zero');
  return sdOf(xs).div(m.abs()).times(HUNDRED);
};
/** A check made by a rule rather than a limit (a yes/no answer, a range that must cover another). */
const verdict = (pass: boolean, shown: string): Check => ({ pass, level: pass ? 'pass' : 'fail', rounded: '', shown });
/** One check standing for several (each labelled): the first failure, else the first alert, else the last. */
function worst(checks: readonly { label: string; check: Check }[]): Check | undefined {
  const c = checks.find((x) => !x.check.pass) ?? checks.find((x) => x.check.level === 'alert') ?? checks.at(-1);
  return c && { ...c.check, shown: `${c.label}: ${c.check.shown}` };
}
/** A percentage written "80", "80 %" or "80 %w/w", as a plain number of percent. */
function pct(q: Q, what: string): Dec {
  const p = parse(q, what);
  if (p.unit.kind === 'number') return p.v;
  needKind(p, ['fraction'], what);
  return to(p, '%');
}

/** Least squares of y on x: the line, r, the residuals and the standard errors (n − 2 degrees of freedom). */
export interface Fit {
  readonly n: number; readonly xbar: Dec; readonly sxx: Dec; readonly slope: Dec; readonly intercept: Dec; readonly r: Dec;
  readonly residuals: readonly Dec[]; readonly residualSd: Dec; readonly interceptSd: Dec; readonly slopeSd: Dec;
}
export function leastSquares(xs: readonly Dec[], ys: readonly Dec[]): Fit {
  const n = xs.length;
  if (n !== ys.length) refuse(`Give one response per level: ${n} levels and ${ys.length} responses`);
  if (n < 3) refuse('A straight line needs at least 3 points');
  const xbar = meanOf(xs);
  const ybar = meanOf(ys);
  const sxx = ssOf(xs, xbar);
  const syy = ssOf(ys, ybar);
  const sxy = xs.reduce((a, x, k) => a.plus(x.minus(xbar).times(ys[k]!.minus(ybar))), ZERO);
  if (sxx.isZero()) refuse('All levels are the same: a line needs different levels');
  if (syy.isZero()) refuse('All responses are the same: the response does not follow the level');
  const slope = sxy.div(sxx);
  const intercept = ybar.minus(slope.times(xbar));
  const r = sxy.div(sxx.times(syy).sqrt());
  const residuals = xs.map((x, k) => ys[k]!.minus(intercept.plus(slope.times(x))));
  const residualSd = residuals.reduce((a, e) => a.plus(e.pow(2)), ZERO).div(n - 2).sqrt();
  return { n, xbar, sxx, slope, intercept, r, residuals, residualSd,
    interceptSd: residualSd.times(ONE.div(n).plus(xbar.pow(2).div(sxx)).sqrt()), slopeSd: residualSd.div(sxx.sqrt()) };
}

// ================================================================ L27 Linearity (response)
/**
 * L27 Linearity: least squares of the responses on the levels (at least 5 levels, ICH Q2(R2)); slope, intercept,
 * r and r², the residuals, the residual SD, the SD of the intercept, and the y-intercept as % of the response at the
 * 100 % level (intercept ÷ (slope × the 100 % level + intercept) × 100). Levels in % are % of the test concentration;
 * otherwise the 100 % level is given (`target`). Log scale: log10 response on log10 level (no intercept %).
 * The value is r, checked against `limit` (e.g. NLT 0.999); r² and the intercept % have their own limits.
 */
export interface L27Input {
  readonly x: Series;
  readonly y: Series;
  readonly target?: Q;
  readonly scale?: 'linear' | 'log';
  readonly limit?: Limit;
  readonly r2Limit?: Limit;
  readonly interceptLimit?: Limit;
  readonly decimals?: number;
}
export interface L27Extra {
  readonly n: number; readonly levels: number; readonly slope: Dec; readonly intercept: Dec; readonly r: Dec; readonly r2: Dec;
  readonly residuals: readonly Dec[]; readonly residualSd: Dec; readonly interceptSd: Dec; readonly slopeSd: Dec;
  readonly interceptPercent?: Dec; readonly low?: Dec; readonly high?: Dec; readonly xUnit: string;
  readonly r2Check?: Check; readonly interceptCheck?: Check;
}

/** The levels as % of the 100 % level: as written when in %, else ÷ the 100 % level × 100 (undefined without it). */
function levelPercents(x: Read, target: Q | undefined, what: string): Dec[] | undefined {
  if (x.ps[0]!.unit.kind === 'fraction') return x.ps.map((p) => to(p, '%'));
  if (target === undefined) return undefined;
  const t = parse(target, 'The 100 % level');
  sameKind([x.ps[0]!, t], `${what} and the 100 % level`);
  if (!t.v.isPositive() || t.v.isZero()) refuse('The 100 % level must be more than zero');
  return x.ps.map((p) => to(p, t.unit).div(t.v).times(HUNDRED));
}

export function l27Linearity(i: L27Input): Outcome<L27Extra> {
  return run(() => {
    const dp = i.decimals ?? 4;
    const x = read(i.x, 'Level', 3);
    const y = read(i.y, 'Response', 3);
    const levels = new Set(x.xs.map((v) => v.toString())).size;
    if (levels < 5) refuse(`Linearity needs at least 5 levels (ICH Q2); ${levels} given`);
    const log = i.scale === 'log';
    if (log && [...x.xs, ...y.xs].some((v) => !v.isPositive() || v.isZero())) refuse('On a log scale every level and response must be more than zero');
    const f = leastSquares(log ? x.xs.map((v) => v.log(10)) : x.xs, log ? y.xs.map((v) => v.log(10)) : y.xs);
    const r2 = f.r.pow(2);
    const p = levelPercents(x, i.target, 'The levels');
    let interceptPercent: Dec | undefined;
    if (!log && p !== undefined) {
      const x100 = x.ps[0]!.unit.kind === 'fraction' ? HUNDRED : to(parse(i.target!, 'The 100 % level'), x.ps[0]!.unit);
      const at100 = f.slope.times(x100).plus(f.intercept);
      if (at100.isZero()) refuse('The response at the 100 % level is zero');
      interceptPercent = f.intercept.div(at100).times(HUNDRED);
    }
    if (i.interceptLimit !== undefined && interceptPercent === undefined) {
      refuse(log ? 'The intercept as % of the 100 % response is not used on a log scale' : 'Give the 100 % level (the test concentration) to check the intercept as % of the 100 % response');
    }
    const low = p && Dec.min(...p);
    const high = p && Dec.max(...p);
    const xu = x.unit;
    const parts = [`${log ? 'log10 response on log10 level' : 'least squares'}, n = ${f.n} (${levels} levels${low && high ? `, ${fmt(low, 1)} to ${fmt(high, 1)} %` : ''})`,
      `slope = ${fmt(f.slope, dp + 2)}`, `intercept = ${fmt(f.intercept, dp)}`, `r = ${fmt(f.r, 5)}`, `r² = ${fmt(r2, 5)}`,
      `residual SD = ${fmt(f.residualSd, dp)}`, `SD of the intercept = ${fmt(f.interceptSd, dp)}`,
      ...(interceptPercent ? [`y-intercept = ${fmt(interceptPercent, 2)} % of the response at 100 %`] : []),
      `largest residual ${fmt(f.residuals.reduce((a, e) => (e.abs().gt(a.abs()) ? e : a), ZERO), dp)}`];
    return {
      ok: true, value: f.r, unit: '', shown: parts.join('; '), n: f.n, levels, slope: f.slope, intercept: f.intercept, r: f.r, r2,
      residuals: f.residuals, residualSd: f.residualSd, interceptSd: f.interceptSd, slopeSd: f.slopeSd, xUnit: xu,
      ...(interceptPercent ? { interceptPercent } : {}), ...(low && high ? { low, high } : {}),
      ...(i.r2Limit ? { r2Check: checkLimit(r2, '', i.r2Limit) } : {}),
      ...(i.interceptLimit && interceptPercent ? { interceptCheck: checkLimit(interceptPercent, '%', i.interceptLimit) } : {}),
      ...checkOf(f.r, '', i.limit),
    };
  });
}

// ================================================================ L28 Accuracy (recovery)
/**
 * L28 Accuracy: per level (% of the test concentration, or of the specification limit for an impurity) the recovery
 * of each determination, found ÷ added × 100; by standard addition (spiked − mean unspiked) ÷ added × 100. The mean
 * recovery per level with its % RSD, and over all determinations the mean recovery with its confidence interval
 * x̄ ± t(1 − α/2; N − 1) × s ÷ √N (95 % unless set). ICH Q2(R2) asks at least 9 determinations over at least 3 levels
 * (said in the worked line when fewer). Limits: the mean recovery (`limit`), each level's mean (`levelLimit`), both
 * ends of the interval (`ciLimit`), each level's % RSD (`rsdLimit`).
 */
export interface L28Level { readonly level: Q; readonly added: Series; readonly found: Series; readonly unspiked?: Series }
export interface L28Input {
  readonly mode?: 'recovery' | 'standard addition';
  readonly levels: readonly L28Level[];
  readonly confidence?: string;
  readonly limit?: Limit;
  readonly levelLimit?: Limit;
  readonly ciLimit?: Limit;
  readonly rsdLimit?: Limit;
  readonly decimals?: number;
}
export interface L28Extra {
  readonly n: number; readonly sd: Dec; readonly rsd: Dec; readonly t: Dec; readonly ci: { readonly low: Dec; readonly high: Dec };
  readonly perLevel: readonly { readonly level: Dec; readonly n: number; readonly mean: Dec; readonly rsd?: Dec }[];
  readonly low: Dec; readonly high: Dec;
  readonly levelCheck?: Check; readonly ciCheck?: Check; readonly rsdCheck?: Check;
}
function confidence(text: string | undefined, dflt: string): { alpha: Dec; text: string } {
  const t = text ?? dflt;
  const c = d(t);
  if (!c.gt(50) || !c.lt(100)) refuse('The confidence level is a % between 50 and 100 (e.g. "95")');
  return { alpha: ONE.minus(c.div(HUNDRED)), text: t };
}

export function l28Accuracy(i: L28Input): Outcome<L28Extra> {
  return run(() => {
    const dp = i.decimals ?? 1;
    const addition = i.mode === 'standard addition';
    const levels = (i.levels ?? []).filter((l) => given(l.level));
    if (!levels.length) refuse('Give the recoveries of at least one level');
    const all: Dec[] = [];
    const lines: string[] = [];
    const perLevel = levels.map((l, k) => {
      const lv = pct(l.level, `Level ${k + 1}`);
      const added = read(l.added, `Level ${fmt(lv, 0)} %: amount added`);
      const found = read(l.found, `Level ${fmt(lv, 0)} %: amount found`);
      if (added.xs.length !== found.xs.length) refuse(`Level ${fmt(lv, 0)} %: give one amount found for each amount added (${added.xs.length} added, ${found.xs.length} found)`);
      sameKind([added.ps[0]!, found.ps[0]!], `Level ${fmt(lv, 0)} %: amounts added and found`);
      let base = ZERO;
      if (addition) {
        if (!given(l.unspiked)) refuse(`Level ${fmt(lv, 0)} %: standard addition needs the unspiked results`);
        const u = read(l.unspiked, `Level ${fmt(lv, 0)} %: unspiked`);
        sameKind([found.ps[0]!, u.ps[0]!], `Level ${fmt(lv, 0)} %: found and unspiked`);
        base = meanOf(u.ps.map((p) => to(p, found.ps[0]!.unit)));
      }
      const rec = found.ps.map((f, j) => {
        const a = to(added.ps[j]!, found.ps[0]!.unit);
        if (!a.isPositive() || a.isZero()) refuse(`Level ${fmt(lv, 0)} %: an amount added must be more than zero`);
        return to(f, found.ps[0]!.unit).minus(base).div(a).times(HUNDRED);
      });
      all.push(...rec);
      const mean = meanOf(rec);
      const rsd = rec.length > 1 && !mean.isZero() ? rsdOf(rec) : undefined;
      lines.push(`${fmt(lv, 0)} %: ${rec.map((r) => fmt(r, dp + 1)).join(', ')} (mean ${fmt(mean, dp + 1)} %${rsd ? `, RSD ${fmt(rsd, 2)} %` : ''})`);
      return { level: lv, n: rec.length, mean, ...(rsd ? { rsd } : {}) };
    });
    const n = all.length;
    if (n < 2) refuse('Accuracy needs at least two determinations');
    const mean = meanOf(all);
    const sd = sdOf(all);
    const rsd = sd.div(mean.abs()).times(HUNDRED);
    const { alpha, text } = confidence(i.confidence, '95');
    const t = tQuantile(ONE.minus(alpha.div(2)), d(n - 1));
    const half = t.times(sd).div(d(n).sqrt());
    const ci = { low: mean.minus(half), high: mean.plus(half) };
    const low = Dec.min(...perLevel.map((l) => l.level));
    const high = Dec.max(...perLevel.map((l) => l.level));
    const few = perLevel.length < 3 || n < 9 ? '; fewer than the 9 determinations over 3 levels ICH Q2 asks' : '';
    const shown = `${addition ? '(spiked − unspiked) ÷ added × 100' : 'found ÷ added × 100'}: ${lines.join('; ')}; all ${n}: mean recovery ${fmt(mean, dp + 1)} %, SD ${fmt(sd, dp + 2)}, `
      + `${text} % CI ${fmt(ci.low, dp + 1)} to ${fmt(ci.high, dp + 1)} % (t = ${fmt(t, 4)})${few}`;
    const each = (lim: Limit | undefined, v: (l: typeof perLevel[number]) => Dec | undefined, unit = '%') => (lim
      ? worst(perLevel.flatMap((l) => { const x = v(l); return x === undefined ? [] : [{ label: `level ${fmt(l.level, 0)} %`, check: checkLimit(x, unit, lim) }]; }))
      : undefined);
    const levelCheck = each(i.levelLimit, (l) => l.mean);
    const rsdCheck = each(i.rsdLimit, (l) => l.rsd);
    const ciCheck = i.ciLimit ? worst([{ label: 'lower end of the interval', check: checkLimit(ci.low, '%', i.ciLimit) }, { label: 'upper end of the interval', check: checkLimit(ci.high, '%', i.ciLimit) }]) : undefined;
    return {
      ok: true, value: mean, unit: '%', shown, n, sd, rsd, t, ci, perLevel, low, high,
      ...(levelCheck ? { levelCheck } : {}), ...(ciCheck ? { ciCheck } : {}), ...(rsdCheck ? { rsdCheck } : {}), ...checkOf(mean, '%', i.limit),
    };
  });
}

// ================================================================ L29 Precision
/**
 * L29 Precision.
 * - repeatability: the % RSD of the determinations (ICH Q2: 6 at 100 % or 9 over the range).
 * - intermediate precision: the runs (days, analysts, instruments) as groups, by one-way analysis of variance:
 *   MS within = Σ (nᵢ − 1) sᵢ² ÷ (N − k); MS between = Σ nᵢ (x̄ᵢ − x̄)² ÷ (k − 1); n₀ = (N − Σ nᵢ² ÷ N) ÷ (k − 1);
 *   s²(repeatability) = MS within; s²(between) = (MS between − MS within) ÷ n₀, or 0 when negative;
 *   s²(intermediate) = s²(repeatability) + s²(between); each as % RSD of the grand mean. The value is the
 *   intermediate precision % RSD; the repeatability % RSD and the largest difference between the run means (as % of
 *   the grand mean) have their own limits.
 */
export type L29Input = { readonly limit?: Limit; readonly decimals?: number } & (
  | { readonly mode: 'repeatability'; readonly readings: Series }
  | { readonly mode: 'intermediate precision'; readonly groups: readonly Series[]; readonly repeatabilityLimit?: Limit; readonly differenceLimit?: Limit }
);
export interface L29Extra {
  readonly n: number; readonly mean: Dec; readonly sd: Dec; readonly rsd: Dec;
  readonly groups?: number; readonly groupMeans?: readonly Dec[]; readonly msWithin?: Dec; readonly msBetween?: Dec;
  readonly rsdRepeatability?: Dec; readonly rsdBetween?: Dec; readonly difference?: Dec;
  readonly repeatabilityCheck?: Check; readonly differenceCheck?: Check;
}
export function l29Precision(i: L29Input): Outcome<L29Extra> {
  return run(() => {
    const dp = i.decimals ?? 2;
    if (i.mode === 'repeatability') {
      const r = read(i.readings, 'Result', 2);
      const mean = meanOf(r.xs);
      const sd = sdOf(r.xs);
      const rsd = rsdOf(r.xs);
      const few = r.xs.length < 6 ? '; fewer than the 6 determinations ICH Q2 asks' : '';
      return { ok: true, value: rsd, unit: '%', n: r.xs.length, mean, sd, rsd,
        shown: `n = ${r.xs.length}, mean ${show(mean, r.unit, dp + 1)}, SD ${fmt(sd, dp + 2)}, repeatability RSD = ${fmt(rsd, 2)} %${few}`, ...checkOf(rsd, '%', i.limit) };
    }
    const groups = (i.groups ?? []).filter((g) => given(g)).map((g, k) => read(g, `Run ${k + 1}`, 2));
    if (groups.length < 2) refuse('Intermediate precision needs at least 2 runs (days, analysts or instruments), each with at least 2 results');
    const unit = groups[0]!.ps[0]!.unit;
    sameKind(groups.map((g) => g.ps[0]!), 'The runs');
    const gx = groups.map((g) => g.ps.map((p) => to(p, unit)));
    const k = gx.length;
    const N = gx.reduce((a, g) => a + g.length, 0);
    const all = gx.flat();
    const grand = meanOf(all);
    if (grand.isZero()) refuse('A % RSD needs a mean other than zero');
    const means = gx.map((g) => meanOf(g));
    const msWithin = gx.reduce((a, g) => a.plus(ssOf(g)), ZERO).div(N - k);
    const msBetween = gx.reduce((a, g, j) => a.plus(d(g.length).times(means[j]!.minus(grand).pow(2))), ZERO).div(k - 1);
    const n0 = d(N).minus(gx.reduce((a, g) => a.plus(d(g.length).pow(2)), ZERO).div(N)).div(k - 1);
    const sBetween2 = Dec.max(ZERO, msBetween.minus(msWithin).div(n0));
    const sIp = msWithin.plus(sBetween2).sqrt();
    const pctOf = (s: Dec) => s.div(grand.abs()).times(HUNDRED);
    const rsdRepeatability = pctOf(msWithin.sqrt());
    const rsdBetween = pctOf(sBetween2.sqrt());
    const rsd = pctOf(sIp);
    const difference = Dec.max(...means).minus(Dec.min(...means)).div(grand.abs()).times(HUNDRED);
    const shown = `${k} runs, N = ${N}: run means ${means.map((m) => fmt(m, dp + 1)).join(', ')}; grand mean ${show(grand, unit.symbol, dp + 1)}; `
      + `MS within ${fmt(msWithin, dp + 3)}, MS between ${fmt(msBetween, dp + 3)} (n₀ = ${fmt(n0, 2)}); `
      + `RSD repeatability ${fmt(rsdRepeatability, 2)} %, between runs ${fmt(rsdBetween, 2)} %, intermediate precision ${fmt(rsd, 2)} %; `
      + `largest difference between run means ${fmt(difference, 2)} % of the grand mean`;
    return {
      ok: true, value: rsd, unit: '%', shown, n: N, mean: grand, sd: sIp, rsd, groups: k, groupMeans: means, msWithin, msBetween, rsdRepeatability, rsdBetween, difference,
      ...(i.repeatabilityLimit ? { repeatabilityCheck: checkLimit(rsdRepeatability, '%', i.repeatabilityLimit) } : {}),
      ...(i.differenceLimit ? { differenceCheck: checkLimit(difference, '%', i.differenceLimit) } : {}),
      ...checkOf(rsd, '%', i.limit),
    };
  });
}

// ================================================================ L30 Detection and quantitation limits
/**
 * L30 Detection limit (DL) and quantitation limit (QL).
 * - calibration: DL = 3.3 σ ÷ S and QL = 10 σ ÷ S, S the slope of a calibration line in the low range, σ from the
 *   source the protocol fixes: the residual SD of that line, the SD of its y-intercept, or the SD of blank responses
 *   (the source changes the answer, so it is a setting). The value is the QL (in the levels' unit), checked against
 *   `limit` (e.g. NMT the reporting threshold); the DL against `lodLimit`.
 * - signal to noise: S/N = 2H ÷ h (H the peak height, h the peak-to-peak noise of a blank) at the level tested, against
 *   NLT 3 for the DL and NLT 10 for the QL unless the protocol sets its own `limit`; optionally the precision of
 *   replicate results at the QL (`rsdLimit`).
 */
export type L30Input = { readonly lodLimit?: Limit; readonly limit?: Limit; readonly decimals?: number } & (
  | { readonly mode: 'calibration'; readonly x: Series; readonly y: Series; readonly sigma: 'residual SD' | 'intercept SD' | 'blank SD'; readonly blanks?: Series }
  | { readonly mode: 'signal to noise'; readonly level: 'detection limit' | 'quantitation limit'; readonly concentration: Q; readonly signal: Q; readonly noise: Q;
      readonly readings?: Series; readonly rsdLimit?: Limit }
);
export interface L30Extra {
  readonly lod?: Dec; readonly loq?: Dec; readonly sigma?: Dec; readonly slope?: Dec; readonly sn?: Dec; readonly xUnit: string;
  readonly lodCheck?: Check; readonly rsdCheck?: Check;
}
export function l30DetectionLimits(i: L30Input): Outcome<L30Extra> {
  return run(() => {
    const dp = i.decimals ?? 3;
    if (i.mode === 'calibration') {
      const x = read(i.x, 'Level', 3);
      const y = read(i.y, 'Response', 3);
      const f = leastSquares(x.xs, y.xs);
      if (!f.slope.isPositive()) refuse('The slope of the calibration line must be more than zero');
      let sigma: Dec;
      if (i.sigma === 'residual SD') sigma = f.residualSd;
      else if (i.sigma === 'intercept SD') sigma = f.interceptSd;
      else if (i.sigma === 'blank SD') sigma = sdOf(read(i.blanks, 'Blank response', 2).xs);
      else refuse('Say which σ the protocol uses: residual SD, intercept SD or blank SD');
      const lod = d('3.3').times(sigma).div(f.slope);
      const loq = TEN.times(sigma).div(f.slope);
      const u = x.unit;
      const shown = `slope S = ${fmt(f.slope, dp + 3)}, σ (${i.sigma}) = ${fmt(sigma, dp + 1)}; DL = 3.3 × ${fmt(sigma, dp + 1)} ÷ ${fmt(f.slope, dp + 3)} = ${show(lod, u, dp)}; `
        + `QL = 10 × ${fmt(sigma, dp + 1)} ÷ ${fmt(f.slope, dp + 3)} = ${show(loq, u, dp)}`;
      return { ok: true, value: loq, unit: u, shown, lod, loq, sigma, slope: f.slope, xUnit: u,
        ...(i.lodLimit ? { lodCheck: checkLimit(lod, u, i.lodLimit) } : {}), ...checkOf(loq, u, i.limit) };
    }
    const c = parse(i.concentration, 'The level tested');
    const H = parse(i.signal, 'The peak height');
    const h = parse(i.noise, 'The noise');
    sameKind([H, h], 'Peak height and noise');
    if (!h.v.isPositive() || h.v.isZero()) refuse('The noise must be more than zero');
    const sn = d(2).times(H.v).div(to(h, H.unit));
    const ql = i.level === 'quantitation limit';
    const lim: Limit = i.limit ?? { low: ql ? '10' : '3', unit: '' };
    let rsdCheck: Check | undefined;
    let precision = '';
    if (given(i.readings)) {
      const r = read(i.readings, 'Result at the level', 2);
      const rsd = rsdOf(r.xs);
      precision = `; ${r.xs.length} results at ${c.text}: RSD ${fmt(rsd, 2)} %`;
      if (i.rsdLimit) rsdCheck = checkLimit(rsd, '%', i.rsdLimit);
    }
    const shown = `S/N = 2 × ${H.text} ÷ ${h.text} = ${fmt(sn, 1)} at ${c.text} (${ql ? 'quantitation' : 'detection'} limit)${precision}`;
    return { ok: true, value: sn, unit: '', shown, sn, xUnit: c.unit.symbol, ...(ql ? { loq: c.v } : { lod: c.v }), ...(rsdCheck ? { rsdCheck } : {}),
      check: checkLimit(sn, '', lim) };
  });
}

// ================================================================ L31 Range
/**
 * L31 Range: the range validated is where linearity, accuracy and precision were all met: from the higher of the
 * lowest linearity and accuracy levels to the lower of their highest levels (% of the test concentration, or of the
 * specification limit for an impurity). It must cover the range the use requires (ICH Q2(R2) Table 2): assay 80 to
 * 120 %; content uniformity 70 to 130 %; dissolution Q − 45 % to 130 %; an impurity from the reporting threshold
 * to 120 % of its limit; or as the protocol writes it.
 */
export interface L31Input {
  readonly use: 'assay' | 'content uniformity' | 'dissolution' | 'impurity' | 'as written';
  readonly q?: Q;
  readonly reportingThreshold?: Q;
  readonly specLimit?: Q;
  readonly low?: Q;
  readonly high?: Q;
  readonly linearity: { readonly low: Q; readonly high: Q; readonly met: boolean };
  readonly accuracy: { readonly low: Q; readonly high: Q; readonly met: boolean };
  readonly precision: { readonly met: boolean };
}
export function requiredRange(i: Pick<L31Input, 'use' | 'q' | 'reportingThreshold' | 'specLimit' | 'low' | 'high'>): { low: Dec; high: Dec; why: string } {
  switch (i.use) {
    case 'assay': return { low: d(80), high: d(120), why: 'assay: 80 to 120 %' };
    case 'content uniformity': return { low: d(70), high: d(130), why: 'content uniformity: 70 to 130 %' };
    case 'dissolution': {
      if (i.q === undefined) refuse('Give Q of the dissolution test (e.g. "80 %")');
      const q = pct(i.q, 'Q');
      return { low: q.minus(45), high: d(130), why: `dissolution: Q − 45 % (Q = ${fmt(q, 0)} %) to 130 %` };
    }
    case 'impurity': {
      if (i.reportingThreshold === undefined || i.specLimit === undefined) refuse('Give the reporting threshold and the impurity\'s specification limit (both in %)');
      const rt = pct(i.reportingThreshold, 'The reporting threshold');
      const lim = pct(i.specLimit, 'The specification limit');
      if (!lim.isPositive() || lim.isZero()) refuse('The specification limit must be more than zero');
      return { low: rt.div(lim).times(HUNDRED), high: d(120), why: `impurity: the reporting threshold ${fmt(rt, 2)} % (${fmt(rt.div(lim).times(HUNDRED), 1)} % of the limit ${fmt(lim, 2)} %) to 120 % of the limit` };
    }
    case 'as written': {
      if (i.low === undefined || i.high === undefined) refuse('Give the range the protocol requires (low and high, in %)');
      return { low: pct(i.low, 'The low end'), high: pct(i.high, 'The high end'), why: 'as the protocol writes it' };
    }
    default: return refuse('Say what the procedure is used for: assay, content uniformity, dissolution, impurity or as written');
  }
}
export function l31Range(i: L31Input): Outcome<{ readonly low: Dec; readonly high: Dec; readonly requiredLow: Dec; readonly requiredHigh: Dec }> {
  return run(() => {
    const req = requiredRange(i);
    const ll = pct(i.linearity.low, 'Linearity, lowest level');
    const lh = pct(i.linearity.high, 'Linearity, highest level');
    const al = pct(i.accuracy.low, 'Accuracy, lowest level');
    const ah = pct(i.accuracy.high, 'Accuracy, highest level');
    const low = Dec.max(ll, al);
    const high = Dec.min(lh, ah);
    const notMet = [...(i.linearity.met ? [] : ['linearity']), ...(i.accuracy.met ? [] : ['accuracy']), ...(i.precision.met ? [] : ['precision'])];
    const covers = notMet.length === 0 && low.lte(req.low) && high.gte(req.high);
    const shown = `linearity ${fmt(ll, 0)} to ${fmt(lh, 0)} %, accuracy ${fmt(al, 0)} to ${fmt(ah, 0)} %: range ${fmt(low, 0)} to ${fmt(high, 0)} %; required (${req.why}) ${fmt(req.low, 0)} to ${fmt(req.high, 0)} %`;
    const why = notMet.length ? `not met: ${notMet.join(', ')} not met, so no range is validated` : covers ? 'the range covers it' : 'NOT COVERED: the levels do not reach the required range';
    return { ok: true, value: low, unit: '%', shown: `${shown}: ${why}`, low, high, requiredLow: req.low, requiredHigh: req.high, check: verdict(covers, why) };
  });
}

// ================================================================ L32 Robustness
/**
 * L32 Robustness: per deliberately varied factor (flow, column temperature, pH of the buffer, organic fraction, another
 * column lot …), the mean result against the mean at the nominal conditions, (varied − nominal) ÷ nominal × 100, and
 * whether system suitability was met at the varied condition. The value is the largest difference; `limit` is the
 * protocol's (e.g. NMT 2.0 %); every factor's system suitability must be met.
 */
export interface L32Input {
  readonly nominal: Series;
  readonly factors: readonly { readonly name: string; readonly results: Series; readonly suitability: string }[];
  readonly limit?: Limit;
  readonly decimals?: number;
}
export function l32Robustness(i: L32Input): Outcome<{ readonly factors: readonly { readonly name: string; readonly mean: Dec; readonly difference: Dec; readonly suitability: boolean }[]; readonly suitabilityCheck: Check }> {
  return run(() => {
    const dp = i.decimals ?? 2;
    const nominal = read(i.nominal, 'Result at the nominal conditions');
    const nm = meanOf(nominal.xs);
    if (nm.isZero()) refuse('The nominal mean is zero: a difference in % needs a mean other than zero');
    const fs = (i.factors ?? []).filter((f) => given(f.results)).map((f, k) => {
      if (!f.name?.trim()) refuse(`Factor ${k + 1}: name what was varied`);
      const r = read(f.results, `${f.name}: result`);
      sameKind([nominal.ps[0]!, r.ps[0]!], `${f.name} and the nominal results`);
      const mean = meanOf(r.ps.map((p) => to(p, nominal.ps[0]!.unit)));
      if (f.suitability !== 'yes' && f.suitability !== 'no') refuse(`${f.name}: answer whether system suitability was met (yes or no)`);
      return { name: f.name.trim(), mean, difference: mean.minus(nm).div(nm.abs()).times(HUNDRED), suitability: f.suitability === 'yes' };
    });
    if (!fs.length) refuse('Give the results of at least one varied factor');
    const largest = fs.reduce((a, f) => (f.difference.abs().gt(a.difference.abs()) ? f : a));
    const failedSst = fs.filter((f) => !f.suitability).map((f) => f.name);
    const shown = `nominal mean ${show(nm, nominal.unit, dp)}; ${fs.map((f) => `${f.name}: ${show(f.mean, nominal.unit, dp)} (${f.difference.isNegative() ? '' : '+'}${fmt(f.difference, 2)} %, system suitability ${f.suitability ? 'met' : 'NOT met'})`).join('; ')}`;
    return {
      ok: true, value: largest.difference.abs(), unit: '%', shown, factors: fs,
      suitabilityCheck: verdict(!failedSst.length, failedSst.length ? `system suitability not met at: ${failedSst.join(', ')}` : 'system suitability met at every varied condition'),
      ...(i.limit ? { check: { ...checkLimit(largest.difference.abs(), '%', i.limit), shown: `largest difference (${largest.name}): ${checkLimit(largest.difference.abs(), '%', i.limit).shown}` } } : {}),
    };
  });
}

// ================================================================ L33 Method transfer comparison
/**
 * L33 Transfer comparison (comparative testing, USP <1224>): the receiving laboratory's results on the same batches
 * against the sending laboratory's; the difference of the means (receiving − sending).
 * - equivalence (TOST): two one-sided t tests at 5 % each, i.e. the 90 % confidence interval of the difference
 *   (Welch-Satterthwaite degrees of freedom) lies within ± the acceptance margin.
 * - difference: the difference itself within ± the margin (the simple criterion of many transfer protocols).
 * The margin is the protocol's, in the results' unit (e.g. "2.0 %"); the receiving laboratory's % RSD may have a limit.
 */
export interface L33Input {
  readonly mode: 'equivalence (TOST)' | 'difference';
  readonly sending: Series;
  readonly receiving: Series;
  readonly margin: Q;
  readonly confidence?: string;
  readonly rsdLimit?: Limit;
  readonly decimals?: number;
}
export function l33TransferComparison(i: L33Input): Outcome<{ readonly meanSending: Dec; readonly meanReceiving: Dec; readonly ci?: { readonly low: Dec; readonly high: Dec }; readonly df?: Dec; readonly t?: Dec; readonly rsdReceiving: Dec; readonly rsdCheck?: Check }> {
  return run(() => {
    const dp = i.decimals ?? 2;
    const s = read(i.sending, 'Sending laboratory result', 2);
    const r = read(i.receiving, 'Receiving laboratory result', 2);
    sameKind([s.ps[0]!, r.ps[0]!], 'The two laboratories\' results');
    const m = parse(i.margin, 'The acceptance margin');
    sameKind([s.ps[0]!, m], 'The results and the acceptance margin');
    if (!m.v.isPositive() || m.v.isZero()) refuse('The acceptance margin must be more than zero');
    const u = s.ps[0]!.unit;
    const rx = r.ps.map((p) => to(p, u));
    const ms = meanOf(s.xs);
    const mr = meanOf(rx);
    const diff = mr.minus(ms);
    const theta = to(m, u);
    const written = (typeof i.margin === 'string' ? i.margin.trim().split(/\s+/)[0] : i.margin.value) ?? '';
    const marginLimit: Limit = { low: `-${written.replace(/^[+-]/, '')}`, high: written.replace(/^[+-]/, ''), unit: m.unit.symbol };
    const rsdReceiving = rsdOf(rx);
    const rsdCheck = i.rsdLimit ? checkLimit(rsdReceiving, '%', i.rsdLimit) : undefined;
    const head = `sending mean ${show(ms, u.symbol, dp)} (n = ${s.xs.length}), receiving mean ${show(mr, u.symbol, dp)} (n = ${rx.length}, RSD ${fmt(rsdReceiving, 2)} %); difference ${show(diff, u.symbol, dp)}`;
    if (i.mode === 'difference') {
      const check = checkLimit(diff, u, marginLimit);
      return { ok: true, value: diff, unit: u.symbol, shown: `${head}; margin ± ${m.text}`, meanSending: ms, meanReceiving: mr, rsdReceiving, check, ...(rsdCheck ? { rsdCheck } : {}) };
    }
    if (i.mode !== 'equivalence (TOST)') refuse('Say how the laboratories are compared: equivalence (TOST) or difference');
    const { alpha, text } = confidence(i.confidence, '90');
    const vs = sdOf(s.xs).pow(2).div(s.xs.length);
    const vr = sdOf(rx).pow(2).div(rx.length);
    const se = vs.plus(vr).sqrt();
    if (se.isZero()) refuse('Both laboratories\' results have no spread: the difference cannot be tested');
    const df = vs.plus(vr).pow(2).div(vs.pow(2).div(s.xs.length - 1).plus(vr.pow(2).div(rx.length - 1)));
    const t = tQuantile(ONE.minus(alpha.div(2)), df);
    const ci = { low: diff.minus(t.times(se)), high: diff.plus(t.times(se)) };
    const check = worst([{ label: 'lower end of the interval', check: checkLimit(ci.low, u, marginLimit) }, { label: 'upper end of the interval', check: checkLimit(ci.high, u, marginLimit) }])!;
    const inside = check.pass;
    const shown = `${head}; Welch df = ${fmt(df, 2)}, t = ${fmt(t, 4)}; ${text} % CI ${fmt(ci.low, dp)} to ${fmt(ci.high, dp)} within ± ${theta.toString()} ${u.symbol}: ${inside ? 'EQUIVALENT' : 'NOT shown equivalent'}`;
    return { ok: true, value: diff, unit: u.symbol, shown, meanSending: ms, meanReceiving: mr, ci, df, t, rsdReceiving, check, ...(rsdCheck ? { rsdCheck } : {}) };
  });
}

// ================================================================ L34 Specificity
/**
 * L34 Specificity: the responses at the analyte's position in the blank, the placebo and each known impurity or
 * degradant injected alone (0 when there is no peak), each as % of the analyte's response at 100 % (or at the
 * specification limit); the value is the largest, checked against `limit` (e.g. NMT 0.5 %). The resolution of the
 * closest pair against `resolutionLimit`, and peak purity of the stressed samples (yes/no) when the method is
 * stability-indicating.
 */
export interface L34Input {
  readonly standard: Q;
  readonly interferences: Series;
  readonly limit?: Limit;
  readonly resolution?: Q;
  readonly resolutionLimit?: Limit;
  readonly purity?: string;
}
export function l34Specificity(i: L34Input): Outcome<{ readonly interferences: readonly Dec[]; readonly resolutionCheck?: Check; readonly purityCheck?: Check }> {
  return run(() => {
    const std = parse(i.standard, 'The analyte\'s response');
    if (!std.v.isPositive() || std.v.isZero()) refuse('The analyte\'s response must be more than zero');
    const r = read(i.interferences, 'Response at the analyte\'s position');
    sameKind([std, r.ps[0]!], 'The responses');
    const ps = r.ps.map((p) => to(p, std.unit).div(std.v).times(HUNDRED));
    if (ps.some((p) => p.isNegative())) refuse('A response cannot be negative');
    const largest = Dec.max(...ps);
    let resolutionCheck: Check | undefined;
    if (i.resolutionLimit) {
      if (i.resolution === undefined) refuse('Give the resolution of the closest pair');
      resolutionCheck = checkLimit(parse(i.resolution, 'The resolution').v, '', i.resolutionLimit);
    }
    const purityCheck = i.purity === undefined || i.purity === '' ? undefined : verdict(i.purity === 'yes', i.purity === 'yes' ? 'peak purity passes in the stressed samples' : 'peak purity FAILS: a co-eluting peak');
    const shown = `interference ${ps.map((p) => `${fmt(p, 2)} %`).join(', ')} of the analyte's response ${std.text}; largest ${fmt(largest, 2)} %${i.resolution !== undefined ? `; resolution of the closest pair ${parse(i.resolution, 'The resolution').text}` : ''}`;
    return { ok: true, value: largest, unit: '%', shown, interferences: ps, ...(resolutionCheck ? { resolutionCheck } : {}), ...(purityCheck ? { purityCheck } : {}), ...checkOf(largest, '%', i.limit) };
  });
}
