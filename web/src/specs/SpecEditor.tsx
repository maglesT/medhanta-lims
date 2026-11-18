// One specification version: its header and its tests (tab "Tests"), and the review and approval (tab "Review and
// approval"), with the specification check always beside it. A draft saves itself as it is edited (as the method
// designer); other states are read only. Each test picks an approved or effective method and its result from lists,
// a limit type from a fixed list, and gives the values the method asks the specification for.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, can, type Me } from '../api.js';
import { getProblems, getSpec, getVersion, listMasters, saveSpec, STATE_CHIP, STATE_LABEL, type MasterRow, type SpecVersion } from '../api-designer.js';
import { blocking, type Problem } from '../../../shared/master/checks.js';
import type { Limit, MasterDoc } from '../../../shared/master/schema.js';
import { LIMIT_TYPES, resultsOf, specNames, specSchema, TEST_USES, type SpecDoc, type SpecTest } from '../../../shared/master/spec.js';
import { CheckPanel } from '../designer/CheckPanel.js';
import { Review } from '../designer/Review.js';
import { newKey, placeOf, unitsOf, unitLabel } from '../designer/model.js';
import { Decimal } from '../designer/ui.js';

type Tab = 'tests' | 'review';
type Save = { kind: 'saved' | 'saving' | 'pending' } | { kind: 'invalid' | 'error'; message: string };

export function SpecEditor({ me, versionId, onBack, onOpen }: { me: Me; versionId: number; onBack: () => void; onOpen: (id: number) => void }) {
  const [v, setV] = useState<SpecVersion | null>(null);
  const [doc, setDoc] = useState<SpecDoc | null>(null);
  const [tab, setTab] = useState<Tab>('tests');
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [methods, setMethods] = useState<MasterRow[]>([]);
  const [save, setSave] = useState<Save>({ kind: 'saved' });
  const [error, setError] = useState('');
  const timer = useRef<number>();
  const latest = useRef<SpecDoc | null>(null);
  const load = async () => {
    const x = await getSpec(versionId);
    setV(x); setDoc(x.doc); latest.current = x.doc;
    if (x.state !== 'draft') setTab('review');
    setProblems((await getProblems(versionId)).problems);
  };
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
    // The methods a test may use: the latest approved or effective version of each.
    void listMasters().then((rows) => setMethods(rows.filter((r) => r.state === 'approved' || r.state === 'effective')
      .filter((r, _, all) => !all.some((o) => o.masterId === r.masterId && o.versionNo > r.versionNo && (o.state === 'approved' || o.state === 'effective')))));
  }, [versionId]);

  const editable = v?.state === 'draft' && can(me, 'master.author');
  const persist = async (d: SpecDoc) => {
    const p = specSchema.safeParse(d);
    if (!p.success) return setSave({ kind: 'invalid', message: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)[0]! });
    setSave({ kind: 'saving' });
    try {
      await saveSpec(versionId, p.data);
      setSave(latest.current === d ? { kind: 'saved' } : { kind: 'pending' });
      setProblems((await getProblems(versionId)).problems);
    } catch (e) { setSave({ kind: 'error', message: e instanceof ApiError ? e.message || e.code : String(e) }); }
  };
  const change = (next: SpecDoc) => {
    setDoc(next); latest.current = next;
    if (!editable) return;
    setSave({ kind: 'pending' });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void persist(next), 600);
  };
  const flush = async () => { if (timer.current && save.kind === 'pending' && latest.current) { window.clearTimeout(timer.current); await persist(latest.current); } };

  if (error) return <><button className="link dark" onClick={onBack}>← Specifications</button><p className="notice">{error}</p></>;
  if (!v || !doc) return <div className="skel skel-block tall" />;
  const h = doc.header;
  const blocked = problems === null || problems.some(blocking);
  const go = (path: string) => { if (placeOf(path).tab === 'header' || path.startsWith('tests')) setTab('tests'); };
  return (
    <div className="designer-page">
      <div className="d-top">
        <button className="link dark" onClick={async () => { await flush(); onBack(); }}>← Specifications</button>
        <div className="d-title">
          <h1>{h.number} · {h.code} {h.name}</h1>
          <span className="muted">Version {v.versionNo} · {h.type} · {h.pharmacopoeia}{h.edition ? ` ${h.edition}` : ''}{h.market ? ` · ${h.market}` : ''}</span>
          <span className={STATE_CHIP[v.state]}>{STATE_LABEL[v.state]}</span>
          {!editable && <span className="muted small">Read only{v.state === 'draft' ? '' : `: this version is ${STATE_LABEL[v.state].toLowerCase()}`}</span>}
        </div>
        <nav className="subtabs" aria-label="Specification">
          {([['tests', 'Tests'], ['review', 'Review and approval']] as const).map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={async () => { if (k === 'review') await flush(); setTab(k); }}>{label}</button>))}
          {editable && <span className={`save save-${save.kind}`} role="status">
            {save.kind === 'saved' ? 'All changes saved' : save.kind === 'saving' ? 'Saving…' : save.kind === 'pending' ? 'Changes not saved yet' : `Not saved: ${'message' in save ? save.message : ''}`}</span>}
        </nav>
      </div>
      <div className="designer">
        <div className="d-main">
          {tab === 'tests' && (
            <fieldset className="plain" disabled={!editable}>
              <div className="card">
                <div className="form-grid">
                  <label>Specification number<input aria-label="Specification number" value={h.number} onChange={(e) => change({ ...doc, header: { ...h, number: e.target.value } })} /></label>
                  <label>Pharmacopoeia<input aria-label="Pharmacopoeia" value={h.pharmacopoeia} onChange={(e) => change({ ...doc, header: { ...h, pharmacopoeia: e.target.value } })} /></label>
                  <label>Edition<input aria-label="Edition" value={h.edition ?? ''} onChange={(e) => change({ ...doc, header: e.target.value ? { ...h, edition: e.target.value } : (({ edition: _, ...x }) => x)(h) })} /></label>
                  <label>Market<input aria-label="Market" value={h.market ?? ''} onChange={(e) => change({ ...doc, header: e.target.value ? { ...h, market: e.target.value } : (({ market: _, ...x }) => x)(h) })} /></label>
                </div>
              </div>
              {doc.tests.map((t, i) => (
                <TestCard key={t.key} t={t} n={i} methods={methods} problems={(problems ?? []).filter((p) => p.path.startsWith(`tests[${i}]`))}
                  onChange={(x) => change({ ...doc, tests: doc.tests.map((y, j) => (j === i ? x : y)) })}
                  onRemove={() => change({ ...doc, tests: doc.tests.filter((_, j) => j !== i) })} />
              ))}
              <button type="button" className="primary" onClick={() => change({ ...doc, tests: [...doc.tests, newTest(doc.tests.map((x) => x.key))] })} disabled={!methods.length}>Add a test</button>
              {!methods.length && <p className="muted small">A test needs an approved or effective method: approve one in Methods first.</p>}
            </fieldset>
          )}
          {tab === 'review' && <Review me={me} version={v} doc={doc} blocked={blocked} onChanged={load} onOpen={onOpen} onGo={go} />}
        </div>
        <CheckPanel doc={doc} state={v.state} problems={problems} onGo={go} />
      </div>
    </div>
  );
}

