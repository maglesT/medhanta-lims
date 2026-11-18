/**
 * Instrument data capture (LIMS-32, LIMS-33, LIMS-49, LIMS-50): what the server does with a reading or a CDS file
 * before it is stored. Pure: the route reads the step, this decides.
 */
import type { BlockField } from '../blocks/format.js';
import type { SettingValue } from '../master/schema.js';
import type { Captured, Imported, Source } from '../engine/links.js';
import { inUnit, isProtocol, MAX_AGE_MINUTES, MAX_LINE, MAX_LINES, parseReading, PROTOCOLS, protocolsFor, serialKind, type CaptureRaw } from './serial.js';
import { CDS_FORMATS, type CdsFile } from './cds.js';

export * from './serial.js';
export * from './cds.js';
export * from './cds-fill.js';

/**
 * Whether a field is read from an instrument or the CDS on this step: an assay that reads absorbances (UV) is not a
 * chromatography run, so its responses are typed as before.
 */
export function captures(f: BlockField, settings: Record<string, SettingValue | undefined>): boolean {
  if (!f.capture) return false;
  return !(f.capture === 'cds' && settings.response === 'absorbance');
}

/** The hand source of a capture field typed instead of read (LIMS-32): the step then needs a second person. */
export const typedSource = (f: BlockField): Source => ({ from: 'hand', link: f.capture === 'cds' ? 'cds' : 'instrument', state: 'absent' });

export type CaptureOutcome = { ok: true; value: string; unit: string; temperature?: string; source: Source } | { ok: false; why: string };
/**
 * A value read from the step's machine (LIMS-32, LIMS-50): the machine named is the one recorded on the step, the
 * protocol is one of the field's kind, the lines are re-parsed here (the browser's number is never taken), the reading is
 * in the step's unit (exactly converted, or refused) and was read in the last few minutes.
 */
export function readCapture(f: BlockField, raw: unknown, machine: { label: string; code: string | null }, unit: string, now: Date): CaptureOutcome {
  const no = (why: string): CaptureOutcome => ({ ok: false, why: `${f.label}: ${why}` });
  const kind = serialKind(f.capture);
  if (!kind) return no('this value is not read from an instrument.');
  const c = raw as Partial<CaptureRaw> | null;
  if (!c || typeof c !== 'object' || typeof c.instrument !== 'string' || !Array.isArray(c.raw) || typeof c.readAt !== 'string') return no('the reading is incomplete: read it again.');
  if (!isProtocol(c.protocol) || PROTOCOLS[c.protocol].kind !== kind) return no(`"${String(c.protocol)}" is not a protocol of this instrument; pick one of ${protocolsFor(kind).map((p) => PROTOCOLS[p].name).join(', ')}.`);
  if (!machine.code) return no(`record the ${machine.label.toLowerCase()} first: the reading must come from it.`);
  if (c.instrument !== machine.code) return no(`the reading came from ${c.instrument}, but the ${machine.label.toLowerCase()} of this step is ${machine.code}: read it from ${machine.code}.`);
  if (c.raw.length > MAX_LINES || c.raw.some((l) => typeof l !== 'string' || l.length > MAX_LINE)) return no('the instrument sent more than one reading: read it again.');
  const at = new Date(c.readAt);
  if (Number.isNaN(at.getTime())) return no('the time of the reading is missing: read it again.');
  if (now.getTime() - at.getTime() > MAX_AGE_MINUTES * 60_000) return no(`the reading is more than ${MAX_AGE_MINUTES} minutes old: read it again.`);
  if (at.getTime() - now.getTime() > 60_000) return no('the time of the reading is ahead of the server: check the computer\'s clock, then read again.');
  const r = parseReading(c.protocol, c.raw);
  if (!r.ok) return no(r.why);
  const value = kind === 'ph' ? r.value : inUnit(r.value, r.unit, unit);
  if (value === null) return no(`the instrument gives ${r.unit}; this step records ${unit || 'no unit'}: set the instrument to ${unit}.`);
  const capture: Captured = { instrument: c.instrument, protocol: c.protocol, raw: c.raw, readAt: at.toISOString() };
  const shown = `${c.instrument}, ${PROTOCOLS[c.protocol].name}: "${r.line.trim()}"${value !== r.value ? ` (${value} ${unit})` : ''}`;
  return { ok: true, value, unit, ...(r.temperature !== undefined ? { temperature: r.temperature } : {}), source: { from: 'instrument', asOf: capture.readAt, shown, capture } };
}

/** The source of a value imported from a CDS result file, in words for the step, the review and the PDF. */
export function importSource(i: Imported, at: Date): Source {
  const shown = `CDS run ${i.run}${i.sequence ? `, sequence ${i.sequence}` : ''}, processing method ${i.method}, injection${i.injections.length === 1 ? '' : 's'} ${i.injections.join(', ')}; `
    + `file ${i.file} (${CDS_FORMATS[i.format as keyof typeof CDS_FORMATS] ?? i.format}, ${i.size} bytes, SHA-256 ${i.hash}), import ${i.version}`;
  return { from: 'cds', asOf: at.toISOString(), shown, cds: i };
}

/** What a CDS file gives, kept with the values (LIMS-49): never the file itself. */
export const imported = (f: CdsFile, file: { name: string; size: number; hash: string }, injections: number[], version: number): Imported =>
  ({ file: file.name, size: file.size, hash: file.hash, format: f.format, run: f.run, sequence: f.sequence, method: f.method, instrument: f.instrument, injections, version });

/** The text of a CDS file from its bytes: UTF-8, or UTF-16 with its byte-order mark (Empower writes UTF-16). */
export function fileText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes);
}
// At most this large: a peak table, not a raw data file.
export const MAX_CDS_BYTES = 512 * 1024;
