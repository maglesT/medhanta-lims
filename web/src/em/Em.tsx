// EM and water (LIMS-36, LIMS-37; plan 2.9): what the effective monitoring plans make due today and overdue, with
// "Take" making the sample; the excursions (results over the alert or action limit, alarms imported); the EM map per
// room and water system with each point's trend table; the plans (written, checked and approved as specifications);
// the continuous monitoring systems' daily reports. One screen per job: a plan (PlanEditor), an excursion
// (ExcursionScreen), a sample (SampleScreen).
import { useEffect, useState, type FormEvent } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { STATE_CHIP, STATE_LABEL, newVersion } from '../api-designer.js';
import { plantDate } from '../../../shared/plant-time.js';
import { monitoringSchema } from '../../../shared/master/monitoring.js';
import { SampleScreen } from '../samples/SampleScreen.js';
import { PlanEditor } from './PlanEditor.js';
import { ExcursionScreen } from './ExcursionScreen.js';
import {
  DUE_CHIP, LEVEL_CHIP, LEVEL_WORDS, STATUS_CHIP, createPlan, getDue, emBatches, getMap, importReport, listExcursions, listImports, listPlans, openExcursion, take,
  type Due, type DueRow, type Excursions, type Imports, type MapGroup, type Pending, type PlanRow,
} from './api-em.js';
import '../designer/designer.css';
import '../samples/samples.css';
import { AdversePanel } from '../trends/AdversePanel.js';
import '../trends/trends.css';
import './em.css';

type Tab = 'due' | 'excursions' | 'map' | 'plans' | 'imports';
type Screen = { plan: number } | { excursion: number } | { sample: number } | { point: string } | null;

export function Em({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('due');
  const [screen, setScreen] = useState<Screen>(null);
  const back = () => setScreen(null);
  if (screen && 'plan' in screen) return <PlanEditor me={me} versionId={screen.plan} onBack={back} onOpen={(plan) => setScreen({ plan })} />;
  if (screen && 'excursion' in screen) return <ExcursionScreen id={screen.excursion} onBack={back} onSample={(sample) => setScreen({ sample })} />;
  if (screen && 'sample' in screen) return <SampleScreen me={me} id={screen.sample} onBack={back} />;
  if (screen && 'point' in screen) return <PointTrend point={screen.point} onBack={back} onSample={(sample) => setScreen({ sample })} />;
  return (
    <>
      <div className="home-head">
        <div>
          <h1>EM and water</h1>
          <p className="greeting">Environmental monitoring and water sampled by the approved monitoring plans; excursions investigated. Dates are plant dates (IST).</p>
        </div>
      </div>
      <nav className="subtabs" aria-label="EM and water">
        {([['due', 'Due today'], ['excursions', 'Excursions'], ['map', 'EM map'], ['plans', 'Plans'], ['imports', 'Monitoring reports']] as const).map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>))}
      </nav>
      {tab === 'due' && <DueTab me={me} onSample={(sample) => setScreen({ sample })} />}
      {tab === 'excursions' && <ExcursionsTab me={me} onOpen={(excursion) => setScreen({ excursion })} onSample={(sample) => setScreen({ sample })} />}
      {tab === 'map' && <MapTab onPoint={(point) => setScreen({ point })} />}
      {tab === 'plans' && <PlansTab me={me} onOpen={(plan) => setScreen({ plan })} />}
      {tab === 'imports' && <ImportsTab me={me} />}
    </>
  );
}

const samplingWords = (r: { kind: string; state: string | null; frequency: string }) => `${r.kind}${r.state ? `, ${r.state}` : ''} · ${r.frequency}`;

