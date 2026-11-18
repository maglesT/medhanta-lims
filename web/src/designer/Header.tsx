// Screen 2: the method header (code, name, technique, reference) and the new-method dialog with what the method starts
// from: empty, a method skeleton, or a copy of another method.
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api.js';
import { createMaster, getVersion, STATE_LABEL, type MasterData, type MasterRow } from '../api-designer.js';
import { masterSchema, TECHNIQUES, type MasterDoc } from '../../../shared/master/schema.js';
import { SKELETON_LIST, skeletonStages } from './skeletons.js';

type Header = MasterDoc['header'];

export function HeaderFields({ header, onChange }: { header: Header; onChange: (h: Header) => void; md?: MasterData }) {
  const set = (k: keyof Header, v: string) => onChange({ ...header, [k]: v });
  return (
    <div className="header-fields">
      <div className="form-grid">
        <label>Method code<input aria-label="Method code" value={header.code} onChange={(e) => set('code', e.target.value)} placeholder="e.g. QC-M-012" /></label>
        <label>Method name<input aria-label="Method name" value={header.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Paracetamol assay by HPLC" /></label>
        <label>Technique
          <select aria-label="Technique" value={header.technique} onChange={(e) => set('technique', e.target.value)}>
            {TECHNIQUES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>Reference (monograph, chapter or in-house number)<input aria-label="Reference" value={header.reference} onChange={(e) => set('reference', e.target.value)} placeholder="e.g. Ph. Int. Paracetamol tablets" /></label>
        <label>Edition<input aria-label="Edition" value={header.edition ?? ''} placeholder="e.g. 12th ed. 2025"
          onChange={(e) => onChange(e.target.value ? { ...header, edition: e.target.value } : (({ edition: _, ...h }) => h)(header))} /></label>
        <label>Source (what it needs before routine use)
          <select aria-label="Source" value={header.origin ?? 'in-house'} onChange={(e) => onChange({ ...header, origin: e.target.value as Header['origin'] })}>
            <option value="in-house">In-house method: validated</option>
            <option value="pharmacopoeial">Pharmacopoeial method: verified</option>
            <option value="transferred">Transferred from another laboratory: transfer report</option>
          </select>
        </label>
        <label>Used for
          <select aria-label="Used for" value={header.use ?? 'routine'} onChange={(e) => onChange({ ...header, use: e.target.value as Header['use'] })}>
            <option value="routine">Routine analysis</option>
            <option value="validation">Validation worksheet (validation, verification or transfer protocol)</option>
          </select>
        </label>
      </div>
    </div>
  );
}

type Start = { kind: 'empty' } | { kind: 'skeleton'; id: string } | { kind: 'copy'; versionId: number };

/** New method (or a copy of one): the header, and what it starts from. */
export function NewMaster({ masters, copyOf, onCreated, onCancel }: {
  md: MasterData; masters: MasterRow[]; copyOf?: MasterRow; onCreated: (id: number) => void; onCancel: () => void;
}) {
  const [header, setHeader] = useState<Header>({ ...(copyOf?.header ?? { code: '', name: '', technique: 'HPLC', reference: '' }) });
  const skeletons = SKELETON_LIST;
  const [start, setStart] = useState<Start>(copyOf ? { kind: 'copy', versionId: copyOf.id } : { kind: 'skeleton', id: skeletons[0]!.id });
  const [source, setSource] = useState<MasterDoc | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (start.kind !== 'copy') return setSource(null);
    void getVersion(start.versionId).then((v) => setSource(v.doc));
  }, [start.kind === 'copy' ? start.versionId : 0]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    let doc: MasterDoc = { header, stages: [] };
    if (start.kind === 'skeleton') {
      doc.stages = skeletonStages(start.id);
      // A validation skeleton is a validation worksheet (LIMS-02).
      if (skeletons.find((s) => s.id === start.id)?.use === 'validation') doc = { ...doc, header: { ...header, use: 'validation' } };
    }
    if (start.kind === 'copy' && source) doc = { ...source, header };
    if (!header.code.trim() || !header.name.trim()) return setError('Give the method code and name.');
    const parsed = masterSchema.safeParse(doc);
    if (!parsed.success) return setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    setBusy(true);
    try {
      onCreated((await createMaster(parsed.data)).id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={copyOf ? 'Copy a method' : 'New method'}>
      <form className="card dialog wide" onSubmit={submit}>
        <h2>{copyOf ? `Copy ${copyOf.header.code} version ${copyOf.versionNo}` : 'New method'}</h2>
        <HeaderFields header={header} onChange={setHeader} />
        <fieldset className="checklist">
          <legend>Start from</legend>
          {skeletons.map((s) => (
            <label key={s.id} className="check route"><input type="radio" name="start" checked={start.kind === 'skeleton' && start.id === s.id} onChange={() => setStart({ kind: 'skeleton', id: s.id })} />
              <span>Method skeleton: {s.name}<small>{s.text}</small></span></label>
          ))}
          <label className="check route"><input type="radio" name="start" checked={start.kind === 'copy'} onChange={() => masters[0] && setStart({ kind: 'copy', versionId: copyOf?.id ?? masters[0].id })} disabled={!masters.length} />
            <span>A copy of another method<small>Its stages and steps are copied.</small></span></label>
          {start.kind === 'copy' && (
            <select aria-label="Method to copy" value={start.versionId} onChange={(e) => { setStart({ kind: 'copy', versionId: Number(e.target.value) }); }}>
              {masters.map((m) => <option key={m.id} value={m.id}>{m.header.code} {m.header.name} · version {m.versionNo} ({STATE_LABEL[m.state]})</option>)}
            </select>
          )}
          <label className="check route"><input type="radio" name="start" checked={start.kind === 'empty'} onChange={() => setStart({ kind: 'empty' })} />
            <span>Empty<small>No stages yet.</small></span></label>
        </fieldset>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>Create draft</button>
        </div>
      </form>
    </div>
  );
}
