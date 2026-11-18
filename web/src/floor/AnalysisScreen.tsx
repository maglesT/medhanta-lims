import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from '../api.js';
import { product } from '../product.js';
import {
  analysisLink, changed, go, headline, pdfLink, plainClock, plainError, stateLabel, STATUS_CHIP, statusText, stepLink, stepOf, stepTitle, timeLeft, tone, useBlocks, words, useServerNow,
  type AnalysisDetail, type Block, type StepRow,
} from '../api-floor.js';
import { StepScreen } from './StepScreen.js';
import { DemoSkip } from './DemoSkip.js';
import { Stop, stoppedText } from '../release/Stop.js';
import { deviationText } from '../../../shared/engine/release.js';
import './floor.css';

// One analysis at the bench: its header, the stages as a progress bar and the alerts, then the overview or one step. Read again on every move between them (what others did shows at once) and after every action;
// a background poll every 20 s is the fallback.
export function AnalysisScreen({ me, id, step, approve }: { me: Me; id: number; step?: string; approve?: boolean }) {
  const [d, setD] = useState<AnalysisDetail | null>(null);
  const [error, setError] = useState('');
  const blocks = useBlocks();
  const reload = useCallback(async (background = false) => {
    try { setD(await api<AnalysisDetail>('GET', `/api/analyses/${id}`, undefined, background)); setError(''); } catch (e) { setError(plainError(e)); }
  }, [id]);
  useEffect(() => setD(null), [id]);
  useEffect(() => { void reload(); }, [reload, step, approve]);
  useEffect(() => {
    const t = setInterval(() => void reload(true), 20_000);
    return () => clearInterval(t);
  }, [reload]);
  const now = useServerNow(d?.now);

  if (error && !d) return <div className="fl"><button className="back" onClick={() => go('#/')}>← My work</button><p className="notice bad" role="alert">{error}</p></div>;
  if (!d || !blocks) {
    return (
      <div className="fl" aria-label="Loading the analysis">
        <div className="dash-panel"><div className="skel skel-line w40" /><div className="skel skel-line w60" /><div className="skel skel-block" /></div>
        <div className="dash-panel"><div className="skel skel-line w30" />{[0, 1, 2].map((i) => <div key={i} className="skel skel-row" />)}</div>
      </div>
    );
  }
  const row = step ? d.steps.find((s) => s.id === step) : undefined;
  return (
    <div className="fl">
      <button className="back" onClick={() => go(step || approve ? analysisLink(id) : '#/')}>← {step || approve ? `Analysis ${d.analysis.analysisNo}` : 'My work'}</button>
      {error && <p className="notice bad" role="alert">{error}</p>}
      {step ? (row ? <StepScreen me={me} d={d} blocks={blocks} row={row} now={now} reload={reload} /> : <p className="notice">This step is not open in the analysis yet.</p>)
        : <><Overview d={d} blocks={blocks} now={now} reload={() => reload()} /><DemoSkip me={me} d={d} reload={() => reload()} /></>}
    </div>
  );
}

export function AnalysisHeader({ d }: { d: AnalysisDetail }) {
  const h = d.master.doc.header;
  return (
    <section className="dash-panel bh" aria-label="Analysis">
      <div>
        <span className="bno">{d.analysis.analysisNo}</span>
        <h1>{h.name}</h1>
        <div className="meta">
          <span>Method <b>{h.code}</b></span>
          <span>Technique <b>{h.technique}</b></span>
          <span>Method version <b>{d.master.versionNo}</b></span>
          <span>Issued <b>{plainClock(d.analysis.issuedAt)}</b></span>
        </div>
      </div>
      <span className="bh-side">
        <span className={`chip ${STATUS_CHIP[d.analysis.status] ?? ''}`}>{statusText(d.analysis.status, true)}</span>
        <a className="button" href={pdfLink(d.analysis.id)} download>Analysis record (PDF)</a>
      </span>
    </section>
  );
}

