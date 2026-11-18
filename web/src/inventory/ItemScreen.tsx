// One lab item: its facts as registered, whether it may be used now and why not, what it was made from or qualified
// against and what was made from it, its entries, and every analysis step that used it (LIMS-14 look-back). The next
// entries this person may add; a second person's check needs the review permission and another person.
import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { plantTime, type Me } from '../api.js';
import { analysisLink, plainError } from '../api-floor.js';
import { BASES, FACT_LABEL, ITEM_KIND_NAME, KIND_FACTS, dayWords, type ItemAction, type ItemEventKind } from '../../../shared/engine/items.js';
import { getItem, itemEntry, statusChip, statusWords, type ItemDetail, type ItemEntry } from './api-inventory.js';

const ENTRY_WORDS: Record<ItemEventKind, string> = {
  opened: 'Opened', standardised: 'Standardised', qualified: 'Qualified against the primary standard', growth_promotion: 'Growth promotion test', checked: 'Checked by a second person',
  retest: 'Retested', blocked: 'Blocked', unblocked: 'Unblocked', disposed: 'Disposed of', note: 'Note',
};
const entryText = (e: ItemEntry) => [e.payload.factor && `Factor ${e.payload.factor}`, e.payload.potency && `Potency ${e.payload.potency} % (${e.payload.basis})`,
  e.payload.against && `against ${e.payload.against}`, e.payload.passed !== undefined && (e.payload.passed ? 'Passed' : 'Failed'), e.payload.organisms && `Organisms: ${e.payload.organisms}`,
  e.payload.nextDue && `next due ${dayWords(e.payload.nextDue)}`, e.payload.retestOn && `retest date ${dayWords(e.payload.retestOn)}`, e.payload.reason && `Reason: ${e.payload.reason}`,
  e.payload.of && `checked entry ${e.payload.of}`, e.payload.text].filter(Boolean).join(' · ');

type Input = { name: string; label: string; type?: 'date' | 'basis' | 'passed'; optional?: boolean; hint?: string };
const FORMS: Record<ItemAction, { title: string; button: string; fields: Input[] }> = {
  open: { title: 'Open the item', button: 'Record opened', fields: [] },
  standardise: { title: 'Standardise the volumetric solution', button: 'Record the standardisation', fields: [
    { name: 'factor', label: 'Factor', hint: 'e.g. 1.0023' }, { name: 'nextDue', label: 'Next standardisation due', type: 'date' },
    { name: 'against', label: 'Standardised against (primary standard)', optional: true, hint: 'e.g. Potassium hydrogen phthalate RS260003' }] },
  qualify: { title: 'Qualify against the primary standard', button: 'Record the qualification', fields: [
    { name: 'potency', label: 'Potency assigned (%)', hint: 'e.g. 99.4' }, { name: 'basis', label: 'Basis of the potency', type: 'basis' }, { name: 'nextDue', label: 'Re-qualification due', type: 'date' }] },
  'growth-promotion': { title: 'Growth promotion test', button: 'Record the test', fields: [{ name: 'passed', label: 'Result', type: 'passed' }, { name: 'organisms', label: 'Organisms tested', hint: 'e.g. S. aureus ATCC 6538, B. subtilis ATCC 6633' }] },
  check: { title: 'Check as a second person', button: 'Confirm the check', fields: [] },
  retest: { title: 'Retest', button: 'Record the retest', fields: [{ name: 'retestOn', label: 'New retest date', type: 'date' }] },
  block: { title: 'Block the item', button: 'Block', fields: [{ name: 'reason', label: 'Reason' }] },
  unblock: { title: 'Unblock the item', button: 'Unblock', fields: [{ name: 'reason', label: 'Reason' }] },
  dispose: { title: 'Dispose of the item', button: 'Record disposed', fields: [{ name: 'reason', label: 'Reason', hint: 'e.g. used up, expired, column plates below limit' }] },
  note: { title: 'Add a note', button: 'Add note', fields: [{ name: 'text', label: 'Note' }] },
};
const BUTTON: Record<ItemAction, string> = {
  open: 'Open', standardise: 'Standardise', qualify: 'Qualify', 'growth-promotion': 'Growth promotion test', check: 'Check (second person)', retest: 'Retest',
  block: 'Block', unblock: 'Unblock', dispose: 'Dispose of', note: 'Add note',
};

