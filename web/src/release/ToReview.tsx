import { useEffect, useState } from 'react';
import { api, type Me } from '../api.js';
import { analysisLink, go, plainClock, plainError, releaseLink, statusText } from '../api-floor.js';
import { Stop } from './Stop.js';
import '../floor/floor.css';
import './release.css';

interface ReviewItem {
  id: number; analysisNo: string; methodCode: string; methodName: string; status: string;
  since: string; by: string; openDeviations: number; actions: string[];
}

// "To review" (LIMS-18): the complete analyses waiting for a second person's review with the audit trail, and those
// still in progress, which the reviewer may stop.
export function ToReview(_: { me: Me }) {
  const [rows, setRows] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = (background: boolean) => api<ReviewItem[]>('GET', '/api/analyses/to-review', undefined, background)
      .then((r) => { if (live) { setRows(r); setError(''); } }, (e) => live && setError(plainError(e)));
    void load(false);
    const t = setInterval(() => void load(true), 30_000);
    return () => { live = false; clearInterval(t); };
  }, [tick]);

  const groups = [['complete', 'Waiting for review', 'every step finished; review the record and its audit trail, then sign'],
    ['in progress', 'In progress', 'an analysis that cannot be finished may be stopped: its record is kept']] as const;
  return (
    <div className="fl">
      <h1>To review</h1>
      <p className="greeting">Analyses waiting for a second person. Nobody reviews an analysis they recorded or signed. Times are plant time (IST).</p>
      {error && <p className="notice bad" role="alert">{error}</p>}
      {rows === null && !error ? (
        <div className="dash-panel" aria-label="Loading"><div className="skel skel-line w30" />{[0, 1].map((i) => <div key={i} className="skel skel-row" />)}</div>
      ) : rows && groups.map(([status, title, sub]) => {
        const mine = rows.filter((r) => r.status === status);
        return (
          <section key={status} className="dash-panel" aria-label={title}>
            <div className="panel-head"><h2>{title}</h2><span className="pill">{mine.length}</span><span className="muted">{sub}</span></div>
            {mine.length === 0 ? <p className="all-good"><span aria-hidden="true">✓</span> Nothing waiting.</p> : (
              <div className="pending-list">
                {mine.map((b) => status === 'in progress' ? (
                  <div key={b.id} className="pending-row">
                    <span className="age-dot" aria-hidden="true" />
                    <span className="pending-what">
                      <strong><a href={analysisLink(b.id)}>{b.analysisNo} · {b.methodName}</a></strong>
                      <small>{b.methodCode} · {statusText(b.status)}, last entry {plainClock(b.since)}</small>
                    </span>
                    {b.actions.includes('stop') && <Stop id={b.id} analysisNo={b.analysisNo} onDone={() => setTick((n) => n + 1)} />}
                  </div>
                ) : (
                  <button key={b.id} className={b.openDeviations ? 'pending-row late' : 'pending-row'} onClick={() => go(releaseLink(b.id))}>
                    <span className={b.openDeviations ? 'age-dot late' : 'age-dot'} aria-hidden="true" />
                    <span className="pending-what">
                      <strong>{b.analysisNo} · {b.methodName}</strong>
                      <small>{b.methodCode} · last entry by {b.by}, {plainClock(b.since)}</small>
                      <span className="pending-badges">
                        {b.openDeviations > 0 && <span className="chip chip-bad">{b.openDeviations} open deviation{b.openDeviations === 1 ? '' : 's'}</span>}
                        {b.actions.includes('review') ? <span className="chip chip-ok">Ready for your review</span> : <span className="chip">Not yours to review</span>}
                      </span>
                    </span>
                    <span className="pending-go">Review →</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