const finished = (s: StepRow) => ['done', 'checked', 'not_applicable'].includes(s.state);

function Overview({ d, blocks, now, reload }: { d: AnalysisDetail; blocks: Block[]; now: number; reload: () => Promise<void> }) {
  const at = d.stages.find((s) => s.open && !s.closed) ?? d.stages.find((s) => !s.closed);
  // An analysis stopped or reviewed runs no more: no stage is "now"; one left unclosed says Stopped.
  const ended = !!d.analysis.stopped || d.analysis.status === 'reviewed';
  const current = ended ? undefined : at;
  const [shown, setShown] = useState(at?.index ?? 0);
  const doc = d.master.doc;
  const title = (s: StepRow) => stepTitle(doc, blocks, stepOf(doc, s.key));
  const stage = doc.stages[shown]!;
  const steps = d.steps.filter((s) => s.key.stage === shown);
  return (
    <>
      <AnalysisHeader d={d} />
      {d.analysis.stopped && <p className="notice bad" role="note"><b>{stoppedText(d.analysis.stopped, plainClock)}</b></p>}
      <nav className="stagebar" aria-label="Stages">
        {d.stages.map((s) => (
          <button key={s.key} className={`${s.closed ? 'closed' : s === current ? 'current' : ''}${s.index === shown ? ' on' : ''}`} onClick={() => setShown(s.index)} aria-pressed={s.index === shown}>
            <small>{s.closed ? '✓ Closed' : ended ? 'Stopped' : s === current ? 'Now' : s.open ? 'Open' : 'Waiting'}</small><span>{s.name}</span>
          </button>
        ))}
      </nav>
      <Alerts d={d} blocks={blocks} now={now} />
      <section className="dash-panel" aria-label={`Stage ${stage.name}`}>
        <div className="panel-head"><h2>{stage.name}</h2><span className="muted">{stage.kind === 'replicate' ? `${stage.count} replicates · ` : ''}{steps.filter(finished).length} of {steps.length} steps finished</span></div>
        {!d.analysis.stopped && d.stages[shown]!.blocked && <p className="notice">{d.stages[shown]!.blocked}</p>}
        <div className="steplist">
          {steps.map((s) => {
            const st = stepOf(doc, s.key);
            const rounds = st.flow.kind === 'repeat-until';
            return (
              <button key={s.id} className={`step-row st-${s.state}`} onClick={() => go(stepLink(d.analysis.id, s.id))}>
                <span className="n">{s.key.step + 1}</span>
                <span>{title(s)}{(rounds || stage.kind === 'replicate') && <small>{stage.kind === 'replicate' ? `Replicate ${s.key.sub}` : ''}{rounds ? ` Round ${s.key.round}` : ''}</small>}
                  {s.blocked && !d.analysis.stopped && <small>{s.blocked}</small>}
                  {d.analysis.deviations.filter((x) => x.step === s.id).map((x) => <small key={x.note} className={x.open ? 'dev-open' : undefined}>Deviation {deviationText(x)}</small>)}</span>
                <span className={`chip ${s.needsResign ? 'chip-warn' : stateLabel(s.state, d.analysis.stopped)[1]}`}>{s.needsResign ? 'Sign again' : stateLabel(s.state, d.analysis.stopped)[0]}</span>
                <span className="go" aria-hidden="true">›</span>
              </button>
            );
          })}
        </div>
      </section>
      {!d.analysis.stopped && <section className="dash-panel" aria-label="Review">
        <div className="panel-head"><h2>Review</h2><span className="muted">by a second person, with the audit trail, when every step is finished</span></div>
        <p className={d.analysis.status === 'in progress' ? 'muted' : 'all-good'}>{d.analysis.status === 'in progress' ? `${d.analysis.open.length} item${d.analysis.open.length === 1 ? '' : 's'} still open.`
          : d.analysis.status === 'complete' ? 'Complete: waiting for the review (To review).' : `The analysis is ${statusText(d.analysis.status)}.`}</p>
      </section>}
      {d.analysis.actions.includes('stop') && (
        <section className="dash-panel" aria-label="Stop the analysis">
          <div className="panel-head"><h2>Stop the analysis</h2><span className="muted">when it cannot be finished: its record is kept</span></div>
          <Stop id={d.analysis.id} analysisNo={d.analysis.analysisNo} onDone={reload} />
        </section>
      )}
    </>
  );
}

