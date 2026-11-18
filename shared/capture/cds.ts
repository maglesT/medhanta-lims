/**
 * Chromatography result files exported from the CDS (LIMS-33, LIMS-49, LIMS-50; plan 2.8, question 3). The CDS stays
 * the raw-data record: LIMS reads the peak table of its result export with a FIXED parser per layout (Empower report
 * CSV, Chromeleon export, OpenLab CDS CSV, and the generic layout documented in docs/design.md), and keeps the file's
 * name, size, SHA-256, the CDS run id, sequence and processing method with the values it took. Pure functions.
 */

export const CDS_FORMATS = { generic: 'generic CSV layout', empower: 'Empower report CSV', chromeleon: 'Chromeleon export', openlab: 'OpenLab CDS CSV' } as const;
export type CdsFormat = keyof typeof CDS_FORMATS;

export interface CdsRow {
  injection: number; sample: string; peak: string; rt: string; area: string;
  // The CDS's own values, when the export has them (system suitability, impurities).
  tailing?: string; plates?: string; resolution?: string; sn?: string; rrt?: string;
}
export interface CdsFile { format: CdsFormat; run: string; sequence: string | null; method: string; instrument: string | null; rows: CdsRow[] }

type Col = keyof CdsRow;
// Column names of each layout (compared without case and spaces at the ends).
const COLUMNS: Record<CdsFormat, Partial<Record<Col, string[]>>> = {
  generic: { injection: ['injection'], sample: ['sample name'], peak: ['peak'], rt: ['retention time'], area: ['area'], tailing: ['tailing'], plates: ['plates'],
    resolution: ['resolution'], sn: ['signal to noise'], rrt: ['rrt'] },
  empower: { injection: ['inj'], sample: ['samplename'], peak: ['name'], rt: ['rt'], area: ['area'], tailing: ['usp tailing'], plates: ['usp plate count'],
    resolution: ['usp resolution'], sn: ['s/n'], rrt: ['rrt'] },
  chromeleon: { injection: ['inj. no.'], sample: ['injection name'], peak: ['peak name'], rt: ['ret.time'], area: ['area'], tailing: ['tailing (usp)', 'asymmetry (ep)'],
    plates: ['plates (usp)', 'plates (ep)'], resolution: ['resolution (usp)', 'resolution (ep)'], sn: ['signal/noise'], rrt: ['rel.ret.time'] },
  openlab: { injection: ['injection'], sample: ['sample name'], peak: ['compound'], rt: ['rt [min]'], area: ['area'], tailing: ['tailing'], plates: ['plates'],
    resolution: ['resolution'], sn: ['signal-to-noise'], rrt: ['rrt'] },
};
// Header lines (key, value) before the peak table: which key gives the run id, the sequence, the processing method.
const KEYS = {
  run: ['run', 'run id', 'result set id', 'sample set id', 'sequence id', 'injection set id'],
  sequence: ['sequence', 'sequence name', 'sample set name'],
  method: ['processing method', 'proc. method'],
  version: ['processing method version', 'proc. method version'],
  instrument: ['instrument', 'instrument name', 'system name'],
};

/** One line of a CSV (comma) or tab-separated file: quoted cells may hold the separator and doubled quotes. */
export function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}
const norm = (s: string) => s.trim().replace(/:$/, '').trim().toLowerCase();
const NUMBER = /^\d+(\.\d+)?$/;
const NONE = new Set(['', 'n.a.', 'n/a', 'na', '-', '---']);
// At most this many peak rows: a result export, not a whole database.
export const MAX_ROWS = 5000;

