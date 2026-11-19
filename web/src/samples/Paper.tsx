// Outside lab results (LIMS-22) and blank worksheets for paper (LIMS-54) of a sample, and the reconciliation list of
// the forms not back yet (Samples tab).
import { useEffect, useState, type FormEvent } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { checkOutside, enterOutside, formEntry, formLink, issueForm, listForms, type FormRow, type ReducedBasis, type SampleDetail, type TestResult } from './api-samples.js';
import { CERTIFICATE_FIELDS } from '../../../shared/engine/reduced.js';

const base64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
export const FORM_WORDS: Record<FormRow['state'], string> = { issued: 'issued, not back yet', used: 'returned, transcribed', unused: 'returned unused', voided: 'voided' };

/** An outside lab's result as the Tests table shows it, with the second person's check. */
export function OutsideLine({ d, a, me, reload }: { d: SampleDetail; a: TestResult; me: Me; reload: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [fields, setFields] = useState(false);
  const o = a.outside!;
  return (
    <div>
      {o.certificate ? <><span className="chip chip-info">supplier's certificate</span> {o.lab}, certificate {o.reportNo}</> : <><span className="chip chip-info">outside lab</span> {o.lab}, report {o.reportNo}</>}
      {a.result && <> · <b>{a.result.value || a.result.shown}{a.result.value ? ` ${a.result.unit}` : ''}</b>{a.result.pass !== undefined && <span className={`chip ${a.result.pass ? 'chip-ok' : 'chip-bad'}`}>{a.result.pass ? 'within limits' : 'out of limits'}</span>}</>}
      <span className="cell-sub">File {o.fileName}, SHA-256 {o.sha256.slice(0, 16)}… · typed by {o.enteredBy}, {plantTime(o.enteredAt)} · {o.checkedBy ? `checked by ${o.checkedBy}, ${plantTime(o.checkedAt)}` : 'waits for a second person\'s check'}</span>
      {!o.checkedBy && !d.decision && can(me, 'analysis.review') && (
        <>{o.certificate && <label className="check small"><input type="checkbox" checked={fields} onChange={(e) => setFields(e.target.checked)} /> The certificate gives {CERTIFICATE_FIELDS}</label>}
        <button className="link dark" disabled={o.certificate && !fields} onClick={async () => { try { await checkOutside(d.sample.id, o.id, o.certificate ? fields : undefined); await reload(); } catch (e) { setError(plainError(e)); } }}>
          {o.certificate ? 'Check against the certificate' : 'Check against the report'}</button></>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

/** Enter an outside lab's result for a test of the sample: the lab, its report (file) and the result as it gives it. */
export function OutsideDialog({ d, onDone, onCancel, certificate }: { d: SampleDetail; onDone: () => void; onCancel: () => void; certificate?: ReducedBasis }) {
  // LIMS-09: from the supplier's certificate, every test but identity (always tested here); the manufacturer is the lab.
  const tests = d.spec!.tests.filter((t) => t.applies && !(d.identityContainers !== null && t.identity) && !(certificate && t.identity));
  const [test, setTest] = useState(tests[0]?.key ?? '');
  const [lab, setLab] = useState('');
  const [reportNo, setReportNo] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [conforms, setConforms] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const t = tests.find((x) => x.key === test);
  const isConforms = t?.limitType === 'conforms';
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!t || (!certificate && !lab.trim()) || !reportNo.trim() || !file) return setError(certificate ? 'Give the test, the certificate number and its scan.' : 'Give the test, the lab, the report number and the report file.');
    if (isConforms ? !conforms : !value.trim()) return setError(isConforms ? 'Say whether the report finds it conforms.' : 'Type the result as the report gives it.');
    setBusy(true);
    try {
      await enterOutside(d.sample.id, { test, ...(certificate ? { certificate: true } : { lab: lab.trim() }), reportNo: reportNo.trim(), file: { name: file.name, content: base64(new Uint8Array(await file.arrayBuffer())) },
        ...(isConforms ? { conforms: conforms === 'yes' } : { value: value.trim(), unit: unit.trim() }) });
      onDone();
    } catch (err) { setError(plainError(err)); setBusy(false); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={certificate ? 'Supplier\'s certificate result' : 'Outside lab result'}>
      <form className="card dialog" onSubmit={send}>
        <h2>{certificate ? 'Supplier\'s certificate result' : 'Outside lab result'}</h2>
        {certificate
          ? <p className="muted">The lot is tested on the certificate of {certificate.manufacturer}{certificate.manufacturerBatchNo ? `, batch ${certificate.manufacturerBatchNo}` : ''}. Type the result as the certificate gives it; a second person checks it against the scan before it counts. Identity is always tested here.</p>
          : <p className="muted">A test done by a contract lab. Type the result from its report; a second person checks it against the report before it counts. The report's file is named with its SHA-256.</p>}
        <label>Test<select aria-label="Test" value={test} onChange={(e) => setTest(e.target.value)}>{tests.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select></label>
        {certificate ? <p>Manufacturer: <b>{certificate.manufacturer}</b> <span className="muted small">(from MMS and master data)</span></p>
          : <label>Outside lab<input aria-label="Outside lab" value={lab} onChange={(e) => setLab(e.target.value)} placeholder="e.g. Demo Analytical Services, Pune" /></label>}
        <label>{certificate ? 'Certificate number' : 'Report number'}<input aria-label={certificate ? 'Certificate number' : 'Report number'} value={reportNo} onChange={(e) => setReportNo(e.target.value)} /></label>
        <label>{certificate ? 'Certificate (PDF or scan)' : 'Report (PDF or scan)'}<input aria-label={certificate ? 'Certificate file' : 'Report file'} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        {isConforms ? (
          <label>Conforms ({t?.conforms})<select aria-label="Conforms" value={conforms} onChange={(e) => setConforms(e.target.value)}><option value="">Pick…</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        ) : (<>
          <label>Result<input aria-label="Result" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></label>
          <label>Unit<input aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={t?.limit?.unit ?? ''} /></label>
        </>)}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit" disabled={busy}>Record the result</button></div>
      </form>
    </div>
  );
}

/** The blank worksheets issued for this sample (LIMS-54): issue one, print it, and record its return or void. */
export function FormsPanel({ d, me, reload }: { d: SampleDetail; me: Me; reload: () => Promise<void> }) {
  const [issuing, setIssuing] = useState(false);
  const [method, setMethod] = useState(d.methods[0]?.versionId ?? 0);
  const [reason, setReason] = useState('');
  const [back, setBack] = useState<Record<number, { action: 'used' | 'unused' | 'void'; text: string }>>({});
  const [error, setError] = useState('');
  const may = can(me, 'analysis.perform');
  const inQc = ['received', 'stored', 'handed over'].includes(d.status) && !d.decision;
  if (!d.forms.length && !(may && inQc && d.methods.length)) return null;
  const run = async (f: () => Promise<unknown>) => { try { await f(); setError(''); await reload(); } catch (e) { setError(plainError(e)); } };
  return (
    <section className="dash-panel samples-waiting" aria-label="Paper worksheets">
      <div className="panel-head"><h2>Paper worksheets</h2>{may && inQc && d.methods.length > 0 && <button onClick={() => setIssuing(true)}>Issue a blank worksheet</button>}</div>
      <p className="muted small">For work on paper (the system or a link down): each form is numbered, comes back used (transcribed into an analysis) or unused, or is voided.</p>
      {d.forms.length > 0 && (
        <table className="masters"><tbody>
          {d.forms.map((f) => (
            <tr key={f.id}>
              <td><b>{f.formNo}</b><span className="cell-sub">{f.methodCode} version {f.versionNo} · {f.issuedByName}, {plantTime(f.issuedAt)} · {f.reason}</span></td>
              <td><span className={f.state === 'issued' ? 'chip chip-warn' : 'chip chip-ok'}>{FORM_WORDS[f.state]}</span>
                {f.entry && <span className="cell-sub">{f.entry.payload.analysisNo ? `into ${f.entry.payload.analysisNo} · ` : ''}{f.entry.payload.reason ? `${f.entry.payload.reason} · ` : ''}{f.entry.personName}, {plantTime(f.entry.at)}</span>}</td>
              <td><a className="button" href={formLink(f.id)} download>Print (PDF)</a></td>
              <td>{f.state === 'issued' && may && (
                <div className="decide">
                  <select aria-label={`Return of ${f.formNo}`} value={back[f.id]?.action ?? 'used'} onChange={(e) => setBack((b) => ({ ...b, [f.id]: { action: e.target.value as 'used', text: b[f.id]?.text ?? '' } }))}>
                    <option value="used">Returned: transcribed into analysis</option><option value="unused">Returned unused</option><option value="void">Voided</option></select>
                  {(back[f.id]?.action ?? 'used') !== 'unused' && <input aria-label={`${(back[f.id]?.action ?? 'used') === 'used' ? 'Analysis number' : 'Reason'} for ${f.formNo}`} placeholder={(back[f.id]?.action ?? 'used') === 'used' ? 'Analysis number, e.g. LA2600012' : 'Reason (spoiled, lost …)'}
                    value={back[f.id]?.text ?? ''} onChange={(e) => setBack((b) => ({ ...b, [f.id]: { action: b[f.id]?.action ?? 'used', text: e.target.value } }))} />}
                  <button className="primary" onClick={() => {
                    const x = back[f.id] ?? { action: 'used', text: '' };
                    void run(() => (x.action === 'void' ? formEntry(f.id, 'void', { reason: x.text.trim() }) : formEntry(f.id, 'return', { outcome: x.action, ...(x.action === 'used' ? { analysisNo: x.text.trim() } : {}) })));
                  }}>Record</button>
                </div>)}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      {error && <p className="notice bad" role="alert">{error}</p>}
      {issuing && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Issue a blank worksheet">
          <form className="card dialog" onSubmit={(e) => { e.preventDefault(); void run(async () => { await issueForm(d.sample.id, { masterVersionId: method, reason: reason.trim() }); setIssuing(false); setReason(''); }); }}>
            <h2>Issue a blank worksheet</h2>
            <p className="muted">Sample {d.sample.sampleNo}. The form gets its own number, printed on every page.</p>
            <label>Method<select aria-label="Method" value={method} onChange={(e) => setMethod(Number(e.target.value))}>{d.methods.map((m) => <option key={m.versionId} value={m.versionId}>{m.code} {m.name}, version {m.versionNo}</option>)}</select></label>
            <label>Reason<input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. LIMS down for maintenance" /></label>
            <div className="actions"><button type="button" onClick={() => setIssuing(false)}>Cancel</button><button className="primary" type="submit" disabled={!reason.trim()}>Issue</button></div>
          </form>
        </div>
      )}
    </section>
  );
}

/** The reconciliation list: every blank worksheet not back yet. */
export function FormsNotBack({ onOpenSample }: { onOpenSample: (id: number) => void }) {
  const [rows, setRows] = useState<FormRow[] | null>(null);
  useEffect(() => { listForms(true).then(setRows, () => setRows([])); }, []);
  if (!rows?.length) return null;
  return (
    <section className="dash-panel samples-waiting" aria-label="Paper worksheets not back">
      <div className="panel-head"><h2>Paper worksheets not back</h2><span className="pill">{rows.length}</span></div>
      <table className="masters"><tbody>
        {rows.map((f) => (
          <tr key={f.id} className="clickable" onClick={() => onOpenSample(f.sampleId)}>
            <td><b>{f.formNo}</b><span className="cell-sub">{f.methodCode} version {f.versionNo}</span></td>
            <td>{f.sampleNo}</td><td>{f.issuedByName}<span className="cell-sub">{plantTime(f.issuedAt)}</span></td><td>{f.reason}</td>
          </tr>
        ))}
      </tbody></table>
    </section>
  );
}
