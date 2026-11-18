/**
 * Which peaks of a CDS result file fill which fields of a step (LIMS-33, LIMS-50). The injections are named by the
 * fixed naming of docs/design.md: the sample by the analysis' sample number (or the analysis number), a preparation
 * by "-1", "-2", "-3" after it; the standard "STD…" or "Standard…" (or the inventory number of the standard picked on
 * the step); the reference solution "REF…" or "Reference…". Other injections (blanks, other samples of the sequence)
 * are left out. The peak read is the one the method names (setting `cdsPeak`), else the largest of the injection.
 * Every count must fit the step, else the file is refused with the reason. Pure.
 */
import { Dec } from '../templates/index.js';
import type { Block } from '../blocks/format.js';
import type { SettingValue } from '../master/schema.js';
import type { CdsFile, CdsRow } from './cds.js';

export interface FillInput {
  block: Block;
  settings: Record<string, SettingValue | undefined>;
  // The names a sample injection may carry: the sample number, and the analysis number.
  names: string[];
  // The inventory number of the standard picked on the step (assay), also a standard's name.
  standard?: string | null;
  file: CdsFile;
}
export interface Fill { values: Record<string, string | string[]>; injections: number[]; problems: string[] }

interface Injection { no: number; name: string; peaks: CdsRow[] }
type Role = { kind: 'sample'; prep: number } | { kind: 'standard' } | { kind: 'reference' } | null;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function roleOf(name: string, names: readonly string[], standard?: string | null): Role {
  const t = name.trim();
  for (const n of names) {
    const m = new RegExp(`^${esc(n)}(?:[\\s_\\-/.]+(?:prep(?:aration)?[\\s_\\-]*|p)?([1-9]))?$`, 'i').exec(t);
    if (m) return { kind: 'sample', prep: m[1] ? Number(m[1]) : 1 };
  }
  if (/^(std|standard)(\b|[\s_\-\d])/i.test(t) || (standard && t.toUpperCase().includes(standard.toUpperCase()))) return { kind: 'standard' };
  if (/^(ref|reference)(\b|[\s_\-\d])/i.test(t)) return { kind: 'reference' };
  return null;
}
const text = (v: SettingValue | undefined) => (typeof v === 'string' ? v : undefined);
const largest = (a: CdsRow, b: CdsRow) => (new Dec(b.area).gt(a.area) ? b : a);
const list = (xs: readonly number[]) => xs.join(', ');

