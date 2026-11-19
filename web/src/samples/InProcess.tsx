// In-process requests (owner 19 Nov 2026): the open lab requests of the TrueBatch steps with in-process QC fields, every
// edition, oldest first. The analyst picks one: its in-process sample is made from it (nothing typed but the quantity
// taken), tested against the product's in-process specification for the fields the request names.
import { useEffect, useState, type FormEvent } from 'react';
import { plainError } from '../api-floor.js';
import { api } from '../api.js';
import { PROVIDER_NAME, type LinkState } from '../../../shared/engine/links.js';

export interface LabRequestRow {
  edition: string; editionName: string; requestId: string; batchNo: string; productCode: string; stageTitle: string | null; stepTitle: string | null;
  tests: { name: string; label: string; unit: string | null; individual: number | null }[]; requestedShown: string;
  spec: { id: number; number: string; versionNo: number } | null; problems: string[]; sample: { id: number; sampleNo: string } | null;
}
const listRequests = () => api<{ link: LinkState; requests: LabRequestRow[] }>('GET', '/api/lab-requests');
const makeSample = (b: { edition: string; requestId: string; quantity: string }) => api<{ id: number; sampleNo: string }>('POST', '/api/samples/in-process', b);

export function InProcessRequests({ onOpenSample }: { onOpenSample: (id: number) => void }) {
  const [data, setData] = useState<{ link: LinkState; requests: LabRequestRow[] } | null>(null);
  const [picked, setPicked] = useState<LabRequestRow | null>(null);
  const [error, setError] = useState('');
  const load = () => { listRequests().then(setData, (e) => setError(plainError(e))); };
  useEffect(load, []);
  const open = (data?.requests ?? []).filter((r) => !r.sample);
  return (
    <section className="dash-panel samples-waiting" aria-label="In-process requests">
      <div className="panel-head"><h2>In-process requests</h2><span className="pill">{open.length}</span></div>
      {error && <p className="notice" role="alert">{error}</p>}
      {data === null ? <div className="skel skel-block" /> : data.link !== 'ok' ? (
        <p className="muted">{PROVIDER_NAME.truebatch} {data.link === 'down' ? 'does not answer now' : 'is not linked'}: in-process samples are made from its requests when it answers.</p>
      ) : open.length === 0 ? <p className="muted">No open request.</p> : (
        <div className="table-wrap">
          <table className="masters" aria-label="Open in-process requests">
            <thead><tr><th>Batch</th><th>Step</th><th>Tests</th><th>Specification</th><th /></tr></thead>
            <tbody>
              {open.map((r) => (
                <tr key={`${r.edition}:${r.requestId}`}>
                  <td><b>{r.batchNo}</b><span className="cell-sub">{r.productCode} · {r.editionName}</span></td>
                  <td>{[r.stageTitle, r.stepTitle].filter(Boolean).join(' › ')}<span className="cell-sub">requested {r.requestedShown}</span></td>
                  <td>{r.tests.map((t) => <span key={t.name} className="cell-line">{t.label}{t.individual ? ` (${t.individual} units)` : ''}</span>)}</td>
                  <td>{r.spec ? `${r.spec.number}, version ${r.spec.versionNo}` : '—'}{r.problems.map((p) => <span key={p} className="chip chip-warn">{p}</span>)}</td>
                  <td><button className="primary" disabled={r.problems.length > 0} onClick={() => setPicked(r)} aria-label={`Take the sample of ${r.requestId}`}>Take the sample</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {picked && <TakeDialog r={picked} onCancel={() => setPicked(null)} onDone={(id) => { setPicked(null); load(); onOpenSample(id); }} />}
    </section>
  );
}

function TakeDialog({ r, onCancel, onDone }: { r: LabRequestRow; onCancel: () => void; onDone: (id: number) => void }) {
  const [quantity, setQuantity] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { onDone((await makeSample({ edition: r.edition, requestId: r.requestId, quantity: quantity.trim() })).id); } catch (err) { setError(plainError(err)); setBusy(false); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Take the in-process sample">
      <form className="card dialog" onSubmit={send}>
        <h2>In-process sample of {r.batchNo}</h2>
        <p>{r.editionName}: {[r.stageTitle, r.stepTitle].filter(Boolean).join(' › ')}, request {r.requestId}.</p>
        <p className="muted">Tested against {r.spec?.number}, version {r.spec?.versionNo}, for: {r.tests.map((t) => t.label).join(', ')}.</p>
        <label>Quantity taken<input aria-label="Quantity taken" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 10 unit doses, 100 mL" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit" disabled={busy || !quantity.trim()}>Make the sample</button></div>
      </form>
    </div>
  );
}
