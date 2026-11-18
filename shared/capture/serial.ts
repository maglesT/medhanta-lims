/**
 * Instrument readings over a serial port (LIMS-32, LIMS-50; plan 2.8, question 3): balances, pH meters, Karl Fischer
 * titrators and potentiometric titrators, read from the browser (Web Serial in Chrome or Edge, no install). Each
 * protocol is a FIXED parser, a pure function from the lines the instrument sent to one reading, or a refusal in plain
 * words. The browser parses to show the reading; the server parses the same raw lines again and stores only what it
 * parsed itself (it never trusts the browser's number).
 */
import { Dec } from '../templates/index.js';

/** What a number field reads from an instrument (block format `capture`). `ph-temperature` is filled with the pH reading. */
export const CAPTURE_KINDS = ['balance', 'ph', 'ph-temperature', 'kf', 'titrator', 'cds'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export type SerialKind = 'balance' | 'ph' | 'kf' | 'titrator';
/** The serial instrument kind a field reads (`ph-temperature` comes with the pH reading); `cds` is a file, not a port. */
export const serialKind = (k: CaptureKind | undefined): SerialKind | null => (k === 'ph-temperature' ? 'ph' : k === 'cds' || !k ? null : k);

export interface PortSettings { baudRate: number; dataBits: 7 | 8; parity: 'none' | 'even' | 'odd'; stopBits: 1 | 2 }
export interface Protocol {
  kind: SerialKind;
  name: string;
  port: PortSettings;
  // What the browser sends to ask for a reading; none: the analyst presses Print on the instrument.
  ask?: string;
}
const p8n1: PortSettings = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 };
export const PROTOCOLS = {
  // Mettler Toledo SICS level 0: "S" asks for the stable net weight.
  sics: { kind: 'balance', name: 'Mettler Toledo SICS', port: p8n1, ask: 'S\r\n' },
  // Sartorius SBI (xBPI print lines): ESC P prints the weight.
  sbi: { kind: 'balance', name: 'Sartorius SBI print', port: { baudRate: 9600, dataBits: 7, parity: 'odd', stopBits: 1 }, ask: '\x1bP\r\n' },
  // Ohaus: "IP" prints the weight immediately.
  ohaus: { kind: 'balance', name: 'Ohaus print', port: p8n1, ask: 'IP\r\n' },
  'balance-line': { kind: 'balance', name: 'Other balance: value and unit', port: p8n1 },
  'ph-print': { kind: 'ph', name: 'pH meter print (pH and temperature)', port: p8n1 },
  'kf-print': { kind: 'kf', name: 'Karl Fischer result print', port: p8n1 },
  'titrator-print': { kind: 'titrator', name: 'Titrator result print', port: p8n1 },
} as const satisfies Record<string, Protocol>;
export type ProtocolId = keyof typeof PROTOCOLS;
export const protocolsFor = (k: SerialKind) => (Object.keys(PROTOCOLS) as ProtocolId[]).filter((p) => PROTOCOLS[p].kind === k);
export const isProtocol = (p: unknown): p is ProtocolId => typeof p === 'string' && Object.hasOwn(PROTOCOLS, p);

/** A reading, or a refusal in plain words. `more`: no reading in the lines yet (the browser keeps reading). */
export type Reading = { ok: true; value: string; unit: string; temperature?: string; line: string } | { ok: false; why: string; more?: boolean };
// One line: a reading, a refusal, or a line that carries no reading (a header of a print, a blank line).
type Line = Reading | 'skip';

const NUM = '[+-]?\\d+(?:\\.\\d+)?';
const unitOf = (u: string) => ({ ug: 'µg', µg: 'µg', mg: 'mg', g: 'g', kg: 'kg', ml: 'mL' } as Record<string, string>)[u.toLowerCase()] ?? u;
const no = (why: string): Reading => ({ ok: false, why });
const negative = (v: string) => new Dec(v).isNegative() && !new Dec(v).isZero();
const quoted = (line: string) => `"${line.trim()}"`;

function balance(value: string, unit: string, line: string): Reading {
  const u = unitOf(unit);
  if (!['mg', 'g', 'kg'].includes(u)) return no(`The balance gives the unit "${unit}": set it to g or mg.`);
  if (negative(value)) return no(`The balance shows a negative mass (${value.replace(/^\+/, '')} ${u}): tare it again, then weigh.`);
  return { ok: true, value: value.replace(/^\+/, ''), unit: u, line };
}

