// One excursion (LIMS-36): the point, room and result over its limit; the investigation (the deviation, read live from
// Deviations; typed by hand and checked by a second person while it is not linked); the isolates identified from the
// identification method's report; a second person's confirmation of an imported alarm; QA's closure; the entries.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { plantTime } from '../api.js';
import { plainError } from '../api-floor.js';
import { TextDialog } from '../stability/Stability.js';
import { LEVEL_CHIP, LEVEL_WORDS, STATUS_CHIP, excursionAction, getExcursion, type ExcursionDetail } from './api-em.js';

const ENTRY_WORDS = { confirmed: 'Alarm confirmed by a second person', deviation: 'Investigation: deviation', checked: 'Deviation number checked by a second person',
  isolate: 'Isolate identified', closed: 'Closed by QA', note: 'Note' } as const;

export function ExcursionScreen({ id, onBack, onSample }: { id: number; onBack: () => void; onSample: (id: number) => void }) {
  const [d, setD] = useState<ExcursionDetail | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'deviation' | 'isolate' | 'close' | null>(null);
  const load = useCallback(() => getExcursion(id).then((x) => { setD(x); setError(''); }, (e) => setError(plainError(e))), [id]);
  useEffect(() => { void load(); }, [load]);
  const act = async (action: 'confirm' | 'check', b: object = {}) => { try { await excursionAction(id, action, b); await load(); } catch (e) { setError(plainError(e)); } };
  if (!d) return <>{error ? <p className="notice" role="alert">{error}</p> : <div className="skel skel-block" />}</>;
  const x = d.excursion;
  const r = d.refusals;
  const button = (label: string, refusal: string | null, onClick: () => void, primary = true) => refusal === null && <button className={primary ? 'primary' : ''} onClick={onClick}>{label}</button>;
  return (
    <>
      <button className="link dark" onClick={onBack}>← EM and water</button>
      <div className="home-head">
        <div>
          <h1>Excursion at {x.point.code} <span className={LEVEL_CHIP[x.level]}>{LEVEL_WORDS[x.level]}</span> <span className={STATUS_CHIP[x.status]}>{x.status}</span></h1>
          <p className="greeting">{x.point.where}{x.point.grade ? ` · grade ${x.point.grade}` : ''} · {x.point.name}</p>
        </div>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      <section className="dash-panel samples-waiting" aria-label="The excursion">
        <dl className="details">
          <dt>Point</dt><dd>{x.point.code} {x.point.name} · {x.point.where}</dd>
          <dt>Sampling</dt><dd>{x.point.kind}{x.point.state ? `, ${x.point.state}` : ''}</dd>
          <dt>Result</dt><dd>{x.result.shown}{x.result.why && x.result.why !== x.result.shown ? <span className="cell-sub">{x.result.why}</span> : null}</dd>
          {x.result.limit && <><dt>Limit</dt><dd>{x.result.limit}</dd></>}
          <dt>From</dt><dd>{x.origin === 'import' ? 'An alarm in a monitoring system\'s daily report' : <>Sample <button className="link dark" onClick={() => onSample(x.sampleId!)}>{x.sampleNo}</button>, analysis {x.result.analysisNo}</>}</dd>
          <dt>Investigation</dt><dd>{d.deviation ? <>Deviation <b>{d.deviation.number}</b>{d.deviation.shown ? ` · ${d.deviation.shown}` : ''}{d.deviation.byHand ? ' (typed by hand: Deviations not linked)' : ''}</>
            : x.level === 'action' ? 'Not opened yet.' : 'None: an alert is a trend watch.'}</dd>
          <dt>Recorded</dt><dd>{x.recordedByName}, {plantTime(x.recordedAt)}</dd>
        </dl>
        <div className="sample-actions">
          {button('Confirm the alarm (second person)', r.confirm, () => void act('confirm'))}
          {button('Open the investigation', r.deviation, () => setDialog('deviation'))}
          {button('Check the deviation number (second person)', r.check, () => void act('check'))}
          {button('Record an isolate', r.isolate, () => setDialog('isolate'), false)}
          {button('Close (QA)', r.close, () => setDialog('close'))}
        </div>
        <ul className="muted small">{Object.entries(r).filter(([, why]) => why).map(([a, why]) => <li key={a}>{why}</li>)}</ul>
      </section>
      <section className="dash-panel samples-waiting" aria-label="Entries">
        <div className="panel-head"><h2>Entries</h2></div>
        {!d.events.length ? <p className="muted">None yet.</p> : (
          <ul className="entries">
            {d.events.map((e) => (
              <li key={e.id}><b>{ENTRY_WORDS[e.kind]}</b> · {e.personName}, {plantTime(e.at)}
                {e.payload.number && ` · ${e.payload.number}`}{e.payload.genus && ` · ${e.payload.genus} ${e.payload.species} by ${e.payload.method}, report ${e.payload.report}`}{e.payload.text && ` · ${e.payload.text}`}</li>))}
          </ul>)}
      </section>
      {dialog === 'deviation' && <DeviationDialog d={d} onCancel={() => setDialog(null)} onDone={async (number) => { await excursionAction(id, 'deviation', { number }); setDialog(null); await load(); }} />}
      {dialog === 'isolate' && <IsolateDialog d={d} onCancel={() => setDialog(null)} onDone={async (b) => { await excursionAction(id, 'isolate', b); setDialog(null); await load(); }} />}
      {dialog === 'close' && <TextDialog title="Close the excursion" label="Conclusion (root cause, actions)" onCancel={() => setDialog(null)}
        onSubmit={async (text) => { await excursionAction(id, 'close', { text }); setDialog(null); await load(); }} />}
    </>
  );
}

