/**
 * Lab calculation templates (library 3b and 8b): L1 Assay by external standard (and its modes), L2 % label claim,
 * L3 Result on a basis, L4 Impurities, L9 Residual solvents, L20 Chromatographic adjustment check.
 *
 * Same rules as every template: text inputs with units, exact decimals, no formula language; the result keeps its
 * full precision and is rounded only at the limit (C1). Safety rules of the library (8d) are refusals here:
 * S1 absorptivity form, S3 basis applied twice, S4 correction factor against response factor, S7 label per volume.
 */
import {
  checkOf, Dec, decimalsOf, defaultDecimals, fmt, HUNDRED, needKind, ONE, parse, parseAny, percent, refuse, run, sameKind, show,
  shownNumber, to, unitOf, ZERO, type Outcome, type Parsed, type Q, type ResultValue,
} from './core.js';
import { checkLimit, roundHalfUp, writtenDecimals, type Check, type Limit } from './rounding.js';
import { Refused } from './refuse.js';
import type { Kind } from './units.js';

const TEN = new Dec(10);
const HALF = new Dec('0.5');
const RESPONSE: Kind[] = ['number', 'absorbance'];
const CONTENT_KINDS: Kind[] = ['fraction', 'IU per mass', 'activity units per mass'];
const PLAIN = /^\d+(\.\d+)?$/;

function positive(p: Parsed, what: string): void {
  if (!p.v.isPositive() || p.v.isZero()) refuse(`${what} must be more than zero`);
}

/** A plain positive decimal written without a unit (a factor, an RRT, a specific absorbance). */
function plain(text: unknown, what: string): Dec {
  if (typeof text !== 'string' || !PLAIN.test(text.trim())) refuse(`${what} must be a plain decimal as written in the method (for example "1.25"), without a unit`);
  const v = new Dec(text.trim());
  if (v.isZero()) refuse(`${what} must be more than zero`);
  return v;
}

/** A computed number in a worked line: exactly when it has at most 4 decimals, else by the display rule (cut, "…"). */
const n = (v: Dec, unit: string, decimals?: number): string =>
  v.decimalPlaces() <= 4 ? v.toFixed() : shownNumber(v, unit, decimals === undefined ? {} : { decimals });
const t = (v: Dec): string => n(v, 'min', 3);
const withUnit = (v: Dec, unit: string): string => `${n(v, unit)} ${unit}`;

// ---------------------------------------------------------------- shared parts: readings, dilutions, standard
interface Mean {
  readonly v: Dec;
  readonly unit: Parsed['unit'];
  readonly text: string;
}

/** The mean of replicate readings (injections, absorbance readings). */
function meanOf(qs: readonly Q[] | undefined, what: string, response: L1Response): Mean {
  if (qs === undefined || qs.length === 0) refuse(`${what}: give at least one reading`);
  const ps = qs.map((q, k) => parse(q, `${what} ${k + 1}`));
  for (const p of ps) {
    needKind(p, RESPONSE, what);
    if (response !== 'absorbance' && p.unit.kind === 'absorbance') refuse(`${what}: a ${response} is a plain number; "${p.text}" is an absorbance`);
    if (p.v.isNegative()) refuse(`${what}: a reading cannot be negative ("${p.text}")`);
  }
  sameKind(ps, what);
  const first = ps[0] as Parsed;
  const sum = ps.reduce((s, p) => s.plus(to(p, first.unit)), ZERO);
  const v = sum.div(ps.length);
  const sym = first.unit.symbol;
  const text = ps.length === 1 ? first.text : `mean of (${ps.map((p) => p.text).join(', ')}) = ${sym === '' ? n(v, '') : withUnit(v, sym)}`;
  return { v, unit: first.unit, text };
}

/** The mean of response ratios analyte ÷ internal standard, injection by injection. */
function ratioMeanOf(a: readonly Q[] | undefined, is: readonly Q[] | undefined, what: string, response: L1Response): Mean {
  if (a === undefined || a.length === 0) refuse(`${what}: give at least one reading`);
  if (is === undefined || is.length !== a.length) refuse(`${what}: give one internal standard reading for each analyte reading (${a.length})`);
  const ratios = a.map((q, k) => {
    const x = meanOf([q], `${what} ${k + 1}`, response);
    const y = meanOf([is[k] as Q], `${what} ${k + 1}, internal standard`, response);
    if (y.v.isZero()) refuse(`${what} ${k + 1}: the internal standard response is zero`);
    return { r: x.v.div(to({ v: y.v, unit: y.unit, text: y.text }, x.unit)), text: `${x.text} ÷ ${y.text}` };
  });
  const v = ratios.reduce((s, r) => s.plus(r.r), ZERO).div(ratios.length);
  const text = ratios.length === 1 ? `ratio ${ratios[0]?.text ?? ''}` : `mean ratio of (${ratios.map((r) => r.text).join(', ')}) = ${n(v, '')}`;
  return { v, unit: unitOf(''), text };
}

/** A dilution chain from the `dilute` block: the first flask, then aliquot → volume made up to, as often as needed. */
export interface Dilution {
  /** The flask the weighed amount (or the sample volume, or the whole units) is dissolved in. Not given for a solution of declared strength. */
  readonly volume?: Q;
  readonly steps?: readonly { readonly aliquot: Q; readonly to: Q }[];
}

interface DilutionOut {
  /** The first flask in mL (1 when not used). */
  readonly volume: Dec;
  /** Π (made up to ÷ aliquot). */
  readonly ratio: Dec;
  readonly text: string;
}

function readDilution(d: Dilution | undefined, what: string, needVolume: boolean): DilutionOut {
  let volume = ONE;
  const parts: string[] = [];
  if (needVolume) {
    if (d?.volume === undefined) refuse(`${what}: give the volume of the first flask the weighed amount is dissolved in`);
    const v = parse(d.volume, `${what}, the first flask`);
    needKind(v, ['volume'], `${what}, the first flask`);
    positive(v, `${what}, the first flask`);
    volume = to(v, 'mL');
    parts.push(v.text);
  } else if (d?.volume !== undefined) {
    refuse(`${what}: a solution of declared strength is not dissolved again; give only the further dilutions (aliquot and the volume it is made up to)`);
  }
  let ratio = ONE;
  (d?.steps ?? []).forEach((s, k) => {
    const a = parse(s.aliquot, `${what}, dilution ${k + 1}, the aliquot`);
    const t = parse(s.to, `${what}, dilution ${k + 1}, the volume made up to`);
    needKind(a, ['volume'], `${what}, dilution ${k + 1}, the aliquot`);
    needKind(t, ['volume'], `${what}, dilution ${k + 1}, the volume made up to`);
    positive(a, `${what}, dilution ${k + 1}, the aliquot`);
    if (to(a, 'mL').gt(to(t, 'mL'))) refuse(`${what}, dilution ${k + 1}: the aliquot (${a.text}) is more than the volume it is made up to (${t.text})`);
    ratio = ratio.times(to(t, 'mL')).div(to(a, 'mL'));
    parts.push(`${t.text} ÷ ${a.text}`);
  });
  return { volume, ratio, text: parts.join(' × ') };
}

/** The reference standard, as the standard item gives it (potency and its basis are pulled, never typed). */
export interface L1Standard {
  /** Weighed standard. */
  readonly mass?: Q;
  /** The standard's potency from its item (%, or µg/mg), on `potencyBasis`. */
  readonly potency?: Q;
  /** Default 'as is'. */
  readonly potencyBasis?: 'as is' | 'dried' | 'anhydrous';
  /** The standard's own loss on drying / water, when its potency is on the dried / anhydrous basis and it is used as it is. */
  readonly lod?: Q;
  readonly water?: Q;
  /** The standard is dried before weighing (the method says so): its potency on the dried basis is used directly. */
  readonly driedBeforeUse?: boolean;
  /** Not weighed: the declared content of a reference solution or a prepared standard solution (mg/mL, µg/mL, % w/v). */
  readonly declared?: Q;
  readonly dilution?: Dilution;
}

interface Conc {
  /** mg/mL in the final solution. */
  readonly c: Dec;
  readonly line: string;
}

function standardConcentration(s: L1Standard | undefined, what = 'The standard'): Conc {
  if (s === undefined) refuse(`${what} is missing: give its weight and potency, or its declared concentration`);
  if (s.declared !== undefined) {
    if (s.mass !== undefined) refuse(`${what}: give either the weighed amount or the declared concentration, not both`);
    const p = parse(s.declared, `${what}, the declared concentration`);
    needKind(p, ['mass concentration'], `${what}, the declared concentration`);
    positive(p, `${what}, the declared concentration`);
    const d = readDilution(s.dilution, what, false);
    const c = to(p, 'mg/mL').div(d.ratio);
    const line = d.text === '' ? `standard ${p.text}` : `standard ${p.text} ÷ (${d.text}) = ${withUnit(c, 'mg/mL')}`;
    return { c, line };
  }
  if (s.mass === undefined) refuse(`${what}: give the weighed amount (or the declared concentration of a reference solution)`);
  const m = parse(s.mass, `${what}, the weighed amount`);
  needKind(m, ['mass'], `${what}, the weighed amount`);
  positive(m, `${what}, the weighed amount`);
  if (s.potency === undefined) refuse(`${what}: the potency from the standard's item is missing`);
  const p = percent(s.potency, `${what}, the potency`);
  if (!p.v.isPositive() || p.v.isZero()) refuse(`${what}: the potency must be more than zero`);
  const basis = s.potencyBasis ?? 'as is';
  const dried = s.driedBeforeUse === true;
  let used = p.v;
  let potLine = p.text;
  const twice = (x: string): never =>
    refuse(`Basis applied twice (safety rule S3): ${what.toLowerCase()} ${x}. Give the potency on the basis the standard is used on, and correct it once.`);
  if (basis === 'as is') {
    if (dried) twice('is dried before use but its potency is as is; ask for the potency on the dried basis');
    if (s.lod !== undefined || s.water !== undefined) twice('has an as-is potency, so no loss on drying or water correction is applied to it');
  } else if (dried) {
    if (s.lod !== undefined || s.water !== undefined) twice(`is dried before use, so its ${basis} potency is used directly; a loss on drying or water correction would count the basis again`);
    potLine = `${p.text} (${basis}, standard dried before use)`;
  } else {
    const q = basis === 'dried' ? s.lod : s.water;
    const name = basis === 'dried' ? 'loss on drying' : 'water content';
    if (basis === 'dried' && s.water !== undefined) refuse(`${what}: a potency on the dried basis is corrected with the loss on drying, not the water content`);
    if (basis === 'anhydrous' && s.lod !== undefined) refuse(`${what}: a potency on the anhydrous basis is corrected with the water content, not the loss on drying`);
    if (q === undefined) refuse(`${what}: the potency is on the ${basis} basis and the standard is used as it is; give its ${name}`);
    const c = percent(q, `${what}, the ${name}`);
    if (c.v.isNegative() || c.v.gte(HUNDRED)) refuse(`${what}: the ${name} must be from 0 to less than 100 %`);
    used = p.v.times(HUNDRED.minus(c.v)).div(HUNDRED);
    potLine = `${p.text} × (100 − ${c.text}) ÷ 100`;
  }
  const d = readDilution(s.dilution, what, true);
  const c = to(m, 'mg').times(used).div(HUNDRED).div(d.volume.times(d.ratio));
  return { c, line: `standard ${m.text} × ${potLine} ÷ 100 ÷ (${d.text}) = ${withUnit(c, 'mg/mL')}` };
}

