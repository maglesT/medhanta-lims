// One OOS investigation (LIMS-23, LIMS-24, LIMS-48), one screen top to bottom: the result as recorded; phase Ia (the
// checklist) and Ib (re-measurements, each planned in writing first, every result shown, none averaged); the phase I
// conclusion and the supervisor's review; QA's invalidation and the retests it authorised; or phase II in Deviations
// and QA's conclusion; the other lots of the item; and the history.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { plantTime, type Me } from '../api.js';
import { analysisLink, go, plainError } from '../api-floor.js';
import { SignDialog } from '../components/SignDialog.js';
import { IssueDialog } from '../floor/IssueDialog.js';
import { OOS_STATUS_WORDS, oosClosed, type OosAction } from '../../../shared/engine/oos.js';
import { OOS_CHIP, OOS_LABEL, getOos, oosAction, type OosDetail, type OosEntry } from './api-oos.js';
import '../designer/designer.css';
import '../floor/floor.css';
import '../release/release.css';
import '../samples/samples.css';
import './oos.css';

const ENTRY_WORDS: Record<OosEntry['kind'], string> = {
  checklist: 'Phase Ia checklist answered', plan: 'Re-measurement planned', remeasured: 'Re-measured', phase1_concluded: 'Phase I concluded',
  phase1_returned: 'Phase I returned', phase1_reviewed: 'Phase I reviewed', phase2: 'Phase II deviation recorded', phase2_checked: 'Deviation number checked (second person)',
  concluded: 'Concluded by QA', retest: 'Retest started',
};
function entryText(e: OosEntry): string {
  const p = e.payload;
  switch (e.kind) {
    case 'checklist': return Object.values(p.answers ?? {}).filter((a) => a && !a.yes).length ? `${Object.values(p.answers ?? {}).filter((a) => a && !a.yes).length} answered no` : 'All answered yes';
    case 'plan': return `${p.what} · by ${p.by}`;
    case 'remeasured': return `${p.shown ?? p.value} · raw data: ${p.reference}`;
    case 'phase1_concluded': return p.labError ? `Assignable laboratory error: ${p.cause}` : 'No laboratory error found';
    case 'phase2': return `${p.reference}${p.source?.from === 'hand' ? ' (typed by hand: Deviations was not reachable)' : ' (picked from Deviations)'}`;
    case 'concluded': return `${p.outcome === 'invalidated' ? 'Invalidated' : 'OOS confirmed'}: ${p.reason}${p.cause ? ` · cause: ${p.cause}` : ''}${p.retests ? ` · ${p.retests} retest${p.retests === 1 ? '' : 's'} authorised` : ''}`;
    case 'retest': return `Analysis ${p.analysisNo}`;
    default: return p.reason ?? '';
  }
}
const by = (e: OosEntry) => `${e.signature ? `signed by ${e.signature.printedName}` : e.personName}, ${plantTime(e.signature?.signedAt ?? e.at)}`;

