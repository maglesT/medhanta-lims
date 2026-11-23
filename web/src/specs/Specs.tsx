// Specifications (LIMS-01): one row per version, as the methods list. A draft is written here, checked by a second
// person and approved by QA with a change control; only the effective version is used for samples.
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, can, plantTime, type Me } from '../api.js';
import { createSpec, listSpecs, loadMasterData, newVersion, STATE_CHIP, STATE_LABEL, type MasterData, type SpecRow } from '../api-designer.js';
import { SPEC_TYPES, specSchema, type SpecDoc } from '../../../shared/master/spec.js';
import { Picker } from '../designer/ui.js';
import { SpecEditor } from './SpecEditor.js';
import '../designer/designer.css';

export function Specs({ me }: { me: Me }) {
  const [rows, setRows] = useState<SpecRow[] | null>(null);
  const [md, setMd] = useState<MasterData | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const author = can(me, 'master.author');
  const load = async () => setRows(await listSpecs());
  useEffect(() => {
    void load();
    loadMasterData().then(setMd, (e: Error) => setError(e.message));
  }, []);

  if (open !== null) return <SpecEditor me={me} versionId={open} onBack={() => { setOpen(null); void load(); }} onOpen={setOpen} />;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows ?? []).filter((r) => words.every((w) => `${r.header.number} ${r.header.code} ${r.header.name} ${r.header.type}`.toLowerCase().includes(w)));
  const pending = (masterId: number) => rows?.some((r) => r.masterId === masterId && ['draft', 'in_review', 'approved'].includes(r.state));
  const addVersion = async (r: SpecRow) => {
    try { setOpen((await newVersion(r.masterId)).id); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  return (
    <>
      <div className="home-head">
        <div>
          <h1>Specifications</h1>
          <p className="greeting">One row per version: the tests of a material or product, each with its method and limit. Written here, checked by a second person and approved by QA.</p>
        </div>
        {author && <button className="primary" onClick={() => setCreating(true)} disabled={!md}>New specification</button>}
      </div>
      {error && <p className="notice">{error}</p>}
      <input className="search" placeholder="Search by number, code, name or type" aria-label="Search specifications" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows === null ? <div className="skel skel-block" /> : !rows.length ? (
        <div className="card placeholder"><p>No specifications yet.{author && ' Start with New specification.'}</p></div>
      ) : (
        <div className="table-wrap">
          <table className="masters">
            <thead><tr><th>Specification</th><th>For</th><th>Type</th><th>Version</th><th>State</th><th>Written by</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpen(r.id)}>
                  <td><b>{r.header.number}</b><span className="cell-sub">{r.header.pharmacopoeia}{r.header.market ? ` · ${r.header.market}` : ''}</span></td>
                  <td><b>{r.header.code}</b><span className="cell-sub">{r.header.name}</span></td>
                  <td>{r.header.type}</td>
                  <td>{r.versionNo}</td>
                  <td><span className={STATE_CHIP[r.state]}>{STATE_LABEL[r.state]}</span></td>
                  <td>{r.createdByName}<span className="cell-sub">{plantTime(r.createdAt)}</span></td>
                  <td>
                    <span className="actions-cell" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setOpen(r.id)}>Open</button>
                      {author && r.state === 'effective' && !pending(r.masterId) && <button onClick={() => void addVersion(r)}>New version</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && md && <NewSpec md={md} onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
    </>
  );
}

/** New specification: what it is for (picked from master data, pull don't type), its type, number and pharmacopoeia. */
function NewSpec({ md, onCreated, onCancel }: { md: MasterData; onCreated: (id: number) => void; onCancel: () => void }) {
  const [header, setHeader] = useState<SpecDoc['header']>({ of: 'material', itemId: '', code: '', name: '', type: 'Raw material', number: '', pharmacopoeia: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof SpecDoc['header'], v: string) => setHeader((h) => ({ ...h, [k]: v }));
  const items = header.of === 'product' ? md.products : md.materials;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!header.itemId) return setError(`Pick the ${header.of}.`);
    const parsed = specSchema.safeParse({ header: { ...header, ...(header.market ? {} : { market: undefined }), ...(header.edition ? {} : { edition: undefined }) }, tests: [] });
    if (!parsed.success) return setError(parsed.error.issues.map((i) => `${String(i.path.at(-1))}: ${i.message}`).join('; '));
    setBusy(true);
    try { onCreated((await createSpec(parsed.data)).id); } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); setBusy(false); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="New specification">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>New specification</h2>
        <fieldset className="checklist">
          <legend>For</legend>
          <label className="check route"><input type="radio" name="of" checked={header.of === 'material'} onChange={() => setHeader((h) => ({ ...h, of: 'material', itemId: '', code: '', name: '' }))} /><span>A material (raw, packing, active substance)</span></label>
          <label className="check route"><input type="radio" name="of" checked={header.of === 'product'} onChange={() => setHeader((h) => ({ ...h, of: 'product', itemId: '', code: '', name: '', type: 'Finished product' }))} /><span>A product</span></label>
        </fieldset>
        {header.itemId ? (
          <p><b>{header.code}</b> {header.name} <button type="button" className="link dark" onClick={() => setHeader((h) => ({ ...h, itemId: '', code: '', name: '' }))}>Change</button></p>
        ) : (
          <Picker label={header.of === 'product' ? 'Product' : 'Material'} items={items.filter((i) => i.active).map((i) => ({ id: i.itemId, code: i.code, name: i.name }))}
            onPick={(i) => setHeader((h) => ({ ...h, itemId: i.id, code: i.code, name: i.name }))} />
        )}
        <div className="form-grid">
          <label>Type<select aria-label="Type" value={header.type} onChange={(e) => set('type', e.target.value)}>{SPEC_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>Specification number<input aria-label="Specification number" value={header.number} onChange={(e) => set('number', e.target.value)} placeholder="e.g. SPEC-RM-012" /></label>
          <label>Pharmacopoeia<input aria-label="Pharmacopoeia" value={header.pharmacopoeia} onChange={(e) => set('pharmacopoeia', e.target.value)} placeholder="IP, BP, Ph. Eur., USP, Ph. Int. or In-house" /></label>
          <label>Edition<input aria-label="Edition" value={header.edition ?? ''} onChange={(e) => set('edition', e.target.value)} placeholder="e.g. 2026" /></label>
          <label>Market<input aria-label="Market" value={header.market ?? ''} onChange={(e) => set('market', e.target.value)} placeholder="blank: all markets" /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>Create draft</button>
        </div>
      </form>
    </div>
  );
}
