// LIMS-21: the certificate of analysis of an approved sample, the way the analysis record PDF is made: what was sampled
// (item, lot or batch, source), the specification, and each test with its limit, method and the reviewed result decided
// on at approval (kept with the signed decision), then the decision with its e-signature. Nothing is typed again.
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import type { SpecDoc } from '../shared/master/spec.js';
import { isHand } from '../shared/engine/links.js';
import type { EventRow, SampleRow } from './routes/samples.js';
import { pageFrame, plant, runs } from './pdf.js';

interface Decided { key: string; name: string; value: string; unit: string; shown: string; reported?: string; pass?: boolean; limit: string; method: string; analysisNo: string; reviewedAt?: string | null }
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
  ?? /^\s*([-+]?\d[\d.]*(?:\s*[^\s;]+)?)\s*;/.exec(shown)?.[1]?.trim() ?? `${value} ${unit}`.trim();

export function coaDoc(c: CoaInput, by: string, printedAt = new Date(), demo = false): TDocumentDefinitions {
  const s = c.sample;
  const h = c.spec.header;
  const p = c.decision.payload as { coaNo?: string; results?: Decided[] };
  const results = p.results ?? [];
  const figure = (r: Decided) => resultFigure(r.shown, r.value, r.unit, r.reported);
  const content: Content[] = [
    { text: runs(`Certificate of analysis ${p.coaNo ?? ''}`), fontSize: 16, bold: true },
    { text: runs(`${s.item.code} · ${s.item.name}`), fontSize: 11, margin: [0, 2, 0, 8] },
    { table: { widths: [95, '*', 95, '*'], body: [
      [th(s.item.of === 'material' ? 'Material' : 'Product'), small(`${s.item.code} · ${s.item.name}`), th(s.item.of === 'material' ? 'Lot' : 'Batch'), small(s.lotNo, { bold: true })],
      [th('Sample'), small(`${s.sampleNo} (${s.purpose}), ${s.quantity}`), th('Source'), small(isHand(s.source) ? 'typed by hand (link not available), checked by a second person' : s.source.shown)],
      [th('Specification'), small(`${h.number}, version ${c.specVersion}`), th('Pharmacopoeia'), small(`${h.pharmacopoeia}${h.edition ? ` ${h.edition}` : ''}${h.market ? ` · market ${h.market}` : ''}`)],
    ] }, layout: 'lightHorizontalLines' },
    { text: 'Results', bold: true, fontSize: 11, margin: [0, 12, 0, 4] },
    { table: { headerRows: 1, widths: [110, 70, '*', 90, 50], body: [
      [th('Test'), th('Method'), th('Limit'), th('Result'), th('')],
      ...results.map((r) => [small(r.name, { bold: true }), small(`${r.method}\n${r.analysisNo}`), small(r.limit || '—'), small(figure(r), { bold: true }),
        small(r.pass === false ? 'FAILS' : r.pass ? 'Complies' : 'Reported', { bold: true, color: r.pass === false ? RED : undefined })]),
    ] }, layout: 'lightHorizontalLines' },
    small('Every result above was reviewed by a second person with its audit trail before this decision (LIMS-18, LIMS-19).', { margin: [0, 6, 0, 0], color: '#555555' }),
    { text: 'Decision', bold: true, fontSize: 11, margin: [0, 12, 0, 4] },
    small(`APPROVED by ${c.decision.signature?.printedName ?? c.decision.personName}, ${plant(c.decision.signature?.signedAt ?? c.decision.at)} (e-signature, meaning "QC approved")`, { fontSize: 10, bold: true }),
  ];
  return pageFrame(`Medhanta LIMS · Certificate of analysis ${p.coaNo ?? ''} · ${s.item.code} ${s.lotNo}`, by, content, printedAt, demo);
}