// ---------------------------------------------------------------- L1 Assay by external standard
export type L1Response = 'peak area' | 'peak height' | 'absorbance';
export type L1Mode = 'external standard' | 'bracketing' | 'internal standard' | 'calibration curve' | 'specific absorbance';

/** The measurement part of L1 (also used per solvent by L9). */
export interface L1Measurement {
  readonly mode: L1Mode;
  /** Default 'peak area' ('absorbance' for the specific absorbance mode). */
  readonly response?: L1Response;
  /** Replicate sample readings (their mean is used). Internal standard: the analyte's readings. */
  readonly sampleResponses: readonly Q[];
  /** Internal standard: the internal standard's reading in each sample injection, in the same order. */
  readonly sampleIsResponses?: readonly Q[];
  /** Standard readings. Bracketing: the standards before the samples. */
  readonly standardResponses?: readonly Q[];
  /** Bracketing: the standards after the samples. */
  readonly standardResponsesAfter?: readonly Q[];
  readonly standardIsResponses?: readonly Q[];
  readonly standard?: L1Standard;
  /** A fixed blank (or the untreated reading) taken off the mean sample / standard reading. */
  readonly sampleBlank?: Q;
  readonly standardBlank?: Q;
  /** Calibration curve: graded standards (concentration in the final solution, reading; with `isResponse` for an internal standard curve). */
  readonly calibration?: {
    readonly points: readonly { readonly concentration: Q; readonly response: Q; readonly isResponse?: Q }[];
    readonly throughOrigin?: boolean;
    /** Lowest correlation coefficient r the method allows, as written (e.g. "0.999"). */
    readonly minR?: string;
  };
  /** Specific absorbance mode: no reference standard. */
  readonly specificAbsorbance?: {
    /** The figure as written in the monograph, e.g. "715". */
    readonly value: string;
    /** Safety rule S1: A(1 %, 1 cm) (per 1 g in 100 mL) and the absorptivity (per 1 g/L) differ 10 times; the method must say which. */
    readonly form: 'A(1 %, 1 cm)' | 'absorptivity';
    /** The cell's path length (never assumed to be 1 cm). */
    readonly pathLength: Q;
  };
}

/** The sample as prepared: by mass, by volume, or N whole units, with its dilution chain. */
export interface L1Sample {
  readonly mass?: Q;
  readonly volume?: Q;
  /** N whole units (tablets, vials, ampoules) dissolved together. */
  readonly units?: Q;
  readonly dilution: Dilution;
  /** Average unit weight, for a result per unit from a weighed portion of powder. */
  readonly averageUnitWeight?: Q;
  /** Weight per mL (density) of a liquid sample taken by mass, for a result per mL (safety rule S7). */
  readonly weightPerMl?: Q;
}

export type L3Basis = 'dried' | 'anhydrous' | 'solvent-free' | 'anhydrous and solvent-free' | 'ignited';

export interface BasisCorrection {
  readonly basis: L3Basis;
  readonly lod?: Q;
  readonly water?: Q;
  readonly solvents?: Q;
  readonly loi?: Q;
  /** 'dried sample': the test portion was dried before the test, so its result is already on the dried basis (S3). */
  readonly measuredOn?: 'as is' | 'dried sample';
}

export interface L1Input extends L1Measurement {
  readonly sample: L1Sample;
  /** The result per mass of sample (%, ppm, mg/g …), per unit (mg per tablet), or per volume (mg/mL). */
  readonly per: 'mass' | 'unit' | 'volume';
  /** Result unit: per mass default %, per unit default mg, per volume default mg/mL. */
  readonly unit?: string;
  /** Per mass only: the content on a basis (L3) with the sample's own LOD / water / solvents. */
  readonly onBasis?: BasisCorrection;
  /** Specific absorbance: IU per mg of the pure substance (retinol), for a result in IU. */
  readonly iuPerMg?: Q;
  readonly decimals?: number;
  readonly limit?: Limit;
}

export interface L1Extra {
  /** Concentration of the analyte in the final sample solution, mg/mL. */
  readonly sampleConcentration: Dec;
  /** Concentration of the standard in its final solution, mg/mL (standard modes). */
  readonly standardConcentration?: Dec;
  /** Calibration curve: slope, intercept and correlation coefficient. */
  readonly curve?: { readonly slope: Dec; readonly intercept: Dec; readonly r: Dec };
  /** Amount of analyte found in the sample taken, mg (IU in the IU mode). */
  readonly amount: Dec;
}

interface Measured {
  readonly c: Dec;
  readonly cStd?: Dec;
  readonly curve?: { slope: Dec; intercept: Dec; r: Dec };
  readonly lines: string[];
}

function blanked(m: Mean, blank: Q | undefined, what: string, response: L1Response, allowZero: boolean): Mean {
  let v = m.v;
  let text = m.text;
  if (blank !== undefined) {
    const b = meanOf([blank], `${what} blank`, response);
    v = m.v.minus(to({ v: b.v, unit: b.unit, text: b.text }, m.unit));
    text = `(${m.text}) − blank ${b.text}`;
  }
  if (v.isNegative() && !v.isZero()) refuse(`${what}: the reading after the blank is taken off is negative; check the blank and the readings`);
  if (!allowZero && v.isZero()) refuse(`${what}: the reading after the blank is zero; the standard did not respond`);
  return { v, unit: m.unit, text };
}

function linearFit(xs: readonly Dec[], ys: readonly Dec[], throughOrigin: boolean): { slope: Dec; intercept: Dec; r: Dec } {
  const k = new Dec(xs.length);
  let sx = ZERO, sy = ZERO, sxx = ZERO, sxy = ZERO, syy = ZERO;
  xs.forEach((x, j) => {
    const y = ys[j] as Dec;
    sx = sx.plus(x); sy = sy.plus(y); sxx = sxx.plus(x.times(x)); sxy = sxy.plus(x.times(y)); syy = syy.plus(y.times(y));
  });
  const dx = k.times(sxx).minus(sx.times(sx));
  const dy = k.times(syy).minus(sy.times(sy));
  if (dx.isZero()) refuse('Calibration curve: the standards must have at least two different concentrations');
  if (dy.isZero()) refuse('Calibration curve: every standard gave the same reading; no curve can be drawn');
  const r = k.times(sxy).minus(sx.times(sy)).div(dx.times(dy).sqrt());
  if (throughOrigin) return { slope: sxy.div(sxx), intercept: ZERO, r };
  const slope = k.times(sxy).minus(sx.times(sy)).div(dx);
  return { slope, intercept: sy.minus(slope.times(sx)).div(k), r };
}

