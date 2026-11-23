// LIMS-29, plan 2b-7: the stability data in the CTD layout (3.2.P.8.3 for a finished product, 3.2.S.7.3 for an active
// substance): per batch and storage condition, each stability test with its acceptance criterion and its reviewed result
// at each time point; then the signed ICH Q1E evaluations. PDF (pdfmake, as the CoA) and CSV. Nothing is typed again.
import type { Content } from 'pdfmake/interfaces.js';
import type { ProtocolDoc } from '../shared/master/protocol.js';
import { conditionLabel } from '../shared/master/protocol.js';
import { schedule } from '../shared/engine/stability.js';
import type { NumericTest, ResultPoint } from '../shared/engine/stability-evaluation.js';
import { resultFigure } from './coa.js';
import { pageFrame, plant, runs } from './pdf.js';

export interface CtdCell { figure: string; pass: boolean | null; decided: string | null; oot: string | null; ootAnswer: string | null; sampleNo: string; analysisNo: string }
export interface CtdTable {
  studyId: number; studyNo: string; lotNo: string; protocolNumber: string; protocolVersionNo: number; pack: string; t0: string;
  condition: string; role: string; months: number[]; rows: { key: string; name: string; criterion: string; cells: Record<number, CtdCell> }[];
}
interface Study { id: number; studyNo: string; lotNo: string; t0: string; cell: string | null; protocolMasterId: number; protocolVersionNo: number; doc: ProtocolDoc }
type Point = ResultPoint & { oot: string | null; ootAnswer: string | null };
interface Evaluation { id: number; scope: string; condition: string; kind: string; months: number; studyIds: number[]; outputs: object; printedName: string | null; signedAt: Date | null }
interface Item { of: string; code: string; name: string }

/** The tables: one per study and condition, the time points of its schedule as columns. */
export function ctdTables(studies: readonly Study[], tests: ReadonlyMap<number, NumericTest[]>, points: readonly Point[]): CtdTable[] {
  return studies.flatMap((s) => s.doc.conditions.map((c) => {
    const label = conditionLabel(c);
    const months = schedule(s.doc, s.t0, s.cell).filter((p) => p.condition === c.key).map((p) => p.month);
    const mine = points.filter((p) => p.studyId === s.id && p.condition === c.key);
    return {
      studyId: s.id, studyNo: s.studyNo, lotNo: s.lotNo, protocolNumber: s.doc.header.number, protocolVersionNo: s.protocolVersionNo, pack: s.doc.header.containerClosure,
      t0: s.t0, condition: label, role: c.role, months,
      rows: (tests.get(s.protocolMasterId) ?? []).map((t) => ({ key: t.key, name: t.name, criterion: t.words,
        cells: Object.fromEntries(mine.filter((p) => p.testKey === t.key).map((p) => [p.month, { figure: resultFigure(p.shown, p.value, p.unit), pass: p.pass, decided: p.decided,
          oot: p.oot, ootAnswer: p.ootAnswer, sampleNo: p.sampleNo, analysisNo: p.analysisNo }])) })),
    };
  }));
}

const section = (of: string) => (of === 'material' ? '3.2.S.7.3' : '3.2.P.8.3');
/** The latest signed evaluation of a study at a condition. */
const evaluationOf = (evals: readonly Evaluation[], t: Pick<CtdTable, 'studyId' | 'condition'>) => evals.find((e) => e.condition === t.condition && e.studyIds.includes(t.studyId));
const mark = (c: CtdCell) => `${c.figure}${c.pass === false ? ' (FAILS)' : ''}${c.oot ? ' (OOT)' : ''}${c.decided ? '' : ' *'}`;

