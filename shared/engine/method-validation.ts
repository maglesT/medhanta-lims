/**
 * Method validation, verification and transfer reports (plan 2.12; LIMS-02, LIMS-04): pure functions over a report's
 * facts. A report covers one method version and the reviewed analyses of validation worksheets (methods whose header
 * says `use: 'validation'`); each validation step of those analyses gives one characteristic with its result as the
 * template worked it out (met = no failed check). The conclusion is "met" only when every characteristic found is met
 * and none that the report's kind and test type require (ICH Q2(R2) Table 1) is missing. Signed by the person who
 * prepares it, reviewed by QC (another person) and approved by QA (a third person). A method validated on paper before
 * LIMS is recorded "outside LIMS" with the paper report's number; QA (another person) approves it.
 */
import { failed, type Stored } from './values.js';
import { l31Range, type L31Input } from '../templates/index.js';
import type { MasterDoc } from '../master/schema.js';

export const REPORT_KINDS = ['validation', 'verification', 'transfer'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type Origin = NonNullable<MasterDoc['header']['origin']>;

export const CHARACTERISTICS = ['specificity', 'linearity', 'range', 'accuracy', 'repeatability', 'intermediate precision', 'detection limit',
  'quantitation limit', 'robustness', 'transfer comparison'] as const;
export type Characteristic = (typeof CHARACTERISTICS)[number];

// ICH Q2(R2) Table 1: what a validation shows, by the type of test. Robustness is shown in development (recommended,
// not required here). A verification of a pharmacopoeial method shows what its protocol chose (USP <1226>); a
// transfer shows the comparison (USP <1224>).
export const TEST_TYPES = ['assay', 'impurity (quantitative)', 'impurity (limit test)', 'identity', 'other (as the protocol says)'] as const;
export type TestType = (typeof TEST_TYPES)[number];
export const TABLE_1: Record<TestType, readonly Characteristic[]> = {
  assay: ['specificity', 'linearity', 'range', 'accuracy', 'repeatability', 'intermediate precision'],
  'impurity (quantitative)': ['specificity', 'linearity', 'range', 'accuracy', 'repeatability', 'intermediate precision', 'quantitation limit'],
  'impurity (limit test)': ['specificity', 'detection limit'],
  identity: ['specificity'],
  'other (as the protocol says)': [],
};
export function required(kind: ReportKind, testType: TestType): readonly Characteristic[] {
  return kind === 'transfer' ? ['transfer comparison'] : kind === 'verification' ? [] : TABLE_1[testType];
}

/** One validation step of a worksheet analysis, as the report reads it. */
export interface ValidationStep {
  analysisNo: string; step: string; block: string;
  settings: Record<string, unknown>;
  result: Stored | undefined;
}
export interface Finding { characteristic: Characteristic; analysisNo: string; step: string; shown: string; met: boolean }

const BLOCK_CHARACTERISTIC: Record<string, Characteristic> = {
  specificity: 'specificity', linearity: 'linearity', accuracy: 'accuracy', robustness: 'robustness', 'transfer-comparison': 'transfer comparison',
};
const metOf = (r: Stored | undefined) => r !== undefined && r.ok && !failed(r);
const shownOf = (r: Stored | undefined) => (r === undefined ? 'no result' : r.ok ? r.shown : `refused: ${r.message}`);

/** The characteristics shown by the validation steps of the analyses, and the range worked out from them (L31). */
export function findings(steps: readonly ValidationStep[]): Finding[] {
  const out: Finding[] = [];
  for (const s of steps) {
    const base = { analysisNo: s.analysisNo, step: s.step, shown: shownOf(s.result), met: metOf(s.result) };
    const r = s.result?.ok ? s.result : undefined;
    if (s.block in BLOCK_CHARACTERISTIC) out.push({ characteristic: BLOCK_CHARACTERISTIC[s.block]!, ...base });
    else if (s.block === 'precision') out.push({ characteristic: s.settings.mode === 'intermediate precision' ? 'intermediate precision' : 'repeatability', ...base });
    else if (s.block === 'lod-loq') out.push({ characteristic: 'detection limit', ...base }, { characteristic: 'quantitation limit', ...base });
    else if (s.block === 'signal-to-noise') out.push({ characteristic: r?.loq !== undefined || s.settings.level === 'quantitation limit' ? 'quantitation limit' : 'detection limit', ...base });
  }
  const range = rangeFinding(steps);
  return range ? [...out, range] : out;
}

/** The range (L31) from the last linearity, accuracy and precision steps, when all three were run. */
function rangeFinding(steps: readonly ValidationStep[]): Finding | null {
  const lin = steps.filter((s) => s.block === 'linearity').at(-1);
  const acc = steps.filter((s) => s.block === 'accuracy').at(-1);
  const pre = steps.filter((s) => s.block === 'precision');
  if (!lin || !acc || !pre.length) return null;
  const l = lin.result?.ok ? lin.result : undefined;
  const a = acc.result?.ok ? acc.result : undefined;
  const at = { analysisNo: lin.analysisNo, step: `${lin.step} (range)` };
  if (!l || !a || l.low === undefined || l.high === undefined) {
    return { characteristic: 'range', ...at, met: false, shown: 'the linearity or accuracy has no levels in % (give the 100 % level of the linearity)' };
  }
  const st = lin.settings;
  const q = (x: unknown) => (typeof x === 'string' ? x : undefined);
  const r = l31Range({
    use: st.use as L31Input['use'], q: q(st.q), reportingThreshold: q(st.reportingThreshold), specLimit: q(st.specLimit), low: q(st.rangeLow), high: q(st.rangeHigh),
    linearity: { low: String(l.low), high: String(l.high), met: metOf(lin.result) },
    accuracy: { low: String(a.low), high: String(a.high), met: metOf(acc.result) },
    precision: { met: pre.every((p) => metOf(p.result)) },
  });
  return { characteristic: 'range', ...at, met: r.ok && !failed(JSON.parse(JSON.stringify(r)) as Stored), shown: r.ok ? r.shown : `refused: ${r.message}` };
}

export interface Conclusion {
  characteristics: { characteristic: Characteristic; met: boolean; findings: Finding[] }[];
  missing: Characteristic[];
  met: boolean;
  why: string;
}
/** Per characteristic: met when every result for it is met; the report is met when all are and none required is missing. */
export function conclude(kind: ReportKind, testType: TestType, fs: readonly Finding[]): Conclusion {
  const characteristics = CHARACTERISTICS.filter((c) => fs.some((f) => f.characteristic === c))
    .map((c) => { const x = fs.filter((f) => f.characteristic === c); return { characteristic: c, met: x.every((f) => f.met), findings: x }; });
  const missing = required(kind, testType).filter((c) => !characteristics.some((x) => x.characteristic === c));
  const notMet = characteristics.filter((c) => !c.met).map((c) => c.characteristic);
  const met = characteristics.length > 0 && !missing.length && !notMet.length;
  const why = !characteristics.length ? 'No validation results in the analyses chosen.'
    : [...(notMet.length ? [`not met: ${notMet.join(', ')}`] : []), ...(missing.length ? [`missing (${kind === 'validation' ? `ICH Q2 for ${testType}` : kind}): ${missing.join(', ')}`] : [])].join('; ')
      || `All ${characteristics.length} characteristics met.`;
  return { characteristics, missing, met, why };
}

/** Which report a method needs before routine use, and the reports that count for it. */
export const NEEDS: Record<Origin, ReportKind> = { 'in-house': 'validation', pharmacopoeial: 'verification', transferred: 'transfer' };
const ACCEPTED: Record<ReportKind, readonly ReportKind[]> = { validation: ['validation'], verification: ['verification', 'validation'], transfer: ['transfer'] };
export const STATUS_WORD: Record<ReportKind, string> = { validation: 'validated', verification: 'verified', transfer: 'transferred' };

/** Why this kind of report cannot be written for a method of this origin; null when it can. */
export function kindRefusal(origin: Origin | undefined, use: MasterDoc['header']['use'], kind: ReportKind): string | null {
  if (use === 'validation') return 'This method is a validation worksheet: its analyses go into a report on the method they validate.';
  const o = origin ?? 'in-house';
  if (kind === 'verification' && o !== 'pharmacopoeial') return 'A verification is for a pharmacopoeial method; an in-house method is validated (LIMS-02).';
  if (kind === 'transfer' && o !== 'transferred') return 'A transfer report is for a method marked "transferred" from another laboratory (LIMS-04).';
  if (kind !== 'transfer' && o === 'transferred') return 'A method transferred from another laboratory needs a transfer report (LIMS-04).';
  return null;
}

export interface ReportFacts {
  id: number; kind: ReportKind; outside: boolean; methodVersionNo: number; conclusion: 'met' | 'not met'; preparedBy: number;
  events: readonly { kind: 'reviewed' | 'approved'; person: number }[];
}
export type ReportStatus = 'to review' | 'to approve' | 'approved';
export function reportStatus(r: ReportFacts): ReportStatus {
  if (r.events.some((e) => e.kind === 'approved')) return 'approved';
  return r.outside || r.events.some((e) => e.kind === 'reviewed') ? 'to approve' : 'to review';
}
/** Why this person may not review (QC) or approve (QA) the report now; null when they may. */
export function reportRefusal(action: 'review' | 'approve', r: ReportFacts, person: number): string | null {
  const status = reportStatus(r);
  if (action === 'review') {
    if (status !== 'to review') return r.outside ? 'A record of a validation outside LIMS is approved by QA; there is no QC review.' : `This report is ${status === 'approved' ? 'approved' : 'already reviewed'}.`;
    if (person === r.preparedBy) return 'The person who prepared the report cannot review it: another person reviews it.';
    return null;
  }
  if (status === 'approved') return 'This report is already approved.';
  if (status === 'to review') return 'QC reviews the report before QA approves it.';
  if (person === r.preparedBy) return r.outside ? 'The person who recorded the validation outside LIMS cannot approve it: QA approves it as a second person.' : 'The person who prepared the report cannot approve it.';
  if (r.events.some((e) => e.kind === 'reviewed' && e.person === person)) return 'QA approval is by a person who neither prepared nor reviewed the report.';
  return null;
}

/**
 * LIMS-02, LIMS-04: whether a method version may be used for routine work: an approved report whose conclusion is met,
 * of the kind its origin needs (a validation also counts for a pharmacopoeial method), for this version or an earlier
 * one of the same method (a later version's change control decides on revalidation; QA sees which version was
 * validated). A validation worksheet itself needs none.
 */
export function methodUse(header: MasterDoc['header'], versionNo: number, reports: readonly ReportFacts[]): { needs: ReportKind | null; status: string; report: ReportFacts | null } {
  if (header.use === 'validation') return { needs: null, status: 'validation worksheet', report: null };
  const needs = NEEDS[header.origin ?? 'in-house'];
  const report = reports.filter((r) => ACCEPTED[needs].includes(r.kind) && r.conclusion === 'met' && r.methodVersionNo <= versionNo && reportStatus(r) === 'approved')
    .sort((a, b) => b.methodVersionNo - a.methodVersionNo || b.id - a.id)[0] ?? null;
  return { needs, report, status: report ? `${STATUS_WORD[report.kind]}${report.outside ? ' (outside LIMS)' : ''}` : `not yet ${STATUS_WORD[needs]}` };
}
export function useRefusal(header: MasterDoc['header'], versionNo: number, reports: readonly ReportFacts[]): string | null {
  const u = methodUse(header, versionNo, reports);
  if (!u.needs || u.report) return null;
  return u.needs === 'transfer'
    ? 'This method is transferred from another laboratory: it is used here only once its transfer report (protocol, comparative results, conclusion) is approved by QA (LIMS-04).'
    : `This ${u.needs === 'verification' ? 'pharmacopoeial' : 'in-house'} method is not ${STATUS_WORD[u.needs]} yet: it becomes effective for routine use once its ${u.needs} report is approved by QA, or its validation outside LIMS is recorded and approved (LIMS-02).`;
}
