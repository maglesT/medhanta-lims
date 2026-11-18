/**
 * Recorded values and the results of the block's calculations. Every GMP number comes from the templates library:
 * this file only picks the inputs (fields, settings, earlier steps) and calls the templates.
 */
import { Dec, findUnit, type Outcome, type Q, type ResultValue } from '../templates/index.js';
import { findBlock, type Block, type BlockField } from '../blocks/index.js';
import type { Limit, MasterDoc, SettingValue, Step } from '../master/schema.js';
import { callTemplate } from './templates.js';
import { keyId, type StepEvent, type StepKey } from './state.js';
import type { Source } from './links.js';

/** A recorded value: a number with its unit, a list of them, a text (yes/no, choice, lot, time) or a picked item (with its type, room and the room's area). */
export type Value = { value: string; unit: string } | { value: string; unit: string }[] | string
  | { itemId: string; code: string; name: string; version: number; type?: string | null; room?: string | null; area?: string | null };

/** A template's outcome as stored in the event payload: decimals as full-precision text, with the worked line. */
export type Stored = ({ ok: true; value: string; unit: string; shown: string; check?: { pass: boolean; level: string; shown: string } } & Record<string, unknown>) | { ok: false; message: string };
export const store = (o: Outcome<object>): Stored => JSON.parse(JSON.stringify(o)) as Stored;
// A result passed on as an input: its full value, written with at least 3 decimals for the worked line (only zeros
// are added, nothing is rounded); a whole count (tablets, packs) stays whole: "4920 packs", not "4920.000 packs".
const exact = (v: Dec | string, unit: string): Q => {
  const d = new Dec(v);
  return { value: d.toFixed(findUnit(unit)?.kind === 'count' && d.isInteger() ? 0 : Math.max(d.decimalPlaces(), 3)), unit };
};
const asQ = (r: Stored): Q | undefined => (r.ok ? exact(r.value, r.unit) : undefined);

/** The checks inside a result that failed (check, rsdCheck, unaccountedCheck ...). */
export function failed(r: Stored | undefined): boolean {
  if (!r?.ok) return false;
  return Object.entries(r).some(([k, v]) => /check$/i.test(k) && (v as { pass?: boolean } | null)?.pass === false);
}

export interface Current {
  values: Record<string, Value>;
  results: Record<string, Stored>;
  // Corrections replace a value; the original stays in the record.
  replaced: { field: string; was: Value; now: Value; reason: string; person: number | null; at: Date }[];
  // The events of other steps (or rounds) the current results were worked out from.
  uses: number[];
  // Where each current value came from, when a link gives it (links.ts).
  source: Record<string, Source>;
}

/**
 * The current values of one step instance: later values and corrections replace earlier ones, which are kept. A
 * "done" that carries results (signing again after an input changed) replaces the results.
 */
export function currentValues(events: readonly StepEvent[]): Current {
  const c: Current = { values: {}, results: {}, replaced: [], uses: [], source: {} };
  for (const e of events) {
    if (e.kind !== 'value' && e.kind !== 'corrected' && !e.payload.results) continue;
    for (const [k, v] of Object.entries(e.payload.values ?? {})) {
      const was = c.values[k];
      if (e.kind === 'corrected' && was !== undefined) c.replaced.push({ field: k, was, now: v, reason: e.payload.reason ?? '', person: e.person, at: e.at });
      c.values[k] = v;
      // A value typed again replaces where it came from too.
      if (e.payload.source?.[k]) c.source[k] = e.payload.source[k]; else delete c.source[k];
    }
    if (e.payload.results) { c.results = e.payload.results; c.uses = e.payload.uses ?? []; }
  }
  return c;
}

/**
 * GMP: a result must not silently keep a value that was changed after it was used. Returns the events that changed
 * one of the used steps since (a correction, or results worked out again); empty when the inputs are as used.
 */