/** The samplings due today and overdue (LIMS-36), and the per-batch ones; "Take" makes the sample. */
function DueTab({ me, onSample }: { me: Me; onSample: (id: number) => void }) {
  const [d, setD] = useState<Due | null>(null);
  const [error, setError] = useState('');
  const [taking, setTaking] = useState<DueRow | Due['perBatch'][number] | null>(null);
  const [done, setDone] = useState('');
  const load = () => getDue().then(setD, (e) => setError(plainError(e)));
  useEffect(() => { void load(); }, []);
  const sampler = can(me, 'sample.register');
  const open = (d?.due ?? []).filter((r) => r.due !== 'done');
  const overdue = open.filter((r) => r.due === 'overdue');
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {done && <p className="notice ok" role="status">{done}</p>}
      {d && !d.plans.length && <div className="card placeholder"><p>No effective monitoring plan yet: write one in Plans.</p></div>}
      {overdue.length > 0 && <p className="notice" role="alert">{overdue.length} sampling{overdue.length === 1 ? ' was' : 's were'} missed in the last period: {overdue.map((r) => `${r.code} ${r.kind} (${r.missed})`).join(', ')}.</p>}
      <section className="dash-panel samples-waiting" aria-label="Due today">
        <div className="panel-head"><h2>Due today {d && plantDate(d.today)}</h2><span className="pill">{d ? open.length : '…'}</span></div>
        {d && !d.due.length && <p className="muted">Nothing on a frequency.</p>}
        {d && d.due.length > 0 && (
          <div className="table-wrap">
            <table className="masters" aria-label="Samplings due">
              <thead><tr><th>Point</th><th>Where</th><th>Sampling</th><th>Limit</th><th>This period</th><th>State</th><th>Last taken</th><th /></tr></thead>
              <tbody>
                {d.due.map((r) => (
                  <tr key={`${r.planVersionId}:${r.point}:${r.sampling}`}>
                    <td><b>{r.code}</b><span className="cell-sub">{r.name}{r.critical ? ' · critical' : ''}</span></td>
                    <td>{r.where}</td>
                    <td>{samplingWords(r)}</td>
                    <td>{r.spec?.limit}<span className="cell-sub">{r.spec?.number}</span></td>
                    <td>{r.taken} of {r.needed}{r.frequency === 'per shift' ? ' shifts' : ''}<span className="cell-sub">{r.period.from === r.period.to ? plantDate(r.period.from) : `${plantDate(r.period.from)} to ${plantDate(r.period.to)}`}</span></td>
                    <td><span className={DUE_CHIP[r.due]}>{r.due === 'overdue' ? `Overdue (missed ${r.missed})` : r.due === 'done' ? 'Done' : 'Due'}</span></td>
                    <td>{r.last ? <button className="link dark" onClick={() => onSample(r.last!.sampleId)}>{r.last.sampleNo}</button> : '—'}<span className="cell-sub">{r.last ? plantDate(r.last.on) : ''}</span></td>
                    <td>{sampler && r.due !== 'done' && <button className="primary" aria-label={`Take ${r.code} ${r.kind}${r.state ? ` ${r.state}` : ''}`} onClick={() => setTaking(r)}>Take</button>}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>)}
      </section>
      {d && d.perBatch.length > 0 && (
        <section className="dash-panel samples-waiting" aria-label="Per batch">
          <div className="panel-head"><h2>Per batch</h2><span className="pill">{d.perBatch.length}</span></div>
          <p className="muted small">Taken during each batch, with its batch number (read from TrueBatch).</p>
          <div className="table-wrap"><table className="masters" aria-label="Per batch samplings"><tbody>
            {d.perBatch.map((r) => (
              <tr key={`${r.planVersionId}:${r.point}:${r.sampling}`}><td><b>{r.code}</b><span className="cell-sub">{r.name}</span></td><td>{r.where}</td><td>{samplingWords(r)}</td>
                <td>{r.last ? `${r.last.sampleNo}, ${plantDate(r.last.on)}` : '—'}</td><td>{sampler && <button onClick={() => setTaking(r)}>Take</button>}</td></tr>))}
          </tbody></table></div>
        </section>)}
      {taking && <TakeDialog row={taking} onCancel={() => setTaking(null)} onDone={(no) => { setTaking(null); setDone(`Sample ${no} taken.`); void load(); }} />}
    </>
  );
}

function TakeDialog({ row, onDone, onCancel }: { row: Due['perBatch'][number] & Partial<Pick<DueRow, 'due' | 'shifts' | 'shiftsTaken' | 'taken' | 'needed'>>; onDone: (no: string) => void; onCancel: () => void }) {
  const [shift, setShift] = useState('');
  const [batch, setBatch] = useState('');
  // The batches running now, from TrueBatch: picked (per batch: needed; otherwise: during which batch, if any).
  const [batches, setBatches] = useState<Awaited<ReturnType<typeof emBatches>> | null>(null);
  useEffect(() => { emBatches().then(setBatches, () => setBatches({ link: 'down', batches: [] })); }, []);
  const [person, setPerson] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const again = row.frequency !== 'per shift' && row.frequency !== 'per batch' && row.taken !== undefined && row.needed !== undefined && row.taken >= row.needed;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await take({ planVersionId: row.planVersionId, point: row.point, sampling: row.sampling, ...(shift ? { shift: Number(shift) } : {}), ...(batch.trim() ? { batch: batch.trim() } : {}),
        ...(person.trim() ? { person: person.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onDone(`${r.sampleNo}${r.byHand ? ' (batch typed by hand: a second person checks the sample)' : ''}`);
    } catch (x) { setError(plainError(x)); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Take the sampling">
      <form className="card dialog" onSubmit={submit}>
        <h2>Take {row.code}: {row.kind}</h2>
        <p>{row.where} · {samplingWords(row)} · {row.quantity}</p>
        <p className="muted small">Tested to {row.spec?.number}, {row.spec?.testName}: {row.spec?.limit}.</p>
        {row.frequency === 'per shift' && <label>Shift<select aria-label="Shift" value={shift} onChange={(e) => setShift(e.target.value)}><option value="">(choose)</option>
          {Array.from({ length: row.shifts ?? 3 }, (_, i) => i + 1).map((n) => <option key={n} value={n} disabled={row.shiftsTaken?.includes(n)}>{n}{row.shiftsTaken?.includes(n) ? ' (taken)' : ''}</option>)}</select></label>}
        {batches?.link === 'ok' ? (
          <label>{row.frequency === 'per batch' ? 'Batch' : 'Taken during batch (if any)'}<select aria-label="Batch number" value={batch} onChange={(e) => setBatch(e.target.value)}>
            <option value="">{row.frequency === 'per batch' ? '(choose)' : '(none)'}</option>
            {batches.batches.map((b) => <option key={`${b.edition}:${b.batchNumber}`} value={b.batchNumber}>{b.batchNumber} · {b.productCode ?? ''} · {b.status.toLowerCase().replaceAll('_', ' ')}</option>)}</select></label>
        ) : row.frequency === 'per batch' && <label>Batch number (TrueBatch not answering: typed, a second person checks)<input aria-label="Batch number" value={batch} onChange={(e) => setBatch(e.target.value)} /></label>}
        {row.person && <label>Person sampled<input aria-label="Person sampled" value={person} onChange={(e) => setPerson(e.target.value)} /></label>}
        {again && <label>Already taken this period: why again<input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Take the sample</button></div>
      </form>
    </div>
  );
}

/** Results over a limit not yet recorded, and the excursions (LIMS-36). */
function ExcursionsTab({ me, onOpen, onSample }: { me: Me; onOpen: (id: number) => void; onSample: (id: number) => void }) {
  const [d, setD] = useState<Excursions | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState<Pending | null>(null);
  const load = () => listExcursions().then(setD, (e) => setError(plainError(e)));
  useEffect(() => { void load(); }, []);
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      <section className="dash-panel samples-waiting" aria-label="Results over a limit">
        <div className="panel-head"><h2>Results over a limit</h2><span className="pill">{d ? d.pending.length : '…'}</span></div>
        <p className="muted small">Reviewed results over the action limit (grade A: any colony) open an investigation; over the alert limit, a trend watch.</p>
        {d && !d.pending.length && <p className="muted">None waiting.</p>}
        {d && d.pending.length > 0 && <div className="table-wrap"><table className="masters" aria-label="Results over a limit">
          <thead><tr><th>Sample</th><th>Point</th><th>Sampling</th><th>Result</th><th>Level</th><th /></tr></thead>
          <tbody>{d.pending.map((p) => (
            <tr key={p.sampleId}>
              <td><button className="link dark" onClick={() => onSample(p.sampleId)}>{p.sampleNo}</button><span className="cell-sub">{plantDate(p.on)}</span></td>
              <td><b>{p.point.code}</b><span className="cell-sub">{p.point.where}</span></td><td>{p.kind}{p.state ? `, ${p.state}` : ''}</td>
              <td>{p.shown}<span className="cell-sub">{p.why}</span></td><td><span className={LEVEL_CHIP[p.level]}>{LEVEL_WORDS[p.level]}</span></td>
              <td>{d.mayOpen && <button className="primary" onClick={() => setOpening(p)}>{p.level === 'action' ? 'Open the investigation' : 'Record the trend watch'}</button>}</td>
            </tr>))}</tbody></table></div>}
      </section>
      <AdversePanel me={me} />
      <h2>Excursions</h2>
      {d === null ? <div className="skel skel-block" /> : !d.excursions.length ? <div className="card placeholder"><p>No excursions.</p></div> : (
        <div className="table-wrap"><table className="masters" aria-label="Excursions">
          <thead><tr><th>Point</th><th>Result</th><th>Level</th><th>Investigation</th><th>Status</th><th>Recorded</th></tr></thead>
          <tbody>{d.excursions.map((x) => (
            <tr key={x.id} className="clickable" onClick={() => onOpen(x.id)}>
              <td><b>{x.point.code}</b><span className="cell-sub">{x.point.where}{x.point.grade ? ` (grade ${x.point.grade})` : ''}</span></td>
              <td>{x.result.shown}<span className="cell-sub">{x.origin === 'import' ? 'monitoring report alarm' : x.sampleNo}</span></td>
              <td><span className={LEVEL_CHIP[x.level]}>{LEVEL_WORDS[x.level]}</span></td><td>{x.deviation ?? '—'}</td>
              <td><span className={STATUS_CHIP[x.status]}>{x.status}</span></td><td>{x.recordedByName}<span className="cell-sub">{plantTime(x.recordedAt)}</span></td>
            </tr>))}</tbody></table></div>)}
      {opening && <OpenDialog p={opening} onCancel={() => setOpening(null)} onDone={(id) => { setOpening(null); onOpen(id); }} />}
    </>
  );
}

function OpenDialog({ p, onDone, onCancel }: { p: Pending; onDone: (id: number) => void; onCancel: () => void }) {
  const [deviation, setDeviation] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { onDone((await openExcursion({ sampleId: p.sampleId, ...(p.level === 'action' ? { deviation: deviation.trim() } : {}) })).id); } catch (x) { setError(plainError(x)); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Excursion">
      <form className="card dialog" onSubmit={submit}>
        <h2>{p.level === 'action' ? 'Open the investigation' : 'Record the trend watch'}: {p.point.code}</h2>
        <p>{p.sampleNo} · {p.kind} · {p.shown}</p>
        {p.level === 'action' && <label>Deviation number (as filed in Deviations; typed by hand while it is not linked, then checked)
          <input aria-label="Deviation number" autoFocus value={deviation} onChange={(e) => setDeviation(e.target.value)} placeholder="e.g. DEV-26-201" /></label>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Record</button></div>
      </form>
    </div>
  );
}

/** The EM map: per room (with its grade) and water system, its points with each sampling's latest result and level. */
function MapTab({ onPoint }: { onPoint: (key: string) => void }) {
  const [groups, setGroups] = useState<MapGroup[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getMap().then((m) => setGroups(m.groups), (e) => setError(plainError(e))); }, []);
  if (error) return <p className="notice" role="alert">{error}</p>;
  if (!groups) return <div className="skel skel-block" />;
  if (!groups.length) return <div className="card placeholder"><p>No points in an effective plan.</p></div>;
  return (
    <>
      {groups.map((g) => (
        <section key={g.key} className="dash-panel samples-waiting" aria-label={`Map ${g.code}`}>
          <div className="panel-head"><h2>{g.code} {g.name}</h2>{g.grade && <span className="pill">Grade {g.grade}</span>}</div>
          <div className="em-map">
            {g.points.map((p) => {
              const worst = p.samplings.map((s) => s.latest?.result?.level ?? 'none').sort((a, b) => ['none', 'alert', 'action'].indexOf(b) - ['none', 'alert', 'action'].indexOf(a))[0] ?? 'none';
              return (
                <button key={`${p.planMasterId}:${p.key}`} className={`card em-point em-${worst}`} aria-label={`Point ${p.code}`} onClick={() => onPoint(`${p.planMasterId}:${p.key}`)}>
                  <b>{p.code}</b>{p.critical && <span className="cell-sub">critical</span>}<span className="cell-sub">{p.name}</span>
                  {p.samplings.map((s) => (
                    <span key={s.key} className="cell-sub">{s.kind}{s.state ? ` (${s.state})` : ''}: {s.latest?.result ? <span className={LEVEL_CHIP[s.latest.result.level]}>{s.latest.result.value} {s.latest.result.unit}</span> : 'no result yet'}</span>))}
                </button>);
            })}
          </div>
        </section>))}
    </>
  );
}

/** One point's trend table: its last results per sampling, with the limits and levels (charts: step 8). */
function PointTrend({ point, onBack, onSample }: { point: string; onBack: () => void; onSample: (id: number) => void }) {
  const [g, setG] = useState<MapGroup | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getMap(point).then((m) => setG(m.groups[0] ?? null), (e) => setError(plainError(e))); }, [point]);
  const p = g?.points[0];
  return (
    <>
      <button className="link dark" onClick={onBack}>← EM and water</button>
      {error && <p className="notice" role="alert">{error}</p>}
      {!g || !p ? <div className="skel skel-block" /> : (<>
        <div className="home-head"><div><h1>{p.code} <span className="muted">{p.name}</span></h1>
          <p className="greeting">{g.code} {g.name}{g.grade ? ` · grade ${g.grade}` : ''} · plan {p.planNumber}{p.critical ? ' · a critical location' : ''}</p></div></div>
        <AdversePanel point={p.code} />
        {p.samplings.map((s) => (
          <section key={s.key} className="dash-panel samples-waiting" aria-label={`Trend ${s.kind}`}>
            <div className="panel-head"><h2>{samplingWords(s)}</h2><span className="pill">{s.limit}</span></div>
            {!s.results.length ? <p className="muted">Not taken yet.</p> : (
              <div className="table-wrap"><table className="masters" aria-label={`Results ${s.kind}`}>
                <thead><tr><th>Taken</th><th>Sample</th><th>Result</th><th>Level</th></tr></thead>
                <tbody>{s.results.map((r) => (
                  <tr key={r.sampleId}><td>{plantDate(r.on)}{r.shift ? `, shift ${r.shift}` : ''}</td>
                    <td><button className="link dark" onClick={() => onSample(r.sampleId)}>{r.sampleNo}</button></td>
                    <td>{r.result ? `${r.result.value} ${r.result.unit}` : 'Not reviewed yet'}</td>
                    <td>{r.result && <span className={LEVEL_CHIP[r.result.level]}>{LEVEL_WORDS[r.result.level]}</span>}</td></tr>))}</tbody></table></div>)}
          </section>))}
      </>)}
    </>
  );
}

function PlansTab({ me, onOpen }: { me: Me; onOpen: (id: number) => void }) {
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const author = can(me, 'master.author');
  useEffect(() => { listPlans().then(setRows, (e) => setError(plainError(e))); }, []);
  const pending = (masterId: number) => rows?.some((r) => r.masterId === masterId && ['draft', 'in_review', 'approved'].includes(r.state));
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {author && <p><button className="primary" onClick={() => setCreating(true)}>New plan</button></p>}
      {rows === null ? <div className="skel skel-block" /> : !rows.length ? <div className="card placeholder"><p>No monitoring plans yet.</p></div> : (
        <div className="table-wrap">
          <table className="masters" aria-label="Plans">
            <thead><tr><th>Plan</th><th>Version</th><th>State</th><th>Written by</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                  <td><b>{r.header.number}</b><span className="cell-sub">{r.header.name}</span></td><td>{r.versionNo}</td>
                  <td><span className={STATE_CHIP[r.state]}>{STATE_LABEL[r.state]}</span></td>
                  <td>{r.createdByName}<span className="cell-sub">{plantTime(r.createdAt)}</span></td>
                  <td><span className="actions-cell" onClick={(e) => e.stopPropagation()}>
                    {author && r.state === 'effective' && !pending(r.masterId) && <button onClick={async () => { try { onOpen((await newVersion(r.masterId)).id); } catch (e) { setError(plainError(e)); } }}>New version</button>}
                  </span></td>
                </tr>))}
            </tbody>
          </table>
        </div>)}
      {creating && <NewPlan onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} />}
    </>
  );
}

