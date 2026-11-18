/**
 * Lab calculation templates, microbiology (Medhanta LIMS library 3b and 8b, build step 7):
 * L11 Microbial count, L12 Bacterial endotoxins, L13 Antibiotic potency by microbial assay.
 *
 * Same rules as every template (README): inputs are text with units, exact decimals, a plain-English refusal,
 * nothing rounded inside a calculation; pharmacopoeia rounding only when a limit is checked. Pharmacopoeia rules
 * are paraphrased (Ph.Int 3.1, 3.3.1, 3.4; the harmonised Ph. Eur. 2.6.12 / 2.6.14 / USP <61> <85>, Ph. Eur. 5.3 for
 * the parallel-line statistics); only the published MPN table is reproduced as numbers.
 *
 * An assay that is not valid (a standard curve with |r| below 0.980, a spike recovered outside 50-200 %, a gel-clot
 * control with the wrong reaction, a microbial assay whose regression is not significant or whose lines are not
 * parallel) is REFUSED with the reason: there is no result to report, the test is repeated. A valid result outside
 * its limit is a result (its check fails: an OOS).
 */
import { checkOf, Dec, fmt, HUNDRED, needKind, ONE, parse, refuse, run, sameKind, shownNumber, to, unitOf, ZERO, type Done, type Outcome, type Parsed, type Q } from './core.js';
import { checkLimit, type Check, type Limit } from './rounding.js';
import { fQuantile, tQuantile } from './lab-physchem.js';

const d = (x: string | number): Dec => new Dec(x);
const TWO = d(2);
const positive = (p: Parsed, what: string): void => {
  if (!p.v.isPositive() || p.v.isZero()) refuse(`${what} must be more than zero`);
};
/** A plain number (a dilution factor "10", a count of tubes), with or without the empty unit. */
function plainNumber(text: unknown, what: string): Dec {
  if (typeof text !== 'string' && !(text && typeof text === 'object' && 'value' in text)) refuse(`${what} is missing`);
  const p = parse(text as Q, what);
  if (p.unit.kind !== 'number' && p.unit.kind !== 'count') needKind(p, ['number'], what);
  return p.v;
}
const num = (v: Dec, unit: string): string => shownNumber(v, unit, { written: v.toString() });
/** A count result shown as people write it: whole numbers, at most 2 decimals otherwise ("485", "3.6"). */
const count = (v: Dec): string => (v.isInteger() ? v.toFixed(0) : v.gte(100) ? fmt(v, 0) : v.toDecimalPlaces(2, Dec.ROUND_HALF_UP).toString());

/** "Less than" or "more than" a reported bound (none counted at the lowest dilution; too many at the highest). */
export type Qualifier = '<' | '>' | '≥';

/**
 * A result reported as a bound ("< 10 CFU/g"): its check is decided by the bound only when the bound decides it.
 * "< x" passes a "not more than" limit when x itself passes; "> x" or "≥ x" fails it when x is already above. Otherwise
 * the bound cannot tell, and the test is done again with another dilution.
 */
function boundCheck(value: Dec, unit: string, q: Qualifier | undefined, limit: Limit | undefined, again: string): { check?: Check } {
  if (limit === undefined) return {};
  const c = checkLimit(value, unit, limit);
  if (q === undefined) return { check: c };
  if (limit.low !== undefined) refuse(`A result "${q} ${count(value)} ${unit}" cannot be checked against a lower limit: ${again}`);
  if (q === '<') {
    if (!c.pass) refuse(`The result is only known to be less than ${count(value)} ${unit}, which is above the limit: ${again}`);
    return { check: { ...c, rounded: `< ${c.rounded}`, shown: `less than ${c.shown}` } };
  }
  if (c.pass) refuse(`The result is only known to be ${q === '>' ? 'more than' : 'at least'} ${count(value)} ${unit}, which is within the limit: ${again}`);
  return { check: { ...c, rounded: `${q} ${c.rounded}`, shown: `${q === '>' ? 'more than' : 'at least'} ${c.shown}` } };
}

// ================================================================ L11 Microbial count
/**
 * Microbial acceptance written as 10^n (Ph.Int 3.3.1 and the harmonised texts, paraphrased): a criterion of 10^1 means
 * a maximum acceptable count of 20, 10^2 of 200, 10^3 of 2000, and so on. The specification writes 10^n as its
 * upper limit (e.g. "1000"); this reads it as NMT 2 × 10^n (safety rule S8: typed literally it fails good batches,
 * typed as 2 × 10^n and doubled again it accepts twice too many). An upper limit that is not a power of ten is refused.
 */
export function tenToN(limit: Limit): Limit {
  if (limit.high === undefined) refuse('A microbial acceptance criterion 10^n is an upper limit (e.g. "1000" for 10^3): give the upper limit');
  if (limit.low !== undefined) refuse('A microbial acceptance criterion 10^n has no lower limit');
  const h = d(limit.high);
  const n = Dec.log10(h);
  if (!h.isPositive() || !n.isInteger()) refuse(`The upper limit ${limit.high} is not a power of ten (10, 100, 1000 …): a microbial 10^n criterion is written as the power of ten itself, and read as not more than twice it`);
  const doubled = h.times(2).toFixed(0);
  if (limit.alertHigh !== undefined && d(limit.alertHigh).gt(doubled)) refuse(`The alert limit ${limit.alertHigh} is above the maximum acceptable count ${doubled}`);
  return { ...limit, high: doubled, highStrict: false };
}

/** The counting ranges a method may name (per plate). TAMC and TYMC: the plates with the highest count fewer than 250 or 50. */
export const COUNTABLE: Record<string, { low?: number; high: number; strict: boolean }> = {
  'TAMC: fewer than 250 per plate': { high: 250, strict: true },
  'TYMC: fewer than 50 per plate': { high: 50, strict: true },
  '30 to 300 per plate': { low: 30, high: 300, strict: false },
  '25 to 250 per plate': { low: 25, high: 250, strict: false },
  '15 to 150 per plate': { low: 15, high: 150, strict: false },
  'membrane: up to 100': { high: 100, strict: false },
};
export const COUNT_PER = ['CFU/g', 'CFU/mL', 'CFU/m³', 'CFU'] as const;

/**
 * The most-probable-number table for 3 tubes at 0.1, 0.01 and 0.001 g (or mL) of product per tube: tubes with growth
 * at each level → MPN per g or mL with its 95 % confidence limits. As published in Ph.Int 3.3.1 Table 3 (the
 * harmonised table of Ph. Eur. 2.6.12 and USP <61>). Combinations not in the table are not expected and are refused.
 */
