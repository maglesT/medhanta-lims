// One stability protocol version (LIMS-26), as the specification editor: the protocol (tab "Protocol") and the review
// and approval (tab "Review and approval"), with the master check beside it. A draft saves itself as it is edited.
// Conditions are picked from the fixed list; the design (ICH Q1D) is checked by template L25 in the master check.
import { useEffect, useRef, useState } from 'react';
import { ApiError, can, type Me } from '../api.js';
import { getProblems, listSpecs, STATE_CHIP, STATE_LABEL, type SpecRow } from '../api-designer.js';
import { blocking, type Problem } from '../../../shared/master/checks.js';
import {
  CONDITION_CODES, DESIGNS, FACTOR_KINDS, PURPOSE_WORDS, ROLES, STORAGE_CONDITIONS, conditionLabel, protocolSchema, type ProtocolCondition, type ProtocolDoc,
} from '../../../shared/master/protocol.js';
import { CheckPanel } from '../designer/CheckPanel.js';
import { Review } from '../designer/Review.js';
import { newKey } from '../designer/model.js';
import { getProtocol, saveProtocol, type ProtocolVersion } from './api-stability.js';

type Tab = 'protocol' | 'review';
type Save = { kind: 'saved' | 'saving' | 'pending' } | { kind: 'invalid' | 'error'; message: string };
const months = (t: string) => t.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
type Design = ProtocolDoc['design'];
type Factor = Design['factors'][number];