/** The CDS result file read, or why it cannot be read, in plain words. */
export function parseCds(text: string): CdsFile | { error: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header: Record<string, string> = {};
  let format: CdsFormat | undefined, sep = ',', at = -1, width = 0, map: Partial<Record<Col, number>> = {};
  for (let i = 0; i < lines.length && !format; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const g = /^#\s*([^:]+):\s*(.*)$/.exec(line);
    if (g) { header[norm(g[1]!)] = g[2]!.trim(); continue; }
    sep = line.includes('\t') ? '\t' : ',';
    const c = cells(line, sep).map(norm);
    for (const f of Object.keys(COLUMNS) as CdsFormat[]) {
      const cols = COLUMNS[f];
      const idx = (k: Col) => c.findIndex((x) => cols[k]?.includes(x));
      if ((['injection', 'sample', 'peak', 'rt', 'area'] as Col[]).every((k) => idx(k) >= 0)) {
        format = f; at = i; width = c.length;
        map = Object.fromEntries((Object.keys(cols) as Col[]).map((k) => [k, idx(k)]).filter(([, n]) => (n as number) >= 0));
        break;
      }
    }
    if (!format && c.length >= 2 && c[0]) header[c[0]] = cells(line, sep)[1] ?? '';
  }
  if (!format) return { error: `This file is not a CDS result export LIMS reads (${Object.values(CDS_FORMATS).join(', ')}): export the peak table with the injection, sample name, peak, retention time and area.` };
  const key = (k: keyof typeof KEYS) => KEYS[k].map((x) => header[x]).find((v) => v !== undefined && v.trim() !== '')?.trim();
  const run = key('run');
  if (!run) return { error: 'The file does not give the CDS run (result set or sequence) id: export it with the run id, so the result links back to the CDS raw data.' };
  const method = key('method');
  if (!method) return { error: 'The file does not name its processing method: export it with the processing method (and its version).' };
  const version = key('version');
  const rows: CdsRow[] = [];
  const problems: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    const c = cells(lines[i]!, sep);
    // More cells than the header: a number written with a thousands separator, or a shifted line. Never guessed.
    if (c.length > width && c.slice(width).some((x) => x !== '')) { problems.push(`Line ${i + 1} has more cells than the header (a number with a thousands separator?).`); continue; }
    const get = (k: Col) => (map[k] === undefined ? undefined : c[map[k]!] ?? '');
    const inj = get('injection')!;
    // A units line under the header (Chromeleon: "min", "mAU*min"), or a summary line: no injection number.
    if (!/^\d+$/.test(inj)) {
      if (NUMBER.test(get('area') ?? '') && (get('sample') ?? '') !== '') problems.push(`Line ${i + 1}: the injection "${inj}" is not a number.`);
      continue;
    }
    const sample = get('sample')!;
    const rt = get('rt')!, area = get('area')!;
    if (!sample) { problems.push(`Line ${i + 1}: no sample name.`); continue; }
    if (NONE.has(area.toLowerCase()) && NONE.has((get('peak') ?? '').toLowerCase())) continue; // an injection without peaks
    if (!NUMBER.test(area)) { problems.push(`Line ${i + 1}: the area "${area}" is not a number.`); continue; }
    if (!NUMBER.test(rt)) { problems.push(`Line ${i + 1}: the retention time "${rt}" is not a number.`); continue; }
    const row: CdsRow = { injection: Number(inj), sample, peak: get('peak') ?? '', rt, area };
    for (const k of ['tailing', 'plates', 'resolution', 'sn', 'rrt'] as const) {
      const v = get(k);
      if (v === undefined || NONE.has(v.toLowerCase())) continue;
      if (!NUMBER.test(v)) { problems.push(`Line ${i + 1}: "${v}" is not a number.`); continue; }
      row[k] = v;
    }
    rows.push(row);
  }
  if (problems.length) return { error: `The file cannot be read: ${problems.slice(0, 5).join(' ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}` };
  if (!rows.length) return { error: 'The file has no peaks.' };
  if (rows.length > MAX_ROWS) return { error: `The file has ${rows.length} peaks; LIMS reads at most ${MAX_ROWS}: export only this run.` };
  return { format, run, sequence: key('sequence') ?? null, method: version ? `${method} version ${version}` : method, instrument: key('instrument') ?? null, rows };
}