export function OosScreen({ me, id }: { me: Me; id: number }) {
  const [d, setD] = useState<OosDetail | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => getOos(id).then((x) => { setD(x); setError(''); }, (e) => setError(plainError(e))), [id]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <>{error ? <p className="notice" role="alert">{error}</p> : <div className="skel skel-block" />}</>;
  const o = d.oos;
  const can = (a: OosAction) => d.actions.includes(a);
  const run = async (a: OosAction, body: object) => {
    try { await oosAction(id, a, body); setError(''); await load(); } catch (e) { setError(plainError(e)); }
  };
  return (
    <>
      <button className="link dark" onClick={() => go('#/oos')}>← OOS</button>
      <div className="home-head">
        <div>
          <h1>{o.oosNo} <span className={OOS_CHIP[d.status]}>{OOS_LABEL[d.status]}</span></h1>
          <p className="greeting">{OOS_STATUS_WORDS[d.status]} · <b>{o.item.code}</b> {o.item.name} · {o.item.of === 'material' ? 'lot' : 'batch'} {o.lotNo}</p>
        </div>
      </div>
      {error && <p className="notice bad" role="alert">{error}</p>}
      <section className="dash-panel samples-waiting" aria-label="The result">
        <div className="panel-head"><h2>The result out of limits</h2><span className="muted">as recorded; it stays on the record</span></div>
        <dl className="details">
          <dt>Test</dt><dd>{o.result.name} · limit {o.result.limit}</dd>
          <dt>Result</dt><dd><b>{o.result.shown}</b> <span className="chip chip-bad">out of limits</span></dd>
          <dt>Analysis</dt><dd><a href={analysisLink(o.analysisId)}>{o.analysisNo}</a>{d.original ? ` · ${d.original.status}` : ''}</dd>
          <dt>Sample</dt><dd>{o.sampleNo} · {o.specNumber}, version {o.specVersionNo}</dd>
          <dt>Opened</dt><dd>at once, when {o.openedByName} signed the result, {plantTime(o.openedAt)}</dd>
        </dl>
      </section>

      <Phase title="Phase Ia: laboratory checklist" sub="by the analyst: every item answered; a “no” says what was found">
        <Checklist d={d} edit={can('checklist')} onSave={(answers) => run('checklist', { answers })} />
      </Phase>

      <Phase title="Phase Ib: hypothesis testing" sub="a re-measurement is done only as written in its plan first; every result is shown, none is averaged with the OOS result">
        {d.plans.length === 0 && <p className="muted">No re-measurement planned.</p>}
        <ol className="rv-list">
          {d.plans.map(({ plan, result }, i) => (
            <li key={plan.id} className={result ? (result.payload.pass === false ? 'bad' : 'ok') : ''}>
              <b>Plan {i + 1}: {plan.payload.what}</b><small>by {plan.payload.by} · written by {plan.personName}, {plantTime(plan.at)}</small>
              {result ? <span>Result: <b>{result.payload.shown ?? result.payload.value}</b> · raw data {result.payload.reference} · {result.personName}, {plantTime(result.at)}</span>
                : can('remeasure') ? <Remeasure onSave={(b) => run('remeasure', { plan: plan.id, ...b })} /> : <small>Not measured yet.</small>}
            </li>
          ))}
        </ol>
        {can('plan') && <Fields label="Write a plan" button="Save the plan" fields={[['what', 'What is re-measured, and how', 'e.g. Re-inject the same sample solution twice'], ['by', 'By whom', 'e.g. The analyst, on HPLC-02']]} onSave={(v) => run('plan', v)} />}
      </Phase>

      <Phase title="Phase I conclusion and review" sub="concluded by the analyst; reviewed by a supervisor who did no part of it">
        {d.conclusion ? <p className={d.conclusion.payload.labError ? 'notice' : 'notice info'}><b>{entryText(d.conclusion)}</b> · {by(d.conclusion)}</p> : !can('conclude-phase1') && <p className="muted">Not concluded yet.{d.status === 'phase I' && d.refusals['conclude-phase1'] ? ` ${d.refusals['conclude-phase1']}` : ''}</p>}
        {can('conclude-phase1') && <ConcludePhase1 onSave={(b) => run('conclude-phase1', b)} />}
        {d.events.filter((e) => e.kind === 'phase1_reviewed' || e.kind === 'phase1_returned').map((e) => (
          <p key={e.id} className={e.kind === 'phase1_reviewed' ? 'all-good' : 'notice'}>{ENTRY_WORDS[e.kind]}{e.payload.reason ? `: ${e.payload.reason}` : ''} · {by(e)}</p>))}
        {can('review') && <Signed meaning="reviewed" button="Sign: phase I reviewed" what={`Phase I of ${o.oosNo}: ${d.conclusion ? entryText(d.conclusion) : ''}`} why="Your signature means: you reviewed the checklist, the re-measurements and the conclusion of phase I and agree with them." onSign={(proof) => run('review', { proof, contentHash: d.contentHash })} />}
        {can('return') && <Fields label="Return phase I" button="Return phase I" fields={[['reason', 'Reason', 'e.g. Check the standard preparation record too']]} onSave={(v) => run('return', v)} />}
        {d.status === 'phase I review' && !can('review') && <p className="muted small">{d.refusals.review}</p>}
      </Phase>

      {(d.status === 'phase II' || d.phase2) && (
        <Phase title="Phase II: manufacturing investigation" sub="in Deviations; QA concludes when its deviation is closed">
          {d.phase2 && (
            <p className={d.phase2.deviation?.status === 'closed' ? 'all-good' : 'notice info'}>
              Deviation <b>{d.phase2.reference}</b>{d.phase2.typed ? ' (typed by hand)' : ''} · {d.phase2.link === 'ok' ? (d.phase2.deviation ? `${d.phase2.deviation.status.replaceAll('_', ' ')} in Deviations${d.phase2.deviation.title ? `: ${d.phase2.deviation.title}` : ''}` : 'not in Deviations') : 'Deviations does not answer now'}
              {d.phase2.typed && (d.phase2.checked ? ' · checked by a second person' : ' · waiting for a second person\'s check')}
            </p>)}
          {can('phase2') && <Phase2Pick d={d} onSave={(reference) => run('phase2', { reference })} />}
          {can('check-phase2') && <div className="decide"><p className="why">Compare the number with the deviation record (or its paper copy). Confirm only if they agree.</p><button className="primary" onClick={() => run('check-phase2', {})}>Confirm the deviation number</button></div>}
        </Phase>
      )}

      {(can('conclude') || oosClosed(d.status)) && (
        <Phase title="QA conclusion" sub="QA's e-signature: the result invalidated (an assignable laboratory cause) or the OOS confirmed">
          {d.events.filter((e) => e.kind === 'concluded').map((e) => <p key={e.id} className={e.payload.outcome === 'invalidated' ? 'notice info' : 'notice bad'}><b>{entryText(e)}</b> · {by(e)}</p>)}
          {can('conclude') && <Conclude d={d} onSign={(b) => run('conclude', { ...b, contentHash: d.contentHash })} />}
        </Phase>
      )}

      {d.status === 'invalidated' && (
        <Phase title="Retests" sub="new analyses of the same sample, linked to this OOS; the invalidated analysis stays on the record">
          <p>{d.retests.authorised} retest{d.retests.authorised === 1 ? '' : 's'} authorised{d.retests.by ? ` by ${d.retests.by.signature?.printedName ?? d.retests.by.personName}, ${plantTime(d.retests.by.at)}` : ''} · {d.retests.analyses.length} started.</p>
          <ul className="rv-list">
            {d.retests.analyses.map((a) => <li key={a.analysisId} className={a.result?.pass === false ? 'bad' : a.result ? 'ok' : ''}><span><a href={analysisLink(a.analysisId)}>{a.analysisNo}</a> · {a.status}{a.result ? <> · <b>{`${a.result.value} ${a.result.unit}`.trim()}</b> {a.result.pass !== undefined && (a.result.pass ? 'within limits' : 'out of limits')}</> : ''}</span></li>)}
          </ul>
          <RetestButton d={d} me={me} />
        </Phase>
      )}

      <Phase title="Other lots of this item" sub="for the impact on other lots or batches">
        {d.others.length ? <ul className="rv-list">{d.others.map((x) => <li key={x.id}><span><b>{x.sampleNo}</b> · {x.lotNo} · {x.purpose} · {x.decision ?? 'not decided'} · {plantTime(x.registeredAt)}</span></li>)}</ul> : <p className="muted">No other samples of {o.item.code}.</p>}
      </Phase>

      <section className="dash-panel samples-waiting" aria-label="History">
        <div className="panel-head"><h2>History</h2></div>
        <ol className="custody">
          <li><b>Opened</b><span className="muted">{o.openedByName}, {plantTime(o.openedAt)}</span></li>
          {d.events.map((e) => <li key={e.id}><b>{ENTRY_WORDS[e.kind]}</b>{entryText(e) && <span>{entryText(e)}</span>}<span className="muted"> {by(e)}</span></li>)}
        </ol>
      </section>
    </>
  );
}

