/**
 * Lab calculation templates, physical-chemical part (Medhanta LIMS library v1, section 3b):
 * L5 Dissolution, L6 Titration, L7 Water by Karl Fischer, L8 Mass loss / residue, L10 Readings with a fixed rule,
 * L14 Statistics, L17 Standardisation, L19 Sampling plan size.
 *
 * Same rules as every template (README): inputs are text with units, exact decimals, a plain-English refusal,
 * nothing rounded inside a calculation; pharmacopoeia rounding only when a limit is checked (C1).
 * Pharmacopoeia rules are paraphrased; no chapter text is copied.
 */
import { checkOf, Dec, fmt, given, HUNDRED, needKind, ONE, parse, percent, refuse, run, sameKind, show, shownNumber, to, unitOf, ZERO, type Outcome, type Parsed, type Q } from './core.js';
import { standardSolution, type L1Standard } from './lab-assay.js';
import { c6StagedTest, type C6Input } from './staged.js';
import { checkLimit, type Check, type Limit } from './rounding.js';
import { noFurtherChange, readSeries, stats, type ChangeLimit, type Series, type Stats } from './series.js';
import { ethanolDensity } from './mixing.js';

const d = (x: string | number): Dec => new Dec(x);
const positive = (p: Parsed, what: string): void => {
  if (!p.v.isPositive() || p.v.isZero()) refuse(`${what} must be more than zero`);
};
const notNegative = (p: Parsed, what: string): void => {
  if (p.v.isNegative() && !p.v.isZero()) refuse(`${what} cannot be negative`);
};
/** A plain number such as a factor or a dilution ("1.0023"), with or without the empty unit. */
const plain = (text: string, what: string): Parsed => {
  const p = parse(text, what);
  needKind(p, ['number'], what);
  return p;
};

// ---------------------------------------------------------------- shared: result unit and basis
/** The unit a content result is reported in: % (default), mg/g, g/g, ppm or % w/w. */
function fractionUnit(u: string | undefined): string {
  const unit = unitOf(u ?? '%');
  if (unit.kind !== 'fraction') refuse(`A content result is reported as a fraction of the sample (%, mg/g, g/g or ppm), not in ${unit.symbol}`);
  return unit.symbol;
}
const fromPercent = (v: Dec, unit: string): Dec => to({ v, unit: unitOf('%'), text: '' }, unit);
/** A computed number in a worked line: as it is when it has at most 4 decimals, otherwise cut (the core rule). */
const num = (v: Dec, unit: string): string => shownNumber(v, unit, { written: v.toString() });

/**
 * A result recalculated on the dried, anhydrous, ignited or solvent-free basis with the sample's own LOD / water /
 * solvent result: value × 100 ÷ (100 − loss − solvents). Safety rule S3: a sample that was dried before weighing is
 * already on the dried basis; the LOD again would count it twice.
 */
export interface Basis {
  readonly as: 'dried' | 'anhydrous' | 'ignited' | 'anhydrous and solvent-free';
  /** The sample's own LOD, water or loss on ignition, in %. */
  readonly loss: Q;
  /** Residual solvents in %, for 'anhydrous and solvent-free'. */
  readonly solvents?: Q;
  /** true when the sample was dried (or ignited) before it was weighed for this test. */
  readonly sampleAlreadyDried?: boolean;
}

function applyBasis(v: Dec, b: Basis | undefined): { v: Dec; line: string } {
  // A basis whose settings were all left out is no basis.
  if (!given(b)) return { v, line: '' };
  if (b.as === undefined) refuse('The sample\'s loss on drying, water or loss on ignition is given, but no basis: say which basis the result is on, or leave it out');
  if (b.sampleAlreadyDried === true && (b.as === 'dried' || b.as === 'ignited')) {
    refuse(`The sample was dried before weighing, so the result is already on the ${b.as} basis: correcting it with the LOD again counts the loss twice (safety rule S3). Remove the basis correction, or weigh the sample as it is`);
  }
  const loss = percent(b.loss, `The ${b.as === 'anhydrous' || b.as === 'anhydrous and solvent-free' ? 'water' : b.as === 'ignited' ? 'loss on ignition' : 'loss on drying'} result`);
  const solv = b.as === 'anhydrous and solvent-free' ? (b.solvents === undefined ? refuse('The anhydrous and solvent-free basis needs the residual solvents result') : percent(b.solvents, 'The residual solvents result')) : undefined;
  const sum = loss.v.plus(solv?.v ?? ZERO);
  if (loss.v.isNegative() || (solv?.v.isNegative() ?? false) || sum.gte(HUNDRED)) refuse('The loss, water or solvent result must be from 0 to less than 100 %');
  const out = v.times(HUNDRED).div(HUNDRED.minus(sum));
  return { v: out, line: ` × 100 ÷ (100 − ${loss.text}${solv ? ` − ${solv.text}` : ''}) on the ${b.as} basis` };
}

// ================================================================ L5 Dissolution
/**
 * L5 Dissolution: % dissolved (or the amount released) per vessel at each time point.
 *
 * Concentration in the vessel at a time point: C = sample response ÷ standard response × standard concentration ×
 * the sample dilution. The amount dissolved by then is what is in the vessel now plus everything taken out before:
 *   amount = carried + C × V(now) + Σ C(earlier) × aliquot(earlier)
 * Volume modes (USP <711>, Ph.Int 5.5, paraphrased):
 *   'replace and correct'    : each aliquot is replaced with fresh medium: V stays; the drug in earlier aliquots is added.
 *   'no replacement'         : the volume falls by each aliquot: V(now) = V − Σ earlier aliquots; earlier aliquots added.
 *   'replace, no correction' : the method replaces and says not to correct: amount = C × V only.
 * Stages (delayed release, media changes): a stage after the first either 'add medium' (Method A: 750 mL acid + 250 mL
 * buffer: the drug already dissolved stays in the vessel; V grows by the volume added) or 'drain' (Method B, media
 * changes: a new medium of its own volume). After a drain the master must say whether the earlier amount is added
 * ('add earlier amount': cumulative release) or not ('this stage only'). Safety rule S9: the buffer volume after the
 * addition, and the acid-stage amount for a cumulative result, are never left to the analyst.
 * All aliquots count, whichever analyte they were taken for (two actives from one vessel set).
 *
 * The stage decision (S1-S3, L1-L3, A/B) is C6's: `atTime[k]` gives the vessels' results at time point k as text for
 * C6 'dissolution IR'/'DR'; `perVessel` gives each vessel's results at every time point for C6 'dissolution ER'.
 * Tier 1 and Tier 2 (with enzyme) are two separate runs of L5, each with its own `label`; when the method sends a Tier 1
 * failure to Tier 2, that is the workflow's matter (owner, 18 Nov 2026: no OOS is opened).
 */
export type VolumeMode = 'replace and correct' | 'no replacement' | 'replace, no correction';

export interface L5Stage {
  /** e.g. "acid", "buffer pH 6.8". */
  readonly name: string;
  /** First stage: the medium volume. A stage after a drain: the new medium's volume. */
  readonly volume?: Q;
  /** How a stage after the first starts (required from the second stage on). */
  readonly change?: 'add medium' | 'drain';
  /** 'add medium': the volume added (e.g. 250 mL of 0.2 M trisodium phosphate). */
  readonly added?: Q;
  /** 'drain': add the amount released in the earlier media (cumulative), or report this stage on its own. */
  readonly earlier?: 'add earlier amount' | 'this stage only';
  /** This stage's own volume mode (default: the test's). */
  readonly volumeMode?: VolumeMode;
  /** The time points of this stage, with the aliquot taken at each. */
  readonly times: readonly { readonly time: Q; readonly aliquot: Q }[];
}

/**
 * The acceptance of the test by C6 on this run's own per-vessel results (a later calculation sees only the mean):
 * immediate release S1-S3 and the delayed-release buffer stage B1-B3 with Q the lower bound of `limit`; the
 * delayed-release acid stage A1-A3 with its upper bound (default 10 %); extended release L1-L3 with one range per time
 * point. The vessel sets are the dissolution stages of `byTime` (6, then 6 more, then 12 more). Left out when not given.
 */
export interface L5Acceptance {
  readonly test?: 'dissolution IR' | 'dissolution DR acid' | 'dissolution DR buffer' | 'dissolution ER';
  readonly limit?: Limit;
  readonly ranges?: readonly Limit[];
}

export interface L5Input {
  /** The labelled content per unit (tablet, capsule, dose, patch): a mass, never a delivery rate. */
  readonly labelClaim: Q;
  /**
   * The standard: its response (or replicate responses, averaged) and its concentration as L1 works it out, or the
   * standard as prepared (weighed amount, potency and its basis, flask and dilution), from which it is worked out here.
   */
  readonly standard: { readonly responses: readonly Q[]; readonly concentration?: Q; readonly prepared?: L1Standard };
  /** Dilution factor of the sample before measuring (default 1): a plain number, or the dilute step's factor. */
  readonly dilution?: Q;
  readonly volumeMode: VolumeMode;
  readonly stages: readonly L5Stage[];
  /** One entry per vessel: its responses at every time point, stage after stage (or `byTime`). */
  readonly vessels?: readonly { readonly name?: string; readonly responses: readonly Q[] }[];
  /**
   * The responses as a step records them: for each time point, for each dissolution stage (6 vessels, 6 more, 12 more)
   * the responses of its vessels, in the same vessel order at every time point. A time point the method does not have
   * is left empty.
   */
  readonly byTime?: readonly (readonly (readonly Q[])[])[];
  readonly acceptance?: L5Acceptance;
  /** % of label claim (default), the amount released per unit, or per area (transdermal: give `area`). */
  readonly express?: '% of label claim' | 'amount per unit' | 'amount per area';
  readonly area?: Q;
  /** What this run is, for the worked line: "Tier 1", "Tier 2 (with pancreatin)". */
  readonly label?: string;
  /** The time point whose mean is the template's value, as written in a stage (default: the last). */
  readonly reportAt?: string;
  readonly decimals?: number;
}

export interface L5Point {
  readonly stage: string;
  readonly time: string;
  readonly mean: Dec;
  readonly sd?: Dec;
  readonly rsd?: Dec;
  readonly min: Dec;
  readonly max: Dec;
}

export interface L5Extra {
  /** With an acceptance: the stage decision (C6). */
  readonly decision?: 'pass' | 'next stage' | 'fail';
  readonly stageReached?: number;
  readonly nextStageUnits?: number;
  readonly points: readonly L5Point[];
  readonly vessels: readonly { readonly name: string; readonly results: readonly Dec[]; readonly amounts: readonly Dec[] }[];
  /** For C6 IR/DR: atTime[k] = every vessel's result at time point k, as text (full precision). */
  readonly atTime: readonly (readonly string[])[];
  /** For C6 ER: perVessel[v] = vessel v's result at every time point, as text. */
  readonly perVessel: readonly (readonly string[])[];
}

const RATE = /\/\s*(24\s*h|\d*\s*h|d|day|hour)\b|per\s+(day|24\s*h)/i;

