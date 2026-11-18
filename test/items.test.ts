import { describe, expect, it } from 'vitest';
import { itemFills, itemRefusal, itemStatus, registerProblems, type Item, type ItemEvent, type ItemFacts, type ItemKind, type Parent } from '../shared/engine/items.js';
import { findBlock } from '../shared/blocks/index.js';
import { blockProblems } from '../shared/blocks/format.js';

// The lab inventory's status, computed from an item's facts and entries (shared/engine/items.ts): may it be used today,
// and if not, why; the values it gives a worksheet.

const TODAY = '2026-11-18';
const item = (kind: ItemKind, facts: Partial<ItemFacts> = {}): Item => ({ kind, facts: { name: 'X', ...facts }, registeredBy: 1, day: '2026-11-01' });
let n = 0;
const e = (kind: ItemEvent['kind'], payload: ItemEvent['payload'] = {}, person = 1, day = '2026-11-10'): ItemEvent => ({ id: ++n, kind, payload, person, day });
const status = (i: Item, events: ItemEvent[] = []) => itemStatus(i, events, TODAY);
const parent = (kind: ItemKind, usable = true, passage?: number): Parent => ({ kind, itemNo: 'P1', name: 'Parent', status: { usable, why: usable ? [] : ['expired on 1 Nov 2026'], values: {}, due: null, ...(passage !== undefined ? { passage } : {}) } });

describe('reference standards (LIMS-14)', () => {
  const rs = item('reference', { source: 'USP', lot: 'R123', potency: '99.6', basis: 'as is', retestOn: '2027-06-30' });
  it('LIMS-14 a primary standard in date is usable, and gives its certificate potency and basis', () => {
    expect(status(rs)).toEqual({ usable: true, why: [], values: { potency: '99.6', basis: 'as is' }, due: '2027-06-30' });
  });
  it('LIMS-14 past its retest date or expired, it cannot be used; a retest entry gives a new date', () => {
    const old = item('reference', { ...rs.facts, retestOn: '2026-11-17', expiry: '2026-11-01' });
    expect(status(old).why).toEqual(['expired on 1 Nov 2026', 'past its retest date 17 Nov 2026']);
    expect(status(item('reference', { ...rs.facts, retestOn: '2026-11-17' }), [e('retest', { retestOn: '2027-05-31' })])).toMatchObject({ usable: true, due: '2027-05-31' });
  });
  it('LIMS-14 a blocked standard cannot be used until unblocked; a disposed one never again', () => {
    expect(status(rs, [e('blocked', { reason: 'vial cracked' })]).why).toEqual(['blocked: vial cracked']);
    expect(status(rs, [e('blocked', { reason: 'x' }), e('unblocked', { reason: 'y' })]).usable).toBe(true);
    expect(status(rs, [e('disposed', { reason: 'used up' }, 1, '2026-11-12')]).why).toEqual(['disposed of on 12 Nov 2026']);
  });
  it('LIMS-14 registering needs the certificate facts and a date in the future', () => {
    expect(registerProblems('reference', { name: 'RS' }, [], TODAY)).toEqual(expect.arrayContaining([
      'Issued by (pharmacopoeia or primary source): please give it.', 'Potency (%): please give it.', 'Give the expiry or the retest date from the certificate.']));
    expect(registerProblems('reference', { ...rs.facts, retestOn: '2026-11-01' }, [], TODAY)).toEqual(['Retest date: 1 Nov 2026 is already past; it cannot be registered for use.']);
    expect(registerProblems('reference', { ...rs.facts, potency: '101' }, [], TODAY)).toEqual(['Potency: a percentage above 0 and up to 100, e.g. 99.6.']);
  });
});

