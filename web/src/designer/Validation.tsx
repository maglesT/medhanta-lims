// Method validation (plan 2.12; LIMS-02, LIMS-04): the validation, verification and transfer reports, a new report
// (its conclusion read from reviewed worksheet analyses, nothing typed but the protocol number), and one report with
// QC's review and QA's approval. A method version becomes effective only with an approved report (masters.ts).
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, plantTime, type Me } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';

export interface MethodUse { versionId: number; masterId: number; versionNo: number; state: string; code: string; name: string; origin: string; use: string; status: string; needs: string | null; reportNo: string | null }
interface ReportRow { id: number; reportNo: string; kind: string; outside: boolean; code: string; name: string; methodVersionNo: number; reference: string; conclusion: string; status: string; personName: string; at: string }
interface Finding { characteristic: string; analysisNo: string; step: string; shown: string; met: boolean }
interface Conclusion { characteristics: { characteristic: string; met: boolean; findings: Finding[] }[]; missing: string[]; met: boolean; why: string }
interface Report extends Omit<ReportRow, 'status'> {
  status: string; testType: string; sendingLab: string | null; receivingLab: string | null; remarks: string; outputs: Conclusion; contentHash: string;
  events: { id: number; kind: string; personName: string; at: string }[]; refusals: { review: string | null; approve: string | null };
}
interface Worksheet { id: number; analysisNo: string; code: string; name: string; issuedAt: string }

export const listMethodReports = () => api<{ reports: ReportRow[]; methods: MethodUse[] }>('GET', '/api/method-reports');
const KINDS = ['validation', 'verification', 'transfer'] as const;
const TEST_TYPES = ['assay', 'impurity (quantitative)', 'impurity (limit test)', 'identity', 'other (as the protocol says)'];
const STATUS_CHIP: Record<string, string> = { 'to review': 'chip chip-info', 'to approve': 'chip chip-warn', approved: 'chip chip-ok' };
const metChip = (met: boolean | string) => (met === true || met === 'met' ? <span className="chip chip-ok">met</span> : <span className="chip chip-bad">not met</span>);

