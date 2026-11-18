// LIMS-51: the analysis record as a PDF, the way the Logbook makes its copies. Everything comes from the master version and
// the events, worked out by the engine as on screen; nothing is typed again. Changed values are marked: the original
// is struck through and kept with the reason, the person and the time.
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { findBlock, type Block } from '../shared/blocks/index.js';
import type { Step } from '../shared/master/schema.js';
import { isCaptured, qualKey } from '../shared/engine/links.js';
import { analysisView, deviations, deviationNumber, deviationText, fieldLabel, handFields, lateItems, notYetText, cutShort, stoppedText, TERMINATED_STATE, openSteps, PROVIDER_NAME, deviationStatusWords, stepTitle, headline, limitOf, withoutVerdict, statusWords, CERTIFICATE, trainingOf, trainingText, trainingTyped, skillText, handWords, type DeviationStatus, type EventKind, type Source, type Stored, type StepView, type Value } from '../shared/engine/index.js';
import type { LoadedAnalysis } from './routes/analyses.js';
import { pageFrame, plant, runs } from './pdf.js';
import { plantText } from '../shared/plant-time.js';

// A signature of the analysis; `step` is the step instance of a step signature.
export interface Signature { objectType: string; objectId: number; printedName: string; meaning: string; signedAt: Date; step: string | null }
// deviationsRead: the deviations as the Deviations system has them now (null without the link).
export interface RecordInput extends LoadedAnalysis { versionNo: number; issuedByName: string; signatures: Signature[]; deviationsRead?: ReadonlyMap<string, DeviationStatus> | null }
// A unit as written (a count stays "units").
const unitName = (u: string, _stock?: string) => u;

const MEANING: Record<string, string> = {
  issued: 'Issued', performed: 'Performed', verified: 'Verified (second person)', reviewed: 'Reviewed (second person)', stopped: 'Stopped',
  qc_approved: 'QC approved', rejected: 'Rejected', oos_approved: 'QA approved (OOS)',
  // LIMS-24, LIMS-48: an analysis whose result QA invalidated in an OOS investigation is kept, marked.
  invalidated: 'Invalidated by QA (OOS investigation)',
};
const EVENT: Record<EventKind, string> = {
  started: 'Started', value: 'Recorded', done: 'Signed as done', checked: 'Checked', sent_back: 'Sent back', corrected: 'Corrected',
  not_applicable: 'Not applicable', late: 'Ran over (server timer)', note: 'Deviation note',
  demo_wait_skipped: 'DEMO: wait skipped',
};
const STATE: Record<string, string> = {
  waiting: 'not started', open: 'not started', in_progress: 'in progress', done_awaiting_check: 'waiting for check', done: 'done', checked: 'checked', not_applicable: 'not applicable',
};

const RED = '#b3261e';
const isItem = (v: Value): v is { itemId: string; code: string; name: string; version: number } => typeof v === 'object' && !Array.isArray(v) && 'itemId' in v;
export function valueText(v: Value | undefined, stockUnit?: string): string {
  if (v === undefined) return '—';
  if (Array.isArray(v)) return v.map((x) => x.value).join(', ') + (v[0]?.unit ? ` ${unitName(v[0].unit, stockUnit)}` : '');
  // Master data's version of a machine or room stays in the event; the record names the item (owner, 17 Nov 2026).
  if (isItem(v)) return `${v.code} · ${v.name}`;
  if (typeof v === 'object') return `${v.value}${v.unit ? ` ${unitName(v.unit, stockUnit)}` : ''}`;
  return plantText(v, true);
}
/** The value at the end of a worked line ("… = 10.152 kg"). */
const endOf = (r: Stored) => (r.ok ? (/=\s*([^=;]+)$/.exec(r.shown)?.[1]?.trim() ?? `${r.value} ${r.unit}`) : '');
const checksOf = (r: Stored) => (r.ok ? Object.entries(r).filter(([k, v]) => /check$/i.test(k) && v && typeof v === 'object') as [string, { pass: boolean; shown: string }][] : []);

const small = (text: string, extra: Record<string, unknown> = {}): Content => ({ text: runs(text), fontSize: 7.5, ...extra }) as Content;
const heading = (text: string): Content => ({ text: runs(text), bold: true, fontSize: 11, margin: [0, 12, 0, 4] });
const th = (text: string): Content => ({ text, fontSize: 8, bold: true, fillColor: '#eef1f4' });
const table = (widths: (number | string)[], head: string[], rows: Content[][], empty = 'None.'): Content =>
  rows.length ? { table: { headerRows: 1, dontBreakRows: true, widths, body: [head.map(th), ...rows] }, layout: 'lightHorizontalLines' } : { text: empty, italics: true, fontSize: 8 };