describe('working standards (LIMS-14)', () => {
  const ws = item('working', { lot: 'WS-01' });
  it('LIMS-14 a working standard is qualified against one usable primary standard', () => {
    expect(registerProblems('working', { name: 'WS', lot: 'W1' }, [], TODAY)).toEqual(['A working standard is qualified against one primary (reference) standard: pick it.']);
    expect(registerProblems('working', { name: 'WS', lot: 'W1' }, [parent('reagent')], TODAY)).toEqual(['A working standard is qualified against one primary (reference) standard: pick it.']);
    expect(registerProblems('working', { name: 'WS', lot: 'W1' }, [parent('reference', false)], TODAY)).toEqual(['P1 Parent cannot be used to make it: expired on 1 Nov 2026.']);
    expect(registerProblems('working', { name: 'WS', lot: 'W1' }, [parent('reference')], TODAY)).toEqual([]);
    expect(itemRefusal('qualify', ws, [], 1, { potency: '99.1', basis: 'dried', nextDue: '2027-05-01' }, TODAY, parent('reference', false))).toMatch(/cannot be used to qualify against/);
  });
  it('LIMS-14 not usable until qualified and checked by a second person; then its assigned potency is used, until re-qualification is due', () => {
    expect(status(ws).why).toEqual(['not qualified against its primary standard']);
    const q = e('qualified', { potency: '99.1', basis: 'dried', nextDue: '2027-05-01' }, 1);
    expect(status(ws, [q]).why).toEqual(['its qualification of 10 Nov 2026 waits for a second person\'s check']);
    expect(itemRefusal('check', ws, [q], 1, {}, TODAY)).toBe('The person who recorded the entry cannot check it: a second person checks it.');
    expect(itemRefusal('check', ws, [q], 2, {}, TODAY)).toBeNull();
    expect(status(ws, [q, e('checked', { of: q.id }, 2)])).toEqual({ usable: true, why: [], values: { potency: '99.1', basis: 'dried' }, due: '2027-05-01' });
    const late = e('qualified', { potency: '99.1', basis: 'dried', nextDue: '2026-11-15' }, 1);
    expect(status(ws, [late, e('checked', { of: late.id }, 2)]).why).toEqual(['re-qualification was due on 15 Nov 2026']);
  });
});

describe('reagents, solutions and volumetric solutions (LIMS-13)', () => {
  it('LIMS-13 an expired reagent cannot be used; nor one past its use period after opening', () => {
    const rg = item('reagent', { supplier: 'S', lot: 'L', expiry: '2027-01-31', useDays: 30 });
    expect(status(rg).usable).toBe(true);
    expect(status(item('reagent', { ...rg.facts, expiry: '2026-11-17' })).why).toEqual(['expired on 17 Nov 2026']);
    expect(status(rg, [e('opened', {}, 1, '2026-10-19')]).why).toEqual([]);
    expect(status(rg, [e('opened', {}, 1, '2026-10-18')]).why).toEqual(['its use period after opening (30 days) ended on 17 Nov 2026']);
    expect(itemRefusal('open', rg, [e('opened')], 1, {}, TODAY)).toBe('The reagent is already opened.');
  });
  it('LIMS-13 a solution is made only from usable items; it cannot be used past its use-by date', () => {
    expect(registerProblems('solution', { name: 'Buffer pH 4.5', procedure: 'SOP-QC-012', expiry: '2026-11-25' }, [parent('reagent', false)], TODAY))
      .toEqual(['P1 Parent cannot be used to make it: expired on 1 Nov 2026.']);
    expect(status(item('solution', { procedure: 'SOP', expiry: '2026-11-17' })).why).toEqual(['past its use-by date 17 Nov 2026']);
  });
  it('LIMS-13 a VS is usable only with a standardisation checked by a second person; its factor comes with it; overdue blocks it', () => {
    const vs = item('vs', { molarity: '0.1 M', procedure: 'SOP', expiry: '2027-02-01' });
    expect(status(vs).why).toEqual(['not standardised']);
    expect(itemRefusal('standardise', vs, [], 1, { factor: '0.1', nextDue: '2026-12-01' }, TODAY)).toMatch(/^Factor: a number near 1/);
    expect(itemRefusal('standardise', vs, [], 1, { factor: '1.0023', nextDue: '2026-11-18' }, TODAY)).toBe('Next standardisation due: give a date after today.');
    const s = e('standardised', { factor: '1.0023', nextDue: '2026-12-01' });
    expect(status(vs, [s]).usable).toBe(false);
    expect(status(vs, [s, e('checked', { of: s.id }, 2)])).toMatchObject({ usable: true, values: { factor: '1.0023' }, due: '2026-12-01' });
    const old = e('standardised', { factor: '1.0023', nextDue: '2026-11-17' });
    expect(status(vs, [old, e('checked', { of: old.id }, 2)]).why).toEqual(['standardisation overdue since 17 Nov 2026']);
    expect(registerProblems('vs', { name: 'NaOH', molarity: 'tenth molar', procedure: 'SOP', expiry: '2027-01-01' }, [], TODAY)).toEqual(['Stated molarity: e.g. 0.1 M.']);
  });
});

