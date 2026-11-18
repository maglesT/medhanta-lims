// One sample (LIMS-07): its facts as registered, its specification and tests (read-only), its chain of custody, and
// the next entries this person may add. Disposal is an e-signature with its reason and method.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { plantTime, type Me } from '../api.js';
import { plainError, sourceWords } from '../api-floor.js';
import { SignDialog } from '../components/SignDialog.js';
import { testText } from '../designer/describe.js';
import type { SampleAction } from '../../../shared/engine/sample.js';
import { PURPOSE_LABEL, STATUS_CHIP, STATUS_LABEL, getSample, sampleEntry, type SampleDetail, type SampleEntry } from './api-samples.js';

const ENTRY_WORDS: Record<SampleEntry['kind'], string> = {
  checked: 'Checked by a second person', received: 'Received in QC', stored: 'Stored', handed_over: 'Handed over', disposed: 'Disposed of', note: 'Note',
};
const entryText = (e: SampleEntry) => [e.payload.condition && `Condition: ${e.payload.condition}`, e.payload.where && `Where: ${e.payload.where}`,
  e.payload.to && `To: ${e.payload.to}`, e.payload.reason && `Reason: ${e.payload.reason}`, e.payload.method && `Method: ${e.payload.method}`, e.payload.text].filter(Boolean).join(' · ');

// The entries asked for in a small form: their fields and button words.
const FORMS: Partial<Record<SampleAction, { title: string; button: string; fields: { name: string; label: string; hint?: string }[] }>> = {
  check: { title: 'Check the sample typed by hand', button: 'Confirm the check', fields: [] },
  receive: { title: 'Receive the sample in QC', button: 'Record received', fields: [{ name: 'condition', label: 'Condition on receipt', hint: 'e.g. Sealed, labelled, 3 containers' }] },
  store: { title: 'Store the sample', button: 'Record stored', fields: [{ name: 'where', label: 'Where', hint: 'e.g. Sample store, shelf B2' }] },
  'hand-over': { title: 'Hand the sample over', button: 'Record handed over', fields: [{ name: 'to', label: 'To (a person or a lab section)', hint: 'e.g. Wet chemistry section' }] },
  dispose: { title: 'Dispose of the sample', button: 'Continue to sign', fields: [{ name: 'reason', label: 'Reason', hint: 'e.g. Testing complete, retention period over' }, { name: 'method', label: 'Method of disposal', hint: 'e.g. Chemical waste, incineration' }] },
  note: { title: 'Add a note', button: 'Add note', fields: [{ name: 'text', label: 'Note' }] },
};
const BUTTON: Record<SampleAction, string> = { check: 'Check (second person)', receive: 'Receive', store: 'Store', 'hand-over': 'Hand over', dispose: 'Dispose of', note: 'Add note' };