export function Validation({ me, onBack }: { me: Me; onBack: () => void }) {
  const [data, setData] = useState<{ reports: ReportRow[]; methods: MethodUse[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const load = async () => setData(await listMethodReports());
  useEffect(() => { void load(); }, []);
  if (open !== null) return <ReportScreen me={me} id={open} onBack={() => { setOpen(null); void load(); }} />;
  return (
    <>
      <div className="home-head">
        <div>
          <h1>Method validation</h1>
          <p className="greeting">A method is used for routine work once validated (in-house), verified (pharmacopoeial) or transferred, by a report QC reviews and QA approves.</p>
        </div>
        <span className="actions-cell">
          <button onClick={onBack}>Back to the methods</button>
          {can(me, 'master.author') && <button className="primary" onClick={() => setCreating(true)} disabled={!data}>New report</button>}
        </span>
      </div>
      {data === null ? <div className="skel skel-block" /> : !data.reports.length ? <div className="card placeholder"><p>No reports yet.</p></div> : (
        <div className="table-wrap">
          <table className="masters">
            <thead><tr><th>Report</th><th>Method</th><th>Kind</th><th>Protocol or paper report</th><th>Conclusion</th><th>Status</th><th>Prepared by</th></tr></thead>
            <tbody>
              {data.reports.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpen(r.id)}>
                  <td><b>{r.reportNo}</b></td>
                  <td>{r.code}<span className="cell-sub">{r.name} · version {r.methodVersionNo}</span></td>
                  <td>{r.kind}{r.outside ? ' (outside LIMS)' : ''}</td>
                  <td>{r.reference}</td>
                  <td>{metChip(r.conclusion)}</td>
                  <td><span className={STATUS_CHIP[r.status]}>{r.status}</span></td>
                  <td>{r.personName}<span className="cell-sub">{plantTime(r.at)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && data && <NewReport methods={data.methods} onCancel={() => setCreating(false)} onDone={(id) => { setCreating(false); setOpen(id); }} />}
    </>
  );
}

function NewReport({ methods, onCancel, onDone }: { methods: MethodUse[]; onCancel: () => void; onDone: (id: number) => void }) {
  const usable = methods.filter((m) => m.use === 'routine' && ['approved', 'effective'].includes(m.state));
  const [kind, setKind] = useState<(typeof KINDS)[number]>('validation');
  const [outside, setOutside] = useState(false);
  const [versionId, setVersionId] = useState(usable[0]?.versionId ?? 0);
  const [testType, setTestType] = useState(TEST_TYPES[0]!);
  const [reference, setReference] = useState('');
  const [sendingLab, setSendingLab] = useState('');
  const [receivingLab, setReceivingLab] = useState('');
  const [remarks, setRemarks] = useState('');
  const [sheets, setSheets] = useState<Worksheet[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [preview, setPreview] = useState<{ conclusion: Conclusion; contentHash: string } | null>(null);
  const [sign, setSign] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void api<Worksheet[]>('GET', '/api/method-reports/analyses').then(setSheets); }, []);
  const method = usable.find((m) => m.versionId === versionId);
  // The kind follows the method's origin (LIMS-02, LIMS-04).
  useEffect(() => { if (method) setKind(method.origin === 'pharmacopoeial' ? 'verification' : method.origin === 'transferred' ? 'transfer' : 'validation'); }, [versionId]);
  const draft = { kind, methodVersionId: versionId, testType, analysisIds: outside ? [] : picked };
  useEffect(() => { setPreview(null); }, [kind, versionId, testType, outside, picked.join(',')]);
  const check = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!reference.trim()) return setError(outside ? 'Give the paper report\'s number.' : 'Give the protocol\'s number.');
    if (kind === 'transfer' && (!sendingLab.trim() || !receivingLab.trim())) return setError('Name the sending and the receiving laboratory.');
    if (outside) return setSign(true);
    if (!picked.length) return setError('Choose the reviewed worksheet analyses the report covers.');
    try { setPreview(await api('POST', '/api/method-reports/preview', draft)); } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };
  if (sign) {
    return (
      <SignDialog meaning="prepared" what={`Sign the ${kind} report of ${method?.code ?? ''} version ${method?.versionNo ?? ''}`} onCancel={() => setSign(false)}
        onSign={async ({ proof }) => {
          const r = await api<{ id: number }>('POST', '/api/method-reports', { ...draft, outside, reference, remarks, proof, ...(preview ? { contentHash: preview.contentHash } : {}),
            ...(kind === 'transfer' ? { sendingLab, receivingLab } : {}) });
          onDone(r.id);
        }}>
        <div className="summary-box">
          <p>{outside ? `${kind} outside LIMS, paper report ${reference}` : `Protocol ${reference}: ${preview?.conclusion.met ? 'met' : 'NOT met'}`}</p>
          {preview && <p className="small">{preview.conclusion.why}</p>}
        </div>
      </SignDialog>
    );
  }
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="New report">
      <form className="card dialog wide" onSubmit={check}>
        <h2>New validation report</h2>
        <div className="form-grid">
          <label>Method version
            <select aria-label="Method version" value={versionId} onChange={(e) => setVersionId(Number(e.target.value))}>
              {usable.map((m) => <option key={m.versionId} value={m.versionId}>{m.code} {m.name} · version {m.versionNo} ({m.origin}; {m.status})</option>)}
            </select>
          </label>
          <label>Kind
            <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label>Type of test (ICH Q2 Table 1)
            <select aria-label="Type of test" value={testType} onChange={(e) => setTestType(e.target.value)}>
              {TEST_TYPES.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label>{outside ? 'Paper report number' : 'Protocol number'}<input aria-label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={outside ? 'e.g. QC/VAL/2019/044' : 'e.g. VP-2026-011'} /></label>
          {kind === 'transfer' && <>
            <label>Sending laboratory<input aria-label="Sending laboratory" value={sendingLab} onChange={(e) => setSendingLab(e.target.value)} /></label>
            <label>Receiving laboratory<input aria-label="Receiving laboratory" value={receivingLab} onChange={(e) => setReceivingLab(e.target.value)} /></label>
          </>}
          <label>Remarks<input aria-label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} />
          <span>Validated outside LIMS (a paper report from before LIMS; QA approves it as a second person)</span></label>
        {!outside && (
          <fieldset className="checklist">
            <legend>Reviewed worksheet analyses</legend>
            {sheets === null ? <div className="skel" /> : !sheets.length ? <p className="muted small">No reviewed analysis of a validation worksheet yet.</p>
              : sheets.map((s) => (
                <label key={s.id} className="check"><input type="checkbox" checked={picked.includes(s.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
                  <span>{s.analysisNo} · {s.code} {s.name}<small>{plantTime(s.issuedAt)}</small></span></label>
              ))}
          </fieldset>
        )}
        {preview && <ConclusionTable c={preview.conclusion} />}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          {preview ? <button className="primary" type="button" onClick={() => setSign(true)}>Sign as prepared</button>
            : <button className="primary" type="submit">{outside ? 'Sign as prepared' : 'Work out the conclusion'}</button>}
        </div>
      </form>
    </div>
  );
}

function ConclusionTable({ c }: { c: Conclusion }) {
  return (
    <div className="card">
      <p><b>Conclusion: {c.met ? 'met' : 'NOT met'}</b> <span className="muted small">{c.why}</span></p>
      {c.characteristics.length > 0 && (
        <table className="masters">
          <thead><tr><th>Characteristic</th><th /><th>Result</th></tr></thead>
          <tbody>
            {c.characteristics.flatMap((x) => x.findings.map((f, i) => (
              <tr key={`${x.characteristic}-${i}`}>
                <td>{i === 0 ? x.characteristic : ''}</td>
                <td>{metChip(f.met)}</td>
                <td className="small">{f.analysisNo} · {f.step}: {f.shown}</td>
              </tr>
            )))}
          </tbody>
        </table>
      )}
      {c.missing.length > 0 && <p className="notice">Missing: {c.missing.join(', ')}</p>}
    </div>
  );
}

function ReportScreen({ me, id, onBack }: { me: Me; id: number; onBack: () => void }) {
  const [r, setR] = useState<Report | null>(null);
  const [sign, setSign] = useState<'review' | 'approve' | null>(null);
  const load = async () => setR(await api<Report>('GET', `/api/method-reports/${id}`));
  useEffect(() => { void load(); }, [id]);
  if (!r) return <div className="skel skel-block" />;
  const action = (a: 'review' | 'approve', label: string, perm: string) => can(me, perm) && (
    <span>
      <button className="primary" disabled={r.refusals[a] !== null} onClick={() => setSign(a)}>{label}</button>
      {r.refusals[a] && <span className="muted small"> {r.refusals[a]}</span>}
    </span>
  );
  return (
    <>
      <div className="home-head">
        <div>
          <h1>{r.reportNo} · {r.kind} of {r.code} version {r.methodVersionNo}</h1>
          <p className="greeting">{r.name} · <span className={STATUS_CHIP[r.status]}>{r.status}</span> · conclusion {metChip(r.conclusion)}</p>
        </div>
        <button onClick={onBack}>Back to the reports</button>
      </div>
      <div className="card">
        <p>{r.outside ? 'Validated outside LIMS: paper report' : 'Protocol'} <b>{r.reference}</b> · type of test {r.testType}</p>
        {r.sendingLab && <p>Transfer from <b>{r.sendingLab}</b> to <b>{r.receivingLab}</b></p>}
        {r.remarks && <p className="small">{r.remarks}</p>}
        <p className="small muted">Prepared by {r.personName}, {plantTime(r.at)}{r.events.map((e) => `; ${e.kind} by ${e.personName}, ${plantTime(e.at)}`).join('')}</p>
      </div>
      {!r.outside && <ConclusionTable c={r.outputs} />}
      {r.status !== 'approved' && (
        <div className="actions">
          {!r.outside && action('review', 'Review (QC)', 'analysis.review')}
          {action('approve', 'Approve (QA)', 'master.approve')}
        </div>
      )}
      {sign && (
        <SignDialog meaning={sign === 'review' ? 'reviewed' : 'approved'} what={`${sign === 'review' ? 'Review' : 'Approve'} ${r.reportNo}`} onCancel={() => setSign(null)}
          onSign={async ({ proof }) => { await api('POST', `/api/method-reports/${id}/${sign}`, { proof, contentHash: r.contentHash }); setSign(null); await load(); }}>
          <div className="summary-box"><p>{r.kind} of {r.code} version {r.methodVersionNo}: {r.conclusion}</p><p className="small">{r.outputs.why}</p></div>
        </SignDialog>
      )}
    </>
  );
}