/** The measurement: concentration of the analyte in the final sample solution (mg/mL). */
function measure(i: L1Measurement): Measured {
  const response: L1Response = i.response ?? (i.mode === 'specific absorbance' ? 'absorbance' : 'peak area');
  const isMode = i.mode === 'internal standard' || (i.mode === 'calibration curve' && i.sampleIsResponses !== undefined);
  if (!isMode && (i.sampleIsResponses !== undefined || i.standardIsResponses !== undefined)) refuse('Internal standard readings are given, but the mode is not the internal standard mode');
  if (i.mode !== 'bracketing' && i.standardResponsesAfter !== undefined) refuse('Standards after the samples are given: use the bracketing mode');
  if (i.mode !== 'calibration curve' && i.calibration !== undefined) refuse('Calibration standards are given: use the calibration curve mode');
  if (i.mode !== 'specific absorbance' && i.specificAbsorbance !== undefined) refuse('A specific absorbance is given: use the specific absorbance mode');

  if (i.mode === 'specific absorbance') {
    if (response !== 'absorbance') refuse('The specific absorbance mode reads an absorbance');
    if (i.standard !== undefined || i.standardResponses !== undefined) refuse('The specific absorbance mode uses no reference standard; remove the standard, or use the external standard mode');
    const sa = i.specificAbsorbance;
    if (sa === undefined) refuse('The specific absorbance mode needs the specific absorbance figure from the monograph, its form and the path length');
    if (sa.form !== 'A(1 %, 1 cm)' && sa.form !== 'absorptivity') {
      refuse('Safety rule S1: say whether the figure is the specific absorbance A(1 %, 1 cm) (per 1 g in 100 mL) or the absorptivity (per 1 g/L); they differ 10 times and the result would be 10 times wrong');
    }
    const a1 = plain(sa.value, 'The specific absorbance');
    const b = parse(sa.pathLength, 'The path length');
    needKind(b, ['length'], 'The path length');
    positive(b, 'The path length');
    const A = blanked(meanOf(i.sampleResponses, 'The sample absorbance', 'absorbance'), i.sampleBlank, 'The sample absorbance', 'absorbance', true);
    const bcm = to(b, 'cm');
    // A(1 %, 1 cm): C in g/100 mL = A ÷ (A1% × b); × 10 = mg/mL. Absorptivity a: C in g/L (= mg/mL) = A ÷ (a × b).
    const c = sa.form === 'A(1 %, 1 cm)' ? A.v.div(a1.times(bcm)).times(TEN) : A.v.div(a1.times(bcm));
    const line =
      sa.form === 'A(1 %, 1 cm)'
        ? `sample ${A.text} ÷ (A(1 %, 1 cm) ${sa.value.trim()} × ${n(bcm, 'cm')} cm) = ${n(c.div(TEN), '%w/v')} g per 100 mL = ${withUnit(c, 'mg/mL')}`
        : `sample ${A.text} ÷ (absorptivity ${sa.value.trim()} L/(g·cm) × ${n(bcm, 'cm')} cm) = ${withUnit(c, 'mg/mL')}`;
    return { c, lines: [line] };
  }

  if (i.mode === 'calibration curve') {
    const cal = i.calibration;
    if (cal === undefined || cal.points.length < 3) refuse('A calibration curve needs at least 3 standards (concentration and reading)');
    const xs = cal.points.map((p, k) => {
      const x = parse(p.concentration, `Calibration standard ${k + 1}, the concentration`);
      needKind(x, ['mass concentration'], `Calibration standard ${k + 1}, the concentration`);
      if (x.v.isNegative()) refuse(`Calibration standard ${k + 1}: the concentration cannot be negative`);
      return to(x, 'mg/mL');
    });
    const ys = cal.points.map((p, k) => {
      if (isMode) {
        if (p.isResponse === undefined) refuse(`Calibration standard ${k + 1}: give the internal standard reading`);
        return ratioMeanOf([p.response], [p.isResponse], `Calibration standard ${k + 1}`, response).v;
      }
      if (p.isResponse !== undefined) refuse(`Calibration standard ${k + 1} has an internal standard reading, but the samples have none`);
      return meanOf([p.response], `Calibration standard ${k + 1}`, response).v;
    });
    const fit = linearFit(xs, ys, cal.throughOrigin === true);
    if (!fit.slope.isPositive() || fit.slope.isZero()) refuse('Calibration curve: the reading does not rise with the concentration (slope not above zero); check the standards');
    let rLine = `r = ${fmt(fit.r, 5)}`;
    if (cal.minR !== undefined) {
      const ck = checkLimit(fit.r, '', { low: cal.minR, unit: '' });
      if (!ck.pass) refuse(`Calibration curve: the correlation coefficient ${ck.shown}; the curve is not valid, so no result is calculated`);
      rLine = `r ${ck.shown}`;
    }
    const y = isMode
      ? ratioMeanOf(i.sampleResponses, i.sampleIsResponses, 'The sample', response)
      : blanked(meanOf(i.sampleResponses, 'The sample reading', response), i.sampleBlank, 'The sample reading', response, true);
    const c = y.v.minus(fit.intercept).div(fit.slope);
    const lo = Dec.min(...xs);
    const hi = Dec.max(...xs);
    if (c.lt(lo) || c.gt(hi)) {
      refuse(`The sample reads back ${withUnit(c, 'mg/mL')}, outside the calibrated range ${withUnit(lo, 'mg/mL')} to ${withUnit(hi, 'mg/mL')}; dilute the sample or prepare it again so that it falls inside the curve`);
    }
    const line =
      `curve of ${xs.length} standards: reading = ${n(fit.slope, '')} × concentration ${fit.intercept.isNegative() ? '−' : '+'} ${n(fit.intercept.abs(), '')}, ${rLine}; ` +
      `sample ${y.text}: (${n(y.v, '')} − ${n(fit.intercept, '')}) ÷ ${n(fit.slope, '')} = ${withUnit(c, 'mg/mL')}`;
    return { c, curve: fit, lines: [line] };
  }

  const std = standardConcentration(i.standard);
  let rs: Mean;
  let rStd: Mean;
  if (i.mode === 'internal standard') {
    if (i.sampleBlank !== undefined || i.standardBlank !== undefined) refuse('A blank is not taken off response ratios; use the external standard mode for a blank correction');
    rs = ratioMeanOf(i.sampleResponses, i.sampleIsResponses, 'The sample', response);
    rStd = ratioMeanOf(i.standardResponses, i.standardIsResponses, 'The standard', response);
    if (rStd.v.isZero()) refuse('The standard: the response ratio is zero');
  } else {
    rs = blanked(meanOf(i.sampleResponses, 'The sample reading', response), i.sampleBlank, 'The sample reading', response, true);
    if (i.mode === 'bracketing') {
      if (i.standardResponsesAfter === undefined) refuse('Bracketing needs the standard readings after the samples as well as before');
      const before = meanOf(i.standardResponses, 'The standard before the samples', response);
      const after = meanOf(i.standardResponsesAfter, 'The standard after the samples', response);
      sameKind([{ v: before.v, unit: before.unit, text: before.text }, { v: after.v, unit: after.unit, text: after.text }], 'Bracketing standards');
      const v = before.v.plus(to({ v: after.v, unit: after.unit, text: after.text }, before.unit)).div(2);
      const sym = before.unit.symbol;
      rStd = { v, unit: before.unit, text: `(before ${before.text}; after ${after.text}) mean = ${sym === '' ? n(v, '') : withUnit(v, sym)}` };
    } else {
      rStd = meanOf(i.standardResponses, 'The standard reading', response);
    }
    rStd = blanked(rStd, i.standardBlank, 'The standard reading', response, false);
    sameKind([{ v: rs.v, unit: rs.unit, text: rs.text }, { v: rStd.v, unit: rStd.unit, text: rStd.text }], 'Sample and standard readings');
  }
  const c = rs.v.times(std.c).div(to({ v: rStd.v, unit: rStd.unit, text: rStd.text }, rs.unit));
  return { c, cStd: std.c, lines: [std.line, `sample ${rs.text} ÷ standard ${rStd.text} × ${withUnit(std.c, 'mg/mL')} = ${withUnit(c, 'mg/mL')}`] };
}

interface SampleOut {
  readonly by: 'mass' | 'volume' | 'units';
  readonly p: Parsed;
  readonly d: DilutionOut;
}

function readSample(s: L1Sample | undefined): SampleOut {
  if (s === undefined) refuse('The sample is missing');
  const given = [s.mass, s.volume, s.units].filter((x) => x !== undefined).length;
  if (given !== 1) refuse('Give the sample as exactly one of: the mass taken, the volume taken, or the number of whole units');
  const by = s.mass !== undefined ? 'mass' : s.volume !== undefined ? 'volume' : 'units';
  const p = parse((s.mass ?? s.volume ?? s.units) as Q, `The sample ${by === 'units' ? 'number of units' : by}`);
  needKind(p, by === 'mass' ? ['mass'] : by === 'volume' ? ['volume'] : ['count', 'number'], `The sample ${by === 'units' ? 'number of units' : by}`);
  positive(p, `The sample ${by === 'units' ? 'number of units' : by}`);
  if (by === 'units' && !p.v.isInteger()) refuse('The number of whole units must be a whole number');
  return { by, p, d: readDilution(s.dilution, 'The sample', true) };
}

/** The basis conversion of L3 (as is → basis), shared with L1. */
function onBasis(value: Dec, valueText: string, b: BasisCorrection): { v: Dec; line: string } {
  const measured = b.measuredOn ?? 'as is';
  if (measured === 'dried sample' && b.basis !== 'ignited') {
    refuse(`Basis applied twice (safety rule S3): the test portion was dried before the test, so its result is already on the dried basis; converting it to the ${b.basis} basis would count the loss on drying again`);
  }
  const corr = (q: Q | undefined, what: string): { v: Dec; text: string } => {
    if (q === undefined) refuse(`The result on the ${b.basis} basis needs the sample's own ${what}`);
    const c = percent(q, `The ${what}`);
    if (c.v.isNegative() || c.v.gte(HUNDRED)) refuse(`The ${what} must be from 0 to less than 100 %`);
    return c;
  };
  const unused = (q: Q | undefined, what: string): void => {
    if (q !== undefined) refuse(`The ${b.basis} basis does not use the ${what}; remove it (a second correction would apply the basis twice)`);
  };
  let off: Dec;
  let offText: string;
  switch (b.basis) {
    case 'dried': {
      unused(b.water, 'water content'); unused(b.solvents, 'residual solvents'); unused(b.loi, 'loss on ignition');
      const c = corr(b.lod, 'loss on drying'); off = c.v; offText = c.text; break;
    }
    case 'anhydrous': {
      unused(b.lod, 'loss on drying'); unused(b.solvents, 'residual solvents'); unused(b.loi, 'loss on ignition');
      const c = corr(b.water, 'water content'); off = c.v; offText = c.text; break;
    }
    case 'solvent-free': {
      unused(b.lod, 'loss on drying'); unused(b.water, 'water content'); unused(b.loi, 'loss on ignition');
      const c = corr(b.solvents, 'residual solvents'); off = c.v; offText = c.text; break;
    }
    case 'ignited': {
      unused(b.lod, 'loss on drying'); unused(b.water, 'water content'); unused(b.solvents, 'residual solvents');
      const c = corr(b.loi, 'loss on ignition'); off = c.v; offText = c.text; break;
    }
    case 'anhydrous and solvent-free': {
      unused(b.lod, 'loss on drying'); unused(b.loi, 'loss on ignition');
      const w = corr(b.water, 'water content');
      const s = corr(b.solvents, 'residual solvents');
      off = w.v.plus(s.v); offText = `${w.text} − ${s.text}`;
      if (off.gte(HUNDRED)) refuse('Water plus solvents must be less than 100 %');
      break;
    }
    default:
      refuse(`Unknown basis "${String(b.basis)}"; use dried, anhydrous, solvent-free, anhydrous and solvent-free, or ignited`);
  }
  const v = value.times(HUNDRED).div(HUNDRED.minus(off));
  return { v, line: `${valueText} × 100 ÷ (100 − ${offText})` };
}