/** The deviation of the investigation: picked from those Deviations lists for the sample or point while it answers. */
function DeviationDialog({ d, onDone, onCancel }: { d: ExcursionDetail; onDone: (number: string) => Promise<void>; onCancel: () => void }) {
  const [number, setNumber] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => { e.preventDefault(); try { await onDone(number.trim()); } catch (x) { setError(plainError(x)); } };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Open the investigation">
      <form className="card dialog" onSubmit={submit}>
        <h2>Open the investigation</h2>
        {d.deviations.link === 'ok'
          ? <label>Deviation<select aria-label="Deviation" value={number} onChange={(e) => setNumber(e.target.value)}><option value="">(pick the deviation filed in Deviations)</option>
            {d.deviations.list.map((x) => <option key={x.number} value={x.number}>{x.number}: {x.title} ({x.status})</option>)}</select></label>
          : <label>Deviation number (Deviations {d.deviations.link === 'down' ? 'does not answer' : 'is not linked'}: typed by hand, a second person checks it)
            <input aria-label="Deviation number" value={number} onChange={(e) => setNumber(e.target.value)} /></label>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Record</button></div>
      </form>
    </div>
  );
}

/** An isolate: genus and species as the identification method's report gives them, the method (an effective method) and the report. */
function IsolateDialog({ d, onDone, onCancel }: { d: ExcursionDetail; onDone: (b: object) => Promise<void>; onCancel: () => void }) {
  const [v, setV] = useState({ genus: '', species: '', method: '', report: '' });
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await onDone({ genus: v.genus.trim(), species: v.species.trim(), methodMasterId: Number(v.method), report: v.report.trim() }); } catch (x) { setError(plainError(x)); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Record an isolate">
      <form className="card dialog" onSubmit={submit}>
        <h2>Isolate identified</h2>
        <div className="form-grid">
          <label>Genus<input aria-label="Genus" value={v.genus} onChange={(e) => setV({ ...v, genus: e.target.value })} placeholder="e.g. Staphylococcus" /></label>
          <label>Species<input aria-label="Species" value={v.species} onChange={(e) => setV({ ...v, species: e.target.value })} placeholder="e.g. epidermidis" /></label>
          <label>Identification method<select aria-label="Identification method" value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}>
            <option value="">(choose)</option>{d.methods.map((m) => <option key={m.masterId} value={m.masterId}>{m.code} {m.name}</option>)}</select></label>
          <label>Its report number<input aria-label="Report number" value={v.report} onChange={(e) => setV({ ...v, report: e.target.value })} /></label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Record</button></div>
      </form>
    </div>
  );
}