/** Timers, waiting checks, steps whose input changed, open deviation notes: each one opens its step. */
export function Alerts({ d, blocks, now, only }: { d: AnalysisDetail; blocks: Block[]; now: number; only?: string }) {
  const doc = d.master.doc;
  const title = (key: StepRow['key']) => stepTitle(doc, blocks, stepOf(doc, key));
  const id = (k: StepRow['key']) => `${k.stage}.${k.sub}.${k.step}.${k.round}`;
  const items: { tone: string; tag: string; text: string; sub?: string; step?: string; at?: number }[] = [];
  // On the step screen the step shows its next periodic check itself.
  for (const t of d.timers.filter((x) => !only || x.kind !== 'periodic')) {
    const left = Date.parse(t.at) - now;
    // A minimum time or a mixing time is never late; a wait skipped in a demo installation is due from the skip (server/demo.ts).
    const least = t.kind === 'minimum' || t.kind === 'duration';
    const late = t.state === 'late' || (!least && !t.skipped && left < 0);
    // The periodic timer belongs to the next round; it is shown on the round that started it.
    const prev = t.kind === 'periodic' ? id({ ...t.key, round: t.key.round - 1 }) : id(t.key);
    items.push({ tone: late ? 'bad' : t.state === 'due soon' || t.state === 'due' ? 'warn' : 'info', tag: t.kind === 'hold' ? (late ? 'Hold time exceeded' : 'Hold time') : t.kind === 'periodic' ? (late ? 'Check overdue' : 'Next check') : 'Minimum time',
      text: t.label, sub: t.skipped ? `DEMO: wait skipped, ${plainClock(t.skipped.at)}` : late ? `Ran out ${plainClock(t.at)}: a deviation note is needed` : least ? `Can be ${t.kind === 'duration' ? 'ended' : 'finished'} from ${plainClock(t.at)}` : `Due ${plainClock(t.at)}`,
      step: t.kind === 'hold' ? undefined : prev, at: late || t.skipped || (least && left <= 0) ? undefined : left });
  }
  // The step screen explains these itself; a terminated analysis has no check or signature still to come.
  for (const s of only || d.analysis.stopped ? [] : d.steps) {
    if (s.state === 'done_awaiting_check') items.push({ tone: 'warn', tag: 'Waiting for check', text: title(s.key), sub: 'A second person checks this step on their own device', step: s.id });
    if (s.inputChanged.length) items.push({ tone: 'warn', tag: 'Input changed', text: title(s.key), sub: 'A value this step used was corrected: sign it again', step: s.id });
  }
  for (const v of d.analysis.deviations.filter((x) => x.open)) items.push({ tone: 'bad', tag: 'Open deviation', text: `${deviationText(v)}: ${v.text}`, step: v.step });
  const shown = only ? items.filter((x) => x.step === only) : items;
  if (!shown.length) return only ? null : <p className="all-good"><span aria-hidden="true">✓</span> No alerts on this analysis.</p>;
  return (
    <div className="alerts" aria-label="Alerts">
      {shown.map((x, i) => {
        const body = (<><span className="tag">{x.tag}</span><span>{x.text}{x.sub && <small>{x.sub}</small>}</span>{x.at !== undefined ? <span className="countdown">in {timeLeft(x.at)}</span> : <span />}</>);
        return only || !x.step
          ? <div key={i} className={`fl-alert ${x.tone}`}>{body}</div>
          : <button key={i} className={`fl-alert ${x.tone}`} onClick={() => go(stepLink(d.analysis.id, x.step!))}>{body}</button>;
      })}
    </div>
  );
}