export function l5Dissolution(i: L5Input): Outcome<L5Extra> {
  return run(() => {
    const express = i.express ?? '% of label claim';
    if (typeof i.labelClaim === 'string' && RATE.test(i.labelClaim)) {
      refuse(`The label claim "${i.labelClaim}" is a delivery rate. Release is expressed against the labelled content per unit (per patch), never against the delivery rate (safety rule S9): give the content per unit`);
    }
    const claim = parse(i.labelClaim, 'The label claim');
    if (claim.unit.kind === 'mass rate') refuse('The label claim is a rate: give the labelled content per unit (safety rule S9)');
    needKind(claim, ['mass'], 'The label claim');
    positive(claim, 'The label claim');
    let area: Parsed | undefined;
    if (express === 'amount per area') {
      if (i.area === undefined) refuse('The amount released per area needs the area of the unit (e.g. "10 cm²")');
      area = parse(i.area, 'The area');
      needKind(area, ['area'], 'The area');
      positive(area, 'The area');
    }
    if ((i.vessels === undefined) === (i.byTime === undefined)) refuse('Give the vessel responses either per vessel or per time point, not both');
    if (i.standard.responses.length === 0) refuse('Give the standard response');
    const sr = i.standard.responses.map((q, n) => parse(q, `Standard response ${n + 1}`));
    sameKind(sr, 'The standard responses');
    const stdResp = sr.reduce((s, p) => s.plus(to(p, sr[0]!.unit)), ZERO).div(sr.length);
    if (!stdResp.isPositive() || stdResp.isZero()) refuse('The standard response must be more than zero');
    const prepared = given(i.standard.prepared) ? i.standard.prepared : undefined;
    if ((i.standard.concentration === undefined) === (prepared === undefined)) refuse('Give the standard\'s concentration, or the standard as prepared (weighed amount, potency, flask and dilution), one of them');
    let cStd: Dec;
    let scText: string;
    if (prepared !== undefined) {
      const st = standardSolution(prepared);
      cStd = st.c;
      scText = `${num(st.c, 'mg/mL')} mg/mL (${st.line})`;
    } else {
      const sc = parse(i.standard.concentration as Q, 'The standard concentration');
      needKind(sc, ['mass concentration'], 'The standard concentration');
      positive(sc, 'The standard concentration');
      cStd = to(sc, 'mg/mL');
      scText = sc.text;
    }
    let dil = ONE;
    if (i.dilution !== undefined) {
      const dp = parse(i.dilution, 'The sample dilution');
      needKind(dp, ['number', 'count'], 'The sample dilution');
      dil = dp.v;
    }
    if (!dil.isPositive() || dil.isZero()) refuse('The sample dilution must be more than zero');
    if (i.stages.length === 0) refuse('Give at least one stage with its time points');

    // The plan of the run: per time point its stage, volume rule and aliquot.
    interface Step { stage: L5Stage; s: number; time: Parsed; aliquot: Dec; mode: VolumeMode }
    const steps: Step[] = [];
    i.stages.forEach((st, s) => {
      if (st.times.length === 0) refuse(`The ${st.name} stage has no time points`);
      if (s === 0) {
        if (st.change !== undefined) refuse(`The first stage (${st.name}) cannot start by "${st.change}": give its medium volume`);
        if (st.volume === undefined) refuse(`Give the medium volume of the ${st.name} stage`);
      } else if (st.change === 'add medium') {
        if (st.added === undefined) refuse(`The ${st.name} stage adds medium: give the volume added (e.g. "250 mL"), or the result is calculated on the wrong volume (safety rule S9)`);
        if (st.volume !== undefined) refuse(`The ${st.name} stage adds medium to the vessel: give the volume added, not a new volume`);
      } else if (st.change === 'drain') {
        if (st.volume === undefined) refuse(`The ${st.name} stage starts with a new medium: give its volume`);
        if (st.earlier === undefined) refuse(`The ${st.name} stage starts after the earlier medium was drained: say whether the amount released before is added (cumulative release) or this stage is reported on its own (safety rule S9)`);
      } else {
        refuse(`Say how the ${st.name} stage starts: "add medium" (to the same vessel) or "drain" (a new medium)`);
      }
      let last: Dec | undefined;
      st.times.forEach((t, k) => {
        const time = parse(t.time, `The ${st.name} time point ${k + 1}`);
        needKind(time, ['time'], `The ${st.name} time point ${k + 1}`);
        const tm = to(time, 'min');
        if (last !== undefined && !tm.gt(last)) refuse(`The time points of the ${st.name} stage must rise (${time.text} is not after the one before)`);
        last = tm;
        const a = parse(t.aliquot, `The aliquot at ${time.text}`);
        needKind(a, ['volume'], `The aliquot at ${time.text}`);
        notNegative(a, `The aliquot at ${time.text}`);
        steps.push({ stage: st, s, time, aliquot: to(a, 'mL'), mode: st.volumeMode ?? i.volumeMode });
      });
    });
    let reportIdx = steps.length - 1;
    if (i.reportAt !== undefined) {
      const want = to(parse(i.reportAt, 'The reported time point'), 'min');
      reportIdx = steps.findIndex((x) => to(x.time, 'min').eq(want));
      if (reportIdx < 0) refuse(`The reported time point ${i.reportAt} is not one of the time points`);
    }
    // The vessel sets (dissolution stages) and each vessel's responses at every time point.
    let sets: number[] = [];
    let given5: readonly { readonly name?: string; readonly responses: readonly Q[] }[];
    if (i.byTime !== undefined) {
      if (i.byTime.slice(steps.length).some((t) => t.some((v) => v.length > 0))) refuse(`Responses are given for more time points than the method has (${steps.length})`);
      const used = i.byTime.slice(0, steps.length);
      if (used.length < steps.length) refuse(`Give the responses at each of the ${steps.length} time points`);
      used.forEach((t, k) => { if (t.length === 0 || t.every((v) => v.length === 0)) refuse(`Give the vessel responses at ${steps[k]!.time.text}`); });
      sets = (used[0] ?? []).map((v) => v.length);
      used.forEach((t, k) => {
        const here = t.map((v) => v.length);
        if (here.join() !== sets.join()) refuse(`At ${steps[k]!.time.text} the vessels are ${here.join(' + ')}, at ${steps[0]!.time.text} ${sets.join(' + ')}: every time point needs the same vessels`);
      });
      const n = sets.reduce((a, b) => a + b, 0);
      given5 = Array.from({ length: n }, (_, vn) => {
        let set = 0;
        let left = vn;
        while (left >= (sets[set] ?? 0)) { left -= sets[set] ?? 0; set += 1; }
        return { responses: used.map((t) => (t[set] as readonly Q[])[left] as Q) };
      });
    } else {
      given5 = i.vessels ?? [];
      sets = [given5.length];
    }
    if (given5.length === 0) refuse('Give the results of at least one vessel');

    const vessels = given5.map((ves, vn) => {
      const name = ves.name ?? `vessel ${vn + 1}`;
      if (ves.responses.length !== steps.length) refuse(`${name} needs ${steps.length} responses (one per time point); ${ves.responses.length} were given`);
      let V = ZERO;
      let removed = ZERO;
      let carried = ZERO;
      let lastAmount = ZERO;
      const amounts: Dec[] = [];
      steps.forEach((st, k) => {
        if (k === 0 || steps[k - 1]!.s !== st.s) {
          const g = st.stage;
          if (st.s === 0) V = to(parse(g.volume as Q, `The ${g.name} volume`), 'mL');
          else if (g.change === 'add medium') {
            const add = parse(g.added as Q, `The volume added at the ${g.name} stage`);
            needKind(add, ['volume'], `The volume added at the ${g.name} stage`);
            positive(add, `The volume added at the ${g.name} stage`);
            V = V.plus(to(add, 'mL'));
          } else {
            const nv = parse(g.volume as Q, `The ${g.name} volume`);
            needKind(nv, ['volume'], `The ${g.name} volume`);
            V = to(nv, 'mL');
            carried = g.earlier === 'add earlier amount' ? lastAmount : ZERO;
            removed = ZERO;
          }
          if (!V.isPositive() || V.isZero()) refuse(`The medium volume of the ${g.name} stage must be more than zero`);
        }
        const r = parse(ves.responses[k] as Q, `${name} response at ${st.time.text}`);
        sameKind([r, sr[0]!], `${name} response at ${st.time.text}`);
        notNegative(r, `${name} response at ${st.time.text}`);
        const C = to(r, sr[0]!.unit).div(stdResp).times(cStd).times(dil);
        const amount = st.mode === 'replace, no correction' ? carried.plus(C.times(V)) : carried.plus(C.times(V)).plus(removed);
        amounts.push(amount);
        lastAmount = amount;
        if (st.aliquot.gte(V)) refuse(`The aliquot at ${st.time.text} (${fmt(st.aliquot, 1)} mL) is not less than the volume left in the vessel (${fmt(V, 1)} mL)`);
        removed = removed.plus(C.times(st.aliquot));
        if (st.mode === 'no replacement') V = V.minus(st.aliquot);
      });
      const results = amounts.map((a) =>
        express === '% of label claim' ? a.div(to(claim, 'mg')).times(HUNDRED) : express === 'amount per area' ? a.div(to(area as Parsed, 'cm²')) : a);
      return { name, results, amounts };
    });

    const unit = express === '% of label claim' ? '%' : express === 'amount per area' ? 'mg/cm²' : 'mg';
    const dp = i.decimals ?? (unit === '%' ? 1 : unit === 'mg' ? 3 : 4);
    const points: L5Point[] = steps.map((st, k) => {
      const s: Stats = stats(vessels.map((v) => ({ v: v.results[k] ?? ZERO, unit: unitOf(unit), text: '' })));
      return { stage: st.stage.name, time: st.time.text, mean: s.mean, min: s.min, max: s.max, ...(s.sd ? { sd: s.sd } : {}), ...(s.rsd ? { rsd: s.rsd } : {}) };
    });
    const atTime = steps.map((_, k) => vessels.map((v) => (v.results[k] ?? ZERO).toString()));
    const perVessel = vessels.map((v) => v.results.map((x) => x.toString()));
    const modes = [...new Set(steps.map((s) => s.mode))].join(' / ');
    const head = `${i.label ? `${i.label}: ` : ''}${vessels.length} vessel${vessels.length === 1 ? '' : 's'}; C = response ÷ ${fmt(stdResp, 4)} × ${scText}${dil.eq(1) ? '' : ` × ${dil.toString()}`}; volume ${modes}`;
    const stageLines = i.stages.length > 1
      ? `; ${i.stages.map((g, s) => (s === 0 ? `${g.name} ${parse(g.volume as Q, 'volume').text}` : g.change === 'add medium' ? `${g.name}: + ${parse(g.added as Q, 'added').text}` : `${g.name}: drained, ${parse(g.volume as Q, 'volume').text}${g.earlier === 'add earlier amount' ? ', earlier amount added' : ', this stage only'}`)).join(', ')}`
      : `; ${parse(i.stages[0]!.volume as Q, 'volume').text}`;
    const pts = points.map((p) => `${p.stage === steps[0]!.stage.name && i.stages.length === 1 ? '' : `${p.stage} `}${p.time}: mean ${show(p.mean, unit, dp)} (${fmt(p.min, dp)}-${fmt(p.max, dp)})`).join('; ');
    const reported = points[reportIdx]!;
    const shown = `${head}${stageLines}. ${pts}${express === '% of label claim' ? ` (of ${claim.text})` : ''}`;
    const acc = given(i.acceptance) ? i.acceptance : undefined;
    if (acc === undefined) return { ok: true, value: reported.mean, unit, points, vessels, atTime, perVessel, shown };
    // C6 on the vessels' own results, set by set (the stages of the test).
    if (acc.test === undefined) refuse('A dissolution limit is given, but not the acceptance test (immediate, extended or delayed release)');
    if (express !== '% of label claim') refuse('The stage rules of the dissolution test apply to the % of label claim dissolved');
    const bySet = <X>(xs: readonly X[]): X[][] => {
      const out: X[][] = [];
      let at = 0;
      for (const n of sets) { out.push(xs.slice(at, at + n)); at += n; }
      return out;
    };
    const bound = (which: 'low' | 'high'): string | undefined => {
      if (acc.limit === undefined) return undefined;
      if (acc.limit.unit !== '%') refuse(`The dissolution limit is in % of label claim; "${acc.limit.unit}" was given`);
      return acc.limit[which];
    };
    let c6: C6Input;
    if (acc.test === 'dissolution ER') {
      const ranges = acc.ranges ?? [];
      if (ranges.length !== steps.length) refuse(`Extended release needs one range for each time point (${steps.length}); ${ranges.length} were given`);
      ranges.forEach((r) => { if (r.unit !== '%') refuse(`The ranges are in % of label claim; "${r.unit}" was given`); });
      c6 = { test: acc.test, ranges: ranges.map((r, k) => ({ time: steps[k]!.time.text, ...(r.low === undefined ? {} : { low: r.low }), ...(r.high === undefined ? {} : { high: r.high }) })),
        stages: bySet(perVessel) };
    } else if (acc.test === 'dissolution DR acid') {
      const max = bound('high');
      c6 = { test: acc.test, ...(max === undefined ? {} : { max }), stages: bySet(atTime[reportIdx]!) };
    } else {
      const q = bound('low');
      if (q === undefined) refuse('Q is the lower limit of the % dissolved ("not less than Q %"): give the limit with its lowest value');
      c6 = { test: acc.test, Q: q, stages: bySet(atTime[reportIdx]!) };
    }
    const d = c6StagedTest(c6);
    if (!d.ok) refuse(d.message);
    return {
      ok: true, value: reported.mean, unit, points, vessels, atTime, perVessel, shown: `${shown}. ${d.shown}`,
      decision: d.decision, stageReached: d.stageReached, ...(d.nextStageUnits === undefined ? {} : { nextStageUnits: d.nextStageUnits }), check: d.check,
    };
  });
}

// ================================================================ L6 Titration
/**
 * L6 Titration. Everything is worked in millimoles of the VS the equivalence is written for:
 *   direct:             n = (V − V blank) × M(titrant)
 *   back, with blank:   n = (V blank − V) × M(titrant) × r      (the excess VS cancels: only the titrant's factor counts)
 *   back, no blank:     n = V(excess) × M(excess) − V × M(titrant) × r
 * with M = stated molarity × factor (from the VS item), r = mol of the excess VS that one mol of titrant takes up
 * (default 1). The content is n ÷ M(equivalence) × E, E being the mg equivalent to 1 mL of VS of the molarity the
 * equivalence is written for, so a VS of another molarity is followed automatically (safety rule S5).
 * Options: temperature-corrected titre V × [1 + c (t1 − t2)] (t1 at standardisation, t2 at titration, c default
 * 0.001 per °C, Ph.Int 2.6), aliquot factor, sample by volume, average unit weight, a basis.
 */
export interface Vs {
  readonly volume: Q;
  /** The stated molarity, e.g. "0.5 M" or "0.1 mol/L". */
  readonly molarity: Q;
  /** The factor from the VS item (actual ÷ stated molarity). */
  readonly factor: string;
}

