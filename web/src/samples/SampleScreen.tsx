// One sample (LIMS-07): its facts as registered, its specification and tests (read-only), its chain of custody, and
// the next entries this person may add. Disposal is an e-signature with its reason and method.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { analysisLink, oosLink, plainError, sourceWords } from '../api-floor.js';
import { IssueDialog } from '../floor/IssueDialog.js';
import { SignDialog } from '../components/SignDialog.js';
import { testText } from '../designer/describe.js';
import { reportName, type SampleAction } from '../../../shared/engine/sample.js';

// The report of an approved sample in a sentence: "certificate COA…", "EM result report COA…".
const reportWord = (purpose: string, of: string) => { const n = reportName(purpose, of); return n === 'Certificate of analysis' ? 'certificate' : n.replace(/^In-/, 'in-'); };
import { ReservePanel } from './Reserve.js';
import { PURPOSE_LABEL, STATUS_CHIP, STATUS_LABEL, answerOot, coaLink, decide, getSample, labelsLink, recordReduced, sampleEntry, type ReducedBasis, type SampleDetail, type SampleEntry } from './api-samples.js';
import { FormsPanel, OutsideDialog, OutsideLine } from './Paper.js';
import { SAMPLING_DETAILS } from '../../../shared/master/spec.js';
import { plantDate } from '../../../shared/plant-time.js';

// What a sample's lot number is: a material's lot, a product's batch, an EM or water sample's point.
const LOT_WORD = { material: 'Lot', product: 'Batch', room: 'Point', water: 'Point' } as const;
// The meaning of a chain-of-custody e-signature, as the signature records it.
const SIGNED_WORDS: Record<string, string> = { disposed: 'Disposed of', qc_approved: 'QC approved', rejected: 'QC rejected' };
const ENTRY_WORDS: Record<SampleEntry['kind'], string> = {
  checked: 'Checked by a second person', received: 'Received in QC', stored: 'Stored', handed_over: 'Handed over', disposed: 'Disposed of', note: 'Note', approved: 'QC approved', rejected: 'QC rejected', oot_answered: 'Out-of-trend flag answered by QC',
};
const entryText = (e: SampleEntry) => [e.payload.condition && `Condition: ${e.payload.condition}`, e.payload.where && `Where: ${e.payload.where}`,
  e.payload.to && `To: ${e.payload.to}`, e.payload.reason && `Reason: ${e.payload.reason}`, e.payload.method && `Method: ${e.payload.method}`, e.payload.coaNo && `${e.payload.coaNo.startsWith('IPR') ? 'In-process test report' : 'Certificate'} ${e.payload.coaNo}`, e.payload.test && `${e.payload.test}, analysis ${e.payload.analysisNo}: ${e.payload.answer}`, e.payload.text].filter(Boolean).join(' · ');

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

