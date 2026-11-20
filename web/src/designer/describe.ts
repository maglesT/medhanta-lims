// A method in plain sentences, section by section (header, each stage), for the review view and for the
// changes view against the previous version. Each line has a key, so two versions can be compared line by line.
import { findBlock } from '../../../shared/blocks/index.js';
import { masterChecks } from '../../../shared/master/checks.js';
import type { Limit, MasterDoc, Stage, Step } from '../../../shared/master/schema.js';
import type { SpecDoc, SpecTest } from '../../../shared/master/spec.js';
import { conditionLabel, PURPOSE_WORDS, type ProtocolDoc } from '../../../shared/master/protocol.js';
import { pointWhere, type MonitoringDoc } from '../../../shared/master/monitoring.js';
import { stepTitle } from '../../../shared/engine/analysis.js';
import { neededText } from '../../../shared/engine/training.js';
import { placeLabel } from './model.js';
import { sentence, sentenceText, settingText, slotsOf } from './sentences.js';

export interface Line { key: string; text: string }
export interface Section { key: string; title: string; lines: Line[] }

/** A hold time in hours, and in days when it is whole days of two or more: "720 hours (30 days)". */
const holdText = (h: number | undefined) => (h === undefined ? '(not set)' : `${h} hours${h >= 48 && h % 24 === 0 ? ` (${h / 24} days)` : ''}`);

function stageText(doc: MasterDoc, s: Stage): string {
  const kind = s.kind === 'preparation' ? 'A preparation' : s.kind === 'replicate' ? `Done in ${s.count ?? '?'} replicates` : 'A stage';
  const uses = s.uses.map((k) => doc.stages.find((x) => x.key === k)).filter(Boolean).map((x) => `${x!.produces?.name ?? x!.name} from ${x!.name}`);
  return [`${kind}, the responsibility of the ${s.role || '(role not set)'}.`,
    `Machine types: ${s.machineTypes.join(', ') || 'any'}. Rooms: ${s.roomTypes.join(', ') || 'any'}.`,
    uses.length ? `Uses ${uses.join(' and ')}.` : '',
    s.produces ? `Produces ${s.produces.name}, to be used within ${holdText(s.produces.holdHours)}.` : 'Produces no intermediate.'].filter(Boolean).join(' ');
}

/** Kept for the callers: units are shown as written. */
export type Units = ReadonlyMap<string, string>;

export function stepText(doc: MasterDoc, t: Step, j: number, _units?: Units): string {
  const b = findBlock(t.block);
  if (!b) return `${j + 1}. Unknown block ${t.block.id}.`;
  const slots = slotsOf(b);
  const shown = (name: string) => settingText(doc, t.settings[name]);
  const loose = b.settings.filter((s) => !slots.has(s.name) && t.settings[s.name] !== undefined).map((s) => `${s.label.replace(/ \(formula line\)$/, '')}: ${shown(s.name)}.`);
  const calcs = b.calcs.map((c) => sentenceText(doc, b, t.settings, sentence(b, c)));
  const flow = t.flow.kind === 'repeat-until' ? `Repeated until the check "${b.calcs.find((c) => c.name === ((t.flow.kind === 'repeat-until' && t.flow.stop) || b.stop))?.label ?? '(not chosen)'}" passes, at most ${t.flow.maxRounds ?? '?'} rounds${t.everyMinutes ? `, a round every ${t.everyMinutes} minutes` : ''}.`
    : t.flow.kind === 'optional-with-reason' ? 'Optional: it may be skipped with a reason.' : '';
  // A step by its title as on the floor (with its material's name and code), never its internal key.
  const steps = doc.stages.find((s) => s.steps.includes(t))?.steps ?? [];
  const after = steps.findIndex((x) => x.key === t.orderAfter);
  return [`${j + 1}. ${stepTitle(doc, t)}: ${t.instruction ?? b.instruction}`, ...loose, ...calcs,
    `Signed by the analyst${t.checker ? ' and checked by a second person' : ''}${t.waitForCheck ? '; the next step waits for the check' : ''}.`,
    t.training ? neededText(t.training, t.checker) : '',
    t.critical ? 'Critical step.' : '', t.minMinutes ? `Takes at least ${t.minMinutes} minutes.` : '', flow,
    t.everyMinutesLater ? `After ${t.everyMinutesLater.afterMinutes} minutes, a round every ${t.everyMinutesLater.everyMinutes} minutes.` : '',
    t.orderAfter ? `Order-critical: after step ${after < 0 ? '(no longer in this stage)' : `${after + 1}. ${stepTitle(doc, steps[after]!)}`}.` : '',].filter(Boolean).join(' ');
}

