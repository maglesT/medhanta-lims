// LIMS-21: the certificate of analysis of an approved sample, the way the analysis record PDF is made: what was sampled
// (item, lot or batch, source), the specification, and each test with its limit, method and the reviewed result decided
// on at approval (kept with the signed decision), then the decision with its e-signature. Nothing is typed again.
import { plantTimesIn } from '../shared/plant-time.js';
import { reportName } from '../shared/engine/sample.js';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { limitFor, purposeLimits, type SpecDoc } from '../shared/master/spec.js';
import { Dec, roundHalfUp, writtenDecimals } from '../shared/templates/index.js';
import { isHand } from '../shared/engine/links.js';
import type { EventRow, SampleRow } from './routes/samples.js';
import { pageFrame, plant, runs } from './pdf.js';

interface Decided { key: string; name: string; value: string; unit: string; shown: string; reported?: string; pass?: boolean; limit: string; method: string; analysisNo: string; reviewedAt?: string | null;
  // LIMS-08: an identity tested on each of this many containers; LIMS-22: done by an outside lab, with its report.
  containers?: number; outsideLab?: string; report?: { file: string; sha256: string };
  // LIMS-09: taken from the supplier's certificate of a lot tested on it.
  certificate?: { manufacturer: string };
  // The units' results behind it (BU, CU) and what the figure is.
  individual?: string[]; figure?: 'AV' | 'mean' }
export interface CoaInput { sample: SampleRow; spec: SpecDoc; specVersion: number; decision: EventRow }

const small = (text: string, extra: Record<string, unknown> = {}): Content => ({ text: runs(text), fontSize: 8, ...extra }) as Content;
const th = (text: string): Content => ({ text, fontSize: 8, bold: true, fillColor: '#eef1f4' });
const RED = '#b3261e';

/**
 * A result's figure as decided: the worked line's end ("… = 99.6 %"), or a reading as written ("99.0 %; limit …"), else
 * value and unit (CoA, CTD tables).
 */
// The figure as reported: the value rounded as the limit is written (kept with the decision as `reported`), else the end
// of the worked line ("… rounded to 1 decimal (as the limit is written) = 0.3 %; limit not more than 0.5 %" → "0.3 %"),
// else the value as written.
export const resultFigure = (shown: string, value: string, unit: string, reported?: string) => reported
  ?? /=\s*([^=;]+?)\s*(?:;\s*limit\b[^=]*)?$/.exec(shown.replace(/:\s*(PASS|FAIL)$/i, '').trim())?.[1]?.trim()
  ?? /^\s*([-+]?\d[\d.]*(?:\s*[^\s;]+)?)\s*;/.exec(shown)?.[1]?.trim() ?? (`${value} ${unit}`.trim() || shown);

/** The result as reported (CoA, result_v1): rounded half up to the decimals the limit is written with (the finer bound). */
export function reportedFigure(value: string, unit: string, limit: { low?: string; high?: string } | undefined): string {
  const d = limit ? Math.max(limit.low !== undefined ? writtenDecimals(limit.low) : 0, limit.high !== undefined ? writtenDecimals(limit.high) : 0) : undefined;
  const v = d === undefined ? value : roundHalfUp(new Dec(value), d).toFixed(d);
  return `${v}${unit ? ` ${unit}` : ''}`;
}

/** The bare figure as the screens show it: as reported when the limit has decimals written; with no limit, to 3 decimals. */
export function shownFigure(value: string, limit: { low?: string; high?: string } | undefined | null): string {
  try {
    if (limit && (limit.low !== undefined || limit.high !== undefined)) return reportedFigure(value, '', limit);
    return /^-?\d+\.\d{4,}$/.test(value.trim()) ? roundHalfUp(new Dec(value), 3).toFixed(3).replace(/\.?0+$/, '') : value;
  } catch { return value; }
}

