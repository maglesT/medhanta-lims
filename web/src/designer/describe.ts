// A method in plain sentences, section by section (header, each stage), for the review view and for the
// changes view against the previous version. Each line has a key, so two versions can be compared line by line.
import { findBlock } from '../../../shared/blocks/index.js';
import { masterChecks } from '../../../shared/master/checks.js';
import type { Limit, MasterDoc, Stage, Step } from '../../../shared/master/schema.js';
import type { SpecDoc, SpecTest } from '../../../shared/master/spec.js';
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

/** A method or a specification (the review and changes views show both). */
export type AnyDoc = MasterDoc | SpecDoc;
export const isSpec = (doc: AnyDoc): doc is SpecDoc => 'tests' in doc;

const limitWords = (l: Limit) => [l.low !== undefined ? `${l.lowStrict ? 'more than' : 'not less than'} ${l.low}` : '', l.high !== undefined ? `${l.highStrict ? 'less than' : 'not more than'} ${l.high}` : '']
  .filter(Boolean).join(' and ') + (l.unit ? ` ${l.unit}` : '') + (l.alertLow !== undefined || l.alertHigh !== undefined ? ` (alert ${[l.alertLow && `below ${l.alertLow}`, l.alertHigh && `above ${l.alertHigh}`].filter(Boolean).join(', ')})` : '');
/** A specification test in plain words: the limit as its type says, the method, the values it gives the method. */
export function testText(t: SpecTest, n: number): string {
  const limit = t.limitType === 'conforms' ? `Conforms: ${t.conforms ?? '(not said)'}` : t.limitType === 'report only' ? 'Reported only, no limit'
    : t.limitType === 'release and shelf life' ? `Release ${t.limit ? limitWords(t.limit) : '(not set)'}; shelf life ${t.shelfLifeLimit ? limitWords(t.shelfLifeLimit) : '(not set)'}`
    : t.limit ? `${t.limitType === 'alert and action' ? 'Action limit' : 'Limit'} ${limitWords(t.limit)}` : 'Limit (not set)';
  const trend = t.trendLimit ? `; trend limit ${limitWords(t.trendLimit)}` : '';
  const values = Object.entries(t.values).map(([k, v]) => `${k} ${typeof v === 'string' ? v : limitWords(v)}`).join('; ');
  return `${n + 1}. ${t.name}: ${limit}${trend}. Method ${t.method.code} ${t.method.name}, result ${t.result}. Applies ${t.use === 'release and stability' ? 'at release and on stability' : t.use === 'release' ? 'at release' : 'on stability'}.${values ? ` Gives the method: ${values}.` : ''}`;
}
function describeSpec(doc: SpecDoc): Section[] {
  const h = doc.header;
  return [
    { key: 'header', title: 'Header', lines: [
      { key: 'what', text: `Specification ${h.number} for the ${h.of} ${h.code} ${h.name} (${h.type.toLowerCase()})${h.market ? `, market ${h.market}` : ''}.` },
      { key: 'pharmacopoeia', text: `Pharmacopoeia ${h.pharmacopoeia}${h.edition ? `, ${h.edition}` : ''}.` },
    ] },
    { key: 'tests', title: 'Tests', lines: doc.tests.map((t, n) => ({ key: t.key, text: testText(t, n) })) },
  ];
}

export function describeMaster(doc: AnyDoc, units?: Units): Section[] {
  if (isSpec(doc)) return describeSpec(doc);
  const h = doc.header;
  const top: Section[] = [
    { key: 'header', title: 'Header', lines: [
      { key: 'method', text: `Method ${h.code}, ${h.name}.` },
      { key: 'technique', text: `Technique ${h.technique}. Reference ${h.reference || '(not set)'}${h.edition ? `, ${h.edition}` : ''}.` },
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
export function diffMasters(prev: AnyDoc, next: AnyDoc, units?: Units): DiffSection[] {
  const before = new Map(describeMaster(prev, units).map((s) => [s.key, s]));
  const after = describeMaster(next, units);
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
  return out;
}
