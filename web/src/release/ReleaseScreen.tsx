import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, can, MEANING_LABEL, type Me } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import {
  blockOf, changed, go, headline, pdfLink, plainClock, plainError, statusText, stepOf, tone, useBlocks, valueText, words,
  type AnalysisDetail, type Block, type FloorEvent, type Source, type TimerRow, type Value,
} from '../api-floor.js';
import { fieldLabel as labelOf, PROVIDER_NAME } from '../../../shared/engine/links.js';
import { stepLabel } from '../../../shared/engine/analysis.js';
import { deviationNumber, deviationStatusWords } from '../../../shared/engine/release.js';
import { skillText } from '../../../shared/engine/training.js';
import { AnalysisHeader } from '../floor/AnalysisScreen.js';
import { ReasonDialog } from '../floor/ReasonDialog.js';
import { stoppedText } from './Stop.js';
import { product } from '../product.js';
import '../floor/floor.css';
import './release.css';

// What the reviewer reviews (GET /api/analyses/:id/review): the audit-trail review of the analysis (LIMS-19), done here
// and covered by the review signature.
interface Review {
  status: string;
  corrections: { step: string; field: string; was: Value; now: Value; reason: string; personName: string | null; at: string }[];
  sentBack: FloorEvent[];
  late: { timer: TimerRow; notes: FloorEvent[] }[];
  outOfLimits: { step: string; calc: string; shown: string; notes: FloorEvent[] }[];
  inputChanged: { step: string; changes: FloorEvent[] }[];
  deviations: { note: number; step: string; reference: string; text: string; open: boolean; status?: string; closedAt?: string | null; filed?: boolean; typed?: boolean; closed?: { personName: string; at: string; payload: { reason?: string } } }[];
  // Owner 15 Nov 2026: every value typed by hand because a link was absent or down, and the Deviations link's state.
  hand: (Extract<Source, { from: 'hand' }> & { step: string; field: string; event: number; personName: string | null; at: string })[];
  unlinked: { number: string; status: string; title: string | null }[];
  // Owner 17 Nov 2026: signatures whose training was ticked by the signer because Recruitment was not reachable.
  trainingTyped: { step: string; event: number; kind: string; code: string; title?: string; state: 'absent' | 'down'; personName: string | null; at: string }[];
  deviationsLink: string;
  notApplicable: FloorEvent[];
  // Demo installations only: the waits ended at once (server/demo.ts).
  demoSkips: FloorEvent[];
  analysisEvents: { id: number; kind: string; payload: { reason?: string }; personName: string; at: string }[];
  signatures: { objectType: string; printedName: string; meaning: string; signedAt: string; step: string | null }[];
}
type Signing = { meaning: 'reviewed'; action: 'review' };