export const MPN_TABLE: readonly (readonly [string, string, string, string])[] = [
  ['000', '3', '0', '9.4'], ['001', '3', '0.1', '9.5'], ['010', '3', '0.1', '10'], ['011', '6.1', '1.2', '17'], ['020', '6.2', '1.2', '17'], ['030', '9.4', '3.5', '35'],
  ['100', '3.6', '0.2', '17'], ['101', '7.2', '1.2', '17'], ['102', '11', '4', '35'], ['110', '7.4', '1.3', '20'], ['111', '11', '4', '35'], ['120', '11', '4', '35'],
  ['121', '15', '5', '38'], ['130', '16', '5', '38'], ['200', '9.2', '1.5', '35'], ['201', '14', '4', '35'], ['202', '20', '5', '38'], ['210', '15', '4', '38'],
  ['211', '20', '5', '38'], ['212', '27', '9', '94'], ['220', '21', '5', '40'], ['221', '28', '9', '94'], ['222', '35', '9', '94'], ['230', '29', '9', '94'],
  ['231', '36', '9', '94'], ['300', '23', '5', '94'], ['301', '38', '9', '104'], ['302', '64', '16', '181'], ['310', '43', '9', '181'], ['311', '75', '17', '199'],
  ['312', '120', '30', '360'], ['313', '160', '30', '380'], ['320', '93', '18', '360'], ['321', '150', '30', '380'], ['322', '210', '30', '400'], ['323', '290', '90', '990'],
  ['330', '240', '40', '990'], ['331', '460', '90', '1980'], ['332', '1100', '200', '4000'], ['333', '1100', '', ''],
];

export interface L11Level {
  /** The dilution factor of this level (1 for the undiluted preparation, "10" for 1 in 10). */
  readonly dilution: string;
  /** The colonies counted on each plate (or membrane) of this level. */
  readonly counts?: readonly Q[];
  /** Too numerous to count: every plate of this level. */
  readonly tntc?: boolean | 'yes' | 'no';
}
export type L11Input = {
  readonly decimals?: number;
  /** The negative control (diluent or medium only): growth makes the test not valid (investigate, repeat). */
  readonly negativeControl?: 'no growth' | 'growth';
  readonly limit?: Limit;
  /** '10^n': the upper limit is a 10^n criterion, read as NMT 2 × 10^n; 'as written' (EM alert and action levels). */
  readonly acceptance?: '10^n' | 'as written';
} & (
  | {
      readonly mode: 'plate count';
      /** A list, or (from a block) levels by number whose dilution the method leaves out are not used. */
      readonly levels: readonly L11Level[] | Readonly<Record<string, Partial<L11Level>>>;
      /** The recovery (correction) factor of a validated bioburden method: the count × this factor. */
      readonly recoveryFactor?: string;
      /** The volume of each level plated or filtered (mL), the air sampled (L or m³, per m³), or a mass of product. */
      readonly amount?: Q;
      /** CFU per g or per mL of product, per m³ of air, or per plate (CFU: a settle, contact or glove plate). */
      readonly per: (typeof COUNT_PER)[number];
      readonly countable: string;
    }
  | {
      readonly mode: 'MPN';
      /** Tubes with growth at the three levels, most product first (e.g. "3", "1", "0"). */
      readonly positives: readonly string[];
      /** The product per tube at the first level (the table is for 0.1 g or mL; other first levels scale it). */
      readonly firstLevel?: Q;
      readonly per: 'CFU/g' | 'CFU/mL';
    }
);
export interface L11Extra {
  readonly qualifier?: Qualifier;
  /** plate count: the dilution whose plates were used, and the mean count on them. */
  readonly dilution?: Dec;
  readonly mean?: Dec;
  /** MPN: the 95 % confidence limits. */
  readonly lower?: Dec;
  readonly upper?: Dec;
}

const yes = (x: boolean | 'yes' | 'no' | undefined): boolean => x === true || x === 'yes';

