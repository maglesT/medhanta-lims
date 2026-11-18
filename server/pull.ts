import type { FastifyInstance } from 'fastify';
import type { MasterEquipment, MasterRoom } from './master.js';
import type { Block, BlockField } from '../shared/blocks/index.js';
import { CERTIFICATE, PROVIDER_NAME, clauses, type Provider, type Source, type Value } from '../shared/engine/index.js';
import { LOT_USABLE } from './links.js';
import { plantDate } from '../shared/plant-time.js';

// What a link gives a step value at write time (owner 15 Nov 2026, LIMS-12, TA-12): the value as read now, or a
// refusal in plain words; when the link is absent or down, the value is typed by hand (its questions in
// shared/engine/links.ts). Nothing read is kept but what the record keeps (PL-07).

// taken: typed fields the pull has read itself (the tablets of a part issue), not read again as typed.
export interface Pulled { source: Source; values: Record<string, Value>; sources: Record<string, Source>; problems: string[]; taken?: string[] }
const hand = (link: Provider, state: 'absent' | 'down'): Pulled => ({ source: { from: 'hand', link, state }, values: {}, sources: {}, problems: [] });
// A refusal: nothing is stored, so its source is never used.
const refused = (...problems: string[]): Pulled => ({ source: { from: 'hand', link: 'mms', state: 'absent' }, values: {}, sources: {}, problems });

/**
 * LIMS-12: a machine or room the Logbook says is fit for use, not kept for another product (after an antibiotic) and not
 * in use by another analysis. Bench clearance: its facts. `productCode`: what the Logbook compares for an item kept for
 * one product (here the method code).
 */
export async function pullItem(app: FastifyInstance, block: Block, f: BlockField, item: MasterEquipment | MasterRoom, analysisNo: string, productCode?: string): Promise<Pulled> {
  const r = await app.links.logbook.status(item.itemId);
  if (r.state !== 'ok' || r.value === 'stale') return hand('logbook', r.state === 'absent' ? 'absent' : 'down');
  const s = r.value;
  if (!s) return refused(`${item.code} is not in the Logbook, so it cannot be used.`);
  if (!s.fitForUse) return refused(`${item.code} is not fit for use (Logbook): ${clauses(s.blockers) || stateWords(s.state)}.`);
  // Owner 17 Nov 2026: after an antibiotic, only that product may follow until a product-changeover cleaning is verified in the Logbook.
  // A lab instrument kept for one product (after an antibiotic): checked against the sample's product once analyses
  // are made for samples; without a product the check is not made.
  if (s.onlyProduct && productCode && s.onlyProduct !== productCode) {
    return refused(`${item.code} was last used for an antibiotic (${s.onlyProduct}): a product-changeover cleaning is needed in the Logbook before ${productCode}.`);
  }
  if (s.inUseAnalysis && s.inUseAnalysis !== analysisNo) return refused(`${item.code} is in use by analysis ${s.inUseAnalysis} (Logbook).`);
  const source: Source = { from: 'logbook', asOf: s.checkedAt, shown: clauses([`${item.code}: ${stateWords(s.state)}`, ...s.warnings]) };
  const out: Pulled = { source, values: {}, sources: {}, problems: [] };
  // The line clearance facts the Logbook has (the room, or a packing line): clean (it is fit for use), when and by whom it was cleaned.
  if ((f.kind === 'room' || f.kind === 'machine') && block.gmp === 'line-clearance') {
    const facts: [string, string | null][] = [['clean', 'yes'], ['cleanedOn', s.cleanedAt], ['cleanedBy', s.cleanedBy]];
    for (const [name, v] of facts) if (v && block.fields.some((x) => x.name === name)) { out.values[name] = v; out.sources[name] = source; }
  }
  return out;
}

// A Logbook status in plain words (equipment_status_v1.state), never its key.
export const stateWords = (state: string) => state.replace(/_/g, ' ').replace(/\bpm\b/, 'PM');

// An MMS lot status in plain words.
const LOT_WORDS: Record<string, string> = { quarantine: 'in quarantine', quarantined: 'in quarantine', under_test: 'under test', on_hold: 'on hold' };
const plantDay = (now: Date, tz: string) => now.toLocaleDateString('en-CA', { timeZone: tz });

/** A lot MMS has, released and in date; its certificate numbers come with it. */
export async function pullLot(app: FastifyInstance, block: Block, lot: string, was: Record<string, Value>, now: Date, tz: string): Promise<Pulled> {
  const r = await app.links.mms.lot(lot);
  if (r.state !== 'ok') return hand('mms', r.state);
  const l = r.value;
  if (!l) return refused(`Lot ${lot} is not in MMS.`);
  const today = plantDay(now, tz);
  const problems: string[] = [];
  if (!LOT_USABLE.includes(l.status)) problems.push(`Lot ${lot} is ${LOT_WORDS[l.status] ?? l.status.replaceAll('_', ' ')} in MMS: only a released lot may be used.`);
  if (l.expiryDate && l.expiryDate < today) problems.push(`Lot ${lot} expired on ${plantDate(l.expiryDate)}.`);
  if (l.retestDate && l.retestDate < today) problems.push(`Lot ${lot} is past its retest date ${plantDate(l.retestDate)}.`);
  const source: Source = { from: 'mms', asOf: l.dataAsOf, shown: `MMS lot ${lot}: ${l.status}, expiry ${l.expiryDate ?? '—'}, retest ${l.retestDate ?? '—'}, QC report ${l.qcReportRef ?? '—'}` };
  const out: Pulled = { source, values: {}, sources: {}, problems };
  for (const [name, test] of Object.entries(CERTIFICATE)) {
    const f = block.fields.find((x) => x.name === name);
    if (!f) continue;
    const t = l.tests.find((x) => x.test.toLowerCase() === test);
    if (!t?.value) {
      // A value of the previous lot must not stay with this one.
      if (was[name] !== undefined) problems.push(`MMS has no ${f.label.toLowerCase()} for lot ${lot}; the step holds one of another lot: correct the lot back, or raise a deviation.`);
      continue;
    }
    if (t.unit !== '%') { problems.push(`MMS gives the ${test} of lot ${lot} in ${t.unit ?? 'no unit'}, not in %.`); continue; }
    out.values[name] = { value: t.value, unit: '%' };
    out.sources[name] = { from: 'mms', asOf: l.dataAsOf, shown: `${test} ${t.value} %${t.basis ? ` (${t.basis})` : ''}, report ${t.reportRef ?? l.qcReportRef ?? '—'}` };
  }
  return out;
}

/** The answer to a hand question: yes to every label question, a date in date for the lot. */
export function handProblem(f: BlockField, v: string, now: Date, tz: string): string | null {
  if (f.kind === 'yes-no' && v !== 'yes') return `${f.label}: if not, do not use it; use another, or raise a deviation.`;
  if (f.name.endsWith('.expiry')) {
    const d = new Date(`${v}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return `${f.label}: give a date, e.g. 2026-11-15.`;
    if (v < plantDay(now, tz)) return `The lot expired or passed its retest date on ${plantDate(v)}: it may not be used.`;
  }
  return null;
}

export const pulledWords = (s: Source) => (s.from === 'hand' ? '' : `comes from ${PROVIDER_NAME[s.from]} and cannot be typed over`);