const newTest = (taken: string[]): SpecTest => ({ key: newKey('test', taken), name: '', method: { masterId: 0, code: '', name: '' }, result: 'x/x/result', limitType: 'range', values: {}, use: 'release and stability' });

const methodDocs = new Map<number, Promise<MasterDoc>>();
/** The document of a method version (cached for the page). */
function useMethodDoc(row: MasterRow | undefined): MasterDoc | null {
  const [doc, setDoc] = useState<MasterDoc | null>(null);
  useEffect(() => {
    if (!row) return setDoc(null);
    let live = true;
    if (!methodDocs.has(row.id)) methodDocs.set(row.id, getVersion(row.id).then((x) => x.doc));
    void methodDocs.get(row.id)!.then((d) => live && setDoc(d));
    return () => { live = false; };
  }, [row?.id]);
  return doc;
}

function TestCard({ t, n, methods, problems, onChange, onRemove }: {
  t: SpecTest; n: number; methods: MasterRow[]; problems: Problem[]; onChange: (t: SpecTest) => void; onRemove: () => void;
}) {
  const row = methods.find((m) => m.masterId === t.method.masterId);
  const mdoc = useMethodDoc(row);
  const results = useMemo(() => (mdoc ? resultsOf(mdoc) : []), [mdoc]);
  const asks = useMemo(() => (mdoc ? specNames(mdoc).filter((x) => x.name !== 'limit') : []), [mdoc]);
  const needsLimit = !['conforms', 'report only'].includes(t.limitType);
  const set = (x: Partial<SpecTest>) => onChange({ ...t, ...x });
  return (
    <div className="card spec-test">
      <div className="d-section-head"><h2>Test {n + 1}{t.name ? `: ${t.name}` : ''}</h2><button type="button" className="link" onClick={onRemove}>Remove</button></div>
      <div className="form-grid">
        <label>Test<input aria-label={`Test ${n + 1} name`} value={t.name} placeholder="e.g. Assay" onChange={(e) => set({ name: e.target.value })} /></label>
        <label>Method
          <select aria-label={`Test ${n + 1} method`} value={t.method.masterId || ''} onChange={(e) => {
            const m = methods.find((x) => x.masterId === Number(e.target.value));
            set(m ? { method: { masterId: m.masterId, code: m.header.code, name: m.header.name }, result: 'x/x/result', values: {} } : { method: { masterId: 0, code: '', name: '' } });
          }}>
            <option value="">(choose a method)</option>
            {methods.map((m) => <option key={m.masterId} value={m.masterId}>{m.header.code} {m.header.name} (version {m.versionNo}, {STATE_LABEL[m.state].toLowerCase()})</option>)}
          </select>
        </label>
        <label>Result of the method
          <select aria-label={`Test ${n + 1} result`} value={t.result} onChange={(e) => set({ result: e.target.value })} disabled={!results.length}>
            <option value="x/x/result">(choose the result)</option>
            {results.map((r) => <option key={r.ref} value={r.ref}>{r.label}</option>)}
          </select>
        </label>
        <label>Applies
          <select aria-label={`Test ${n + 1} applies`} value={t.use} onChange={(e) => set({ use: e.target.value as SpecTest['use'] })}>
            {TEST_USES.map((u) => <option key={u} value={u}>{u === 'release and stability' ? 'at release and on stability' : u === 'release' ? 'at release only' : 'on stability only'}</option>)}
          </select>
        </label>
        <label>Limit type
          <select aria-label={`Test ${n + 1} limit type`} value={t.limitType} onChange={(e) => {
            const limitType = e.target.value as SpecTest['limitType'];
            const { limit: _l, shelfLifeLimit: _s, conforms: _c, ...rest } = t;
            set({ ...rest, limitType, ...(['conforms', 'report only'].includes(limitType) ? {} : t.limit ? { limit: t.limit } : {}) } as SpecTest);
          }}>
            {LIMIT_TYPES.map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
      </div>
      {t.limitType === 'conforms' && <label>The result must show<input aria-label={`Test ${n + 1} conforms`} value={t.conforms ?? ''} placeholder="e.g. The IR spectrum matches the reference spectrum" onChange={(e) => set({ conforms: e.target.value })} /></label>}
      {needsLimit && <LimitInput label={t.limitType === 'release and shelf life' ? 'Release limit' : t.limitType === 'alert and action' ? 'Action limit' : 'Limit'} type={t.limitType} value={t.limit}
        alert={t.limitType === 'alert and action'} onChange={(limit) => onChange(limit ? { ...t, limit } : (({ limit: _, ...x }) => x as SpecTest)(t))} />}
      {t.limitType === 'release and shelf life' && <LimitInput label="Shelf-life limit" type="range" value={t.shelfLifeLimit}
        onChange={(shelfLifeLimit) => onChange(shelfLifeLimit ? { ...t, shelfLifeLimit } : (({ shelfLifeLimit: _, ...x }) => x as SpecTest)(t))} />}
      {asks.length > 0 && (
        <div className="d-section">
          <h3>Values the method asks the specification for</h3>
          <div className="form-grid">
            {asks.map((a) => (
              <label key={a.name}>{a.name} <span className="muted small">({a.where})</span>
                <input aria-label={`Test ${n + 1} ${a.name}`} value={typeof t.values[a.name] === 'string' ? t.values[a.name] as string : ''} placeholder="e.g. 500 mg"
                  onChange={(e) => { const { [a.name]: _, ...rest } = t.values; set({ values: e.target.value ? { ...rest, [a.name]: e.target.value } : rest }); }} />
              </label>
            ))}
          </div>
        </div>
      )}
      {problems.length > 0 && <ul className="small">{problems.map((p, i) => <li key={i} className={p.level === 'error' ? 'error' : 'muted'}>{p.message}</li>)}</ul>}
    </div>
  );
}

/** A limit as its type says: both sides for a range, one for NMT / NLT; alert limits for alert and action. */
function LimitInput({ label, type, value, alert, onChange }: { label: string; type: SpecTest['limitType']; value?: Limit; alert?: boolean; onChange: (l: Limit | undefined) => void }) {
  const l = value ?? { unit: '%' };
  const put = (x: Partial<Limit>) => {
    const next = Object.fromEntries(Object.entries({ ...l, ...x }).filter(([, y]) => y !== undefined && y !== '')) as Limit;
    onChange(next.low || next.high ? { ...next, unit: next.unit ?? l.unit } : undefined);
  };
  const low = type !== 'not more than';
  const high = type !== 'not less than';
  return (
    <div className="limit-row">
      <span className="field-label">{label}</span>
      {low && <>not less than <Decimal label={`${label}: lowest`} placeholder="lowest" value={l.low} onChange={(v) => put({ low: v })} width={6} /></>}
      {low && high && ' and '}
      {high && <>not more than <Decimal label={`${label}: highest`} placeholder="highest" value={l.high} onChange={(v) => put({ high: v })} width={6} /></>}{' '}
      <select aria-label={`${label}: unit`} value={l.unit} onChange={(e) => put({ unit: e.target.value })}>
        {unitsOf().map((u) => <option key={u.symbol} value={u.symbol}>{unitLabel(u.symbol)}</option>)}
      </select>
      {alert && <> · alert below <Decimal label={`${label}: alert low`} value={l.alertLow} onChange={(v) => put({ alertLow: v })} width={6} /> or above <Decimal label={`${label}: alert high`} value={l.alertHigh} onChange={(v) => put({ alertHigh: v })} width={6} /></>}
    </div>
  );
}