export function analysisRecordDoc(r: RecordInput, by: string, printedAt = new Date(), demo = false): TDocumentDefinitions {
  const { doc, events, analysisEvents, now } = r;
  const h = doc.header;
  const view = analysisView(doc, events, analysisEvents, now, r.deviationsRead);
  const { steps } = openSteps(doc, events, now);
  const names = new Map(events.map((e) => [e.person, e.personName]));
  const who = (id: number | null) => (id === null ? 'server' : names.get(id) ?? `person ${id}`);
  const sigOf = new Map(r.signatures.filter((s) => s.objectType === 'step_event').map((s) => [s.objectId, s]));
  const stepOf = (v: StepView) => doc.stages[v.key.stage]!.steps[v.key.step]!;
  const unitOf = (_v: StepView): string | undefined => undefined;
  const stepName = (v: StepView) => {
    const s = doc.stages[v.key.stage]!;
    const st = stepOf(v);
    return `${v.key.stage + 1}.${v.key.step + 1} ${stepTitle(doc, st)}${s.kind === 'replicate' ? ` · replicate ${v.key.sub}` : ''}${st.flow.kind === 'repeat-until' ? ` · round ${v.key.round}` : ''}`;
  };
  const byId = new Map(steps.map((v) => [v.id, v]));
  const stepLabel = (id: string) => { const v = byId.get(id); return v ? `${doc.stages[v.key.stage]!.name} · ${stepName(v)}` : id; };

  const record = 'Analysis record';
  // A stopped analysis: said at the top and in the decisions.
  const ended = analysisEvents.find((b) => b.kind === 'stopped');
  const endedText = ended && stoppedText(ended, plant);
  const content: Content[] = [
    { text: runs(`${record} ${r.analysis.analysisNo}`), fontSize: 16, bold: true },
    { text: runs(`${h.code} · ${h.name}`), fontSize: 11, margin: [0, 2, 0, 8] },
    { table: { widths: [90, '*', 90, '*', 90, '*'], body: [
      [th('Method'), small(`${h.code} · ${h.name}`), th('Analysis no.'), small(r.analysis.analysisNo, { bold: true }), th('Status'), small(statusWords(view.status, true), { bold: true })],
      [th('Sample'), small(r.sample ? `${r.sample.sampleNo} · ${r.sample.item.code} ${r.sample.item.name} · ${r.sample.lotNo}` : 'none (trial analysis)'), th('Specification'), small(r.sample ? `${r.sample.spec.number} version ${r.sample.spec.versionNo}: ${r.sample.tests.map((t) => t.name).join(', ')}` : '—'), th('Purpose'), small(r.sample?.purpose ?? '—')],
      [th('Technique'), small(h.technique), th('Reference'), small([h.reference, h.edition].filter(Boolean).join(', ') || '—'), th('Method version'), small(String(r.versionNo))],
      [th('Issued'), small(`${r.issuedByName}, ${plant(r.analysis.issuedAt)}`), th('Times'), small('plant time (IST)'), th('Changed values'), small('marked CHANGED; the original is struck through, with the reason', { color: RED })],
    ] }, layout: 'lightHorizontalLines' },
    ...(endedText ? [small(endedText, { bold: true, color: RED, margin: [0, 6, 0, 0] })] : []),
  ];

  // The deviations of the notes: the number written with the note, or the one Deviations filed from it (read live).
  const devs = deviations(events, analysisEvents, r.deviationsRead);
  const devOf = (e: { id: number }) => devs.find((x) => x.note === e.id);

  // Every stage and step: values, worked calculation lines with limits and pass/fail, who did and checked what and when.
  doc.stages.forEach((s, si) => {
    const mine = steps.filter((v) => v.key.stage === si);
    content.push(heading(`Stage ${si + 1}: ${s.name}`));
    content.push(small([s.kind === 'preparation' ? 'Preparation' : s.kind === 'replicate' ? `${s.count} replicates` : 'Stage', s.role, s.roomTypes.length ? `rooms: ${s.roomTypes.join(', ')}` : '']
      .filter(Boolean).join(' · '), { margin: [0, 0, 0, 4] }));
    content.push(table([120, '*', '*', 175], ['Step', 'Recorded values', 'Calculations, limits and result', 'Who and when'], mine.map((v) => {
      const st = stepOf(v);
      const block = findBlock(st.block);
      return [
        { stack: [small(stepName(v), { bold: true }), small((ended && TERMINATED_STATE[v.state]) || (STATE[v.state] ?? v.state), { color: v.state === 'not_applicable' ? '#666666' : undefined })] },
        { stack: block ? valueLines(block, v, who, unitOf(v)) : [] },
        { stack: block ? resultLines(block, st, v, who, cutShort(ended, v, steps), unitOf(v)) : [] },
        { stack: v.events.filter((e) => e.kind !== 'value').map((e) => {
          // Demo installations only (server/demo.ts).
          if (e.kind === 'demo_wait_skipped') return small(`DEMO: wait skipped by ${who(e.person)} at ${plant(e.at)} · ${String(e.payload.label ?? '')}`, { color: RED, bold: true });
          const sig = sigOf.get(e.id);
          const d = e.kind === 'note' ? devOf(e) : undefined;
          const extra = e.payload.reason ? ` · reason: ${e.payload.reason}` : e.payload.text ? ` · ${d ? `deviation ${deviationText(d)}: ` : ''}${e.payload.text}` : '';
          const kind = EVENT[e.kind];
          // The signer's training in the step's skill (owner, 17 Nov 2026): from Recruitment, or typed by hand.
          const trained = trainingOf(e);
          const training = trained ? ` · ${trained.from === 'hand' ? trainingText(trained).toUpperCase() : trainingText(trained)}` : '';
          return small(`${kind}: ${who(e.person)}, ${plant(e.at)}${sig ? ` · signed "${MEANING[sig.meaning] ?? sig.meaning}"` : ''}${training}${extra}`,
            e.kind === 'late' || e.kind === 'sent_back' || trained?.from === 'hand' ? { color: RED } : {});
        }) },
      ];
    }), 'No steps.'));
  });

  // Timers that ran over, with the deviation notes made after them.
  content.push(heading('Timers that ran over'));
  content.push(table([250, 120, '*'], ['Timer', 'Due', 'Deviation notes'], lateItems(doc, events, now).map((l) => [
    small(l.timer.label), small(plant(l.timer.at)), small(l.notes.map((n) => `${devOf(n) ? `${devOf(n)!.reference}: ` : ''}${n.payload.text ?? ''} (${who(n.person)}, ${plant(n.at)})`).join('\n') || 'NO DEVIATION NOTE', l.notes.length ? {} : { color: RED }),
  ])));

  // Deviation notes with their number and status (a note with a deviation number is open until it is closed: in the
  // Deviations system while it answers, else by QA); a number typed by hand, or filed in Deviations from the note, says so.
  content.push(heading('Deviation notes'));
  content.push(table([70, 170, '*', 110, 170], ['Deviation', 'Step', 'Note', 'Written', 'Status'], events.filter((e) => e.kind === 'note').map((e) => {
    const d = devOf(e);
    const closed = d?.closed && analysisEvents.find((b) => b.id === d.closed!.id);
    return [small(d ? deviationNumber(d) : '—'), small(stepLabel(`${e.stage}.${e.sub}.${e.step}.${e.round}`)), small(e.payload.text ?? ''), small(`${who(e.person)}, ${plant(e.at)}`),
      small(!d ? 'note (no deviation number)' : d.status ? `${d.open ? 'OPEN: ' : ''}${deviationStatusWords(d.status)} in the Deviations system${d.closedAt ? `, ${plant(d.closedAt)}` : ''}` : d.open ? 'OPEN' : `closed by ${closed?.personName ?? ''}, ${plant(closed?.at)}: ${closed?.payload.reason ?? ''}`, d?.open ? { color: RED } : {})];
  })));

  // LIMS-19, LIMS-32, LIMS-33, LIMS-49: what was read from an instrument (with the raw line) and each CDS result file
  // imported (its file, size, SHA-256, run, sequence and processing method; the CDS stays the raw-data record).
  const captured = events.flatMap((e) => Object.entries(e.payload.source ?? {}).filter(([, x]) => isCaptured(x)).map(([field, x]) => ({ e, field, x: x as Exclude<Source, { from: 'hand' }> })));
  const cdsImports = [...new Map(captured.filter((c) => c.x.from === 'cds').map((c) => [c.e.id, c])).values()];
  if (captured.length) {
    content.push(heading('Read from instruments and imported from the CDS'));
    const label = (c: (typeof captured)[number]) => fieldLabel(findBlock(doc.stages[c.e.stage]!.steps[c.e.step]!.block)?.fields ?? [], c.field);
    content.push(table([170, 150, '*', 110], ['Step', 'Value', 'Source', 'Recorded'], [
      ...captured.filter((c) => c.x.from === 'instrument').map((c) => [small(stepLabel(`${c.e.stage}.${c.e.sub}.${c.e.step}.${c.e.round}`)), small(label(c)),
        small(`Read from ${c.x.capture?.instrument ?? 'the instrument'} (${c.x.shown}); raw: ${(c.x.capture?.raw ?? []).filter((l) => l.trim()).map((l) => `"${l.trim()}"`).join(' ')}; read ${plant(c.x.asOf)}`), small(`${who(c.e.person)}, ${plant(c.e.at)}`)]),
      ...cdsImports.map((c) => [small(stepLabel(`${c.e.stage}.${c.e.sub}.${c.e.step}.${c.e.round}`)),
        small(captured.filter((x) => x.e.id === c.e.id).map(label).join(', ')),
        small(`Imported from the CDS: ${c.x.shown}${c.e.payload.reason ? `; imported again: ${c.e.payload.reason}` : ''}`), small(`${who(c.e.person)}, ${plant(c.e.at)}`)]),
    ]));
  }

  // Signatures whose training was typed by hand because Recruitment was not reachable, for QA (owner, 17 Nov 2026);
  // only when the master names a training.
  if (doc.stages.some((s) => s.steps.some((t) => t.training))) {
    content.push(heading('Training typed by hand (Recruitment not reachable)'));
    content.push(table([170, 150, 120, '*'], ['Step', 'Signed by', 'When', 'Training'], trainingTyped(events).map((x) => [
      small(stepLabel(x.step)), small(`${who(x.person)} (${x.kind === 'checked' ? 'checked' : 'performed'})`), small(plant(x.at)),
      small(`${skillText(x)}: ticked "I am trained", Recruitment ${x.state === 'down' ? 'link down' : 'not linked'}`, { color: RED }),
    ]), 'None: every training was read from Recruitment.'));
  }

  // Every signature of the analysis with its meaning.
  content.push(heading('Signatures'));
  content.push(table([150, 140, 130, '*'], ['Meaning', 'Signed by', 'When', 'What was signed'], r.signatures.map((s) => {
    const what = s.objectType === 'analysis' ? `Analysis ${r.analysis.analysisNo}` : s.step ? stepLabel(s.step) : 'The analysis record';
    return [small(MEANING[s.meaning] ?? s.meaning), small(s.printedName), small(plant(s.signedAt)), small(what)];
  })));

  // The review or the stop.
  content.push(heading('Review'));
  const decisions = analysisEvents.filter((b) => b.kind !== 'deviation_closed');
  content.push(decisions.length ? { stack: decisions.map((b) => small(b === ended ? endedText! :
    `${MEANING[b.kind] ?? b.kind}${b.payload.oosNo ? ` ${b.payload.oosNo}` : ''}: ${b.personName}, ${plant(b.at)}${b.payload.reason ? ` · reason: ${b.payload.reason}` : ''}`,
    { fontSize: 9, bold: true, color: b.kind === 'stopped' || b.kind === 'invalidated' ? RED : undefined, margin: [0, 0, 0, 2] })) }
    : { text: `Not reviewed yet: the analysis is ${statusWords(view.status)}.`, italics: true, fontSize: 9 });
  if (view.status !== 'reviewed') content.push(small(`This copy was made while the analysis is ${statusWords(view.status)}: it is not a reviewed record.`, { color: RED, margin: [0, 4, 0, 0] }));

  return pageFrame(`Medhanta LIMS · ${record} ${r.analysis.analysisNo} · ${h.code} ${h.name}`, by, content, printedAt, demo);
}

