import { useState } from 'react';
import { plainError, plainClock, type FloorEvent } from '../api-floor.js';
import { parseReading, PROTOCOLS, protocolsFor, MAX_CDS_BYTES, type CaptureRaw, type ProtocolId, type SerialKind } from '../../../shared/capture/index.js';
import type { Source } from '../../../shared/engine/links.js';

// The browser's Web Serial API (Chrome and Edge; navigator.serial), as far as LIMS uses it.
interface SerialPortLike {
  open(o: { baudRate: number; dataBits: number; parity: string; stopBits: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
const serial = (): { requestPort(): Promise<SerialPortLike> } | undefined => (navigator as unknown as { serial?: { requestPort(): Promise<SerialPortLike> } }).serial;
export const hasSerial = () => typeof navigator !== 'undefined' && !!serial();

// How long the browser waits for a reading (the analyst may have to press Print on the instrument).
const WAIT_MS = 30_000;
const remembered = (code: string, kind: SerialKind): ProtocolId => {
  try { const p = localStorage.getItem(`lims.protocol.${code}`) as ProtocolId | null; if (p && protocolsFor(kind).includes(p)) return p; } catch { /* no storage */ }
  return protocolsFor(kind)[0]!;
};

/**
 * Reads one reading from the instrument over its serial port: opens the port the analyst picks with the protocol's
 * settings, asks for a reading (or waits for Print), and keeps the lines until the protocol's parser gives a reading
 * or refuses. The parser is the server's: the server parses the same lines again and stores only what it parsed.
 */
async function readOnce(protocol: ProtocolId): Promise<{ lines: string[]; error?: string }> {
  const s = serial();
  if (!s) return { lines: [], error: 'This browser cannot read instruments (use Chrome or Edge).' };
  const port = await s.requestPort();
  const p = PROTOCOLS[protocol];
  await port.open(p.port);
  const lines: string[] = [];
  let buffer = '';
  const reader = port.readable!.getReader();
  try {
    if ('ask' in p && p.ask) { const w = port.writable!.getWriter(); await w.write(new TextEncoder().encode(p.ask)); w.releaseLock(); }
    const decoder = new TextDecoder();
    const until = Date.now() + WAIT_MS;
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) return { lines, error: `No reading came within ${WAIT_MS / 1000} seconds: press Print on the instrument, or check its cable and settings (${p.port.baudRate} baud).` };
      const chunk = await Promise.race([reader.read(), new Promise<'late'>((r) => setTimeout(() => r('late'), left))]);
      if (chunk === 'late') continue;
      if (chunk.done) return { lines, error: 'The instrument closed the connection before a reading came.' };
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split(/\r?\n|\r/);
      buffer = parts.pop() ?? '';
      lines.push(...parts);
      const r = parseReading(protocol, lines);
      if (r.ok || !r.more) return { lines };
      if (lines.length > 40) return { lines, error: 'The instrument sent many lines but no reading: check the protocol picked.' };
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await port.close().catch(() => {});
  }
}

/**
 * "Read from the instrument" beside a number field read from the step's machine (LIMS-32): the protocol (remembered
 * per machine in this browser), then the reading as the parser sees it; the value goes to the server with its raw lines.
 */
export function ReadInstrument({ kind, label, machine, disabled, onRead }: { kind: SerialKind; label: string; machine: string | null; disabled?: boolean; onRead: (c: { capture: CaptureRaw }) => Promise<void> }) {
  const [protocol, setProtocol] = useState<ProtocolId | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'bad' | 'info'; text: string } | null>(null);
  if (!hasSerial()) return <p className="muted small">This browser cannot read instruments (Web Serial: Chrome or Edge). A typed value is marked typed and checked by a second person.</p>;
  if (!machine) return <p className="muted small">Record the {label.toLowerCase()} first: the value is then read from it.</p>;
  const chosen = protocol ?? remembered(machine, kind);
  const read = async () => {
    setBusy(true);
    setMsg(null);
    try {
      try { localStorage.setItem(`lims.protocol.${machine}`, chosen); } catch { /* no storage */ }
      const { lines, error } = await readOnce(chosen);
      const r = parseReading(chosen, lines);
      if (error && !r.ok) { setMsg({ tone: 'bad', text: error }); return; }
      if (!r.ok) { setMsg({ tone: 'bad', text: r.why }); return; }
      await onRead({ capture: { instrument: machine, protocol: chosen, raw: lines, readAt: new Date().toISOString() } });
      setMsg({ tone: 'info', text: `Read from ${machine}: ${r.value}${r.unit ? ` ${r.unit}` : ''}${r.temperature ? `, ${r.temperature} °C` : ''}` });
    } catch (e) {
      // The analyst closed the port picker: nothing was read.
      setMsg(e instanceof DOMException && e.name === 'NotFoundError' ? null : { tone: 'bad', text: plainError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="capture">
      <button type="button" className="big" disabled={disabled || busy} onClick={() => void read()}>{busy ? 'Reading…' : `Read from ${machine}`}</button>
      {protocolsFor(kind).length > 1 && (
        <label className="muted small">Protocol{' '}
          <select value={chosen} disabled={busy} onChange={(e) => setProtocol(e.target.value as ProtocolId)}>
            {protocolsFor(kind).map((p) => <option key={p} value={p}>{PROTOCOLS[p].name}</option>)}
          </select>
        </label>
      )}
      {msg && <p className={msg.tone === 'bad' ? 'field-error' : 'muted small'} role={msg.tone === 'bad' ? 'alert' : 'status'}>{msg.text}</p>}
    </div>
  );
}

const base64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/**
 * "Import the CDS result file" on a chromatography step (LIMS-33, LIMS-49, LIMS-50): the analyst picks the CDS's
 * result export; the server reads it, checks it against the run and the sample, and fills the step's peak values,
 * which cannot be typed over. An import over an earlier one needs a reason; every import stays listed.
 */
export function CdsImport({ events, names, signed, onImport }: { events: FloorEvent[]; names: (field: string) => string; signed: boolean;
  onImport: (cds: { name: string; content: string }, reason?: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A new file input after each import, so the one imported is not shown as picked.
  const [picker, setPicker] = useState(0);
  const imports = events.flatMap((e) => {
    const s = Object.entries(e.payload.source ?? {}).filter(([, x]) => (x as Source).from === 'cds') as [string, Extract<Source, { shown: string }>][];
    return s.length ? [{ e, fields: s.map(([f]) => f), cds: s[0]![1].cds!, shown: s[0]![1].shown }] : [];
  });
  const again = imports.length > 0 || signed;
  const send = async () => {
    if (!file) return;
    if (file.size > MAX_CDS_BYTES) { setError(`The file is ${Math.round(file.size / 1024)} kB; a CDS result export is at most ${MAX_CDS_BYTES / 1024} kB.`); return; }
    setBusy(true);
    setError('');
    try {
      await onImport({ name: file.name, content: base64(new Uint8Array(await file.arrayBuffer())) }, again ? reason.trim() : undefined);
      setFile(null);
      setReason('');
      setPicker((n) => n + 1);
    } catch (e) { setError(plainError(e)); } finally { setBusy(false); }
  };
  return (
    <section className="dash-panel" aria-label="CDS result file">
      <div className="panel-head"><h2>CDS result file</h2><span className="muted">the CDS stays the raw data; LIMS keeps the values, the file's hash and the run</span></div>
      {imports.length > 0 && (
        <ol className="timeline">{imports.map((x) => (
          <li key={x.e.id}><time>{plainClock(x.e.at)}</time><span><b>Import {x.cds.version}</b>: {x.cds.file} · run {x.cds.run} · {x.cds.method} · SHA-256 <code>{x.cds.hash.slice(0, 16)}…</code>
            {' '}· {x.fields.map(names).join(', ')}{x.e.payload.reason ? ` · imported again: “${x.e.payload.reason}”` : ''} · <b>{x.e.personName}</b></span></li>
        ))}</ol>
      )}
      <div className="cds-import">
        <input key={picker} type="file" aria-label="Pick the CDS result file" accept=".csv,.txt,.tsv,text/csv,text/plain" disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(''); }} />
        {again && <input className="text" aria-label="Reason for importing again" placeholder={signed ? 'Reason for the correction' : 'Reason for importing again'} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />}
        <button type="button" className="big primary" disabled={busy || !file || (again && !reason.trim())} onClick={() => void send()}>{busy ? 'Importing…' : imports.length ? 'Import again' : 'Import the CDS result file'}</button>
      </div>
      <p className="muted small">Empower report CSV, Chromeleon export, OpenLab CDS CSV, or the generic layout. Name the injections by the sample number (with -1, -2, -3 for the preparations), the standard STD and the reference solution REF.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}
