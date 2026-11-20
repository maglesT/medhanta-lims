import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import {
  blockOf, changed, go, headline, plainClock, plainLine, withoutVerdict, plainError, rawOf, sourceWords, stateLabel, stepLink, stepOf, stepTitle, timeLeft, tone, unitOf, useLinked, useLogbookItems, useQualItems, valueText, words,
  type AnalysisDetail, type Block, type Deviation, type BlockField, type FloorEvent, type History, type PickItem, type Step, type StepRow, type Stored, unitName,
} from '../api-floor.js';
import { Alerts } from './AnalysisScreen.js';
import { deviationText } from '../../../shared/engine/release.js';
import { FieldInput } from './Fields.js';
import { DemoSkip } from './DemoSkip.js';
import { ReasonDialog } from './ReasonDialog.js';
import { CERTIFICATE, fieldLabel, handEntered, isCaptured, LINK_OF, qualKey } from '../../../shared/engine/links.js';
import { captures, serialKind, type CaptureRaw } from '../../../shared/capture/index.js';
import { CdsImport, ReadInstrument } from './Capture.js';
import { inQualification } from '../../../shared/engine/qualification.js';
import { itemFills } from '../../../shared/engine/items.js';
import { askedFields, cutShort, notYetText } from '../../../shared/engine/analysis.js';
import { plantText } from '../../../shared/plant-time.js';
import { emptyNote, inLogbook, machineRefusal, roomRefusal } from '../../../shared/engine/picks.js';
import { neededText, tickText, trainingOf, trainingText, type Skill, type Training } from '../../../shared/engine/training.js';

type Dialog = { kind: 'done' | 'repeat' | 'check' | 'na' | 'send-back' | 'note' } | { kind: 'na-sign'; reason: string } | { kind: 'correct'; field: BlockField };
const INVOLVING = ['started', 'value', 'done', 'corrected', 'not_applicable'];
const same = (a: StepRow['key'], b: StepRow['key']) => a.stage === b.stage && a.sub === b.sub && a.step === b.step;

/** The limits and values the method set for this step, in words (`_mdUnit`: kept for the callers). */
function settingsText(_doc: AnalysisDetail['master']['doc'], block: Block, st: Step, _row: StepRow, _mdUnit: string | null): [string, string][] {
  return block.settings.flatMap((s): [string, string][] => {
    const v = st.settings[s.name];
    if (typeof v === 'string') return v && s.kind !== 'text' ? [[s.label, v]] : v && s.kind === 'text' ? [[s.label, v]] : [];
    if (!v || !('unit' in v)) return [];
    const u = v.unit ? ` ${v.unit}` : '';
    return [[s.label, v.low && v.high ? `${v.low} to ${v.high}${u}` : v.high ? `not more than ${v.high}${u}` : `at least ${v.low}${u}`]];
  });
}