const PER_DEFAULT = { mass: '%', unit: 'mg', volume: 'mg/mL' } as const;

/** L1 core: the result and the worked line, without the outer run(). */
function l1(i: L1Input): { value: Dec; unit: string; shown: string; extra: L1Extra } {
  const m = measure(i);
  const s = readSample(i.sample);
  const amount = m.c.times(s.d.volume).times(s.d.ratio); // mg in the sample taken
  const amountLine = `× (${s.d.text}) = ${withUnit(amount, 'mg')} in the sample`;
  const lines = [...m.lines];
  let iu: Dec | undefined;
  if (i.iuPerMg !== undefined) {
    if (i.mode !== 'specific absorbance') refuse('A conversion to IU belongs to the specific absorbance mode; a standard in IU gives IU directly');
    const f = parse(i.iuPerMg, 'The IU per mg');
    needKind(f, ['IU per mass'], 'The IU per mg');
    positive(f, 'The IU per mg');
    iu = to(f, 'IU/mg');
  }
  const u = unitOf(i.unit ?? (iu !== undefined ? (i.per === 'mass' ? 'IU/g' : 'IU') : PER_DEFAULT[i.per]));
  let value: Dec;
  if (i.per === 'mass') {
    if (s.by !== 'mass') refuse('A result per mass of sample needs the sample taken by mass');
    if (iu !== undefined) {
      needKind({ v: ONE, unit: u, text: u.symbol }, ['IU per mass'], 'The result unit');
      value = to({ v: amount.times(iu).div(to(s.p, 'mg')), unit: unitOf('IU/mg'), text: '' }, u);
      lines.push(`${amountLine} × ${withUnit(iu, 'IU/mg')} ÷ ${s.p.text} = ${show(value, u.symbol, i.decimals ?? 0)}`);
    } else {
      needKind({ v: ONE, unit: u, text: u.symbol }, ['fraction'], 'The result unit per mass');
      const pct = amount.div(to(s.p, 'mg')).times(HUNDRED);
      value = to({ v: pct, unit: unitOf('%'), text: '' }, u);
      lines.push(`${amountLine} ÷ ${s.p.text} × 100 = ${withUnit(pct, '%')}`);
      if (i.onBasis !== undefined) {
        const b = onBasis(value, withUnit(value, u.symbol), i.onBasis);
        value = b.v;
        lines.push(`on the ${i.onBasis.basis} basis: ${b.line} = ${withUnit(value, u.symbol)}`);
      }
    }
  } else if (i.per === 'unit') {
    if (i.onBasis !== undefined) refuse('A content per unit is not put on a basis; the basis applies to a content per mass of substance');
    let perUnit: Dec;
    const total = iu !== undefined ? amount.times(iu) : amount;
    const tu = iu !== undefined ? 'IU' : 'mg';
    if (s.by === 'units') {
      perUnit = total.div(s.p.v);
      lines.push(`${amountLine} ÷ ${s.p.text} = ${withUnit(perUnit, tu)} per unit`);
    } else if (s.by === 'mass') {
      if (i.sample.averageUnitWeight === undefined) refuse('A result per unit from a weighed portion needs the average unit weight');
      const w = parse(i.sample.averageUnitWeight, 'The average unit weight');
      needKind(w, ['mass'], 'The average unit weight');
      positive(w, 'The average unit weight');
      perUnit = total.div(to(s.p, 'mg')).times(to(w, 'mg'));
      lines.push(`${amountLine} ÷ ${s.p.text} × average unit weight ${w.text} = ${withUnit(perUnit, tu)} per unit`);
    } else {
      refuse('A result per unit needs the sample as whole units or as a weighed portion with the average unit weight; for a liquid taken by volume use the result per volume');
    }
    if (iu !== undefined) needKind({ v: ONE, unit: u, text: u.symbol }, ['IU'], 'The result unit');
    else needKind({ v: ONE, unit: u, text: u.symbol }, ['mass'], 'The result unit per unit');
    value = to({ v: perUnit, unit: unitOf(tu), text: '' }, u);
  } else {
    if (i.onBasis !== undefined) refuse('A content per volume is not put on a basis');
    if (iu !== undefined) refuse('A result in IU per volume is not supported; give the result per mass or per unit');
    needKind({ v: ONE, unit: u, text: u.symbol }, ['mass concentration'], 'The result unit per volume');
    let perMl: Dec;
    if (s.by === 'volume') {
      perMl = amount.div(to(s.p, 'mL'));
      lines.push(`${amountLine} ÷ ${s.p.text} = ${withUnit(perMl, 'mg/mL')}`);
    } else if (s.by === 'mass') {
      if (i.sample.weightPerMl === undefined) {
        refuse('Safety rule S7: a liquid taken by mass gives a result per mL only with its weight per mL (density); record the weight per mL (L10) and pass it in');
      }
      const dn = parse(i.sample.weightPerMl, 'The weight per mL');
      needKind(dn, ['density'], 'The weight per mL');
      positive(dn, 'The weight per mL');
      perMl = amount.div(to(s.p, 'mg')).times(to(dn, 'g/mL')).times(1000);
      lines.push(`${amountLine} ÷ ${s.p.text} × weight per mL ${dn.text} = ${withUnit(perMl, 'mg/mL')}`);
    } else {
      refuse('A result per volume from whole units is not defined; use the result per unit');
    }
    value = to({ v: perMl, unit: unitOf('mg/mL'), text: '' }, u);
  }
  const extra: L1Extra = {
    sampleConcentration: m.c,
    amount: iu !== undefined ? amount.times(iu) : amount,
    ...(m.cStd === undefined ? {} : { standardConcentration: m.cStd }),
    ...(m.curve === undefined ? {} : { curve: m.curve }),
  };
  return { value, unit: u.symbol, shown: lines.join('; '), extra };
}

/**
 * L1 Assay by external standard. Modes: single standard, bracketing standards (mean of the means before and after),
 * internal standard (response ratio), calibration curve (least squares of N standards, read-back inside the range),
 * specific absorbance (no reference standard). Results per mass (% on a basis), per unit, or per volume.
 */
export function l1Assay(i: L1Input): Outcome<L1Extra> {
  return run(() => {
    const r = l1(i);
    const dp = i.decimals ?? defaultDecimals(r.unit);
    return { ok: true, value: r.value, unit: r.unit, shown: `${r.shown}; result ${show(r.value, r.unit, dp)}`, ...r.extra, ...checkOf(r.value, r.unit, i.limit) };
  });
}

// ---------------------------------------------------------------- L2 % label claim
export interface L2Input {
  /** Content found per unit (mg, IU) or per volume (mg/mL): an L1 result or a value. */
  readonly content: Q | ResultValue;
  /** The label claim from the product master (e.g. "500 mg", "125 mg" per 5 mL, "50000 IU"). */
  readonly labelClaim: Q;
  /** The volume the label claim is stated per (e.g. "5 mL"), for liquids (safety rule S7). */
  readonly labelPer?: Q;
  readonly decimals?: number;
  readonly limit?: Limit;
}

/** L2 % label claim: content ÷ label claim × 100 (per unit, or per mL with the label's volume). */
export function l2LabelClaim(i: L2Input): Outcome {
  return run(() => {
    const c = parseAny(i.content, 'The content found');
    const l = parse(i.labelClaim, 'The label claim');
    positive(l, 'The label claim');
    if (c.v.isNegative()) refuse('The content found cannot be negative');
    let label: Dec;
    let labelText = l.text;
    if (i.labelPer !== undefined) {
      const per = parse(i.labelPer, 'The volume the label claim is per');
      needKind(per, ['volume'], 'The volume the label claim is per');
      positive(per, 'The volume the label claim is per');
      needKind(l, ['mass'], 'A label claim per volume');
      if (c.unit.kind !== 'mass concentration') {
        refuse(`Safety rule S7: the label claim is ${l.text} per ${per.text}, so the content found must be per mL (mg/mL); "${c.text}" is ${c.unit.kind === 'mass' ? 'a mass per unit' : `a ${c.unit.kind}`}`);
      }
      label = to(l, 'mg').div(to(per, 'mL'));
      labelText = `(${l.text} ÷ ${per.text} = ${withUnit(label, 'mg/mL')})`;
      label = to({ v: label, unit: unitOf('mg/mL'), text: '' }, c.unit);
    } else {
      if (c.unit.kind === 'mass concentration' && l.unit.kind === 'mass') {
        refuse(`Safety rule S7: the content found is per volume (${c.text}) but the label claim ${l.text} has no volume; give the volume the label claim is per (e.g. 5 mL)`);
      }
      sameKind([c, l], 'Content and label claim');
      label = to(l, c.unit);
    }
    const value = c.v.div(label).times(HUNDRED);
    const dp = i.decimals ?? 1;
    return { ok: true, value, unit: '%', shown: `${c.text} ÷ ${labelText} × 100 = ${fmt(value, dp)} % of label claim`, ...checkOf(value, '%', i.limit) };
  });
}

// ---------------------------------------------------------------- L3 Result on a basis
export interface L3Input extends BasisCorrection {
  /** The result as is (%, mg/g, ppm, IU/mg …): a value or an earlier result (L1, L6). */
  readonly result: Q | ResultValue;
  readonly unit?: string;
  readonly decimals?: number;
  readonly limit?: Limit;
}

/**
 * L3 Result on a basis: as is × 100 ÷ (100 − LOD / water / solvents / LOI) with the sample's own result (the T9
 * correction, the other way round). Refuses a basis applied twice (S3).
 */