export interface L6Input {
  readonly mode: 'direct' | 'back';
  /** The sample: a mass (or a volume for a liquid sample reported in mg/mL). */
  readonly sample: Q;
  /** The VS titrated from the burette: its volume at the end point, stated molarity and factor. */
  readonly titrant: Vs;
  /** The blank titration volume of the same titrant. */
  readonly blank?: Q;
  /** Back titration without a blank: the VS added in measured excess, with its own factor. */
  readonly excess?: Vs;
  /** Back titration: mol of the excess VS taken up by one mol of titrant (default 1). */
  readonly reactionRatio?: string;
  /** E: the mg of substance equivalent to 1 mL of VS of the stated molarity, and which VS it is written for. */
  readonly equivalence: { readonly mass: Q; readonly molarity: Q; readonly of?: 'titrant' | 'excess' };
  /** An aliquot was titrated: the whole sample solution and the part taken. */
  readonly aliquot?: { readonly total: Q; readonly taken: Q };
  readonly temperatureCorrection?: { readonly standardisedAt: Q; readonly titratedAt: Q; readonly coefficient?: string };
  /** '%' of the sample mass (default), 'mg' found, 'mg per unit' (with `unitWeight`), 'mg/mL' (sample by volume). */
  readonly report?: '%' | 'mg' | 'mg per unit' | 'mg/mL';
  /** Average unit weight, for mg per unit (tablets: powder mass taken → per tablet). */
  readonly unitWeight?: Q;
  /** Unit of a '%' result: %, mg/g, g/g. */
  readonly unit?: string;
  readonly basis?: Basis;
  readonly decimals?: number;
  readonly limit?: Limit;
}

function molarityOf(q: Q, what: string): Parsed {
  const p = parse(q, what);
  if (p.unit.kind === 'number') return { v: p.v, unit: unitOf('mol/L'), text: `${p.text} M` };
  needKind(p, ['amount concentration'], what);
  return p;
}

function vsOf(vs: Vs, what: string, tc: Dec | undefined): { V: Dec; M: Dec; text: string; volume: string; of: string } {
  const V = parse(vs.volume, `The ${what} volume`);
  needKind(V, ['volume'], `The ${what} volume`);
  notNegative(V, `The ${what} volume`);
  const M = molarityOf(vs.molarity, `The ${what} molarity`);
  positive(M, `The ${what} molarity`);
  if (typeof vs.factor !== 'string') refuse(`Give the factor of the ${what} from its VS item (safety rule S5)`);
  const f = plain(vs.factor, `The ${what} factor`);
  if (f.v.lt('0.8') || f.v.gt('1.2')) refuse(`The ${what} factor ${f.text} is not near 1: a VS factor is the actual ÷ the stated molarity (usually 0.95-1.05). Check that the molarity was not typed as the factor`);
  const v = to(V, 'mL').times(tc ?? ONE);
  return { V: v, M: to(M, 'mol/L').times(f.v), text: `${V.text} of ${M.text} × ${f.text}`, volume: V.text, of: `of ${M.text} × ${f.text}` };
}

export function l6Titration(input: L6Input): Outcome {
  return run(() => {
    // Optional groups whose settings were all left out are not given (a direct titration: no VS in excess).
    const i: L6Input = {
      ...input,
      excess: given(input.excess) ? input.excess : undefined,
      aliquot: given(input.aliquot) ? input.aliquot : undefined,
      temperatureCorrection: given(input.temperatureCorrection) ? input.temperatureCorrection : undefined,
    } as L6Input;
    const report = i.report ?? '%';
    const sample = parse(i.sample, 'The sample');
    positive(sample, 'The sample');
    if (report === 'mg/mL') needKind(sample, ['volume'], 'The sample (by volume)');
    else needKind(sample, ['mass'], 'The sample mass');
    let tc: Dec | undefined;
    let tcLine = '';
    if (i.temperatureCorrection !== undefined) {
      const t1 = parse(i.temperatureCorrection.standardisedAt, 'The temperature at standardisation');
      const t2 = parse(i.temperatureCorrection.titratedAt, 'The temperature of the titration');
      needKind(t1, ['temperature'], 'The temperature at standardisation');
      needKind(t2, ['temperature'], 'The temperature of the titration');
      const c = plain(i.temperatureCorrection.coefficient ?? '0.001', 'The expansion coefficient').v;
      tc = ONE.plus(c.times(to(t1, '°C').minus(to(t2, '°C'))));
      tcLine = ` (titres × [1 + ${c.toString()} × (${t1.text} − ${t2.text})] = × ${num(tc, '')})`;
    }
    const t = vsOf(i.titrant, 'titrant', tc);
    const Eq = parse(i.equivalence.mass, 'The equivalence');
    needKind(Eq, ['mass'], 'The equivalence (mg per mL of VS)');
    positive(Eq, 'The equivalence');
    const Meq = molarityOf(i.equivalence.molarity, 'The molarity the equivalence is written for');
    positive(Meq, 'The molarity the equivalence is written for');
    const of = i.equivalence.of ?? 'titrant';
    let blankV: Dec | undefined;
    let blankText = '';
    if (i.blank !== undefined) {
      const b = parse(i.blank, 'The blank volume');
      needKind(b, ['volume'], 'The blank volume');
      notNegative(b, 'The blank volume');
      blankV = to(b, 'mL').times(tc ?? ONE);
      blankText = b.text;
    }
    const r = i.reactionRatio === undefined ? ONE : plain(i.reactionRatio, 'The reaction ratio').v;
    if (r.lte(0)) refuse('The reaction ratio must be more than zero');
    let n: Dec; // mmol of the VS the equivalence is written for
    let line: string;
    if (i.mode === 'direct') {
      if (of !== 'titrant') refuse('In a direct titration the equivalence is written for the titrant');
      if (i.excess !== undefined) refuse('A direct titration has no VS in excess: use the back titration mode');
      const net = t.V.minus(blankV ?? ZERO);
      if (net.isNegative()) refuse('The blank volume is more than the titration volume: check both readings');
      n = net.times(t.M);
      line = blankV ? `(${t.volume} − blank ${blankText}) ${t.of}` : `${t.text}`;
    } else if (blankV !== undefined) {
      const net = blankV.minus(t.V);
      if (net.isNegative()) refuse('In a back titration with a blank the sample takes less titrant than the blank; here it took more: check the readings (the order is blank − sample)');
      n = net.times(t.M).times(r);
      if (of === 'titrant') n = n.div(r);
      line = `(blank ${blankText} − ${t.volume}) ${t.of}${r.eq(1) ? '' : ` × ${r.toString()}`} (the excess VS cancels)`;
    } else {
      if (i.excess === undefined) refuse('A back titration without a blank needs the VS added in excess, with its own volume, molarity and factor (safety rule S5)');
      const e = vsOf(i.excess, 'excess VS', undefined);
      n = e.V.times(e.M).minus(t.V.times(t.M).times(r));
      if (n.isNegative() || n.isZero()) refuse('The titrant took up more than the excess VS added: nothing is left for the sample. Check the volumes and factors');
      if (of === 'titrant') n = n.div(r);
      line = `(${e.text} − ${t.text}${r.eq(1) ? '' : ` × ${r.toString()}`})`;
    }
    let mg = n.div(to(Meq, 'mol/L')).times(to(Eq, 'mg'));
    let aliquotLine = '';
    if (i.aliquot !== undefined) {
      const tot = parse(i.aliquot.total, 'The whole sample solution');
      const tk = parse(i.aliquot.taken, 'The aliquot titrated');
      sameKind([tot, tk], 'The aliquot');
      positive(tk, 'The aliquot titrated');
      if (to(tk, tot.unit).gt(tot.v)) refuse('The aliquot titrated is more than the whole sample solution');
      const f = tot.v.div(to(tk, tot.unit));
      mg = mg.times(f);
      aliquotLine = ` × ${tot.text} ÷ ${tk.text}`;
    }
    const found = `${line} ÷ ${Meq.text} × ${Eq.text}${aliquotLine}${tcLine} = ${num(mg, 'mg')} mg`;
    let value: Dec;
    let unit: string;
    let shown: string;
    if (report === 'mg') {
      if (i.basis !== undefined) refuse('A basis applies to a content in % of the sample, not to the mg found');
      value = mg; unit = 'mg'; shown = found;
    } else if (report === 'mg/mL') {
      value = mg.div(to(sample, 'mL')); unit = 'mg/mL'; shown = `${found}; ÷ ${sample.text} = ${show(value, 'mg/mL', i.decimals ?? 3)}`;
    } else if (report === 'mg per unit') {
      if (i.unitWeight === undefined) refuse('A result per unit needs the average unit weight');
      const uw = parse(i.unitWeight, 'The average unit weight');
      needKind(uw, ['mass'], 'The average unit weight');
      positive(uw, 'The average unit weight');
      value = mg.div(to(sample, 'mg')).times(to(uw, 'mg')); unit = 'mg';
      shown = `${found}; ÷ ${sample.text} × ${uw.text} = ${show(value, 'mg', i.decimals ?? 1)} per unit`;
    } else {
      unit = fractionUnit(i.unit);
      const pct = mg.div(to(sample, 'mg')).times(HUNDRED);
      const b = applyBasis(pct, i.basis);
      value = fromPercent(b.v, unit);
      shown = `${found}; ÷ ${sample.text} × 100${b.line} = ${show(value, unit, i.decimals ?? (unit === '%' ? 2 : 1))}`;
    }
    return { ok: true, value, unit, shown, ...checkOf(value, unit, i.limit) };
  });
}

// ================================================================ L7 Water by Karl Fischer
/**
 * L7 Water by Karl Fischer (Ph.Int 2.8, Ph. Eur. 2.5.12/2.5.32, paraphrased).
 *   volumetric:       water = (V − V blank) × F − drift × time;          result = water ÷ sample × 100
 *   volumetric back:  water = V(reagent) × F − V(water-methanol) × its water (mg/mL)   (method B)
 *   coulometric:      water = reading (µg) − blank − drift × time;      µg ÷ mg × 0.1 = %
 */
export type L7Input = {
  readonly sample: Q;
  /** %, mg/g, g/g or ppm (default %). */
  readonly unit?: string;
  readonly decimals?: number;
  readonly limit?: Limit;
} & (
  | { readonly mode: 'volumetric'; readonly volume: Q; readonly factor: Q; readonly blank?: Q; readonly drift?: { readonly rate: Q; readonly time: Q } }
  | { readonly mode: 'volumetric back'; readonly reagent: Q; readonly factor: Q; readonly back: Q; readonly backWater: Q }
  | { readonly mode: 'coulometric'; readonly water: Q; readonly blank?: Q; readonly drift?: { readonly rate: Q; readonly time: Q } }
);

function driftOf(dr: { rate: Q; time: Q } | undefined): { mg: Dec; text: string } {
  if (!given(dr)) return { mg: ZERO, text: '' };
  const rate = parse(dr.rate, 'The drift');
  needKind(rate, ['mass rate'], 'The drift (e.g. "8 µg/min")');
  notNegative(rate, 'The drift');
  const time = parse(dr.time, 'The titration time');
  needKind(time, ['time'], 'The titration time');
  notNegative(time, 'The titration time');
  const mg = to(rate, 'g/h').times(to(time, 'h')).times(1000);
  return { mg, text: ` − drift ${rate.text} × ${time.text}` };
}

export function l7WaterKf(i: L7Input): Outcome<{ readonly waterMg: Dec }> {
  return run(() => {
    const unit = fractionUnit(i.unit);
    const s = parse(i.sample, 'The sample mass');
    needKind(s, ['mass'], 'The sample mass');
    positive(s, 'The sample mass');
    let water: Dec;
    let line: string;
    if (i.mode === 'coulometric') {
      const w = parse(i.water, 'The water found');
      needKind(w, ['mass'], 'The water found (e.g. "1250 µg")');
      notNegative(w, 'The water found');
      const b = i.blank === undefined ? undefined : parse(i.blank, 'The blank');
      if (b) { needKind(b, ['mass'], 'The blank'); notNegative(b, 'The blank'); }
      const dr = driftOf(i.drift);
      water = to(w, 'mg').minus(b ? to(b, 'mg') : ZERO).minus(dr.mg);
      line = `(${w.text}${b ? ` − blank ${b.text}` : ''}${dr.text})`;
    } else {
      const F = parse(i.factor, 'The water equivalent F of the reagent');
      needKind(F, ['mass concentration'], 'The water equivalent F (mg/mL)');
      positive(F, 'The water equivalent F');
      const Fv = to(F, 'mg/mL');
      if (i.mode === 'volumetric') {
        const V = parse(i.volume, 'The titre');
        needKind(V, ['volume'], 'The titre');
        notNegative(V, 'The titre');
        const b = i.blank === undefined ? undefined : parse(i.blank, 'The blank');
        if (b) { needKind(b, ['volume'], 'The blank'); notNegative(b, 'The blank'); }
        const dr = driftOf(i.drift);
        water = to(V, 'mL').minus(b ? to(b, 'mL') : ZERO).times(Fv).minus(dr.mg);
        line = `(${b ? `(${V.text} − ${b.text})` : V.text} × ${F.text}${dr.text})`;
      } else {
        const R = parse(i.reagent, 'The reagent added in excess');
        const B = parse(i.back, 'The water-methanol back-titre');
        needKind(R, ['volume'], 'The reagent added in excess');
        needKind(B, ['volume'], 'The water-methanol back-titre');
        notNegative(R, 'The reagent volume');
        notNegative(B, 'The back-titre');
        const bw = parse(i.backWater, 'The water content of the water-methanol');
        needKind(bw, ['mass concentration'], 'The water content of the water-methanol (mg/mL)');
        water = to(R, 'mL').times(Fv).minus(to(B, 'mL').times(to(bw, 'mg/mL')));
        line = `(${R.text} × ${F.text} − ${B.text} × ${bw.text})`;
      }
    }
    if (water.isNegative()) refuse('The blank, drift or back-titre is more than the water found: the result would be negative. Check the readings (and that the drift was stable)');
    const pct = water.div(to(s, 'mg')).times(HUNDRED);
    const value = fromPercent(pct, unit);
    const shown = `${line} = ${num(water, 'mg')} mg water ÷ ${s.text} × 100 = ${show(value, unit, i.decimals ?? (unit === '%' ? 2 : unit === 'g/g' ? 4 : 1))}`;
    return { ok: true, value, unit, waterMg: water, shown, ...checkOf(value, unit, i.limit) };
  });
}

