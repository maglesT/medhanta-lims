// Reserve (retention) samples (LIMS-30) and the retest of stored materials (LIMS-31), on the Samples screen:
// - ReservePanel: on a release sample, its lot's reserve sample (or "log it"), which QC approval waits for;
// - LogReserveDialog: the quantity kept, the location, and how long it is kept (the rule shown, the date checked);
// - ReserveScreen: one reserve sample (facts, status, entries, the next entries);
// - ReserveList and RetestDue: the sections of the Samples screen.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { dayWords } from '../../../shared/engine/items.js';
import { FINDINGS, KEEP_RULES, KEEP_RULE_NAMES, addYears, type KeepRule, type ReserveAction, type ReserveEventKind } from '../../../shared/engine/reserve.js';
import { plantText } from '../../../shared/plant-time.js';
import type { SampleDetail } from './api-samples.js';
import { RESERVE_CHIP, getReserve, listReserves, logReserve, reserveEntry, reserveLabel, retestDue, type ReserveDetail, type ReserveEntry, type ReserveRow, type RetestDue, type RetestRow } from './api-reserve.js';

/** On a release sample: its lot's reserve sample, which QC approval waits for when the specification names a quantity. */
export function ReservePanel({ d, me, onOpen, reload }: { d: SampleDetail; me: Me; onOpen: (id: number) => void; reload: () => Promise<void> }) {
  const [logging, setLogging] = useState(false);
  if (d.sample.purpose !== 'release') return null;
  const r = d.reserve;
  return (
    <section className="dash-panel samples-waiting" aria-label="Reserve sample">
      <div className="panel-head"><h2>Reserve sample</h2>{r && <span className={RESERVE_CHIP[r.state.status]}>{reserveLabel(r.state.status)}</span>}</div>
      {r ? (<>
        <p>{r.state.left} {r.unit} kept · {r.location} · until {dayWords(r.keptUntil)} <button className="link dark" onClick={() => onOpen(r.id)}>Open the reserve sample</button></p>
        {r.state.why.length > 0 && <ul className="muted">{r.state.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      </>) : (<>
        <p className={d.reserveRequired ? 'notice' : 'muted'}>{d.reserveRequired
          ? `No reserve sample logged yet: the specification asks for at least ${d.reserveRequired}. QC approval waits for it.`
          : d.reserveNote ?? 'No reserve sample logged yet.'}</p>
        {can(me, 'sample.register') && d.decision !== 'rejected' && <button className="primary" onClick={() => setLogging(true)}>Log the reserve sample</button>}
      </>)}
      {logging && <LogReserveDialog sampleId={d.sample.id} what={`${d.sample.item.code} ${d.sample.item.name}, ${d.sample.lotNo}`} required={d.reserveRequired}
        onCancel={() => setLogging(false)} onDone={async () => { setLogging(false); await reload(); }} />}
    </section>
  );
}

export function LogReserveDialog({ sampleId, what, required, onDone, onCancel }: { sampleId: number; what: string; required: string | null; onDone: () => Promise<void>; onCancel: () => void }) {
  const [v, setV] = useState({ quantity: '', location: '', rule: 'expiry' as KeepRule, fromDate: '', keptUntil: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rule = KEEP_RULES[v.rule];
  const min = /^\d{4}-\d{2}-\d{2}$/.test(v.fromDate) ? addYears(v.fromDate, rule.years) : null;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!v.quantity.trim() || !v.location.trim() || !v.fromDate || !v.keptUntil) return setError('Give the quantity, the location and both dates.');
    setBusy(true);
    try { await logReserve(sampleId, { ...v, quantity: v.quantity.trim(), location: v.location.trim() }); await onDone(); } catch (err) { setError(plainError(err)); setBusy(false); }
  };
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Log the reserve sample">
      <form className="card dialog wide" onSubmit={send}>
        <h2>Log the reserve sample</h2>
        <p className="muted">{what}. Your name and the server's time are recorded with the entry.</p>
        <p>{required ? <>The specification asks for at least <b>{required}</b>: twice the quantity for all its tests, except sterility and pyrogen.</> : 'The specification names no reserve quantity.'}</p>
        <div className="form-grid">
          <label>Quantity kept<input aria-label="Quantity kept" value={v.quantity} onChange={set('quantity')} placeholder={required ? `e.g. ${required}` : 'e.g. 60 tablets'} /></label>
          <label>Storage location<input aria-label="Storage location" value={v.location} onChange={set('location')} placeholder="e.g. Reserve sample store, cabinet 3" /></label>
        </div>
        <label>Kept for<select aria-label="Kept for" value={v.rule} onChange={set('rule')}>
          {KEEP_RULE_NAMES.map((k) => <option key={k} value={k}>{KEEP_RULES[k].words}</option>)}</select></label>
        <p className="muted small">{rule.clauses}</p>
        <div className="form-grid">
          <label>{rule.from}<input aria-label={rule.from} type="date" value={v.fromDate} onChange={set('fromDate')} /></label>
          <label>Kept until<input aria-label="Kept until" type="date" value={v.keptUntil} onChange={set('keptUntil')} /></label>
        </div>
        {min && <p className="muted" role="note">Kept until: on or after {dayWords(min)} ({rule.words}).</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>Log the reserve sample</button>
        </div>
      </form>
    </div>
  );
}

const ENTRY_WORDS: Record<ReserveEventKind, string> = {
  inspected: 'Visual inspection', withdrawn: 'Withdrawn', destroyed: 'Destroyed', checked: 'Checked by a second person', note: 'Note',
};
const entryText = (e: ReserveEntry, unit: string) => [e.payload.finding && (e.payload.finding === 'deterioration' ? 'Deterioration seen' : 'No deterioration'),
  e.payload.amount && `${e.payload.amount} ${unit}`, e.payload.reason && `Reason: ${e.payload.reason}`, e.payload.of && `checked entry ${e.payload.of}`, e.payload.text].filter(Boolean).join(' · ');
type Field = { name: string; label: string; type?: 'finding'; optional?: boolean; hint?: string };
const FORMS: Record<ReserveAction, { title: string; button: string; fields: Field[] }> = {
  inspect: { title: 'Yearly visual inspection', button: 'Record the inspection', fields: [{ name: 'finding', label: 'Finding', type: 'finding' },
    { name: 'reason', label: 'Deterioration seen', optional: true, hint: 'e.g. tablets mottled, container cracked' }] },
  withdraw: { title: 'Withdraw from the reserve sample', button: 'Record the withdrawal', fields: [{ name: 'amount', label: 'Quantity withdrawn', hint: 'e.g. 10' },
    { name: 'reason', label: 'Reason', hint: 'e.g. Complaint investigation CMP-26-004' }] },
  destroy: { title: 'Destroy the reserve sample', button: 'Record destroyed', fields: [{ name: 'reason', label: 'Reason', hint: 'e.g. Retention period over' }] },
  check: { title: 'Check as a second person', button: 'Confirm the check', fields: [] },
  note: { title: 'Add a note', button: 'Add note', fields: [{ name: 'text', label: 'Note' }] },
};
const BUTTON: Record<ReserveAction, string> = { inspect: 'Visual inspection', withdraw: 'Withdraw', destroy: 'Destroy', check: 'Check (second person)', note: 'Add note' };

/** One reserve sample: its facts, its status and why, its entries, and the entries this person may add now. */
export function ReserveScreen({ id, onBack }: { id: number; onBack: () => void }) {
  const [d, setD] = useState<ReserveDetail | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<ReserveAction | null>(null);
  const load = useCallback(() => getReserve(id).then((x) => { setD(x); setError(''); }, (e) => setError(plainError(e))), [id]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <>{error ? <p className="notice" role="alert">{error}</p> : <div className="skel skel-block" />}</>;
  const r = d.reserve;
  return (
    <>
      <button className="link dark" onClick={onBack}>← Samples</button>
      <div className="home-head">
        <div>
          <h1>Reserve sample {r.lotNo} <span className={RESERVE_CHIP[d.state.status]}>{reserveLabel(d.state.status)}</span></h1>
          <p className="greeting"><b>{r.item.code}</b> {r.item.name} · from release sample {r.sampleNo}</p>
        </div>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      {d.state.why.length > 0 ? <div className="notice" role="status"><ul>{d.state.why.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
        : <p className="all-good" role="status">Kept, at the required quantity; next visual inspection by {dayWords(d.state.inspectionDue)}.</p>}
      <section className="dash-panel samples-waiting" aria-label="The reserve sample">
        <dl className="details">
          <dt>Quantity</dt><dd>{d.state.left} {r.unit} left of {r.amount} {r.unit} logged{d.required ? ` · the specification (${r.specNumber}, version ${r.specVersionNo}) asks for at least ${d.required.amount} ${d.required.unit}` : ''}</dd>
          <dt>Storage location</dt><dd>{r.location}</dd>
          <dt>Kept until</dt><dd>{dayWords(r.keptUntil)} · {KEEP_RULES[r.rule].words} ({KEEP_RULES[r.rule].from.toLowerCase()} {dayWords(r.fromDate)})</dd>
          <dt>Next visual inspection</dt><dd>{dayWords(d.state.inspectionDue)}</dd>
          <dt>Logged</dt><dd>{r.loggedByName}, {plantTime(r.loggedAt)}</dd>
        </dl>
      </section>
      <section className="dash-panel samples-waiting" aria-label="Entries">
        <div className="panel-head"><h2>Entries</h2></div>
        <ol className="custody">
          <li><b>Logged</b><span>{r.amount} {r.unit} · {r.location}</span><span className="muted"> {r.loggedByName}, {plantTime(r.loggedAt)}</span></li>
          {d.events.map((e) => (
            <li key={e.id}>
              <b>{ENTRY_WORDS[e.kind]} <small className="muted">(entry {e.id})</small></b>
              {entryText(e, r.unit) && <span>{entryText(e, r.unit)}</span>}
              <span className="muted"> {e.personName}, {plantTime(e.at)}</span>
            </li>
          ))}
        </ol>
        {d.waitingCheck && <p className="muted">Entry {d.waitingCheck.id} ({ENTRY_WORDS[d.waitingCheck.kind].toLowerCase()} by {d.waitingCheck.personName}) waits for a second person's check.</p>}
        {d.actions.length > 0 && (
          <div className="sample-actions">
            {d.actions.map((a) => <button key={a} className={a === 'destroy' || a === 'withdraw' ? '' : 'primary'} onClick={() => setForm(a)}>{BUTTON[a]}</button>)}
          </div>
        )}
        {d.refusals.destroy && !d.actions.includes('destroy') && d.state.status !== 'destroyed' && <p className="muted small">{d.refusals.destroy}</p>}
      </section>
      {form && <EntryForm action={form} d={d} onCancel={() => setForm(null)} onSubmit={async (body) => { await reserveEntry(id, form, body); setForm(null); await load(); }} />}
    </>
  );
}

function EntryForm({ action, d, onSubmit, onCancel }: { action: ReserveAction; d: ReserveDetail; onSubmit: (v: Record<string, string>) => Promise<void>; onCancel: () => void }) {
  const f = FORMS[action];
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const empty = f.fields.find((x) => !x.optional && !values[x.name]?.trim());
    if (empty) return setError(`${empty.label}: please give it.`);
    setBusy(true);
    try { await onSubmit(Object.fromEntries(f.fields.filter((x) => values[x.name]?.trim()).map((x) => [x.name, values[x.name]!.trim()]))); } catch (err) { setError(plainError(err)); setBusy(false); }
  };
  const w = d.waitingCheck;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={f.title}>
      <form className="card dialog" onSubmit={send}>
        <h2>{f.title}</h2>
        <p className="muted">Reserve sample {d.reserve.lotNo} ({d.state.left} {d.reserve.unit} left). Your name and the server's time are recorded with the entry.</p>
        {action === 'check' && w && <p>Check entry {w.id}: <b>{ENTRY_WORDS[w.kind]}</b> by {w.personName} · {entryText(w, d.reserve.unit)}. Confirm only if you saw it done as recorded.</p>}
        {f.fields.map((x) => (
          <label key={x.name}>{x.label}{x.name === 'amount' ? ` (${d.reserve.unit})` : ''}{x.optional ? ' (if any)' : ''}
            {x.type === 'finding' ? (
              <select aria-label={x.label} value={values[x.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [x.name]: e.target.value }))}>
                <option value="">Pick…</option>{FINDINGS.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : <input aria-label={x.label} placeholder={x.hint} value={values[x.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [x.name]: e.target.value }))} />}
          </label>
        ))}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>{f.button}</button>
        </div>
      </form>
    </div>
  );
}

/** The Samples screen's reserve section: every reserve sample with its status. */
export function ReserveList({ onOpen }: { onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<(ReserveRow & { state: ReserveDetail['state']; waitingCheck: boolean })[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { listReserves().then(setRows, (e) => setError(plainError(e))); }, []);
  return (
    <section className="dash-panel samples-waiting" aria-label="Reserve samples">
      <div className="panel-head"><h2>Reserve samples</h2><span className="pill">{rows?.length ?? 0}</span></div>
      {error && <p className="notice" role="alert">{error}</p>}
      {rows === null ? <div className="skel skel-block" /> : !rows.length ? <p className="muted">No reserve samples logged yet.</p> : (
        <div className="table-wrap">
          <table className="masters" aria-label="Reserve list">
            <thead><tr><th>Lot or batch</th><th>Item</th><th>Quantity</th><th>Location</th><th>Kept until</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                  <td><b>{r.lotNo}</b><span className="cell-sub">{r.sampleNo}</span></td>
                  <td><b>{r.item.code}</b><span className="cell-sub">{r.item.name}</span></td>
                  <td>{r.state.left} {r.unit}{r.reserveQuantity && <span className="cell-sub">required {r.reserveQuantity}</span>}</td>
                  <td>{r.location}</td>
                  <td>{dayWords(r.keptUntil)}<span className="cell-sub">inspect by {dayWords(r.state.inspectionDue)}</span></td>
                  <td><span className={RESERVE_CHIP[r.state.status]}>{reserveLabel(r.state.status)}</span>{r.waitingCheck && <span className="cell-sub">waits for a check</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * LIMS-31: the released MMS lots whose retest date is past or within the days picked, read live; each with its retest
 * sample (waiting for QC) or the button to register it (purpose retest, against the effective specification).
 */
export function RetestDueList({ onRegister, onOpenSample }: { onRegister: (r: RetestRow) => void; onOpenSample: (id: number) => void }) {
  const [days, setDays] = useState(30);
  const [due, setDue] = useState<RetestDue | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setDue(null); retestDue(days).then(setDue, (e) => setError(plainError(e))); }, [days]);
  return (
    <section className="dash-panel samples-waiting" aria-label="Retest due">
      <div className="panel-head"><h2>Retest due</h2><span className="pill">{due?.rows.length ?? 0}</span>
        <label className="inline">Within<select aria-label="Retest due within" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 60, 90].map((n) => <option key={n} value={n}>{n} days</option>)}</select></label></div>
      {error && <p className="notice" role="alert">{error}</p>}
      {due === null ? <div className="skel skel-block" /> : due.link !== 'ok' ? (
        <p className="notice">MMS {due.link === 'down' ? 'does not answer now' : 'is not linked'}: the lots due for retest cannot be read. Register a retest sample by hand (purpose Retest); a second person checks it.</p>
      ) : (<>
        {due.pastWithout.length > 0 && <p className="notice bad" role="note">Past the retest date with no retest sample: {due.pastWithout.join(', ')}.</p>}
        {!due.rows.length ? <p className="muted">No released lot is due for retest within {due.days} days.</p> : (
          <div className="table-wrap">
            <table className="masters" aria-label="Lots due for retest">
              <thead><tr><th>Lot</th><th>What</th><th>Retest date</th><th>Specification</th><th>Retest sample</th></tr></thead>
              <tbody>
                {due.rows.map((r) => (
                  <tr key={r.lotNo}>
                    <td><b>{r.lotNo}</b><span className="cell-sub">{r.stock ?? ''}</span></td>
                    <td><b>{r.code}</b><span className="cell-sub">{plantText(r.shown)}</span></td>
                    <td>{dayWords(r.retestDate)}{r.past && <span className="chip chip-bad">past</span>}</td>
                    <td>{r.specs.length ? r.specs.map((s) => <span key={s.id} className="cell-line">{s.number}, version {s.versionNo}</span>) : <span className="chip chip-warn">{r.noSpec}</span>}</td>
                    <td>{r.sampleNo ? <button className="link dark" onClick={() => onOpenSample(r.sampleId!)}>{r.sampleNo}</button>
                      : <button className="primary" disabled={!r.specs.length} onClick={() => onRegister(r)} aria-label={`Register the retest sample of ${r.lotNo}`}>Register the retest sample</button>}
                      {r.lastRetest && <span className="cell-sub">last retest {r.lastRetest.sampleNo}: {r.lastRetest.decision}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>)}
    </section>
  );
}