function NewPlan({ onCreated, onCancel }: { onCreated: (id: number) => void; onCancel: () => void }) {
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const doc = monitoringSchema.safeParse({ header: { number, name, shifts: 3 }, points: [] });
    if (!doc.success) return setError(doc.error.issues.map((i) => `${i.path.at(-1)}: ${i.message}`).join('; '));
    try { onCreated((await createPlan(doc.data)).id); } catch (x) { setError(plainError(x)); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="New plan">
      <form className="card dialog" onSubmit={submit}>
        <h2>New monitoring plan</h2>
        <div className="form-grid">
          <label>Plan number<input aria-label="Plan number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. EMP-001" /></label>
          <label>Name<input aria-label="Plan name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sterile block: EM and water" /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Create draft</button></div>
      </form>
    </div>
  );
}

/** The continuous monitoring systems' daily summary reports (owner, 18 Nov 2026): imported with their SHA-256. */
function ImportsTab({ me }: { me: Me }) {
  const [d, setD] = useState<Imports | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'particle' | 'water'>('particle');
  const [done, setDone] = useState('');
  const load = () => listImports().then(setD, (e) => setError(plainError(e)));
  useEffect(() => { void load(); }, []);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(''); setDone('');
    try {
      const r = await importReport({ kind, fileName: file.name, content: await file.text() });
      setDone(`${file.name}: ${r.rows} rows of ${plantDate(r.date)}, ${r.alarms} alarm${r.alarms === 1 ? '' : 's'} (to be confirmed by a second person). SHA-256 ${r.sha256}.`);
      await load();
    } catch (x) { setError(plainError(x)); }
  };
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {done && <p className="notice ok" role="status">{done}</p>}
      {can(me, 'sample.register') && d && (
        <div className="card">
          <div className="form-grid">
            <label>System<select aria-label="System" value={kind} onChange={(e) => setKind(e.target.value as 'particle' | 'water')}>
              {Object.entries(d.layouts).map(([k, l]) => <option key={k} value={k}>{l.name}</option>)}</select></label>
            <label>Daily summary report (CSV)<input type="file" aria-label="Report file" accept=".csv,text/csv" onChange={(e) => void upload(e.target.files?.[0])} /></label>
          </div>
          <p className="muted small">The layout: {d.layouts[kind].header.join(',')}. Counts per m³; alarm empty, ALERT or ACTION.</p>
        </div>)}
      {d && !d.imports.length && <div className="card placeholder"><p>No reports imported.</p></div>}
      {d && d.imports.length > 0 && <div className="table-wrap"><table className="masters" aria-label="Reports">
        <thead><tr><th>Report</th><th>Day</th><th>Rows</th><th>Alarms</th><th>Imported</th></tr></thead>
        <tbody>{d.imports.map((i) => (
          <tr key={i.id}><td><b>{i.fileName}</b><span className="cell-sub">{d.layouts[i.kind].name} · SHA-256 {i.sha256.slice(0, 16)}…</span></td><td>{plantDate(i.reportDate)}</td>
            <td>{i.rows.length}</td><td>{i.alarms}</td><td>{i.importedByName}<span className="cell-sub">{plantTime(i.importedAt)}</span></td></tr>))}</tbody></table></div>}
    </>
  );
}