export function inputChanges<E extends StepEvent>(events: readonly E[], uses: readonly number[]): E[] {
  return [...new Set(uses)].flatMap((u) => {
    const src = events.find((e) => e.id === u);
    return src ? events.filter((e) => e.id > u && e.payload.results && keyId(e) === keyId(src)) : [];
  });
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
/** Reads a typed value for a field (machine, room and timer values are the server's). */
export function readValue(f: BlockField, raw: unknown, unit: string): Value | { error: string } {
  const bad = (why: string) => ({ error: `${f.label}: ${why}` });
  if (f.kind === 'number') {
    const one = (x: unknown) => (typeof x === 'string' && NUMBER.test(x.trim()) ? { value: x.trim(), unit } : null);
    if (f.count === undefined) return one(raw) ?? bad('type a number, e.g. "50.300"');
    // With minCount (replicate injections: 5 or 6), blank readings are left out and minCount to count are taken.
    const given = f.minCount && Array.isArray(raw) ? raw.filter((x) => !(typeof x === 'string' && !x.trim())) : raw;
    if (!Array.isArray(given) || given.length > f.count || given.length < (f.minCount ?? f.count)) {
      return bad(f.minCount ? `give ${f.minCount} to ${f.count} readings` : `give exactly ${f.count} readings`);
    }
    const list = given.map(one);
    return list.every((x) => x !== null) ? (list as { value: string; unit: string }[]) : bad('every reading must be a number');
  }
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) return bad('missing');
  const t = raw.trim();
  if (f.kind === 'yes-no' && t !== 'yes' && t !== 'no') return bad('answer yes or no');
  if (f.kind === 'choice' && !f.options?.includes(t)) return bad(`choose one of ${f.options?.join(', ')}`);
  if (f.kind === 'lot' && t.length > 60) return bad('a lot number has at most 60 characters');
  return t;
}

const MISSING = Symbol('missing');
// An optional "$name?" that is not set, or an object of a list holding one ({ name: 'binder 2', quantity: '$binder2?' }).
const unset = (x: unknown, inputs: Record<string, unknown>): boolean => (typeof x === 'string' ? x.startsWith('$') && x.endsWith('?') && inputs[x.slice(1, -1)] === undefined
  : !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).some((v) => typeof v === 'string' && unset(v, inputs)));
/**
 * Replaces each "$name" by its input; MISSING when one is not there yet (the calculation then waits). "$name?" is an
 * optional setting or field: left out when not set. "$prev.name" is the same field or calculation in the previous round.
 */
function resolve(x: unknown, inputs: Record<string, unknown>): unknown {
  if (typeof x === 'string' && x.endsWith('?') && x.startsWith('$')) return inputs[x.slice(1, -1)];
  if (typeof x === 'string' && x.startsWith('$')) return x.slice(1) in inputs ? inputs[x.slice(1)] : MISSING;
  if (Array.isArray(x)) {
    const a = x.map((y) => resolve(y, inputs));
    // An optional entry that is not set is left out of the list (e.g. the second stage of a staged test, a second binder).
    return a.includes(MISSING) ? MISSING : a.filter((_, i) => !unset(x[i], inputs));
  }
  if (x && typeof x === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) { const r = resolve(v, inputs); if (r === MISSING) return MISSING; o[k] = r; }
    return o;
  }
  return x;
}

/**
 * The latest round of a step that has values, in the copy `sub` (or the given round). The id of its latest event
 * with values or results goes into `uses`.
 */
function latestValues(events: readonly StepEvent[], stage: number, sub: number, step: number, uses: number[], round?: number): Current {
  const mine = events.filter((e) => e.stage === stage && e.sub === sub && e.step === step);
  const last = round ?? Math.max(0, ...mine.filter((e) => e.kind === 'value' || e.kind === 'corrected').map((e) => e.round));
  const these = mine.filter((e) => e.round === last);
  const used = these.filter((e) => e.payload.values || e.payload.results).at(-1);
  if (used) uses.push(used.id);
  return currentValues(these);
}

/** An earlier step's field or calculation, "stage/step/name". In the same replicate stage: the same copy. */
function refValue(doc: MasterDoc, events: readonly StepEvent[], here: StepKey, ref: string, uses: number[]): unknown {
  const [sk, tk, name] = ref.split('/') as [string, string, string];
  const si = doc.stages.findIndex((s) => s.key === sk);
  const ti = doc.stages[si]?.steps.findIndex((t) => t.key === tk) ?? -1;
  if (ti < 0) return undefined;
  const c = latestValues(events, si, si === here.stage ? here.sub : 1, ti, uses);
  return name in c.values ? c.values[name] : c.results[name] ? asQ(c.results[name]) : undefined;
}

/**
 * The results of a step's calculations for its current values: the block's calculations in order. A calculation whose
 * inputs are not all there yet is left out until they are. The ids of the other steps' events used go into `uses`.
 */