const Phase = ({ title, sub, children }: { title: string; sub: string; children: ReactNode }) => (
  <section className="dash-panel samples-waiting" aria-label={title}>
    <div className="panel-head"><h2>{title}</h2><span className="muted">{sub}</span></div>
    {children}
  </section>
);

function Checklist({ d, edit, onSave }: { d: OosDetail; edit: boolean; onSave: (a: Record<string, { yes: boolean; comment?: string }>) => Promise<void> }) {
  const last = d.events.filter((e) => e.kind === 'checklist').at(-1);
  const [a, setA] = useState<Record<string, { yes?: boolean; comment?: string }>>({});
  const [again, setAgain] = useState(false);
  if (!edit || (last && !again)) {
    if (!last) return <p className="muted">Not answered yet.</p>;
    return (<>
      <ul className="rv-list">{d.checklist.map(([k, label]) => { const x = last.payload.answers?.[k as never] as { yes: boolean; comment?: string } | undefined;
        return <li key={k} className={x?.yes ? 'ok' : 'bad'}><span>{label}: <b>{x?.yes ? 'yes' : 'no'}</b>{x?.comment ? ` · ${x.comment}` : ''}</span></li>; })}</ul>
      <p className="muted small">{last.personName}, {plantTime(last.at)}</p>
      {edit && <button onClick={() => setAgain(true)}>Answer the checklist again</button>}
    </>);
  }
  const done = d.checklist.every(([k]) => a[k]?.yes !== undefined && (a[k]!.yes || a[k]!.comment?.trim()));
  return (
    <div className="oos-checklist">
      {d.checklist.map(([k, label]) => (
        <fieldset key={k}>
          <legend>{label}</legend>
          <label className="inline"><input type="radio" name={`ck-${k}`} checked={a[k]?.yes === true} onChange={() => setA((x) => ({ ...x, [k]: { yes: true } }))} /> Yes</label>
          <label className="inline"><input type="radio" name={`ck-${k}`} checked={a[k]?.yes === false} onChange={() => setA((x) => ({ ...x, [k]: { yes: false, comment: x[k]?.comment ?? '' } }))} /> No</label>
          {a[k]?.yes === false && <input aria-label={`${label}: what was found`} placeholder="What was found" value={a[k]?.comment ?? ''} onChange={(e) => setA((x) => ({ ...x, [k]: { yes: false, comment: e.target.value } }))} />}
        </fieldset>
      ))}
      <button className="primary" disabled={!done} onClick={() => void onSave(Object.fromEntries(Object.entries(a).map(([k, x]) => [k, { yes: !!x.yes, ...(x.yes ? {} : { comment: x.comment?.trim() }) }]))).then(() => { setAgain(false); setA({}); })}>Save the checklist</button>
    </div>
  );
}