export function SampleScreen({ id, onBack }: { me: Me; id: number; onBack: () => void }) {
  const [d, setD] = useState<SampleDetail | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<SampleAction | null>(null);
  const [signing, setSigning] = useState<Record<string, string> | null>(null);
  const load = useCallback(() => getSample(id).then((x) => { setD(x); setError(''); }, (e) => setError(plainError(e))), [id]);
  useEffect(() => { void load(); }, [load]);

  if (!d) return <>{error ? <p className="notice" role="alert">{error}</p> : <div className="skel skel-block" />}</>;
  const s = d.sample;
  const waitingWhy = !d.actions.includes('receive') && d.status !== 'disposed' && d.refusals.receive;
  return (
    <>
      <button className="link dark" onClick={onBack}>← Samples</button>
      <div className="home-head">
        <div>
          <h1>{s.sampleNo} <span className={STATUS_CHIP[d.status]}>{STATUS_LABEL[d.status]}</span></h1>
          <p className="greeting"><b>{s.item.code}</b> {s.item.name} · {s.item.of === 'material' ? 'lot' : 'batch'} {s.lotNo}</p>
        </div>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      <section className="dash-panel samples-waiting" aria-label="The sample">
        <dl className="details">
          <dt>{s.item.of === 'material' ? 'Lot' : 'Batch'}</dt><dd>{s.lotNo}</dd>
          <dt>Source</dt><dd>{sourceWords(s.source)}</dd>
          <dt>Quantity</dt><dd>{s.quantity}{s.containers ? ` from ${s.containers} container${s.containers === 1 ? '' : 's'}` : ''}</dd>
          <dt>Purpose</dt><dd>{PURPOSE_LABEL[s.purpose]}</dd>
          <dt>Registered</dt><dd>{s.registeredByName}, {plantTime(s.registeredAt)}</dd>
          {d.spec && (<><dt>Specification</dt><dd>{d.spec.header.number}, version {d.spec.versionNo} · {d.spec.header.pharmacopoeia}{d.spec.header.edition ? ` ${d.spec.header.edition}` : ''}{d.spec.state !== 'effective' ? ` (now ${d.spec.state})` : ''}</dd></>)}
        </dl>
        {d.spec && <ol className="spec-tests" aria-label="Tests">{d.spec.tests.map((t, i) => <li key={t.key}>{testText(t, i).replace(/^\d+\. /, '')}</li>)}</ol>}
      </section>
      <section className="dash-panel samples-waiting" aria-label="Chain of custody">
        <div className="panel-head"><h2>Chain of custody</h2></div>
        <ol className="custody">
          <li><b>Registered</b><span className="muted">{s.registeredByName}, {plantTime(s.registeredAt)}</span></li>
          {d.events.map((e) => (
            <li key={e.id}>
              <b>{ENTRY_WORDS[e.kind]}</b>
              {entryText(e) && <span>{entryText(e)}</span>}
              <span className="muted"> {e.personName}, {plantTime(e.at)}{e.signature ? ` · signed “Disposed of” by ${e.signature.printedName}` : ''}</span>
            </li>
          ))}
        </ol>
        {waitingWhy && <p className="muted">{waitingWhy}</p>}
        {d.actions.length > 0 && (
          <div className="sample-actions">
            {d.actions.map((a) => <button key={a} className={a === 'dispose' ? '' : 'primary'} onClick={() => setForm(a)}>{BUTTON[a]}</button>)}
          </div>
        )}
      </section>
      {form && (
        <EntryForm action={form} sampleNo={s.sampleNo} onCancel={() => setForm(null)}
          onSubmit={async (values) => {
            if (form === 'dispose') { setForm(null); setSigning(values); return; }
            await sampleEntry(id, form, values);
            setForm(null);
            await load();
          }} />
      )}
      {signing && (
        <SignDialog meaning="disposed" what={`Dispose of sample ${s.sampleNo} (${s.item.code}, ${s.lotNo})`} onCancel={() => setSigning(null)}
          onSign={async ({ proof }) => { await sampleEntry(id, 'dispose', { ...signing, proof, contentHash: d.contentHash }); setSigning(null); await load(); }}>
          <div className="summary-box"><p>Reason: <b>{signing.reason}</b></p><p>Method: <b>{signing.method}</b></p></div>
        </SignDialog>
      )}
    </>
  );
}

function EntryForm({ action, sampleNo, onSubmit, onCancel }: { action: SampleAction; sampleNo: string; onSubmit: (v: Record<string, string>) => Promise<void>; onCancel: () => void }) {
  const f = FORMS[action]!;
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const empty = f.fields.find((x) => !values[x.name]?.trim());
    if (empty) return setError(`${empty.label}: please write it.`);
    setBusy(true);
    try { await onSubmit(Object.fromEntries(f.fields.map((x) => [x.name, values[x.name]!.trim()]))); } catch (err) { setError(plainError(err)); setBusy(false); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={f.title}>
      <form className="card dialog" onSubmit={send}>
        <h2>{f.title}</h2>
        <p className="muted">Sample {sampleNo}. Your name and the server's time are recorded with the entry.</p>
        {action === 'check' && <p>Compare the lot or batch number, the item and the quantity with the sample's label and its paper record. Confirm only if they agree.</p>}
        {f.fields.map((x) => (
          <label key={x.name}>{x.label}<input aria-label={x.label} placeholder={x.hint} value={values[x.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [x.name]: e.target.value }))} /></label>
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
