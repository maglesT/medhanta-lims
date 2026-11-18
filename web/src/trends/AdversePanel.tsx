// LIMS-36 (EU Annex 1): the EM adverse trends (repeated alerts at a point, alerts across a room in a week, new organisms),
// each acknowledged by QC with the reason; on the Excursions tab (all, with "Acknowledge") and a point's trend screen.
import { useEffect, useState } from 'react';
import { api, can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { plantDate } from '../../../shared/plant-time.js';
import type { Adverse } from '../../../shared/engine/em-trends.js';

type Row = Adverse & { answer: { reason: string; by: string; at: string } | null };

export function AdversePanel({ me, point }: { me?: Me; point?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState<Record<string, string>>({});
  const load = () => api<Row[]>('GET', `/api/em/adverse${point ? `?point=${encodeURIComponent(point)}` : ''}`).then(setRows, (e) => setError(plainError(e)));
  useEffect(() => { void load(); }, [point]);
  const qc = !!me && can(me, 'qc.approve');
  const ack = async (key: string) => {
    try { await api('POST', '/api/em/adverse/answer', { key, reason: reason[key] ?? '' }); setError(''); await load(); } catch (e) { setError(plainError(e)); }
  };
  const open = (rows ?? []).filter((r) => !r.answer).length;
  return (
    <section className="dash-panel samples-waiting" aria-label="Adverse trends">
      <div className="panel-head"><h2>Adverse trends</h2><span className={open ? 'pill warn' : 'pill'}>{rows ? `${open} to acknowledge` : '…'}</span></div>
      <p className="muted small">Repeated alert or action results at a point (the plan's n in m), alerts at 2 or more points of a room in one week, and organisms new to a room in 12 months. QC acknowledges each with the reason.</p>
      {error && <p className="notice" role="alert">{error}</p>}
      {rows && !rows.length && <p className="muted">None.</p>}
      {rows && rows.length > 0 && <div className="table-wrap"><table className="masters" aria-label="Adverse trends">
        <thead><tr><th>Date</th><th>Adverse trend</th><th>What</th><th>QC</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key}><td>{plantDate(r.on)}</td><td><span className="chip chip-warn">{r.kind}</span></td><td>{r.what}</td>
            <td>{r.answer ? <>{r.answer.reason}<span className="cell-sub">{r.answer.by}, {plantTime(r.answer.at)}</span></> : qc ? (
              <span className="tr-assign"><input aria-label={`Reason ${r.key}`} placeholder="Reason (what was done)" value={reason[r.key] ?? ''} onChange={(e) => setReason({ ...reason, [r.key]: e.target.value })} />
                <button disabled={!reason[r.key]?.trim()} onClick={() => void ack(r.key)}>Acknowledge</button></span>) : 'to acknowledge (QC)'}</td></tr>))}</tbody>
      </table></div>}
    </section>
  );
}