function Fields({ label, button, fields, onSave }: { label: string; button: string; fields: [string, string, string][]; onSave: (v: Record<string, string>) => Promise<void> }) {
  const [v, setV] = useState<Record<string, string>>({});
  const ready = fields.every(([n]) => v[n]?.trim());
  return (
    <div className="decide" aria-label={label}>
      {fields.map(([n, l, hint]) => <label key={n}>{l}<input aria-label={l} placeholder={hint} value={v[n] ?? ''} onChange={(e) => setV((x) => ({ ...x, [n]: e.target.value }))} /></label>)}
      <button className="primary" disabled={!ready} onClick={() => void onSave(Object.fromEntries(fields.map(([n]) => [n, v[n]!.trim()]))).then(() => setV({}))}>{button}</button>
    </div>
  );
}

const Remeasure = ({ onSave }: { onSave: (b: { value: string; reference: string }) => Promise<void> }) => (
  <Fields label="Record the re-measurement" button="Record the result" fields={[['value', 'Result', 'e.g. 6.2'], ['reference', 'Where its raw data are', 'e.g. pH meter printout 13, CDS run 2611-04']]}
    onSave={(v) => onSave({ value: v.value!, reference: v.reference! })} />
);

function ConcludePhase1({ onSave }: { onSave: (b: { labError: boolean; cause?: string }) => Promise<void> }) {
  const [lab, setLab] = useState<boolean | null>(null);
  const [cause, setCause] = useState('');
  return (
    <div className="decide">
      <fieldset>
        <legend>Was an assignable laboratory error found?</legend>
        <label className="inline"><input type="radio" name="lab" checked={lab === true} onChange={() => setLab(true)} /> Yes: a laboratory error</label>
        <label className="inline"><input type="radio" name="lab" checked={lab === false} onChange={() => setLab(false)} /> No laboratory error found</label>
      </fieldset>
      {lab && <label>The assignable cause<input aria-label="The assignable cause" value={cause} onChange={(e) => setCause(e.target.value)} placeholder="e.g. pH meter calibrated with an expired buffer" /></label>}
      <button className="primary" disabled={lab === null || (lab && !cause.trim())} onClick={() => void onSave(lab ? { labError: true, cause: cause.trim() } : { labError: false })}>Conclude phase I</button>
    </div>
  );
}

function Phase2Pick({ d, onSave }: { d: OosDetail; onSave: (reference: string) => Promise<void> }) {
  const [ref, setRef] = useState('');
  const linked = d.deviations.link === 'ok';
  return (
    <div className="decide">
      {linked ? (
        <label>Deviation in Deviations (those naming analysis {d.oos.analysisNo})
          <select aria-label="Phase II deviation" value={ref} onChange={(e) => setRef(e.target.value)}>
            <option value="">Pick the deviation filed for this OOS</option>
            {d.deviations.list.map((x) => <option key={x.number} value={x.number}>{x.number} · {x.status.replaceAll('_', ' ')}{x.title ? ` · ${x.title}` : ''}</option>)}
          </select>
        </label>
      ) : (
        <label>Deviation number (typed by hand: Deviations {d.deviations.link === 'down' ? 'does not answer' : 'is not linked'}; a second person checks it)
          <input aria-label="Phase II deviation" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. DEV-26-0300" />
        </label>
      )}
      <button className="primary" disabled={!ref.trim()} onClick={() => void onSave(ref.trim())}>Record the phase II deviation</button>
    </div>
  );
}