export function l11MicrobialCount(i: L11Input): Outcome<L11Extra> {
  return run(() => {
    if (i.negativeControl === 'growth') refuse('The test is not valid: the negative control shows growth. Investigate and repeat the test');
    const limit = i.limit === undefined ? undefined : (i.acceptance ?? 'as written') === '10^n' ? tenToN(i.limit) : i.limit;
    const limitLine = i.limit !== undefined && i.acceptance === '10^n' ? `; criterion 10^${Dec.log10(d(i.limit.high!)).toFixed(0)} read as not more than ${limit!.high} ${i.limit.unit}` : '';
    if (i.mode === 'MPN') {
      if (!['CFU/g', 'CFU/mL'].includes(i.per)) refuse('The MPN result is per g or per mL of product');
      if (!i.positives || i.positives.length !== 3) refuse('The MPN table needs the tubes with growth at three levels');
      const p = i.positives.map((x, k) => {
        const v = plainNumber(x, `Level ${k + 1}: tubes with growth`);
        if (!v.isInteger() || v.lt(0) || v.gt(3)) refuse(`Level ${k + 1}: tubes with growth is 0, 1, 2 or 3 (3 tubes per level)`);
        return v.toFixed(0);
      }).join('');
      const row = MPN_TABLE.find(([k]) => k === p);
      if (!row) refuse(`The combination ${p.split('').join('-')} is not in the MPN table (a growth pattern that is not expected): repeat the test`);
      let scale = ONE;
      let levelLine = '0.1, 0.01 and 0.001';
      if (i.firstLevel !== undefined) {
        const f = parse(i.firstLevel, 'The product per tube at the first level');
        needKind(f, ['mass', 'volume'], 'The product per tube at the first level');
        positive(f, 'The product per tube at the first level');
        const g = to(f, f.unit.kind === 'mass' ? 'g' : 'mL');
        scale = d('0.1').div(g);
        levelLine = `${num(g, '')}, ${num(g.div(10), '')} and ${num(g.div(100), '')}`;
      }
      const unit = i.per;
      const v = d(row[1]).times(scale);
      const q: Qualifier | undefined = p === '000' ? '<' : p === '333' ? '>' : undefined;
      const lower = row[2] === '' ? undefined : d(row[2]).times(scale);
      const upper = row[3] === '' ? undefined : d(row[3]).times(scale);
      const head = `tubes with growth ${p.split('').join('-')} at ${levelLine} ${unit === 'CFU/g' ? 'g' : 'mL'} per tube`;
      const res = q === undefined ? `${count(v)} ${unit} (95 % limits ${count(lower!)} to ${count(upper!)})` : `${q === '<' ? 'less than' : 'more than'} ${count(v)} ${unit}`;
      const check = boundCheck(v, unit, q, limit, 'test again with more (or less) product per tube');
      const shown = `MPN: ${head}${scale.eq(1) ? '' : ` (table ÷ ${num(ONE.div(scale), '')})`} = ${res}${limitLine}${check.check ? `: ${check.check.shown}` : ''}`;
      return { ok: true, value: v, unit, shown, ...(q ? { qualifier: q } : {}), ...(lower ? { lower } : {}), ...(upper ? { upper } : {}), ...check };
    }
    if (i.mode !== 'plate count') return refuse('Unknown L11 mode');
    if (!(COUNT_PER as readonly string[]).includes(i.per)) refuse(`A count is reported per g, per mL, per m³ or per plate (CFU), not "${i.per}"`);
    const range = COUNTABLE[i.countable];
    if (!range) refuse(`Name the counting range of the method (${Object.keys(COUNTABLE).join('; ')})`);
    const given = Array.isArray(i.levels) ? i.levels as readonly L11Level[]
      : Object.values(i.levels ?? {}).filter((l): l is L11Level => l?.dilution !== undefined);
    if (given.length === 0) refuse('Record the plates of at least one dilution');
    let amount: Parsed | undefined;
    if (i.per !== 'CFU') {
      if (i.amount === undefined) refuse(`A count ${i.per === 'CFU/m³' ? 'per m³ needs the volume of air sampled' : 'per g or per mL needs the volume plated or filtered at each dilution'}`);
      amount = parse(i.amount, 'The amount plated');
      if (i.per === 'CFU/m³') needKind(amount, ['volume'], 'The volume of air sampled');
      else needKind(amount, ['volume', 'mass'], 'The amount plated or filtered');
      positive(amount, 'The amount plated');
    }
    const levels = given.map((l, k) => {
      const f = plainNumber(l.dilution, `Dilution ${k + 1}: the dilution factor`);
      if (f.lt(1)) refuse(`Dilution ${k + 1}: a dilution factor is 1 or more (10 for 1 in 10)`);
      const tntc = yes(l.tntc);
      const counts = (l.counts ?? []).map((c, n) => {
        const p = parse(c, `Dilution ${k + 1}, plate ${n + 1}`);
        if (p.unit.kind !== 'number') needKind(p, ['CFU', 'count'], `Dilution ${k + 1}, plate ${n + 1}`);
        if (!p.v.isInteger() || p.v.isNegative()) refuse(`Dilution ${k + 1}, plate ${n + 1}: colonies are counted as a whole number, 0 or more`);
        return p.v;
      });
      if (!tntc && counts.length === 0) refuse(`Dilution ${k + 1}: record the colonies on its plates, or that they were too numerous to count`);
      if (tntc && counts.length > 0) refuse(`Dilution ${k + 1}: the plates are either counted or too numerous to count, not both`);
      const mean = tntc ? undefined : counts.reduce((s, c) => s.plus(c), ZERO).div(counts.length);
      const over = tntc || counts.some((c) => (range.strict ? c.gte(range.high) : c.gt(range.high)));
      return { f, counts, tntc, mean, over, k };
    }).sort((a, b) => a.f.comparedTo(b.f));
    if (i.per === 'CFU' && (levels.length !== 1 || !levels[0]!.f.eq(1))) refuse('A count per plate is read on the plate itself: one level, not diluted');
    for (let n = 1; n < levels.length; n += 1) if (levels[n]!.f.eq(levels[n - 1]!.f)) refuse(`Two levels have the same dilution factor ${levels[n]!.f.toString()}`);
    const unit = i.per;
    let rf = ONE;
    if (i.recoveryFactor !== undefined) {
      rf = plainNumber(i.recoveryFactor, 'The recovery factor');
      if (rf.lt(1)) refuse('A recovery (correction) factor is 1 or more: the count is multiplied by it');
    }
    const factor = (f0: Dec): Dec => {
      const f = f0.times(rf);
      if (amount === undefined) return f;
      if (unit === 'CFU/m³') return f.div(to(amount, 'm³'));
      return f.div(amount.unit.kind === 'mass' ? to(amount, 'g') : to(amount, 'mL'));
    };
    const amountText = `${rf.eq(1) ? '' : ` × recovery factor ${rf.toString()}`}${amount === undefined ? '' : ` ÷ ${amount.text}`}`;
    const plates = (l: (typeof levels)[number]) => (l.tntc ? 'too numerous to count' : `${l.counts.map((c) => c.toString()).join(', ')} (mean ${count(l.mean!)})`);
    const rangeWords = range.low === undefined ? `${range.strict ? 'fewer than' : 'up to'} ${range.high}` : `${range.low} to ${range.high}`;
    const chosen = levels.find((l) => !l.over);
    let value: Dec;
    let q: Qualifier | undefined;
    let line: string;
    if (chosen === undefined) {
      // Every level too many: more than the countable maximum at the highest dilution.
      const top = levels.at(-1)!;
      value = d(range.high).times(factor(top.f));
      q = '>';
      line = `every dilution has too many colonies (at 1 in ${top.f.toString()}: ${plates(top)}); more than ${range.high} × ${top.f.toString()}${amountText} = more than ${count(value)} ${unit}`;
    } else if (chosen.mean!.isZero() && chosen === levels[0]) {
      // None counted at the lowest dilution: less than 1 colony at it.
      value = factor(chosen.f);
      q = '<';
      line = `no colonies at the lowest dilution 1 in ${chosen.f.toString()} (${chosen.counts.length} plate${chosen.counts.length === 1 ? '' : 's'}): less than 1 × ${chosen.f.toString()}${amountText} = less than ${count(value)} ${unit}`;
    } else {
      value = chosen.mean!.times(factor(chosen.f));
      const below = range.low !== undefined && chosen.mean!.lt(range.low) ? ` (below the counting range ${rangeWords}: an estimate)` : '';
      line = `${unit === 'CFU' ? 'plate' : `1 in ${chosen.f.toString()}`}: ${plates(chosen)}, the highest count ${rangeWords}${below}; ${count(chosen.mean!)}${unit === 'CFU' ? '' : ` × ${chosen.f.toString()}${amountText}`} = ${count(value)} ${unit}`;
    }
    const check = boundCheck(value, unit, q, limit, 'count again with other dilutions');
    const shown = `${line}${limitLine}${check.check ? `: ${check.check.shown}` : ''}`;
    return { ok: true, value, unit, shown, ...(q ? { qualifier: q } : {}), ...(chosen ? { dilution: chosen.f, mean: chosen.mean! } : {}), ...check };
  });
}