export function l3OnBasis(i: L3Input): Outcome {
  return run(() => {
    const r = parseAny(i.result, 'The result as is');
    needKind(r, CONTENT_KINDS, 'The result as is');
    if (r.v.isNegative()) refuse('The result as is cannot be negative');
    const u = unitOf(i.unit ?? r.unit.symbol);
    const b = onBasis(to(r, u), r.unit.symbol === u.symbol ? r.text : withUnit(to(r, u), u.symbol), i);
    const dp = i.decimals ?? defaultDecimals(u.symbol);
    return { ok: true, value: b.v, unit: u.symbol, shown: `${b.line} = ${show(b.v, u.symbol, dp)} (${i.basis} basis)`, ...checkOf(b.v, u.symbol, i.limit) };
  });
}

// ---------------------------------------------------------------- L4 Impurities
/** Safety rule S4: a correction factor multiplies the area; a relative response factor divides it. The method names which. */
export interface Factor {
  readonly kind: 'correction factor' | 'relative response factor';
  readonly value: string;
}

export interface L4Peak {
  /** A named (specified) impurity; peaks with the same name are summed (split peaks). */
  readonly name?: string;
  /** Relative retention as read, e.g. "0.85". */
  readonly rrt?: string;
  /** Peak area (plain number). */
  readonly area: Q;
  /** The principal peak (the substance itself). */
  readonly principal?: boolean;
  /** Excluded from the calculation, with the reason (blank, placebo, counter-ion, preservative …). */
  readonly excluded?: string;
  readonly factor?: Factor;
  /** External standard: the reference this peak is measured against (default the first). */
  readonly reference?: string;
}

export interface L4Reference {
  readonly name: string;
  /** The reference solution's readings (mean used). */
  readonly responses: readonly Q[];
  /** A dilution of the test solution, as % of it (e.g. "0.5 %"): the diluted reference. */
  readonly percentOfTest?: Q;
  /** An impurity (or substance) reference standard. */
  readonly standard?: L1Standard;
}

export interface L4Named {
  readonly name: string;
  /** The RRT window that defines the impurity, as written ("0.80", "0.90"). */
  readonly rrtLow?: string;
  readonly rrtHigh?: string;
  readonly factor?: Factor;
  readonly limit?: Limit;
}

export interface L4Input {
  readonly mode: 'area normalisation' | 'external standard';
  readonly peaks: readonly L4Peak[];
  readonly references?: readonly L4Reference[];
  /** External standard with a reference standard: the test solution (mass and dilution, or its concentration). */
  readonly sample?: { readonly mass: Q; readonly dilution: Dilution } | { readonly concentration: Q };
  readonly named?: readonly L4Named[];
  /** Peaks excluded by an RRT window, with the reason. */
  readonly excludeRrt?: readonly { readonly low: string; readonly high: string; readonly reason: string }[];
  readonly groups?: readonly { readonly name: string; readonly members: readonly string[]; readonly limit?: Limit }[];
  /** Peaks at or below this % (as written) are disregarded. */
  readonly disregardLimit?: string;
  /** Impurities above this % (as written) are reported and counted in the total. */
  readonly reportingThreshold?: string;
  /** Limit for any unspecified (unknown) impurity. */
  readonly unknownLimit?: Limit;
  /** "Not more than N peaks above x %". */
  readonly countRule?: { readonly above: string; readonly notMoreThan: number };
  readonly decimals?: number;
  /** Limit on the total of impurities. */
  readonly limit?: Limit;
}

export interface L4Impurity {
  readonly name: string;
  readonly kind: 'named' | 'unknown';
  readonly rrt?: string;
  readonly percent: Dec;
  readonly peaks: number;
  readonly reported: boolean;
  readonly shown: string;
  readonly check?: Check;
}

export interface L4Extra {
  readonly impurities: readonly L4Impurity[];
  readonly disregarded: readonly { readonly name: string; readonly percent: Dec }[];
  readonly excluded: readonly { readonly name: string; readonly reason: string }[];
  readonly groups: readonly { readonly name: string; readonly percent: Dec; readonly check?: Check }[];
  readonly largestUnknown?: { readonly name: string; readonly percent: Dec; readonly check?: Check };
  readonly countCheck?: Check;
  /** false when any limit (named, unknown, group, count, total) fails. */
  readonly allPass: boolean;
}

function readFactor(f: Factor | undefined, what: string): { v: Dec; kind: Factor['kind'] } | undefined {
  if (f === undefined) return undefined;
  if (typeof f !== 'object' || (f.kind !== 'correction factor' && f.kind !== 'relative response factor')) {
    refuse(`${what}: safety rule S4: say whether the factor is a correction factor (the area is multiplied by it) or a relative response factor (the area is divided by it); applying the wrong one changes the result by the factor squared`);
  }
  return { v: plain(f.value, `${what}, the ${f.kind}`), kind: f.kind };
}

const inWindow = (rrt: Dec, low: string, high: string, what: string): boolean => {
  const l = plain(low, `${what}, the lower RRT`);
  const h = plain(high, `${what}, the upper RRT`);
  if (l.gt(h)) refuse(`${what}: the lower RRT ${low} is above the upper RRT ${high}`);
  return rrt.gte(l) && rrt.lte(h);
};

/**
 * L4 Impurities: area normalisation (disregard limit) or external standard (a diluted test solution or an impurity
 * standard), correction / relative response factors (S4), excluded peaks, split peaks summed by name, RRT windows,
 * groups, reporting threshold, total, largest unknown and "not more than N peaks above x %".
 */