// The step screen: the instruction, only the fields the block needs, the results worked out by the server with their
// worked line, and the actions open to this person. A step waiting for its check shows what was recorded to the
// checker, on their own device (LIMS-41).
export function StepScreen({ me, d, blocks, row, now, reload }: { me: Me; d: AnalysisDetail; blocks: Block[]; row: StepRow; now: number; reload: (b?: boolean) => Promise<void> }) {
  const doc = d.master.doc;
  const st = stepOf(doc, row.key);
  const block = blockOf(blocks, st)!;
  const stage = doc.stages[row.key.stage]!;
  const base = `/api/analyses/${d.analysis.id}/steps/${row.id}`;
  const title = stepTitle(doc, blocks, st);
  const [history, setHistory] = useState<History | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [md, setMd] = useState<Record<'machine' | 'room', PickItem[]>>({ machine: [], room: [] });
  const last = row.events.at(-1)?.id ?? 0;
  // The block's fields and the label questions of what was entered by hand (a link absent or down).
  const fields = [...askedFields(doc, block, st.settings), ...row.handFields];
  const lots = useLinked<{ lotNumber: string }>(null, 'lots');
  const mdUnit: string | null = null;
  const unitKnown = true;
  const shownUnit = (f: BlockField) => unitOf(f, st);
  // Bench clearance: the room's or instrument's previous analysis (pull, don't type).
  const place = block.gmp === 'line-clearance' ? block.fields.find((f) => f.kind === 'room' || f.kind === 'machine') : undefined;
  const placeId = place && (row.values[place.name] as { itemId?: string } | undefined)?.itemId;
  const [prev, setPrev] = useState<{ of: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!placeId || !block.fields.some((f) => f.name === 'previous')) return;
    let live = true;
    void api<{ previous: { text: string } | null }>('GET', `/api/analyses/${d.analysis.id}/previous-use?item=${encodeURIComponent(placeId)}`)
      .then((r) => live && setPrev({ of: placeId, text: r.previous?.text ?? null }), () => {});
    return () => { live = false; };
  }, [placeId, d.analysis.id, block]);
  const previous = prev && prev.of === placeId ? prev.text : null;
  const deviationPicks = useLinked<{ number: string; title: string | null }>(`/api/analyses/${d.analysis.id}/deviations`, 'deviations');
  const lotField = block.fields.find((f) => f.kind === 'lot');
  const lotPulled = lotField && row.source[lotField.name] && row.source[lotField.name]!.from !== 'hand';
  // Only trained people sign (owner, 17 Nov 2026): the signer's training in the step's skill, read when the sign dialog opens.
  const signing = dialog?.kind === 'done' || dialog?.kind === 'repeat' || dialog?.kind === 'check';
  const [training, setTraining] = useState<TrainingRead | null>(null);
  const [trained, setTrained] = useState(false);
  const [askTraining, setAskTraining] = useState(0);
  useEffect(() => {
    setTraining(null);
    setTrained(false);
    if (!signing || !st.training) return;
    let live = true;
    void api<TrainingRead>('GET', `${base}/training`).then((t) => live && setTraining(t), () => live && setTraining({ skill: st.training!, link: 'down', ok: false }));
    return () => { live = false; };
  }, [signing, st.training, base, askTraining]);
  const trainingBlocked = !!st.training && (!training || (training.link === 'ok' ? !training.ok : !trained));

  useEffect(() => {
    let live = true;
    void api<History>('GET', `${base}/events`).then((h) => live && setHistory(h), () => {});
    return () => { live = false; };
  }, [base, last]);
  useEffect(() => {
    if (!block.fields.some((f) => f.kind === 'machine' || f.kind === 'room')) return;
    void api<PickItem[]>('GET', '/api/master/rooms').then((room) => setMd((p) => ({ ...p, room })), () => {});
    if (block.fields.some((f) => f.kind === 'machine')) void api<PickItem[]>('GET', '/api/master/equipment').then((machine) => setMd((p) => ({ ...p, machine })), () => {});
  }, [block]);
  // What each machine or room field offers: as the server accepts it (shared/engine/picks.ts), and while the Logbook
  // is linked only what the Logbook has; an empty picker says what is left out and why.
  const logbook = useLogbookItems(block.fields.some((f) => f.kind === 'machine' || f.kind === 'room'));
  const fits = (f: BlockField) => (f.kind === 'room' ? md.room.filter((r) => r.active && !roomRefusal(stage, r))
    : f.kind === 'machine' ? md.machine.filter((m) => m.active && !machineRefusal(stage, f, m, md.room)) : []);
  // LIMS-12: a machine also only while Qualification says it is qualified (while linked); each one left out says why.
  const qual = useQualItems(block.fields.some((f) => f.kind === 'machine'));
  const pickOf = (f: BlockField) => {
    const lb = inLogbook(fits(f), logbook);
    if (f.kind !== 'machine') return { ...lb, leftOut: [] as string[] };
    const q = inQualification(lb.offered, qual);
    return { offered: q.offered, note: lb.note, leftOut: q.leftOut };
  };
  // A lab inventory item (LIMS-12, 13, 14): only the usable ones are offered; those left out are named with why.
  const [inv, setInv] = useState<Record<string, { items: PickItem[]; leftOut: { code: string; name: string; why: string[] }[] }>>({});
  useEffect(() => {
    let live = true;
    for (const f of block.fields.filter((x) => x.kind === 'item')) {
      void api<{ items: PickItem[]; leftOut: { code: string; name: string; why: string[] }[] }>('GET', `/api/inventory/picks?kinds=${f.itemKinds!.join(',')}`)
        .then((r) => live && setInv((p) => ({ ...p, [f.name]: r })), () => {});
    }
    return () => { live = false; };
  }, [block, last]);
  const fills = itemFills(block);
  const picksFor = (f: BlockField) => (f.kind === 'item' ? inv[f.name]?.items ?? [] : pickOf(f).offered);
  // An empty picker says why (once master data is read) and what the Logbook leaves out; one with choices says nothing.
  const mdRead = md.room.length > 0 && (md.machine.length > 0 || !block.fields.some((x) => x.kind === 'machine'));
  const noteFor = (f: BlockField) => (f.kind === 'item' ? (inv[f.name]?.leftOut ?? []).map((x) => `Not offered: ${x.code} ${x.name}: ${x.why.join('; ')}.`)
    : [mdRead && !fits(f).length ? emptyNote(stage, f, md.machine, md.room) : null, pickOf(f).note, ...pickOf(f).leftOut]);

  const post = (action: string, body: object = {}, key = row.id) => api('POST', `/api/analyses/${d.analysis.id}/steps/${key}/${action}`, body);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try { await fn(); } catch (e) { setNotice({ tone: 'bad', text: plainError(e) }); }
    await reload();
    setBusy(false);
  };
  // A signature carries the hash of what is on the screen; if the step changed meanwhile, it reloads and says so.
  const signed = (action: string, extra: object = {}, after?: () => Promise<void>) => async ({ proof }: { proof: string }) => {
    try {
      await post(action, { proof, contentHash: row.contentHash, ...extra, ...(st.training && (action === 'done' || action === 'check') ? { trained } : {}) });
    } catch (e) {
      // The training answer changed since the dialog opened (Recruitment came back or went down): read it again.
      if (e instanceof ApiError && (e.code === 'not_trained' || e.code === 'training_tick')) setAskTraining((n) => n + 1);
      if (!changed(e)) throw e;
      setDialog(null);
      setNotice({ tone: 'bad', text: 'This step changed while you were signing (someone recorded, corrected or checked it). It has been reloaded: look at the values again, then sign again.' });
      return reload();
    }
    setDialog(null);
    setNotice(null);
    await after?.();
    await reload();
  };
  const record = async (name: string, raw: unknown) => { await post('record', { values: { [name]: raw } }); await reload(); };

  const rounds = d.steps.filter((s) => same(s.key, row.key));
  const repeatUntil = st.flow.kind === 'repeat-until';
  const stop = st.flow.kind === 'repeat-until' ? st.flow.stop ?? block.stop : undefined;
  const stopFailed = stop !== undefined && tone(row.results[stop]) === 'bad';
  const outCalcs = block.calcs.filter((c) => c.name !== stop && tone(row.results[c.name]) === 'bad');
  const next = rounds.find((r) => r.key.round === row.key.round + 1);
  const can = (a: string) => row.actions.includes(a as never);
  const events = history?.events ?? row.events;
  const names = new Map(events.map((e) => [e.person, e.personName]));
  const by: Record<string, FloorEvent> = {};
  for (const e of events) if ((e.kind === 'value' || e.kind === 'corrected') && e.payload.values) for (const k of Object.keys(e.payload.values)) by[k] = e;
  const lastDone = events.filter((e) => e.kind === 'done').at(-1);
  const sentBack = events.filter((e) => e.kind === 'sent_back').at(-1);
  const involved = events.some((e) => INVOLVING.includes(e.kind) && e.person === me.id);
  const checking = row.state === 'done_awaiting_check';
  const noteNeeded = row.problems.some((p) => /deviation note/.test(p)) || outCalcs.length > 0;
  // Readings out of their band (C3), shown red in the grid.
  const outOf = (f: BlockField) => {
    const units = block.calcs.filter((x) => x.args.readings === `$${f.name}`).flatMap((x) => (row.results[x.name] as { units?: { inBand: boolean }[] } | undefined)?.units ?? []);
    return new Set(units.flatMap((u, i) => (u.inBand ? [] : [i])));
  };
  const periodic = st.everyMinutes ? d.timers.find((t) => t.kind === 'periodic' && same(t.key, row.key) && t.key.round === row.key.round + 1) : undefined;

  // After "done" in a repeat-until step that is not periodic: the next round starts at once.
  const repeat = async () => {
    if (st.everyMinutes) return;
    const fresh = await api<AnalysisDetail>('GET', `/api/analyses/${d.analysis.id}`);
    const n = fresh.steps.find((s) => same(s.key, row.key) && s.key.round === row.key.round + 1);
    if (n?.actions.includes('start')) { await post('start', {}, n.id); go(stepLink(d.analysis.id, n.id)); }
  };

  const fieldView = (f: BlockField) => {
    const v = row.values[f.name];
    // Line clearance: the previous product and analysis of the room or line, pulled from the analyses that used it.
    if (f.name === 'previous' && block.gmp === 'line-clearance' && v === undefined && can('record') && previous) {
      return (
        <div key={f.name} className="fl-field">
          <div className="lbl"><span>{f.label}</span></div>
          <div className="recorded"><span>{previous}</span><button className="big" onClick={() => void record(f.name, previous)}>Use this</button></div>
          <p className="muted small">The last analysis that used it, from the analysis records. If another product used it since, type it below.</p>
          <FieldInput f={f} unit="" disabled={!can('record')} onSave={(raw) => record(f.name, raw)} />
        </div>
      );
    }
    const unit = shownUnit(f);
    const src = row.source[f.name];
    // LIMS-32: a value read from the step's machine over its serial port (the temperature comes with the pH reading).
    const kind = captures(f, st.settings) && f.capture !== 'ph-temperature' ? serialKind(f.capture) : null;
    const machineField = block.fields.find((x) => x.kind === 'machine');
    const machineCode = machineField ? (row.values[machineField.name] as { code?: string } | undefined)?.code ?? null : null;
    const reader = kind && machineField && can('record')
      ? <ReadInstrument kind={kind} label={machineField.label} machine={machineCode} disabled={busy} onRead={(c) => record(f.name, c)} /> : null;
    // Pulled through a link: shown, never typed over. Certificate values come only with an MMS lot; a standard's potency
    // or a VS factor only with the item picked from the inventory.
    const pulled = (src && src.from !== 'hand' && !LINK_OF[f.kind] && f.kind !== 'item') || (lotPulled && CERTIFICATE[f.name] !== undefined) || fills[f.name] !== undefined;
    if (pulled && v === undefined) return null;
    if (!pulled && (can('record') || (v === undefined && row.state === 'open') || (f.count && v !== undefined))) {
      return (
        <div key={f.name}>
          <FieldInput f={f} unit={unit} saved={v} picks={picksFor(f)} note={noteFor(f)} options={f.kind === 'lot' ? lots.map((l) => l.lotNumber) : []}
            disabled={!can('record')} out={outOf(f)} onSave={can('record') ? (raw) => record(f.name, raw) : undefined} />
          {reader}
          {src && <p className="muted small">{sourceWords(src)}</p>}
          {row.source[qualKey(f.name)] && <p className="muted small">{sourceWords(row.source[qualKey(f.name)])}</p>}
          {!can('record') && can('correct') && <button className="big" onClick={() => setDialog({ kind: 'correct', field: f })}>Correct {f.label.toLowerCase()}</button>}
          <Replaced h={history} field={f.name} names={names} mdUnit={mdUnit} />
        </div>
      );
    }
    if (v === undefined && f.optional) return null;
    const e = by[f.name];
    return (
      <div key={f.name} className="fl-field">
        <div className="lbl"><span>{f.label}</span></div>
        <div className="recorded">
          <span>{valueText(v, mdUnit)}</span>
          {e && <span className="by">{e.personName}, {plainClock(e.at)}</span>}
          {can('correct') && v !== undefined && (!pulled || (isCaptured(src) && src.from === 'instrument')) && <button className="big" onClick={() => setDialog({ kind: 'correct', field: f })}>Correct</button>}
        </div>
        {reader}
        {src && <p className="muted small">{sourceWords(src)}</p>}
        {row.source[qualKey(f.name)] && <p className="muted small">{sourceWords(row.source[qualKey(f.name)])}</p>}
        <Replaced h={history} field={f.name} names={names} mdUnit={mdUnit} />
      </div>
    );
  };

  const resultRows = [...block.settings.map((s) => [s.name, s.label] as const), ...block.calcs.map((c) => [c.name, c.label] as const)]
    .filter(([n]) => row.results[n]).map(([n, label]) => ({ n, label, r: row.results[n]! }));

  return (
    <>
      <div className="step-title">
        <span className="where">{stage.name}{stage.kind === 'replicate' ? ` · replicate ${row.key.sub}` : ''}{repeatUntil ? ` · round ${row.key.round}` : ''}</span>
        <h1>{title}</h1>
        <span className={`chip ${row.needsResign ? 'chip-warn' : stateLabel(row.state, d.analysis.stopped)[1]}`}>{row.needsResign ? 'Sign again' : stateLabel(row.state, d.analysis.stopped)[0]}</span>
        {st.critical && <span className="chip chip-bad">Critical step</span>}
        {st.checker && <span className="chip">Second-person check</span>}
      </div>
      {notice && <p className={`notice ${notice.tone}`} role="alert">{notice.text}</p>}
      <div className="alerts">
        <Alerts d={d} blocks={blocks} now={now} only={row.id} />
        {row.blocked && !d.analysis.stopped && <div className="fl-alert info"><span className="tag">Not open yet</span><span>{row.blocked}</span><span /></div>}
        {sentBack && !d.analysis.stopped && row.state === 'in_progress' && lastDone && sentBack.id > lastDone.id && (
          <div className="fl-alert bad"><span className="tag">Sent back</span><span>“{sentBack.payload.reason}”<small>by {sentBack.personName}, {plainClock(sentBack.at)}. Correct the value, then sign again.</small></span><span /></div>
        )}
        {row.inputChanged.map((e) => <InputChanged key={e.id} e={e} d={d} blocks={blocks} />)}
        {row.needsResign && !d.analysis.stopped && !row.inputChanged.length && <div className="fl-alert warn"><span className="tag">Sign again</span><span>A value of this step was corrected after it was signed: check it and sign the step again.</span><span /></div>}
        {periodic && !d.analysis.stopped && <div className={`fl-alert ${periodic.state === 'late' ? 'bad' : 'info'}`}><span className="tag">Next check</span><span>Check {periodic.key.round} (every {st.everyMinutes} min)<small>due {plainClock(periodic.at)}{periodic.skipped ? ' · DEMO: wait skipped' : ''}</small></span>
            <span className="countdown">{Date.parse(periodic.at) > now ? `in ${timeLeft(Date.parse(periodic.at) - now)}` : 'now'}</span></div>}
      </div>
      <DemoSkip me={me} d={d} row={row} reload={() => reload()} />

      {!unitKnown ? <div className="dash-panel" aria-label="Loading the step"><div className="skel skel-line w60" /><div className="skel skel-block" /></div> : (
      <div className="step-grid">
        <div>
          <section className="dash-panel" aria-label="Instruction">
            <p className="instr">{st.instruction || block.instruction}</p>
            {st.training && <p className="muted small">{neededText(st.training, st.checker)}</p>}
            {settingsText(doc, block, st, row, mdUnit).length > 0 && <dl className="fields">{settingsText(doc, block, st, row, mdUnit).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
          </section>
          {checking ? (
            <section className="dash-panel" aria-label="What was recorded">
              <div className="panel-head"><h2>What was recorded</h2>{lastDone && <span className="muted">performed by {lastDone.personName}, {plainClock(lastDone.at)}</span>}</div>
              <table className="recorded-table"><thead><tr><th>Field</th><th>Value</th><th>Recorded by</th></tr></thead>
                <tbody>{fields.filter((f) => row.values[f.name] !== undefined).map((f) => (
                  <tr key={f.name}><td>{f.label}<small className="muted"> {sourceWords(row.source[f.name])}</small></td><td className="v">{valueText(row.values[f.name], mdUnit)}</td><td>{by[f.name] ? `${by[f.name]!.personName}, ${plainClock(by[f.name]!.at)}` : '—'}</td></tr>
                ))}</tbody></table>
              {handEntered(row.source) && <p className="notice warn">Entered by hand because a link is off or down: check each value against the status label, the lot label and the QC report.</p>}
              {fields.filter((f) => row.values[f.name] !== undefined).map((f) => <Replaced key={f.name} h={history} field={f.name} names={names} label={f.label} mdUnit={mdUnit} />)}
              {!can('check') && !d.analysis.stopped && <p className="notice info">{involved ? 'You performed or recorded this step: a second person checks it on their own device.' : 'Waiting for a second person to check this step.'}</p>}
            </section>
          ) : (
            <section className="dash-panel" aria-label="Record">
              <div className="panel-head"><h2>Record</h2>{can('record') && <span className="muted">each value is saved when you leave the field</span>}</div>
              {fields.map(fieldView)}
            </section>
          )}
          {/* LIMS-33: the peak values of a chromatography step come from the CDS result file. */}
          {block.fields.some((f) => f.capture === 'cds' && captures(f, st.settings)) && (can('record') || can('correct')) && (
            <CdsImport events={events} names={(n) => fieldLabel(block.fields, n)} signed={!can('record')}
              onImport={async (cds, reason) => { await post(can('record') ? 'record' : 'correct', { cds, ...(reason ? { reason } : {}) }); await reload(); }} />
          )}
        </div>
        <div>
          <section className="dash-panel" aria-label="Results">
            <div className="panel-head"><h2>Results</h2><span className="muted">worked out by the server</span></div>
            {resultRows.length === 0 ? <p className="muted">The results appear here as soon as the values are saved.</p> : (
              <div className="results">{resultRows.map((x) => <ResultCard key={x.n} label={x.label} r={x.r} mdUnit={mdUnit} big={false} stop={x.n === row.notYet} terminated={cutShort(d.analysis.stopped, row, rounds)} />)}</div>
            )}
          </section>
          {repeatUntil && rounds.length > 0 && (
            <section className="dash-panel" aria-label="Rounds">
              <div className="panel-head"><h2>Rounds</h2><span className="muted">until {block.calcs.find((c) => c.name === stop)?.label.toLowerCase()} passes{st.flow.kind === 'repeat-until' && st.flow.maxRounds ? `, at most ${st.flow.maxRounds}` : ''}</span></div>
              <div className="rounds">{rounds.map((r) => {
                const s = stop ? r.results[stop] : undefined;
                return (
                  <button key={r.id} className={r.id === row.id ? 'round here' : 'round'} onClick={() => go(stepLink(d.analysis.id, r.id))}>
                    <b>Round {r.key.round}</b><span>{s?.ok ? (tone(s) === 'ok' ? 'Passed' : cutShort(d.analysis.stopped, r, rounds) ? 'Not reached' : 'Not yet') : ''}{s?.ok && headline(s) ? ` · ${headline(s)}` : ''}</span>
                    <span className={`chip ${stateLabel(r.state, d.analysis.stopped)[1]}`}>{stateLabel(r.state, d.analysis.stopped)[0]}</span>
                  </button>
                );
              })}</div>
            </section>
          )}
          <History_ h={history} block={block} deviations={d.analysis.deviations} />
        </div>
      </div>
      )}

      <div className="action-bar">
        {row.state === 'waiting' && !d.analysis.stopped && <p className="why">{row.blocked ?? 'This step opens when the step before it is finished.'}</p>}
        {can('start') && <button className="big primary" disabled={busy} onClick={() => void run(() => post('start'))}>{row.key.round > 1 ? `Start round ${row.key.round}` : 'Start'}</button>}
        {can('done') && (<>
          <p className="why">{row.problems.length ? row.problems.map(words).join(' ') : repeatUntil && stopFailed ? `${block.calcs.find((c) => c.name === stop)?.label} has not passed: sign this round, then repeat.` : row.needsResign ? 'Check the values and results, then sign again.' : 'Sign when every value is recorded.'}</p>
          <button className="big primary" disabled={busy || row.problems.length > 0} onClick={() => setDialog({ kind: repeatUntil && stopFailed ? 'repeat' : 'done' })}>
            {repeatUntil && stopFailed ? (st.everyMinutes ? 'Done: next check later' : `Done, repeat (round ${row.key.round + 1})`) : row.needsResign ? 'Sign again: done' : 'Done'}
          </button>
        </>)}
        {checking && can('check') && (<>
          <p className="why">Check the values against the analysis, the lot and the machine. You were not involved in this step.</p>
          <button className="big soft-bad" disabled={busy} onClick={() => setDialog({ kind: 'send-back' })}>Send back</button>
          <button className="big ok" disabled={busy} onClick={() => setDialog({ kind: 'check' })}>Checked</button>
        </>)}
        {next && next.actions.includes('start') && row.id !== next.id && <button className="big primary" onClick={() => go(stepLink(d.analysis.id, next.id))}>Repeat: round {next.key.round} →</button>}
        {['done', 'checked', 'not_applicable'].includes(row.state) && !next && <p className="why">This step is finished.</p>}
        <span className="spacer" />
        {can('not-applicable') && <button className="big" disabled={busy} onClick={() => setDialog({ kind: 'na' })}>Not applicable</button>}
        {can('note') && <button className={noteNeeded ? 'big attn' : 'big'} disabled={busy} onClick={() => setDialog({ kind: 'note' })}>Add deviation note</button>}
      </div>

      {(dialog?.kind === 'done' || dialog?.kind === 'repeat') && (
        <SignDialog meaning="performed" what={`${title} · analysis ${d.analysis.analysisNo}: performed as recorded.`} blocked={trainingBlocked} onCancel={() => setDialog(null)} onSign={signed('done', {}, dialog.kind === 'repeat' ? repeat : undefined)}>
          <Summary row={row} block={block} mdUnit={mdUnit} />
          {st.training && <TrainingCheck skill={st.training} read={training} ticked={trained} onTick={setTrained} />}
        </SignDialog>
      )}
      {dialog?.kind === 'check' && (
        <SignDialog meaning="verified" what={`${title} · analysis ${d.analysis.analysisNo}: checked by a second person.`} blocked={trainingBlocked} onCancel={() => setDialog(null)} onSign={signed('check')}>
          <Summary row={row} block={block} mdUnit={mdUnit} />
          {st.training && <TrainingCheck skill={st.training} read={training} ticked={trained} onTick={setTrained} />}
        </SignDialog>
      )}
      {dialog?.kind === 'send-back' && (
        <ReasonDialog title="Send back to the performer" label="What must be looked at again" submit="Send back" onCancel={() => setDialog(null)}
          onSubmit={async (reason) => { await post('send-back', { reason }); setDialog(null); await reload(); }} />
      )}
      {dialog?.kind === 'note' && (
        <ReasonDialog title="Deviation note" label="What happened" reference options={deviationPicks} submit="Add the note" hint={outCalcs.length ? `Out of limits: ${outCalcs.map((c) => c.label).join(', ')}.` : undefined}
          onCancel={() => setDialog(null)} onSubmit={async (text, reference) => { await post('note', { text, ...(reference ? { reference } : {}) }); setDialog(null); await reload(); }} />
      )}
      {dialog?.kind === 'na' && (
        <ReasonDialog title="Not applicable" label="Why this step does not apply to this analysis" submit="Next: sign" onCancel={() => setDialog(null)}
          onSubmit={async (reason) => setDialog({ kind: 'na-sign', reason })} />
      )}
      {dialog?.kind === 'na-sign' && (
        <SignDialog meaning="performed" what={`${title} · analysis ${d.analysis.analysisNo}: not applicable. Reason: “${dialog.reason}”`} onCancel={() => setDialog(null)} onSign={signed('not-applicable', { reason: dialog.reason })} />
      )}
      {dialog?.kind === 'correct' && (
        <Correct f={dialog.field} unit={shownUnit(dialog.field)} mdUnit={mdUnit} saved={row.values[dialog.field.name]} picks={picksFor(dialog.field)}
          read={row.source[dialog.field.name]?.from === 'instrument' && block.fields.find((x) => x.kind === 'machine')
            ? { kind: serialKind(dialog.field.capture)!, label: block.fields.find((x) => x.kind === 'machine')!.label, machine: (row.values[block.fields.find((x) => x.kind === 'machine')!.name] as { code?: string } | undefined)?.code ?? null } : undefined}
          onCancel={() => setDialog(null)} onSave={async (raw, reason) => { await post('correct', { values: { [dialog.field.name]: raw }, reason }); setDialog(null); await reload(); }} />
      )}
    </>
  );
}

/** The signer's training in the step's skill, as Recruitment answered when the dialog opened. */
type TrainingRead = { skill: Skill; link: 'ok' | 'absent' | 'down'; ok: boolean; training?: Training; message?: string };
function TrainingCheck({ skill, read, ticked, onTick }: { skill: Skill; read: TrainingRead | null; ticked: boolean; onTick: (b: boolean) => void }) {
  if (!read) return <p className="muted">Reading your training from Recruitment…</p>;
  if (read.link === 'ok') return read.ok ? <p className="notice info">Your training: {trainingText(read.training!)}.</p> : <p className="notice bad">{read.message}</p>;
  return (
    <div className="notice warn">
      <p>Recruitment {read.link === 'absent' ? 'is not linked' : 'cannot be reached'}: this step needs a person trained in it. Your signature will be marked “training typed by hand” for QA.</p>
      <label className="check"><input type="checkbox" checked={ticked} onChange={(e) => onTick(e.target.checked)} />{tickText(skill)}</label>
    </div>
  );
}

function ResultCard({ label, r, mdUnit, big, stop, terminated }: { label: string; r: Stored; mdUnit?: string | null; big?: boolean; stop?: boolean; terminated?: boolean }) {
  if (!r.ok) return <div className="result warn"><div className="rh"><span>{label}</span></div><div className="shown">{r.message}</div></div>;
  const t = tone(r);
  const h = headline(r)?.replace(/\bunits\b/g, unitName('units', mdUnit)) ?? null;
  // The stop check of a repeat-until round is not a failure until the rounds run out (the server says which: notYet).
  const cls = stop && t === 'bad' ? '' : t ?? '';
  // The chip is the one verdict: the worked lines lose theirs (owner, 17 Nov 2026).
  // A count in master data's name for the material's unit (nos), as its fields.
  const shown = (x: string) => plantText(withoutVerdict(stop ? notYetText(x, terminated) : x)).replace(/\bunits\b/g, unitName('units', mdUnit));
  const word = t === 'ok' ? 'Within limits' : t === 'bad' ? (stop ? (terminated ? 'Not reached' : 'Not yet: repeat') : 'Out of limits') : t === 'warn' ? 'Alert' : null;
  const worked = <>{shown(r.shown)}{r.check && r.check.shown !== r.shown ? <><br />{shown(r.check.shown)}</> : null}</>;
  const line = plainLine(r);
  return (
    <div className={`result ${cls}${big ? ' big' : ''}`}>
      <div className="rh"><span>{label}</span>{word && <span className={`chip ${cls === 'ok' ? 'chip-ok' : cls === 'bad' ? 'chip-bad' : 'chip-warn'}`}>{word}</span>}</div>
      {h && <div className="rv">{h}</div>}
      {/* A figure leads, with its limit in a few words; the worked line stays one tap away. Without a figure the line is the result. */}
      {h ? (<>
        {line && <div className="plain">{line}</div>}
        <details className="shown"><summary>How it was worked out</summary>{worked}</details>
      </>) : <div className="shown">{worked}</div>}
    </div>
  );
}

function Summary({ row, block, mdUnit }: { row: StepRow; block: Block; mdUnit: string | null }) {
  return (
    <dl className="summary summary-box">
      {block.fields.filter((f) => row.values[f.name] !== undefined).map((f) => <div key={f.name} style={{ display: 'contents' }}><dt>{f.label}</dt><dd>{valueText(row.values[f.name], mdUnit)}</dd></div>)}
      {block.calcs.filter((c) => row.results[c.name]?.ok).map((c) => {
        const r = row.results[c.name]!;
        return <div key={c.name} style={{ display: 'contents' }}><dt>{c.label}</dt><dd>{headline(r) ?? ''} {c.name === row.notYet ? '(not yet: the rounds go on)' : tone(r) === 'bad' ? '(out of limits)' : tone(r) === 'ok' ? '(within limits)' : ''}</dd></div>;
      })}
    </dl>
  );
}

// LIMS-46: the original value stays, crossed out, with who changed it, when and why.
function Replaced({ h, field, names, label, mdUnit }: { h: History | null; field: string; names: Map<number | null, string | null>; label?: string; mdUnit: string | null }) {
  const list = h?.replaced.filter((r) => r.field === field) ?? [];
  return <>{list.map((r, i) => (
    <p key={i} className="corrected">{label && `${label}: `}<s>{valueText(r.was, mdUnit)}</s> → {valueText(r.now, mdUnit)} · corrected by {names.get(r.person) ?? '—'}, {plainClock(r.at)}: “{r.reason}”</p>
  ))}</>;
}

/** A value this step used was corrected (or worked out again) in another step: which one, by whom, why. */
function InputChanged({ e, d, blocks }: { e: FloorEvent; d: AnalysisDetail; blocks: Block[] }) {
  const doc = d.master.doc;
  const src = stepOf(doc, e);
  const b = blockOf(blocks, src);
  const what = `“${stepTitle(doc, blocks, src)}”`;
  const fields = Object.keys(e.payload.values ?? {}).map((k) => fieldLabel(b?.fields ?? [], k)).join(', ');
  return (
    <div className="fl-alert warn">
      <span className="tag">Input changed</span>
      <span>{e.kind === 'corrected' ? `${fields} in ${what} was corrected by ${e.personName}, ${plainClock(e.at)}: “${e.payload.reason ?? ''}”.` : `The results of ${what} were worked out again when ${e.personName} signed it again, ${plainClock(e.at)}.`}
        <small>The results here are worked out again with the new value. Check them and sign this step again.</small></span>
      <button className="link dark" onClick={() => go(stepLink(d.analysis.id, `${e.stage}.${e.sub}.${e.step}.${e.round}`))}>Open</button>
    </div>
  );
}

function StageSummary({ d, blocks, row }: { d: AnalysisDetail; blocks: Block[]; row: StepRow }) {
  const doc = d.master.doc;
  const steps = d.steps.filter((s) => s.key.stage === row.key.stage && s.key.sub === row.key.sub && s.id !== row.id);
  return (
    <section className="dash-panel" aria-label="Stage end">
      <div className="panel-head"><h2>Stage end</h2><span className="muted">the steps of this stage</span></div>
      <ul className="checklist-plain">{steps.map((s) => {
        const ok = ['done', 'checked', 'not_applicable'].includes(s.state);
        return <li key={s.id} className={ok ? 'ok' : 'no'}><i>{ok ? '✓' : '✕'}</i><span>{stepTitle(doc, blocks, stepOf(doc, s.key))}{s.key.round > 1 ? ` (round ${s.key.round})` : ''} · {stateLabel(s.state, d.analysis.stopped)[0]}</span></li>;
      })}</ul>
    </section>
  );
}

function History_({ h, block, deviations }: { h: History | null; block: Block; deviations: Deviation[] }) {
  if (!h) return <section className="dash-panel"><div className="skel skel-line w30" /><div className="skel skel-line w60" /></section>;
  const trained = (e: FloorEvent) => { const t = trainingOf(e); return t ? ` · ${trainingText(t)}` : ''; };
  const fields = (e: FloorEvent) => Object.keys(e.payload.values ?? {}).map((k) => fieldLabel(block.fields, k)).join(', ');
  const what = (e: FloorEvent) => ({
    started: 'Started', value: `Recorded ${fields(e)}`, done: `Signed: performed${trained(e)}`, checked: `Signed: verified (second person)${trained(e)}`, sent_back: `Sent back: “${e.payload.reason}”`,
    corrected: `Corrected ${fields(e)}: “${e.payload.reason}”`, not_applicable: `Not applicable: “${e.payload.reason}”`, late: 'Ran over its time (recorded by the server)',
    // The deviation's number and status, read live: the one written with the note, or the one Deviations filed from it.
    note: `Deviation note${((x) => (x ? ` ${deviationText(x)}` : e.payload.reference ? ` ${e.payload.reference}` : ''))(deviations.find((x) => x.note === e.id))}: “${e.payload.text}”`, qa_released_hold: 'QA released the hold',
    demo_wait_skipped: `DEMO: wait skipped by ${e.personName ?? '—'} at ${plainClock(e.at)}: ${String(e.payload.label ?? '')}`,
  })[e.kind];
  return (
    <section className="dash-panel" aria-label="History">
      <div className="panel-head"><h2>History</h2><span className="muted">who did what, on the server clock</span></div>
      {h.events.length === 0 ? <p className="muted">Nothing recorded yet.</p> : (
        <ol className="timeline">{h.events.map((e) => (
          <li key={e.id} className={e.kind === 'note' ? 'note' : undefined}><time>{plainClock(e.at)}</time><span>{what(e)}{e.personName && e.kind !== 'demo_wait_skipped' && <> · <b>{e.personName}</b></>}</span></li>
        ))}</ol>
      )}
    </section>
  );
}

function Correct({ f, unit, mdUnit, saved, picks, read, onSave, onCancel }: { f: BlockField; unit: string; mdUnit: string | null; saved: StepRow['values'][string] | undefined; picks: PickItem[];
  // A value read from an instrument is corrected by reading it again, never by typing (LIMS-32).
  read?: { kind: NonNullable<ReturnType<typeof serialKind>>; label: string; machine: string | null };
  onSave: (raw: unknown, reason: string) => Promise<void>; onCancel: () => void }) {
  const [raw, setRaw] = useState<unknown>(rawOf(saved));
  if (read) {
    return (
      <ReasonDialog title={`Correct: ${f.label}`} label="Reason for the correction" submit="Save the correction" onCancel={onCancel}
        hint={`Now: ${valueText(saved, mdUnit)}, read from the instrument. Read it again; the original value stays in the record, crossed out, with your reason.`}
        onSubmit={(reason) => onSave(raw, reason)}>
        <ReadInstrument kind={read.kind} label={read.label} machine={read.machine} onRead={async (c: { capture: CaptureRaw }) => setRaw(c)} />
      </ReasonDialog>
    );
  }
  return (
    <ReasonDialog title={`Correct: ${f.label}`} label="Reason for the correction" submit="Save the correction" onCancel={onCancel}
      hint={`Now: ${valueText(saved, mdUnit)}. The original value stays in the record, crossed out, with your reason; the step must be signed again.`}
      onSubmit={(reason) => onSave(raw, reason)}>
      <FieldInput f={f} unit={unit} saved={saved} picks={picks} onChange={setRaw} />
    </ReasonDialog>
  );
}