/** The recorded values; a corrected value shows the original struck through, the reason, the person and the time. */
function valueLines(block: Block, v: StepView, who: (id: number | null) => string, stockUnit?: string): Content[] {
  // Label answers typed while a link was off stay in the record when the link gives the value again.
  const names = new Set([...block.fields, ...handFields(block.fields, v.source)].map((f) => f.name).concat(Object.keys(v.values), v.replaced.map((x) => x.field)));
  return [...names].filter((name) => v.values[name] !== undefined || v.replaced.some((x) => x.field === name)).map((name) => {
    const changes = v.replaced.filter((x) => x.field === name);
    const now = runs(`${fieldLabel(block.fields, name)}: ${valueText(v.values[name], stockUnit)}${name in CERTIFICATE ? certificateText(v.source[name]) : sourceText(v.source[name])}${sourceText(v.source[qualKey(name)])}`);
    if (!changes.length) return { text: now, fontSize: 7.5 };
    return { stack: [
      { text: [...now, { text: '  CHANGED', bold: true, color: RED }], fontSize: 7.5 },
      ...changes.map((c) => ({ text: [{ text: 'was ' }, ...runs(valueText(c.was, stockUnit)).map((x) => ({ ...x, decoration: 'lineThrough' as const })),
        ...runs(` · reason: ${c.reason} · ${who(c.person)}, ${plant(c.at)}`)], fontSize: 7, color: RED, margin: [8, 0, 0, 0] as [number, number, number, number] })),
    ] } as Content;
  });
}

