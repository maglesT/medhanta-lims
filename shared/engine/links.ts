/**
 * Where a recorded value came from (owner 15 Nov 2026). A link that answers gives the value (pulled, it cannot be
 * typed over); a link that is absent (not licensed, switched off) or down (switched on but not answering) leaves it
 * to people: typed by hand from the label or certificate, with a second-person check, and listed for QA.
 */
import type { BlockField } from '../blocks/format.js';

// recruitment: the people's training (training.ts), read when a person signs a step that names one. truebatch: the
// batches made, read for finished-product samples (shared/engine/sample.ts). qual: the Qualification product's
// qualification_v1, read when a machine is recorded (shared/engine/qualification.ts, LIMS-12).
export const PROVIDERS = ['deviations', 'qms', 'logbook', 'mms', 'recruitment', 'truebatch', 'qual'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type LinkState = 'absent' | 'down' | 'ok';
export const PROVIDER_NAME: Record<Provider, string> = { deviations: 'Deviations', qms: 'QMS', logbook: 'Logbook', mms: 'MMS', recruitment: 'Recruitment', truebatch: 'TrueBatch', qual: 'Qualification' };

/**
 * Pulled through a link (with what was read, PL-07), or typed by hand while the link was absent or down; or taken from
 * this product's own lab inventory (a standard's potency, a VS factor: shared/engine/items.ts), never typed.
 */
export type Source = { from: 'hand'; link: Provider; state: 'absent' | 'down' } | { from: Provider | 'inventory'; asOf: string | null; shown: string };
/** Where a pulled value came from, in words. */
export const SOURCE_NAME: Record<Provider | 'inventory', string> = { ...PROVIDER_NAME, inventory: 'the LIMS inventory' };
export const isHand = (s: Source | undefined): s is Extract<Source, { from: 'hand' }> => s?.from === 'hand';

/** The link that gives a field kind's value. */
export const LINK_OF: Partial<Record<BlockField['kind'], Provider>> = { lot: 'mms', machine: 'logbook', room: 'logbook' };
/** Certificate values that come with an MMS lot. */
export const CERTIFICATE: Record<string, string> = { assay: 'assay', water: 'water', lod: 'lod', content: 'content' };

const yes = (name: string, label: string): BlockField => ({ name, label, kind: 'yes-no' });
// The questions people answer from the status labels or the lot label when the link does not give the value.
const QUESTIONS: Partial<Record<BlockField['kind'], (f: BlockField) => BlockField[]>> = {
  machine: (f) => [
    yes(`${f.name}.clean`, `${f.label}: the status label says clean, within its clean hold`),
    yes(`${f.name}.calibrated`, `${f.label}: the calibration label is in date`),
    yes(`${f.name}.inService`, `${f.label}: not tagged out of service, maintenance in date`),
    yes(`${f.name}.qualified`, `${f.label}: qualified, status label checked (periodic review in date)`),
  ],
  room: (f) => [
    yes(`${f.name}.clean`, `${f.label}: the status label says clean, within its clean hold`),
    yes(`${f.name}.inService`, `${f.label}: not tagged out of service`),
    yes(`${f.name}.qualified`, `${f.label}: qualified (label in date)`),
  ],
  lot: (f) => [
    yes(`${f.name}.released`, `${f.label}: the label says RELEASED (approved by QC)`),
    { name: `${f.name}.expiry`, label: `${f.label}: expiry or retest date on the label, whichever is first`, kind: 'text', date: true },
    { name: `${f.name}.report`, label: `${f.label}: QC report or certificate number of the values typed`, kind: 'text', optional: true },
  ],
};

/**
 * A machine's qualification (LIMS-12) is read from Qualification, kept as the source `<field>.qualification`: while it
 * is pulled the "qualified" label question is not asked; while Qualification is absent or down it is asked, even when
 * the Logbook answers. A record from before the Qualification link asks it with the Logbook's questions.
 */
export const qualKey = (field: string) => `${field}.qualification`;
/** The questions a hand-entered machine, room or lot adds to the step. */
export function handFields(fields: readonly BlockField[], source: Record<string, Source>): BlockField[] {
  return fields.flatMap((f) => {
    const all = QUESTIONS[f.kind]?.(f) ?? [];
    if (f.kind !== 'machine') return isHand(source[f.name]) ? all : [];
    const q = source[qualKey(f.name)];
    const qualHand = q ? isHand(q) : isHand(source[f.name]);
    return all.filter((x) => (x.name === `${f.name}.qualified` ? qualHand : isHand(source[f.name])));
  });
}
/** What people saw for a recorded name: a field's label, or a label question's ("machine.clean"), whatever the link is now. */
export function fieldLabel(fields: readonly BlockField[], name: string): string {
  const f = fields.find((x) => x.name === name) ?? fields.find((x) => name.startsWith(`${x.name}.`));
  if (!f) return name;
  if (name === qualKey(f.name)) return `${f.label}: qualification`;
  return f.name === name ? f.label : QUESTIONS[f.kind]?.(f).find((q) => q.name === name)?.label ?? name;
}
/** A step with a value entered by hand needs a second-person check, whatever the master says. */
export const handEntered = (source: Record<string, Source>) => Object.values(source).some(isHand);

/**
 * Sentences of another product (a Logbook blocker: "Dirty: clean and verify before the next use.") put into one of
 * ours: each without its own closing stop, joined by "; ". The sentence that wraps them ends with one full stop.
 */
export const clauses = (parts: readonly string[]) => parts.map((p) => p.trim().replace(/[\s.;]+$/, '')).filter(Boolean).join('; ');
