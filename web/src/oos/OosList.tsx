// The OOS tab (LIMS-23): every OOS investigation, newest first, with its status; open ones first.
import { useEffect, useState } from 'react';
import { plantTime, type Me } from '../api.js';
import { go, oosLink, plainError } from '../api-floor.js';
import { oosClosed } from '../../../shared/engine/oos.js';
import { OOS_CHIP, OOS_LABEL, listOos, type OosListRow } from './api-oos.js';
import '../designer/designer.css';
import '../floor/floor.css';
import '../samples/samples.css';

export function OosList(_: { me: Me }) {
  const [rows, setRows] = useState<OosListRow[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { listOos().then(setRows, (e) => setError(plainError(e))); }, []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows ?? []).filter((r) => words.every((w) => `${r.oosNo} ${r.sampleNo} ${r.lotNo} ${r.item.code} ${r.item.name} ${r.result.name} ${r.status} ${r.deviation ?? ''}`.toLowerCase().includes(w)));
  const open = shown.filter((r) => !oosClosed(r.status));
  const closed = shown.filter((r) => oosClosed(r.status));
  const table = (list: OosListRow[], label: string) => (
    <div className="table-wrap">
      <table className="masters" aria-label={label}>
        <thead><tr><th>OOS</th><th>Sample and lot</th><th>Test and result</th><th>Status</th><th>Deviation</th><th>Opened</th></tr></thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => go(oosLink(r.id))}>
              <td><b>{r.oosNo}</b><span className="cell-sub">analysis {r.analysisNo}</span></td>
              <td><b>{r.sampleNo}</b><span className="cell-sub">{r.item.code} {r.item.name} · {r.lotNo}</span></td>
              <td><b>{r.result.name}: {r.result.shown}</b><span className="cell-sub">limit {r.result.limit}</span></td>
              <td><span className={OOS_CHIP[r.status]}>{OOS_LABEL[r.status]}</span>{r.closedAt && <span className="cell-sub">{plantTime(r.closedAt)}</span>}</td>
              <td>{r.deviation ?? '—'}</td>
              <td>{r.openedByName}<span className="cell-sub">{plantTime(r.openedAt)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <div className="home-head">
        <div>
          <h1>OOS</h1>
          <p className="greeting">Each result out of its limit opens an investigation at once. Times are plant time (IST).</p>
        </div>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      <input className="search" placeholder="Search by OOS, sample, lot, item, test, status or deviation" aria-label="Search OOS" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows === null ? <div className="skel skel-block" /> : !rows.length ? <div className="card placeholder"><p>No OOS results.</p></div> : (<>
        <h2>Open <span className="pill warn">{open.length}</span></h2>
        {open.length ? table(open, 'Open OOS') : <p className="muted">None open.</p>}
        <h2>Concluded <span className="pill">{closed.length}</span></h2>
        {closed.length ? table(closed, 'Concluded OOS') : <p className="muted">None concluded yet.</p>}
      </>)}
    </>
  );
}