// ================================================================ L8 Mass loss / residue
/**
 * L8 Mass loss / residue, from the weighings: tare (empty dish, crucible or bottle), before (with the sample) and
 * after (dried or ignited; several successive weighings when constant mass is required).
 *   loss on drying, loss on ignition:          (before − after) ÷ (before − tare) × 100
 *   residue on ignition, sulfated ash, residue: (after − tare) ÷ (before − tare) × 100
 *   container weight loss (stability):         (before − after) ÷ before × 100, or ÷ (before − tare) when the tare is given
 * Constant mass: the last two weighings by the F2 helper `noFurtherChange` (e.g. NMT 0.5 mg); option `orWithinLimit`
 * (Ph.Int 2.3): heating may also stop once the result complies with the limit.
 */
export interface L8Input {
  readonly mode: 'loss on drying' | 'loss on ignition' | 'residue on ignition' | 'sulfated ash' | 'residue' | 'container weight loss';
  readonly tare?: Q;
  readonly before: Q;
  /** One weighing, or the successive weighings in order (the last is used). */
  readonly after: Q | readonly Q[];
  readonly constantMass?: ChangeLimit;
  readonly orWithinLimit?: boolean;
  readonly unit?: string;
  readonly basis?: Basis;
  readonly decimals?: number;
  readonly limit?: Limit;
}

export function l8MassLoss(i: L8Input): Outcome<{ readonly sampleMass: Dec; readonly constantMass?: Check }> {
  return run(() => {
    const unit = fractionUnit(i.unit);
    const before = parse(i.before, 'The mass before');
    needKind(before, ['mass'], 'The mass before');
    const afters = (Array.isArray(i.after) ? i.after : [i.after as Q]).map((q, n) => parse(q, `Weighing after ${n + 1}`));
    if (afters.length === 0) refuse('Give the mass after drying or ignition');
    for (const a of afters) needKind(a, ['mass'], 'The mass after');
    const after = afters[afters.length - 1]!;
    const isLoss = i.mode === 'loss on drying' || i.mode === 'loss on ignition' || i.mode === 'container weight loss';
    let tare: Parsed | undefined;
    if (i.tare !== undefined) {
      tare = parse(i.tare, 'The tare');
      needKind(tare, ['mass'], 'The tare');
      notNegative(tare, 'The tare');
    } else if (i.mode !== 'container weight loss') refuse('Give the tare (the empty dish, crucible or bottle), weighed on the same balance');
    const u = before.unit;
    const sample = to(before, u).minus(tare ? to(tare, u) : ZERO);
    if (!sample.isPositive() || sample.isZero()) refuse('The mass before must be more than the tare: there is no sample');
    const a = to(after, u);
    let part: Dec;
    if (isLoss) {
      part = to(before, u).minus(a);
      if (part.isNegative()) refuse(`The mass after (${after.text}) is more than before (${before.text}): the sample gained mass. Check the weighings, the balance and the desiccator`);
    } else {
      part = a.minus(tare ? to(tare, u) : ZERO);
      if (part.isNegative()) refuse(`The mass after (${after.text}) is less than the tare (${tare?.text ?? ''}): check the weighings`);
      if (part.gt(sample)) refuse('The residue is more than the sample: check the weighings');
    }
    const pct = part.div(sample).times(HUNDRED);
    const b = applyBasis(pct, i.basis);
    const value = fromPercent(b.v, unit);
    const check = checkOf(value, unit, i.limit).check;
    let cm: Check | undefined;
    let cmLine = '';
    if (given(i.constantMass)) {
      if (afters.length < 2) refuse('Constant mass needs at least two successive weighings after drying or ignition');
      const prev = afters[afters.length - 2]!;
      const r = noFurtherChange(prev.text, after.text, i.constantMass);
      if (!r.ok) refuse(r.message);
      cm = r.check;
      if (cm && !cm.pass) {
        if (i.orWithinLimit === true && check?.pass === true) cmLine = `; not yet at constant mass (${r.shown}), but the result complies with the limit: heating may stop`;
        else refuse(`Not yet at constant mass: ${r.shown}. Heat again and weigh`);
      } else cmLine = `; constant mass: ${r.shown}`;
    }
    const what = isLoss ? `(${before.text} − ${after.text})` : `(${after.text} − ${tare?.text ?? ''})`;
    const base = tare ? `(${before.text} − ${tare.text})` : before.text;
    const dp = i.decimals ?? (unit === '%' ? 2 : unit === 'g/g' ? 4 : 1);
    const shown = `${i.mode}: ${what} ÷ ${base} × 100${b.line} = ${show(value, unit, dp)}${cmLine}`;
    return { ok: true, value, unit, sampleMass: sample, ...(cm ? { constantMass: cm } : {}), shown, ...(check ? { check } : {}) };
  });
}

// ================================================================ L10 Readings with a fixed rule
/**
 * L10 Readings with a fixed rule.
 * - specific rotation (Ph.Int 1.4, Ph. Eur. 2.2.7): solution [α] = 100 α ÷ (l × c), c in g per 100 mL; neat liquid
 *   [α] = α ÷ (l × d); solution by mass [α] = 100 α ÷ (l × p × d), p in g per 100 g; l in dm (safety rule S12: the
 *   path length is taken with its unit, and a tube outside 0.1-5 dm is refused, as a length in mm typed as dm gives a
 *   100-fold error); optional basis (dried / anhydrous with the sample's own result).
 * - content from rotation: observed α × the written factor.
 * - relative density (pycnometer): (m sample-filled − m empty) ÷ (m water-filled − m empty); weight per mL: × the
 *   density of water at the temperature (from the reference table item).
 * - ethanol content from the density at 20 °C (OIML R 22 alcoholometric formula, as T26): % v/v or % w/w.
 * - pH: the reading with its temperature; refused when the calibration was more than 2 °C away (Ph.Int 1.13).
 * - conductivity (USP <645>, Ph. Eur. water for injections, paraphrased): stage 1 compares the NON-compensated reading
 *   with the table limit at the next lower 5 °C step (safety rule S11); stage 2 at 25 ± 1 °C NMT 2.1 µS/cm;
 *   stage 3 the limit at the pH of the sample (pH 5.0-7.0 table).
 * - TOC (USP <643>): the reading against the limit response r(s) − r(w); system suitability response efficiency
 *   (r(ss) − r(w)) ÷ (r(s) − r(w)) × 100, 85-115 %.
 * - melting point (Ph.Int 1.2.1): reading + thermometer correction + emergent stem 0.00015 × N × (T − t).
 */
export type L10Input = { readonly decimals?: number; readonly limit?: Limit } & (
  | {
      readonly mode: 'specific rotation';
      /** Observed angle, zero-corrected and signed (e.g. "-1.23 °"). */
      readonly angle: Q;
      readonly pathLength: Q;
      readonly form: 'solution' | 'neat liquid' | 'solution by mass';
      /** solution: g per 100 mL ("2.000 g/100 mL", "%w/v" or mg/mL). */
      readonly concentration?: Q;
      /** solution: or the substance weighed and the volume it is dissolved in, c = mass ÷ volume × 100 (g per 100 mL). */
      readonly sample?: { readonly mass?: Q; readonly volume?: Q };
      /** solution by mass: g per 100 g ("%w/w"). */
      readonly massPercent?: Q;
      /** neat liquid, solution by mass: relative density (a plain number) or density. */
      readonly density?: Q;
      readonly basis?: Basis;
    }
  | { readonly mode: 'content from rotation'; readonly angle: Q; readonly factor: { readonly value: string; readonly unit: string } }
  | { readonly mode: 'relative density' | 'weight per mL'; readonly empty: Q; readonly withWater: Q; readonly withSample: Q; readonly waterDensity?: Q; readonly temperature?: Q }
  | { readonly mode: 'ethanol content'; readonly density: Q; readonly report: '% v/v' | '% w/w' }
  | { readonly mode: 'pH'; readonly reading: Q; readonly temperature: Q; readonly calibrationTemperature?: Q }
  | { readonly mode: 'conductivity'; readonly stage: 1 | 2 | 3; readonly reading: Q; readonly temperature?: Q; readonly temperatureCompensated: boolean; readonly pH?: Q }
  | { readonly mode: 'TOC'; readonly reading: Q; readonly suitability?: { readonly water: Q; readonly sucrose: Q; readonly benzoquinone: Q } }
  | { readonly mode: 'melting point'; readonly reading: Q; readonly thermometerCorrection?: Q; readonly stem?: { readonly degrees: string; readonly stemTemperature: Q } }
);

/** USP <645> stage 1 (also Ph. Eur. water for injections): °C → largest uncompensated conductivity, µS/cm. */
export const CONDUCTIVITY_STAGE1: readonly (readonly [number, string])[] = [
  [0, '0.6'], [5, '0.8'], [10, '0.9'], [15, '1.0'], [20, '1.1'], [25, '1.3'], [30, '1.4'], [35, '1.5'], [40, '1.7'], [45, '1.8'], [50, '1.9'],
  [55, '2.1'], [60, '2.2'], [65, '2.4'], [70, '2.5'], [75, '2.7'], [80, '2.7'], [85, '2.7'], [90, '2.7'], [95, '2.9'], [100, '3.1'],
];
/** USP <645> stage 3: pH → largest conductivity, µS/cm (at 25 °C). */
export const CONDUCTIVITY_STAGE3: readonly (readonly [string, string])[] = [
  ['5.0', '4.7'], ['5.1', '4.1'], ['5.2', '3.6'], ['5.3', '3.3'], ['5.4', '3.0'], ['5.5', '2.8'], ['5.6', '2.6'], ['5.7', '2.5'], ['5.8', '2.4'], ['5.9', '2.4'], ['6.0', '2.4'],
  ['6.1', '2.4'], ['6.2', '2.5'], ['6.3', '2.4'], ['6.4', '2.3'], ['6.5', '2.2'], ['6.6', '2.1'], ['6.7', '2.6'], ['6.8', '3.1'], ['6.9', '3.8'], ['7.0', '4.6'],
];