const LINE: Record<ProtocolId, (line: string) => Line> = {
  // "S S      12.3456 g": stable. "S D": still moving. "S +" / "S -": over- and underload. "S I": busy. "ES/ET/EL": not understood.
  sics: (line) => {
    const t = line.trim();
    let m = new RegExp(`^S\\s+S\\s+(${NUM})\\s+(\\S+)$`).exec(t);
    if (m) return balance(m[1]!, m[2]!, line);
    if (/^S\s+D\b/.test(t)) return no('The balance is not stable yet: wait until the reading settles, then read again.');
    if (/^S\s*\+$/.test(t)) return no('The balance is overloaded: take the load off.');
    if (/^S\s*-$/.test(t)) return no('The balance is underloaded (below zero): put the pan back and tare it.');
    if (/^S\s+I$/.test(t)) return no('The balance is busy and gave no reading: read again.');
    if ((m = /^(ES|ET|EL)$/.exec(t))) return no(`The balance did not understand the request (${m[1]}): check that the protocol picked is the balance's.`);
    return no(`This is not a Mettler Toledo SICS reading: ${quoted(line)}. Check the protocol picked.`);
  },
  // "+     12.3456 g  " (or with an ID: "N     +     12.3456 g"; in a GLP print the gross G# and tare T lines are skipped).
  // No unit: not stable yet. "High" / "Low": over- and underload.
  sbi: (line) => {
    const t = line.trim();
    if (/^(high|h)$/i.test(t)) return no('The balance is overloaded: take the load off.');
    if (/^(low|l)$/i.test(t)) return no('The balance is underloaded (below zero): put the pan back and tare it.');
    if (/^err/i.test(t)) return no(`The balance reports an error (${t}).`);
    const m = new RegExp(`^(?:(N|G#?|T)\\s+)?([+-])?\\s*(\\d+(?:\\.\\d+)?)\\s*([a-zA-Zµ]+)?$`).exec(t);
    // The other lines of a GLP print (date, type, serial number, dashes) carry no reading.
    if (!m) return 'skip';
    if (m[1] && m[1] !== 'N') return 'skip';
    if (!m[4]) return no('The balance is not stable yet (no unit printed): wait until the reading settles, then read again.');
    return balance(`${m[2] === '-' ? '-' : ''}${m[3]}`, m[4], line);
  },
  // "    12.3456 g    N": "?" after the unit when not stable, N net / G gross, T a tare line.
  ohaus: (line) => {
    const t = line.trim();
    if (/^-*\s*(OL|UL|-OL-|overload|underload)\s*-*$/i.test(t)) return no(/UL|under/i.test(t) ? 'The balance is underloaded (below zero): put the pan back and tare it.' : 'The balance is overloaded: take the load off.');
    const m = new RegExp(`^(${NUM})\\s*([a-zA-Zµ]+)\\s*(\\?)?\\s*(N|G|T|NET|GROSS|TARE)?$`, 'i').exec(t);
    // The other lines of a print (header, date, ID) carry no reading.
    if (!m) return 'skip';
    if (/^t/i.test(m[4] ?? '')) return 'skip';
    if (m[3]) return no('The balance is not stable yet ("?" printed): wait until the reading settles, then read again.');
    return balance(m[1]!, m[2]!, line);
  },
  // "12.3456 g": a value and its unit, nothing else.
  'balance-line': (line) => {
    const m = new RegExp(`^\\s*(${NUM})\\s*([a-zA-Zµ]+)\\s*$`).exec(line);
    if (!m) return no(`This line is not a value and its unit: ${quoted(line)}.`);
    return balance(m[1]!, m[2]!, line);
  },
  // "pH 6.85  25.0 °C", "pH: 6.85 Temp: 25.0 C", "6.85 pH 25.0°C ATC". A print's other lines are skipped.
  'ph-print': (line) => {
    const t = line.trim();
    if (!/\bpH\b/i.test(t)) return 'skip';
    if (/unstable|not stable|drift|\?/i.test(t)) return no('The pH reading is not stable yet: wait for the end point, then print again.');
    if (/\berr|error|over|under|-{3,}|out of range/i.test(t)) return no(`The pH meter reports an error: ${quoted(line)}.`);
    const ph = new RegExp(`(?:\\bpH\\s*:?\\s*(${NUM}))|(?:(${NUM})\\s*pH\\b)`, 'i').exec(t);
    // A heading ("pH meter", "SevenCompact pH") carries no reading.
    if (!ph) return 'skip';
    const value = (ph[1] ?? ph[2])!.replace(/^\+/, '');
    if (new Dec(value).lt(0) || new Dec(value).gt(14)) return no(`The pH reading ${value} is outside 0 to 14: check the meter and its calibration.`);
    const temp = new RegExp(`(${NUM})\\s*(?:°|º|deg)?\\s*C\\b`).exec(t.replace(ph[0], ' '));
    return { ok: true, value, unit: '', ...(temp ? { temperature: temp[1]!.replace(/^\+/, '') } : {}), line };
  },
  // "Consumption 2.3456 mL" / "EP1 2.3456 mL" (volumetric), "Water 1234.5 µg" (coulometric). The content (%) is LIMS's
  // own calculation and is skipped; a drift, abort or error refuses the print.
  'kf-print': (line) => {
    const t = line.trim();
    if (/drift.*(too high|high|unstable)|abort|error|cancel|over-?titrat|no end ?point|timeout/i.test(t)) return no(`The titrator reports a problem: ${quoted(line)}. Determine again.`);
    const m = new RegExp(`^(Consumption|Volume|EP\\d?|Titre|Water found|Water|H2O)\\s*[:=]?\\s*(${NUM})\\s*(mL|ml|µg|ug|mg)\\b`, 'i').exec(t);
    if (!m) return 'skip';
    const volume = /^(consumption|volume|ep|titre)/i.test(m[1]!);
    const unit = unitOf(m[3]!);
    if (volume !== (unit === 'mL')) return no(`"${m[1]}" in ${unit} is not a Karl Fischer reading: ${quoted(line)}.`);
    if (negative(m[2]!)) return no(`The titrator gives a negative reading (${m[2]} ${unit}): determine again.`);
    return { ok: true, value: m[2]!.replace(/^\+/, ''), unit, line };
  },
  // "EQP1 12.345 mL", "VEQ 12.345 mL", "Titre 12.345 mL". No end point found, an abort or an error refuses the print.
  'titrator-print': (line) => {
    const t = line.trim();
    if (/no (eqp|equivalence point|end ?point)|abort|error|cancel|max(imum)? volume/i.test(t)) return no(`The titrator reports a problem: ${quoted(line)}. Titrate again.`);
    const m = new RegExp(`^(EQP\\d*|EP\\d*|VEQ\\d*|Titre|Consumption)\\s*[:=]?\\s*(${NUM})\\s*(mL|ml)\\b`, 'i').exec(t);
    if (!m) return 'skip';
    if (negative(m[2]!)) return no(`The titrator gives a negative titre (${m[2]} mL): titrate again.`);
    return { ok: true, value: m[2]!.replace(/^\+/, ''), unit: 'mL', line };
  },
};