export function SampleScreen({ me, id, onBack, onOpenReserve, backTo = 'Samples' }: { me: Me; id: number; onBack: () => void; onOpenReserve?: (id: number) => void; backTo?: string }) {
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
      <button className="link dark" onClick={onBack}>← {backTo}</button>
      <div className="home-head">
        <div>
          <h1>{s.sampleNo} <span className={STATUS_CHIP[d.status]}>{STATUS_LABEL[d.status]}</span></h1>
          <p className="greeting"><b>{s.item.code}</b> {s.item.name} · {LOT_WORD[s.item.of].toLowerCase()} {s.lotNo}</p>
        </div>
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      <section className="dash-panel samples-waiting" aria-label="The sample">
        <dl className="details">
          <dt>{LOT_WORD[s.item.of]}</dt><dd>{s.lotNo}</dd>
          <dt>Source</dt><dd>{sourceWords(s.source)}</dd>
          {s.request && <><dt>In-process request</dt><dd>{s.request.requestId}: {[s.request.stageTitle, s.request.stepTitle].filter(Boolean).join(' › ')} · {s.request.tests.map((t) => t.label).join(', ')}</dd></>}
          <dt>Quantity</dt><dd>{s.quantity}{s.containers ? ` from ${s.containers} container${s.containers === 1 ? '' : 's'}` : ''}</dd>
          <dt>Purpose</dt><dd>{PURPOSE_LABEL[s.purpose]}</dd>
          {s.sampling && <><dt>Sampling plan</dt><dd>{s.sampling.line} · containers sampled: {s.sampling.numbers.join(', ')}
            {SAMPLING_DETAILS.filter(([k]) => s.sampling!.details[k]).map(([k, label]) => <span key={k} className="cell-sub">{label}: {s.sampling!.details[k]}</span>)}</dd></>}
          {s.stability && <><dt>Stability study</dt><dd>{s.stability.studyNo}, {s.stability.label}, {s.stability.month} months</dd></>}
          {s.monitoring && <><dt>Monitoring</dt><dd>Plan {s.monitoring.planNumber} version {s.monitoring.planVersionNo} · point {s.monitoring.pointCode} {s.monitoring.pointName} · {s.monitoring.kind}
            {s.monitoring.state ? `, ${s.monitoring.state}` : ''}{s.monitoring.grade ? ` · grade ${s.monitoring.grade}` : ''} · taken {s.monitoring.takenOn}{s.monitoring.shift ? `, shift ${s.monitoring.shift}` : ''}
            {s.monitoring.batch ? ` · batch ${s.monitoring.batch}` : ''}{s.monitoring.person ? ` · ${s.monitoring.person}` : ''}</dd></>}
          <dt>Registered</dt><dd>{s.registeredByName}, {plantTime(s.registeredAt)}</dd>
          {d.spec && (<><dt>Specification</dt><dd>{d.spec.header.number}, version {d.spec.versionNo} · {d.spec.header.pharmacopoeia}{d.spec.header.edition ? ` ${d.spec.header.edition}` : ''}{d.spec.state !== 'effective' ? ` (now ${d.spec.state})` : ''}</dd></>)}
        </dl>
        {/* LIMS-06: the sample's label and a label for each container sampled, printed from the record. */}
        <div className="actions-row"><a className="button" href={labelsLink(s.id)} download>Print labels (PDF)</a></div>
      </section>
      {d.spec && <Tests d={d} me={me} reload={load} />}
      {d.spec && <FormsPanel d={d} me={me} reload={load} />}
      <ReservePanel d={d} me={me} reload={load} onOpen={(r) => onOpenReserve?.(r)} />
      {d.spec && <Decision d={d} me={me} reload={load} />}
      <section className="dash-panel samples-waiting" aria-label="Chain of custody">
        <div className="panel-head"><h2>Chain of custody</h2></div>
        <ol className="custody">
          <li><b>Registered</b><span className="muted">{s.registeredByName}, {plantTime(s.registeredAt)}</span></li>
          {d.events.map((e) => (
            <li key={e.id}>
              <b>{ENTRY_WORDS[e.kind]}</b>
              {entryText(e) && <span>{entryText(e)}</span>}
              <span className="muted"> {e.personName}, {plantTime(e.at)}{e.signature ? ` · signed “${SIGNED_WORDS[e.signature.meaning] ?? e.signature.meaning}” by ${e.signature.printedName}` : ''}</span>
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

/**
 * The specification's tests (LIMS-11): each with its limit, whether it applies to this sample, its analyses (status and
 * result once worked out, pass or fail against the limit), and the methods to start an analysis by, once the sample is
 * in QC.
 */
function Tests({ d, me, reload }: { d: SampleDetail; me: Me; reload: () => Promise<void> }) {
  const [starting, setStarting] = useState<SampleDetail['methods'][number] | null>(null);
  const [outside, setOutside] = useState(false);
  const [certificate, setCertificate] = useState(false);
  // LIMS-08: a starting material's identity is tested on each container: the container is picked when its analysis starts.
  const [container, setContainer] = useState<number | undefined>(undefined);
  const n = d.identityContainers;
  const inQc = ['received', 'stored', 'handed over'].includes(d.status);
  const may = can(me, 'analysis.perform');
  return (
    <section className="dash-panel samples-waiting" aria-label="Tests">
      <div className="panel-head"><h2>Tests</h2><span className="muted">{d.spec!.header.number}, version {d.spec!.versionNo}</span></div>
      <div className="table-wrap">
        <table className="masters">
          <thead><tr><th>Test</th><th>Analyses and results</th></tr></thead>
          <tbody>
            {d.spec!.tests.map((t, i) => (
              <tr key={t.key} className={t.applies ? '' : 'muted'}>
                <td><b>{t.name}</b><span className="cell-sub">{testText(t, i).replace(/^\d+\. [^:]*: /, '')}{t.applies ? '' : ' · not for this sample'}</span></td>
                <td>{n !== null && t.identity && t.applies && <span className="cell-sub">On each of {n} containers: {Array.from({ length: n }, (_, k) => k + 1).map((c) => `${c} ${t.analyses.some((a) => a.container === c && a.status === 'reviewed') ? '✓' : '·'}`).join('  ')}</span>}
                  {t.analyses.length ? t.analyses.map((a) => a.outside ? <OutsideLine key={`o${a.outside.id}`} d={d} a={a} me={me} reload={reload} /> : (
                  <div key={a.analysisId}><a href={analysisLink(a.analysisId)}>{a.analysisNo}</a>{a.container ? ` · container ${a.container}` : ''} · {a.status}
                    {a.result && <> · <b>{a.result.value} {a.result.unit}</b>{a.result.pass !== undefined && <span className={`chip ${a.result.pass ? 'chip-ok' : 'chip-bad'}`}>{a.result.pass ? 'within limits' : 'out of limits'}</span>}</>}
                    {d.oot.some((x) => x.key === t.key && x.analysisNo === a.analysisNo) && <span className="chip chip-warn">out of trend</span>}
                    {d.oos.filter((o) => o.testKey === t.key && o.analysisNo === a.analysisNo).map((o) => <a key={o.id} className="chip chip-bad" href={oosLink(o.id)}>{o.oosNo} · {o.status}</a>)}
                  </div>)) : <span className="muted">{t.applies ? 'not started' : '—'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {may && d.methods.length > 0 && (
        <div className="actions-row">
          {inQc ? d.methods.map((m) => <button key={m.masterId} onClick={() => setStarting(m)}>Start {m.code} {m.name}</button>)
            : <p className="muted small">Analyses start once QC has received the sample.</p>}
          {inQc && !d.decision && <button onClick={() => setOutside(true)}>Outside lab result</button>}
          {inQc && !d.decision && d.reducedTesting?.recorded && <button onClick={() => setCertificate(true)}>Supplier's certificate result</button>}
          {inQc && n !== null && <label className="small">Identity of container<select aria-label="Identity of container" value={container ?? ''} onChange={(e) => setContainer(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">— (other tests)</option>{Array.from({ length: n }, (_, k) => <option key={k} value={k + 1}>{k + 1}</option>)}</select></label>}
        </div>
      )}
      {starting && <IssueDialog row={{ id: starting.versionId, versionNo: starting.versionNo, header: { code: starting.code, name: starting.name } }} sampleId={d.sample.id} sampleNo={d.sample.sampleNo} container={container} onCancel={() => setStarting(null)} />}
      {outside && <OutsideDialog d={d} onCancel={() => setOutside(false)} onDone={() => { setOutside(false); void reload(); }} />}
      {certificate && d.reducedTesting?.recorded && <OutsideDialog d={d} certificate={d.reducedTesting.recorded.payload} onCancel={() => setCertificate(false)} onDone={() => { setCertificate(false); void reload(); }} />}
      {d.reducedTesting && <Reduced d={d} reload={reload} />}
    </section>
  );
}

/**
 * LIMS-09: reduced testing on the supplier's certificate: recorded (with its basis as pulled), or what stands in the way,
 * or QC records it. Identity is always tested here; every n-th lot and at least every m months a lot is tested in full.
 */
function Reduced({ d, reload }: { d: SampleDetail; reload: () => Promise<void> }) {
  const r = d.reducedTesting!;
  const [error, setError] = useState('');
  const basis = (b: ReducedBasis) => `Manufacturer ${b.manufacturer}${b.manufacturerBatchNo ? `, batch ${b.manufacturerBatchNo}` : ''}; supplier ${b.supplier}${b.broker ? ' (a broker: the certificate must be the manufacturer\'s own)' : ''}; QMS approval ${b.approval ?? '—'}${b.approvedUntil ? ` until ${plantDate(b.approvedUntil)}` : ''}; last full test ${b.lastFull ?? '—'}.`;
  return (
    <div className="card" aria-label="Reduced testing">
      <h3>Reduced testing (supplier's certificate)</h3>
      <p className="muted small">Full testing every {r.interval.fullEvery} lots and at least every {r.interval.months} months; identity always tested here.</p>
      {r.recorded ? <p><span className="chip chip-info">tested on the certificate</span> Recorded by {r.recorded.personName}, {plantTime(r.recorded.at)}. {basis(r.recorded.payload)}</p>
        : r.problems.length ? <><p>This lot is tested in full:</p><ul>{r.problems.map((x) => <li key={x}>{x}</li>)}</ul></>
        : <><p>{r.basis && basis(r.basis)}</p>
          <button className="primary" onClick={async () => { try { await recordReduced(d.sample.id); await reload(); } catch (e) { setError(plainError(e)); } }}>Test this lot on the supplier's certificate</button></>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * QC's decision (LIMS-20, LIMS-21): approve (e-signature "QC approved", a CoA number is given) when every test that applies
 * has a reviewed result within its limit; reject with a reason (e-signature "rejected") at any time. Once approved, the
 * certificate of analysis downloads here.
 */
function Decision({ d, me, reload }: { d: SampleDetail; me: Me; reload: () => Promise<void> }) {
  const [signing, setSigning] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const decided = d.events.find((e) => e.kind === 'approved' || e.kind === 'rejected');
  const may = can(me, 'qc.approve');
  return (
    <section className="dash-panel samples-waiting" aria-label="QC decision">
      <div className="panel-head"><h2>QC decision</h2>{d.decision === 'approved' && <a className="button" href={coaLink(d.sample.id)} download>{reportName(d.sample.purpose, d.sample.item.of)} (PDF)</a>}</div>
      {decided && (
        <p className={decided.kind === 'approved' ? 'all-good' : 'notice bad'}><span aria-hidden="true">{decided.kind === 'approved' ? '✓' : '✕'}</span>
          {decided.kind === 'approved' ? `Approved, ${reportWord(d.sample.purpose, d.sample.item.of)} ${decided.payload.coaNo}` : `Rejected: ${decided.payload.reason}`} · {decided.signature?.printedName ?? decided.personName}, {plantTime(decided.signature?.signedAt ?? decided.at)}</p>
      )}
      <OosBlocks d={d} reload={reload} />
      {decided ? null : !may ? <p className="muted">QC decides when every test has a reviewed result.</p> : (<>
        {d.approvalProblems.length > 0 && <div className="notice" role="note"><p><b>Not ready for approval:</b></p><ul>{d.approvalProblems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
        {error && <p className="notice bad" role="alert">{error}</p>}
        <div className="decide">
          <p className="why">Your signature means: every test of the specification that applies has a reviewed result within its limit; the sample is approved and its {reportWord(d.sample.purpose, d.sample.item.of)} issued.</p>
          <button className="big ok" disabled={d.approvalProblems.length > 0} onClick={() => setSigning('approve')}>Sign: QC approved</button>
        </div>
        <div className="decide reject">
          <label>Reason for rejection<textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></label>
          <button className="big soft-bad" disabled={!reason.trim() || !!d.rejectionRefusal} onClick={() => setSigning('reject')}>Sign: rejected</button>
        </div>
      </>)}
      {signing && (
        <SignDialog meaning={signing === 'approve' ? 'qc_approved' : 'rejected'} what={`Sample ${d.sample.sampleNo} · ${d.sample.item.code} ${d.sample.item.name} · ${d.sample.lotNo}`}
          onCancel={() => setSigning(null)}
          onSign={async ({ proof }) => {
            try {
              await decide(d.sample.id, signing, { proof, contentHash: d.decisionHash, ...(signing === 'reject' ? { reason: reason.trim() } : {}) });
              setSigning(null);
              await reload();
            } catch (e) { setSigning(null); setError(plainError(e)); }
          }}>
          <div className="summary-box">{signing === 'reject' ? <p>Reason: <b>{reason.trim()}</b></p> : <p>{d.spec!.tests.filter((t) => t.applies).length} tests, each with a reviewed result within its limit.</p>}</div>
        </SignDialog>
      )}
    </section>
  );
}

/**
 * What stands in the decision's way from OOS and OOT (LIMS-23, LIMS-25): each OOS of the sample with its status (a link
 * to it), and each out-of-trend result with QC's answer, or the form to answer it (no action, or investigation, with
 * the reason).
 */
function OosBlocks({ d, reload }: { d: SampleDetail; reload: () => Promise<void> }) {
  const [form, setForm] = useState<Record<string, { answer: 'no action' | 'investigation'; reason: string }>>({});
  const [error, setError] = useState('');
  if (!d.oos.length && !d.oot.length) return null;
  return (
    <div className="oos-blocks">
      {d.oos.map((o) => (
        <p key={o.id} className={o.status === 'invalidated' ? 'notice info' : 'notice bad'}>
          <a href={oosLink(o.id)}><b>{o.oosNo}</b></a> · {o.testName}, analysis {o.analysisNo} · {o.status === 'open' ? `open (${o.detail})` : o.status === 'confirmed' ? 'OOS confirmed: the sample can only be rejected' : 'invalidated (laboratory error): the analysis no longer counts'}
        </p>
      ))}
      {d.oot.map((t) => (
        <div key={t.key} className={t.answer ? 'notice info' : 'notice'}>
          <p><b>Out of trend:</b> {t.name} {t.shown} ({t.trend}), analysis {t.analysisNo}.</p>
          {t.answer ? <p>QC answered: <b>{t.answer.payload.answer}</b> · {t.answer.payload.reason} · {t.answer.personName}, {plantTime(t.answer.at)}</p>
            : d.decision ? null : d.ootRefusal ? <p className="muted small">{d.ootRefusal}</p> : (
            <div className="decide">
              <label>Answer<select aria-label={`Answer the out-of-trend flag of ${t.name}`} value={form[t.key]?.answer ?? 'no action'} onChange={(e) => setForm((f) => ({ ...f, [t.key]: { reason: f[t.key]?.reason ?? '', answer: e.target.value as 'no action' } }))}>
                <option value="no action">No action</option><option value="investigation">Investigation</option></select></label>
              <label>Reason<input aria-label={`Reason for the answer on ${t.name}`} value={form[t.key]?.reason ?? ''} onChange={(e) => setForm((f) => ({ ...f, [t.key]: { answer: f[t.key]?.answer ?? 'no action', reason: e.target.value } }))} /></label>
              <button className="primary" disabled={!form[t.key]?.reason.trim()} onClick={async () => {
                try { await answerOot(d.sample.id, { test: t.key, answer: form[t.key]!.answer, reason: form[t.key]!.reason.trim() }); setError(''); await reload(); } catch (e) { setError(plainError(e)); }
              }}>Record the answer</button>
            </div>)}
        </div>
      ))}
      {error && <p className="notice bad" role="alert">{error}</p>}
    </div>
  );
}