// ================================================================ L12 Bacterial endotoxins
/**
 * L12 Bacterial endotoxins (Ph.Int 3.4, harmonised with Ph. Eur. 2.6.14 and USP <85>; paraphrased).
 * - MVD (maximum valid dilution) = endotoxin limit × concentration of the sample solution ÷ λ. The concentration is
 *   in the limit's terms (safety rule S8): mg/mL for a limit per mg, IU/mL for a limit per IU, none for a limit per mL.
 *   The sample is never tested at a dilution beyond the MVD.
 * - photometric (kinetic or end-point, turbidimetric or chromogenic): the standard curve is the regression of
 *   log response (onset time, rate or absorbance) on log concentration, |r| ≥ 0.980; λ is the lowest standard (S8).
 *   Each replicate of the sample (A) and of the spiked sample (B) is read back on the curve; the spike recovered,
 *   (mean B − mean A) ÷ spike × 100, is 50-200 %; the negative control (D) below the lowest standard; the result is
 *   mean A × dilution (÷ concentration): it complies when LESS than the limit.
 * - gel clot, confirmation of λ: the end-point of each replicate series (the lowest concentration that clots, as a
 *   multiple of λ); 0.25λ negative in all; the geometric mean (antilog of the mean log end-point) within 0.5λ to 2λ.
 * - gel clot, limit test: solutions A-D in duplicate; B and C positive, D negative; A both negative complies, both
 *   positive does not, one each: repeat once, and the repeat complies only when both are negative.
 * - gel clot, quantitative: A at dilutions 1, 2, 4, 8 in duplicate; each replicate's end-point dilution × λ × the
 *   sample's own dilution (S8); none positive: less than λ × the sample's dilution; positive at 8: at least 8λ ×;
 *   D negative, B positive, C's geometric mean 0.5λ to 2λ; every replicate less than the limit.
 */
export const GEL_ENDPOINTS = ['2λ', 'λ', '0.5λ', '0.25λ', 'no clot'] as const;
const ENDPOINT_FACTOR: Record<string, string> = { '2λ': '2', 'λ': '1', '0.5λ': '0.5', '0.25λ': '0.25' };
export const QUANT_DILUTIONS = ['none positive', '1', '2', '4', '8'] as const;

interface L12Common {
  readonly decimals?: number;
  /** The lysate lot picked (the result is worked out once it is). */
  readonly lysate?: string;
  /** The endotoxin limit of the specification (EU/mL, EU/mg, EU/g or EU/IU): its upper bound, read as "less than". */
  readonly limit?: Limit;
  /** The concentration of the sample solution in the limit's terms (mg/mL, g/mL as %w/v, IU/mL); none for EU/mL. */
  readonly concentration?: Q;
  /** The dilution of the sample solution tested (1: not diluted). */
  readonly dilution?: string;
}
export type L12Input = L12Common & (
  | { readonly mode: 'MVD'; readonly lambda: Q }
  | {
      readonly mode: 'photometric';
      readonly response: 'onset time' | 'rate' | 'absorbance';
      readonly standards: readonly { readonly concentration: Q; readonly responses: readonly Q[] }[];
      readonly sample: readonly Q[];
      readonly spiked: readonly Q[];
      /** The endotoxin added to B (EU/mL in the solution tested). */
      readonly spike: Q;
      /** The negative control (water BET) read below the lowest standard (or no reaction). */
      readonly negativeControl: boolean | 'yes' | 'no';
    }
  | { readonly mode: 'gel clot confirm'; readonly lambda: Q; readonly endpoints: readonly string[] }
  | {
      readonly mode: 'gel clot limit';
      readonly lambda: Q;
      /** '+' (a firm gel) or '−' for each replicate. */
      readonly a: readonly string[]; readonly b: readonly string[]; readonly c: readonly string[]; readonly dControl: readonly string[];
      readonly repeat?: boolean | 'yes' | 'no';
    }
  | {
      readonly mode: 'gel clot quantitative';
      readonly lambda: Q;
      /** Each replicate of A: the greatest dilution (1, 2, 4, 8) that clots, or "none positive". */
      readonly aEndpoints: readonly string[];
      readonly b: readonly string[];
      /** C: each replicate's end-point as a multiple of λ. */
      readonly cEndpoints: readonly string[];
      readonly dControl: readonly string[];
    }
);
export interface L12Extra {
  readonly qualifier?: Qualifier;
  readonly mvd?: Dec;
  readonly r?: Dec;
  readonly recovery?: Dec;
  readonly lambda?: Dec;
  readonly geometricMean?: Dec;
  readonly decision?: 'complies' | 'does not comply';
}

const sign = (x: string, what: string): boolean => {
  const t = x.trim().toLowerCase();
  if (['+', 'positive', 'yes', 'gel'].includes(t)) return true;
  if (['−', '-', 'negative', 'no', 'no gel'].includes(t)) return false;
  return refuse(`${what}: record + (a firm gel) or − (no gel), not "${x}"`);
};
const signs = (xs: readonly string[] | undefined, n: number, what: string): boolean[] => {
  if (!xs || xs.length !== n) refuse(`${what}: record ${n} replicates`);
  return xs.map((x, k) => sign(x, `${what}, replicate ${k + 1}`));
};

/** The limit's unit and the concentration in its terms: the endotoxin per mL of the sample solution that equals the limit. */
function limitPerMl(limit: Limit, concentration: Q | undefined): { perMl: Dec; unit: string; c?: Parsed; line: string } {
  if (limit.high === undefined || limit.low !== undefined) refuse('An endotoxin limit is an upper limit only');
  const lu = unitOf(limit.unit);
  const L = d(limit.high);
  if (lu.kind === 'endotoxin per volume') {
    if (concentration !== undefined) refuse('A limit per mL needs no concentration of the sample solution: leave it out');
    return { perMl: to({ v: L, unit: lu, text: '' }, 'EU/mL'), unit: lu.symbol, line: `${limit.high} ${lu.symbol}` };
  }
  if (concentration === undefined) refuse(`A limit in ${lu.symbol} needs the concentration of the sample solution in its terms (safety rule S8)`);
  const c = parse(concentration, 'The concentration of the sample solution');
  positive(c, 'The concentration of the sample solution');
  if (lu.kind === 'endotoxin per mass') {
    needKind(c, ['mass concentration'], `The concentration for a limit in ${lu.symbol} (safety rule S8: in mg/mL)`);
    const perMl = to({ v: L, unit: lu, text: '' }, 'EU/mg').times(to(c, 'mg/mL'));
    return { perMl, unit: lu.symbol, c, line: `${limit.high} ${lu.symbol} × ${c.text}` };
  }
  if (lu.kind === 'endotoxin per IU') {
    needKind(c, ['IU per volume'], `The concentration for a limit in ${lu.symbol} (safety rule S8: in IU/mL)`);
    return { perMl: L.times(to(c, 'IU/mL')), unit: lu.symbol, c, line: `${limit.high} ${lu.symbol} × ${c.text}` };
  }
  return refuse(`An endotoxin limit is in EU/mL, EU/mg, EU/g or EU/IU, not ${lu.symbol || 'a plain number'}`);
}
/** The endotoxin of the sample (EU/mL of the sample solution) in the limit's terms. */
function inLimitTerms(perMl: Dec, unit: string, c: Parsed | undefined): Dec {
  if (c === undefined) return to({ v: perMl, unit: unitOf('EU/mL'), text: '' }, unit);
  if (c.unit.kind === 'mass concentration') return to({ v: perMl.div(to(c, 'mg/mL')), unit: unitOf('EU/mg'), text: '' }, unit);
  return perMl.div(to(c, 'IU/mL'));
}
function lambdaOf(q: Q): Parsed {
  const l = parse(q, 'The lysate sensitivity λ');
  needKind(l, ['endotoxin per volume'], 'The lysate sensitivity λ (EU/mL)');
  positive(l, 'The lysate sensitivity λ');
  return l;
}
const geoMean = (xs: readonly Dec[]): Dec => Dec.exp(xs.reduce((s, x) => s.plus(Dec.ln(x)), ZERO).div(xs.length));

