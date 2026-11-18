// Register a sample (LIMS-05): the lot's or batch's facts as pulled (read-only) and the specification found for it; or,
// while the link is absent or down, the number typed and the item picked from master data (a second person checks it).
// Then the quantity, the containers sampled and the purpose.
import { useEffect, useState, type FormEvent } from 'react';
import { plainError } from '../api-floor.js';
import { loadMasterData, type MasterData } from '../api-designer.js';
import { Picker } from '../designer/ui.js';
import { PROVIDER_NAME } from '../../../shared/engine/links.js';
import { SAMPLE_PURPOSES, type SamplePurpose } from '../../../shared/engine/sample.js';
import { plantText } from '../../../shared/plant-time.js';
import { PURPOSE_LABEL, registerSample, specsFor, type From, type SampleRequest, type SpecChoice } from './api-samples.js';

export function RegisterDialog({ from, onDone, onCancel, purpose: initial = 'release' }: { from: SampleRequest | { hand: From }; onDone: (id: number) => void; onCancel: () => void; purpose?: SamplePurpose }) {
  const hand = 'hand' in from ? from.hand : null;
  const source: From = hand ?? (from as SampleRequest).source;
  const what = source === 'mms' ? 'lot' : 'batch';
  const [lotNo, setLotNo] = useState(hand ? '' : (from as SampleRequest).lotNo);
  const [md, setMd] = useState<MasterData | null>(null);
  const [item, setItem] = useState<{ id: string; code: string; name: string } | null>(null);
  const [specs, setSpecs] = useState<SpecChoice[] | null>(hand ? null : (from as SampleRequest).specs);
  const [specId, setSpecId] = useState<number | null>(hand ? null : (from as SampleRequest).specs[0]?.id ?? null);
  const [quantity, setQuantity] = useState('');
  const [containers, setContainers] = useState('');
  const [purpose, setPurpose] = useState<SamplePurpose>(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (hand) loadMasterData().then(setMd, (e) => setError(plainError(e))); }, [hand]);
  useEffect(() => {
    if (!hand || !item) return;
    setSpecs(null);
    specsFor(source === 'mms' ? 'material' : 'product', item.id).then((s) => { setSpecs(s); setSpecId(s[0]?.id ?? null); }, (e) => setError(plainError(e)));
  }, [hand, item, source]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!lotNo.trim()) return setError(`Give the ${what} number.`);
    if (hand && !item) return setError(`Pick the ${source === 'mms' ? 'material' : 'product'}.`);
    if (!specId) return setError('There is no effective specification to test it against.');
    if (!/^\d+(\.\d+)?\s*\S/.test(quantity.trim())) return setError('Give the quantity with its unit, e.g. 120 g.');
    const n = containers.trim() ? Number(containers) : undefined;
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) return setError('Containers sampled: a whole number, 1 or more.');
    setBusy(true);
    try {
      const r = await registerSample({ source, ...(source === 'mms' ? { lotNumber: lotNo.trim() } : { batchNumber: lotNo.trim() }),
        ...(hand ? { byHand: true, itemId: item!.id } : {}), specVersionId: specId, quantity: quantity.trim(), ...(n ? { containers: n } : {}), purpose });
      onDone(r.id);
    } catch (err) { setError(plainError(err)); setBusy(false); }
  };

  const items = !md ? [] : (source === 'mms' ? md.materials : md.products).filter((i) => i.active).map((i) => ({ id: i.itemId, code: i.code, name: i.name }));
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Register a sample">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>Register a sample{hand ? ' by hand' : ''}</h2>
        {hand ? (<>
          <p className="notice">{PROVIDER_NAME[source]} is not reachable now. Type the {what} number from its label and pick what it is; the sample is marked
            “typed by hand” and a second person checks it before it is received.</p>
          <label>{what === 'lot' ? 'Lot number' : 'Batch number'}<input aria-label={what === 'lot' ? 'Lot number' : 'Batch number'} value={lotNo} onChange={(e) => setLotNo(e.target.value)} /></label>
          {item ? (
            <p><b>{item.code}</b> {item.name} <button type="button" className="link dark" onClick={() => { setItem(null); setSpecs(null); setSpecId(null); }}>Change</button></p>
          ) : md && <Picker label={source === 'mms' ? 'Material' : 'Product'} items={items} onPick={(i) => setItem(i)} />}
        </>) : (
          <dl className="details">
            <dt>{what === 'lot' ? 'Lot' : 'Batch'}</dt><dd><b>{lotNo}</b></dd>
            <dt>What</dt><dd><b>{(from as SampleRequest).code}</b> {(from as SampleRequest).name ?? ''}</dd>
            <dt>From {PROVIDER_NAME[source]}</dt><dd>{plantText((from as SampleRequest).shown)}</dd>
          </dl>
        )}
        {specs && (specs.length === 0 ? <p className="error">No effective specification for this item: a sample is tested against the effective version only.</p> : (
          <label>Specification
            <select aria-label="Specification" value={specId ?? ''} onChange={(e) => setSpecId(Number(e.target.value))} disabled={specs.length === 1}>
              {specs.map((s) => <option key={s.id} value={s.id}>{s.number}, version {s.versionNo} ({s.type}{s.market ? `, ${s.market}` : ''})</option>)}
            </select>
          </label>
        ))}
        <div className="form-grid">
          <label>Quantity taken<input aria-label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 120 g" /></label>
          <label>Containers sampled<input aria-label="Containers sampled" inputMode="numeric" value={containers} onChange={(e) => setContainers(e.target.value)} placeholder="optional" /></label>
          <label>Purpose<select aria-label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as SamplePurpose)}>
            {SAMPLE_PURPOSES.map((p) => <option key={p} value={p}>{PURPOSE_LABEL[p]}</option>)}</select></label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>Register</button>
        </div>
      </form>
    </div>
  );
}