export function coaDoc(c: CoaInput, by: string, printedAt = new Date(), demo = false): TDocumentDefinitions {
  const s = c.sample;
  const h = c.spec.header;
  const p = c.decision.payload as { coaNo?: string; results?: Decided[] };
  const results = p.results ?? [];
  // A decision kept before `reported` existed: rounded now as the specification's limit is written (the same rule).
  const on = purposeLimits(s.purpose);
  const reported = (r: Decided) => {
    if (r.reported) return r.reported;
    const t = c.spec.tests.find((x) => x.key === r.key);
    try { return t && r.value ? reportedFigure(r.value, r.unit, limitFor(t, on)) : undefined; } catch { return undefined; }
  };
  const figure = (r: Decided) => resultFigure(r.shown, r.value, r.unit, reported(r));
  // In-process: a test report of the step's request, not a certificate (owner 19 Nov 2026).
  const title = reportName(s.purpose, s.item.of);
  const req = (s as { request?: { requestId: string; stageTitle: string | null; stepTitle: string | null } | null }).request;
  const content: Content[] = [
    { text: runs(`${title} ${p.coaNo ?? ''}`), fontSize: 16, bold: true },
    ...(req ? [small(`Request ${req.requestId}: ${[req.stageTitle, req.stepTitle].filter(Boolean).join(' › ')}`, { margin: [0, 2, 0, 0] })] : []),
    { text: runs(`${s.item.code} · ${s.item.name}`), fontSize: 11, margin: [0, 2, 0, 8] },
    { table: { widths: [95, '*', 95, '*'], body: [
      [th(s.item.of === 'material' ? 'Material' : s.item.of === 'room' ? 'Room' : s.item.of === 'water' ? 'Water system' : 'Product'), small(`${s.item.code} · ${s.item.name}`),
        th(s.item.of === 'material' ? 'Lot' : s.item.of === 'room' || s.item.of === 'water' ? 'Point' : 'Batch'), small(s.lotNo, { bold: true })],
      [th('Sample'), small(`${s.sampleNo} (${s.purpose}), ${s.quantity}`), th('Source'), small(isHand(s.source) ? 'typed by hand (link not available), checked by a second person' : plantTimesIn(s.source.shown))],
      [th('Specification'), small(`${h.number}, version ${c.specVersion}`), th('Pharmacopoeia'), small(`${h.pharmacopoeia}${h.edition ? ` ${h.edition}` : ''}${h.market ? ` · market ${h.market}` : ''}`)],
    ] }, layout: 'lightHorizontalLines' },
    { text: 'Results', bold: true, fontSize: 11, margin: [0, 12, 0, 4] },
    { table: { headerRows: 1, widths: [110, 70, '*', 90, 50], body: [
      [th('Test'), th('Method'), th('Limit'), th('Result'), th('')],
      ...results.map((r) => [small(r.name, { bold: true }), small(r.certificate ? `SUPPLIER'S CERTIFICATE: ${r.certificate.manufacturer}\ncertificate ${r.analysisNo}` : r.outsideLab ? `OUTSIDE LAB: ${r.outsideLab}\nreport ${r.analysisNo}` : `${r.method}\n${r.analysisNo}`),
        small(r.limit || '—'), small(`${figure(r)}${r.containers ? ` (each of ${r.containers} containers)` : ''}`, { bold: true }),
        small(r.pass === false ? 'FAILS' : r.pass ? 'Complies' : 'Reported', { bold: true, color: r.pass === false ? RED : undefined })]),
    ] }, layout: 'lightHorizontalLines' },
    small('Every result above was reviewed by a second person with its audit trail before this decision.', { margin: [0, 6, 0, 0], color: '#555555' }),
    ...results.filter((r) => r.individual?.length).map((r) => small(`${r.name}: ${r.individual!.length} individual results ${r.individual!.join(', ')}${r.unit ? ` ${r.unit}` : ''}; the figure reported is ${r.figure === 'AV' ? 'the acceptance value' : 'their mean'}.`, { margin: [0, 2, 0, 0] })),
    ...results.filter((r) => r.certificate).map((r) => small(`${r.name}: taken from the certificate ${r.analysisNo} of the manufacturer ${r.certificate!.manufacturer} (scan ${r.report?.file ?? ''}, SHA-256 ${r.report?.sha256 ?? ''}): the lot was tested on the supplier's certificate (reduced testing, LIMS-09) with its identity tested here; the result was typed from the certificate and checked by a second person.`, { margin: [0, 2, 0, 0] })),
    ...results.filter((r) => r.outsideLab && !r.certificate).map((r) => small(`${r.name}: tested by the outside (contract) lab ${r.outsideLab}, report ${r.analysisNo} (file ${r.report?.file ?? ''}, SHA-256 ${r.report?.sha256 ?? ''}); the result was typed from the report and checked by a second person.`, { margin: [0, 2, 0, 0] })),
    { text: 'Decision', bold: true, fontSize: 11, margin: [0, 12, 0, 4] },
    small(`APPROVED by ${c.decision.signature?.printedName ?? c.decision.personName}, ${plant(c.decision.signature?.signedAt ?? c.decision.at)} (e-signature, meaning "QC approved")`, { fontSize: 10, bold: true }),
  ];
  return pageFrame(`Medhanta QLIMS · ${title} ${p.coaNo ?? ''} · ${s.item.code} ${s.lotNo}`, by, content, printedAt, demo);
}