export function l12Endotoxin(i: L12Input): Outcome<L12Extra> {
  return run(() => {
    const D = i.dilution === undefined ? ONE : plainNumber(i.dilution, 'The dilution of the sample solution');
    if (D.lt(1)) refuse('The dilution of the sample solution is 1 or more');
    const dp = i.decimals ?? 3;
    /** The MVD and the check that the dilution tested is within it. */
    const mvdOf = (lambda: Dec): { mvd?: Dec; line: string } => {
      if (i.limit === undefined) return { line: '' };
      const lt = limitPerMl(i.limit, i.concentration);
      const mvd = lt.perMl.div(lambda);
      if (D.gt(mvd)) refuse(`The sample was diluted 1 in ${D.toString()}, beyond the maximum valid dilution ${fmt(mvd, 1)} (${lt.line} ÷ λ ${num(lambda, '')} EU/mL): at that dilution the limit cannot be seen. Test at a dilution not beyond the MVD`);
      return { mvd, line: `MVD = ${lt.line} ÷ λ ${num(lambda, '')} EU/mL = ${fmt(mvd, 1)}; tested at 1 in ${D.toString()}` };
    };
    const strictLimit = (l: Limit): Limit => ({ ...l, highStrict: true });
    switch (i.mode) {
      case 'MVD': {
        const l = lambdaOf(i.lambda);
        if (i.limit === undefined) refuse('The MVD needs the endotoxin limit');
        const m = mvdOf(to(l, 'EU/mL'));
        return { ok: true, value: m.mvd!, unit: '', mvd: m.mvd!, lambda: to(l, 'EU/mL'), shown: m.line };
      }
      case 'photometric': {
        if (!Array.isArray(i.standards) || i.standards.length < 3) refuse('The standard curve needs at least 3 concentrations of standard endotoxin');
        const pts: { x: Dec; y: Dec }[] = [];
        const ru = i.response === 'absorbance' ? ['absorbance', 'number'] : i.response === 'onset time' ? ['time'] : ['number', 'absorbance'];
        const resp = (q: Q, what: string): Dec => {
          const p = parse(q, what);
          if (!ru.includes(p.unit.kind)) refuse(`${what}: an ${i.response} is ${i.response === 'onset time' ? 'a time (s)' : 'a plain number or an absorbance'}, not "${p.text}"`);
          positive(p, what);
          return p.unit.kind === 'time' ? to(p, 's') : p.unit.kind === 'absorbance' ? to(p, 'AU') : p.v;
        };
        const concs = i.standards.map((s, k) => {
          const c = parse(s.concentration, `Standard ${k + 1}: concentration`);
          needKind(c, ['endotoxin per volume'], `Standard ${k + 1}: concentration (EU/mL)`);
          positive(c, `Standard ${k + 1}: concentration`);
          if (!s.responses?.length) refuse(`Standard ${k + 1}: record its responses`);
          for (const [n, r] of s.responses.entries()) pts.push({ x: Dec.log10(to(c, 'EU/mL')), y: Dec.log10(resp(r, `Standard ${k + 1}, replicate ${n + 1}`)) });
          return to(c, 'EU/mL');
        });
        if (new Set(concs.map((c) => c.toString())).size !== concs.length) refuse('Two standards have the same concentration');
        const n = pts.length;
        const mx = pts.reduce((s, p) => s.plus(p.x), ZERO).div(n);
        const my = pts.reduce((s, p) => s.plus(p.y), ZERO).div(n);
        const sxx = pts.reduce((s, p) => s.plus(p.x.minus(mx).pow(2)), ZERO);
        const syy = pts.reduce((s, p) => s.plus(p.y.minus(my).pow(2)), ZERO);
        const sxy = pts.reduce((s, p) => s.plus(p.x.minus(mx).times(p.y.minus(my))), ZERO);
        if (syy.isZero()) refuse('The standards all gave the same response: no standard curve');
        const b = sxy.div(sxx);
        const a = my.minus(b.times(mx));
        const r = sxy.div(sxx.times(syy).sqrt());
        const rText = fmt(r.abs(), 4);
        if (r.abs().toDecimalPlaces(3, Dec.ROUND_HALF_UP).lt('0.980')) refuse(`The test is not valid: the standard curve's |r| is ${rText}, less than 0.980. Repeat the test`);
        const lambda = Dec.min(...concs);
        const top = Dec.max(...concs);
        const readBack = (q: Q, what: string): Dec => Dec.pow(10, Dec.log10(resp(q, what)).minus(a).div(b));
        if (!i.sample || !i.spiked || i.sample.length < 2 || i.spiked.length < 2) refuse('Solutions A (sample) and B (spiked sample) are tested at least in duplicate');
        const A = i.sample.map((q, k) => readBack(q, `Solution A, replicate ${k + 1}`));
        const B = i.spiked.map((q, k) => readBack(q, `Solution B, replicate ${k + 1}`));
        const mean = (xs: Dec[]) => xs.reduce((s, x) => s.plus(x), ZERO).div(xs.length);
        const mA = mean(A);
        const mB = mean(B);
        if (i.spike === undefined) refuse('Give the endotoxin added to B (the spike)');
        const sp = parse(i.spike, 'The endotoxin added to B');
        needKind(sp, ['endotoxin per volume'], 'The endotoxin added to B (EU/mL)');
        positive(sp, 'The endotoxin added to B');
        const recovery = mB.minus(mA).div(to(sp, 'EU/mL')).times(HUNDRED);
        const recText = fmt(recovery, 0);
        if (recovery.toDecimalPlaces(0, Dec.ROUND_HALF_UP).lt(50) || recovery.toDecimalPlaces(0, Dec.ROUND_HALF_UP).gt(200)) {
          refuse(`The test is not valid: the spike was recovered at ${recText} % ((${num(mB, '')} − ${num(mA, '')}) ÷ ${sp.text} × 100), outside 50-200 %: the sample interferes. Repeat at a greater dilution, not beyond the MVD`);
        }
        if (!yes(i.negativeControl)) refuse('The test is not valid: the negative control (water BET) is not below the lowest standard. Repeat the test');
        if (mA.gt(top)) refuse(`Solution A reads ${num(mA, '')} EU/mL, above the highest standard ${num(top, '')} EU/mL: test at a greater dilution (not beyond the MVD)`);
        const m = mvdOf(lambda);
        const below = mA.lt(lambda);
        const perMl = (below ? lambda : mA).times(D);
        const unit = i.limit?.unit ?? 'EU/mL';
        const lt = i.limit ? limitPerMl(i.limit, i.concentration) : undefined;
        const value = inLimitTerms(perMl, unit, lt?.c);
        const q: Qualifier | undefined = below ? '<' : undefined;
        const per = lt?.c ? ` ÷ ${lt.c.text}` : '';
        const check = i.limit ? boundCheck(value, unit, q, strictLimit(i.limit), 'test at a smaller dilution') : {};
        const shown = `standard curve |r| ${rText} (λ = lowest standard ${num(lambda, '')} EU/mL); spike recovery ${recText} %; ${m.line ? `${m.line}; ` : ''}`
          + `A = ${below ? `below λ: less than ${num(lambda, '')}` : num(mA, '')} EU/mL × ${D.toString()}${per} = ${q ? 'less than ' : ''}${fmt(value, dp)} ${unit}${check.check ? `: ${check.check.shown}` : ''}`;
        return { ok: true, value, unit, shown, r, recovery, lambda, ...(m.mvd ? { mvd: m.mvd } : {}), ...(q ? { qualifier: q } : {}), ...check };
      }
      case 'gel clot confirm': {
        const l = lambdaOf(i.lambda);
        if (!i.endpoints || i.endpoints.length < 2) refuse('Record the end-point of each replicate series (4 series)');
        const f = i.endpoints.map((e, k) => {
          if (e === 'no clot') refuse(`The test is not valid: series ${k + 1} did not clot even at 2λ. Repeat the test`);
          if (e === '0.25λ') refuse(`The test is not valid: series ${k + 1} clotted at 0.25λ, which must be negative in all series. Repeat the test`);
          const x = ENDPOINT_FACTOR[e];
          if (x === undefined) refuse(`Series ${k + 1}: the end-point is one of ${GEL_ENDPOINTS.join(', ')}`);
          return d(x).times(to(l, 'EU/mL'));
        });
        const g = geoMean(f);
        const lam = to(l, 'EU/mL');
        const pass = g.gte(lam.div(2)) && g.lte(lam.times(2));
        const shown = `end-points ${i.endpoints.join(', ')} of λ ${l.text}: geometric mean ${num(g, '')} EU/mL; ${pass ? 'within' : 'NOT within'} 0.5λ to 2λ (${num(lam.div(2), '')} to ${num(lam.times(2), '')} EU/mL): the labelled sensitivity is ${pass ? 'confirmed' : 'NOT confirmed'}`;
        return { ok: true, value: g, unit: 'EU/mL', shown, lambda: lam, geometricMean: g, check: { pass, level: pass ? 'pass' : 'fail', rounded: `${num(g, '')} EU/mL`, shown } };
      }
      case 'gel clot limit': {
        const l = lambdaOf(i.lambda);
        const lam = to(l, 'EU/mL');
        const A = signs(i.a, 2, 'Solution A');
        const B = signs(i.b, 2, 'Solution B (positive product control)');
        const C = signs(i.c, 2, 'Solution C (positive control)');
        const Dc = signs(i.dControl, 2, 'Solution D (negative control)');
        if (!B.every(Boolean) || !C.every(Boolean) || Dc.some(Boolean)) refuse('The test is not valid: both replicates of B and C must clot and both of D must not. Repeat the test');
        if (i.limit === undefined) refuse('The limit test needs the endotoxin limit');
        const m = mvdOf(lam);
        const pos = A.filter(Boolean).length;
        if (pos === 1 && !yes(i.repeat)) refuse('One replicate of A clotted and the other did not: repeat the test, and record it as the repeat');
        const pass = pos === 0;
        const unit = i.limit.unit;
        const lt = limitPerMl(i.limit, i.concentration);
        // The sample at 1 in D clotting at λ holds λ × D EU/mL or more: in the limit's terms.
        const value = inLimitTerms(lam.times(D), unit, lt.c);
        const words = pass ? `both replicates of A negative${yes(i.repeat) ? ' (repeat)' : ''}: less than ${fmt(value, dp)} ${unit}, complies` : `${pos === 2 ? 'both replicates' : 'a replicate (in the repeat)'} of A positive: at least ${fmt(value, dp)} ${unit}, DOES NOT COMPLY`;
        const shown = `${m.line}; controls valid; ${words}`;
        return { ok: true, value, unit, shown, qualifier: pass ? '<' : '≥', mvd: m.mvd!, lambda: lam, decision: pass ? 'complies' : 'does not comply',
          check: { pass, level: pass ? 'pass' : 'fail', rounded: `${pass ? '<' : '≥'} ${fmt(value, dp)} ${unit}`, shown } };
      }
      case 'gel clot quantitative': {
        const l = lambdaOf(i.lambda);
        const lam = to(l, 'EU/mL');
        const B = signs(i.b, 2, 'Solution B (positive product control)');
        const Dc = signs(i.dControl, 2, 'Solution D (negative control)');
        if (!B.every(Boolean) || Dc.some(Boolean)) refuse('The test is not valid: both replicates of B must clot and both of D must not. Repeat the test');
        if (!i.cEndpoints || i.cEndpoints.length < 2) refuse('Solution C: record the end-point of each replicate');
        const cEnds = i.cEndpoints.map((e, k) => {
          const x = ENDPOINT_FACTOR[e];
          if (x === undefined) refuse(`The test is not valid: solution C, replicate ${k + 1} has no end-point within 2λ to 0.25λ. Repeat the test`);
          return d(x).times(lam);
        });
        const g = geoMean(cEnds);
        if (g.lt(lam.div(2)) || g.gt(lam.times(2))) refuse(`The test is not valid: the geometric mean end-point of C is ${num(g, '')} EU/mL, outside 0.5λ to 2λ. Repeat the test`);
        if (!i.aEndpoints || i.aEndpoints.length < 2) refuse('Solution A: record each replicate (2)');
        const m = mvdOf(lam);
        const unit = i.limit?.unit ?? 'EU/mL';
        const lt = i.limit ? limitPerMl(i.limit, i.concentration) : undefined;
        const reps = i.aEndpoints.map((e, k) => {
          if (!(QUANT_DILUTIONS as readonly string[]).includes(e)) refuse(`Solution A, replicate ${k + 1}: the greatest dilution that clots is one of ${QUANT_DILUTIONS.join(', ')}`);
          const f = e === 'none positive' ? ONE : d(e);
          const q: Qualifier | undefined = e === 'none positive' ? '<' : e === '8' ? '≥' : undefined;
          return { v: inLimitTerms(f.times(lam).times(D), unit, lt?.c), q, f, e };
        });
        // Every replicate is checked; the result reported is the highest.
        const worst = reps.reduce((x, y) => (y.v.gt(x.v) || (y.v.eq(x.v) && y.q !== '<') ? y : x));
        const checks = i.limit ? reps.map((r) => boundCheck(r.v, unit, r.q, strictLimit(i.limit!), 'test with a longer dilution series').check!) : [];
        const pass = checks.every((c) => c.pass);
        const per = lt?.c ? ` ÷ ${lt.c.text}` : '';
        const repLine = reps.map((r, k) => `replicate ${k + 1}: ${r.e === 'none positive' ? 'none positive, less than' : `end-point 1 in ${r.e},${r.q ? ' at least' : ''}`} ${r.f.toString()} × ${num(lam, '')} × ${D.toString()}${per} = ${fmt(r.v, dp)} ${unit}`).join('; ');
        const shown = `${m.line ? `${m.line}; ` : ''}C geometric mean ${num(g, '')} EU/mL (0.5λ to 2λ); ${repLine}${i.limit ? `; limit less than ${i.limit.high} ${unit}: ${pass ? 'complies' : 'DOES NOT COMPLY'}` : ''}`;
        const check: Check | undefined = i.limit ? { pass, level: pass ? 'pass' : 'fail', rounded: `${worst.q ? `${worst.q} ` : ''}${fmt(worst.v, dp)} ${unit}`, shown } : undefined;
        return { ok: true, value: worst.v, unit, shown, lambda: lam, geometricMean: g, ...(m.mvd ? { mvd: m.mvd } : {}), ...(worst.q ? { qualifier: worst.q } : {}), ...(check ? { check } : {}) };
      }
      default:
        return refuse('Unknown L12 mode');
    }
  });
}