export function ItemScreen({ me: _me, id, onBack, onOpen }: { me: Me; id: number; onBack: () => void; onOpen: (id: number) => void }) {
  const [d, setD] = useState<ItemDetail | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<ItemAction | null>(null);
  const load = useCallback(() => getItem(id).then((x) => { setD(x); setError(''); }, (e) => setError(plainError(e))), [id]);
  useEffect(() => { void load(); }, [load]);

  if (!d) return <>{error ? <p className="notice" role="alert">{error}</p> : <div className="skel skel-block" />}</>;
  const it = d.item;
  const facts = [...KIND_FACTS[it.kind].need, ...KIND_FACTS[it.kind].may].filter((n) => it.facts[n] !== undefined);
  const column = it.kind === 'column';
  return (
    <>
      <button className="link dark" onClick={onBack}>← Inventory</button>
      <div className="home-head">
        <div>
          <h1>{it.itemNo} <span className={statusChip(d.status)}>{d.status.usable ? 'Usable' : 'Not usable'}</span></h1>
          <p className="greeting"><b>{it.name}</b> · {ITEM_KIND_NAME[it.kind]}</p>
        </div>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      <p className={d.status.usable ? 'all-good' : 'notice bad'} role="status">{statusWords(d.status)}{d.status.due ? ` · in use until ${dayWords(d.status.due)}` : ''}</p>
      <section className="dash-panel samples-waiting" aria-label="The item">
        <dl className="details">
          {facts.map((n) => <Fragment key={n}><dt>{FACT_LABEL[n]}</dt><dd>{n === 'expiry' || n === 'retestOn' ? dayWords(String(it.facts[n])) : String(it.facts[n])}</dd></Fragment>)}
          {it.facts.passage !== undefined && <><dt>Passage from the reference culture</dt><dd>{it.facts.passage}</dd></>}
          {d.status.values.potency && <><dt>Potency used in analyses</dt><dd>{d.status.values.potency} % ({d.status.values.basis})</dd></>}
          {d.status.values.factor && <><dt>Factor used in analyses</dt><dd>{d.status.values.factor}</dd></>}
          <dt>{['reference', 'reagent', 'column', 'medium'].includes(it.kind) ? 'Received' : 'Prepared'}</dt><dd>{it.registeredByName}, {plantTime(it.registeredAt)}</dd>
          {d.parents.length > 0 && <><dt>{it.kind === 'working' ? 'Primary standard' : it.kind === 'culture' ? 'Sub-cultured from' : 'Made from'}</dt>
            <dd>{d.parents.map((p) => <span key={p.id} className="cell-line"><button className="link dark" onClick={() => onOpen(p.id)}>{p.itemNo}</button> {p.name} <span className={statusChip(p.status)}>{p.status.usable ? 'usable' : 'not usable'}</span></span>)}</dd></>}
          {d.children.length > 0 && <><dt>Used to make</dt>
            <dd>{d.children.map((c) => <span key={c.id} className="cell-line"><button className="link dark" onClick={() => onOpen(c.id)}>{c.itemNo}</button> {c.name}</span>)}</dd></>}
        </dl>
      </section>
      <section className="dash-panel samples-waiting" aria-label="Entries">
        <div className="panel-head"><h2>Entries</h2></div>
        <ol className="custody">
          <li><b>{['reference', 'reagent', 'column', 'medium'].includes(it.kind) ? 'Received' : 'Prepared'} and registered</b><span className="muted">{it.registeredByName}, {plantTime(it.registeredAt)}</span></li>
          {d.events.map((e) => (
            <li key={e.id}>
              <b>{column && e.kind === 'disposed' ? 'Retired' : ENTRY_WORDS[e.kind]} <small className="muted">(entry {e.id})</small></b>
              {entryText(e) && <span>{entryText(e)}</span>}
              <span className="muted"> {e.personName}, {plantTime(e.at)}</span>
            </li>
          ))}
        </ol>
        {d.waitingCheck && <p className="muted">Entry {d.waitingCheck.id} ({ENTRY_WORDS[d.waitingCheck.kind].toLowerCase()} by {d.waitingCheck.personName}) waits for a second person's check.</p>}
        {d.actions.length > 0 && (
          <div className="sample-actions">
            {d.actions.map((a) => <button key={a} className={a === 'dispose' || a === 'block' ? '' : 'primary'} onClick={() => setForm(a)}>{column && a === 'dispose' ? 'Retire' : BUTTON[a]}</button>)}
          </div>
        )}
      </section>
      <section className="dash-panel samples-waiting" aria-label="Usage">
        <div className="panel-head"><h2>{column ? 'Runs' : 'Used in'}</h2><span className="pill">{d.uses.length}</span></div>
        {!d.uses.length ? <p className="muted">Not used in an analysis yet.</p> : (
          <div className="table-wrap">
            <table className="masters" aria-label="Used in">
              <thead><tr><th>Analysis</th><th>Step</th><th>By</th></tr></thead>
              <tbody>
                {d.uses.map((u, i) => (
                  <tr key={i}>
                    <td><a href={analysisLink(u.analysisId)}>{u.analysisNo}</a><span className="cell-sub">{u.method}{u.sampleNo ? ` · sample ${u.sampleNo}` : ''}</span></td>
                    <td>{u.where}</td>
                    <td>{u.personName ?? '—'}<span className="cell-sub">{plantTime(u.at)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {form && <EntryForm action={form} d={d} onCancel={() => setForm(null)} onSubmit={async (body) => { await itemEntry(id, form, body); setForm(null); await load(); }} />}
    </>
  );
}

function EntryForm({ action, d, onSubmit, onCancel }: { action: ItemAction; d: ItemDetail; onSubmit: (v: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const f = FORMS[action];
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const empty = f.fields.find((x) => !x.optional && !values[x.name]?.trim());
    if (empty) return setError(`${empty.label}: please give it.`);
    setBusy(true);
    try {
      await onSubmit(Object.fromEntries(f.fields.filter((x) => values[x.name]?.trim()).map((x) => [x.name, x.type === 'passed' ? values[x.name] === 'passed' : values[x.name]!.trim()])));
    } catch (err) { setError(plainError(err)); setBusy(false); }
  };
  const w = d.waitingCheck;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={f.title}>
      <form className="card dialog" onSubmit={send}>
        <h2>{f.title}</h2>
        <p className="muted">{d.item.itemNo} {d.item.name}. Your name and the server's time are recorded with the entry.</p>
        {action === 'check' && w && <p>Check entry {w.id}: <b>{ENTRY_WORDS[w.kind]}</b> by {w.personName} · {entryText(w)}. Compare it with the worksheet and the raw data. Confirm only if they agree.</p>}
        {f.fields.map((x) => (
          <label key={x.name}>{x.label}{x.optional ? ' (if it applies)' : ''}
            {x.type === 'basis' || x.type === 'passed' ? (
              <select aria-label={x.label} value={values[x.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [x.name]: e.target.value }))}>
                <option value="">Pick…</option>
                {(x.type === 'basis' ? BASES : ['passed', 'failed']).map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : <input aria-label={x.label} type={x.type === 'date' ? 'date' : 'text'} placeholder={x.hint} value={values[x.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [x.name]: e.target.value }))} />}
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
