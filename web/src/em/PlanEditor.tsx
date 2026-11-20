// One monitoring plan version (LIMS-36, LIMS-37), as the specification editor: the plan (tab "Plan") and the review
// and approval (tab "Review and approval"), with the master check beside it. A draft saves itself as it is edited.
// Rooms come from master data (with their grade); each sampling names a test of an approved or effective
// environmental monitoring or water specification, whose alert and action limits apply.
import { adverseRule } from '../../../shared/engine/em-trends.js';
import { useEffect, useRef, useState } from 'react';
import { ApiError, can, type Me } from '../api.js';
import { getProblems, getSpec, listSpecs, loadMasterData, STATE_CHIP, STATE_LABEL, type MasterData } from '../api-designer.js';
import { blocking, type Problem } from '../../../shared/master/checks.js';
import {
  EM_KINDS, FREQUENCIES, IDENTIFY, STATES, WATER_KINDS, WATER_SYSTEMS, monitoringSchema, pointWhere, type MonitoringDoc, type MonitoringPoint, type Sampling, type WaterSystem,
} from '../../../shared/master/monitoring.js';
import type { SpecDoc } from '../../../shared/master/spec.js';
import { limitText } from '../../../shared/master/spec.js';
import { CheckPanel } from '../designer/CheckPanel.js';
import { Review } from '../designer/Review.js';
import { newKey } from '../designer/model.js';
import { getPlan, savePlan, type PlanVersion } from './api-em.js';

type Tab = 'plan' | 'review';
type Save = { kind: 'saved' | 'saving' | 'pending' } | { kind: 'invalid' | 'error'; message: string };
interface SpecPick { masterId: number; number: string; versionNo: number; state: string; type: string; tests: SpecDoc['tests'] }