/** A method, a specification or a stability protocol (the review and changes views show each). */
export type AnyDoc = MasterDoc | SpecDoc | ProtocolDoc | MonitoringDoc;
export const isSpec = (doc: AnyDoc): doc is SpecDoc => 'tests' in doc;
export const isProtocol = (doc: AnyDoc): doc is ProtocolDoc => 'conditions' in doc;
export const isMonitoring = (doc: AnyDoc): doc is MonitoringDoc => 'points' in doc;
/** The title a version is signed under: "EMP-001 · Sterile block", "SPEC-RM-012 · RM-012 Demolol", "M-001 Assay". */
export const docTitle = (doc: AnyDoc) => (isMonitoring(doc) ? `${doc.header.number} · ${doc.header.name}`
  : isSpec(doc) ? `${doc.header.number} · ${doc.header.code} ${doc.header.name}` : `${doc.header.code} ${doc.header.name}`);

/** A monitoring plan in plain words (LIMS-36, LIMS-37): each point, where it is, and what is sampled there. */
function describeMonitoring(doc: MonitoringDoc): Section[] {
  return [
    { key: 'header', title: 'Plan', lines: [{ key: 'what', text: `Monitoring plan ${doc.header.number}: ${doc.header.name || '(no name)'}. ${doc.header.shifts} shift${doc.header.shifts === 1 ? '' : 's'} a day.` }] },
    ...doc.points.map((p) => ({ key: `point:${p.key}`, title: `Point ${p.code}`, lines: [
      { key: 'where', text: `${p.code}, ${p.name || '(no description)'}: ${pointWhere(p)}${p.critical ? ', a critical location' : ''}.` },
      ...p.samplings.map((s) => ({ key: s.key, text: `${s.kind[0]!.toUpperCase()}${s.kind.slice(1)}, ${s.frequency}${s.state ? `, ${s.state}` : ''}, ${s.quantity}: ${s.spec
        ? `specification ${s.spec.number}, ${s.spec.testName} (${s.spec.limit || 'no limit'})${s.spec.method ? `, method ${s.spec.method}` : ''}` : '(no specification test)'}. Isolates identified: ${s.identify}.${s.adverse ? ` Adverse trend: ${s.adverse.n} alert or action results in the last ${s.adverse.m} samplings.` : ' Adverse trend: the default for its grade.'}` })),
    ] })),
  ];
}

const limitWords = (l: Limit) => [l.low !== undefined ? `${l.lowStrict ? 'more than' : 'not less than'} ${l.low}` : '', l.high !== undefined ? `${l.highStrict ? 'less than' : 'not more than'} ${l.high}` : '']
  .filter(Boolean).join(' and ') + (l.unit ? ` ${l.unit}` : '') + (l.alertLow !== undefined || l.alertHigh !== undefined ? ` (alert ${[l.alertLow && `below ${l.alertLow}`, l.alertHigh && `above ${l.alertHigh}`].filter(Boolean).join(', ')})` : '');