export function l4Impurities(i: L4Input): Outcome<L4Extra> {
  return run(() => {
    if (i.peaks.length === 0) refuse('Give the peaks of the chromatogram');
    const named = i.named ?? [];
    const names = new Set<string>();
    for (const nm of named) {
      if (names.has(nm.name)) refuse(`The impurity "${nm.name}" is defined twice`);
      names.add(nm.name);
      if ((nm.rrtLow === undefined) !== (nm.rrtHigh === undefined)) refuse(`Impurity "${nm.name}": give both ends of its RRT window`);
    }
    const disregard = i.disregardLimit === undefined ? undefined : { v: plain(i.disregardLimit, 'The disregard limit'), dp: writtenDecimals(i.disregardLimit) };
    const report = i.reportingThreshold === undefined ? undefined : { v: plain(i.reportingThreshold, 'The reporting threshold'), dp: writtenDecimals(i.reportingThreshold) };

    // 1. Each peak: excluded, principal, its name, its corrected area.
    interface P { name: string; kind: 'named' | 'unknown' | 'principal'; rrt?: string; area: Parsed; corr: Dec; line: string; ref?: string }
    const excluded: { name: string; reason: string }[] = [];
    const ps: P[] = [];
    let unknownNo = 0;
    i.peaks.forEach((pk, k) => {
      const label = pk.name ?? (pk.rrt !== undefined ? `peak at RRT ${pk.rrt}` : `peak ${k + 1}`);
      const area = parse(pk.area, `Peak ${k + 1} (${label}), the area`);
      needKind(area, ['number'], `Peak ${k + 1} (${label}), the area`);
      if (area.v.isNegative()) refuse(`Peak ${k + 1} (${label}): the area cannot be negative`);
      const rrt = pk.rrt === undefined ? undefined : plain(pk.rrt, `Peak ${k + 1}, the RRT`);
      if (pk.excluded !== undefined) {
        if (typeof pk.excluded !== 'string' || pk.excluded.trim() === '') refuse(`Peak ${k + 1} (${label}) is excluded without a reason; say why (blank, placebo, counter-ion …)`);
        excluded.push({ name: label, reason: pk.excluded.trim() });
        return;
      }
      if (rrt !== undefined) {
        const w = (i.excludeRrt ?? []).find((x, j) => inWindow(rrt, x.low, x.high, `Excluded RRT window ${j + 1}`));
        if (w !== undefined) {
          if (w.reason.trim() === '') refuse('An excluded RRT window needs its reason');
          excluded.push({ name: label, reason: w.reason.trim() });
          return;
        }
      }
      if (pk.principal === true) {
        ps.push({ name: pk.name ?? 'principal peak', kind: 'principal', ...(pk.rrt === undefined ? {} : { rrt: pk.rrt }), area, corr: area.v, line: area.text });
        return;
      }
      let def: L4Named | undefined;
      if (pk.name !== undefined) def = named.find((x) => x.name === pk.name);
      else if (rrt !== undefined) {
        const hits = named.filter((x) => x.rrtLow !== undefined && x.rrtHigh !== undefined && inWindow(rrt, x.rrtLow, x.rrtHigh, `Impurity "${x.name}"`));
        if (hits.length > 1) refuse(`The peak at RRT ${pk.rrt ?? ''} falls in the windows of ${hits.map((h) => `"${h.name}"`).join(' and ')}; the RRT windows must not overlap`);
        def = hits[0];
      }
      const name = pk.name ?? def?.name;
      if (pk.factor !== undefined && def?.factor !== undefined) refuse(`Peak ${k + 1} (${label}): the factor is given on the peak and on the impurity "${def.name}"; give it once`);
      const f = readFactor(pk.factor ?? def?.factor, `Peak ${k + 1} (${label})`);
      const corr = f === undefined ? area.v : f.kind === 'correction factor' ? area.v.times(f.v) : area.v.div(f.v);
      const line = f === undefined ? area.text : f.kind === 'correction factor' ? `${area.text} × correction factor ${f.v.toString()}` : `${area.text} ÷ relative response factor ${f.v.toString()}`;
      if (name === undefined) unknownNo += 1;
      ps.push({
        name: name ?? (pk.rrt !== undefined ? `unknown at RRT ${pk.rrt}` : `unknown ${unknownNo}`),
        kind: name === undefined ? 'unknown' : 'named',
        ...(pk.rrt === undefined ? {} : { rrt: pk.rrt }),
        area, corr, line,
        ...(pk.reference === undefined ? {} : { ref: pk.reference }),
      });
    });

    // 2. Percent of each peak.
    const pct = new Map<P, { v: Dec; line: string }>();
    const disregarded: { name: string; percent: Dec }[] = [];
    const isDisregarded = (v: Dec): boolean => disregard !== undefined && roundHalfUp(v, disregard.dp).lte(disregard.v);
    let lead = '';
    if (i.mode === 'area normalisation') {
      if (i.references !== undefined || i.sample !== undefined) refuse('Area normalisation uses no reference solution; remove it or use the external standard mode');
      const principals = ps.filter((p) => p.kind === 'principal');
      if (principals.length !== 1) refuse('Area normalisation needs exactly one principal peak');
      for (const p of ps) if (p.ref !== undefined) refuse(`${p.name}: a reference is named, but area normalisation uses none`);
      let kept = ps;
      let total = kept.reduce((s, p) => s.plus(p.corr), ZERO);
      if (total.isZero()) refuse('The total peak area is zero');
      const drop = kept.filter((p) => p.kind !== 'principal' && isDisregarded(p.corr.div(total).times(HUNDRED)));
      for (const p of drop) disregarded.push({ name: p.name, percent: p.corr.div(total).times(HUNDRED) });
      kept = kept.filter((p) => !drop.includes(p));
      total = kept.reduce((s, p) => s.plus(p.corr), ZERO);
      for (const p of kept) if (p.kind !== 'principal') pct.set(p, { v: p.corr.div(total).times(HUNDRED), line: `${p.line} ÷ total ${n(total, '')} × 100` });
      lead = `total area ${n(total, '')} (${kept.length} peaks${drop.length > 0 ? `; ${drop.length} at or below the disregard limit ${i.disregardLimit ?? ''} % left out` : ''})`;
    } else {
      const refs = i.references ?? [];
      if (refs.length === 0) refuse('The external standard mode needs a reference solution (a dilution of the test solution or a reference standard)');
      let sampleC: Conc | undefined;
      const sampleConc = (): Conc => {
        if (sampleC !== undefined) return sampleC;
        const s = i.sample;
        if (s === undefined) refuse('A reference standard is compared with the test solution: give the sample mass and dilution (or the test solution concentration)');
        if ('concentration' in s) {
          const p = parse(s.concentration, 'The test solution concentration');
          needKind(p, ['mass concentration'], 'The test solution concentration');
          positive(p, 'The test solution concentration');
          sampleC = { c: to(p, 'mg/mL'), line: `test solution ${p.text}` };
        } else {
          const m = parse(s.mass, 'The sample mass');
          needKind(m, ['mass'], 'The sample mass');
          positive(m, 'The sample mass');
          const d = readDilution(s.dilution, 'The sample', true);
          const c = to(m, 'mg').div(d.volume.times(d.ratio));
          sampleC = { c, line: `test solution ${m.text} ÷ (${d.text}) = ${withUnit(c, 'mg/mL')}` };
        }
        return sampleC;
      };
      const refNames = new Set<string>();
      const refOut = new Map<string, { r: Mean; factor: Dec; line: string }>();
      for (const rf of refs) {
        if (refNames.has(rf.name)) refuse(`The reference "${rf.name}" is given twice`);
        refNames.add(rf.name);
        const r = blanked(meanOf(rf.responses, `Reference "${rf.name}"`, 'peak area'), undefined, `Reference "${rf.name}"`, 'peak area', false);
        if ((rf.percentOfTest === undefined) === (rf.standard === undefined)) refuse(`Reference "${rf.name}": give either the % of the test solution it is diluted to, or the reference standard`);
        if (rf.percentOfTest !== undefined) {
          const p = percent(rf.percentOfTest, `Reference "${rf.name}", the % of the test solution`);
          if (!p.v.isPositive() || p.v.isZero()) refuse(`Reference "${rf.name}": the % of the test solution must be more than zero`);
          refOut.set(rf.name, { r, factor: p.v, line: `reference "${rf.name}" ${r.text} at ${p.text} of the test solution` });
        } else {
          const st = standardConcentration(rf.standard, `Reference "${rf.name}"`);
          const sc = sampleConc();
          const factor = st.c.div(sc.c).times(HUNDRED);
          refOut.set(rf.name, { r, factor, line: `reference "${rf.name}" ${r.text}; ${st.line}; ${sc.line}; reference = ${withUnit(factor, '%')} of the test solution` });
        }
      }
      const first = refs[0] as L4Reference;
      for (const p of ps) {
        if (p.kind === 'principal') continue;
        const rn = p.ref ?? first.name;
        const ro = refOut.get(rn);
        if (ro === undefined) refuse(`${p.name}: the reference "${rn}" is not given`);
        const v = p.corr.div(ro.r.v).times(ro.factor);
        if (isDisregarded(v)) {
          disregarded.push({ name: p.name, percent: v });
          continue;
        }
        pct.set(p, { v, line: `${p.line} ÷ ${n(ro.r.v, '')} × ${n(ro.factor, '%')} %${refs.length > 1 ? ` (reference "${rn}")` : ''}` });
      }
      lead = [...refOut.values()].map((r) => r.line).join('; ');
    }

    // 3. Impurities: named ones summed over their peaks (split peaks), each unknown on its own.
    const dp = i.decimals ?? 2;
    const imps: { name: string; kind: 'named' | 'unknown'; rrt?: string; v: Dec; peaks: number; lines: string[] }[] = [];
    for (const [p, x] of pct) {
      const same = p.kind === 'named' ? imps.find((m) => m.kind === 'named' && m.name === p.name) : undefined;
      if (same !== undefined) {
        same.v = same.v.plus(x.v);
        same.peaks += 1;
        same.lines.push(x.line);
      } else {
        imps.push({ name: p.name, kind: p.kind === 'named' ? 'named' : 'unknown', ...(p.rrt === undefined ? {} : { rrt: p.rrt }), v: x.v, peaks: 1, lines: [x.line] });
      }
    }
    const reported = (v: Dec): boolean => report === undefined || roundHalfUp(v, report.dp).gt(report.v);
    const impurities: L4Impurity[] = imps.map((m) => {
      const lim = m.kind === 'named' ? named.find((x) => x.name === m.name)?.limit : i.unknownLimit;
      const rep = reported(m.v);
      const head = m.peaks > 1 ? `${m.name} (${m.peaks} peaks summed): ${m.lines.join(' + ')}` : `${m.name}: ${m.lines[0] ?? ''}`;
      return {
        name: m.name, kind: m.kind, ...(m.rrt === undefined ? {} : { rrt: m.rrt }), percent: m.v, peaks: m.peaks, reported: rep,
        shown: `${head} = ${fmt(m.v, dp)} %${rep ? '' : ` (not above the reporting threshold ${i.reportingThreshold ?? ''} %: not reported)`}`,
        ...checkOf(m.v, '%', lim),
      };
    });
    const total = impurities.filter((m) => m.reported).reduce((s, m) => s.plus(m.percent), ZERO);

    const groups = (i.groups ?? []).map((g) => {
      if (g.members.length === 0) refuse(`The group "${g.name}" has no members`);
      if (named.length > 0) for (const mb of g.members) if (!names.has(mb)) refuse(`The group "${g.name}" names "${mb}", which is not an impurity of the method`);
      const v = impurities.filter((m) => m.kind === 'named' && g.members.includes(m.name) && m.reported).reduce((s, m) => s.plus(m.percent), ZERO);
      return { name: g.name, percent: v, ...checkOf(v, '%', g.limit) };
    });

    const unknowns = impurities.filter((m) => m.kind === 'unknown');
    const big = unknowns.reduce<L4Impurity | undefined>((b, m) => (b === undefined || m.percent.gt(b.percent) ? m : b), undefined);
    const largestUnknown = big === undefined ? undefined : { name: big.name, percent: big.percent, ...(big.check === undefined ? {} : { check: big.check }) };

    let countCheck: Check | undefined;
    if (i.countRule !== undefined) {
      const above = plain(i.countRule.above, 'The count rule threshold');
      const adp = writtenDecimals(i.countRule.above);
      if (!Number.isInteger(i.countRule.notMoreThan) || i.countRule.notMoreThan < 0) refuse('The count rule needs a whole number of peaks (0 or more)');
      const count = impurities.filter((m) => roundHalfUp(m.percent, adp).gt(above)).length;
      const pass = count <= i.countRule.notMoreThan;
      countCheck = {
        pass, level: pass ? 'pass' : 'fail', rounded: `${count} peaks`,
        shown: `${count} impurit${count === 1 ? 'y' : 'ies'} above ${i.countRule.above} %; not more than ${i.countRule.notMoreThan} allowed: ${pass ? 'within limits' : 'OUT OF LIMITS'}`,
      };
    }
    const totalCheck = checkOf(total, '%', i.limit);
    const allPass = [...impurities.map((m) => m.check), ...groups.map((g) => g.check), countCheck, totalCheck.check].every((c) => c === undefined || c.pass);

    const shown = [
      lead,
      ...impurities.map((m) => m.shown),
      ...groups.map((g) => `${g.name} = ${fmt(g.percent, dp)} %`),
      ...(largestUnknown === undefined ? [] : [`largest unknown: ${largestUnknown.name} = ${fmt(largestUnknown.percent, dp)} %`]),
      ...(excluded.length === 0 ? [] : [`excluded: ${excluded.map((x) => `${x.name} (${x.reason})`).join(', ')}`]),
      `total of impurities = ${fmt(total, dp)} %`,
    ].filter((x) => x !== '').join('; ');
    return {
      ok: true, value: total, unit: '%', shown, impurities, disregarded, excluded, groups,
      ...(largestUnknown === undefined ? {} : { largestUnknown }),
      ...(countCheck === undefined ? {} : { countCheck }),
      allPass, ...totalCheck,
    };
  });
}

// ---------------------------------------------------------------- L9 Residual solvents
export interface L9Solvent extends L1Measurement {
  readonly name: string;
  /** ICH Q3C class (1, 2 or 3), shown with the result. */
  readonly class?: 1 | 2 | 3;
  /** The solvent's limit (e.g. NMT 3000 ppm methanol, class 2). */
  readonly limit?: Limit;
}

