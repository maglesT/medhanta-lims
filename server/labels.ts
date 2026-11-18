// Printed from the record, nothing typed: the sample's labels (LIMS-06) and a numbered blank worksheet for paper
// (LIMS-54). pdfmake, as the certificate (server/coa.ts).
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { findBlock } from '../shared/blocks/index.js';
import { stepTitle } from '../shared/engine/analysis.js';
import type { MasterDoc } from '../shared/master/schema.js';
import { PLANT_TZ, plantDate } from '../shared/plant-time.js';
import { pageFrame, plant, runs } from './pdf.js';
import type { SampleRow } from './routes/samples.js';

const LOT_WORD = { material: 'Lot', product: 'Batch', room: 'Point', water: 'Point' } as const;
const line = (label: string, value: string, bold = false): Content => ({ text: [{ text: `${label}: `, color: '#555555' }, ...runs(value).map((r) => ({ ...r, bold }))], fontSize: 8 });

/** One label: a bordered box of lines (about 90 × 50 mm), kept on one page. */
const box = (title: string, lines: Content[]): Content => ({
  unbreakable: true, margin: [0, 0, 0, 8],
  table: { widths: [250], body: [[{ stack: [{ text: runs(title), bold: true, fontSize: 10, margin: [0, 0, 0, 2] }, ...lines] }]] },
} as Content);

/**
 * LIMS-06: the sample's label and a "container sampled" label for each container it was taken from: material or
 * product, lot or batch, container number, sample number, who sampled (registered) it and the date. All from the record.
 */
export function labelsDoc(s: SampleRow, spec: { number: string; versionNo: number }, by: string, printedAt = new Date(), demo = false): TDocumentDefinitions {
  const lot = LOT_WORD[s.item.of];
  const date = plantDate(new Date(s.registeredAt).toLocaleDateString('en-CA', { timeZone: PLANT_TZ }));
  // Made anew for each label: pdfmake changes the content objects it lays out.
  const common = () => [line(s.item.of === 'material' ? 'Material' : s.item.of === 'product' ? 'Product' : 'Item', `${s.item.code} · ${s.item.name}`), line(lot, s.lotNo, true)];
  const n = s.containers ?? 0;
  // LIMS-05: the container numbers the sampler confirmed under the sampling plan; else containers 1 to n.
  const numbers = s.sampling?.numbers ?? Array.from({ length: n }, (_, i) => i + 1);
  const of = s.sampling?.received ?? n;
  const labels: Content[] = [
    box(`QC SAMPLE ${s.sampleNo}`, [...common(),
      line('Containers', s.sampling ? `${numbers.length} sampled of ${of} received: ${numbers.join(', ')}` : n ? `${n} (sampled from container${n === 1 ? '' : 's'} 1${n > 1 ? ` to ${n}` : ''})` : 'not stated'),
      ...(s.sampling?.details.storage ? [line('Storage', s.sampling.details.storage)] : []),
      line('Quantity', s.quantity), line('Purpose', s.purpose), line('Specification', `${spec.number} version ${spec.versionNo}`),
      line('Sampled by', s.registeredByName), line('Date', date)]),
    ...numbers.map((k) => box(`SAMPLED · container ${k} of ${of}`, [...common(), line('Sample', s.sampleNo, true), line('Sampled by', s.registeredByName), line('Date', date)])),
  ];
  return { ...pageFrame(`Medhanta LIMS · Labels of sample ${s.sampleNo} · ${s.item.code} ${s.lotNo}`, by, labels, printedAt, demo), pageOrientation: 'portrait' };
}

/**
 * LIMS-54: a blank worksheet of a method for one sample, numbered on every page (its form number), with the method's
 * steps and a blank for each value and signature. The record is transcribed into an analysis of the sample later; the
 * calculations are done then, by the system.
 */
export function blankFormDoc(f: { formNo: string; reason: string; issuedByName: string; issuedAt: Date | string }, s: SampleRow, m: { doc: MasterDoc; versionNo: number },
  by: string, printedAt = new Date(), demo = false): TDocumentDefinitions {
  const h = m.doc.header;
  const blank = '_____________________';
  const content: Content[] = [
    { text: runs(`Blank worksheet ${f.formNo}`), fontSize: 16, bold: true },
    { text: runs(`${h.code} · ${h.name}, version ${m.versionNo} · sample ${s.sampleNo} · ${s.item.code} ${s.item.name} · ${LOT_WORD[s.item.of].toLowerCase()} ${s.lotNo}`), fontSize: 10, margin: [0, 2, 0, 4] },
    { text: runs(`Issued by ${f.issuedByName}, ${plant(f.issuedAt)}, because: ${f.reason}. Controlled copy: return it to QC, used or not; it is reconciled by its number. `
      + 'Write in ink, cross out with one line, sign and date each change. Transcribe it into an analysis of this sample by this method.'), fontSize: 8, color: '#555555', margin: [0, 0, 0, 6] },
  ];
  m.doc.stages.forEach((st, si) => {
    content.push({ text: runs(`Stage ${si + 1}: ${st.name}${st.kind === 'replicate' ? ` (${st.count} replicates)` : ''}`), bold: true, fontSize: 11, margin: [0, 8, 0, 2] });
    st.steps.forEach((step, ti) => {
      const b = findBlock(step.block);
      const unit = (u?: string) => (u?.startsWith('$') ? String(step.settings[u.slice(1)] ?? '') : u ?? '');
      content.push({ unbreakable: true, margin: [0, 2, 0, 4], stack: [
        { text: runs(`${si + 1}.${ti + 1} ${stepTitle(m.doc, step)}`), bold: true, fontSize: 9 },
        ...(step.instruction ?? b?.instruction ? [{ text: runs(step.instruction ?? b!.instruction), fontSize: 8, color: '#555555' }] : []),
        { table: { widths: [200, '*'], body: (b?.fields ?? []).map((x) => [{ text: runs(x.label), fontSize: 8 },
          { text: runs(x.count ? Array.from({ length: x.count }, (_, k) => `${k + 1}: ________`).join('   ') : `${blank} ${x.kind === 'yes-no' ? 'yes / no' : unit(x.unit)}`), fontSize: 8 }]) }, layout: 'lightHorizontalLines' },
        { text: `Performed by / date: ${blank}${step.checker ? `      Checked by / date: ${blank}` : ''}`, fontSize: 8, margin: [0, 2, 0, 0] },
      ] } as Content);
    });
  });
  content.push({ text: `Returned to QC by / date: ${blank}      Transcribed into analysis: ${blank}`, fontSize: 9, margin: [0, 12, 0, 0] });
  return pageFrame(`Medhanta LIMS · Form ${f.formNo} · blank worksheet ${h.code} for sample ${s.sampleNo}`, by, content, printedAt, demo);
}
