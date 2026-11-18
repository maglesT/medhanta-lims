// One stability study (LIMS-28): its batch and protocol, the schedule with each pull (on time, or late with its reason
// and deviation), the stock per condition (extra placement approved by QA), checks of what was typed by hand, the
// results per time point from the stability samples' analyses, the excursions that touched it, and its entries.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError, sourceWords } from '../api-floor.js';
import { SignDialog } from '../components/SignDialog.js';
import { plantDate } from '../../../shared/plant-time.js';
import { conditionLabel, PURPOSE_WORDS } from '../../../shared/master/protocol.js';
import { getStudy, studyAction, STATE_CHIPS, STATE_WORDS, type Point, type StudyDetail } from './api-stability.js';
import { TextDialog } from './Stability.js';

const ENTRY: Record<string, string> = { placed: 'Placed', extra: 'Extra placed', extra_approved: 'Extra placement approved by QA', pulled: 'Pulled', checked: 'Checked by a second person', note: 'Note' };

export function StudyScreen({ me, id, onBack }: { me: Me; id: number; onBack: () => void }) {
  const [d, setD] = useState<StudyDetail | null>(null);
  const [error, setError] = useState('');
  const [late, setLate] = useState<Point | null>(null);
  const [extra, setExtra] = useState<string | null>(null);
  const [approving, setApproving] = useState<number | null>(null);
  const [note, setNote] = useState(false);
  const [done, setDone] = useState('');
  const load = useCallback(() => getStudy(id).then((x) => { setD(x); setError(''); }, (e) => setError(plainError(e))), [id]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <>{error ? <p className="notice" role="alert">{error}</p> : <div className="skel skel-block" />}</>;
  const s = d.study;
  const h = d.protocol.header;
  const act = async (action: Parameters<typeof studyAction>[1], b: object) => {
    try {
      const r = await studyAction(id, action, b);
      if (r.sampleNo) setDone(`Stability sample ${r.sampleNo} registered.`);
      await load();
    } catch (e) { setError(plainError(e)); }
  };
  const label = (key: string) => { const c = d.protocol.conditions.find((x) => x.key === key); return c ? conditionLabel(c) : key; };
  return (
    <>
      <button className="link dark" onClick={onBack}>← Stability</button>
      <div className="home-head">
        <div>
          <h1>{s.studyNo}</h1>
          <p className="greeting"><b>{s.item.code}</b> {s.item.name} · {s.item.of === 'material' ? 'lot' : 'batch'} {s.lotNo} · placed {plantDate(s.t0)}</p>
        </div>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      {done && <p className="notice" role="status">{done}</p>}
      <section className="dash-panel samples-waiting" aria-label="The study">
        <dl className="details">
          <dt>Protocol</dt><dd>{h.number}, version {s.protocolVersionNo} · {PURPOSE_WORDS[h.purpose]}</dd>
          <dt>Container closure</dt><dd>{h.containerClosure}</dd>
          <dt>Specification</dt><dd>{d.protocol.spec ? `${d.protocol.spec.number}, version ${d.protocol.spec.versionNo} (shelf-life limits)` : '—'}</dd>
          <dt>Per time point</dt><dd>{d.protocol.quantity.amount} {d.protocol.quantity.unit}, window ± {d.protocol.pullWindowDays} days</dd>
          {s.cell && <><dt>Matrix cell</dt><dd>{s.cell}</dd></>}
          <dt>Source</dt><dd>{sourceWords(s.source)}</dd>
          <dt>Started</dt><dd>{s.createdByName}, {plantTime(s.createdAt)}</dd>
        </dl>
        {d.toCheck.map((c) => (
          <p key={c.entry} className="notice">{c.entry === 0 ? 'The batch was typed by hand.' : `Entry ${c.entry} was accepted without its link.`} A second person checks it before any pull.{' '}
            <button className="primary" disabled={!!c.refusal} title={c.refusal ?? ''} onClick={() => void act('check', { entry: c.entry })}>Check (second person)</button>
            {c.refusal && <span className="muted small"> {c.refusal}</span>}</p>))}
      </section>
      <section className="dash-panel samples-waiting" aria-label="Schedule">
        <div className="panel-head"><h2>Schedule</h2></div>
        <div className="table-wrap">
          <table className="masters" aria-label="Time points">
            <thead><tr><th>Condition</th><th>Time point</th><th>Due</th><th>Window</th><th>State</th><th>Sample</th><th /></tr></thead>
            <tbody>
              {d.points.map((p) => (
                <tr key={`${p.condition}:${p.month}`}>
                  <td>{p.label}</td><td>{p.month} months</td><td>{plantDate(p.due)}</td><td>{plantDate(p.from)} to {plantDate(p.to)}</td>
                  <td><span className={STATE_CHIPS[p.state]}>{STATE_WORDS[p.state]}</span>{p.late && <span className="cell-sub">late: {p.late.reason} ({p.late.deviation})</span>}</td>
                  <td>{p.sampleNo ?? ''}</td>
                  <td>{p.state !== 'pulled' && can(me, 'sample.register') && (p.state === 'due' || p.state === 'overdue') && (
                    p.refusal ? <span className="muted small">{p.refusal}</span>
                      : <button className="primary" aria-label={`Pull ${p.label} ${p.month} months`} onClick={() => (p.state === 'overdue' ? setLate(p) : void act('pull', { condition: p.condition, month: p.month }))}>Pull</button>)}</td>
                </tr>))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="dash-panel samples-waiting" aria-label="Stock">
        <div className="panel-head"><h2>Stock</h2></div>
        <table className="masters" aria-label="Stock per condition">
          <thead><tr><th>Condition</th><th>Placed</th><th>Pulled</th><th>Left</th><th>Later time points need</th><th /></tr></thead>
          <tbody>
            {d.stock.map((x) => (
              <tr key={x.condition}>
                <td>{x.label}</td><td>{x.placed} {x.unit}</td><td>{x.used}</td><td>{x.left}</td>
                <td>{x.needed}{x.left < x.needed && <span className="chip chip-warn">short by {x.needed - x.left}</span>}{x.extraWaiting > 0 && <span className="cell-sub">{x.extraWaiting} more waiting for QA</span>}</td>
                <td>{can(me, 'sample.register') && <button onClick={() => setExtra(x.condition)}>Place more</button>}</td>
              </tr>))}
          </tbody>
        </table>
        {d.extras.filter((x) => !x.approved).map((x) => (
          <p key={x.entry}>{label(x.condition)}: {x.quantity} more placed by {x.personName} ({x.reason}).{' '}
            {can(me, 'qc.approve') && <button className="primary" disabled={!!x.refusal} onClick={() => setApproving(x.entry)}>Approve (QA)</button>}
            {x.refusal && <span className="muted small"> {x.refusal}</span>}</p>))}
      </section>
      <section className="dash-panel samples-waiting" aria-label="Results">
        <div className="panel-head"><h2>Results per time point</h2></div>
        {!d.results.length ? <p className="muted">No pulls yet.</p> : (
          <div className="table-wrap">
            <table className="masters" aria-label="Results">
              <thead><tr><th>Condition</th><th>Time point</th><th>Sample</th>{d.tests.map((t) => <th key={t.key}>{t.name}</th>)}</tr></thead>
              <tbody>
                {d.results.map((r) => (
                  <tr key={`${r.condition}:${r.month}`}>
                    <td>{r.label}</td><td>{r.month} months</td><td>{r.sampleNo}</td>
                    {d.tests.map((t) => { const x = r.tests[t.key]; return <td key={t.key}>{x ? <>{x.shown ?? '—'}{x.pass === false && <span className="chip chip-bad">out of limits</span>}<span className="cell-sub">{x.analysisNo} · {x.status}</span></> : 'Not started'}</td>; })}
                  </tr>))}
              </tbody>
            </table>
          </div>)}
      </section>
      {d.excursions.length > 0 && (
        <section className="dash-panel samples-waiting" aria-label="Excursions">
          <div className="panel-head"><h2>Chamber excursions</h2></div>
          <ul>{d.excursions.map((x) => <li key={x.id}>{x.chamber.code}: {plantTime(x.from)} to {plantTime(x.to)}{x.range ? `, ${x.range.min} to ${x.range.max} °C` : ''}{x.mkt.ok ? `, MKT ${x.mkt.value}` : ''} · {x.deviation}</li>)}</ul>
        </section>)}
      <section className="dash-panel samples-waiting" aria-label="Entries">
        <div className="panel-head"><h2>Entries</h2></div>
        <ol className="custody">
          {d.events.map((e) => (
            <li key={e.id}><b>{ENTRY[e.kind]}</b>
              <span>{[e.payload.condition && label(e.payload.condition), e.payload.chamber && `${e.payload.chamber.code}${e.payload.chamberByHand ? ' (Logbook not read)' : ''}`,
                e.payload.quantity && `${e.payload.quantity} ${d.protocol.quantity.unit}`, e.payload.month !== undefined && `${e.payload.month} months`, e.payload.sampleNo,
                e.payload.reason, e.payload.text].filter(Boolean).join(' · ')}</span>
              <span className="muted"> {e.personName}, {plantTime(e.at)}{e.signature ? ` · signed “QC approved” by ${e.signature.printedName}` : ''}</span></li>))}
        </ol>
        {can(me, 'sample.register') && <button onClick={() => setNote(true)}>Add note</button>}
      </section>
      {late && <LateDialog p={late} onCancel={() => setLate(null)} onSubmit={async (b) => { setLate(null); await act('pull', { condition: late.condition, month: late.month, late: b }); }} />}
      {extra && (
        <ExtraDialog unit={d.protocol.quantity.unit} label={label(extra)} onCancel={() => setExtra(null)}
          onSubmit={async (b) => { setExtra(null); await act('extra', { condition: extra, ...b }); }} />)}
      {note && <TextDialog title="Add a note" label="Note" onCancel={() => setNote(false)} onSubmit={async (text) => { setNote(false); await act('note', { text }); }} />}
      {approving !== null && (
        <SignDialog meaning="qc_approved" what={`Approve the extra placement of study ${s.studyNo}`} onCancel={() => setApproving(null)}
          onSign={async ({ proof }) => { const fresh = await getStudy(id); await studyAction(id, 'approve-extra', { entry: approving, proof, contentHash: fresh.contentHash }); setApproving(null); await load(); }}>
          <div className="summary-box">{d.extras.filter((x) => x.entry === approving).map((x) => <p key={x.entry}>{label(x.condition)}: <b>{x.quantity} {d.protocol.quantity.unit}</b> more · {x.reason}</p>)}</div>
        </SignDialog>)}
    </>
  );
}

function LateDialog({ p, onSubmit, onCancel }: { p: Point; onSubmit: (b: { reason: string; deviation: string }) => Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [deviation, setDeviation] = useState('');
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Late pull">
      <form className="card dialog" onSubmit={(e: FormEvent) => { e.preventDefault(); if (reason.trim() && deviation.trim()) void onSubmit({ reason: reason.trim(), deviation: deviation.trim() }); }}>
        <h2>Late pull: {p.label}, {p.month} months</h2>
        <p>Its window closed on {plantDate(p.to)}. Give the reason and the deviation number.</p>
        <label>Reason<textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label>Deviation number<input aria-label="Deviation number" value={deviation} onChange={(e) => setDeviation(e.target.value)} /></label>
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Pull</button></div>
      </form>
    </div>
  );
}

function ExtraDialog({ unit, label, onSubmit, onCancel }: { unit: string; label: string; onSubmit: (b: { quantity: string; reason: string }) => Promise<void>; onCancel: () => void }) {
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Place more">
      <form className="card dialog" onSubmit={(e: FormEvent) => { e.preventDefault(); if (quantity.trim() && reason.trim()) void onSubmit({ quantity: quantity.trim(), reason: reason.trim() }); }}>
        <h2>Place more: {label}</h2>
        <p className="muted small">Counts once QA approves it.</p>
        <label>Quantity ({unit})<input aria-label="Quantity" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        <label>Reason<textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Place</button></div>
      </form>
    </div>
  );
}
