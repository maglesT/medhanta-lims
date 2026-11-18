// Register a lab item as received or prepared: its kind, the facts its kind needs (from its label or certificate, or
// from the preparation), and what it was made from or qualified against: only usable items are offered (LIMS-13,
// LIMS-14, LIMS-35). The server checks it all again.
import { useState, type FormEvent } from 'react';
import { plainError } from '../api-floor.js';
import { BASES, FACT_LABEL, ITEM_KINDS, ITEM_KIND_NAME, KIND_FACTS, MAX_PASSAGE, type FactName, type ItemKind } from '../../../shared/engine/items.js';
import { registerItem, type ItemRow } from './api-inventory.js';

const DATES: FactName[] = ['expiry', 'retestOn'];
const HINT: Partial<Record<FactName, string>> = {
  source: 'e.g. USP, Ph. Eur., IP', lot: 'from the label', potency: 'e.g. 99.6', procedure: 'e.g. SOP-QC-021', molarity: 'e.g. 0.1 M', storage: 'e.g. 2-8 °C, desiccator',
  columnType: 'e.g. C18, 250 x 4.6 mm, 5 µm', sterilisation: 'e.g. Autoclave AC-01, cycle 233', strain: 'e.g. ATCC 6538', organism: 'e.g. Staphylococcus aureus',
};
const PARENT_WORDS: Record<'one' | 'any' | 'culture', string> = {
  one: 'Qualified against the primary (reference) standard',
  any: 'Made from (reagents, standards and solutions used)',
  culture: `Sub-cultured from (none: this is the reference culture; at most ${MAX_PASSAGE} passages)`,
};

export function RegisterItemDialog({ items, onDone, onCancel }: { items: ItemRow[]; onDone: (id: number) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<ItemKind>('reference');
  const [values, setValues] = useState<Record<string, string>>({});
  const [parents, setParents] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const rule = KIND_FACTS[kind];
  const facts: FactName[] = [...rule.need, ...rule.may];
  const set = (n: string, v: string) => { setValues((x) => ({ ...x, [n]: v })); setError(''); };
  // What it may be made from: usable items of the fitting kinds.
  const offered = items.filter((i) => i.status.usable && (rule.parents === 'one' ? i.kind === 'reference' : rule.parents === 'culture' ? i.kind === 'culture'
    : ['reagent', 'solution', 'vs', 'reference', 'working'].includes(i.kind)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!values.name?.trim()) return setError('Give the name of the item.');
    const missing = rule.need.find((n) => !values[n]?.trim());
    if (missing) return setError(`${FACT_LABEL[missing]}: please give it.`);
    if (rule.parents === 'one' && parents.length !== 1) return setError('Pick the primary standard it is qualified against.');
    setBusy(true);
    try {
      const f: Record<string, string | number> = { name: values.name.trim() };
      for (const n of facts) if (values[n]?.trim()) f[n] = n === 'useDays' ? Number(values[n]) : values[n]!.trim();
      const r = await registerItem({ kind, facts: f, parentIds: parents });
      onDone(r.id);
    } catch (err) { setError(plainError(err)); setBusy(false); }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Register an item">
      <form className="card dialog wide" onSubmit={submit}>
        <h2>Register an item</h2>
        <p className="muted">Received or prepared now. Your name and the server's time are recorded; the number is given by the kind.</p>
        <label>Kind
          <select aria-label="Kind" value={kind} onChange={(e) => { setKind(e.target.value as ItemKind); setParents([]); setError(''); }}>
            {ITEM_KINDS.map((k) => <option key={k} value={k}>{ITEM_KIND_NAME[k]}</option>)}
          </select>
        </label>
        <label>Name<input aria-label="Name" value={values.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Paracetamol RS, 0.1 M Sodium hydroxide" /></label>
        {facts.map((n) => {
          const label = `${FACT_LABEL[n]}${rule.need.includes(n) ? '' : ' (if it applies)'}`;
          if (n === 'basis') return (
            <label key={n}>{label}<select aria-label={FACT_LABEL[n]} value={values[n] ?? ''} onChange={(e) => set(n, e.target.value)}>
              <option value="">Pick…</option>{BASES.map((b) => <option key={b}>{b}</option>)}</select></label>
          );
          return <label key={n}>{label}<input aria-label={FACT_LABEL[n]} type={DATES.includes(n) ? 'date' : n === 'useDays' ? 'number' : 'text'} placeholder={HINT[n]}
            value={values[n] ?? ''} onChange={(e) => set(n, e.target.value)} /></label>;
        })}
        {rule.parents !== 'none' && (
          <fieldset className="parents">
            <legend>{PARENT_WORDS[rule.parents]}</legend>
            {!offered.length && <p className="muted small">No usable item to pick.</p>}
            {offered.map((i) => (
              <label key={i.id} className="check">
                <input type={rule.parents === 'any' ? 'checkbox' : 'radio'} name="parent" checked={parents.includes(i.id)}
                  onChange={(e) => setParents(rule.parents === 'any' ? (e.target.checked ? [...parents, i.id] : parents.filter((x) => x !== i.id)) : [i.id])} />
                <b>{i.itemNo}</b> {i.name}{i.status.passage !== undefined ? ` · passage ${i.status.passage}` : ''}
              </label>
            ))}
            {rule.parents === 'culture' && parents.length > 0 && <button type="button" className="link dark" onClick={() => setParents([])}>None: this is the reference culture</button>}
          </fieldset>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>Register</button>
        </div>
      </form>
    </div>
  );
}
