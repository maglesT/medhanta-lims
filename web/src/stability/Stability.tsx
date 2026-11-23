// Stability (LIMS-26, LIMS-27, LIMS-28; plan 2.6 and 2b): the studies with their next pulls, what is due this week and
// overdue, the on-going stability flags; the protocols (written, checked and approved as specifications); the chamber
// excursions; the chamber capacity. One screen per job: a protocol (ProtocolEditor), a study (StudyScreen).
import { useEffect, useState, type FormEvent } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { STATE_CHIP, STATE_LABEL, loadMasterData, newVersion, type MasterData } from '../api-designer.js';
import { plantDate } from '../../../shared/plant-time.js';
import { PURPOSE_WORDS, protocolSchema, type ProtocolDoc } from '../../../shared/master/protocol.js';
import { ANY_PACK } from '../../../shared/engine/stability.js';
import { Picker } from '../designer/ui.js';
import {
  answerOngoing, batchesFor, listEvaluated, createProtocol, effectiveProtocols, excursionAction, getCapacity, getOngoing, listChambers, listExcursions, listProtocols, listStudies,
  recordExcursion, startStudy, STATE_CHIPS, STATE_WORDS, type Capacity, type Chamber, type Excursion, type Ongoing, type ProtocolRow, type Studies,
} from './api-stability.js';
import { ProtocolEditor } from './ProtocolEditor.js';
import { StudyScreen } from './StudyScreen.js';
import { ProductEvaluation } from './Evaluation.js';
import '../designer/designer.css';
import '../samples/samples.css';

type Tab = 'studies' | 'evaluation' | 'protocols' | 'excursions' | 'capacity';

export function Stability({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('studies');
  const [study, setStudy] = useState<number | null>(null);
  const [protocol, setProtocol] = useState<number | null>(null);
  const [product, setProduct] = useState<{ of: 'product' | 'material'; itemId: string } | null>(null);
  if (study !== null) return <StudyScreen me={me} id={study} onBack={() => setStudy(null)} onProduct={(p) => { setStudy(null); setProduct(p); }} />;
  if (product !== null) return <ProductEvaluation me={me} {...product} onBack={() => setProduct(null)} onOpenStudy={(id) => { setProduct(null); setStudy(id); }} />;
  if (protocol !== null) return <ProtocolEditor me={me} versionId={protocol} onBack={() => setProtocol(null)} onOpen={setProtocol} />;
  return (
    <>
      <div className="home-head">
        <div>
          <h1>Stability</h1>
          <p className="greeting">Studies placed by approved protocols, pulled on schedule from chambers the Logbook says are fit. Dates are plant dates (IST).</p>
        </div>
      </div>
      <nav className="subtabs" aria-label="Stability">
        {([['studies', 'Studies'], ['evaluation', 'Evaluation'], ['protocols', 'Protocols'], ['excursions', 'Excursions'], ['capacity', 'Chamber capacity']] as const).map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>))}
      </nav>
      {tab === 'studies' && <StudiesTab me={me} onOpen={setStudy} />}
      {tab === 'evaluation' && <EvaluationTab onOpen={setProduct} />}
      {tab === 'protocols' && <ProtocolsTab me={me} onOpen={setProtocol} />}
      {tab === 'excursions' && <ExcursionsTab me={me} />}
      {tab === 'capacity' && <CapacityTab />}
    </>
  );
}

