// The validation, verification or transfer report as the document QA files (LIMS-02, LIMS-04): pdfmake, as the CoA and
// the CTD tables. Made again each time from the stored report (its inputs and outputs as signed) and its signatures;
// nothing is worked out again.
import type { Content } from 'pdfmake/interfaces.js';
import { findBlock } from '../shared/blocks/index.js';
import type { Conclusion, ValidationStep } from '../shared/engine/method-validation.js';
import { pageFrame, plant, runs } from './pdf.js';

export interface ReportForPdf {
  reportNo: string; kind: string; outside: boolean; code: string; name: string; origin: string; methodVersionNo: number; testType: string; reference: string;
  sendingLab: string | null; receivingLab: string | null; remarks: string; conclusion: string; inputs: { steps?: ValidationStep[] }; outputs: Conclusion & { findings?: unknown[] };
}
export interface SignatureRow { meaning: string; printedName: string; signedAt: Date | string }

type Lim = { low?: string; high?: string; unit?: string; lowStrict?: boolean; highStrict?: boolean };
const words = (l: Lim) => {
  const u = l.unit ? ` ${l.unit}` : '';
  if (l.low !== undefined && l.high !== undefined) return `${l.low} to ${l.high}${u}`;
  return l.low !== undefined ? `${l.lowStrict ? 'more than' : 'NLT'} ${l.low}${u}` : `${l.highStrict ? 'less than' : 'NMT'} ${l.high ?? ''}${u}`;
};
/** The step's acceptance criteria as the protocol set them: its limit settings (and a transfer's margin). */
export function criteria(s: ValidationStep): string {
  const b = findBlock({ id: s.block, version: 1 });
  const out = (b?.settings ?? []).flatMap((x) => {
    const v = s.settings[x.name];
    if (x.kind === 'limit' && v && typeof v === 'object' && 'unit' in (v as object)) return [`${x.label.replace(/: limit.*$/, '')}: ${words(v as Lim)}`];
    if (x.name === 'margin' && typeof v === 'string') return [`acceptance margin ± ${v}`];
    return [];
  });
  return out.join('; ');
}

const small = (text: string, extra: Record<string, unknown> = {}): Content => ({ text: runs(text), fontSize: 8, ...extra }) as Content;
const th = (text: string): Content => ({ text: runs(text), fontSize: 8, bold: true, fillColor: '#eef1f4' });
const MEANING: Record<string, string> = { prepared: 'Prepared', reviewed: 'Reviewed (QC)', approved: 'Approved (QA)' };

export function methodReportDoc(r: ReportForPdf, signatures: readonly SignatureRow[], by: string, printedAt = new Date(), demo = false) {
  const steps = r.inputs.steps ?? [];
  const content: Content[] = [
    { text: runs(`${r.reportNo} · Method ${r.kind} report`), fontSize: 15, bold: true },
    { text: runs(`${r.code} · ${r.name} · version ${r.methodVersionNo} · ${r.origin} method`), fontSize: 11, margin: [0, 2, 0, 6] },
    small(r.outside ? `Validated outside LIMS: paper report ${r.reference}` : `Protocol ${r.reference} · type of test ${r.testType}`, { bold: true }),
    ...(r.sendingLab ? [small(`Transfer from ${r.sendingLab} (sending laboratory) to ${r.receivingLab ?? ''} (receiving laboratory)`)] : []),
    ...(r.remarks ? [small(`Remarks: ${r.remarks}`)] : []),
  ];
  if (!r.outside) {
    const rows = r.outputs.characteristics.flatMap((c) => c.findings.map((f, i) => {
      const s = steps.find((x) => x.analysisNo === f.analysisNo && (x.step === f.step || `${x.step} (range)` === f.step));
      const criterion = f.step.endsWith('(range)') ? `range required for ${String(s?.settings.use ?? '')} (ICH Q2 Table 2)` : s ? criteria(s) : '';
      return [small(i === 0 ? c.characteristic : '', { bold: true }), small(criterion), small(`${f.analysisNo} · ${f.step}: ${f.shown}`), small(f.met ? 'met' : 'NOT MET', { bold: true, color: f.met ? undefined : '#b3261e' })];
    }));
    content.push({ table: { headerRows: 1, dontBreakRows: true, widths: [90, 170, '*', 45], body: [[th('Characteristic'), th('Acceptance criterion'), th('Result (analysis, step: worked figures)'), th('')], ...rows] },
      layout: 'lightHorizontalLines', margin: [0, 8, 0, 0] } as Content);
    if (r.outputs.missing.length) content.push(small(`Missing (required): ${r.outputs.missing.join(', ')}`, { color: '#b3261e', margin: [0, 4, 0, 0] }));
  }
  content.push({ text: runs(`Conclusion: ${r.conclusion === 'met' ? 'met' : 'NOT MET'}. ${r.outputs.why ?? ''}`), bold: true, fontSize: 10, margin: [0, 10, 0, 6] });
  content.push({ table: { headerRows: 1, widths: [110, 160, '*'], body: [[th('Signature'), th('Name'), th('Signed')],
    ...signatures.map((g) => [small(MEANING[g.meaning] ?? g.meaning), small(g.printedName), small(plant(g.signedAt))])] }, layout: 'lightHorizontalLines' } as Content);
  return pageFrame(`Medhanta QLIMS · ${r.reportNo} · ${r.kind} of ${r.code} version ${r.methodVersionNo}`, by, content, printedAt, demo);
}
