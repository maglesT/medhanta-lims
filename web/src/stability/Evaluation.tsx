// Stability evaluation (LIMS-29, LIMS-25; plan 2.6, 2b items 3, 4, 7): the reviewed results per batch, condition and
// time point (out of trend and out of limits marked), what is to be reported, the ICH Q1E evaluation per long-term
// condition (template L15) that QA answers the decision tree for and signs, the signed evaluations, and (product) the
// Arrhenius advisory. One panel for a study and for a product; the product screen adds the CTD downloads.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { SignDialog } from '../components/SignDialog.js';
import {
  answerReport, ctdLink, getEvaluation, previewEvaluation, signEvaluation,
  type Answers, type EvalGroup, type EvalScope, type EvaluationView, type ReportRow, type TestEvaluation,
} from './api-stability.js';

const months = (e?: string) => (e === undefined ? '—' : e === 'Infinity' ? 'not limiting' : `${Math.floor(Number(e) * 10) / 10} months`);

export function EvaluationPanel({ me, scope }: { me: Me; scope: EvalScope }) {
  const [d, setD] = useState<EvaluationView | null>(null);
  const [error, setError] = useState('');
  const [signing, setSigning] = useState<EvalGroup | null>(null);
  const [answering, setAnswering] = useState<ReportRow | null>(null);
  const key = JSON.stringify(scope);
  const load = useCallback(() => getEvaluation(JSON.parse(key) as EvalScope).then((x) => { setD(x); setError(''); }, (e) => setError(plainError(e))), [key]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return error ? <p className="notice" role="alert">{error}</p> : <div className="skel skel-block" />;
  const what = d.kind;
  return (
    <>
      {error && <p className="notice" role="alert">{error}</p>}
      {d.toReport.length > 0 && (
        <section className="dash-panel samples-waiting" aria-label="To be reported">
          <div className="panel-head"><h2>To be reported</h2><span className="pill">{d.toReport.filter((r) => !r.answer).length}</span></div>
          <p className="muted small">A confirmed OOS or a negative trend on a marketed batch (LIMS-29). QA records whether a regulator notice is needed; the app never sends it.</p>
          <ul className="link-states">
            {d.toReport.map((r) => (
              <li key={r.key} className={r.answer ? 'ok' : 'off'}>
                <span className="chip chip-bad">to be reported</span> <b>{r.kind === 'confirmed OOS' ? r.oosNo : 'Negative trend'}</b> · {r.lotNo} ({r.studyNo}), {r.label}, {r.month} months · {r.what}
                {r.marketed === null && <span className="cell-sub">Marketed or not: the link does not answer; treated as marketed.</span>}
                {r.answer ? <span> · QA: regulator notice {r.answer.needed ? 'needed' : 'not needed'}: {r.answer.text} ({r.answer.by}, {plantTime(r.answer.at)})</span>
                  : can(me, 'qc.approve') && <button className="link dark" disabled={!!d.reportRefusal} onClick={() => setAnswering(r)}>Regulator notice? (QA)</button>}
              </li>))}
          </ul>
        </section>)}
      <section className="dash-panel samples-waiting" aria-label="Stability data">
        <div className="panel-head"><h2>Stability data</h2></div>
        <p className="muted small">Reviewed results of the stability samples. * reviewed, QC decision pending.</p>
        {d.tables.map((t) => (
          <div key={`${t.studyId}:${t.condition}`} className="table-wrap">
            <table className="masters" aria-label={`Data ${t.lotNo} ${t.condition}`}>
              <caption>{t.lotNo} · {t.condition} ({t.role}) · {t.studyNo}</caption>
              <thead><tr><th>Test</th><th>Limit</th>{t.months.map((m) => <th key={m}>{m} months</th>)}</tr></thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={r.key}>
                    <td><b>{r.name}</b></td><td>{r.criterion}</td>
                    {t.months.map((m) => { const c = r.cells[m]; return <td key={m}>{c ? <>{c.figure}{c.decided ? '' : ' *'}{c.pass === false && <span className="chip chip-bad">out of limits</span>}
                      {c.oot && <span className="chip chip-warn" title={c.oot}>out of trend{c.ootAnswer ? `: ${c.ootAnswer}` : ''}</span>}</> : '—'}</td>; })}
                  </tr>))}
              </tbody>
            </table>
          </div>))}
      </section>
      <section className="dash-panel samples-waiting" aria-label="Evaluation">
        <div className="panel-head"><h2>Evaluation (ICH Q1E)</h2></div>
        {!d.groups.length && <p className="muted">No long-term condition to evaluate.</p>}
        {d.groups.map((g) => (
          <div key={g.key}>
            <h3>{g.protocolNumber} · {g.label}</h3>
            <p className="muted small">{d.scope === 'study' ? 'This batch alone.' : `Batches of ${g.studies.join(', ')}: pooled as far as the poolability tests allow (level 0.25).`}</p>
            <div className="table-wrap">
              <table className="masters" aria-label={`Evaluation ${g.label}`}>
                <thead><tr><th>Test</th><th>Limit</th><th>Batches</th><th>Model</th><th>Estimate</th><th>Limited by</th></tr></thead>
                <tbody>
                  {g.tests.map((t) => (
                    <tr key={t.key}>
                      <td><b>{t.name}</b></td><td>{t.criterion}</td>
                      <td>{t.used.join(', ') || '—'}{t.notUsed.map((n) => <span key={n.lotNo} className="cell-sub">{n.lotNo}: {n.why}</span>)}</td>
                      {t.ok ? <><td>{t.model}{t.slopesP && <span className="cell-sub">slopes p = {t.slopesP}, intercepts p = {t.interceptsP}</span>}</td><td>{months(t.estimate)}</td><td>{t.limiting}</td></>
                        : <td colSpan={3} className="muted">{t.message}</td>}
                    </tr>))}
                </tbody>
              </table>
            </div>
            {can(me, 'qc.approve') && <p><button className="primary" disabled={!!g.signRefusal} title={g.signRefusal ?? ''} onClick={() => setSigning(g)}>Propose the {what} (QA)</button>
              {g.signRefusal && <span className="muted small"> {g.signRefusal}</span>}</p>}
          </div>))}
        {d.evaluations.length > 0 && (
          <table className="masters" aria-label="Signed evaluations">
            <caption>Signed</caption>
            <thead><tr><th>Condition</th><th>{what[0]!.toUpperCase() + what.slice(1)}</th><th>Limited by</th><th>Batches</th><th>Signed</th></tr></thead>
            <tbody>
              {d.evaluations.map((e) => (
                <tr key={e.id}>
                  <td>{e.condition}</td><td><b>{e.months} months</b></td>
                  <td>{e.outputs.proposal?.test ? `${e.outputs.proposal.test}, ${e.outputs.proposal.limiting ?? ''}` : ''}</td>
                  <td>{(e.inputs.studies ?? []).join(', ')}</td>
                  <td>{e.printedName}, {e.signedAt ? plantTime(e.signedAt) : ''} (QC approved)</td>
                </tr>))}
            </tbody>
          </table>)}
      </section>
      {d.arrhenius.length > 0 && (
        <section className="dash-panel samples-waiting" aria-label="Arrhenius">
          <div className="panel-head"><h2>Accelerated prediction (Arrhenius)</h2></div>
          <p className="notice">{d.arrhenius[0]!.advisory}</p>
          <ul>
            {d.arrhenius.map((a) => (
              <li key={`${a.protocolNumber}:${a.test}`}><b>{a.protocolNumber} · {a.test}</b> at {a.longTerm}: {a.ok ? <>about <b>{a.months} months</b><span className="cell-sub">{a.shown}</span></> : a.message}
                {a.rates.length > 0 && <span className="cell-sub">Rates: {a.rates.map((r) => `${r.label} ${r.rate}`).join('; ')}</span>}</li>))}
          </ul>
        </section>)}
      {signing && <SignEvaluation scope={JSON.parse(key) as EvalScope} group={signing} what={what} onCancel={() => setSigning(null)} onDone={async () => { setSigning(null); await load(); }} />}
      {answering && <ReportDialog row={answering} onCancel={() => setAnswering(null)}
        onSubmit={async (needed, text) => { await answerReport({ of: d.item.of, itemId: d.item.itemId, key: answering.key, needed, text }); setAnswering(null); await load(); }} />}
    </>
  );
}