export function evaluate(doc: MasterDoc, events: readonly StepEvent[], key: StepKey, values: Record<string, Value>, uses: number[] = []): Record<string, Stored> {
  const step = doc.stages[key.stage]?.steps[key.step];
  const block = step && findBlock(step.block);
  if (!step || !block) return {};
  const results: Record<string, Stored> = {};
  const inputs: Record<string, unknown> = { ...values };
  // C1 takes earlier results as results, and shows them at display precision.
  const asResults: Record<string, ResultValue> = {};
  if (key.round > 1 && JSON.stringify(block.calcs).includes('"$prev.')) {
    const p = latestValues(events, key.stage, key.sub, key.step, uses, key.round - 1);
    for (const [k, v] of Object.entries(p.values)) inputs[`prev.${k}`] = v;
    for (const [k, r] of Object.entries(p.results)) if (r.ok) inputs[`prev.${k}`] = asQ(r);
  }
  // A field's values in the earlier rounds of this step.
  const calcs = JSON.stringify(block.calcs);
  for (const name of new Set([...calcs.matchAll(/"\$earlier\.([a-zA-Z0-9]+)/g)].map((m) => m[1]!))) {
    const seen: string[] = [];
    for (let r = 1; r < key.round; r++) { const v = latestValues(events, key.stage, key.sub, key.step, uses, r).values[name]; if (typeof v === 'string') seen.push(v); }
    inputs[`earlier.${name}`] = seen.join('\n');
  }
  for (const s of block.settings) {
    const v: SettingValue | undefined = step.settings[s.name];
    if (v === undefined) continue;
    if (typeof v === 'string' || 'unit' in v) { inputs[s.name] = v; continue; }
    if ('ref' in v) { const r = refValue(doc, events, key, v.ref, uses); if (r !== undefined) inputs[s.name] = r; continue; }
    // { spec: name } is replaced by the spec's value before an analysis runs (applySpec); left alone (a method on its
    // own, in the designer's preview) it is not there yet, and the calculations that need it wait.
  }
  for (const c of block.calcs) {
    // A limit check of an optional value that was not given, or against an optional limit the master did not set,
    // checks nothing: it is left out, as "$name?" promises.
    const c1 = c.args as { value?: unknown; limit?: unknown };
    if (c.template === 'C1' && (unset(c1.value, { ...inputs, ...asResults }) || unset(c1.limit, { ...inputs, ...asResults }))) continue;
    const args = resolve(c.args, c.template === 'C1' ? { ...inputs, ...asResults } : inputs);
    if (args === MISSING) continue;
    const skip = c.template === 'T13' && events.some((e) => e.kind === 'demo_wait_skipped' && e.payload.timer === durationId(key, c.name));
    const r = store(callTemplate(c.template, skip ? lowMet(args as { limit?: Limit }) : args));
    if (skip && r.ok) {
      r.shown += DEMO_SKIPPED;
      if (r.check) r.check.shown += DEMO_SKIPPED;
    }
    results[c.name] = r;
    const q = asQ(r);
    if (q) inputs[c.name] = q;
    if (r.ok) asResults[c.name] = { ok: true, value: new Dec(r.value), unit: r.unit };
  }
  return results;
}

/** Demo only: the timer id of a block's minimum duration (a mixing time) in one step instance (analysis.ts timers). */
export const durationId = (k: StepKey, calc: string) => `dur:${keyId(k)}:${calc}`;
const DEMO_SKIPPED = ' · DEMO: wait skipped';
// The limit without its lower bound: the wait was skipped, the upper limit still applies.
const lowMet = (a: { limit?: Limit }) => {
  const { low: _low, lowStrict: _strict, alertLow: _alert, ...rest } = a.limit ?? { unit: '' };
  return { ...a, limit: rest.high === undefined ? undefined : rest };
};

/**
 * The minimum durations of a step: the block's T13 durations from a start timer field to an end timer field (the
 * mixing times) whose limit, as the master sets it, has a lower bound.
 */
export function durations(block: Block | undefined, st: Step): { calc: string; label: string; start: string; end: string; limit: Limit & { low: string } }[] {
  const timer = (x: unknown) => block?.fields.find((f) => f.kind === 'timer' && x === `$${f.name}`)?.name;
  return (block?.calcs ?? []).flatMap((c) => {
    const a = c.args;
    const limit = typeof a.limit === 'string' ? st.settings[a.limit.slice(1)] : undefined;
    const [start, end] = [timer(a.start), timer(a.end)];
    return c.template === 'T13' && a.mode === 'duration' && start && end && typeof limit === 'object' && 'low' in limit && limit.low
      ? [{ calc: c.name, label: c.label, start, end, limit: { ...limit, low: limit.low } }] : [];
  });
}
