/**
 * Method checks: pure checks over one method document. Each problem is an error (⛔, the version cannot be approved)
 * or a warning (⚠️), with the path to the item. Template settings are checked by the templates library itself.
 */
import { findBlock, type Block } from '../blocks/index.js';
import { c1WithinLimits, findUnit } from '../templates/index.js';
import { evaluate } from '../engine/values.js';
import type { Answer, MasterDoc, SettingValue } from './schema.js';
import { unitKindProblem } from './kinds.js';
import { isBalance } from '../engine/picks.js';

/** A warning the author answers: one of the options, with a reason when `needsReason`. */
export interface Question { key: string; options: string[]; needsReason: boolean; answer?: Answer }
export interface Problem { level: 'error' | 'warning'; path: string; message: string; rule?: string; question?: Question }

/**
 * A message in plain words for the people who read it: without the internal codes of the rules (LIMS-12) and
 * templates (T9, L1) the code comments use. The rule stays in `rule` for the tests.
 */
export const plainWords = (m: string) => m.replace(/\s*\((?:T|L)\d+\)/g, '');

/** What stops "Send for review" and approval: an error, or a warning that needs an answer and has none. */
export const blocking = (p: Problem) => p.level === 'error' || (p.question !== undefined && !p.question.answer);

const QUANTITY = /^[+-]?(\d+(\.\d*)?|\.\d+)\s*(\S.*)?$/;
const DECIMAL = /^\d+(\.\d+)?$/;

export function masterChecks(doc: MasterDoc): Problem[] {
  const out: Problem[] = [];
  const error = (path: string, message: string, rule?: string) => out.push({ level: 'error', path, message, ...(rule ? { rule } : {}) });
  const warn = (path: string, message: string) => out.push({ level: 'warning', path, message });
  const twice = (keys: string[], path: string) => keys.forEach((k, i) => keys.indexOf(k) !== i && error(`${path}[${i}]`, `The key ${k} is used twice`));

  if (!doc.stages.length) error('stages', 'The method has no steps');
  twice(doc.stages.map((s) => s.key), 'stages');
  doc.stages.forEach((s, si) => {
    const path = `stages[${si}]`;
    twice(s.steps.map((t) => t.key), `${path}.steps`);
    if (s.kind === 'replicate' && !s.count) error(path, 'A replicate stage needs the number of replicates');
    if (s.produces && !s.produces.holdHours) error(`${path}.produces`, `The intermediate ${s.produces.name} has no hold time`, 'LIMS-01');
    // Everything the plain view would show as "(not set)" is reported here (the plain view's sentences, describe.ts).
    if (!s.role.trim()) warn(path, `Stage ${s.name} names no responsible role`);
    if (s.kind === 'preparation' && !doc.stages.some((x) => x.uses.includes(s.key))) warn(path, `No stage uses the preparation ${s.name}`);
    const clearance = s.steps.findIndex((t) => findBlock(t.block)?.gmp === 'line-clearance');
    if (clearance > 0) warn(`${path}.steps[${clearance}]`, `Bench clearance is not the first step of ${s.name}`);
    // LIMS-12: a stage that works machines (not balances) or names a room
    // runs only in the rooms it allows (shared/engine/picks.ts).
    const placed = s.steps.some((t) => { const b = findBlock(t.block); return b?.fields.some((f) => f.kind === 'room' || (f.kind === 'machine' && !isBalance(f))); });
    // LIMS-12: an instrument field names no type of its own: the stage names the instrument types it may use.
    if (s.steps.some((t) => findBlock(t.block)?.fields.some((f) => f.kind === 'machine' && !f.types?.length)) && !s.machineTypes.length) {
      error(`${path}.machineTypes`, `Stage ${s.name} runs an instrument: choose the instrument types it may use (stage settings)`, 'LIMS-12');
    }
    if (placed && !s.roomTypes.length) error(`${path}.roomTypes`, `Stage ${s.name}: choose the rooms this stage may run in (an area or a room of master data, in the stage settings)`, 'LIMS-12');
    for (const u of s.uses) {
      const pi = doc.stages.findIndex((x) => x.key === u);
      if (pi < 0 || pi >= si) error(`${path}.uses`, `${u} is not an earlier stage`);
      else if (!doc.stages[pi]!.produces) error(`${path}.uses`, `Stage ${doc.stages[pi]!.name} produces no intermediate`);
    }
    s.steps.forEach((st, ti) => {
      const p = `${path}.steps[${ti}]`;
      const block = findBlock(st.block);
      if (!block) return void error(`${p}.block`, `No block ${st.block.id} version ${st.block.version}`);
      if (!st.checker && (block.gmp || st.critical)) error(p, `${block.gmp ? `A ${block.gmp.replace('line-clearance', 'bench clearance')} step` : 'A critical step'} needs a second-person check`, 'LIMS-41');
      if (st.critical && st.flow.kind === 'optional-with-reason') error(`${p}.flow`, 'A critical step cannot be optional');
      if (st.waitForCheck && !st.checker) warn(p, 'The next step waits for a check this step does not have');
      for (const bs of block.settings) if (!bs.optional && st.settings[bs.name] === undefined) error(`${p}.settings.${bs.name}`, `${bs.label} is not set`);
      for (const [name, v] of Object.entries(st.settings)) {
        const bs = block.settings.find((x) => x.name === name);
        const listed = !bs?.options || (typeof v === 'string' && bs.options.includes(v));
        const why = !bs ? `The block ${block.name} has no setting ${name}` : listed ? settingProblem(doc, si, ti, bs.kind, v) : `${bs.label}: choose one of ${bs.options!.join(', ')}`;
        if (why) error(`${p}.settings.${name}`, why);
        // LIMS-01: a limit (or a typed target) in a unit of another kind than the value it checks.
        const unit = typeof v === 'object' && 'unit' in v ? v.unit : typeof v === 'string' && bs?.kind === 'quantity' ? QUANTITY.exec(v)?.[3] : undefined;
        const wrong = !why && unit !== undefined ? unitKindProblem(block, name, st.settings, unit) : null;
        if (wrong) error(`${p}.settings.${name}`, wrong, 'LIMS-01');
      }
      // A temperature recorded with optional limits left empty is recorded without a check (the disintegration
      // medium at 37 ± 2 °C, an inlet or forming temperature): a warning, so the author sets them or leaves them knowingly.
      for (const c of block.calcs) {
        const a = c.args as { value?: unknown; limit?: unknown };
        const lim = c.template === 'C1' && typeof a.limit === 'string' ? block.settings.find((x) => x.name === a.limit!.toString().slice(1) && x.optional) : undefined;
        const f = typeof a.value === 'string' ? block.fields.find((x) => x.name === (a.value as string).slice(1)) : undefined;
        if (lim && f && findUnit(f.unit ?? '')?.kind === 'temperature' && st.settings[lim.name] === undefined) warn(`${p}.settings.${lim.name}`, `${f.label} is recorded but not checked: set the ${lim.label.toLowerCase()}`);
      }
      // A calculation that needs no recorded value is worked out now (e.g. a liquid make-up, T17): a refusal must be fixed.
      const now = evaluate(doc, [], { stage: si, sub: 1, step: ti, round: 1 }, {});
      for (const c of block.calcs) { const r = now[c.name]; if (r && !r.ok) error(p, `${c.label}: ${r.message}`); }
      if (st.flow.kind === 'repeat-until') {
        if (!st.flow.maxRounds) error(`${p}.flow`, 'A repeat-until step needs the most rounds allowed');
        const stop = st.flow.stop ?? block.stop;
        if (!stop || !block.calcs.some((c) => c.name === stop)) error(`${p}.flow`, 'A repeat-until step needs a stop check (a calculation of its block)');
      }
      if (st.everyMinutes && st.flow.kind !== 'repeat-until') error(`${p}.everyMinutes`, 'Checks every N minutes need a repeat-until step');
      const later = st.everyMinutesLater;
      if (later && !st.everyMinutes) error(`${p}.everyMinutesLater`, 'A later interval needs the interval of the first checks');
      if (later && block.periodic && later.everyMinutes > block.periodic.maxMinutes) error(`${p}.everyMinutesLater`, `Periodic checks every ${later.everyMinutes} min: they must be at least every ${block.periodic.maxMinutes} min`);
      if (block.periodic && !st.everyMinutes) error(`${p}.everyMinutes`, `${block.name} needs the interval of its periodic checks`);
      if (block.periodic && st.everyMinutes && st.everyMinutes > block.periodic.maxMinutes) {
        error(`${p}.everyMinutes`, `Periodic checks every ${st.everyMinutes} min: they must be at least every ${block.periodic.maxMinutes} min`);
      }
    });
  });
  return out.map((p) => ({ ...p, message: plainWords(p.message) }));
}


