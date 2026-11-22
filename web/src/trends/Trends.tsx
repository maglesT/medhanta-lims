// Trends (plan 2.10, 2.11; LIMS-25, LIMS-42): control charts of any numeric test of a product, material or EM and water
// point with the Nelson rule breaks (template L18); the lab's KPIs with the turnaround targets; the workload planner
// (who tests what by when, assigned to a trained analyst); the APQR summary of a product with its PDF and CSV export.
// One screen per job; a sample opens the sample screen.
import { useEffect, useState } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { plantClock, plantDate } from '../../../shared/plant-time.js';
import { SampleScreen } from '../samples/SampleScreen.js';
import { ControlChart } from './ControlChart.js';
import {
  apqrUrl, assign, getApqr, getApqrItems, getChart, getKpis, getSeries, getWorkload, setTarget,
  type Apqr, type ApqrItem, type Chart, type KpiData, type SeriesRow, type Workload,
} from './api-trends.js';
import '../designer/designer.css';
import '../samples/samples.css';
import '../floor/floor.css';
import './trends.css';

type Tab = 'charts' | 'kpis' | 'workload' | 'apqr';

export function Trends({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('charts');
  const [sample, setSample] = useState<number | null>(null);
  if (sample) return <SampleScreen me={me} id={sample} onBack={() => setSample(null)} backTo="Trends" />;
  return (
    <>
      <div className="home-head"><div>
        <h1>Trends</h1>
        <p className="greeting">Results as QC decided on them. Control charts, KPIs, who tests what by when, and the APQR data. Dates are plant dates (IST).</p>
      </div></div>
      <nav className="subtabs" aria-label="Trends">
        {([['charts', 'Control charts'], ['kpis', 'KPIs'], ['workload', 'Workload'], ['apqr', 'APQR']] as const).map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>))}
      </nav>
      {tab === 'charts' && <ChartsTab onSample={setSample} />}
      {tab === 'kpis' && <KpisTab me={me} />}
      {tab === 'workload' && <WorkloadTab me={me} onSample={setSample} />}
      {tab === 'apqr' && <ApqrTab />}
    </>
  );
}

const key = (s: SeriesRow) => `${s.series}|${s.testKey}|${s.unit}`;