/** The lines a browser may send for one reading: at most 40 lines of at most 200 characters. */
export const MAX_LINES = 40;
export const MAX_LINE = 200;
/**
 * One reading from the lines an instrument sent, by its protocol: the first refusal refuses the whole print; two
 * different readings in one print are refused (read one at a time); no reading yet is `more`.
 */
export function parseReading(protocol: ProtocolId, lines: readonly string[]): Reading {
  let found: Extract<Reading, { ok: true }> | undefined;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const r = LINE[protocol](raw);
    if (r === 'skip') continue;
    if (!r.ok) return r;
    if (found && (found.value !== r.value || found.unit !== r.unit)) return no(`The print has more than one reading (${found.value} ${found.unit} and ${r.value} ${r.unit}): print one reading at a time.`);
    found ??= r;
  }
  return found ?? { ok: false, why: 'The instrument sent no reading yet.', more: true };
}

const SHIFT: Record<string, { family: string; exp: number }> = { µg: { family: 'mass', exp: -6 }, mg: { family: 'mass', exp: -3 }, g: { family: 'mass', exp: 0 }, kg: { family: 'mass', exp: 3 }, mL: { family: 'volume', exp: 0 } };
/**
 * The reading in the step's unit, exactly (the decimal point moved, no rounding: "0.05123 g" is "51.23 mg"); null when
 * the units do not convert (mL and mg). A reading with no unit (pH) is taken as it is.
 */
export function inUnit(value: string, from: string, to: string): string | null {
  if (from === to || (from === '' && !SHIFT[to])) return value;
  const a = SHIFT[from], b = SHIFT[to];
  if (!a || !b || a.family !== b.family) return null;
  const shift = a.exp - b.exp;
  const dp = Math.max(0, (value.split('.')[1]?.length ?? 0) - shift);
  return new Dec(value).times(new Dec(10).pow(shift)).toFixed(dp);
}

/** What the browser sends with a value read from an instrument; the server checks every part of it. */
export interface CaptureRaw { instrument: string; protocol: string; raw: string[]; readAt: string }
export const isCaptureRaw = (x: unknown): x is { capture: CaptureRaw } => !!x && typeof x === 'object' && !Array.isArray(x) && 'capture' in x;
// A reading older than this when it reaches the server is not saved: read again (LIMS-44, the step's time is the server's).
export const MAX_AGE_MINUTES = 10;