/** Whether a step setting fits its kind, and a reference points at something earlier that exists. */
function settingProblem(doc: MasterDoc, si: number, ti: number, kind: Block['settings'][number]['kind'], v: SettingValue): string | null {
  if (typeof v === 'string') {
    if (kind === 'number') return DECIMAL.test(v) ? null : `"${v}" is not a plain decimal`;
    if (kind === 'quantity') {
      const m = QUANTITY.exec(v);
      return m && findUnit(m[3] ?? '') ? null : `"${v}" is not a number with a unit from the unit list`;
    }
    return kind === 'text' ? null : `A ${kind} cannot be written as text`;
  }
  if ('unit' in v) {
    if (kind !== 'limit') return `A limit is given where a ${kind} is wanted`;
    const r = c1WithinLimits({ value: { value: '0', unit: v.unit }, limit: v });
    return r.ok ? null : r.message;
  }
  if ('spec' in v) return kind === 'material' ? 'A specification value cannot name a material' : null;
  const [sk, tk, name] = v.ref.split('/') as [string, string, string];
  const ri = doc.stages.findIndex((x) => x.key === sk);
  const target = doc.stages[ri];
  const rt = target?.steps.findIndex((t) => t.key === tk) ?? -1;
  if (!target || rt < 0) return `${v.ref}: no such stage and step`;
  if (ri > si || (ri === si && rt >= ti)) return `${v.ref} comes later than this step`;
  if (ri !== si && target.kind === 'replicate') return `${v.ref} is inside the replicate stage ${target.name}: refer to it from that stage only`;
  const b = findBlock(target.steps[rt]!.block);
  const names = b ? [...b.fields, ...b.calcs].map((x) => x.name) : [];
  if (!names.includes(name)) return `${v.ref}: step ${tk} has no field or calculation ${name}`;
  return null;
}