/** LIMS-25: pick a product (or point) and test; the I-MR chart with the specification and the rule breaks. */
function ChartsTab({ onSample }: { onSample: (id: number) => void }) {
  const [series, setSeries] = useState<SeriesRow[] | null>(null);
  const [pick, setPick] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [c, setC] = useState<Chart | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getSeries().then((s) => { setSeries(s); if (s[0]) setPick(key(s[0])); }, (e) => setError(plainError(e))); }, []);
  const chosen = series?.find((s) => key(s) === pick);
  useEffect(() => {
    if (!chosen) return;
    setC(null);
    getChart({ series: chosen.series, test: chosen.testKey, unit: chosen.unit, from: from || undefined, to: to || undefined }).then(setC, (e) => setError(plainError(e)));
  }, [pick, from, to, chosen?.series]);
  const values = c?.points.map((p) => Number(p.value)) ?? [];
  const u = c?.unit ? ` ${c.unit}` : '';
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {series && !series.length && <div className="card placeholder"><p>No decided numeric result yet: charts start once QC decides on samples.</p></div>}
      {series && series.length > 0 && (
        <div className="card tr-pick">
          <label>Product, material or point, and test
            <select aria-label="Series" value={pick} onChange={(e) => setPick(e.target.value)}>
              {series.map((s) => <option key={key(s)} value={key(s)}>{s.kind === 'point' ? 'Point ' : ''}{s.code} {s.name} · {s.testName}{s.unit ? ` (${s.unit})` : ''} · {s.n} result{s.n === 1 ? '' : 's'}</option>)}
            </select></label>
          <label>From <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      )}
      {chosen && !c && !error && <div className="skel skel-block" />}
      {c && (
        <section className="dash-panel" aria-label="Control chart">
          <div className="panel-head"><h2>{c.item?.code} {c.item?.name} · {c.testName}</h2>
            {c.spec && <span className="pill">{c.spec.number} v{c.spec.versionNo}{c.spec.limit ? `: ${[c.spec.limit.low && `NLT ${c.spec.limit.low}`, c.spec.limit.high && `NMT ${c.spec.limit.high}`].filter(Boolean).join(', ')}${c.spec.limit.unit ? ` ${c.spec.limit.unit}` : ''}` : ''}</span>}</div>
          {c.message && <p className="notice" role="status">{c.message}</p>}
          {c.chart && (<>
            <p className="tr-shown">{c.chart.shown}{c.chart.cpk ? ` · Cpk ${Number(c.chart.cpk).toFixed(2)}` : ''}{c.chart.ppk ? ` · Ppk ${Number(c.chart.ppk).toFixed(2)}` : ''}</p>
            <ControlChart c={c.chart} values={values} labels={c.points.map((p) => `${p.sampleNo} (${p.lotNo})`)} />
            <h3>Nelson rule breaks</h3>
            {!c.chart.breaks.length ? <p className="all-good"><span aria-hidden="true">✓</span> No Nelson rule broken.</p> : (
              <div className="table-wrap"><table className="masters" aria-label="Rule breaks">
                <thead><tr><th>Rule</th><th>What</th><th>Points</th></tr></thead>
                <tbody>{c.chart.breaks.map((b, i) => (
                  <tr key={i}><td><span className="chip chip-bad">Rule {b.rule}</span></td><td>{b.text}</td>
                    <td>{b.points.map((n) => `${n} (${c.points[n - 1]?.lotNo ?? ''})`).join(', ')}</td></tr>))}</tbody>
              </table></div>
            )}
            {c.chart.mrBreaks.length > 0 && <p className="muted">Moving range above its limit at point{c.chart.mrBreaks.length === 1 ? '' : 's'} {c.chart.mrBreaks.join(', ')}.</p>}
          </>)}
          <h3>Results</h3>
          <div className="table-wrap"><table className="masters" aria-label="Results">
            <thead><tr><th>#</th><th>Decided</th><th>Sample</th><th>Lot or batch</th><th>Result</th><th>Decision</th><th>OOS / OOT</th></tr></thead>
            <tbody>{c.points.map((p) => (
              <tr key={p.n} className="clickable" onClick={() => onSample(p.sampleId)}>
                <td>{p.n}</td><td>{plantTime(p.decidedAt)}</td><td>{p.sampleNo}</td><td>{p.lotNo}</td><td>{p.reported ?? `${Number(p.value)}${u}`}</td><td>{p.decision}</td>
                <td>{p.oos && <span className="chip chip-bad">{p.oos}</span>} {p.oot && <span className="chip chip-warn">OOT: {p.oot}</span>}</td></tr>))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} %`);
/** Plan 2.11: right first time, OOS rate, invalid-run rate, turnaround and the backlog; QC sets the turnaround targets. */
function KpisTab({ me }: { me: Me }) {
  const [k, setK] = useState<KpiData | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const load = () => getKpis(from || undefined, to || undefined).then((x) => { setK(x); setError(''); }, (e) => setError(plainError(e)));
  useEffect(() => { void load(); }, [from, to]);
  const qc = can(me, 'qc.approve');
  const save = async (purpose: string) => {
    try { await setTarget(purpose, Number(edit[purpose])); setEdit((x) => { const { [purpose]: _, ...rest } = x; return rest; }); await load(); } catch (e) { setError(plainError(e)); }
  };
  const Counts = ({ rows, label }: { rows: (KpiData['byAnalyst'][number] & { method?: string })[] | KpiData['byTest']; label: 'analyst' | 'method' }) => (
    <div className="table-wrap"><table className="masters" aria-label={label === 'analyst' ? 'By analyst' : 'By test method'}>
      <thead><tr><th>{label === 'analyst' ? 'Analyst' : 'Test method'}</th><th>Finished</th><th>Right first time</th><th>OOS rate</th><th>Invalid runs</th></tr></thead>
      <tbody>{rows.map((r) => { const name = (r as unknown as Record<string, string>)[label]!; return (
        <tr key={name}><td>{name}</td><td>{r.finished}</td><td>{pct(r.rftPct)} ({r.rightFirstTime})</td><td>{pct(r.oosPct)} ({r.oos})</td><td>{pct(r.invalidPct)} ({r.invalid})</td></tr>); })}</tbody>
    </table></div>
  );
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="card tr-pick">
        <label>From month <input type="month" aria-label="From month" value={from || k?.from || ''} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To month <input type="month" aria-label="To month" value={to || k?.to || ''} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {!k ? <div className="skel skel-block" /> : (<>
        <div className="kpis">
          <div className={`kpi ${k.backlog.some((b) => b.over) ? 'bad' : 'ok'}`}><b>{k.backlog.length}</b><span>Samples not decided ({k.backlog.filter((b) => b.over).length} over target)</span></div>
          {(() => { const f = k.months.reduce((s, m) => s + m.finished, 0); const r = k.months.reduce((s, m) => s + m.rightFirstTime, 0);
            return <div className="kpi info"><b>{f ? `${((r / f) * 100).toFixed(1)} %` : '—'}</b><span>Right first time ({f} analyses)</span></div>; })()}
          {(() => { const v = k.months.reduce((s, m) => s + m.reviewed, 0); const o = k.months.reduce((s, m) => s + m.oos, 0);
            return <div className={`kpi ${o ? 'warn' : 'ok'}`}><b>{v ? `${((o / v) * 100).toFixed(1)} %` : '—'}</b><span>OOS rate ({o} OOS)</span></div>; })()}
          {(() => { const d = k.months.reduce((s, m) => s + m.decided, 0); const w = k.months.reduce((s, m) => s + m.tatWithin, 0);
            return <div className="kpi info"><b>{d ? `${((w / d) * 100).toFixed(1)} %` : '—'}</b><span>Decided within the target ({d} samples)</span></div>; })()}
        </div>
        <section className="dash-panel" aria-label="Per month">
          <div className="panel-head"><h2>Per month</h2><span className="muted">analyses by the month they finished; samples by the month QC decided</span></div>
          <div className="table-wrap"><table className="masters" aria-label="KPIs per month">
            <thead><tr><th>Month</th><th>Analyses finished</th><th>Right first time</th><th>OOS rate</th><th>Invalid runs</th><th>Samples decided</th><th>Turnaround (mean days)</th><th>Within target</th></tr></thead>
            <tbody>{k.months.map((m) => (
              <tr key={m.month}><td>{m.month}</td><td>{m.finished}</td><td>{pct(m.rftPct)}</td><td>{pct(m.oosPct)}</td><td>{pct(m.invalidPct)}</td><td>{m.decided}</td>
                <td>{m.tatMeanDays ?? '—'}</td><td>{pct(m.tatPct)}</td></tr>))}</tbody>
          </table></div>
          <p className="muted">Right first time: reviewed, never corrected, sent back or invalidated. OOS rate: of the reviewed analyses, those that opened an OOS. Invalid runs: stopped or invalidated.</p>
        </section>
        <section className="dash-panel" aria-label="Per analyst and test"><div className="panel-head"><h2>Per analyst and test method</h2><span className="muted">the period; the analyst is who started the analysis</span></div>
          <Counts rows={k.byAnalyst} label="analyst" />
          <Counts rows={k.byTest} label="method" />
        </section>
        <section className="dash-panel" aria-label="Backlog">
          <div className="panel-head"><h2>Backlog today</h2><span className="pill">{k.backlog.length}</span><span className="muted">received, not decided</span></div>
          <div className="tr-buckets">{k.buckets.map((b) => <div key={b.label} className={`kpi ${b.over ? 'warn' : 'info'}`}><b>{b.count}</b><span>{b.label}{b.over ? ` (${b.over} over target)` : ''}</span></div>)}</div>
          {k.backlog.length > 0 && <div className="table-wrap"><table className="masters" aria-label="Samples not decided">
            <thead><tr><th>Sample</th><th>Purpose</th><th>Received</th><th>Age (days)</th><th>Due</th><th /></tr></thead>
            <tbody>{k.backlog.map((b) => <tr key={b.sampleNo}><td>{b.sampleNo}</td><td>{b.purpose}</td><td>{plantDate(b.received)}</td><td>{b.ageDays}</td><td>{plantDate(b.due)}</td>
              <td>{b.over && <span className="chip chip-bad">over target</span>}</td></tr>)}</tbody>
          </table></div>}
        </section>
        <section className="dash-panel" aria-label="Turnaround targets">
          <div className="panel-head"><h2>Turnaround targets</h2><span className="muted">calendar days from receipt in QC to QC's decision{qc ? '' : ' (QC sets them)'}</span></div>
          <div className="table-wrap"><table className="masters" aria-label="Targets">
            <thead><tr><th>Sample purpose</th><th>Target (days)</th><th>Set</th>{qc && <th />}</tr></thead>
            <tbody>{k.targets.map((t) => (
              <tr key={t.purpose}><td>{t.purpose}</td>
                <td>{qc && t.purpose in edit ? <input type="number" min={0.01} max={365} step={0.001} aria-label={`Target ${t.purpose}`} value={edit[t.purpose]} onChange={(e) => setEdit({ ...edit, [t.purpose]: e.target.value })} /> : t.days < 1 ? `${t.days} (${Math.round(t.days * 24 * 10) / 10} h)` : t.days}</td>
                <td>{t.setBy ? `${t.setBy}, ${plantTime(t.at)}` : 'product default'}</td>
                {qc && <td>{t.purpose in edit ? <button onClick={() => void save(t.purpose)}>Save</button> : <button className="link dark" onClick={() => setEdit({ ...edit, [t.purpose]: String(t.days) })}>Change</button>}</td>}</tr>))}</tbody>
          </table></div>
        </section>
      </>)}
    </>
  );
}

/** Plan 2.10: the open samples' tests per method, due by the turnaround target; assigned to a trained analyst. */
function WorkloadTab({ me, onSample }: { me: Me; onSample: (id: number) => void }) {
  const [w, setW] = useState<Workload | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  const load = () => getWorkload().then(setW, (e) => setError(plainError(e)));
  useEffect(() => { void load(); }, []);
  const planner = can(me, 'analysis.review') || can(me, 'qc.approve');
  const doAssign = async (r: Workload['rows'][number]) => {
    const id = Number(pick[`${r.sampleId}:${r.methodMasterId}`]);
    if (!id) return;
    try {
      const x = await assign(r.sampleId, r.methodMasterId, id);
      setDone(`${r.sampleNo} ${r.method?.code ?? ''} assigned to ${w!.analysts.find((a) => a.id === id)?.name ?? ''} (training: ${x.training.checked}).`);
      setError('');
      await load();
    } catch (e) { setError(plainError(e)); setDone(''); }
  };
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {done && <p className="notice ok" role="status">{done}</p>}
      {w?.link && w.link !== 'ok' && <p className="notice" role="status">TIDE {w.link === 'down' ? 'does not answer' : 'is not linked'}: training is not checked when assigning (it is checked again when each step is signed).</p>}
      {!w ? <div className="skel skel-block" /> : (<>
        <section className="dash-panel" aria-label="Open tests">
          <div className="panel-head"><h2>Open tests by due date</h2><span className="pill">{w.rows.length}</span><span className="muted">due: received + the purpose's turnaround target</span></div>
          {!w.rows.length ? <p className="all-good"><span aria-hidden="true">✓</span> Nothing open.</p> : (
            <div className="table-wrap"><table className="masters" aria-label="Open tests">
              <thead><tr><th>Due</th><th>Sample</th><th>Item</th><th>Method and tests</th><th>Analysis</th><th>Assigned to</th>{planner && <th>Assign</th>}</tr></thead>
              <tbody>{w.rows.map((r) => { const k = `${r.sampleId}:${r.methodMasterId}`; return (
                <tr key={k}>
                  <td>{r.dueAt ? plantClock(r.dueAt) : plantDate(r.due)} {r.overdue && <span className="chip chip-bad">overdue</span>}</td>
                  <td><button className="link dark" onClick={() => onSample(r.sampleId)}>{r.sampleNo}</button><small className="muted"> {r.purpose}</small></td>
                  <td>{r.item.code} {r.item.name}<small className="muted"> · {r.lotNo}</small></td>
                  <td>{r.method ? `${r.method.code} ${r.method.name}` : 'no effective method version'}<small className="muted"> · {r.tests.join(', ')}</small></td>
                  <td>{r.analysis ? `${r.analysis.analysisNo} (${r.analysis.status}, ${r.analysis.by})` : 'not started'}</td>
                  <td>{r.assigned ? <>{r.assigned.analyst}<small className="muted"> by {r.assigned.by}</small></> : '—'}</td>
                  {planner && <td>{r.method && <span className="tr-assign">
                    <select aria-label={`Analyst for ${r.sampleNo} ${r.method.code}`} value={pick[k] ?? ''} onChange={(e) => setPick({ ...pick, [k]: e.target.value })}>
                      <option value="">Pick an analyst…</option>
                      {w.analysts.map((a) => { const no = w.trained[r.methodMasterId]?.[a.id] ?? null; return (
                        <option key={a.id} value={a.id} disabled={!!no}>{a.name} · {a.openAnalyses} open{no ? ' · not trained' : ''}</option>); })}
                    </select>
                    <button disabled={!pick[k]} onClick={() => void doAssign(r)}>Assign</button></span>}</td>}
                </tr>); })}</tbody>
            </table></div>
          )}
        </section>
        <section className="dash-panel" aria-label="Analysts">
          <div className="panel-head"><h2>Analysts</h2><span className="muted">open analyses they started, and open tests assigned to them</span></div>
          <div className="table-wrap"><table className="masters" aria-label="Analysts">
            <thead><tr><th>Analyst</th><th>Open analyses</th><th>Assigned</th></tr></thead>
            <tbody>{w.analysts.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.openAnalyses}</td><td>{a.assigned}</td></tr>)}</tbody>
          </table></div>
        </section>
      </>)}
    </>
  );
}

const yearStart = () => `${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 4)}-01-01`;
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
/** LIMS-42: the lab's part of a product's annual review, over a period, on screen and as PDF or CSV. */
function ApqrTab() {
  const [items, setItems] = useState<ApqrItem[] | null>(null);
  const [item, setItem] = useState('');
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayIst());
  const [r, setR] = useState<Apqr | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { getApqrItems().then((x) => { setItems(x); if (x[0]) setItem(`${x[0].of}:${x[0].code}`); }, (e) => setError(plainError(e))); }, []);
  const sel = items?.find((i) => `${i.of}:${i.code}` === item);
  const q = sel ? { of: sel.of, code: sel.code, from, to } : null;
  const show = () => { if (q) { setR(null); getApqr(q).then((x) => { setR(x); setError(''); }, (e) => setError(plainError(e))); } };
  const T = ({ label, head, rows, none }: { label: string; head: string[]; rows: (string | number | null)[][]; none: string }) => (!rows.length ? <p className="muted">{none}</p> : (
    <div className="table-wrap"><table className="masters" aria-label={label}><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c ?? '—'}</td>)}</tr>)}</tbody></table></div>));
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="card tr-pick">
        <label>Product or material
          <select aria-label="Product or material" value={item} onChange={(e) => setItem(e.target.value)}>
            {(items ?? []).map((i) => <option key={`${i.of}:${i.code}`} value={`${i.of}:${i.code}`}>{i.code} {i.name} ({i.of})</option>)}
          </select></label>
        <label>From <input type="date" aria-label="Period from" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" aria-label="Period to" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="primary" disabled={!q} onClick={show}>Show the summary</button>
        {q && <a className="button" href={apqrUrl(q, 'csv')} download>Export CSV</a>}
        {q && <a className="button" href={apqrUrl(q, 'pdf')} download>Export PDF</a>}
      </div>
      {r && (
        <section className="dash-panel" aria-label="APQR summary">
          <div className="panel-head"><h2>{r.item.code} {r.item.name} · {plantDate(r.period.from)} to {plantDate(r.period.to)}</h2>
            <span className="pill">{r.lots.length} lots decided, {r.failed.length} rejected</span></div>
          <h3>Results</h3>
          <T label="Results summary" head={['Test', 'Limit', 'Results', 'Failed', 'n', 'Min', 'Max', 'Mean', 'SD', 'Cpk', 'Nelson rules broken']} none="No results decided in the period."
            rows={r.results.map((t) => [t.name, t.limit, t.results, t.failed, t.n, t.min, t.max, t.mean, t.sd, t.cpk, t.rules.join(', ') || null])} />
          <h3>Failed batches and investigations</h3>
          <T label="OOS" head={['OOS', 'Sample', 'Lot or batch', 'Purpose', 'Test', 'Result', 'Status', 'Deviation', 'Opened']} none="No OOS in the period."
            rows={r.oos.map((o) => [o.oosNo, o.sampleNo, o.lotNo, o.purpose, o.test, o.shown, o.status, o.deviation, plantTime(o.openedAt)])} />
          <T label="OOT" head={['Out of trend', 'Lot or batch', 'Test', 'Analysis', 'QC answer', 'Reason']} none="No out-of-trend result answered in the period."
            rows={r.oot.map((o) => [o.sampleNo, o.lotNo, o.test, o.analysisNo, o.answer, o.reason])} />
          <h3>Method and specification changes</h3>
          <T label="Changes" head={['Kind', 'Number', 'Name', 'Version', 'Effective', 'Change control']} none="No version made effective in the period."
            rows={r.changes.map((c) => [c.kind, c.number, c.name, c.versionNo, plantTime(c.effectiveAt), c.changeControl])} />
          <h3>Stability ({r.stabilityResults.n} results decided in the period, {r.stabilityResults.failed} failed)</h3>
          <T label="Stability" head={['Study', 'Batch or lot', 'Protocol', 'Placed', 'Last time point (months)', 'Latest signed evaluation']} none="No stability study of this item."
            rows={r.stability.map((s) => [s.studyNo, s.lotNo, s.protocol, plantDate(s.t0), s.lastMonth, s.evaluation])} />
          <h3>EM and water (the plant, in the period)</h3>
          <T label="EM and water" head={['Point', 'Name', 'Room or system', 'Grade', 'Sampling', 'Results', 'Alert', 'Action']} none="No EM or water results decided in the period."
            rows={r.em.map((e) => [e.point, e.name, e.where, e.grade, e.kind, e.n, e.alert, e.action])} />
          <T label="EM adverse trends" head={['Adverse trend', 'Room or system', 'Date', 'What', 'QC acknowledged']} none="No EM adverse trend in the period."
            rows={r.adverse.map((a) => [a.kind, a.room, plantDate(a.on), a.what, a.answer ? `${a.answer.by}: ${a.answer.reason}` : 'not yet'])} />
          <T label="Excursions" head={['Point', 'Level', 'Result', 'Deviation', 'Status', 'Recorded']} none="No excursions in the period."
            rows={r.excursions.map((x) => [x.point, x.level, x.shown, x.deviation, x.closed ? 'closed' : 'open', plantTime(x.at)])} />
        </section>
      )}
    </>
  );
}