export function ProtocolEditor({ me, versionId, onBack, onOpen }: { me: Me; versionId: number; onBack: () => void; onOpen: (id: number) => void }) {
  const [v, setV] = useState<ProtocolVersion | null>(null);
  const [doc, setDoc] = useState<ProtocolDoc | null>(null);
  const [tab, setTab] = useState<Tab>('protocol');
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [specs, setSpecs] = useState<SpecRow[]>([]);
  const [save, setSave] = useState<Save>({ kind: 'saved' });
  const [error, setError] = useState('');
  const timer = useRef<number>();
  const latest = useRef<ProtocolDoc | null>(null);
  const load = async () => {
    const x = await getProtocol(versionId);
    setV(x); setDoc(x.doc); latest.current = x.doc;
    if (x.state !== 'draft') setTab('review');
    setProblems((await getProblems(versionId)).problems);
  };
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); void listSpecs().then(setSpecs, () => {}); }, [versionId]);

  const editable = v?.state === 'draft' && can(me, 'master.author');
  const persist = async (d: ProtocolDoc) => {
    const p = protocolSchema.safeParse(d);
    if (!p.success) return setSave({ kind: 'invalid', message: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)[0]! });
    setSave({ kind: 'saving' });
    try {
      await saveProtocol(versionId, p.data);
      setSave(latest.current === d ? { kind: 'saved' } : { kind: 'pending' });
      setProblems((await getProblems(versionId)).problems);
    } catch (e) { setSave({ kind: 'error', message: e instanceof ApiError ? e.message || e.code : String(e) }); }
  };
  const change = (next: ProtocolDoc) => {
    setDoc(next); latest.current = next;
    if (!editable) return;
    setSave({ kind: 'pending' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void persist(next), 600);
  };
  const flush = async () => { if (timer.current && save.kind === 'pending' && latest.current) { window.clearTimeout(timer.current); await persist(latest.current); } };

  if (error) return <><button className="link dark" onClick={onBack}>← Stability</button><p className="notice">{error}</p></>;
  if (!v || !doc) return <div className="skel skel-block tall" />;
  const h = doc.header;
  const setH = (x: Partial<ProtocolDoc['header']>) => change({ ...doc, header: { ...h, ...x } });
  const setC = (i: number, x: Partial<ProtocolCondition>) => change({ ...doc, conditions: doc.conditions.map((c, j) => (j === i ? { ...c, ...x } : c)) });
  const setD = (x: Partial<Design>) => change({ ...doc, design: { ...doc.design, ...x } });
  // The specification versions of the same product or material, approved or effective.
  const mine = specs.filter((s) => ['approved', 'effective'].includes(s.state) && s.header.of === h.of && (h.of === 'material' ? s.header.itemId === h.itemId : s.header.code === h.code));
  const blocked = problems === null || problems.some(blocking);
  return (
    <div className="designer-page">
      <div className="d-top">
        <button className="link dark" onClick={async () => { await flush(); onBack(); }}>← Stability</button>
        <div className="d-title">
          <h1>{h.number} · {h.code} {h.name}</h1>
          <span className="muted">Version {v.versionNo} · {PURPOSE_WORDS[h.purpose]}</span>
          <span className={STATE_CHIP[v.state]}>{STATE_LABEL[v.state]}</span>
          {!editable && <span className="muted small">Read only</span>}
        </div>
        <nav className="subtabs" aria-label="Protocol">
          {([['protocol', 'Protocol'], ['review', 'Review and approval']] as const).map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={async () => { if (k === 'review') await flush(); setTab(k); }}>{label}</button>))}
          {editable && <span className={`save save-${save.kind}`} role="status">
            {save.kind === 'saved' ? 'All changes saved' : save.kind === 'saving' ? 'Saving…' : save.kind === 'pending' ? 'Changes not saved yet' : `Not saved: ${'message' in save ? save.message : ''}`}</span>}
        </nav>
      </div>
      <div className="designer">
        <div className="d-main">
          {tab === 'protocol' && (
            <fieldset className="plain" disabled={!editable}>
              <div className="card">
                <div className="form-grid">
                  <label>Protocol number<input aria-label="Protocol number" value={h.number} onChange={(e) => setH({ number: e.target.value })} /></label>
                  <label>Purpose<select aria-label="Purpose" value={h.purpose} onChange={(e) => setH({ purpose: e.target.value as typeof h.purpose })}>
                    {Object.entries(PURPOSE_WORDS).map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></label>
                  <label>Container closure (primary pack)<input aria-label="Container closure" value={h.containerClosure} placeholder="e.g. Alu-Alu blister, 10 tablets" onChange={(e) => setH({ containerClosure: e.target.value })} /></label>
                  <label className="check"><input type="checkbox" aria-label="Same as marketed" checked={h.sameAsMarketed} onChange={(e) => setH({ sameAsMarketed: e.target.checked })} /> The container closure marketed (or proposed)</label>
                  <label>Shelf life (months)<input aria-label="Shelf life" inputMode="numeric" value={h.shelfLifeMonths} onChange={(e) => setH({ shelfLifeMonths: Number(e.target.value) || 0 })} /></label>
                  <label>Specification
                    <select aria-label="Specification" value={doc.spec?.versionId ?? ''} onChange={(e) => {
                      const s = mine.find((x) => x.id === Number(e.target.value));
                      change({ ...doc, spec: s ? { versionId: s.id, number: s.header.number, versionNo: s.versionNo } : null });
                    }}>
                      <option value="">(choose the specification version)</option>
                      {mine.map((s) => <option key={s.id} value={s.id}>{s.header.number}, version {s.versionNo} ({STATE_LABEL[s.state].toLowerCase()})</option>)}
                    </select></label>
                  <label>Pulled per time point<input aria-label="Quantity per time point" inputMode="decimal" value={doc.quantity.amount} onChange={(e) => change({ ...doc, quantity: { ...doc.quantity, amount: e.target.value.trim() } })} /></label>
                  <label>Unit<input aria-label="Quantity unit" value={doc.quantity.unit} onChange={(e) => change({ ...doc, quantity: { ...doc.quantity, unit: e.target.value } })} /></label>
                  <label>Pull window (± days)<input aria-label="Pull window" inputMode="numeric" value={doc.pullWindowDays} onChange={(e) => change({ ...doc, pullWindowDays: Number(e.target.value) || 0 })} /></label>
                </div>
              </div>
              <div className="card">
                <div className="d-section-head"><h2>Storage conditions and time points</h2></div>
                {doc.conditions.map((c, i) => (
                  <div key={c.key} className="form-grid">
                    <label>Condition<select aria-label={`Condition ${i + 1}`} value={c.code} onChange={(e) => {
                      const code = e.target.value as ProtocolCondition['code'];
                      setC(i, { code, role: STORAGE_CONDITIONS[code].role, ...(code === 'other' ? {} : { other: undefined }) });
                    }}>{CONDITION_CODES.map((k) => <option key={k} value={k}>{STORAGE_CONDITIONS[k].label}</option>)}</select></label>
                    {c.code === 'other' && <label>Which<input aria-label={`Condition ${i + 1} other`} value={c.other ?? ''} onChange={(e) => setC(i, { other: e.target.value })} /></label>}
                    <label>Role<select aria-label={`Condition ${i + 1} role`} value={c.role} onChange={(e) => setC(i, { role: e.target.value as ProtocolCondition['role'] })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
                    <label>Time points (months)<input aria-label={`Condition ${i + 1} months`} defaultValue={c.months.join(', ')} placeholder="0, 3, 6, 9, 12, 18, 24"
                      onBlur={(e) => setC(i, { months: months(e.target.value) })} /></label>
                    <button type="button" className="link" onClick={() => change({ ...doc, conditions: doc.conditions.filter((_, j) => j !== i) })}>Remove</button>
                  </div>))}
                <button type="button" className="primary" onClick={() => change({ ...doc, conditions: [...doc.conditions, { key: newKey('c', doc.conditions.map((x) => x.key)), code: '30/75', role: 'long-term', months: [] }] })}>Add a condition</button>
              </div>
              <DesignCard doc={doc} setD={setD} />
            </fieldset>
          )}
          {tab === 'review' && <Review me={me} version={v} doc={doc} blocked={blocked} onChanged={load} onOpen={onOpen} onGo={() => setTab('protocol')} />}
        </div>
        <CheckPanel doc={doc} state={v.state} problems={problems} onGo={() => setTab('protocol')} />
      </div>
    </div>
  );
}