export function l10Reading(i: L10Input): Outcome<{ readonly decision?: 'pass' | 'next stage' | 'fail' }> {
  return run(() => {
    switch (i.mode) {
      case 'specific rotation': {
        const a = parse(i.angle, 'The observed angle');
        needKind(a, ['angle'], 'The observed angle');
        if (typeof i.pathLength === 'string' && !/\s/.test(i.pathLength.trim())) refuse('Give the path length with its unit ("1 dm" or "100 mm"): a bare number is ambiguous, and mm read as dm is a 100-fold error (safety rule S12)');
        const l = parse(i.pathLength, 'The path length');
        needKind(l, ['length'], 'The path length');
        const ldm = to(l, 'dm');
        if (ldm.lt('0.1') || ldm.gt(5)) refuse(`A polarimeter tube of ${l.text} (${fmt(ldm, 3)} dm) is not plausible: tubes are 0.1 to 5 dm (10 to 500 mm). Check the unit of the path length (safety rule S12: mm taken as dm is a 100-fold error)`);
        let value: Dec;
        let line: string;
        const dens = (): Parsed => {
          if (i.density === undefined) refuse(`The ${i.form} form needs the relative density`);
          const p = parse(i.density, 'The relative density');
          if (p.unit.kind !== 'number') needKind(p, ['density'], 'The relative density');
          positive(p, 'The relative density');
          return p;
        };
        const weighed = given(i.sample) ? i.sample : undefined;
        if (weighed !== undefined && i.form !== 'solution') refuse(`The ${i.form} form is not made up from a weighed amount in a flask: leave out the sample mass and volume`);
        if (i.form === 'solution') {
          if ((i.concentration === undefined) === (weighed === undefined)) refuse('A solution needs its concentration (g per 100 mL), or the mass weighed and the volume it is dissolved in: one of them');
          let cw: Dec;
          let cText = '';
          if (weighed !== undefined) {
            if (weighed.mass === undefined || weighed.volume === undefined) refuse('Give both the mass weighed and the volume it is dissolved in');
            const m = parse(weighed.mass, 'The mass weighed');
            const vol = parse(weighed.volume, 'The volume');
            needKind(m, ['mass'], 'The mass weighed');
            needKind(vol, ['volume'], 'The volume');
            positive(m, 'The mass weighed');
            positive(vol, 'The volume');
            cw = to(m, 'g').div(to(vol, 'mL')).times(HUNDRED);
            cText = ` (${m.text} in ${vol.text})`;
          } else {
            const c = parse(i.concentration as Q, 'The concentration');
            needKind(c, ['mass concentration'], 'The concentration (g per 100 mL)');
            positive(c, 'The concentration');
            cw = to(c, '%w/v');
          }
          value = HUNDRED.times(a.v).div(ldm.times(cw));
          line = `100 × ${a.text} ÷ (${fmt(ldm, 4)} dm × ${fmt(cw, 4)} g/100 mL${cText})`;
        } else if (i.form === 'neat liquid') {
          const dd = dens();
          const dv = dd.unit.kind === 'number' ? dd.v : to(dd, 'g/mL');
          value = a.v.div(ldm.times(dv));
          line = `${a.text} ÷ (${fmt(ldm, 4)} dm × ${dd.text})`;
        } else {
          if (i.massPercent === undefined) refuse('A solution by mass needs its concentration in g per 100 g');
          const p = parse(i.massPercent, 'The concentration by mass');
          needKind(p, ['fraction'], 'The concentration by mass (g per 100 g)');
          positive(p, 'The concentration by mass');
          const dd = dens();
          const dv = dd.unit.kind === 'number' ? dd.v : to(dd, 'g/mL');
          value = HUNDRED.times(a.v).div(ldm.times(to(p, '%')).times(dv));
          line = `100 × ${a.text} ÷ (${fmt(ldm, 4)} dm × ${fmt(to(p, '%'), 4)} g/100 g × ${dd.text})`;
        }
        const b = applyBasis(value, i.basis);
        const dp = i.decimals ?? 1;
        return { ok: true, value: b.v, unit: '°', shown: `[α] = ${line}${b.line} = ${fmt(b.v, dp)}°`, ...checkOf(b.v, '°', i.limit) };
      }
      case 'content from rotation': {
        const a = parse(i.angle, 'The observed angle');
        needKind(a, ['angle'], 'The observed angle');
        const f = parse({ value: i.factor.value, unit: i.factor.unit }, 'The written factor');
        const value = a.v.times(f.v);
        const u = f.unit.symbol;
        return { ok: true, value, unit: u, shown: `${a.text} × ${f.text} per degree = ${show(value, u, i.decimals ?? 2)}`, ...checkOf(value, u, i.limit) };
      }
      case 'relative density':
      case 'weight per mL': {
        const m0 = parse(i.empty, 'The empty pycnometer');
        const m1 = parse(i.withWater, 'The pycnometer filled with water');
        const m2 = parse(i.withSample, 'The pycnometer filled with the sample');
        for (const [p, w] of [[m0, 'The empty pycnometer'], [m1, 'The pycnometer with water'], [m2, 'The pycnometer with the sample']] as const) needKind(p, ['mass'], w);
        const w = to(m1, 'g').minus(to(m0, 'g'));
        const s = to(m2, 'g').minus(to(m0, 'g'));
        if (!w.isPositive() || w.isZero() || !s.isPositive() || s.isZero()) refuse('The filled pycnometer must weigh more than the empty one: check the weighings');
        const rd = s.div(w);
        const line = `(${m2.text} − ${m0.text}) ÷ (${m1.text} − ${m0.text})`;
        if (i.mode === 'relative density') return { ok: true, value: rd, unit: '', shown: `relative density = ${line} = ${fmt(rd, i.decimals ?? 4)}`, ...checkOf(rd, '', i.limit) };
        if (i.waterDensity === undefined) refuse('The weight per mL needs the density of water at the measuring temperature (from the reference table item)');
        const wd = parse(i.waterDensity, 'The density of water');
        needKind(wd, ['density'], 'The density of water');
        if (to(wd, 'g/mL').lt('0.95') || to(wd, 'g/mL').gt('1.0')) refuse('The density of water must lie between 0.95 and 1.000 g/mL; check the value and its unit');
        const value = rd.times(to(wd, 'g/mL'));
        return { ok: true, value, unit: 'g/mL', shown: `weight per mL = ${line} × ${wd.text}${i.temperature ? ` (at ${parse(i.temperature, 'The temperature').text})` : ''} = ${fmt(value, i.decimals ?? 4)} g/mL`, ...checkOf(value, 'g/mL', i.limit) };
      }
      case 'ethanol content': {
        const rho = parse(i.density, 'The density at 20 °C');
        needKind(rho, ['density'], 'The density at 20 °C');
        const kg = to(rho, 'kg/m³');
        const top = ethanolDensity(ZERO);
        const bottom = ethanolDensity(ONE);
        if (kg.gt(top) || kg.lt(bottom)) refuse(`A density of ${rho.text} at 20 °C is outside the range of ethanol-water mixtures (${fmt(bottom.div(1000), 5)} to ${fmt(top.div(1000), 5)} g/mL)`);
        let lo = ZERO;
        let hi = ONE;
        for (let n = 0; n < 120; n += 1) {
          const m = lo.plus(hi).div(2);
          if (ethanolDensity(m).gt(kg)) lo = m; else hi = m; // the density falls as the ethanol fraction rises
        }
        const p = lo.plus(hi).div(2);
        const ww = p.times(HUNDRED);
        const vv = p.times(kg).div(bottom).times(HUNDRED);
        const value = i.report === '% v/v' ? vv : ww;
        const unit = i.report === '% v/v' ? '%v/v' : '%w/w';
        return { ok: true, value, unit, shown: `density ${rho.text} at 20 °C (OIML R 22) = ${fmt(ww, 2)} % w/w = ${fmt(vv, 2)} % v/v`, ...checkOf(value, unit, i.limit) };
      }
      case 'pH': {
        const r = parse(i.reading, 'The pH reading');
        needKind(r, ['number'], 'The pH reading');
        if (r.v.isNegative() || r.v.gt(14)) refuse('A pH reading must be from 0 to 14');
        const t = parse(i.temperature, 'The temperature of the sample');
        needKind(t, ['temperature'], 'The temperature of the sample');
        if (i.calibrationTemperature !== undefined) {
          const ct = parse(i.calibrationTemperature, 'The calibration temperature');
          needKind(ct, ['temperature'], 'The calibration temperature');
          if (to(ct, '°C').minus(to(t, '°C')).abs().gt(2)) refuse(`The sample (${t.text}) was measured more than 2 °C from the calibration (${ct.text}): bring them to the same temperature, or calibrate again at the sample's temperature`);
        }
        return { ok: true, value: r.v, unit: '', shown: `pH ${r.text} at ${t.text}`, ...checkOf(r.v, '', i.limit) };
      }
      case 'conductivity': {
        const r = parse(i.reading, 'The conductivity');
        needKind(r, ['conductivity'], 'The conductivity');
        notNegative(r, 'The conductivity');
        const v = to(r, 'µS/cm');
        if (i.stage === 1) {
          if (i.temperatureCompensated !== false) refuse('Stage 1 compares the conductivity NOT compensated for temperature with the table at the measured temperature (safety rule S11): switch off the temperature compensation and record the uncompensated reading');
          if (i.temperature === undefined) refuse('Stage 1 needs the temperature of the water at the reading');
          const t = to(parse(i.temperature, 'The temperature'), '°C');
          if (t.isNegative() || t.gt(100)) refuse('The table covers 0 to 100 °C');
          const row = [...CONDUCTIVITY_STAGE1].reverse().find(([deg]) => t.gte(deg))!;
          const lim = d(row[1]);
          const ok = v.lte(lim);
          const decision = ok ? 'pass' : 'next stage';
          const shown = `stage 1: ${r.text} (not compensated) at ${fmt(t, 1)} °C; limit at ${row[0]} °C (the next lower table temperature) ${row[1]} µS/cm: ${ok ? 'PASS' : 'above the limit: go to stage 2'}`;
          const check: Check = { pass: ok, level: ok ? 'pass' : 'fail', rounded: `${r.text}`, shown };
          return { ok: true, value: v, unit: 'µS/cm', decision, shown, check };
        }
        if (i.stage === 2) {
          if (i.temperature === undefined) refuse('Stage 2 is read at 25 ± 1 °C: give the temperature');
          const t = to(parse(i.temperature, 'The temperature'), '°C');
          if (t.minus(25).abs().gt(1)) refuse(`Stage 2 is read at 25 ± 1 °C; ${fmt(t, 1)} °C was given`);
          const c = checkLimit(v, 'µS/cm', { high: '2.1', unit: 'µS/cm' });
          const decision = c.pass ? 'pass' : 'next stage';
          const shown = `stage 2 (25 °C, after stirring until the change is NMT 0.1 µS/cm per 5 min): ${c.shown}${c.pass ? '' : ': go to stage 3'}`;
          return { ok: true, value: v, unit: 'µS/cm', decision, shown, check: { ...c, shown } };
        }
        if (i.pH === undefined) refuse('Stage 3 needs the pH of the sample (measured after adding the potassium chloride solution)');
        const ph = parse(i.pH, 'The pH');
        needKind(ph, ['number'], 'The pH');
        const phR = ph.v.toDecimalPlaces(1, Dec.ROUND_HALF_UP);
        const row = CONDUCTIVITY_STAGE3.find(([p]) => d(p).eq(phR));
        if (row === undefined) {
          const shown = `stage 3: pH ${ph.text} is outside 5.0-7.0: FAIL`;
          return { ok: true, value: v, unit: 'µS/cm', decision: 'fail', shown, check: { pass: false, level: 'fail', rounded: ph.text, shown } };
        }
        const c = checkLimit(v, 'µS/cm', { high: row[1], unit: 'µS/cm' });
        const shown = `stage 3 at pH ${row[0]}: ${c.shown}`;
        return { ok: true, value: v, unit: 'µS/cm', decision: c.pass ? 'pass' : 'fail', shown, check: { ...c, shown } };
      }
      case 'TOC': {
        const r = parse(i.reading, 'The TOC reading');
        needKind(r, ['fraction', 'mass concentration'], 'The TOC reading (ppb or mg/L of carbon)');
        notNegative(r, 'The TOC reading');
        const u = r.unit.symbol;
        if (i.suitability === undefined) return { ok: true, value: r.v, unit: u, shown: `TOC ${r.text}`, ...checkOf(r.v, u, i.limit) };
        const rw = parse(i.suitability.water, 'The water response r(w)');
        const rs = parse(i.suitability.sucrose, 'The sucrose response r(s)');
        const rss = parse(i.suitability.benzoquinone, 'The benzoquinone response r(ss)');
        sameKind([r, rw, rs, rss], 'TOC');
        const lr = to(rs, u).minus(to(rw, u));
        if (!lr.isPositive() || lr.isZero()) refuse('The sucrose response must be more than the water response');
        const eff = to(rss, u).minus(to(rw, u)).div(lr).times(HUNDRED);
        const effCheck = checkLimit(eff, '%', { low: '85', high: '115', unit: '%' });
        if (!effCheck.pass) refuse(`The system is not suitable: response efficiency (${rss.text} − ${rw.text}) ÷ (${rs.text} − ${rw.text}) × 100 = ${fmt(eff, 1)} %, outside 85-115 %. Do not report the result`);
        const pass = r.v.lte(lr);
        const shown = `TOC ${r.text}; limit response r(s) − r(w) = ${num(lr, u)} ${u}; response efficiency ${fmt(eff, 1)} %: ${pass ? 'PASS' : 'FAIL'}`;
        return { ok: true, value: r.v, unit: u, shown, check: { pass, level: pass ? 'pass' : 'fail', rounded: r.text, shown } };
      }
      case 'melting point': {
        const T = parse(i.reading, 'The reading');
        needKind(T, ['temperature'], 'The reading');
        let v = to(T, '°C');
        let line = `${fmt(v, 1)} °C`;
        if (i.thermometerCorrection !== undefined) {
          const c = parse(i.thermometerCorrection, 'The thermometer correction');
          needKind(c, ['temperature difference'], 'The thermometer correction (e.g. "+0.3 Δ°C")');
          v = v.plus(to(c, 'Δ°C'));
          line += ` ${to(c, 'Δ°C').isNegative() ? '−' : '+'} ${fmt(to(c, 'Δ°C').abs(), 2)} (thermometer)`;
        }
        if (i.stem !== undefined) {
          const N = plain(i.stem.degrees, 'The number of degrees of the emergent stem').v;
          const t = to(parse(i.stem.stemTemperature, 'The mean temperature of the emergent stem'), '°C');
          const s = d('0.00015').times(N).times(to(T, '°C').minus(t));
          v = v.plus(s);
          line += ` + 0.00015 × ${N.toString()} × (${fmt(to(T, '°C'), 1)} − ${fmt(t, 1)}) (stem)`;
        }
        return { ok: true, value: v, unit: '°C', shown: `${line} = ${fmt(v, i.decimals ?? 1)} °C`, ...checkOf(v, '°C', i.limit) };
      }
      default:
        return refuse('Unknown L10 mode');
    }
  });
}

