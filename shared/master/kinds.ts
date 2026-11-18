/**
 * Unit kinds of a block's values and settings: one place for the designer (the units it offers) and the master check
 * (LIMS-01: a limit or a typed target in a unit of another kind than the value it checks is refused; the template would
 * refuse every reading at analysis time). A quantity is of the kind of the values it is used with; a limit of what it limits.
 */
import { refsIn, type Block } from '../blocks/format.js';
import { findUnit, type Kind } from '../templates/index.js';
import type { Step } from './schema.js';

export const kindOfUnit = (symbol: string | undefined): Kind | undefined => (symbol === undefined ? undefined : findUnit(symbol)?.kind);

const CHECKS = /^(C\d|F2)$/;
const T6_MODES: Record<string, Kind> = { carr: 'fraction', hausner: 'number', 'angle of repose': 'angle', log10: 'log', 'whole containers': 'count' };

/**
 * The kind of a calculation's result where its template sets it, not its inputs (null: it follows its inputs). A lab
 * template's result follows its mode or report, as written or as the step's setting names it ("$per").
 */
function resultKind(c: Block['calcs'][number], settings: Step['settings'] = {}): Kind | undefined | null {
  if (['T3', 'T4', 'T5', 'T22'].includes(c.template)) return 'fraction';
  if (c.template === 'T13') return 'time';
  if (/^L\d+$/.test(c.template)) return labKind(c, settings);
  if (c.template !== 'T6') return null;
  const a = c.args as { mode?: string; unit?: unknown };
  return T6_MODES[a.mode ?? ''] ?? (typeof a.unit === 'string' ? kindOfUnit(a.unit) : undefined);
}

function labKind(c: Block['calcs'][number], settings: Step['settings']): Kind | undefined | null {
  const a = c.args as Record<string, unknown>;
  // A "$name" argument is the step's setting of that name (undefined when not set or not a plain text).
  const named = (x: unknown): unknown => (typeof x === 'string' && x.startsWith('$') ? settings[x.slice(1).replace(/\?$/, '')] : x);
  const lit = (x: unknown): string | undefined => { const v = named(x); return typeof v === 'string' ? v : undefined; };
  switch (c.template) {
    case 'L2': case 'L4': case 'L7': case 'L8': return 'fraction';
    case 'L5': return a.express === undefined ? 'fraction' : undefined;
    case 'L1': {
      if (a.iuPerMg !== undefined || a.unit !== undefined) return undefined;
      const per = lit(a.per);
      if (per === 'mass') return 'fraction';
      if (per === 'unit') return named(a.labelClaim) === undefined ? 'mass' : 'fraction';
      return per === 'volume' ? 'mass concentration' : undefined;
    }
    case 'L6': {
      if (a.unit !== undefined) return undefined;
      const r = a.report === undefined ? '%' : lit(a.report) ?? (typeof a.report === 'string' && a.report.endsWith('?') ? '%' : undefined);
      return r === '%' ? 'fraction' : r === 'mg' || r === 'mg per unit' ? 'mass' : r === 'mg/mL' ? 'mass concentration' : undefined;
    }
    case 'L10': {
      const m = lit(a.mode);
      return m === 'specific rotation' ? 'angle' : m === 'pH' || m === 'relative density' ? 'number' : m === 'weight per mL' ? 'density' : undefined;
    }
    default: return undefined;
  }
}

/** The kind of a field, setting or calculation of a block in a step (undefined when it cannot be told). */
export function kindOf(block: Block, name: string, settings: Step['settings'] = {}, seen = new Set<string>()): Kind | undefined {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const f = block.fields.find((x) => x.name === name);
  if (f) {
    if (f.kind !== 'number') return undefined;
    const u = f.unit?.startsWith('$') ? settings[f.unit.slice(1)] : f.unit;
    return typeof u === 'string' ? kindOfUnit(u) : undefined;
  }
  const c = block.calcs.find((x) => x.name === name);
  if (c) {
    if (CHECKS.test(c.template)) return undefined;
    const r = resultKind(c, settings);
    if (r !== null) return r;
    for (const r of refsIn(c.args)) { const k = kindOf(block, r, settings, seen); if (k) return k; }
    return undefined;
  }
  const s = block.settings.find((x) => x.name === name);
  return s ? neededKind(block, name, settings, seen) : undefined;
}

/** The kind a setting must have: a quantity is of the kind of the values it is used with; a limit of what it limits. */
export function neededKind(block: Block, setting: string, settings: Step['settings'] = {}, seen = new Set<string>([setting])): Kind | undefined {
  const s = block.settings.find((x) => x.name === setting);
  for (const c of block.calcs) {
    const refs = refsIn(c.args);
    if (!refs.includes(setting)) continue;
    if (s?.kind === 'limit') {
      if (c.template === 'F2') return undefined;
      if (refsIn((c.args as { rsdLimit?: unknown }).rsdLimit).includes(setting)) return 'fraction';
      const r = resultKind(c, settings);
      if (r !== null) return r;
    }
    for (const r of refs) {
      if (r === setting || block.settings.find((x) => x.name === r)?.kind === 'limit') continue;
      const k = kindOf(block, r, settings, new Set(seen));
      if (k) return k;
    }
  }
  return undefined;
}

const what = (k: Kind) => (k === 'number' ? 'a plain number' : k === 'fraction' ? 'a percentage' : `${/^[aeiou]/i.test(k) ? 'an' : 'a'} ${k}`);

/** LIMS-01: a limit, or a C1 target typed with its unit, in a unit of another kind than the value it is checked against. */
export function unitKindProblem(block: Block, name: string, settings: Step['settings'], unit: string): string | null {
  const s = block.settings.find((x) => x.name === name);
  const target = block.calcs.some((c) => c.template === 'C1' && refsIn((c.args as { around?: { centre?: unknown } }).around?.centre).includes(name));
  if (!s || (s.kind !== 'limit' && !target)) return null;
  const need = neededKind(block, name, settings);
  const u = findUnit(unit);
  if (!need || !u || u.kind === need || (need === 'temperature difference' && u.kind === 'temperature')) return null;
  return `${s.label}: ${unit || 'no unit'} is ${what(u.kind)}, but the value checked is ${what(need)}. Choose a unit of that kind (in ${unit || 'no unit'} every reading would be refused at analysis time)`;
}