// A cell a spreadsheet would run as a formula (also after leading spaces, tab or line break) gets a leading apostrophe.
const FORMULA = /^\s*[=+\-@]/;
export const csvCell = (v: unknown) => { const s = String(v ?? ''); const t = FORMULA.test(s) ? `'${s}` : s; return /[",\n\r]/.test(t) || t !== s ? `"${t.replaceAll('"', '""')}"` : t; };
export function ctdCsv(item: Item, tables: readonly CtdTable[], evals: readonly Evaluation[]): string {
  const kind = item.of === 'material' ? 'Retest period (months)' : 'Shelf life (months)';
  const head = ['Section', 'Code', 'Name', 'Study', item.of === 'material' ? 'Lot' : 'Batch', 'Protocol', 'Container closure', 'Placed', 'Condition', 'Role', 'Test',
    'Acceptance criterion', 'Time point (months)', 'Result', 'Complies', 'Sample', 'Analysis', 'QC decision', 'Out of trend', kind];
  const lines = [head];
  for (const t of tables) {
    const e = evaluationOf(evals, t);
    for (const r of t.rows) for (const m of t.months) {
      const c = r.cells[m];
      lines.push([section(item.of), item.code, item.name, t.studyNo, t.lotNo, `${t.protocolNumber} v${t.protocolVersionNo}`, t.pack, t.t0, t.condition, t.role, r.name, r.criterion, String(m),
        c?.figure ?? '', c ? (c.pass === false ? 'no' : c.pass ? 'yes' : '') : '', c?.sampleNo ?? '', c?.analysisNo ?? '', c ? (c.decided ?? 'reviewed, not yet decided') : '',
        c?.oot ? `${c.oot}${c.ootAnswer ? `; QC: ${c.ootAnswer}` : ''}` : '', e ? String(e.months) : '']);
    }
  }
  return `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const small = (text: string, extra: Record<string, unknown> = {}): Content => ({ text: runs(text), fontSize: 7.5, ...extra }) as Content;
const th = (text: string): Content => ({ text: runs(text), fontSize: 7.5, bold: true, fillColor: '#eef1f4' });
const RED = '#b3261e';

export function ctdDoc(item: Item, tables: readonly CtdTable[], evals: readonly Evaluation[], by: string, printedAt = new Date(), demo = false) {
  const what = item.of === 'material' ? 'retest period' : 'shelf life';
  const content: Content[] = [
    { text: runs(`${section(item.of)} Stability data`), fontSize: 15, bold: true },
    { text: runs(`${item.code} · ${item.name}`), fontSize: 11, margin: [0, 2, 0, 6] },
    small('Results are the reportable values of the reviewed analyses of the stability samples. * reviewed, the sample\'s QC decision pending. FAILS: outside the acceptance criterion (OOS). OOT: out of trend (95 % prediction interval, template L22). —: not tested yet.', { color: '#555555', margin: [0, 0, 0, 8] }),
  ];
  for (const t of tables) {
    const e = evaluationOf(evals, t);
    content.push({ text: runs(`${item.of === 'material' ? 'Lot' : 'Batch'} ${t.lotNo} · ${t.condition} (${t.role}) · study ${t.studyNo}`), bold: true, fontSize: 10, margin: [0, 8, 0, 2] });
    content.push(small(`Protocol ${t.protocolNumber}, version ${t.protocolVersionNo} · container closure ${t.pack} · placed ${t.t0}${e ? ` · ${what} ${e.months} months (signed evaluation)` : ''}`, { margin: [0, 0, 0, 3] }));
    content.push({ table: { headerRows: 1, dontBreakRows: true, widths: [90, 80, ...t.months.map(() => '*')], body: [
      [th('Test'), th('Acceptance criterion'), ...t.months.map((m) => th(`${m} months`))],
      ...t.rows.map((r) => [small(r.name, { bold: true }), small(r.criterion), ...t.months.map((m) => { const c = r.cells[m]; return c ? small(mark(c), { color: c.pass === false || c.oot ? RED : undefined }) : small('—'); })]),
    ] }, layout: 'lightHorizontalLines' } as Content);
  }
  content.push({ text: `Evaluation (ICH Q1E, template L15)`, bold: true, fontSize: 11, margin: [0, 14, 0, 4] });
  if (!evals.length) content.push(small(`No ${what} has been signed yet.`));
  else content.push({ table: { headerRows: 1, widths: [110, 60, '*', 70, 120], body: [
    [th('Condition'), th(`${what[0]!.toUpperCase()}${what.slice(1)}`), th('Limited by'), th('Scope'), th('Signed')],
    ...evals.map((e) => {
      const p = (e.outputs as { proposal?: { test?: string; limiting?: string } }).proposal;
      return [small(e.condition), small(`${e.months} months`, { bold: true }), small(p?.test ? `${p.test}, ${p.limiting ?? ''}` : ''), small(e.scope === 'study' ? 'one study' : `${e.studyIds.length} studies`),
        small(`${e.printedName ?? ''}, ${plant(e.signedAt)} (QC approved)`)];
    }),
  ] }, layout: 'lightHorizontalLines' } as Content);
  return pageFrame(`Medhanta QLIMS · ${section(item.of)} Stability data · ${item.code}`, by, content, printedAt, demo);
}