// ================================================================ L13 Antibiotic potency, microbial assay
/**
 * L13 Antibiotic potency by microbial assay (Ph.Int 3.1 names the parallel-line method; the statistics follow the
 * standard practice of Ph. Eur. 5.3, paraphrased): 2 or 3 doses of the standard and of the test (the test's doses at
 * its assumed potency), in geometric progression with the same ratio, n replicates each (plates or tubes); responses
 * are zone diameters (mm) or turbidity (absorbance). Analysis of variance on the log doses:
 * - regression (the common slope) must be significant, and the deviations from parallelism (and, with 3 doses, from
 *   linearity) not significant, each by the F test at p = 0.05; otherwise the assay is not valid (refused);
 * - completely randomised, or randomised blocks (each replicate one plate holding every dose: plates as blocks);
 * - potency = assumed potency × antilog((mean T − mean S) ÷ b − (mean log dose T − mean log dose S));
 * - fiducial limits at 95 % by Fieller's theorem (C = 1 ÷ (1 − g), g = t² s² ÷ (b² Σ(x − x̄)²)).
 * The limit may be checked on the estimate or on a fiducial limit (Ph.Int: e.g. the upper fiducial limit NLT 95 %).
 */
export type L13Input = {
  readonly design: 'completely randomised' | 'randomised blocks';
  readonly standard: { readonly doses: readonly Q[]; readonly responses: readonly (readonly Q[])[] };
  readonly test: { readonly doses: readonly Q[]; readonly responses: readonly (readonly Q[])[] };
  /** The potency assumed for the test in making its doses (e.g. "1000 IU/mg"). */
  readonly assumedPotency: Q;
  readonly limit?: Limit;
  readonly checkOn?: 'estimate' | 'lower fiducial limit' | 'upper fiducial limit';
  /** The precision required: the fiducial limits as % of the estimate (e.g. 95 to 105 %). */
  readonly precision?: Limit;
  readonly decimals?: number;
};
export interface L13Extra {
  readonly lower: Dec;
  readonly upper: Dec;
  readonly lowerPercent: Dec;
  readonly upperPercent: Dec;
  readonly slope: Dec;
  readonly precisionCheck?: Check;
  readonly anova: readonly { readonly source: string; readonly df: number; readonly ss: Dec; readonly f?: Dec; readonly critical?: Dec }[];
}