/** QA answers the Q1E decision tree, sees the proposal, and signs it. */
function SignEvaluation({ scope, group, what, onCancel, onDone }: { scope: EvalScope; group: EvalGroup; what: string; onCancel: () => void; onDone: () => Promise<void> }) {
  const [a, setA] = useState<Answers>({ storage: group.storage, statistics: 'performed' });
  const [transforms, setTransforms] = useState<Record<string, 'none' | 'log'>>({});
  const [p, setP] = useState<Awaited<ReturnType<typeof previewEvaluation>> | null>(null);
  const [sign, setSign] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { previewEvaluation({ scope, group: group.key, answers: a, transforms }).then(setP, (e) => setError(plainError(e))); }, [a, transforms]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = <K extends keyof Answers>(k: K, label: string, options: readonly string[]) => (
    <label>{label}<select aria-label={label} value={a[k] ?? ''} onChange={(e) => setA({ ...a, [k]: e.target.value || undefined })}>
      <option value="">—</option>{options.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>);
  const proposal = p?.proposal;
  if (sign && proposal?.months != null) {
    return (
      <SignDialog meaning="qc_approved" what={`Sign the ${what}: ${group.protocolNumber}, ${group.label}`} onCancel={() => setSign(false)}
        onSign={async ({ proof }) => { await signEvaluation({ scope, group: group.key, answers: a, transforms, proof, contentHash: group.contentHash }); await onDone(); }}>
        <div className="summary-box">
          <p>Proposed {what}: <b>{proposal.months} months</b> (limited by {proposal.test}, {proposal.limiting})</p>
          <p className="small">Storage {a.storage}{a.accelerated ? `; accelerated: ${a.accelerated}` : ''}{a.intermediate ? `; intermediate: ${a.intermediate}` : ''}{a.change ? `; data: ${a.change}` : ''}{a.statistics ? `; statistics ${a.statistics}` : ''}.</p>
          {p!.tests.map((t) => <p key={t.key} className="small">{t.name}: {t.shown}</p>)}
        </div>
      </SignDialog>);
  }
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Propose the shelf life">
      <form className="card dialog" onSubmit={(e: FormEvent) => { e.preventDefault(); if (proposal?.months != null) setSign(true); }}>
        <h2>{group.protocolNumber} · {group.label}</h2>
        <p className="muted small">The ICH Q1E decision tree (Appendix A): answer what the data show; the template caps the extrapolation.</p>
        {pick('storage', 'Storage', ['room temperature', 'refrigerated', 'frozen'])}
        {a.storage !== 'frozen' && pick('accelerated', 'Significant change at accelerated', ['no significant change', 'significant change'])}
        {a.storage === 'room temperature' && a.accelerated === 'significant change' && pick('intermediate', 'Significant change at intermediate', ['no significant change', 'significant change'])}
        {a.storage !== 'frozen' && a.accelerated === 'no significant change' && pick('change', 'Long-term data show', ['little or none', 'change or variability'])}
        {pick('statistics', 'Statistical analysis', ['performed', 'not amenable'])}
        {group.tests.map((t: TestEvaluation) => (
          <label key={t.key}>{t.name}: fit<select aria-label={`Fit ${t.name}`} value={transforms[t.key] ?? 'none'} onChange={(e) => setTransforms({ ...transforms, [t.key]: e.target.value as 'none' | 'log' })}>
            <option value="none">linear</option><option value="log">log (first order)</option></select></label>))}
        <div className="summary-box" role="status">
          {p?.answersRefusal ? <p>{p.answersRefusal}</p> : proposal?.months != null ? <p>Proposed {what}: <b>{proposal.months} months</b> (limited by {proposal.test}, {proposal.limiting})</p>
            : <p>{proposal?.why ?? '…'}</p>}
          {p?.tests.filter((t) => t.branch).slice(0, 1).map((t) => <p key={t.key} className="small">{t.branch}; cap {t.cap} months.</p>)}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit" disabled={proposal?.months == null}>Continue to sign</button></div>
      </form>
    </div>
  );
}