export function PlanEditor({ me, versionId, onBack, onOpen }: { me: Me; versionId: number; onBack: () => void; onOpen: (id: number) => void }) {
  const [v, setV] = useState<PlanVersion | null>(null);
  const [doc, setDoc] = useState<MonitoringDoc | null>(null);
  const [tab, setTab] = useState<Tab>('plan');
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [md, setMd] = useState<MasterData | null>(null);
  const [specs, setSpecs] = useState<SpecPick[]>([]);
  const [save, setSave] = useState<Save>({ kind: 'saved' });
  const [error, setError] = useState('');
  const timer = useRef<number>();
  const latest = useRef<MonitoringDoc | null>(null);
  const load = async () => {
    const x = await getPlan(versionId);
    setV(x); setDoc(x.doc); latest.current = x.doc;
    if (x.state !== 'draft') setTab('review');
    setProblems((await getProblems(versionId)).problems);
  };
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
    void loadMasterData().then(setMd, () => {});
    // The environmental monitoring and water specifications, approved or effective (the latest of each), with their tests.
    void listSpecs().then(async (rows) => {
      const mine = rows.filter((r) => ['approved', 'effective'].includes(r.state) && ['Environmental monitoring', 'Water'].includes(r.header.type));
      const latestOf = [...new Map(mine.map((r) => [r.masterId, r])).values()];
      setSpecs(await Promise.all(latestOf.map(async (r) => ({ masterId: r.masterId, number: r.header.number, versionNo: r.versionNo, state: r.state, type: r.header.type, tests: (await getSpec(r.id)).doc.tests }))));
    }, () => {});
  }, [versionId]);

  const editable = v?.state === 'draft' && can(me, 'master.author');
  const persist = async (d: MonitoringDoc) => {
    const p = monitoringSchema.safeParse(d);
    if (!p.success) return setSave({ kind: 'invalid', message: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)[0]! });
    setSave({ kind: 'saving' });
    try {
      await savePlan(versionId, p.data);
      setSave(latest.current === d ? { kind: 'saved' } : { kind: 'pending' });
      setProblems((await getProblems(versionId)).problems);
    } catch (e) { setSave({ kind: 'error', message: e instanceof ApiError ? e.message || e.code : String(e) }); }
  };
  const change = (next: MonitoringDoc) => {
    setDoc(next); latest.current = next;
    if (!editable) return;
    setSave({ kind: 'pending' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void persist(next), 600);
  };
  const flush = async () => { if (timer.current && save.kind === 'pending' && latest.current) { window.clearTimeout(timer.current); await persist(latest.current); } };

  if (error) return <><button className="link dark" onClick={onBack}>← EM and water</button><p className="notice">{error}</p></>;
  if (!v || !doc) return <div className="skel skel-block tall" />;
  const h = doc.header;
  const setP = (i: number, x: Partial<MonitoringPoint>) => change({ ...doc, points: doc.points.map((p, j) => (j === i ? { ...p, ...x } : p)) });
  const setS = (i: number, k: number, x: Partial<Sampling>) => setP(i, { samplings: doc.points[i]!.samplings.map((s, j) => (j === k ? { ...s, ...x } : s)) });
  const blocked = problems === null || problems.some(blocking);
  const addPoint = (of: 'room' | 'water') => change({ ...doc, points: [...doc.points, { key: newKey('p', doc.points.map((p) => p.key)), code: '', name: '', of, critical: false, samplings: [],
    ...(of === 'water' ? { system: 'PW' as WaterSystem } : {}) }] });
  return (
    <div className="designer-page">
      <div className="d-top">
        <button className="link dark" onClick={async () => { await flush(); onBack(); }}>← EM and water</button>
        <div className="d-title">
          <h1>{h.number} · {h.name}</h1>
          <span className="muted">Version {v.versionNo} · monitoring plan</span>
          <span className={STATE_CHIP[v.state]}>{STATE_LABEL[v.state]}</span>
          {!editable && <span className="muted small">Read only</span>}
        </div>
        <nav className="subtabs" aria-label="Plan">
          {([['plan', 'Plan'], ['review', 'Review and approval']] as const).map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={async () => { if (k === 'review') await flush(); setTab(k); }}>{label}</button>))}
          {editable && <span className={`save save-${save.kind}`} role="status">
            {save.kind === 'saved' ? 'All changes saved' : save.kind === 'saving' ? 'Saving…' : save.kind === 'pending' ? 'Changes not saved yet' : `Not saved: ${'message' in save ? save.message : ''}`}</span>}
        </nav>
      </div>
      <div className="designer">
        <div className="d-main">
          {tab === 'plan' && (
            <fieldset className="plain" disabled={!editable}>
              <div className="card">
                <div className="form-grid">
                  <label>Plan number<input aria-label="Plan number" value={h.number} onChange={(e) => change({ ...doc, header: { ...h, number: e.target.value } })} /></label>
                  <label>Name<input aria-label="Plan name" value={h.name} onChange={(e) => change({ ...doc, header: { ...h, name: e.target.value } })} /></label>
                  <label>Shifts a day<select aria-label="Shifts a day" value={h.shifts} onChange={(e) => change({ ...doc, header: { ...h, shifts: Number(e.target.value) } })}>
                    {[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></label>
                </div>
              </div>
              {doc.points.map((p, i) => (
                <div key={p.key} className="card" aria-label={`Point ${i + 1}`}>
                  <div className="d-section-head"><h2>{p.code || `Point ${i + 1}`} <span className="muted small">{pointWhere(p)}</span></h2>
                    <button type="button" className="link" onClick={() => change({ ...doc, points: doc.points.filter((_, j) => j !== i) })}>Remove the point</button></div>
                  <div className="form-grid">
                    <label>Point code<input aria-label={`Point ${i + 1} code`} value={p.code} placeholder={p.of === 'room' ? 'e.g. B101-SP1' : 'e.g. PW-04'} onChange={(e) => setP(i, { code: e.target.value })} /></label>
                    <label>Where exactly<input aria-label={`Point ${i + 1} name`} value={p.name} placeholder={p.of === 'room' ? 'e.g. Filling LAF, left of the needles' : 'e.g. Loop 1, outlet 4'} onChange={(e) => setP(i, { name: e.target.value })} /></label>
                    {p.of === 'room' ? (
                      <label>Room (master data)<select aria-label={`Point ${i + 1} room`} value={p.room?.itemId ?? ''} onChange={(e) => {
                        const r = md?.rooms.find((x) => x.itemId === e.target.value);
                        setP(i, { room: r ? { itemId: r.itemId, code: r.code, name: r.name, grade: (r.grade ?? '').toUpperCase() } : undefined });
                      }}><option value="">(choose the room)</option>
                        {(md?.rooms ?? []).filter((r) => r.active).map((r) => <option key={r.itemId} value={r.itemId}>{r.code} {r.name}{r.grade ? ` (grade ${r.grade})` : ' (no grade)'}</option>)}</select></label>
                    ) : (
                      <label>Water system<select aria-label={`Point ${i + 1} system`} value={p.system ?? ''} onChange={(e) => setP(i, { system: e.target.value as WaterSystem })}>
                        {Object.entries(WATER_SYSTEMS).map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></label>
                    )}
                    <label className="check"><input type="checkbox" checked={p.critical} onChange={(e) => setP(i, { critical: e.target.checked })} /> A critical location</label>
                  </div>
                  {p.samplings.map((s, k) => {
                    const kinds = p.of === 'room' ? EM_KINDS : WATER_KINDS;
                    const type = p.of === 'room' ? 'Environmental monitoring' : 'Water';
                    const spec = specs.find((x) => x.masterId === s.spec?.masterId);
                    const label = `Point ${i + 1} sampling ${k + 1}`;
                    return (
                      <div key={s.key} className="form-grid" aria-label={label}>
                        <label>What is sampled<select aria-label={`${label} kind`} value={s.kind} onChange={(e) => setS(i, k, { kind: e.target.value as Sampling['kind'] })}>
                          {kinds.map((x) => <option key={x}>{x}</option>)}</select></label>
                        <label>How often<select aria-label={`${label} frequency`} value={s.frequency} onChange={(e) => setS(i, k, { frequency: e.target.value as Sampling['frequency'] })}>
                          {FREQUENCIES.map((x) => <option key={x}>{x}</option>)}</select></label>
                        {p.of === 'room' && <label>State<select aria-label={`${label} state`} value={s.state ?? ''} onChange={(e) => setS(i, k, { state: (e.target.value || undefined) as Sampling['state'] })}>
                          <option value="">(choose)</option>{STATES.map((x) => <option key={x}>{x}</option>)}</select></label>}
                        <label>Specification<select aria-label={`${label} specification`} value={s.spec?.masterId ?? ''} onChange={(e) => {
                          const sp = specs.find((x) => x.masterId === Number(e.target.value));
                          setS(i, k, { spec: sp ? { masterId: sp.masterId, testKey: sp.tests[0]?.key ?? 'test', number: sp.number, testName: sp.tests[0]?.name ?? '', method: sp.tests[0] ? `${sp.tests[0].method.code} ${sp.tests[0].method.name}` : '', limit: sp.tests[0] ? limitText(sp.tests[0]) : '' } : null });
                        }}><option value="">(choose the specification)</option>
                          {specs.filter((x) => x.type === type).map((x) => <option key={x.masterId} value={x.masterId}>{x.number}, version {x.versionNo} ({x.state})</option>)}</select></label>
                        {spec && <label>Test (its limits apply)<select aria-label={`${label} test`} value={s.spec?.testKey ?? ''} onChange={(e) => {
                          const t = spec.tests.find((x) => x.key === e.target.value)!;
                          setS(i, k, { spec: { ...s.spec!, testKey: t.key, testName: t.name, method: `${t.method.code} ${t.method.name}`, limit: limitText(t) } });
                        }}>{spec.tests.map((t) => <option key={t.key} value={t.key}>{t.name}: {limitText(t)}</option>)}</select></label>}
                        <label>Taken each time<input aria-label={`${label} quantity`} value={s.quantity} onChange={(e) => setS(i, k, { quantity: e.target.value })} /></label>
                        <label>Isolates identified<select aria-label={`${label} identify`} value={s.identify} onChange={(e) => setS(i, k, { identify: e.target.value as Sampling['identify'] })}>
                          {IDENTIFY.map((x) => <option key={x}>{x}</option>)}</select></label>
                        <label>Adverse trend: alert or action results<input type="number" min={1} max={20} aria-label={`${label} adverse n`} placeholder={String(adverseRule(p.room?.grade ?? null).n)}
                          value={s.adverse?.n ?? ''} onChange={(e) => setS(i, k, { adverse: e.target.value ? { n: Number(e.target.value), m: s.adverse?.m ?? adverseRule(p.room?.grade ?? null).m } : undefined })} /></label>
                        <label>… in the last samplings<input type="number" min={1} max={20} aria-label={`${label} adverse m`} placeholder={String(adverseRule(p.room?.grade ?? null).m)}
                          value={s.adverse?.m ?? ''} onChange={(e) => setS(i, k, { adverse: e.target.value ? { n: s.adverse?.n ?? adverseRule(p.room?.grade ?? null).n, m: Number(e.target.value) } : undefined })} /></label>
                        <button type="button" className="link" onClick={() => setP(i, { samplings: p.samplings.filter((_, j) => j !== k) })}>Remove</button>
                      </div>);
                  })}
                  <button type="button" onClick={() => setP(i, { samplings: [...p.samplings, { key: newKey('s', p.samplings.map((x) => x.key)), kind: p.of === 'room' ? 'settle plate' : 'TOC',
                    frequency: p.of === 'room' ? 'daily' : 'weekly', ...(p.of === 'room' ? { state: 'in operation' as const } : {}), spec: null, quantity: p.of === 'room' ? '1 plate' : '250 mL', identify: 'on action' }] })}>Add a sampling</button>
                </div>))}
              <p className="sample-actions">
                <button type="button" className="primary" onClick={() => addPoint('room')}>Add a room point</button>
                <button type="button" onClick={() => addPoint('water')}>Add a water point</button>
              </p>
            </fieldset>
          )}
          {tab === 'review' && <Review me={me} version={v} doc={doc} blocked={blocked} onChanged={load} onOpen={onOpen} onGo={() => setTab('plan')} />}
        </div>
        <CheckPanel doc={doc} state={v.state} problems={problems} onGo={() => setTab('plan')} />
      </div>
    </div>
  );
}