export function l13MicrobialAssay(i: L13Input): Outcome<L13Extra> {
  return run(() => {
    const prep = (p: L13Input['standard'], what: string) => {
      if (!p?.doses || !p.responses) refuse(`${what}: give its doses and responses`);
      const k = p.doses.length;
      if (k < 2 || k > 3) refuse(`${what}: 2 or 3 doses`);
      if (p.responses.length !== k) refuse(`${what}: record the responses of each of its ${k} doses`);
      const doses = p.doses.map((q, j) => { const x = parse(q, `${what}, dose ${j + 1}`); positive(x, `${what}, dose ${j + 1}`); return x; });
      sameKind(doses, `${what}: the doses`);
      const ys = p.responses.map((rs, j) => (rs ?? []).map((r, n) => parse(r, `${what}, dose ${j + 1}, replicate ${n + 1}`)));
      return { doses, ys };
    };
    const S = prep(i.standard, 'Standard');
    const T = prep(i.test, 'Test');
    if (S.doses.length !== T.doses.length) refuse('The standard and the test have the same number of doses');
    const k = S.doses.length;
    sameKind([S.doses[0]!, T.doses[0]!], 'The doses of the standard and the test');
    const du = S.doses[0]!.unit;
    const allY = [...S.ys.flat(), ...T.ys.flat()];
    sameKind(allY, 'The responses');
    const yu = allY[0]!.unit;
    if (!['length', 'absorbance', 'number'].includes(yu.kind)) refuse('The responses are zone diameters (mm) or turbidity (absorbance)');
    const n = S.ys[0]!.length;
    if (n < 2) refuse('Each dose needs at least 2 replicates');
    for (const ys of [...S.ys, ...T.ys]) if (ys.length !== n) refuse('Every dose of the standard and the test has the same number of replicates (a balanced design)');
    const xS = S.doses.map((x) => Dec.ln(to(x, du)));
    const xT = T.doses.map((x) => Dec.ln(to(x, du)));
    const step = (xs: Dec[]) => {
      for (let j = 1; j < xs.length; j += 1) if (!xs[j]!.gt(xs[j - 1]!)) refuse('The doses are written from the lowest to the highest');
      return xs[1]!.minus(xs[0]!);
    };
    const rS = step(xS);
    const rT = step(xT);
    for (const [xs, r] of [[xS, rS], [xT, rT]] as const) for (let j = 2; j < xs.length; j += 1) if (xs[j]!.minus(xs[j - 1]!).minus(r).abs().gt('1e-9')) refuse('The doses are in geometric progression with one ratio');
    if (rT.minus(rS).abs().gt('1e-9')) refuse('The standard and the test use the same dose ratio');
    const y = (p: typeof S) => p.ys.map((rs) => rs.map((r) => to(r, yu)));
    const yS = y(S);
    const yT = y(T);
    const all = [...yS.flat(), ...yT.flat()];
    const N = all.length;
    const grand = all.reduce((s, v) => s.plus(v), ZERO).div(N);
    const meanOf = (xs: Dec[]) => xs.reduce((s, v) => s.plus(v), ZERO).div(xs.length);
    const total = all.reduce((s, v) => s.plus(v.minus(grand).pow(2)), ZERO);
    const cell = [...yS, ...yT].map(meanOf);
    const treatments = cell.reduce((s, m) => s.plus(m.minus(grand).pow(2)), ZERO).times(n);
    const mS = meanOf(yS.flat());
    const mT = meanOf(yT.flat());
    const preparations = mS.minus(grand).pow(2).plus(mT.minus(grand).pow(2)).times(k * n);
    // Slopes on the log doses centred within each preparation.
    const centred = (xs: Dec[]) => { const m = meanOf(xs); return xs.map((x) => x.minus(m)); };
    const cS = centred(xS);
    const cT = centred(xT);
    const sxy = (c: Dec[], ys: Dec[][]) => c.reduce((s, x, j) => s.plus(x.times(meanOf(ys[j]!))), ZERO).times(n);
    const sxx = (c: Dec[]) => c.reduce((s, x) => s.plus(x.pow(2)), ZERO).times(n);
    const SxyS = sxy(cS, yS);
    const SxyT = sxy(cT, yT);
    const Sxx = sxx(cS).plus(sxx(cT));
    const b = SxyS.plus(SxyT).div(Sxx);
    const regression = SxyS.plus(SxyT).pow(2).div(Sxx);
    const parallelism = SxyS.pow(2).div(sxx(cS)).plus(SxyT.pow(2).div(sxx(cT))).minus(regression);
    const linearity = treatments.minus(preparations).minus(regression).minus(parallelism);
    let blocks = ZERO;
    let blockDf = 0;
    if (i.design === 'randomised blocks') {
      const means = Array.from({ length: n }, (_, r) => meanOf([...yS, ...yT].map((ys) => ys[r]!)));
      blocks = means.reduce((s, m) => s.plus(m.minus(grand).pow(2)), ZERO).times(2 * k);
      blockDf = n - 1;
    } else if (i.design !== 'completely randomised') refuse('The design is completely randomised or randomised blocks');
    const errDf = N - 1 - (2 * k - 1) - blockDf;
    if (errDf < 1) refuse('Too few replicates to estimate the error');
    const error = total.minus(treatments).minus(blocks);
    const s2 = error.div(errDf);
    if (!s2.isPositive() || s2.isZero()) refuse('The replicates show no scatter at all: check the readings');
    const F = (ss: Dec, df: number) => ss.div(df).div(s2);
    const crit = (df: number) => fQuantile(d('0.95'), d(df), d(errDf));
    const anova: { source: string; df: number; ss: Dec; f?: Dec; critical?: Dec }[] = [
      { source: 'preparations', df: 1, ss: preparations },
      { source: 'regression', df: 1, ss: regression, f: F(regression, 1), critical: crit(1) },
      { source: 'parallelism', df: 1, ss: parallelism, f: F(parallelism, 1), critical: crit(1) },
      ...(k === 3 ? [{ source: 'linearity', df: 2, ss: linearity, f: F(linearity, 2), critical: crit(2) }] : []),
      ...(blockDf ? [{ source: 'blocks (plates)', df: blockDf, ss: blocks }] : []),
      { source: 'residual error', df: errDf, ss: error },
    ];
    const reg = anova[1]!;
    const par = anova[2]!;
    const fT = (x: { f?: Dec; critical?: Dec }) => `F ${fmt(x.f!, 2)}, critical ${fmt(x.critical!, 2)}`;
    if (!reg.f!.gt(reg.critical!)) refuse(`The assay is not valid: the regression is not significant (${fT(reg)}, p = 0.05). Repeat the assay`);
    if (par.f!.gt(par.critical!)) refuse(`The assay is not valid: the lines deviate significantly from parallel (${fT(par)}, p = 0.05). Repeat the assay`);
    const lin = anova.find((a) => a.source === 'linearity');
    if (lin && lin.f!.gt(lin.critical!)) refuse(`The assay is not valid: the responses deviate significantly from a straight line (${fT(lin)}, p = 0.05). Repeat the assay`);
    const ap = parse(i.assumedPotency, 'The assumed potency of the test');
    positive(ap, 'The assumed potency of the test');
    const off = meanOf(xS).minus(meanOf(xT));
    const M = mT.minus(mS).div(b);
    const t = tQuantile(d('0.975'), d(errDf));
    const g = t.pow(2).times(s2).div(b.pow(2).times(Sxx));
    if (!g.lt(1)) refuse(`The assay is too imprecise for fiducial limits (g = ${fmt(g, 3)}, at least 1): repeat the assay`);
    const V = d(1).div(k * n).times(2);
    const half = t.times(s2.sqrt()).div(b.abs()).times(ONE.minus(g).times(V).plus(M.pow(2).div(Sxx)).sqrt());
    const mL = M.minus(half).div(ONE.minus(g));
    const mU = M.plus(half).div(ONE.minus(g));
    const R = Dec.exp(M.plus(off));
    const value = ap.v.times(R);
    const lower = ap.v.times(Dec.exp(mL.plus(off)));
    const upper = ap.v.times(Dec.exp(mU.plus(off)));
    const lowerPercent = lower.div(value).times(HUNDRED);
    const upperPercent = upper.div(value).times(HUNDRED);
    const u = ap.unit.symbol;
    const dp = i.decimals ?? 1;
    const on = i.checkOn ?? 'estimate';
    const checked = on === 'estimate' ? value : on === 'lower fiducial limit' ? lower : upper;
    const c = checkOf(checked, u, i.limit);
    let precisionCheck: Check | undefined;
    if (i.precision !== undefined) {
      const lo = checkLimit(lowerPercent, '%', i.precision);
      const hi = checkLimit(upperPercent, '%', i.precision);
      const pass = lo.pass && hi.pass;
      precisionCheck = { pass, level: pass ? 'pass' : 'fail', rounded: `${lo.rounded} to ${hi.rounded}`, shown: `fiducial limits ${fmt(lowerPercent, 1)} to ${fmt(upperPercent, 1)} % of the estimate: ${pass ? 'precise enough' : 'NOT precise enough: repeat and combine assays'}` };
    }
    const shown = `${k} + ${k} doses, ${n} replicates (${i.design}); regression ${fT(reg)}; parallelism ${fT(par)}${lin ? `; linearity ${fT(lin)}` : ''}; `
      + `potency = ${ap.text} × ${fmt(R, 4)} = ${fmt(value, dp)} ${u} (95 % fiducial limits ${fmt(lower, dp)} to ${fmt(upper, dp)} ${u}, ${fmt(lowerPercent, 1)} to ${fmt(upperPercent, 1)} %)`
      + `${c.check ? `; ${on === 'estimate' ? '' : `${on} `}${c.check.shown}` : ''}${precisionCheck ? `; ${precisionCheck.shown}` : ''}`;
    const done: Done & L13Extra = { ok: true, value, unit: u, shown, lower, upper, lowerPercent, upperPercent, slope: b, anova, ...(precisionCheck ? { precisionCheck } : {}), ...c };
    return done;
  });
}