/** A spec test's result by its step names ("Assay › HPLC run › Content"), keyed '<method master id>|<result ref>'. */
export type ResultNames = ReadonlyMap<string, string>;
/** A specification test in plain words: the limit as its type says, the method, the values it gives the method. */
export function testText(t: SpecTest, n: number, results?: ResultNames): string {
  const result = results?.get(`${t.method.masterId}|${t.result}`);
  const limit = t.limitType === 'conforms' ? `Conforms: ${t.conforms ?? '(not said)'}` : t.limitType === 'report only' ? 'Reported only, no limit'
    : t.limitType === 'release and shelf life' ? `Release ${t.limit ? limitWords(t.limit) : '(not set)'}; shelf life ${t.shelfLifeLimit ? limitWords(t.shelfLifeLimit) : '(not set)'}`
    : t.limit ? `${t.limitType === 'alert and action' ? 'Action limit' : 'Limit'} ${limitWords(t.limit)}` : 'Limit (not set)';
  const trend = t.trendLimit ? `; trend limit ${limitWords(t.trendLimit)}` : '';
  const values = Object.entries(t.values).map(([k, v]) => `${k} ${typeof v === 'string' ? v : limitWords(v)}`).join('; ');
  return `${n + 1}. ${t.name}: ${limit}${trend}. Method ${t.method.code} ${t.method.name}${result ? `, result ${result}` : ''}. Applies ${t.use === 'release and stability' ? 'at release and on stability' : t.use === 'release' ? 'at release' : 'on stability'}.${t.identity ? ' Identity test: on each container of a starting material.' : ''}${t.ipcField ? ` Answers the TrueBatch in-process field ${t.ipcField}.` : ''}${values ? ` Gives the method: ${values}.` : ''}`;
}
function describeSpec(doc: SpecDoc, results?: ResultNames): Section[] {
  const h = doc.header;
  return [
    { key: 'header', title: 'Header', lines: [
      { key: 'what', text: `Specification ${h.number} for the ${h.of} ${h.code} ${h.name} (${h.type.toLowerCase()})${h.market ? `, market ${h.market}` : ''}.` },
      { key: 'pharmacopoeia', text: `Pharmacopoeia ${h.pharmacopoeia}${h.edition ? `, ${h.edition}` : ''}.` },
      { key: 'reserve', text: h.reserveQuantity ? `Reserve sample: ${h.reserveQuantity}.` : 'No reserve sample.' },
      { key: 'sampling', text: h.sampling ? `Sampling plan: ${h.sampling.plan === 'square root' ? '1 + √N containers' : 'every container'}.${(['method', 'equipment', 'amount', 'subdivision', 'precautions', 'storage'] as const).map((k) => h.sampling?.[k] ? ` ${k[0]!.toUpperCase()}${k.slice(1)}: ${h.sampling[k]}.` : '').join('')}` : 'No sampling plan.' },
      { key: 'reduced', text: h.reducedTesting ? `Reduced testing on the supplier's certificate allowed for a QMS-approved supplier: identity tested on every lot; full testing every ${h.reducedTesting.fullEvery} lots and at least every ${h.reducedTesting.months} months.` : 'Every lot tested in full.' },
    ] },
    { key: 'tests', title: 'Tests', lines: doc.tests.map((t, n) => ({ key: t.key, text: testText(t, n, results) })) },
  ];
}

/** A stability protocol in plain words (LIMS-26). */
function describeProtocol(doc: ProtocolDoc): Section[] {
  const h = doc.header;
  const d = doc.design;
  return [
    { key: 'header', title: 'Protocol', lines: [
      { key: 'what', text: `Stability protocol ${h.number} for the ${h.of} ${h.code} ${h.name}: ${PURPOSE_WORDS[h.purpose].toLowerCase()}.` },
      { key: 'pack', text: `Container closure: ${h.containerClosure || '(not set)'}${h.sameAsMarketed ? ', as marketed' : ', NOT the one marketed'}. Shelf life ${h.shelfLifeMonths} months.` },
      { key: 'spec', text: doc.spec ? `Tested to specification ${doc.spec.number}, version ${doc.spec.versionNo} (its stability tests and shelf-life limits).` : 'Specification (not set).' },
      { key: 'quantity', text: `${doc.quantity.amount} ${doc.quantity.unit} pulled at each time point, within ± ${doc.pullWindowDays} days of its date.` },
    ] },
    { key: 'conditions', title: 'Conditions and time points', lines: doc.conditions.map((c) => ({ key: c.key, text: `${conditionLabel(c)} (${c.role}): ${c.months.join(', ') || '(none)'} months.` })) },
    { key: 'design', title: 'Design', lines: [
      { key: 'type', text: `${d.type[0]!.toUpperCase()}${d.type.slice(1)} design.${d.justification ? ` Why: ${d.justification}` : ''}` },
      ...d.factors.map((f, i) => ({ key: `f${i}`, text: `${f.name} (${f.kind}): ${f.levels.map((l) => `${l.name}${l.tested ? ' (tested)' : ''}`).join(', ')}.` })),
      ...d.matrix.map((m, i) => ({ key: `m${i}`, text: `${m.cell} at ${m.condition}: ${m.months.join(', ')} months.` })),
    ] },
  ];
}