function ReportDialog({ row, onSubmit, onCancel }: { row: ReportRow; onSubmit: (needed: boolean, text: string) => Promise<void>; onCancel: () => void }) {
  const [needed, setNeeded] = useState<boolean | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Regulator notice">
      <form className="card dialog" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (needed === null || !text.trim()) return setError('Answer yes or no, with the reference or why not.');
        try { await onSubmit(needed, text.trim()); } catch (x) { setError(plainError(x)); } }}>
        <h2>Regulator notice needed?</h2>
        <p>{row.kind === 'confirmed OOS' ? row.oosNo : 'Negative trend'} · {row.lotNo}, {row.label}, {row.month} months · {row.what}</p>
        <label><input type="radio" name="needed" checked={needed === true} onChange={() => setNeeded(true)} /> Yes</label>
        <label><input type="radio" name="needed" checked={needed === false} onChange={() => setNeeded(false)} /> No</label>
        <label>Reference or why not<textarea aria-label="Reference or why not" value={text} onChange={(e) => setText(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">Save</button></div>
      </form>
    </div>
  );
}

/** The product (or material) evaluation screen: its studies, the CTD downloads and the evaluation panel. */
export function ProductEvaluation({ me, of, itemId, onBack, onOpenStudy }: { me: Me; of: 'product' | 'material'; itemId: string; onBack: () => void; onOpenStudy: (id: number) => void }) {
  const [d, setD] = useState<EvaluationView | null>(null);
  useEffect(() => { getEvaluation({ of, itemId }).then(setD, () => setD(null)); }, [of, itemId]);
  return (
    <>
      <button className="link dark" onClick={onBack}>← Stability</button>
      <div className="home-head">
        <div>
          <h1>{d ? `${d.item.code} ${d.item.name}` : 'Stability evaluation'}</h1>
          <p className="greeting">Stability evaluation of the {of}: the {of === 'material' ? 'retest period' : 'shelf life'} from ICH Q1E, signed by QA.</p>
        </div>
        <div>
          <a className="button" href={ctdLink(of, itemId, 'pdf')} download>CTD {of === 'material' ? '3.2.S.7.3' : '3.2.P.8.3'} (PDF)</a>{' '}
          <a className="button" href={ctdLink(of, itemId, 'csv')} download>CTD table (CSV)</a>
        </div>
      </div>
      {d && <p>Studies: {d.studies.map((s, k) => <span key={s.id}>{k ? ', ' : ''}<button className="link dark" onClick={() => onOpenStudy(s.id)}>{s.studyNo}</button> ({s.lotNo}, {s.protocolNumber})</span>)}</p>}
      <EvaluationPanel me={me} scope={{ of, itemId }} />
    </>
  );
}
