// The lab inventory (LIMS-12, 13, 14, 34, 35): standards, reagents, solutions, volumetric solutions, columns, media and
// cultures, each with whether it may be used now and why not. One screen per job: register (RegisterItemDialog), one
// item (ItemScreen).
import { useEffect, useState } from 'react';
import { can, plantTime, type Me } from '../api.js';
import { plainError } from '../api-floor.js';
import { ITEM_KINDS, ITEM_KIND_NAME, dayWords, type ItemKind } from '../../../shared/engine/items.js';
import { listItems, statusChip, statusWords, type ItemRow } from './api-inventory.js';
import { RegisterItemDialog } from './RegisterItemDialog.js';
import { ItemScreen } from './ItemScreen.js';
import '../designer/designer.css';
import '../floor/floor.css';
import '../samples/samples.css';

export function Inventory({ me }: { me: Me }) {
  const may = can(me, 'analysis.perform');
  const [rows, setRows] = useState<ItemRow[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [registering, setRegistering] = useState(false);
  const [kind, setKind] = useState<ItemKind | ''>('');
  const [q, setQ] = useState('');
  const load = () => { listItems().then(setRows, (e) => setError(plainError(e))); };
  useEffect(load, []);

  if (open !== null) return <ItemScreen me={me} id={open} onBack={() => { setOpen(null); load(); }} onOpen={setOpen} />;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows ?? []).filter((r) => (!kind || r.kind === kind)
    && words.every((w) => `${r.itemNo} ${r.name} ${r.facts.lot ?? ''} ${r.facts.serial ?? ''} ${statusWords(r.status)}`.toLowerCase().includes(w)));
  return (
    <>
      <div className="home-head">
        <div>
          <h1>Inventory</h1>
          <p className="greeting">Standards, reagents, solutions, columns, media and cultures. Only a usable item can be picked in an analysis. Dates are plant dates (IST).</p>
        </div>
        {may && <button className="primary" onClick={() => setRegistering(true)}>Register an item</button>}
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="toggle" role="group" aria-label="Kind">
        <button type="button" className={kind === '' ? 'on' : ''} onClick={() => setKind('')}>All</button>
        {ITEM_KINDS.map((k) => <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{ITEM_KIND_NAME[k]}</button>)}
      </div>
      <input className="search" placeholder="Search by number, name, lot, serial or status" aria-label="Search the inventory" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows === null ? <div className="skel skel-block" /> : !shown.length ? (
        <div className="card placeholder"><p>No items{kind ? ` of this kind` : ''} yet.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="masters" aria-label="Inventory">
            <thead><tr><th>Item</th><th>Kind</th><th>Status</th><th>In use until</th><th>Registered</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpen(r.id)}>
                  <td><b>{r.itemNo}</b><span className="cell-sub">{r.name}{r.facts.lot ? ` · lot ${r.facts.lot}` : ''}{r.facts.serial ? ` · serial ${r.facts.serial}` : ''}</span></td>
                  <td>{ITEM_KIND_NAME[r.kind]}</td>
                  <td><span className={statusChip(r.status)}>{r.status.usable ? 'Usable' : 'Not usable'}</span>{!r.status.usable && <span className="cell-sub">{r.status.why.join('; ')}</span>}
                    {r.waitingCheck && <span className="cell-sub">waits for a second person's check</span>}</td>
                  <td>{r.status.due ? dayWords(r.status.due) : '—'}</td>
                  <td>{r.registeredByName}<span className="cell-sub">{plantTime(r.registeredAt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {registering && <RegisterItemDialog items={rows ?? []} onCancel={() => setRegistering(false)} onDone={(id) => { setRegistering(false); setOpen(id); }} />}
    </>
  );
}
