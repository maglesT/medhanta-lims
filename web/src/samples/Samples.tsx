// Samples (LIMS-05, LIMS-07): the lots and batches waiting to be sampled (pulled from MMS and TrueBatch), and the
// samples registered, with their computed status. One screen per job: register (RegisterDialog), one sample
// (SampleScreen).
import { useEffect, useState } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { PROVIDER_NAME, type LinkState } from '../../../shared/engine/links.js';
import { plantText } from '../../../shared/plant-time.js';
import { PURPOSE_LABEL, STATUS_CHIP, STATUS_LABEL, listSamples, sampleRequests, type From, type Requests, type SampleListRow, type SampleRequest } from './api-samples.js';
import { RegisterDialog } from './RegisterDialog.js';
import { SampleScreen } from './SampleScreen.js';
import { ReserveList, ReserveScreen, RetestDueList } from './Reserve.js';
import { FormsNotBack } from './Paper.js';
import type { SamplePurpose } from '../../../shared/engine/sample.js';
import '../designer/designer.css';
import '../floor/floor.css';
import './samples.css';

const linkWords = (from: From, s: LinkState) => (s === 'ok' ? `${PROVIDER_NAME[from]} is linked: its ${from === 'mms' ? 'lots' : 'batches'} are listed as read now.`
  : s === 'down' ? `${PROVIDER_NAME[from]} does not answer now: register its ${from === 'mms' ? 'lots' : 'batches'} by hand; a second person checks each one.`
  : `${PROVIDER_NAME[from]} is not linked: register its ${from === 'mms' ? 'lots' : 'batches'} by hand; a second person checks each one.`);

export function Samples({ me }: { me: Me }) {
  const sampler = can(me, 'sample.register');
  const [rows, setRows] = useState<SampleListRow[] | null>(null);
  const [req, setReq] = useState<Requests | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [registering, setRegistering] = useState<SampleRequest | { hand: From } | null>(null);
  // LIMS-30, LIMS-31: a reserve sample opened; the purpose of the sample being registered (a retest from the retest-due list).
  const [reserve, setReserve] = useState<number | null>(null);
  const [purpose, setPurpose] = useState<SamplePurpose>('release');
  const [q, setQ] = useState('');
  const load = () => {
    listSamples().then(setRows, (e) => setError(plainError(e)));
    if (sampler) sampleRequests().then(setReq, (e) => setError(plainError(e)));
  };
  useEffect(load, [sampler]);

  if (reserve !== null) return <ReserveScreen id={reserve} onBack={() => { setReserve(null); load(); }} />;
  if (open !== null) return <SampleScreen me={me} id={open} onBack={() => { setOpen(null); load(); }} onOpenReserve={(r) => { setOpen(null); setReserve(r); }} />;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows ?? []).filter((r) => words.every((w) => `${r.sampleNo} ${r.item.code} ${r.item.name} ${r.lotNo} ${r.purpose} ${r.status} ${r.registeredByName}`.toLowerCase().includes(w)));
  const waiting = (req?.requests ?? []).filter((r) => !r.sampleNo);
  const sampled = (req?.requests ?? []).filter((r) => r.sampleNo);
  return (
    <>
      <div className="home-head">
        <div>
          <h1>Samples</h1>
          <p className="greeting">Each sample is tested against the specification effective when it was registered. Times are plant time (IST).</p>
        </div>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      {sampler && (
        <section className="dash-panel samples-waiting" aria-label="Waiting to be sampled">
          <div className="panel-head"><h2>Waiting to be sampled</h2><span className="pill">{waiting.length}</span></div>
          {req === null ? <div className="skel skel-block" /> : (<>
            <ul className="link-states">
              {(['mms', 'truebatch'] as const).map((f) => (
                <li key={f} className={req.links[f] === 'ok' ? 'ok' : 'off'}>
                  {linkWords(f, req.links[f])}
                  {req.links[f] !== 'ok' && <button className="link dark" onClick={() => { setPurpose('release'); setRegistering({ hand: f }); }}>Register by hand</button>}
                </li>
              ))}
            </ul>
            {waiting.length === 0 ? <p className="muted">Nothing waiting.</p> : (
              <div className="table-wrap">
                <table className="masters">
                  <thead><tr><th>Lot or batch</th><th>What</th><th>From</th><th>Specification</th><th /></tr></thead>
                  <tbody>
                    {waiting.map((r) => (
                      <tr key={`${r.source}:${r.lotNo}`}>
                        <td><b>{r.lotNo}</b><span className="cell-sub">{r.stock ?? ''}</span></td>
                        <td><b>{r.code}</b><span className="cell-sub">{r.name ?? ''}</span></td>
                        <td>{PROVIDER_NAME[r.source]}<span className="cell-sub">{plantText(r.shown)}</span></td>
                        <td>{r.specs.length ? r.specs.map((s) => <span key={s.id} className="cell-line">{s.number}, version {s.versionNo}</span>) : <span className="chip chip-warn">{r.noSpec}</span>}</td>
                        <td><button className="primary" disabled={!r.specs.length} onClick={() => { setPurpose('release'); setRegistering(r); }} aria-label={`Register ${r.lotNo}`}>Register</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sampled.length > 0 && <p className="muted small">Already sampled for release: {sampled.map((r) => `${r.lotNo} (${r.sampleNo})`).join(', ')}.</p>}
          </>)}
        </section>
      )}
      {sampler && <RetestDueList onOpenSample={setOpen} onRegister={(r) => { setPurpose('retest'); setRegistering(r); }} />}
      <h2>Samples</h2>
      <input className="search" placeholder="Search by sample, item, lot, purpose, status or person" aria-label="Search samples" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows === null ? <div className="skel skel-block" /> : !rows.length ? (
        <div className="card placeholder"><p>No samples yet.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="masters" aria-label="Samples">
            <thead><tr><th>Sample</th><th>Item</th><th>Lot or batch</th><th>Purpose</th><th>Status</th><th>Registered by</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpen(r.id)}>
                  <td><b>{r.sampleNo}</b><span className="cell-sub">{r.specNumber}, version {r.specVersionNo}</span></td>
                  <td><b>{r.item.code}</b><span className="cell-sub">{r.item.name}</span></td>
                  <td>{r.lotNo}{r.byHand && <span className="cell-sub">typed by hand</span>}</td>
                  <td>{PURPOSE_LABEL[r.purpose]}</td>
                  <td><span className={STATUS_CHIP[r.status]}>{STATUS_LABEL[r.status]}</span></td>
                  <td>{r.registeredByName}<span className="cell-sub">{plantTime(r.registeredAt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormsNotBack onOpenSample={setOpen} />
      <ReserveList onOpen={setReserve} />
      {registering && <RegisterDialog from={registering} purpose={purpose} onCancel={() => setRegistering(null)} onDone={(id) => { setRegistering(null); setOpen(id); }} />}
    </>
  );
}