// The second person's review of a complete analysis (LIMS-18, LIMS-19), signed after reading everything below.
export function ReleaseScreen({ me, id }: { me: Me; id: number }) {
  const [d, setD] = useState<AnalysisDetail | null>(null);
  const [r, setR] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [signing, setSigning] = useState<Signing | null>(null);
  const [closing, setClosing] = useState<Review['deviations'][number] | null>(null);
  const blocks = useBlocks();
  const reload = useCallback(async (background = false) => {
    try {
      const [b, v] = await Promise.all([api<AnalysisDetail>('GET', `/api/analyses/${id}`, undefined, background), api<Review>('GET', `/api/analyses/${id}/review`, undefined, background)]);
      setD(b); setR(v); setError('');
    } catch (e) { setError(plainError(e)); }
  }, [id]);
  // Read on opening and after every action; a background poll every 20 s shows what others did meanwhile.
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(true), 20_000);
    return () => clearInterval(t);
  }, [reload]);

  const back = <button className="back" onClick={() => go('#/release')}>← To review</button>;
  if (!d || !r || !blocks) return <div className="fl">{back}{error ? <p className="notice bad" role="alert">{error}</p> : <div className="dash-panel"><div className="skel skel-line w40" /><div className="skel skel-block" /></div>}</div>;

  const doc = d.master.doc;
  const name = (step: string) => stepName(d, step);
  // A note's deviation number: the one written with it, or the one Deviations filed from it (read live).
  const numberOf = (n: { id: number; payload: { reference?: string } }) => r.deviations.find((x) => x.note === n.id)?.reference ?? n.payload.reference;
  // Server messages name steps by their position; people see the step's name.
  const plain = (t: string) => words(t.replace(/(?:step|Step) \S+ \((\d+\.\d+\.\d+\.\d+)\)|\(step (\d+\.\d+\.\d+\.\d+)\)/g, (m, a, b) => (a ? `step ${name(a)}` : `(${name(b)})`)));
  const fieldLabel = (step: string, field: string) => fieldOf(d, blocks, step, field);
  const decided = d.analysis.status === 'reviewed' || d.analysis.status === 'stopped';
  const openDevs = r.deviations.filter((x) => x.open);
  const turn = d.analysis.status === 'complete';
  const handLabel = (step: string, field: string) => field === 'reference' ? 'deviation number' : fieldLabel(step, field);

  const sign = async ({ proof }: { proof: string }) => {
    if (!signing) return;
    try {
      await api('POST', `/api/analyses/${id}/${signing.action}`, { proof, contentHash: d.analysis.contentHash });
      setSigning(null);
      setNotice('The analysis is reviewed. Its results count for the sample.');
    } catch (e) {
      if (!changed(e)) throw e;
      setSigning(null);
      setNotice('The record changed while you were signing (a note was added or a deviation closed). It has been reloaded: review it and sign again.');
    }
    await reload();
  };

  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return (
    <div className="fl">
      {back}
      {error && <p className="notice bad" role="alert">{error}</p>}
      <AnalysisHeader d={d} />
      <div className="kpis">
        <Kpi n={r.corrections.length} label="Corrections" tone="warn" />
        <Kpi n={r.sentBack.length} label="Sent back by the checker" tone="warn" />
        <Kpi n={r.late.length} label="Late (timers ran over)" tone="bad" />
        <Kpi n={r.outOfLimits.length} label="Out of limits" tone="bad" />
        <Kpi n={openDevs.length} label={r.deviations.length ? `Open deviations (${r.deviations.length} in all)` : 'Open deviations'} tone="bad" />
        <Kpi n={r.hand.length} label="Typed by hand, not pulled through a link" tone="warn" />
      </div>
      {r.deviationsLink === 'down' && <p className="notice warn">The Deviations link is down: the deviation statuses shown are LIMS's own (closed by hand).</p>}

      <section className="dash-panel" aria-label="Review of the record and its audit trail">
        <div className="panel-head"><h2>Review of the record and its audit trail</h2>
          <span className="muted">every change, departure and finding of the analysis; the review signature covers it</span></div>
        <Group title="Corrections" empty="No value was corrected.">{r.corrections.map((c, i) => (
          <li key={i}><b>{name(c.step)} · {fieldLabel(c.step, c.field)}</b>
            <span><s>{valueText(c.was)}</s> → {valueText(c.now)}</span><small>Reason: {c.reason} · {c.personName}, {plainClock(c.at)}</small></li>))}</Group>
        <Group title="Sent back by the checker" empty="No step was sent back.">{r.sentBack.map((e) => (
          <li key={e.id}><b>{name(idOf(e))}</b><span>{e.payload.reason}</span><small>{e.personName}, {plainClock(e.at)}</small></li>))}</Group>
        <Group title="Late: timers that ran over" empty="No timer ran over.">{r.late.map((l) => (
          <li key={l.timer.id} className={l.notes.length ? '' : 'bad'}><b>{l.timer.label}</b><span>Due {plainClock(l.timer.at)}</span>
            <small>{l.notes.length ? l.notes.map((n) => `${numberOf(n) ? `${numberOf(n)}: ` : ''}${n.payload.text} (${n.personName})`).join(' · ') : 'No deviation note'}</small></li>))}</Group>
        <Group title="Out of limits" empty="Every value was within its limits.">{r.outOfLimits.map((o, i) => (
          <li key={i} className="bad"><b>{name(o.step)}</b><span>{words(o.shown)}</span>
            <small>{o.notes.length ? o.notes.map((n) => `Note${numberOf(n) ? ` ${numberOf(n)}` : ''}: ${n.payload.text} (${n.personName}, ${plainClock(n.at)})`).join(' · ') : 'No note'}</small></li>))}</Group>
        {r.inputChanged.length > 0 && <Group title="Worked out again after an input changed" empty="">{r.inputChanged.map((x) => (
          <li key={x.step}><b>{name(x.step)}</b><small>{x.changes.map((e) => `${e.personName}, ${plainClock(e.at)}`).join(' · ')}</small></li>))}</Group>}
        <Group title="Deviation notes" empty="No deviation note has a deviation number.">{r.deviations.map((x) => (
          <li key={x.note} className={x.open ? 'bad' : 'ok'}><b>{deviationNumber(x)} · {name(x.step)}</b><span>{x.text}</span>
            <small>{x.status ? `${deviationStatusWords(x.status)} in the Deviations system${x.closedAt ? `, ${plainClock(x.closedAt)}` : ''}` : x.open ? 'Open: closed in the Deviations system, or by hand by QC' : `Closed by ${x.closed?.personName}, ${plainClock(x.closed?.at ?? '')}: ${x.closed?.payload.reason ?? ''}`}</small>
            {x.open && !x.status && !decided && can(me, 'qc.approve') && <button onClick={() => setClosing(x)}>Close the deviation…</button>}</li>))}</Group>
        {r.unlinked.length > 0 && <Group title="Deviations naming this analysis that no note links" empty="">{r.unlinked.map((x) => (
          <li key={x.number} className="bad"><b>{x.number}</b><span>{x.title}</span><small>{deviationStatusWords(x.status)} in the Deviations system</small></li>))}</Group>}
        <Group title="Typed by hand (a link was off or down)" empty="Every linked value came through its link.">{r.hand.map((h, i) => (
          <li key={i}><b>{name(h.step)} · {handLabel(h.step, h.field)}</b><span>{PROVIDER_NAME[h.link]} {h.state === 'down' ? 'link was down' : 'not linked'}</span>
            <small>{h.personName}, {plainClock(h.at)}</small></li>))}</Group>
        {(r.trainingTyped.length > 0 || d.master.doc.stages.some((s) => s.steps.some((t) => t.training))) && <Group title="Training typed by hand (Recruitment not reachable)" empty="Every training was read from Recruitment.">{r.trainingTyped.map((x) => (
          <li key={x.event} className="bad"><b>{name(x.step)}</b><span>{x.personName} ({x.kind === 'checked' ? 'checked' : 'performed'}) ticked “I am trained in {skillText(x)}”: Recruitment {x.state === 'down' ? 'link was down' : 'not linked'}</span>
            <small>{plainClock(x.at)}</small></li>))}</Group>}
        <Group title="Steps not applicable" empty="Every step was done.">{r.notApplicable.map((e) => (
          <li key={e.id}><b>{name(idOf(e))}</b><span>{e.payload.reason}</span><small>{e.personName}, {plainClock(e.at)}</small></li>))}</Group>
        {r.demoSkips.length > 0 && <Group title="DEMO: waits skipped" empty="">{r.demoSkips.map((e) => (
          <li key={e.id} className="bad"><b>{name(idOf(e))}</b><span>DEMO: wait skipped by {e.personName} at {plainClock(e.at)}</span><small>{String(e.payload.label ?? '')}</small></li>))}</Group>}
        <Group title={`Signatures (${r.signatures.length})`} empty="No signatures.">{r.signatures.map((s, i) => (
          <li key={i} className="sig"><b>{MEANING_LABEL[s.meaning] ?? s.meaning}</b><span>{s.printedName}</span>
            <small>{plainClock(s.signedAt)} · {s.step ? name(s.step) : s.objectType === 'analysis' ? `Analysis ${d.analysis.analysisNo} issued` : 'The analysis record'}</small></li>))}</Group>
      </section>

      <section className="dash-panel" aria-label="Review">
        <div className="panel-head"><h2>Review</h2>
          <a className="button" href={pdfLink(id)} download>Analysis record (PDF)</a></div>
        {notice && <p className="notice info" role="status">{notice}</p>}
        {r.analysisEvents.filter((b) => b.kind !== 'deviation_closed').map((b) => (
          <p key={b.id} className={b.kind === 'stopped' ? 'notice bad' : 'all-good'}><span aria-hidden="true">{b.kind === 'stopped' ? '✕' : '✓'}</span>
            {b.kind === 'stopped' ? stoppedText(b, plainClock) : <>{MEANING_LABEL[b.kind] ?? b.kind} by {b.personName}, {plainClock(b.at)}</>}</p>))}
        {turn && (d.analysis.actions.includes('review') ? (
          <div className="decide">
            <p className="why">Your signature means: you reviewed the original record and its audit trail above ({count(r.corrections.length, 'correction')}, {count(r.sentBack.length, 'step')} sent back,
              {' '}{count(r.late.length, 'late timer')}, {count(r.outOfLimits.length, 'value')} out of limits, {count(r.deviations.length, 'deviation')}) and it is complete, correct and as the method says.</p>
            <button className="big ok" onClick={() => setSigning({ meaning: 'reviewed', action: 'review' })}>Sign: reviewed</button>
          </div>
        ) : <p className="notice">{can(me, 'analysis.review') ? 'You recorded or signed steps of this analysis: another person reviews it.' : 'The review needs the analysis review permission.'}</p>)}
        {!turn && !decided && <p className="notice">The analysis is {statusText(d.analysis.status)}: it is reviewed when every step is finished.</p>}
      </section>

      {signing && (
        <SignDialog meaning={signing.meaning} what={`Analysis ${d.analysis.analysisNo} · ${doc.header.code} ${doc.header.name}`} onCancel={() => setSigning(null)} onSign={sign}>
          <div className="summary-box">
            <p>This signature records your review of the analysis and its audit trail: {count(r.corrections.length, 'correction')}, {count(r.sentBack.length, 'step')} sent back,
              {' '}{count(r.late.length, 'late timer')}, {count(r.outOfLimits.length, 'value')} out of limits, {count(r.deviations.length, 'deviation')}, {count(r.notApplicable.length, 'step')} not applicable.</p>
          </div>
        </SignDialog>
      )}
      {closing && (
        <ReasonDialog title={`Close deviation ${closing.reference}`} label="Reason for closing" hint={closing.text} submit="Close the deviation" onCancel={() => setClosing(null)}
          onSubmit={async (reason) => { await api('POST', `/api/analyses/${id}/close-deviation`, { note: closing.note, reason }); setClosing(null); setNotice(`Deviation ${closing.reference} is closed.`); await reload(); }} />
      )}
    </div>
  );
}

const idOf = (e: FloorEvent) => `${e.stage}.${e.sub}.${e.step}.${e.round}`;
function blockFor(d: AnalysisDetail, blocks: Block[], step: string) {
  const s = d.steps.find((x) => x.id === step);
  return s ? blockOf(blocks, stepOf(d.master.doc, s.key)) : undefined;
}
function fieldOf(d: AnalysisDetail, blocks: Block[], step: string, field: string) {
  return labelOf(blockFor(d, blocks, step)?.fields ?? [], field);
}
/** "Granulation › Weigh a material: Examplol (replicate 2, round 3)". */
function stepName(d: AnalysisDetail, step: string): string {
  const s = d.steps.find((x) => x.id === step);
  return s ? stepLabel(d.master.doc, s.key) : `step ${step}`;
}

function Kpi({ n, label, tone: t }: { n: number; label: string; tone: 'warn' | 'bad' }) {
  return <div className={`kpi ${n ? t : 'ok'}`}><b>{n}</b><span>{label}</span></div>;
}
function Group({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (<>
    <h3>{title}</h3>
    {children.length ? <ul className="rv-list">{children}</ul> : <p className="muted rv-none">{empty}</p>}
  </>);
}