export interface L9Input {
  /** The sample taken by mass, with its dilution (headspace vial volume or flask). */
  readonly sample: L1Sample;
  readonly solvents: readonly L9Solvent[];
  readonly decimals?: number;
  /** Limit on the sum of the solvents (e.g. class 3 solvents NMT 5000 ppm). */
  readonly limit?: Limit;
}

export interface L9Extra {
  readonly solvents: readonly { readonly name: string; readonly class?: 1 | 2 | 3; readonly ppm: Dec; readonly shown: string; readonly check?: Check }[];
  readonly allPass: boolean;
}

/** L9 Residual solvents: L1 per solvent in ppm (µg/g) of the sample, each against its class limit; value = their sum. */
export function l9ResidualSolvents(i: L9Input): Outcome<L9Extra> {
  return run(() => {
    if (i.solvents.length === 0) refuse('Give at least one solvent');
    if (i.sample.mass === undefined) refuse('Residual solvents in ppm need the sample taken by mass');
    const seen = new Set<string>();
    const dp = i.decimals ?? 0;
    const solvents = i.solvents.map((s) => {
      if (typeof s.name !== 'string' || s.name.trim() === '') refuse('Each solvent needs its name');
      if (seen.has(s.name)) refuse(`The solvent "${s.name}" is given twice`);
      seen.add(s.name);
      if (s.class !== undefined && ![1, 2, 3].includes(s.class)) refuse(`The solvent "${s.name}": the class must be 1, 2 or 3`);
      if (s.mode === 'specific absorbance') refuse(`The solvent "${s.name}": residual solvents are measured against a standard, not by specific absorbance`);
      let r: ReturnType<typeof l1>;
      try {
        r = l1({ ...s, sample: i.sample, per: 'mass', unit: 'ppm' });
      } catch (e) {
        if (e instanceof Refused) refuse(`${s.name}: ${e.message}`);
        throw e;
      }
      const cls = s.class === undefined ? '' : ` (class ${s.class})`;
      return { name: s.name, ...(s.class === undefined ? {} : { class: s.class }), ppm: r.value, shown: `${s.name}${cls}: ${r.shown} = ${fmt(r.value, dp)} ppm`, ...checkOf(r.value, 'ppm', s.limit) };
    });
    const value = solvents.reduce((t, s) => t.plus(s.ppm), ZERO);
    const totalCheck = checkOf(value, 'ppm', i.limit);
    const allPass = [...solvents.map((s) => s.check), totalCheck.check].every((c) => c === undefined || c.pass);
    const shown = `${solvents.map((s) => s.shown).join('; ')}; sum ${fmt(value, dp)} ppm`;
    return { ok: true, value, unit: 'ppm', shown, solvents, allPass, ...totalCheck };
  });
}

// ---------------------------------------------------------------- L20 Chromatographic adjustment check
export interface L20Conditions {
  /** Column length (mm or cm). */
  readonly length: Q;
  /** Column internal diameter (mm). */
  readonly diameter: Q;
  /** Particle size (µm). */
  readonly particleSize: Q;
  /** Default 'totally porous'. */
  readonly particle?: 'totally porous' | 'superficially porous';
  /** Plate number of the principal peak (needed when the particle type changes). */
  readonly plateNumber?: Q;
  /** Flow rate (mL/min). */
  readonly flow: Q;
  readonly injectionVolume?: Q;
  /** Gradient: the time points of the gradient table (min), from 0, in order. */
  readonly gradientTimes?: readonly Q[];
  /** Gradient: the system's dwell volume (mL); or measured from the step-gradient test. */
  readonly dwellVolume?: Q;
  /** Dwell volume from the step-gradient test: D = (t0.5 − 0.5 × tG) × F. */
  readonly dwellMeasurement?: { readonly tHalf: Q; readonly gradientTime: Q; readonly flow: Q };
}

export interface L20Input {
  /** Default 'liquid chromatography'. Gas chromatography is not covered (its ranges are C1 checks). */
  readonly technique?: 'liquid chromatography' | 'gas chromatography';
  readonly elution: 'isocratic' | 'gradient';
  /** The conditions written in the method. */
  readonly method: L20Conditions;
  /** The conditions actually used. */
  readonly actual: L20Conditions;
  readonly decimals?: number;
}

export type L20Status = 'within' | 'outside' | 'conditional';

export interface L20Item {
  readonly name: string;
  readonly status: L20Status;
  readonly shown: string;
}

export interface L20Extra {
  readonly items: readonly L20Item[];
  /** Change of L/dp, % of the method's. */
  readonly ldpChange: Dec;
  /** Adjusted flow F2 = F1 × (dc2² × dp1) ÷ (dc1² × dp2), mL/min. */
  readonly adjustedFlow: Dec;
  /** Adjusted injection volume = V1 × (L2 × dc2²) ÷ (L1 × dc1²), µL. */
  readonly adjustedInjectionVolume?: Dec;
  /** Gradient: factor on every time point = (F1 ÷ F2) × (L2 × dc2²) ÷ (L1 × dc1²). */
  readonly gradientFactor?: Dec;
  /** Gradient: the adjusted time points (min), with the dwell volume hold when it is positive. */
  readonly adjustedGradientTimes?: readonly Dec[];
  /** Gradient: (D1 × column volume ratio − D2) ÷ F2, min. Positive: add an isocratic hold; negative: delay the injection. */
  readonly dwellOffset?: Dec;
}

interface Col {
  L: Dec; // mm
  dc: Dec; // mm
  dp: Dec; // µm
  F: Parsed;
  f: Dec; // mL/min
  particle: 'totally porous' | 'superficially porous';
  text: string;
}

function readColumn(c: L20Conditions | undefined, who: string): Col {
  if (c === undefined) refuse(`The ${who} conditions are missing`);
  const len = parse(c.length, `The ${who} column length`);
  const dia = parse(c.diameter, `The ${who} column internal diameter`);
  const dp = parse(c.particleSize, `The ${who} particle size`);
  const F = parse(c.flow, `The ${who} flow rate`);
  for (const [p, w] of [[len, 'column length'], [dia, 'column internal diameter'], [dp, 'particle size']] as const) {
    needKind(p, ['length'], `The ${who} ${w}`);
    positive(p, `The ${who} ${w}`);
  }
  needKind(F, ['volume rate'], `The ${who} flow rate`);
  positive(F, `The ${who} flow rate`);
  const particle = c.particle ?? 'totally porous';
  if (particle !== 'totally porous' && particle !== 'superficially porous') refuse(`The ${who} particle type must be totally porous or superficially porous`);
  return { L: to(len, 'mm'), dc: to(dia, 'mm'), dp: to(dp, 'µm'), F, f: to(F, 'mL/min'), particle, text: `${len.text} × ${dia.text}, ${dp.text}` };
}

/** "Equal at the decimals the actual value is written with": the method value rounded to them is the limit. */
function sameAsWritten(actual: Parsed, target: Dec, unit: string): Check {
  const dp = decimalsOf(actual.text.split(' ')[0] ?? '');
  const t = roundHalfUp(target, dp).toFixed(dp);
  return checkLimit(to(actual, unit), unit, { low: t, high: t, unit });
}

/**
 * L20 Chromatographic adjustment check (Ph.Int 1.14.1, harmonised with Ph. Eur. 2.2.46 and USP <621>), liquid
 * chromatography: L/dp within −25 % to +50 % (or the plate number for a change to superficially porous particles);
 * flow scaled by the column diameter and particle size (isocratic: ± 50 % more; gradient: no further change);
 * injection volume scaled by the column volume; gradient time points scaled; dwell volume compensated.
 */