export function describeMaster(doc: AnyDoc, units?: Units, results?: ResultNames): Section[] {
  if (isSpec(doc)) return describeSpec(doc, results);
  if (isProtocol(doc)) return describeProtocol(doc);
  if (isMonitoring(doc)) return describeMonitoring(doc);
  const h = doc.header;
  const top: Section[] = [
    { key: 'header', title: 'Header', lines: [
      { key: 'method', text: `Method ${h.code}, ${h.name}.` },
      { key: 'technique', text: `Technique ${h.technique}. Reference ${h.reference || '(not set)'}${h.edition ? `, ${h.edition}` : ''}.` },
      { key: 'source', text: `Source: ${h.origin === 'pharmacopoeial' ? 'pharmacopoeial (verified before use)' : h.origin === 'transferred' ? 'transferred from another laboratory (transfer report before use)' : 'in-house (validated before use)'}. Used for: ${h.use === 'validation' ? 'a validation worksheet' : 'routine testing'}.` },
    ] },
  ];
  return [
    ...top,
    ...doc.stages.map((s, i) => ({ key: `stage:${s.key}`, title: `Stage ${i + 1}: ${s.name}`, lines: [
      { key: 'about', text: stageText(doc, s) },
      ...s.steps.map((t, j) => ({ key: t.key, text: stepText(doc, t, j, units) })),
    ] })),

    // The calculation checks the author answered (or not yet), for the checker and QA; only when there are some.
    ...[{ key: 'answers', title: 'Calculation checks', lines: masterChecks(doc).flatMap((p) => (p.question ? [{ key: p.question.key,
      text: `${placeLabel(doc, p.path)}: ${p.message} ${p.question.answer ? `Answered: ${p.question.answer.choice}${p.question.answer.reason ? `. Reason: ${p.question.answer.reason}` : ''}.` : 'Not answered yet.'}` }] : [])) }].filter((s) => s.lines.length),
  ];
}

export type Change = 'same' | 'added' | 'changed' | 'removed';
export interface DiffLine extends Line { change: Change; was?: string }
export interface DiffSection { key: string; title: string; change: Change; lines: DiffLine[] }

/** The changes from the previous version, line by line (by key; a step that moved shows its new number). */
export function diffMasters(prev: AnyDoc, next: AnyDoc, units?: Units, results?: ResultNames): DiffSection[] {
  const before = new Map(describeMaster(prev, units, results).map((s) => [s.key, s]));
  const after = describeMaster(next, units, results);
  const out: DiffSection[] = after.map((s) => {
    const old = before.get(s.key);
    const lines: DiffLine[] = s.lines.map((l) => {
      const was = old?.lines.find((x) => x.key === l.key)?.text;
      return { ...l, change: was === undefined ? 'added' : was === l.text ? 'same' : 'changed', ...(was !== undefined && was !== l.text ? { was } : {}) };
    });
    for (const l of old?.lines ?? []) if (!s.lines.some((x) => x.key === l.key)) lines.push({ ...l, change: 'removed' });
    return { key: s.key, title: s.title, change: !old ? 'added' : lines.some((l) => l.change !== 'same') ? 'changed' : 'same', lines };
  });
  for (const s of before.values()) if (!after.some((x) => x.key === s.key)) out.push({ ...s, change: 'removed', lines: s.lines.map((l) => ({ ...l, change: 'removed' })) });
  // Safety net: a change no plain line shows (a field without its own line) is still listed, so nobody signs a version
  // whose change they cannot see.
  if (out.every((s) => s.change === 'same')) {
    const paths = changedPaths(prev, next);
    if (paths.length) out.push({ key: 'other', title: 'Other changes', change: 'changed', lines: paths.map((p) => ({ key: p.path, text: `${p.path}: ${p.now}`, change: 'changed', was: `${p.path}: ${p.was}` })) });
  }
  return out;
}

const shown = (v: unknown) => (v === undefined ? '(not set)' : typeof v === 'string' ? v : JSON.stringify(v));
/** The paths where two documents differ (at most 20), with the value before and after. */
export function changedPaths(a: unknown, b: unknown, path = '', out: { path: string; was: string; now: string }[] = []): { path: string; was: string; now: string }[] {
  if (out.length >= 20 || JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) changedPaths(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else out.push({ path: path || '(document)', was: shown(a), now: shown(b) });
  return out;
}