// ================================================================ distributions (for L14)
/**
 * Critical values of t, F and chi-square, computed from the distributions (no typed table): the regularized
 * incomplete beta function by its continued fraction and the regularized incomplete gamma function by its series or
 * continued fraction (Abramowitz and Stegun 26.5.8, 6.5.29, 6.5.31; as in Numerical Recipes), ln Γ by Stirling's
 * series after shifting the argument above 30. Quantiles by bisection. Every value checked in the tests against the
 * usual published tables (Student t, Fisher F, chi-square) to their printed decimals.
 */
// Worked at 30 significant digits (plenty for a critical value printed to 3-4 decimals; and fast enough).
const D = Dec.clone({ precision: 30, rounding: Dec.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 40 });
type D = InstanceType<typeof D>;
const dd = (x: Dec | string | number): D => new D(x.toString());
const EPS = dd('1e-22');
const TINY = dd('1e-300');
const D1 = dd(1);
const D0 = dd(0);
const HALF_LN_2PI = D.ln(D.acos(-1).times(2)).div(2);
const STIRLING = [dd(1).div(12), dd(-1).div(360), dd(1).div(1260), dd(-1).div(1680), dd(1).div(1188), dd(-691).div(360360), dd(1).div(156), dd(-3617).div(122400)];

/** ln Γ(x) for x > 0, by Stirling's series after shifting x above 30. */
export function lnGamma(x: Dec): Dec {
  return new Dec(lnG(dd(x)).toString());
}
function lnG(x: D): D {
  let prod = D1;
  let z = x;
  while (z.lt(30)) { prod = prod.times(z); z = z.plus(1); }
  const inv = D1.div(z);
  const inv2 = inv.times(inv);
  let series = D0;
  let p = inv;
  for (const c of STIRLING) { series = series.plus(c.times(p)); p = p.times(inv2); }
  return z.minus('0.5').times(D.ln(z)).minus(z).plus(HALF_LN_2PI).plus(series).minus(D.ln(prod));
}

function betacf(a: D, b: D, x: D): D {
  const qab = a.plus(b);
  const qap = a.plus(1);
  const qam = a.minus(1);
  let c = D1;
  let e = D1.minus(qab.times(x).div(qap));
  if (e.abs().lt(TINY)) e = TINY;
  e = D1.div(e);
  let h = e;
  for (let m = 1; m <= 5000; m += 1) {
    const m2 = 2 * m;
    let aa = dd(m).times(b.minus(m)).times(x).div(qam.plus(m2).times(a.plus(m2)));
    e = D1.plus(aa.times(e)); if (e.abs().lt(TINY)) e = TINY;
    c = D1.plus(aa.div(c)); if (c.abs().lt(TINY)) c = TINY;
    e = D1.div(e); h = h.times(e).times(c);
    aa = a.plus(m).times(qab.plus(m)).times(x).neg().div(a.plus(m2).times(qap.plus(m2)));
    e = D1.plus(aa.times(e)); if (e.abs().lt(TINY)) e = TINY;
    c = D1.plus(aa.div(c)); if (c.abs().lt(TINY)) c = TINY;
    e = D1.div(e);
    const del = e.times(c);
    h = h.times(del);
    if (del.minus(1).abs().lt(EPS)) return h;
  }
  throw new Error('incomplete beta did not converge');
}

/** I_x(a, b) with ln B(a, b) given (it does not change while a quantile is searched). */
function ibeta(x: D, a: D, b: D, lnB: D): D {
  if (x.lte(0)) return D0;
  if (x.gte(1)) return D1;
  const bt = D.exp(a.times(D.ln(x)).plus(b.times(D.ln(D1.minus(x)))).minus(lnB));
  if (x.lt(a.plus(1).div(a.plus(b).plus(2)))) return bt.times(betacf(a, b, x)).div(a);
  return D1.minus(bt.times(betacf(b, a, D1.minus(x))).div(b));
}
const lnBeta = (a: D, b: D): D => lnG(a).plus(lnG(b)).minus(lnG(a.plus(b)));

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: Dec, a: Dec, b: Dec): Dec {
  return new Dec(ibeta(dd(x), dd(a), dd(b), lnBeta(dd(a), dd(b))).toString());
}

/** P(a, x) with ln Γ(a) given. */
function igamma(a: D, x: D, lnGa: D): D {
  if (x.lte(0)) return D0;
  const pre = D.exp(x.neg().plus(a.times(D.ln(x))).minus(lnGa));
  if (x.lt(a.plus(1))) {
    let ap = a;
    let del = D1.div(a);
    let sum = del;
    for (let n = 0; n < 10000; n += 1) {
      ap = ap.plus(1); del = del.times(x).div(ap); sum = sum.plus(del);
      if (del.abs().lt(sum.abs().times(EPS))) return sum.times(pre);
    }
    throw new Error('incomplete gamma series did not converge');
  }
  let b = x.plus(1).minus(a);
  let c = D1.div(TINY);
  let e = D1.div(b);
  let h = e;
  for (let n = 1; n < 10000; n += 1) {
    const an = dd(-n).times(dd(n).minus(a)); // a(n) = −n (n − a)
    b = b.plus(2);
    e = an.times(e).plus(b); if (e.abs().lt(TINY)) e = TINY;
    c = b.plus(an.div(c)); if (c.abs().lt(TINY)) c = TINY;
    e = D1.div(e);
    const del = e.times(c);
    h = h.times(del);
    if (del.minus(1).abs().lt(EPS)) return D1.minus(pre.times(h));
  }
  throw new Error('incomplete gamma fraction did not converge');
}

/** Regularized lower incomplete gamma P(a, x). */
export function incompleteGamma(a: Dec, x: Dec): Dec {
  return new Dec(igamma(dd(a), dd(x), lnG(dd(a))).toString());
}

/** The x where an increasing cdf reaches p, by bisection (to about 15 significant digits). */
function bisect(cdf: (x: D) => D, pIn: Dec): Dec {
  const p = dd(pIn);
  let lo = D0;
  let hi = D1;
  while (cdf(hi).lt(p)) { lo = hi; hi = hi.times(2); if (hi.gt('1e12')) throw new Error('quantile out of range'); }
  for (let n = 0; n < 200 && hi.minus(lo).gt(hi.times('1e-15')); n += 1) {
    const m = lo.plus(hi).div(2);
    if (cdf(m).lt(p)) lo = m; else hi = m;
  }
  return new Dec(lo.plus(hi).div(2).toSignificantDigits(15).toString());
}

/** The p quantile (p > 0.5) of Student's t with df degrees of freedom (df may be fractional: Welch). */
export function tQuantile(p: Dec, df: Dec): Dec {
  if (!p.gt('0.5') || !p.lt(1)) throw new Error('t quantile: p must be between 0.5 and 1');
  const v = dd(df);
  const a = v.div(2);
  const b = dd('0.5');
  const lb = lnBeta(a, b);
  return bisect((t) => D1.minus(b.times(ibeta(v.div(v.plus(t.times(t))), a, b, lb))), p);
}

/** The p quantile of F with d1 and d2 degrees of freedom. */
export function fQuantile(p: Dec, d1: Dec, d2: Dec): Dec {
  const x1 = dd(d1);
  const x2 = dd(d2);
  const a = x1.div(2);
  const b = x2.div(2);
  const lb = lnBeta(a, b);
  return bisect((f) => ibeta(x1.times(f).div(x1.times(f).plus(x2)), a, b, lb), p);
}

/** The p quantile of chi-square with k degrees of freedom. */
export function chi2Quantile(p: Dec, k: Dec): Dec {
  const a = dd(k).div(2);
  const lga = lnG(a);
  return bisect((x) => igamma(a, x.div(2), lga), p);
}

// ================================================================ L14 Statistics
/**
 * L14 Statistics (beyond T7's mean, SD, % RSD, min, max).
 * - summary: T7's statistics; the confidence interval of the mean x̄ ± t × s ÷ √n (two-sided, or one-sided bound);
 *   optional: the confidence interval of the SD [s √((n−1) ÷ χ²(1−α/2)), s √((n−1) ÷ χ²(α/2))]; the prediction interval
 *   for one more result x̄ ± t × s × √(1 + 1/n); the two-sided tolerance interval x̄ ± k s with Howe's k
 *   (k² = (n−1)(1 + 1/n) z² ÷ χ²(α; n−1), z from the coverage); the bias against a known true value with its interval.
 * - two means: the difference x̄a − x̄b with its confidence interval; pooled SD (equal variances) or Welch (unequal,
 *   Welch-Satterthwaite degrees of freedom). "No significant difference" when the interval holds 0.
 * - F test: larger variance ÷ smaller against F(1 − α/2) two-sided, or s²a ÷ s²b against F(1 − α) one-sided (a > b).
 * Confidence level as a % (default 95).
 */
export type L14Input = { readonly decimals?: number; readonly limit?: Limit } & (
  | {
      readonly mode: 'summary';
      readonly readings: Series;
      readonly confidence?: string;
      readonly sides?: 'two-sided' | 'lower bound' | 'upper bound';
      readonly sdInterval?: boolean;
      readonly prediction?: boolean;
      /** Tolerance interval: the coverage in % (e.g. "95"), at the confidence level. */
      readonly toleranceCoverage?: string;
      readonly trueValue?: Q;
      readonly rsdLimit?: Limit;
    }
  | { readonly mode: 'two means'; readonly a: Series; readonly b: Series; readonly variances: 'equal' | 'unequal'; readonly confidence?: string }
  | { readonly mode: 'F test'; readonly a: Series; readonly b: Series; readonly confidence?: string; readonly sides?: 'two-sided' | 'one-sided' }
);

export interface Interval { readonly low: Dec; readonly high: Dec }

export interface L14Extra {
  readonly n?: number;
  readonly sd?: Dec;
  readonly rsd?: Dec;
  readonly t?: Dec;
  readonly df?: Dec;
  readonly ci?: Interval;
  readonly sdCi?: Interval;
  readonly predictionInterval?: Interval;
  readonly toleranceInterval?: Interval;
  readonly k?: Dec;
  readonly bias?: Dec;
  readonly biasCi?: Interval;
  readonly F?: Dec;
  readonly critical?: Dec;
  readonly significant?: boolean;
  readonly rsdCheck?: Check;
}

function confidenceOf(text: string | undefined): { c: Dec; alpha: Dec; text: string } {
  const t = text ?? '95';
  const c = plain(t, 'The confidence level').v;
  if (!c.gt(50) || !c.lt(100)) refuse('The confidence level is a % between 50 and 100 (e.g. "95")');
  return { c, alpha: ONE.minus(c.div(HUNDRED)), text: t };
}

function seriesStats(s: Series, what: string): Stats {
  const st = stats(readSeries(s, what));
  if (st.count < 2 || st.sd === undefined) refuse(`${what}: statistics need at least two results`);
  return st;
}