/** The values a CDS result file gives a step, the injections they came from, or why it cannot be used. */
export function cdsFill({ block, settings, names, standard, file }: FillInput): Fill {
  const problems: string[] = [];
  const values: Record<string, string | string[]> = {};
  const used = new Set<number>();
  // The injections in run order, each with its peaks.
  const byNo = new Map<number, Injection>();
  for (const r of file.rows) {
    const i = byNo.get(r.injection);
    if (!i) byNo.set(r.injection, { no: r.injection, name: r.sample, peaks: [r] });
    else if (i.name !== r.sample) problems.push(`Injection ${r.injection} has two sample names (${i.name}, ${r.sample}).`);
    else i.peaks.push(r);
  }
  if (problems.length) return { values, injections: [], problems };
  const injections = [...byNo.values()].sort((a, b) => a.no - b.no);
  const role = (i: Injection) => roleOf(i.name, names, standard);
  const samples = injections.filter((i) => role(i)?.kind === 'sample');
  const standards = injections.filter((i) => role(i)?.kind === 'standard');
  const references = injections.filter((i) => role(i)?.kind === 'reference');
  const peakName = text(settings.cdsPeak)?.trim();
  // The peak read in an injection: the method's named peak, else the largest.
  const main = (i: Injection): CdsRow | undefined => {
    if (!peakName) return i.peaks.reduce(largest);
    const p = i.peaks.find((x) => x.peak.trim().toLowerCase() === peakName.toLowerCase());
    if (!p) problems.push(`Injection ${i.no} (${i.name}) has no peak named ${peakName}.`);
    return p;
  };
  const field = (name: string) => block.fields.find((f) => f.name === name);
  // Areas of the main peak of these injections into a list field, if their number fits it.
  const put = (name: string, from: Injection[]) => {
    const f = field(name);
    if (!f || !from.length) return;
    const min = f.minCount ?? f.count ?? 1, max = f.count ?? 1;
    if (from.length < min || from.length > max) {
      problems.push(`${f.label}: the file has ${from.length} injection${from.length === 1 ? '' : 's'} (${list(from.map((i) => i.no))}); this step takes ${min === max ? min : `${min} to ${max}`}.`);
      return;
    }
    const areas = from.map(main);
    if (areas.some((a) => !a)) return;
    values[name] = f.count ? areas.map((a) => a!.area) : areas[0]!.area;
    for (const i of from) used.add(i.no);
  };
  const others = () => [...new Set(injections.map((i) => i.name))].join(', ');
  const needSamples = () => {
    if (!samples.length) problems.push(`The file has no injection of ${names.join(' or ')} (it has ${others()}): import the run of this sample.`);
    return samples.length > 0;
  };
  const needStandards = () => {
    if (!standards.length) problems.push(`The file has no standard injection (named STD or Standard${standard ? `, or ${standard}` : ''}).`);
    return standards.length > 0;
  };

  if (block.id === 'assay') {
    if (text(settings.response) === 'absorbance') return { values, injections: [], problems: ['This assay reads absorbances, not a chromatography run: there is no CDS result file to import.'] };
    const n = Number(text(settings.preparations) ?? '1');
    if (needSamples() && needStandards()) {
      const preps = [...new Set(samples.map((i) => (role(i) as { prep: number }).prep))].sort();
      const extra = preps.filter((k) => k > n);
      const missing = Array.from({ length: n }, (_, k) => k + 1).filter((k) => !preps.includes(k));
      if (extra.length) problems.push(`The method sets ${n} sample preparation${n === 1 ? '' : 's'}; the file also has preparation ${list(extra)}.`);
      if (missing.length) problems.push(`The method sets ${n} sample preparation${n === 1 ? '' : 's'}; the file has no injection of preparation ${list(missing)}.`);
      for (let k = 1; k <= n; k++) put(`responses${k}`, samples.filter((i) => (role(i) as { prep: number }).prep === k));
      if (text(settings.mode) === 'bracketing') {
        const first = samples[0]!.no, last = samples.at(-1)!.no;
        const between = standards.filter((i) => i.no > first && i.no < last);
        if (between.length) problems.push(`Bracketing: standard injection ${list(between.map((i) => i.no))} is between the sample injections; the standards come before and after them.`);
        const before = standards.filter((i) => i.no < first), after = standards.filter((i) => i.no > last);
        if (!after.length) problems.push('Bracketing: the file has no standard injection after the samples.');
        put('stdResponses', before);
        put('stdResponsesAfter', after);
        if (!before.length) problems.push('Bracketing: the file has no standard injection before the samples.');
      } else put('stdResponses', standards);
    }
  } else if (block.id === 'system-suitability') {
    if (needStandards()) {
      put('responses', standards);
      // Each check of the method's suitability on its worst injection: the highest tailing, the fewest plates, the
      // lowest resolution and signal-to-noise.
      const peaks = standards.map(main).filter((p): p is CdsRow => !!p);
      const worst = (k: 'tailing' | 'plates' | 'resolution' | 'sn', high: boolean) => {
        const xs = peaks.map((p) => p[k]).filter((x): x is string => x !== undefined);
        return xs.length ? xs.reduce((a, b) => (new Dec(b)[high ? 'gt' : 'lt'](a) ? b : a)) : undefined;
      };
      for (const [name, k, high] of [['tailing', 'tailing', true], ['plates', 'plates', false], ['resolution', 'resolution', false], ['signalToNoise', 'sn', false]] as const) {
        const w = worst(k, high);
        if (w !== undefined && field(name)) values[name] = w;
      }
    }
  } else if (block.id === 'impurities') {
    if (needSamples()) {
      if (samples.length > 1) problems.push(`Related substances take one injection of the test solution; the file has ${samples.length} (${list(samples.map((i) => i.no))}).`);
      else {
        const inj = samples[0]!;
        const principal = main(inj);
        if (principal) {
          // Every other peak in run order: its relative retention time (the CDS's, else worked out from the retention
          // times, to 2 decimals) and its area.
          const rest = inj.peaks.filter((p) => p !== principal).sort((a, b) => new Dec(a.rt).cmp(b.rt));
          if (!rest.length) problems.push(`The test solution (injection ${inj.no}) has no peak other than the principal peak: this step needs at least one; record the result with a deviation note.`);
          else if (rest.length > (field('areas')?.count ?? 30)) problems.push(`The test solution has ${rest.length} peaks other than the principal peak; this step takes at most ${field('areas')?.count ?? 30}.`);
          else {
            values.rrts = rest.map((p) => p.rrt ?? rrt(p.rt, principal.rt));
            values.areas = rest.map((p) => p.area);
            values.principalArea = principal.area;
            used.add(inj.no);
          }
        }
      }
      if (text(settings.mode) === 'external standard') {
        if (!references.length) problems.push('The file has no injection of the reference solution (named REF or Reference).');
        put('referenceResponses', references);
      }
    }
  } else problems.push('This step takes no CDS result file.');
  return { values, injections: [...used].sort((a, b) => a - b), problems };
}

/** A relative retention time from the retention times: the peak's over the principal peak's, to 2 decimals (half up). */
export const rrt = (rt: string, principal: string) => new Dec(rt).div(principal).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2);