function Signed({ meaning, button, what, why, onSign }: { meaning: string; button: string; what: string; why: string; onSign: (proof: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (<>
    <div className="decide"><p className="why">{why}</p><button className="big ok" onClick={() => setOpen(true)}>{button}</button></div>
    {open && <SignDialog meaning={meaning} what={what} onCancel={() => setOpen(false)} onSign={async ({ proof }) => { setOpen(false); await onSign(proof); }} />}
  </>);
}

function Conclude({ d, onSign }: { d: OosDetail; onSign: (b: object) => Promise<void> }) {
  const labError = d.status === 'QA approval';
  const [outcome, setOutcome] = useState<'confirmed' | 'invalidated'>(labError ? 'invalidated' : 'confirmed');
  const [reason, setReason] = useState('');
  const [cause, setCause] = useState('');
  const [retests, setRetests] = useState(1);
  const [open, setOpen] = useState(false);
  const ready = reason.trim() && (outcome === 'confirmed' || labError || cause.trim());
  return (<>
    <div className="decide reject">
      {labError ? <p className="why">Phase I found an assignable laboratory error: <b>{d.conclusion?.payload.cause}</b>. Invalidating the result marks analysis {d.oos.analysisNo} invalidated (it stays on the record) and authorises the retests.</p> : (
        <fieldset>
          <legend>Outcome</legend>
          <label className="inline"><input type="radio" name="outcome" checked={outcome === 'confirmed'} onChange={() => setOutcome('confirmed')} /> OOS confirmed</label>
          <label className="inline"><input type="radio" name="outcome" checked={outcome === 'invalidated'} onChange={() => setOutcome('invalidated')} /> Invalidated: phase II found a laboratory cause</label>
        </fieldset>)}
      {!labError && outcome === 'invalidated' && <label>The assignable laboratory cause<input aria-label="The assignable laboratory cause" value={cause} onChange={(e) => setCause(e.target.value)} /></label>}
      {outcome === 'invalidated' && <label>Retests authorised<select aria-label="Retests authorised" value={retests} onChange={(e) => setRetests(Number(e.target.value))}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>}
      <label>Reason<textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></label>
      <button className="big ok" disabled={!ready} onClick={() => setOpen(true)}>{outcome === 'invalidated' ? 'Sign: invalidate the result' : 'Sign: OOS confirmed'}</button>
    </div>
    {open && (
      <SignDialog meaning="oos_approved" what={`${d.oos.oosNo} · ${d.oos.result.name} ${d.oos.result.shown} · ${outcome === 'invalidated' ? 'invalidated' : 'OOS confirmed'}`} onCancel={() => setOpen(false)}
        onSign={async ({ proof }) => { setOpen(false); await onSign({ proof, outcome, reason: reason.trim(), ...(outcome === 'invalidated' ? { retests, ...(labError ? {} : { cause: cause.trim() }) } : {}) }); }}>
        <div className="summary-box"><p>Reason: <b>{reason.trim()}</b></p></div>
      </SignDialog>
    )}
  </>);
}

function RetestButton({ d, me }: { d: OosDetail; me: Me }) {
  const [open, setOpen] = useState(false);
  if (!me.permissions.includes('lims.analysis.perform')) return null;
  if (d.retestRefusal) return <p className="muted small">{d.retestRefusal}</p>;
  if (!d.retestMethod) return <p className="muted small">The method of this test has no effective version.</p>;
  const m = d.retestMethod;
  return (<>
    <button className="primary" onClick={() => setOpen(true)}>Start the retest ({m.code})</button>
    {open && <IssueDialog row={{ id: m.id, versionNo: m.versionNo, header: { code: m.code, name: m.name } }} sampleId={d.oos.sampleId} sampleNo={d.oos.sampleNo}
      oos={{ id: d.oos.id, oosNo: d.oos.oosNo }} onCancel={() => setOpen(false)} />}
  </>);
}