/** The products and materials on stability, with their latest signed shelf life or retest period (LIMS-29). */
function EvaluationTab({ onOpen }: { onOpen: (p: { of: 'product' | 'material'; itemId: string }) => void }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listEvaluated>> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { listEvaluated().then(setRows, (e) => setError(plainError(e))); }, []);
  if (error) return <p className="notice" role="alert">{error}</p>;
  if (!rows) return <div className="skel skel-block" />;
  if (!rows.length) return <div className="card placeholder"><p>No studies yet.</p></div>;
  return (
    <div className="table-wrap">
      <table className="masters" aria-label="Products on stability">
        <thead><tr><th>Product or material</th><th>Studies</th><th>Signed shelf life or retest period</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.of}:${r.itemId}`} className="clickable" onClick={() => onOpen({ of: r.of, itemId: r.itemId })}>
              <td><b>{r.code}</b> {r.name}<span className="cell-sub">{r.of}</span></td><td>{r.studies}</td>
              <td>{r.months === null ? 'Not evaluated yet' : `${r.months} months (${r.of === 'material' ? 'retest period' : 'shelf life'})`}</td>
            </tr>))}
        </tbody>
      </table>
    </div>
  );
}

function StudiesTab({ me, onOpen }: { me: Me; onOpen: (id: number) => void }) {
  const [d, setD] = useState<Studies | null>(null);
  const [ongoing, setOngoing] = useState<Ongoing | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [answering, setAnswering] = useState<{ productCode: string; pack: string } | null>(null);
  const load = () => {
    listStudies().then(setD, (e) => setError(plainError(e)));
    getOngoing().then(setOngoing, (e) => setError(plainError(e)));
  };
  useEffect(load, []);
  const overdue = (d?.due ?? []).filter((x) => x.state === 'overdue');
  const week = (d?.due ?? []).filter((x) => x.state !== 'overdue');
  const flags = (ongoing?.flags ?? []).filter((f) => f.flag);
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {can(me, 'sample.register') && <p><button className="primary" onClick={() => setStarting(true)}>New study</button></p>}
      <section className="dash-panel samples-waiting" aria-label="Pulls due">
        <div className="panel-head"><h2>Pulls due</h2><span className="pill">{d ? d.due.length : '…'}</span></div>
        {d && !d.due.length && <p className="muted">Nothing due this week, nothing overdue.</p>}
        {[['Overdue', overdue], ['Due this week', week]].map(([title, rows]) => (rows as Studies['due']).length > 0 && (
          <div key={title as string} className="table-wrap">
            <table className="masters" aria-label={title as string}>
              <caption>{title as string}</caption>
              <thead><tr><th>Study</th><th>Batch</th><th>Condition</th><th>Time point</th><th>Due</th><th>Window</th><th>State</th></tr></thead>
              <tbody>
                {(rows as Studies['due']).map((p) => (
                  <tr key={`${p.studyId}:${p.condition}:${p.month}`} className="clickable" onClick={() => onOpen(p.studyId)}>
                    <td><b>{p.studyNo}</b></td><td>{p.lotNo}<span className="cell-sub">{p.item.code}</span></td><td>{p.label}</td><td>{p.month} months</td>
                    <td>{plantDate(p.due)}</td><td>{plantDate(p.from)} to {plantDate(p.to)}</td><td><span className={STATE_CHIPS[p.state]}>{STATE_WORDS[p.state]}</span></td>
                  </tr>))}
              </tbody>
            </table>
          </div>))}
      </section>
      <section className="dash-panel samples-waiting" aria-label="On-going stability">
        <div className="panel-head"><h2>On-going stability {ongoing?.year}</h2><span className="pill">{flags.length}</span></div>
        <p className="muted small">At least one batch a year per strength and primary pack (LIMS-27), from the batches TrueBatch released this year.
          {ongoing && ongoing.link !== 'ok' && ` TrueBatch ${ongoing.link === 'down' ? 'does not answer' : 'is not linked'}: no batches are read.`}</p>
        {ongoing && ongoing.flags.length > 0 && (
          <ul className="link-states">
            {ongoing.flags.map((f) => (
              <li key={`${f.productCode}:${f.pack}`} className={f.flag ? 'off' : 'ok'}>
                <b>{f.productCode}</b> {f.productName}{f.pack ? ` · ${f.pack}` : ''} · released {f.released.join(', ')}
                {f.studies.length > 0 && <span> · on study: {f.studies.join(', ')}</span>}
                {f.answer && <span> · QA: {f.answer.text} ({f.answer.by})</span>}
                {f.flag && <span className="chip chip-warn">{f.flag}</span>}
                {f.flag && can(me, 'qc.approve') && <button className="link dark" onClick={() => setAnswering({ productCode: f.productCode, pack: f.pack ?? ANY_PACK })}>Record why not</button>}
              </li>))}
          </ul>)}
      </section>
      <h2>Studies</h2>
      {d === null ? <div className="skel skel-block" /> : !d.studies.length ? <div className="card placeholder"><p>No studies yet.</p></div> : (
        <div className="table-wrap">
          <table className="masters" aria-label="Studies">
            <thead><tr><th>Study</th><th>Batch</th><th>Protocol</th><th>Placed</th><th>Pulled</th><th>Next pull</th></tr></thead>
            <tbody>
              {d.studies.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => onOpen(s.id)}>
                  <td><b>{s.studyNo}</b>{s.byHand && <span className="cell-sub">typed by hand</span>}</td>
                  <td>{s.lotNo}<span className="cell-sub">{s.item.code} {s.item.name}</span></td>
                  <td>{s.protocolNumber}, version {s.protocolVersionNo}<span className="cell-sub">{s.purpose} · {s.pack}</span></td>
                  <td>{plantDate(s.t0)}</td>
                  <td>{s.pulled} of {s.total}{s.overdue > 0 && <span className="chip chip-bad">{s.overdue} overdue</span>}</td>
                  <td>{s.next ? <>{s.next.label}, {s.next.month} months<span className="cell-sub">due {plantDate(s.next.due)}</span></> : 'Complete'}</td>
                </tr>))}
            </tbody>
          </table>
        </div>)}
      {starting && <NewStudy onCancel={() => setStarting(false)} onDone={(id) => { setStarting(false); onOpen(id); }} />}
      {answering && (
        <TextDialog title={`Why no on-going study: ${answering.productCode}`} label="Reason (QA)" onCancel={() => setAnswering(null)}
          onSubmit={async (text) => { await answerOngoing({ ...answering, text }); setAnswering(null); load(); }} />
      )}
    </>
  );
}

/** A dialog asking for one text. */
export function TextDialog({ title, label, onSubmit, onCancel, children }: { title: string; label: string; onSubmit: (text: string) => Promise<void>; onCancel: () => void; children?: React.ReactNode }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <form className="card dialog" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (!text.trim()) return setError('Write it.'); try { await onSubmit(text.trim()); } catch (x) { setError(plainError(x)); } }}>
        <h2>{title}</h2>
        {children}
        <label>{label}<textarea aria-label={label} autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Save</button></div>
      </form>
    </div>
  );
}

/** A new study: an effective protocol, a batch read from TrueBatch (a lot from MMS), each condition in a fit chamber. */
function NewStudy({ onDone, onCancel }: { onDone: (id: number) => void; onCancel: () => void }) {
  const [protocols, setProtocols] = useState<{ id: number; versionNo: number; doc: ProtocolDoc }[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [batches, setBatches] = useState<Awaited<ReturnType<typeof batchesFor>> | null>(null);
  const [chambers, setChambers] = useState<Chamber[]>([]);
  const [batch, setBatch] = useState('');
  const [cell, setCell] = useState('');
  const [place, setPlace] = useState<Record<string, { chamber: string; quantity: string }>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { effectiveProtocols().then(setProtocols, (e) => setError(plainError(e))); listChambers().then(setChambers, (e) => setError(plainError(e))); }, []);
  useEffect(() => { if (pick) batchesFor(pick).then(setBatches, (e) => setError(plainError(e))); }, [pick]);
  const p = protocols?.find((x) => x.id === pick);
  const byHand = !!batches && batches.link !== 'ok';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!p || !batch.trim()) return setError('Pick the protocol and the batch.');
    setBusy(true);
    try {
      onDone((await startStudy({ protocolVersionId: p.id, batchNumber: batch.trim(), byHand, ...(cell ? { cell } : {}),
        placements: p.doc.conditions.map((c) => ({ condition: c.key, chamberItemId: place[c.key]?.chamber ?? '', quantity: place[c.key]?.quantity ?? '' })) })).id);
    } catch (x) { setError(plainError(x)); setBusy(false); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="New study">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>New stability study</h2>
        <label>Protocol
          <select aria-label="Protocol" value={pick ?? ''} onChange={(e) => { setPick(Number(e.target.value) || null); setBatch(''); setPlace({}); }}>
            <option value="">(choose an effective protocol)</option>
            {(protocols ?? []).map((x) => <option key={x.id} value={x.id}>{x.doc.header.number} · {x.doc.header.code} {x.doc.header.name} · {x.doc.header.containerClosure} (version {x.versionNo})</option>)}
          </select>
        </label>
        {p && batches && (byHand ? (
          <label>{batches.from === 'truebatch' ? 'Batch' : 'Lot'} (typed by hand: {batches.from === 'truebatch' ? 'TrueBatch' : 'MMS'} {batches.link === 'down' ? 'does not answer' : 'is not linked'}; a second person checks the study)
            <input aria-label="Batch number" value={batch} onChange={(e) => setBatch(e.target.value)} /></label>
        ) : (
          <label>{batches.from === 'truebatch' ? 'Batch (from TrueBatch)' : 'Lot (from MMS)'}
            <select aria-label="Batch" value={batch} onChange={(e) => setBatch(e.target.value)}>
              <option value="">(choose)</option>
              {batches.batches.map((b) => <option key={b.number} value={b.number}>{b.shown}</option>)}
            </select>
          </label>))}
        {p && p.doc.design.matrix.length > 0 && (
          <label>Matrix cell<select aria-label="Matrix cell" value={cell} onChange={(e) => setCell(e.target.value)}>
            <option value="">(choose)</option>{[...new Set(p.doc.design.matrix.map((m) => m.cell))].map((c) => <option key={c}>{c}</option>)}</select></label>)}
        {p && (
          <table className="masters" aria-label="Placement">
            <thead><tr><th>Condition</th><th>Chamber</th><th>Placed ({p.doc.quantity.unit})</th></tr></thead>
            <tbody>
              {p.doc.conditions.map((c) => (
                <tr key={c.key}>
                  <td>{c.code === 'other' ? c.other : c.code} · {c.months.length} time points<span className="cell-sub">needs {c.months.length * Number(p.doc.quantity.amount)} {p.doc.quantity.unit}</span></td>
                  <td><select aria-label={`Chamber for ${c.key}`} value={place[c.key]?.chamber ?? ''} onChange={(e) => setPlace({ ...place, [c.key]: { quantity: place[c.key]?.quantity ?? '', chamber: e.target.value } })}>
                    <option value="">(choose)</option>
                    {chambers.map((ch) => <option key={ch.itemId} value={ch.itemId} disabled={ch.fit === false}>{ch.code} {ch.name}{ch.fit === false ? `: ${ch.why}` : ch.link !== 'ok' ? ' (LEAD not read: label checked by hand)' : ''}</option>)}
                  </select></td>
                  <td><input aria-label={`Quantity for ${c.key}`} inputMode="decimal" value={place[c.key]?.quantity ?? ''} onChange={(e) => setPlace({ ...place, [c.key]: { chamber: place[c.key]?.chamber ?? '', quantity: e.target.value.trim() } })} /></td>
                </tr>))}
            </tbody>
          </table>)}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit" disabled={busy || !p}>Place the study</button></div>
      </form>
    </div>
  );
}

function ProtocolsTab({ me, onOpen }: { me: Me; onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<ProtocolRow[] | null>(null);
  const [md, setMd] = useState<MasterData | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const author = can(me, 'master.author');
  useEffect(() => { listProtocols().then(setRows, (e) => setError(plainError(e))); loadMasterData().then(setMd, (e: Error) => setError(e.message)); }, []);
  const pending = (masterId: number) => rows?.some((r) => r.masterId === masterId && ['draft', 'in_review', 'approved'].includes(r.state));
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {author && <p><button className="primary" disabled={!md} onClick={() => setCreating(true)}>New protocol</button></p>}
      {rows === null ? <div className="skel skel-block" /> : !rows.length ? <div className="card placeholder"><p>No protocols yet.</p></div> : (
        <div className="table-wrap">
          <table className="masters" aria-label="Protocols">
            <thead><tr><th>Protocol</th><th>For</th><th>Purpose</th><th>Version</th><th>State</th><th>Written by</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                  <td><b>{r.header.number}</b><span className="cell-sub">{r.header.containerClosure}</span></td>
                  <td><b>{r.header.code}</b><span className="cell-sub">{r.header.name}</span></td>
                  <td>{PURPOSE_WORDS[r.header.purpose]}</td><td>{r.versionNo}</td>
                  <td><span className={STATE_CHIP[r.state]}>{STATE_LABEL[r.state]}</span></td>
                  <td>{r.createdByName}<span className="cell-sub">{plantTime(r.createdAt)}</span></td>
                  <td><span className="actions-cell" onClick={(e) => e.stopPropagation()}>
                    {author && r.state === 'effective' && !pending(r.masterId) && <button onClick={async () => { try { onOpen((await newVersion(r.masterId)).id); } catch (e) { setError(plainError(e)); } }}>New version</button>}
                  </span></td>
                </tr>))}
            </tbody>
          </table>
        </div>)}
      {creating && md && <NewProtocol md={md} onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
    </>
  );
}

/** A new protocol: what it is for (picked from master data), its number and purpose; the rest in the editor. */
function NewProtocol({ md, onCreated, onCancel }: { md: MasterData; onCreated: (id: number) => void; onCancel: () => void }) {
  const [of, setOf] = useState<'product' | 'material'>('product');
  const [item, setItem] = useState<{ id: string; code: string; name: string } | null>(null);
  const [number, setNumber] = useState('');
  const [purpose, setPurpose] = useState<ProtocolDoc['header']['purpose']>('registration');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!item) return setError(`Pick the ${of}.`);
    const doc = protocolSchema.safeParse({
      header: { of, itemId: item.id, code: item.code, name: item.name, number, purpose, containerClosure: '', sameAsMarketed: true, shelfLifeMonths: 24 },
      spec: null, quantity: { amount: '0', unit: 'tablets' }, pullWindowDays: 7, conditions: [], design: { type: 'full', factors: [], matrix: [] },
    });
    if (!doc.success) return setError(doc.error.issues.map((i) => `${String(i.path.at(-1))}: ${i.message}`).join('; '));
    try { onCreated((await createProtocol(doc.data)).id); } catch (x) { setError(plainError(x)); }
  };
  const items = (of === 'product' ? md.products : md.materials).filter((i) => i.active).map((i) => ({ id: i.itemId, code: i.code, name: i.name }));
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="New protocol">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>New stability protocol</h2>
        <fieldset className="checklist">
          <legend>For</legend>
          <label className="check route"><input type="radio" name="of" checked={of === 'product'} onChange={() => { setOf('product'); setItem(null); }} /><span>A product</span></label>
          <label className="check route"><input type="radio" name="of" checked={of === 'material'} onChange={() => { setOf('material'); setItem(null); }} /><span>A material (active substance)</span></label>
        </fieldset>
        {item ? <p><b>{item.code}</b> {item.name} <button type="button" className="link dark" onClick={() => setItem(null)}>Change</button></p>
          : <Picker label={of === 'product' ? 'Product' : 'Material'} items={items} onPick={(i) => setItem(i)} />}
        <div className="form-grid">
          <label>Protocol number<input aria-label="Protocol number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. STP-FG-001" /></label>
          <label>Purpose<select aria-label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)}>
            {Object.entries(PURPOSE_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Create draft</button></div>
      </form>
    </div>
  );
}

function ExcursionsTab({ me }: { me: Me }) {
  const [rows, setRows] = useState<Excursion[] | null>(null);
  const [error, setError] = useState('');
  const [entering, setEntering] = useState(false);
  const [assessing, setAssessing] = useState<number | null>(null);
  const load = () => listExcursions().then(setRows, (e) => setError(plainError(e)));
  useEffect(() => { void load(); }, []);
  const act = async (id: number, action: 'check' | 'assess', b: object) => { try { await excursionAction(id, action, b); await load(); } catch (e) { setError(plainError(e)); } };
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {can(me, 'sample.register') && <p><button className="primary" onClick={() => setEntering(true)}>Enter an excursion</button></p>}
      {rows === null ? <div className="skel skel-block" /> : !rows.length ? <div className="card placeholder"><p>No chamber excursions.</p></div> : rows.map((x) => (
        <section key={x.id} className="dash-panel samples-waiting" aria-label={`Excursion of ${x.chamber.code}`}>
          <div className="panel-head"><h2>{x.chamber.code} {x.chamber.name}</h2><span className="pill">{x.deviation}</span></div>
          <dl className="details">
            <dt>Period</dt><dd>{plantTime(x.fromAt)} to {plantTime(x.toAt)}</dd>
            <dt>Readings</dt><dd>{x.readings.length}{x.range ? `, ${x.range.min} to ${x.range.max} °C` : ''}</dd>
            <dt>Mean kinetic temperature</dt><dd>{x.mkt.ok ? <><b>{x.mkt.value}</b><span className="cell-sub">{x.mkt.shown}</span></> : x.mkt.message}</dd>
            <dt>Deviation</dt><dd>{x.deviation}{x.deviationSource.from === 'hand' ? ' (typed by hand: DIVE not read)' : ''}</dd>
            <dt>Entered</dt><dd>{x.recordedByName}, {plantTime(x.recordedAt)}</dd>
            <dt>Checked</dt><dd>{x.checked ? `${x.checked.personName}, ${plantTime(x.checked.at)}` : 'Not yet: a second person checks the readings.'}</dd>
            <dt>Impact</dt><dd>{x.assessed ? `${x.assessed.payload.text} (${x.assessed.personName}, ${plantTime(x.assessed.at)})` : 'Not assessed yet.'}</dd>
            <dt>Studies affected</dt><dd>{x.affected.length ? x.affected.map((a) => `${a.studyNo} ${a.condition}: ${a.months.join(', ')} months`).join('; ') : 'None'}</dd>
          </dl>
          <div className="sample-actions">
            {!x.checked && <button className="primary" disabled={!!x.checkRefusal} title={x.checkRefusal ?? ''} onClick={() => void act(x.id, 'check', {})}>Check (second person)</button>}
            {x.checked && !x.assessed && <button className="primary" disabled={!!x.assessRefusal} title={x.assessRefusal ?? ''} onClick={() => setAssessing(x.id)}>Assess the impact</button>}
            {(x.checkRefusal && !x.checked) && <span className="muted small">{x.checkRefusal}</span>}
          </div>
        </section>))}
      {entering && <NewExcursion onCancel={() => setEntering(false)} onDone={() => { setEntering(false); void load(); }} />}
      {assessing !== null && <TextDialog title="Assess the impact" label="Impact on the samples" onCancel={() => setAssessing(null)}
        onSubmit={async (text) => { await excursionAction(assessing, 'assess', { text }); setAssessing(null); await load(); }} />}
    </>
  );
}

/** An excursion as the chamber's record shows it: the period, readings at equal intervals (one per line "date time, °C, %RH"). */
function NewExcursion({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [chambers, setChambers] = useState<Chamber[]>([]);
  const [v, setV] = useState({ chamber: '', from: '', to: '', deviation: '', readings: '' });
  const [error, setError] = useState('');
  useEffect(() => { listChambers().then(setChambers, (e) => setError(plainError(e))); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const readings = v.readings.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [at, temperature, humidity] = l.split(',').map((x) => x.trim());
      return { at: (at ?? '').replace(' ', 'T'), temperature: temperature ?? '', ...(humidity ? { humidity } : {}) };
    });
    try { await recordExcursion({ chamberItemId: v.chamber, from: v.from, to: v.to, deviation: v.deviation, readings }); onDone(); } catch (x) { setError(plainError(x)); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Enter an excursion">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>Chamber excursion</h2>
        <div className="form-grid">
          <label>Chamber<select aria-label="Chamber" value={v.chamber} onChange={(e) => setV({ ...v, chamber: e.target.value })}>
            <option value="">(choose)</option>{chambers.map((c) => <option key={c.itemId} value={c.itemId}>{c.code} {c.name}</option>)}</select></label>
          <label>From<input type="datetime-local" aria-label="From" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} /></label>
          <label>To<input type="datetime-local" aria-label="To" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} /></label>
          <label>Deviation number<input aria-label="Deviation number" value={v.deviation} onChange={(e) => setV({ ...v, deviation: e.target.value })} /></label>
        </div>
        <label>Readings at equal intervals, one per line: date and time, °C, % RH (optional)
          <textarea aria-label="Readings" rows={6} placeholder={'2026-11-16 08:00, 33.5, 78\n2026-11-16 09:00, 32.0'} value={v.readings} onChange={(e) => setV({ ...v, readings: e.target.value })} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Enter</button></div>
      </form>
    </div>
  );
}

function CapacityTab() {
  const [d, setD] = useState<Capacity | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getCapacity().then(setD, (e) => setError(plainError(e))); }, []);
  if (error) return <p className="notice" role="alert">{error}</p>;
  if (!d) return <div className="skel skel-block" />;
  return (
    <>
      <p className="muted">Units booked in each chamber and condition: in it now, and still in it on 1 January of each coming year (time points not yet pulled).</p>
      {!d.rows.length ? <div className="card placeholder"><p>No samples in any chamber.</p></div> : (
        <div className="table-wrap">
          <table className="masters" aria-label="Chamber capacity">
            <thead><tr><th>Chamber</th><th>Condition</th><th>Studies</th><th>Now</th>{d.years.map((y) => <th key={y}>{y}</th>)}</tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={`${r.chamber.itemId}:${r.condition}:${r.unit}`}>
                  <td><b>{r.chamber.code}</b><span className="cell-sub">{r.chamber.name}</span></td><td>{r.condition}</td><td>{r.studies.join(', ')}</td>
                  <td>{r.now} {r.unit}</td>{d.years.map((y) => <td key={y}>{r.byYear[y] ?? 0}</td>)}
                </tr>))}
            </tbody>
          </table>
        </div>)}
    </>
  );
}