export function l14Statistics(i: L14Input): Outcome<L14Extra> {
  return run(() => {
    const dp = i.decimals ?? 3;
    if (i.mode === 'summary') {
      const s = seriesStats(i.readings, 'Result');
      const n = s.count;
      const sd = s.sd as Dec;
      const u = s.unit.symbol;
      const { c, alpha, text } = confidenceOf(i.confidence);
      const df = d(n - 1);
      const sides = i.sides ?? 'two-sided';
      const tq = tQuantile(sides === 'two-sided' ? ONE.minus(alpha.div(2)) : ONE.minus(alpha), df);
      const half = tq.times(sd).div(d(n).sqrt());
      const ci: Interval = { low: sides === 'upper bound' ? d('-Infinity') : s.mean.minus(half), high: sides === 'lower bound' ? d('Infinity') : s.mean.plus(half) };
      const parts = [`n = ${n}`, `mean = ${show(s.mean, u, dp)}`, `SD = ${fmt(sd, dp + 1)}`, ...(s.rsd ? [`RSD = ${fmt(s.rsd, 2)} %`] : []),
        sides === 'two-sided' ? `${text} % CI ${fmt(ci.low, dp)} to ${fmt(ci.high, dp)} (t = ${fmt(tq, 4)})`
          : `${text} % ${sides} ${fmt(sides === 'lower bound' ? ci.low : ci.high, dp)} (t = ${fmt(tq, 4)}, one-sided)`];
      const extra: { -readonly [K in keyof L14Extra]?: L14Extra[K] } = { n, sd, t: tq, df, ci, ...(s.rsd ? { rsd: s.rsd } : {}) };
      if (i.sdInterval === true) {
        const lowQ = chi2Quantile(alpha.div(2), df);
        const highQ = chi2Quantile(ONE.minus(alpha.div(2)), df);
        extra.sdCi = { low: sd.times(df.div(highQ).sqrt()), high: sd.times(df.div(lowQ).sqrt()) };
        parts.push(`${text} % CI of the SD ${fmt(extra.sdCi.low, dp + 1)} to ${fmt(extra.sdCi.high, dp + 1)} (χ² ${fmt(lowQ, 3)}, ${fmt(highQ, 3)})`);
      }
      if (i.prediction === true) {
        const t2 = tQuantile(ONE.minus(alpha.div(2)), df);
        const h = t2.times(sd).times(ONE.plus(ONE.div(n)).sqrt());
        extra.predictionInterval = { low: s.mean.minus(h), high: s.mean.plus(h) };
        parts.push(`${text} % prediction interval ${fmt(s.mean.minus(h), dp)} to ${fmt(s.mean.plus(h), dp)}`);
      }
      if (i.toleranceCoverage !== undefined) {
        const P = plain(i.toleranceCoverage, 'The coverage').v;
        if (!P.gt(0) || !P.lt(100)) refuse('The coverage is a % between 0 and 100');
        const z2 = chi2Quantile(P.div(HUNDRED), ONE); // z((1 + P) ÷ 2)² = χ²(P; 1)
        const k = df.times(ONE.plus(ONE.div(n))).times(z2).div(chi2Quantile(alpha, df)).sqrt();
        extra.k = k;
        extra.toleranceInterval = { low: s.mean.minus(k.times(sd)), high: s.mean.plus(k.times(sd)) };
        parts.push(`tolerance interval (${i.toleranceCoverage} % coverage, ${text} % confidence, Howe k = ${fmt(k, 4)}) ${fmt(extra.toleranceInterval.low, dp)} to ${fmt(extra.toleranceInterval.high, dp)}`);
      }
      if (i.trueValue !== undefined) {
        const tv = parse(i.trueValue, 'The true value');
        sameKind([tv, { v: s.mean, unit: s.unit, text: '' }], 'The true value');
        const bias = s.mean.minus(to(tv, s.unit));
        extra.bias = bias;
        const t2 = tQuantile(ONE.minus(alpha.div(2)), df);
        const h = t2.times(sd).div(d(n).sqrt());
        extra.biasCi = { low: bias.minus(h), high: bias.plus(h) };
        parts.push(`bias against ${tv.text} = ${fmt(bias, dp)} (${text} % CI ${fmt(bias.minus(h), dp)} to ${fmt(bias.plus(h), dp)})`);
      }
      if (i.rsdLimit !== undefined) {
        if (s.rsd === undefined) refuse('The % RSD needs a mean other than zero');
        extra.rsdCheck = checkLimit(s.rsd, '%', i.rsdLimit);
      }
      void c;
      return { ok: true, value: s.mean, unit: u, shown: parts.join('; '), ...extra, ...checkOf(s.mean, u, i.limit) };
    }
    const a = seriesStats(i.a, 'Result a');
    const b = seriesStats(i.b, 'Result b');
    sameKind([{ v: a.mean, unit: a.unit, text: 'a' }, { v: b.mean, unit: b.unit, text: 'b' }], 'Two series');
    const bMean = to({ v: b.mean, unit: b.unit, text: '' }, a.unit);
    const bSd = to({ v: b.sd as Dec, unit: b.unit, text: '' }, a.unit).abs();
    const aSd = a.sd as Dec;
    const { alpha, text } = confidenceOf(i.confidence);
    const na = d(a.count);
    const nb = d(b.count);
    const u = a.unit.symbol;
    if (i.mode === 'two means') {
      const diff = a.mean.minus(bMean);
      let se: Dec;
      let df: Dec;
      if (i.variances === 'equal') {
        df = na.plus(nb).minus(2);
        const sp2 = na.minus(1).times(aSd.pow(2)).plus(nb.minus(1).times(bSd.pow(2))).div(df);
        se = sp2.times(ONE.div(na).plus(ONE.div(nb))).sqrt();
      } else {
        const va = aSd.pow(2).div(na);
        const vb = bSd.pow(2).div(nb);
        se = va.plus(vb).sqrt();
        df = va.plus(vb).pow(2).div(va.pow(2).div(na.minus(1)).plus(vb.pow(2).div(nb.minus(1))));
      }
      if (se.isZero()) refuse('Both series have no spread: the difference cannot be tested');
      const tq = tQuantile(ONE.minus(alpha.div(2)), df);
      const ci = { low: diff.minus(tq.times(se)), high: diff.plus(tq.times(se)) };
      const significant = ci.low.gt(0) || ci.high.lt(0);
      const shown = `mean a ${show(a.mean, u, dp)} − mean b ${show(bMean, u, dp)} = ${show(diff, u, dp)}; ${i.variances === 'equal' ? 'pooled SD' : 'Welch'}, df = ${fmt(df, i.variances === 'equal' ? 0 : 2)}, t = ${fmt(tq, 4)}; ${text} % CI ${fmt(ci.low, dp)} to ${fmt(ci.high, dp)}: ${significant ? 'SIGNIFICANT difference' : 'no significant difference'}`;
      return { ok: true, value: diff, unit: u, t: tq, df, ci, significant, shown, ...checkOf(diff, u, i.limit) };
    }
    const va = aSd.pow(2);
    const vb = bSd.pow(2);
    if (vb.isZero() || va.isZero()) refuse('A series with no spread cannot be used in an F test');
    const sides = i.sides ?? 'two-sided';
    let F: Dec;
    let d1: Dec;
    let d2: Dec;
    if (sides === 'two-sided') {
      const aTop = va.gte(vb);
      F = aTop ? va.div(vb) : vb.div(va);
      d1 = aTop ? na.minus(1) : nb.minus(1);
      d2 = aTop ? nb.minus(1) : na.minus(1);
    } else {
      F = va.div(vb); d1 = na.minus(1); d2 = nb.minus(1);
    }
    const critical = fQuantile(sides === 'two-sided' ? ONE.minus(alpha.div(2)) : ONE.minus(alpha), d1, d2);
    const significant = F.gt(critical);
    const shown = `F = ${sides === 'two-sided' ? 'larger ÷ smaller variance' : 's²a ÷ s²b'} = ${fmt(F, 3)} (df ${d1.toString()}, ${d2.toString()}); critical F(${sides === 'two-sided' ? `${fmt(ONE.minus(alpha.div(2)), 3)}` : `${fmt(ONE.minus(alpha), 3)}`}) = ${fmt(critical, 3)}: ${significant ? 'the variances DIFFER' : 'no significant difference between the variances'}`;
    return { ok: true, value: F, unit: '', F, critical, significant, shown, ...checkOf(F, '', i.limit) };
  });
}

// ================================================================ L17 Standardisation
/**
 * L17 Standardisation.
 * - VS factor: each replicate f = m × purity ÷ 100 ÷ (E × (V − V blank)); E = mg of the primary standard equivalent to
 *   1 mL of VS of the stated molarity. The factor is the mean; its % RSD is checked (e.g. NMT 0.2 %); the actual
 *   molarity = stated × factor.
 * - KF water equivalent: F = m × water content ÷ 100 ÷ V (mg/mL), water 100 % or sodium tartrate dihydrate (certificate).
 * - working standard: potency = (R(ws) ÷ c(ws)) ÷ (R(ps) ÷ c(ps)) × potency of the primary, c = mass ÷ dilution
 *   volume; one potency per working-standard preparation, the mean reported.
 */
export type L17Input = { readonly decimals?: number; readonly limit?: Limit; readonly rsdLimit?: Limit } & (
  | {
      readonly mode: 'VS factor';
      readonly molarity: Q;
      /** E: mg of the primary standard equivalent to 1 mL of VS of the stated molarity. */
      readonly equivalent: Q;
      readonly purity?: Q;
      readonly replicates: readonly { readonly mass: Q; readonly volume: Q; readonly blank?: Q }[];
      readonly temperature?: Q;
    }
  | { readonly mode: 'KF water equivalent'; readonly waterContent: Q; readonly replicates: readonly { readonly mass: Q; readonly volume: Q }[] }
  | {
      readonly mode: 'working standard';
      readonly primary: { readonly potency: Q; readonly preparations: readonly Prep[] };
      readonly working: { readonly preparations: readonly Prep[] };
      readonly basis?: Basis;
    }
);
export interface Prep {
  readonly mass: Q;
  readonly responses: readonly Q[];
  /** The volume the mass was made up to (with any further dilution), the same for every preparation of a kind. */
  readonly volume?: Q;
}

export interface L17Extra {
  readonly replicates: readonly Dec[];
  readonly sd?: Dec;
  readonly rsd?: Dec;
  readonly rsdCheck?: Check;
  readonly molarity?: Dec;
}

function prepFactor(p: Prep, what: string): { rf: Dec; text: string } {
  const m = parse(p.mass, `${what} mass`);
  needKind(m, ['mass'], `${what} mass`);
  positive(m, `${what} mass`);
  if (p.responses.length === 0) refuse(`${what}: give its responses`);
  const rs = p.responses.map((q, k) => parse(q, `${what} response ${k + 1}`));
  sameKind(rs, `${what} responses`);
  const mean = rs.reduce((s, x) => s.plus(to(x, rs[0]!.unit)), ZERO).div(rs.length);
  if (!mean.isPositive() || mean.isZero()) refuse(`${what}: the response must be more than zero`);
  let conc = to(m, 'mg');
  if (p.volume !== undefined) {
    const v = parse(p.volume, `${what} volume`);
    needKind(v, ['volume'], `${what} volume`);
    positive(v, `${what} volume`);
    conc = conc.div(to(v, 'mL'));
  }
  return { rf: mean.div(conc), text: `${num(mean, '')} ÷ ${m.text}${p.volume ? ` in ${parse(p.volume, 'v').text}` : ''}` };
}

export function l17Standardisation(i: L17Input): Outcome<L17Extra> {
  return run(() => {
    let reps: Dec[];
    let unit: string;
    let lines: string[];
    let tail = '';
    let molarity: Dec | undefined;
    if (i.mode === 'VS factor' || i.mode === 'KF water equivalent') {
      if (i.replicates.length === 0) refuse('Give at least one replicate');
      if (i.mode === 'VS factor') {
        const M = molarityOf(i.molarity, 'The stated molarity');
        positive(M, 'The stated molarity');
        const E = parse(i.equivalent, 'The equivalent');
        needKind(E, ['mass'], 'The equivalent (mg of primary standard per mL of VS)');
        positive(E, 'The equivalent');
        const pur = i.purity === undefined ? undefined : percent(i.purity, 'The purity of the primary standard');
        if (pur && (pur.v.lte(0) || pur.v.gt(HUNDRED))) refuse('The purity must be more than 0 and not more than 100 %');
        unit = '';
        lines = [];
        reps = i.replicates.map((r, k) => {
          const m = parse(r.mass, `Replicate ${k + 1} mass`);
          needKind(m, ['mass'], `Replicate ${k + 1} mass`);
          positive(m, `Replicate ${k + 1} mass`);
          const V = parse(r.volume, `Replicate ${k + 1} volume`);
          needKind(V, ['volume'], `Replicate ${k + 1} volume`);
          const b = r.blank === undefined ? undefined : parse(r.blank, `Replicate ${k + 1} blank`);
          if (b) needKind(b, ['volume'], `Replicate ${k + 1} blank`);
          const net = to(V, 'mL').minus(b ? to(b, 'mL') : ZERO);
          if (!net.isPositive() || net.isZero()) refuse(`Replicate ${k + 1}: the titre less the blank must be more than zero`);
          const f = to(m, 'mg').times(pur ? pur.v.div(HUNDRED) : ONE).div(to(E, 'mg').times(net));
          if (f.lt('0.8') || f.gt('1.2')) refuse(`Replicate ${k + 1} gives a factor of ${fmt(f, 4)}, not near 1: check the mass, the titre and the equivalent (is the equivalent for ${M.text}?)`);
          lines.push(`${m.text}${pur ? ` × ${pur.text}` : ''} ÷ (${E.text}/mL × ${b ? `(${V.text} − ${b.text})` : V.text}) = ${fmt(f, 4)}`);
          return f;
        });
        const mean = reps.reduce((s, x) => s.plus(x), ZERO).div(reps.length);
        molarity = to(M, 'mol/L').times(mean);
        tail = `; molarity = ${M.text} × ${fmt(mean, 4)} = ${fmt(molarity, 5)} M${i.temperature ? ` (standardised at ${parse(i.temperature, 'The temperature').text})` : ''}`;
      } else {
        const w = percent(i.waterContent, 'The water content of the standard');
        if (w.v.lte(0) || w.v.gt(HUNDRED)) refuse('The water content must be more than 0 and not more than 100 %');
        unit = 'mg/mL';
        lines = [];
        reps = i.replicates.map((r, k) => {
          const m = parse(r.mass, `Replicate ${k + 1} mass`);
          needKind(m, ['mass'], `Replicate ${k + 1} mass`);
          positive(m, `Replicate ${k + 1} mass`);
          const V = parse(r.volume, `Replicate ${k + 1} titre`);
          needKind(V, ['volume'], `Replicate ${k + 1} titre`);
          positive(V, `Replicate ${k + 1} titre`);
          const F = to(m, 'mg').times(w.v).div(HUNDRED).div(to(V, 'mL'));
          lines.push(`${m.text} × ${w.text} ÷ ${V.text} = ${fmt(F, 4)} mg/mL`);
          return F;
        });
      }
    } else {
      const P = percent(i.primary.potency, 'The potency of the primary standard');
      if (P.v.lte(0) || P.v.gt(HUNDRED)) refuse('The potency of the primary standard must be more than 0 and not more than 100 %');
      if (i.primary.preparations.length === 0 || i.working.preparations.length === 0) refuse('Give at least one preparation of the primary and of the working standard');
      const all = [...i.primary.preparations, ...i.working.preparations];
      if (all.some((p) => p.volume === undefined) && all.some((p) => p.volume !== undefined)) refuse('Give the dilution volume for every preparation, or for none (when all are made up the same way)');
      const ps = i.primary.preparations.map((p, k) => prepFactor(p, `Primary preparation ${k + 1}`));
      const rfPs = ps.reduce((s, x) => s.plus(x.rf), ZERO).div(ps.length).div(P.v.div(HUNDRED));
      unit = '%';
      lines = [];
      reps = i.working.preparations.map((p, k) => {
        const w = prepFactor(p, `Working standard preparation ${k + 1}`);
        const pot = w.rf.div(rfPs).times(HUNDRED);
        lines.push(`(${w.text}) = ${fmt(pot, 2)} %`);
        return pot;
      });
      tail = `; primary ${P.text}, response per mg of pure substance ${shownNumber(rfPs, '')}`;
    }
    const st = stats(reps.map((v) => ({ v, unit: unitOf(unit), text: '' })));
    let value = st.mean;
    let basisLine = '';
    if (i.mode === 'working standard' && i.basis !== undefined) {
      const b = applyBasis(value, i.basis);
      value = b.v;
      basisLine = b.line;
    }
    let rsdCheck: Check | undefined;
    if (i.rsdLimit !== undefined) {
      if (st.rsd === undefined) refuse('The % RSD needs at least two replicates');
      rsdCheck = checkLimit(st.rsd, '%', i.rsdLimit);
    }
    const dp = i.decimals ?? (i.mode === 'working standard' ? 1 : 4);
    const shown = `${lines.join('; ')}; mean${basisLine} = ${show(value, unit, dp)}${st.rsd ? `, RSD ${fmt(st.rsd, 2)} %` : ''}${tail}${rsdCheck ? ` (${rsdCheck.shown})` : ''}`;
    return { ok: true, value, unit, replicates: reps, ...(st.sd ? { sd: st.sd } : {}), ...(st.rsd ? { rsd: st.rsd } : {}), ...(rsdCheck ? { rsdCheck } : {}), ...(molarity ? { molarity } : {}), shown, ...checkOf(value, unit, i.limit) };
  });
}