// Where a value came from: pulled through a link (as read), or typed by hand while the link was off or down.
const sourceText = (s: Source | undefined) => (!s ? '' : s.from === 'hand' ? ` (BY HAND: ${handWords(s)})` : ` (${plantText(s.shown, true)})`);

// A certificate value from MMS: its basis and report, without the value said again ("· as is, MMS report QC/RM/26/1171").
function certificateText(s: Source | undefined): string {
  const m = s && s.from !== 'hand' ? /^\S+ [\d.]+ %(?: \(([^)]*)\))?, report (.+)$/.exec(s.shown) : null;
  return m ? ` · ${m[1] ? `${m[1]}, ` : ''}${PROVIDER_NAME[(s as { from: keyof typeof PROVIDER_NAME }).from]} report ${m[2]}` : sourceText(s);
}

/** The worked calculation lines, with the limits and pass or fail; a count of the step's material in master data's name
 *  for it (nos for units), as its recorded values and the floor's worked lines. */
function resultLines(block: Block, st: Step, v: StepView, who: (id: number | null) => string, terminated: boolean, stockUnit?: string): Content[] {
  const label = (name: string) => block.calcs.find((c) => c.name === name)?.label ?? block.settings.find((s) => s.name === name)?.label ?? name;
  const out: Content[] = Object.entries(v.results).flatMap(([name, r]) => {
    if (!r.ok) return [small(`${label(name)}: ${r.message}`, { color: RED })];
    const checks = checksOf(r);
    // A round whose stop check is not reached yet is not out of limits: the rounds go on.
    const notYet = name === v.notYet;
    const counted = (t: string) => t.replace(/\bunits\b/g, unitName('units', stockUnit));
    const text = (t: string) => counted(plantText(notYet ? notYetText(t, terminated) : t, true));
    // A check's worked line may start with its own question ("Packing finished: no", "Line clear after packing: …"):
    // the label is not said twice.
    // A figure leads, with its limit (owner, 17 Nov 2026); the worked lines follow without their verdict, which the
    // verdict line under them says once.
    const h = headline(r) && counted(headline(r)!);
    const limit = limitOf(r) && counted(limitOf(r)!);
    const shown = withoutVerdict(text(r.shown));
    const lead = h ? `${label(name)}: ${h}${limit ? ` (limit ${limit})` : ''}` : shown.toLowerCase().startsWith(label(name).toLowerCase()) ? shown : `${label(name)}: ${shown}`;
    return [
      small(lead, h ? { bold: true } : {}),
      ...(h ? [small(shown, { color: '#555555', margin: [8, 0, 0, 0] })] : []),
      ...checks.filter(([, c]) => c.shown !== r.shown).map(([, c]) => small(withoutVerdict(text(c.shown)), { color: '#555555', margin: [8, 0, 0, 0] })),
      ...checks.map(([, c]) => small(c.pass ? 'PASS' : notYet ? (terminated ? 'NOT REACHED: stopped' : 'NOT YET: the rounds go on') : 'FAIL: out of limits', { bold: true, color: c.pass ? '#1b6e3a' : notYet ? '#666666' : RED, margin: [8, 0, 0, 2] })),
    ];
  });
  if (v.inputChanged.length) out.push(small(`Worked out again: an input was corrected later (${v.inputChanged.map((e) => `${who(e.person)}, ${plant(e.at)}`).join('; ')})`, { color: RED }));
  return out;
}