export function l20ChromAdjustment(i: L20Input): Outcome<L20Extra> {
  return run(() => {
    if ((i.technique ?? 'liquid chromatography') !== 'liquid chromatography') {
      refuse('L20 covers liquid chromatography only. Gas chromatography adjustments (column length, internal diameter, film thickness, flow, oven temperatures) are checked against the method with C1 ranges');
    }
    if (i.elution !== 'isocratic' && i.elution !== 'gradient') refuse('Say whether the method is isocratic or gradient');
    const gradient = i.elution === 'gradient';
    const m = readColumn(i.method, 'method');
    const a = readColumn(i.actual, 'actual');
    const items: L20Item[] = [];
    const add = (name: string, status: L20Status, shown: string): void => {
      items.push({ name, status, shown: `${name}: ${shown}` });
    };

    // Column: L/dp, or the plate number for a change to superficially porous particles.
    const ldpChange = a.L.div(a.dp).div(m.L.div(m.dp)).times(HUNDRED).minus(HUNDRED);
    const ldpCheck = checkLimit(ldpChange, '%', { low: '-25', high: '50', unit: '%' });
    const ldpLine = `L/dp ${n(m.L.div(m.dp), '')} → ${n(a.L.div(a.dp), '')}, change ${fmt(ldpChange, 1)} %; allowed −25 % to +50 %`;
    if (m.particle === 'superficially porous' && a.particle === 'totally porous') {
      refuse('A change from superficially porous to totally porous particles is not an allowed adjustment; the method must be revalidated or the original column type used');
    }
    if (m.particle !== a.particle) {
      if (i.method.plateNumber === undefined || i.actual.plateNumber === undefined) {
        refuse('A change from totally porous to superficially porous particles is judged by the plate number: give the plate number on the method\'s column and on the column used');
      }
      const n1 = parse(i.method.plateNumber, 'The method plate number');
      const n2 = parse(i.actual.plateNumber, 'The actual plate number');
      needKind(n1, ['number', 'count'], 'The method plate number');
      needKind(n2, ['number', 'count'], 'The actual plate number');
      positive(n1, 'The method plate number');
      positive(n2, 'The actual plate number');
      const nChange = n2.v.div(n1.v).times(HUNDRED).minus(HUNDRED);
      const ck = checkLimit(nChange, '%', { low: '-25', high: '50', unit: '%' });
      add('column (superficially porous particles)', ck.pass ? 'within' : 'outside', `plate number ${n1.text} → ${n2.text}, change ${fmt(nChange, 1)} %; allowed −25 % to +50 % (${ck.pass ? 'within' : 'OUTSIDE'}); ${ldpLine.replace('; allowed −25 % to +50 %', '')}`);
    } else {
      add('column length and particle size', ldpCheck.pass ? 'within' : 'outside', `${m.text} → ${a.text}; ${ldpLine} (${ldpCheck.pass ? 'within' : 'OUTSIDE'})`);
    }

    // Flow rate.
    const adjustedFlow = m.f.times(a.dc.pow(2)).times(m.dp).div(m.dc.pow(2).times(a.dp));
    const flowLine = `adjusted ${m.F.text} × (${n(a.dc, 'mm')}² × ${n(m.dp, 'µm')}) ÷ (${n(m.dc, 'mm')}² × ${n(a.dp, 'µm')}) = ${withUnit(adjustedFlow, 'mL/min')}`;
    if (gradient) {
      const ck = sameAsWritten(a.F, adjustedFlow, 'mL/min');
      add('flow rate', ck.pass ? 'within' : 'outside', `${flowLine}; used ${a.F.text}; a gradient method allows no further change (${ck.pass ? 'within' : 'OUTSIDE'})`);
    } else {
      const dev = a.f.div(adjustedFlow).times(HUNDRED).minus(HUNDRED);
      const ck = checkLimit(dev, '%', { low: '-50', high: '50', unit: '%' });
      add('flow rate', ck.pass ? 'within' : 'outside', `${flowLine}; used ${a.F.text}, ${fmt(dev, 1)} % of it; a further ± 50 % is allowed (${ck.pass ? 'within' : 'OUTSIDE'})`);
    }

    // Injection volume.
    const volRatio = a.L.times(a.dc.pow(2)).div(m.L.times(m.dc.pow(2)));
    let adjustedInjectionVolume: Dec | undefined;
    if (i.method.injectionVolume !== undefined || i.actual.injectionVolume !== undefined) {
      if (i.method.injectionVolume === undefined || i.actual.injectionVolume === undefined) refuse('Give the injection volume of the method and the one used');
      const v1 = parse(i.method.injectionVolume, 'The method injection volume');
      const v2 = parse(i.actual.injectionVolume, 'The actual injection volume');
      needKind(v1, ['volume'], 'The method injection volume');
      needKind(v2, ['volume'], 'The actual injection volume');
      positive(v1, 'The method injection volume');
      positive(v2, 'The actual injection volume');
      adjustedInjectionVolume = to(v1, 'µL').times(volRatio);
      const ck = sameAsWritten(v2, adjustedInjectionVolume, 'µL');
      const line = `adjusted ${v1.text} × (${n(a.L, 'mm')} × ${n(a.dc, 'mm')}²) ÷ (${n(m.L, 'mm')} × ${n(m.dc, 'mm')}²) = ${withUnit(adjustedInjectionVolume, 'µL')}; used ${v2.text}`;
      if (ck.pass) add('injection volume', 'within', `${line} (within)`);
      else add('injection volume', 'conditional', `${line}: allowed only when system suitability (precision, sensitivity, linearity, resolution) is met`);
    }

    // Gradient time points and dwell volume.
    let gradientFactor: Dec | undefined;
    let adjustedGradientTimes: Dec[] | undefined;
    let dwellOffset: Dec | undefined;
    const g1 = i.method.gradientTimes;
    const g2 = i.actual.gradientTimes;
    const dwellGiven = [i.method.dwellVolume, i.method.dwellMeasurement, i.actual.dwellVolume, i.actual.dwellMeasurement].some((x) => x !== undefined);
    if (!gradient) {
      if (g1 !== undefined || g2 !== undefined) refuse('Gradient time points are given, but the method is isocratic');
      if (dwellGiven) refuse('The dwell volume applies to gradient methods only');
    } else {
      if (g1 === undefined || g1.length < 2) refuse('A gradient method needs the time points of its gradient table (at least two, from 0 min)');
      const times = g1.map((q, k) => {
        const t = parse(q, `Gradient time point ${k + 1}`);
        needKind(t, ['time'], `Gradient time point ${k + 1}`);
        if (t.v.isNegative()) refuse(`Gradient time point ${k + 1} cannot be negative`);
        return to(t, 'min');
      });
      if (!(times[0] as Dec).isZero()) refuse('The gradient table must start at 0 min');
      times.forEach((t, k) => {
        if (k > 0 && t.lte(times[k - 1] as Dec)) refuse(`Gradient time point ${k + 1} (${n(t, 'min', 3)} min) is not after the one before it`);
      });
      gradientFactor = m.f.div(a.f).times(volRatio);
      const scaled = times.map((t) => t.times(gradientFactor as Dec));
      adjustedGradientTimes = scaled;
      const gLine = `factor (${m.F.text} ÷ ${a.F.text}) × (${n(a.L, 'mm')} × ${n(a.dc, 'mm')}²) ÷ (${n(m.L, 'mm')} × ${n(m.dc, 'mm')}²) = ${n(gradientFactor, '')}`;

      // Dwell volume.
      const dwell = (c: L20Conditions, who: string): Dec | undefined => {
        if (c.dwellVolume !== undefined && c.dwellMeasurement !== undefined) refuse(`The ${who} dwell volume: give the volume or the step-gradient measurement, not both`);
        if (c.dwellVolume !== undefined) {
          const d = parse(c.dwellVolume, `The ${who} dwell volume`);
          needKind(d, ['volume'], `The ${who} dwell volume`);
          if (d.v.isNegative()) refuse(`The ${who} dwell volume cannot be negative`);
          return to(d, 'mL');
        }
        if (c.dwellMeasurement !== undefined) {
          const th = parse(c.dwellMeasurement.tHalf, `The ${who} dwell measurement, t0.5`);
          const tg = parse(c.dwellMeasurement.gradientTime, `The ${who} dwell measurement, gradient time`);
          const f = parse(c.dwellMeasurement.flow, `The ${who} dwell measurement, flow rate`);
          needKind(th, ['time'], `The ${who} dwell measurement, t0.5`);
          needKind(tg, ['time'], `The ${who} dwell measurement, gradient time`);
          needKind(f, ['volume rate'], `The ${who} dwell measurement, flow rate`);
          positive(f, `The ${who} dwell measurement, flow rate`);
          const tD = to(th, 'min').minus(to(tg, 'min').times(HALF));
          if (!tD.isPositive() || tD.isZero()) refuse(`The ${who} dwell measurement: t0.5 must be more than half the gradient time (tD = t0.5 − 0.5 × tG)`);
          return tD.times(to(f, 'mL/min'));
        }
        return undefined;
      };
      const d1 = dwell(i.method, 'method');
      const d2 = dwell(i.actual, 'actual');
      if ((d1 === undefined) !== (d2 === undefined)) refuse('The dwell volume compensation needs the dwell volume of the method\'s system and of the system used');
      let dLine = '';
      if (d1 !== undefined && d2 !== undefined) {
        dwellOffset = d1.times(volRatio).minus(d2).div(a.f);
        const how = dwellOffset.isZero()
          ? 'no change'
          : dwellOffset.isPositive()
            ? `add an isocratic hold of ${t(dwellOffset)} min at the start (the gradient time points move later)`
            : `start the gradient ${t(dwellOffset.abs())} min before the injection (delay the injection)`;
        dLine = `; dwell volume (${n(d1, 'mL')} mL × ${n(volRatio, '')} − ${n(d2, 'mL')} mL) ÷ ${n(a.f, 'mL/min')} mL/min = ${t(dwellOffset)} min: ${how}`;
        if (dwellOffset.isPositive() && !dwellOffset.isZero()) adjustedGradientTimes = [ZERO, ...scaled.map((t) => t.plus(dwellOffset as Dec))];
      }
      const table = adjustedGradientTimes.map((x) => t(x)).join(', ');
      if (g2 === undefined) {
        add('gradient time points', 'within', `${gLine}; adjusted table ${table} min${dLine}`);
      } else {
        if (g2.length !== adjustedGradientTimes.length) refuse(`The gradient table used has ${g2.length} time points; the adjusted table has ${adjustedGradientTimes.length}`);
        const bad: number[] = [];
        g2.forEach((q, k) => {
          const t = parse(q, `Gradient time point used ${k + 1}`);
          needKind(t, ['time'], `Gradient time point used ${k + 1}`);
          if (!sameAsWritten(t, adjustedGradientTimes?.[k] as Dec, 'min').pass) bad.push(k + 1);
        });
        add('gradient time points', bad.length === 0 ? 'within' : 'outside', `${gLine}; adjusted table ${table} min${dLine}; ${bad.length === 0 ? 'the table used matches (within)' : `time point${bad.length > 1 ? 's' : ''} ${bad.join(', ')} of the table used do not match (OUTSIDE)`}`);
      }
    }

    const outside = items.filter((x) => x.status === 'outside').length;
    const conditional = items.filter((x) => x.status === 'conditional').length;
    const level = outside > 0 ? 'fail' : conditional > 0 ? 'alert' : 'pass';
    const summary = outside > 0
      ? `${outside} of ${items.length} changes outside the allowed adjustments: OUT OF LIMITS`
      : conditional > 0
        ? `within the allowed adjustments, but ${conditional} change${conditional > 1 ? 's need' : ' needs'} system suitability: ALERT`
        : `all ${items.length} changes within the allowed adjustments`;
    const check: Check = { pass: outside === 0, level, rounded: `${items.length - outside} of ${items.length} within`, shown: summary };
    return {
      ok: true, value: adjustedFlow, unit: 'mL/min', shown: `${items.map((x) => x.shown).join('; ')}; ${summary}`, check, items, ldpChange, adjustedFlow,
      ...(adjustedInjectionVolume === undefined ? {} : { adjustedInjectionVolume }),
      ...(gradientFactor === undefined ? {} : { gradientFactor }),
      ...(adjustedGradientTimes === undefined ? {} : { adjustedGradientTimes }),
      ...(dwellOffset === undefined ? {} : { dwellOffset }),
    };
  });
}