/** The design (ICH Q1D): its type and why; bracketing factors with their levels; the matrix of time points per cell. */
function DesignCard({ doc, setD }: { doc: ProtocolDoc; setD: (x: Partial<Design>) => void }) {
  const d = doc.design;
  const setF = (i: number, x: Partial<Factor>) => setD({ factors: d.factors.map((f, j) => (j === i ? { ...f, ...x } : f)) });
  // Levels, one per line: "name, size, tested" (tested: yes or no).
  const levels = (t: string): Factor['levels'] => t.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((p) => p[0])
    .map(([name, size, tested]) => ({ name: name!, ...(size ? { size } : {}), tested: !/^no$/i.test(tested ?? 'yes') }));
  // Matrix, one cell per line: "cell; condition key; months".
  const matrix = (t: string): Design['matrix'] => t.split('\n').map((l) => l.split(';').map((x) => x.trim())).filter((p) => p[0] && p[1])
    .map(([cell, condition, m]) => ({ cell: cell!, condition: condition!, months: months(m ?? '') }));
  return (
    <div className="card">
      <div className="d-section-head"><h2>Design (ICH Q1D)</h2></div>
      <div className="form-grid">
        <label>Design<select aria-label="Design" value={d.type} onChange={(e) => setD({ type: e.target.value as Design['type'] })}>{DESIGNS.map((x) => <option key={x}>{x}</option>)}</select></label>
        {d.type !== 'full' && <label>Why it is justified<textarea aria-label="Design justification" value={d.justification ?? ''} onChange={(e) => setD({ justification: e.target.value || undefined })} /></label>}
      </div>
      {d.type !== 'full' && (<>
        {d.factors.map((f, i) => (
          <div key={i} className="form-grid">
            <label>Factor<input aria-label={`Factor ${i + 1}`} value={f.name} onChange={(e) => setF(i, { name: e.target.value })} /></label>
            <label>Kind<select aria-label={`Factor ${i + 1} kind`} value={f.kind} onChange={(e) => setF(i, { kind: e.target.value as Factor['kind'] })}>{FACTOR_KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
            {f.kind === 'strength' ? <label>Formulations<select aria-label={`Factor ${i + 1} formulation`} value={f.formulation ?? ''} onChange={(e) => setF(i, { formulation: (e.target.value || undefined) as Factor['formulation'] })}>
              <option value="">(say)</option>{['identical', 'closely related', 'different'].map((x) => <option key={x}>{x}</option>)}</select></label>
              : <label className="check"><input type="checkbox" checked={!!f.sameClosureSystem} onChange={(e) => setF(i, { sameClosureSystem: e.target.checked })} /> Same container closure system</label>}
            <label>Levels, one per line: name, size, tested (yes or no)<textarea aria-label={`Factor ${i + 1} levels`} defaultValue={f.levels.map((l) => [l.name, l.size ?? '', l.tested ? 'yes' : 'no'].join(', ')).join('\n')}
              onBlur={(e) => setF(i, { levels: levels(e.target.value) })} /></label>
            <button type="button" className="link" onClick={() => setD({ factors: d.factors.filter((_, j) => j !== i) })}>Remove</button>
          </div>))}
        <button type="button" onClick={() => setD({ factors: [...d.factors, { name: 'Strength', kind: 'strength', levels: [] }] })}>Add a factor</button>
        {d.type.includes('matrixing') && (
          <div className="form-grid">
            <label>Matrix, one cell per line: cell; condition ({doc.conditions.map((c) => `${c.key} = ${conditionLabel(c)}`).join(', ')}); months
              <textarea aria-label="Matrix" defaultValue={d.matrix.map((m) => `${m.cell}; ${m.condition}; ${m.months.join(', ')}`).join('\n')} onBlur={(e) => setD({ matrix: matrix(e.target.value) })} /></label>
            <label>Reduction of the intermediate time points<input aria-label="Reduction" placeholder="1/2" value={d.reduction ?? ''} onChange={(e) => setD({ reduction: e.target.value.trim() || undefined })} /></label>
            <label>Variability of the supporting data<select aria-label="Variability" value={d.variability ?? ''} onChange={(e) => setD({ variability: (e.target.value || undefined) as Design['variability'] })}>
              <option value="">(say)</option>{['small', 'moderate', 'large'].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="check"><input type="checkbox" checked={!!d.statisticallyJustified} onChange={(e) => setD({ statisticallyJustified: e.target.checked })} /> Statistically justified</label>
            <label className="check"><input type="checkbox" checked={!!d.fullDataBeforeApproval} onChange={(e) => setD({ fullDataBeforeApproval: e.target.checked })} /> Full long-term data before approval</label>
          </div>)}
      </>)}
    </div>
  );
}