describe('columns (LIMS-12)', () => {
  it('LIMS-12 a column is usable until retired', () => {
    const co = item('column', { columnType: 'C18 250 x 4.6 mm', serial: 'SN1' });
    expect(status(co).usable).toBe(true);
    expect(status(co, [e('disposed', { reason: 'plates below limit' }, 1, '2026-11-11')]).why).toEqual(['retired on 11 Nov 2026']);
    expect(itemRefusal('note', co, [e('disposed', { reason: 'x' })], 1, { text: 'x' }, TODAY)).toBe('The column is retired: nothing more is recorded.');
  });
});

describe('culture media (LIMS-34)', () => {
  const md = item('medium', { lot: 'SCDA-1', sterilisation: 'AC-01 cycle 233', expiry: '2026-12-01' });
  it('LIMS-34 a medium cannot be used until its growth promotion test passed and was checked, and while in date', () => {
    expect(status(md).why).toEqual(['growth promotion not tested']);
    expect(status(md, [e('growth_promotion', { passed: false, organisms: 'S. aureus' })]).why).toEqual(['growth promotion failed on 10 Nov 2026']);
    const g = e('growth_promotion', { passed: true, organisms: 'S. aureus, P. aeruginosa, B. subtilis' });
    expect(status(md, [g]).usable).toBe(false);
    expect(status(md, [g, e('checked', { of: g.id }, 2)]).usable).toBe(true);
    expect(status(item('medium', { ...md.facts, expiry: '2026-11-10' }), [g, e('checked', { of: g.id }, 2)]).why).toEqual(['past its use-by date 10 Nov 2026']);
  });
});

describe('cultures (LIMS-35)', () => {
  it('LIMS-35 a culture is traced to the reference culture; a sub-culture beyond passage 5 is refused', () => {
    const facts = { name: 'S. aureus', organism: 'Staphylococcus aureus', strain: 'ATCC 6538', expiry: '2026-12-15' };
    expect(registerProblems('culture', facts, [], TODAY)).toEqual([]);
    expect(registerProblems('culture', facts, [parent('culture', true, 4)], TODAY)).toEqual([]);
    expect(registerProblems('culture', facts, [parent('culture', true, 5)], TODAY)).toEqual(['P1 is at passage 5: a sub-culture would be passage 6, beyond the limit of 5 from the reference culture.']);
    expect(registerProblems('culture', facts, [parent('reagent')], TODAY)).toEqual(['A culture is sub-cultured from one culture: pick it, or none for the reference culture itself.']);
    expect(status(item('culture', { ...facts, passage: 6 })).why).toEqual(['passage 6 is beyond the limit of 5 from the reference culture']);
    expect(status(item('culture', { ...facts, passage: 5 }))).toMatchObject({ usable: true, passage: 5 });
  });
});

describe('the worksheet item field', () => {
  it('the assay\'s standard fills its potency and basis; the titration\'s VS its factor; the run names a column', () => {
    const assay = findBlock({ id: 'assay', version: 1 })!;
    expect(Object.fromEntries(Object.entries(itemFills(assay)).map(([k, v]) => [k, [v.item.name, v.value]]))).toEqual({ stdPotency: ['std', 'potency'], stdBasis: ['std', 'basis'] });
    const tit = findBlock({ id: 'titration', version: 1 })!;
    expect(Object.fromEntries(Object.entries(itemFills(tit)).map(([k, v]) => [k, [v.item.name, v.value]]))).toEqual({ vsFactor: ['vs', 'factor'], excessFactor: ['excess', 'factor'] });
    expect(findBlock({ id: 'instrument-run', version: 1 })!.fields.find((f) => f.name === 'column')).toMatchObject({ kind: 'item', itemKinds: ['column'] });
    for (const b of [assay, tit]) expect(blockProblems(b)).toEqual([]);
  });
  it('an item field names its kinds, and only an item field does', () => {
    const b = findBlock({ id: 'instrument-run', version: 1 })!;
    expect(blockProblems({ ...b, fields: b.fields.map((f) => (f.name === 'column' ? { ...f, itemKinds: undefined } : f)) })).toEqual(['field column: an item field, and only an item field, names its itemKinds']);
  });
});