// ================================================================ L19 Sampling plan size
/**
 * L19 Sampling plan size.
 * - square root (WHO good practices for sampling, "n plan"): containers to sample n = 1 + √N, rounded up, not more than N;
 *   tested each, as one composite, or as composites of a given number of containers.
 * - every container: n = N.
 * - sterility containers (Ph.Int 3.2 / Ph. Eur. 2.6.1 / USP <71>, harmonised, paraphrased): by product type and batch
 *   size; percentages rounded up to whole containers; doubled when one container cannot inoculate both media.
 * - sterility quantity: the least quantity per container for each medium, by the content of the container.
 * - extractable volume (Ph.Int 5.6 / Ph. Eur. 2.9.17): containers by nominal volume (≥ 10 mL: 1; > 3 mL: 3; else 5).
 */
export type SterilityProduct =
  | 'parenteral' | 'large-volume parenteral' | 'antibiotic solid, bulk package under 5 g' | 'antibiotic solid, bulk package 5 g or more'
  | 'ophthalmic and other non-injectable' | 'devices' | 'bulk solid';

export type L19Input =
  | { readonly mode: 'square root' | 'every container'; readonly containers: Q; readonly test?: 'each container' | 'one composite' | { readonly compositesOf: number } }
  // tested (a worksheet's count of containers tested): checked to be at least the number required (sterility test block).
  | { readonly mode: 'sterility containers'; readonly batchSize: Q; readonly product: SterilityProduct; readonly oneContainerForBothMedia: boolean | 'yes' | 'no'; readonly tested?: Q }
  | { readonly mode: 'sterility quantity'; readonly content: Q; readonly product: 'liquid' | 'antibiotic liquid' | 'solid' | 'insoluble, cream or ointment' }
  | { readonly mode: 'extractable volume'; readonly nominal: Q };

function wholeCount(q: Q, what: string): number {
  const p = parse(q, what);
  if (p.unit.kind !== 'number') needKind(p, ['count'], what);
  if (!p.v.isInteger() || p.v.lt(1)) refuse(`${what} must be a whole number, 1 or more`);
  return p.v.toNumber();
}

export function l19SamplingPlan(i: L19Input): Outcome<{ readonly tests?: number; readonly quantity?: Dec }> {
  return run(() => {
    switch (i.mode) {
      case 'square root':
      case 'every container': {
        const N = wholeCount(i.containers, 'The number of containers');
        let n: number;
        let line: string;
        if (i.mode === 'every container') { n = N; line = `every container: ${N}`; }
        else {
          const raw = d(N).sqrt().plus(1);
          const up = raw.ceil().toNumber();
          n = Math.min(up, N);
          line = `1 + √${N} = ${fmt(raw, 2)}, rounded up = ${up}${up > N ? `, but only ${N} containers: all ${N}` : ''}`;
        }
        const t = i.test ?? 'each container';
        let tests: number;
        let tl: string;
        if (t === 'each container') { tests = n; tl = `each tested: ${n} tests`; }
        else if (t === 'one composite') { tests = 1; tl = 'pooled into one composite sample'; }
        else {
          if (!Number.isInteger(t.compositesOf) || t.compositesOf < 1) refuse('The number of containers per composite must be a whole number, 1 or more');
          tests = Math.ceil(n / t.compositesOf);
          tl = `composites of up to ${t.compositesOf} containers: ${tests} composites`;
        }
        return { ok: true, value: d(n), unit: 'units', tests, shown: `sample ${n} of ${N} containers (${line}); ${tl}` };
      }
      case 'sterility containers': {
        const N = wholeCount(i.batchSize, 'The batch size');
        const pctUp = (p: number): number => d(N).times(p).div(100).ceil().toNumber();
        let n: number;
        let rule: string;
        switch (i.product) {
          case 'parenteral':
          case 'devices':
            if (N <= 100) { n = Math.max(pctUp(10), 4); rule = 'not more than 100: 10 % or 4, whichever is greater'; }
            else if (N <= 500) { n = 10; rule = 'more than 100, not more than 500: 10'; }
            else { n = Math.min(pctUp(2), 20); rule = 'more than 500: 2 % or 20, whichever is less'; }
            break;
          case 'large-volume parenteral':
            // As other parenterals; only the band above 500 containers is capped at 10 (Ph.Int 3.2 Table 3).
            if (N <= 100) { n = Math.max(pctUp(10), 4); rule = 'not more than 100: 10 % or 4, whichever is greater'; }
            else if (N <= 500) { n = 10; rule = 'more than 100, not more than 500: 10'; }
            else { n = Math.min(pctUp(2), 10); rule = 'large-volume parenterals, more than 500: 2 % or 10, whichever is less'; }
            break;
          case 'antibiotic solid, bulk package under 5 g':
            n = 20; rule = 'antibiotic solids, pharmacy bulk packages under 5 g: 20';
            break;
          case 'antibiotic solid, bulk package 5 g or more':
            n = 6; rule = 'antibiotic solids, pharmacy bulk packages of 5 g or more: 6';
            break;
          case 'ophthalmic and other non-injectable':
            if (N <= 200) { n = Math.max(pctUp(5), 2); rule = 'not more than 200: 5 % or 2, whichever is greater'; }
            else { n = 10; rule = 'more than 200: 10'; }
            break;
          case 'bulk solid':
            if (N <= 4) { n = N; rule = 'up to 4 containers: each container'; }
            else if (N <= 50) { n = Math.max(pctUp(20), 4); rule = 'more than 4, not more than 50: 20 % or 4, whichever is greater'; }
            else { n = Math.max(pctUp(2), 10); rule = 'more than 50: 2 % or 10, whichever is greater'; }
            break;
          default:
            return refuse('Unknown product type for the sterility table');
        }
        const both = i.oneContainerForBothMedia === 'yes' ? true : i.oneContainerForBothMedia === 'no' ? false : i.oneContainerForBothMedia;
        if (typeof both !== 'boolean') refuse('Say whether the contents of one container are enough to inoculate both media');
        const perMedia = both ? n : n * 2;
        const all = perMedia >= N;
        const value = Math.min(perMedia, N);
        const shown = `${i.product}, batch of ${N} (${rule}): ${n}${both ? ' for both media together' : `, × 2 as one container cannot inoculate both media = ${perMedia}`}${all ? `; the batch has only ${N}: test all ${N}` : ''}`;
        if (i.tested === undefined) return { ok: true, value: d(value), unit: 'units', shown };
        const tested = wholeCount(i.tested, 'The number of containers tested');
        const pass = tested >= value;
        const line = `${shown}; ${tested} tested: ${pass ? 'enough' : `TOO FEW (at least ${value})`}`;
        return { ok: true, value: d(value), unit: 'units', shown: line, check: { pass, level: pass ? 'pass' : 'fail', rounded: `${tested} units`, shown: line } };
      }
      case 'sterility quantity': {
        const c = parse(i.content, 'The content of the container');
        positive(c, 'The content of the container');
        let q: Dec;
        let unit: string;
        let rule: string;
        if (i.product === 'liquid' || i.product === 'antibiotic liquid') {
          needKind(c, ['volume'], 'The content of a liquid container');
          const v = to(c, 'mL');
          unit = 'mL';
          if (i.product === 'antibiotic liquid') { q = ONE; rule = 'antibiotic liquids: 1 mL'; }
          else if (v.lt(1)) { q = v; rule = 'less than 1 mL: the whole contents'; }
          else if (v.lte(40)) { q = Dec.max(v.div(2), ONE); rule = '1-40 mL: half the contents, not less than 1 mL'; }
          else if (v.lte(100)) { q = d(20); rule = 'more than 40, not more than 100 mL: 20 mL'; }
          else { q = Dec.max(v.div(10), d(20)); rule = 'more than 100 mL: 10 % of the contents, not less than 20 mL'; }
        } else if (i.product === 'insoluble, cream or ointment') {
          needKind(c, ['mass'], 'The content of the container');
          q = d(200); unit = 'mg'; rule = 'insoluble preparations, creams and ointments: the contents giving not less than 200 mg';
          if (to(c, 'mg').lt(200)) refuse(`A container of ${c.text} cannot give 200 mg: pool the contents of several containers as the method says`);
        } else {
          needKind(c, ['mass'], 'The content of a solid container');
          const m = to(c, 'mg');
          unit = 'mg';
          if (m.lt(50)) { q = m; rule = 'less than 50 mg: the whole contents'; }
          else if (m.lt(300)) { q = Dec.max(m.div(2), d(50)); rule = '50 mg to less than 300 mg: half the contents, not less than 50 mg'; }
          else if (m.lte(5000)) { q = d(150); rule = '300 mg to 5 g: 150 mg'; }
          else { q = d(500); rule = 'more than 5 g: 500 mg'; }
        }
        return { ok: true, value: q, unit, quantity: q, shown: `${i.product}, ${c.text} per container (${rule}): at least ${num(q, unit)} ${unit} for each medium` };
      }
      case 'extractable volume': {
        const v = parse(i.nominal, 'The nominal volume');
        needKind(v, ['volume'], 'The nominal volume');
        positive(v, 'The nominal volume');
        const ml = to(v, 'mL');
        const n = ml.gte(10) ? 1 : ml.gt(3) ? 3 : 5;
        const rule = ml.gte(10) ? '10 mL or more: 1' : ml.gt(3) ? 'more than 3 mL and less than 10 mL: 3' : '3 mL or less: 5';
        return { ok: true, value: d(n), unit: 'units', shown: `nominal ${v.text} (${rule}): ${n} container${n === 1 ? '' : 's'}` };
      }
      default:
        return refuse('Unknown L19 mode');
    }
  });
}

// ---- L35 Complies / does not comply (owner 21 Nov 2026) ----
/**
 * A test whose result is a judgement, not a number (description, identification, visual checks of packing material):
 * the analyst finds that the sample complies with what the specification says it must show, or does not. The result
 * is that word; it has no number. "Does not comply" fails the check (an OOS, as an out-of-limit number).
 */
export interface L35Input { readonly answer: string; readonly requirement?: string; readonly what?: string }
export const COMPLIES = ['Complies', 'Does not comply'] as const;
export function l35Complies(i: L35Input): Outcome<{ readonly text: string }> {
  return run(() => {
    const a = (i.answer ?? '').trim().toLowerCase();
    if (a !== 'complies' && a !== 'does not comply') refuse(`Pick Complies or Does not comply (not "${i.answer}")`);
    const pass = a === 'complies';
    const text = pass ? 'Complies' : 'DOES NOT COMPLY';
    const req = i.requirement?.trim();
    const shown = `${i.what?.trim() ? `${i.what.trim()}: ` : ''}${text}${req ? ` (must show: ${req})` : ''}`;
    return { ok: true, value: pass ? ZERO : ONE, unit: '', shown, check: { pass, level: pass ? 'pass' : 'fail', rounded: text, shown }, text };
  });
}
