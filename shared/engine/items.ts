/**
 * The lab inventory (LIMS-12, LIMS-13, LIMS-14, LIMS-34, LIMS-35), the Logbook way: an item is a row (what it is, its
 * facts as received or prepared) and insert-only entries; "may this item be used now, and if not, why" is computed here
 * from the entries, never stored. The worksheet's 'item' field offers only usable items, and the values an analysis
 * needs (a standard's potency and basis, a volumetric solution's factor) come with the item, never typed.
 */
import type { Block, BlockField } from '../blocks/format.js';

// animal (LIMS-39): a lab animal where a site uses them: identified, kept suitable (blocked when not), its health checks
// and uses written as entries.
export const ITEM_KINDS = ['reference', 'working', 'reagent', 'solution', 'vs', 'column', 'medium', 'culture', 'animal'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_NAME: Record<ItemKind, string> = {
  reference: 'Reference standard', working: 'Working standard', reagent: 'Reagent', solution: 'Prepared or test solution', vs: 'Volumetric solution',
  column: 'Column', medium: 'Culture medium', culture: 'Culture', animal: 'Lab animal',
};
/** The number of an item: its kind's prefix, the plant year and a counter per kind and year (RS260001). */
export const ITEM_PREFIX: Record<ItemKind, string> = { reference: 'RS', working: 'WS', reagent: 'RG', solution: 'SO', vs: 'VS', column: 'CO', medium: 'MD', culture: 'CU', animal: 'AN' };
export const BASES = ['as is', 'dried', 'anhydrous'] as const;
/** Ph. Eur. 5.1.4 / USP <61>: a test culture is not more than 5 passages from the reference culture. */
export const MAX_PASSAGE = 5;

/** What is recorded when an item is registered (received or prepared); which facts a kind needs: KIND_FACTS. */
export interface ItemFacts {
  name: string;
  storage?: string;
  // reference standard: who issued it (USP, Ph. Eur., IP, BP, in-house primary).
  source?: string;
  lot?: string;
  supplier?: string;
  // reference standard: from its certificate (working standard: from its qualification entry).
  potency?: string;
  basis?: (typeof BASES)[number];
  expiry?: string;
  retestOn?: string;
  // reagent: the days it may be used after opening.
  useDays?: number;
  // a prepared item: the procedure (SOP or method) it was made by.
  procedure?: string;
  // volumetric solution: its stated molarity (e.g. "0.1 M").
  molarity?: string;
  // column
  serial?: string;
  columnType?: string;
  // culture medium
  sterilisation?: string;
  // culture: organism and strain (e.g. ATCC 6538); its passage is worked out from its parent (0: the reference culture).
  organism?: string;
  strain?: string;
  passage?: number;
  // lab animal: its own identification (ear tag, tattoo); the species and strain are its organism and strain.
  tag?: string;
}
export type FactName = Exclude<keyof ItemFacts, 'name' | 'passage'>;
/** The facts asked for at registration, per kind: required, or optional (?). */
export const KIND_FACTS: Record<ItemKind, { need: FactName[]; may: FactName[]; parents: 'none' | 'one' | 'any' | 'culture' }> = {
  reference: { need: ['source', 'lot', 'potency', 'basis'], may: ['expiry', 'retestOn', 'storage'], parents: 'none' },
  working: { need: ['lot'], may: ['expiry', 'storage'], parents: 'one' },
  reagent: { need: ['supplier', 'lot', 'expiry'], may: ['useDays', 'storage'], parents: 'none' },
  solution: { need: ['procedure', 'expiry'], may: ['storage'], parents: 'any' },
  vs: { need: ['molarity', 'procedure', 'expiry'], may: ['storage'], parents: 'any' },
  column: { need: ['columnType', 'serial'], may: ['supplier'], parents: 'none' },
  medium: { need: ['lot', 'sterilisation', 'expiry'], may: ['supplier', 'storage'], parents: 'none' },
  culture: { need: ['organism', 'strain', 'expiry'], may: ['storage'], parents: 'culture' },
  animal: { need: ['organism', 'tag', 'supplier'], may: ['strain', 'storage'], parents: 'none' },
};
export const FACT_LABEL: Record<FactName, string> = {
  storage: 'Storage', source: 'Issued by (pharmacopoeia or primary source)', lot: 'Lot or batch', supplier: 'Supplier', potency: 'Potency (%)', basis: 'Basis of the potency',
  expiry: 'Expiry or use-by date', retestOn: 'Retest date', useDays: 'Use period after opening (days)', procedure: 'Prepared by procedure (SOP or method)',
  molarity: 'Stated molarity', serial: 'Serial number', columnType: 'Column (type and dimensions)', sterilisation: 'Sterilisation (autoclave cycle)',
  organism: 'Organism', strain: 'Strain (reference culture collection number)', tag: 'Animal identification (ear tag or tattoo)',
};

export const ITEM_EVENT_KINDS = ['opened', 'standardised', 'qualified', 'growth_promotion', 'checked', 'retest', 'blocked', 'unblocked', 'disposed', 'note'] as const;
export type ItemEventKind = (typeof ITEM_EVENT_KINDS)[number];
export interface ItemPayload {
  // standardised (VS): factor and next standardisation; qualified (working standard): potency, basis, next re-qualification.
  factor?: string; potency?: string; basis?: (typeof BASES)[number]; nextDue?: string; against?: string;
  // growth promotion (medium)
  passed?: boolean; organisms?: string;
  // checked: the entry checked by a second person
  of?: number;
  retestOn?: string; reason?: string; text?: string;
}
// day: the plant date of the entry (YYYY-MM-DD).
export interface ItemEvent { id: number; kind: ItemEventKind; payload: ItemPayload; person: number; day: string }
export interface Item { kind: ItemKind; facts: ItemFacts; registeredBy: number; day: string }

/** The entries each kind takes (besides block, unblock, dispose and note), and the action that adds them. */
export const ITEM_ACTIONS = {
  open: 'opened', standardise: 'standardised', qualify: 'qualified', 'growth-promotion': 'growth_promotion', check: 'checked', retest: 'retest',
  block: 'blocked', unblock: 'unblocked', dispose: 'disposed', note: 'note',
} as const satisfies Record<string, ItemEventKind>;
export type ItemAction = keyof typeof ITEM_ACTIONS;
export const ITEM_ACTION_NAMES = Object.keys(ITEM_ACTIONS) as ItemAction[];
const KIND_ACTIONS: Partial<Record<ItemAction, ItemKind[]>> = {
  open: ['reagent'], standardise: ['vs'], qualify: ['working'], 'growth-promotion': ['medium'], check: ['vs', 'working', 'medium'], retest: ['reference'],
};
/** The entries that need a second person's check before their values are used. */
const CHECKED: ItemEventKind[] = ['standardised', 'qualified', 'growth_promotion'];
/** The second-person checks need the review permission; every other entry the analyst's. */
export const CHECK_ACTIONS: ItemAction[] = ['check'];

/** The values an item gives a worksheet (filled into the block's fields named after the item field: std → stdPotency). */
export interface ItemValues { potency?: string; basis?: (typeof BASES)[number]; factor?: string }
export interface ItemStatus { usable: boolean; why: string[]; values: ItemValues; due: string | null; passage?: number }

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const last = (events: readonly ItemEvent[], kinds: readonly ItemEventKind[]) => events.filter((e) => kinds.includes(e.kind)).at(-1);
const checkedBy = (events: readonly ItemEvent[], e: ItemEvent) => events.find((x) => x.kind === 'checked' && x.payload.of === e.id);
// The latest entry of a kind that needs a check, and whether a second person has checked it.
function current(events: readonly ItemEvent[], kind: ItemEventKind) {
  const e = last(events, [kind]);
  return e ? { e, checked: !!checkedBy(events, e) } : null;
}
/** A date in words for the reasons (31 Dec 2026). */
export const dayWords = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/\bSept\b/, 'Sep');

/**
 * May the item be used today (the plant date), and if not, why (every reason, in plain words); with the values it
 * gives an analysis and the date its use ends (expiry, retest, use after opening, next standardisation or
 * qualification), whichever is first.
 */
export function itemStatus(item: Item, events: readonly ItemEvent[], today: string): ItemStatus {
  const f = item.facts;
  const why: string[] = [];
  const values: ItemValues = {};
  const dues: string[] = [];
  const disposed = last(events, ['disposed']);
  if (disposed) return { usable: false, why: [item.kind === 'column' ? `retired on ${dayWords(disposed.day)}` : `disposed of on ${dayWords(disposed.day)}`], values, due: null };
  const block = last(events, ['blocked', 'unblocked']);
  if (block?.kind === 'blocked') why.push(`blocked: ${block.payload.reason ?? ''}`.trim());
  const due = (day: string | undefined, words: string) => { if (!day) return; dues.push(day); if (day < today) why.push(`${words} ${dayWords(day)}`); };
  due(f.expiry, item.kind === 'reagent' || item.kind === 'reference' ? 'expired on' : 'past its use-by date');
  switch (item.kind) {
    case 'reference': {
      due(last(events, ['retest'])?.payload.retestOn ?? f.retestOn, 'past its retest date');
      values.potency = f.potency;
      values.basis = f.basis;
      break;
    }
    case 'reagent': {
      const opened = events.find((e) => e.kind === 'opened');
      if (opened && f.useDays) due(addDays(opened.day, f.useDays), `its use period after opening (${f.useDays} days) ended on`);
      break;
    }
    case 'working': {
      const q = current(events, 'qualified');
      if (!q) why.push('not qualified against its primary standard');
      else if (!q.checked) why.push(`its qualification of ${dayWords(q.e.day)} waits for a second person's check`);
      else { values.potency = q.e.payload.potency; values.basis = q.e.payload.basis; }
      if (q?.checked) due(q.e.payload.nextDue, 're-qualification was due on');
      break;
    }
    case 'vs': {
      const s = current(events, 'standardised');
      if (!s) why.push('not standardised');
      else if (!s.checked) why.push(`its standardisation of ${dayWords(s.e.day)} waits for a second person's check`);
      else { values.factor = s.e.payload.factor; due(s.e.payload.nextDue, 'standardisation overdue since'); }
      break;
    }
    case 'medium': {
      const g = current(events, 'growth_promotion');
      if (!g) why.push('growth promotion not tested');
      else if (!g.e.payload.passed) why.push(`growth promotion failed on ${dayWords(g.e.day)}`);
      else if (!g.checked) why.push(`its growth promotion test of ${dayWords(g.e.day)} waits for a second person's check`);
      break;
    }
    case 'culture':
      if ((f.passage ?? 0) > MAX_PASSAGE) why.push(`passage ${f.passage} is beyond the limit of ${MAX_PASSAGE} from the reference culture`);
      break;
    case 'solution':
    case 'column':
    case 'animal':
      break;
  }
  return { usable: why.length === 0, why, values, due: dues.sort()[0] ?? null, ...(item.kind === 'culture' ? { passage: f.passage ?? 0 } : {}) };
}
/** "RS260001 Paracetamol RS cannot be used: expired on 1 Nov 2026." */
export const unusableText = (no: string, name: string, s: ItemStatus) => `${no} ${name} cannot be used: ${s.why.join('; ')}.`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: string | undefined) => !!v && DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const percent = (v: string | undefined) => !!v && /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) > 0 && Number(v) <= 100;
// A VS factor is near 1 (safety rule S5 of the titration template: a molarity typed as a factor is refused).
const factorOk = (v: string | undefined) => !!v && /^\d\.\d{3,4}$/.test(v) && Number(v) >= 0.9 && Number(v) <= 1.1;

/** A parent item at registration: its kind, number, whether it is usable now, and (a culture) its passage. */
export interface Parent { kind: ItemKind; itemNo: string; name: string; status: ItemStatus }

/**
 * Why an item cannot be registered (plain words, all at once): its kind's facts, dates in date, and its parents: a working
 * standard is qualified against one usable reference standard (LIMS-14), a solution or VS is made from usable items only
 * (LIMS-13), a culture comes from the reference culture or a usable culture within the passage limit (LIMS-35).
 */
export function registerProblems(kind: ItemKind, facts: ItemFacts, parents: readonly Parent[], today: string): string[] {
  const p: string[] = [];
  const rule = KIND_FACTS[kind];
  if (!facts.name?.trim()) p.push('Give the name of the item.');
  for (const n of rule.need) if (facts[n] === undefined || facts[n] === '') p.push(`${FACT_LABEL[n]}: please give it.`);
  for (const n of ['expiry', 'retestOn'] as const) {
    if (facts[n] === undefined) continue;
    if (!isDate(facts[n])) p.push(`${FACT_LABEL[n]}: give a date, e.g. 2027-03-31.`);
    else if (facts[n]! < today) p.push(`${FACT_LABEL[n]}: ${dayWords(facts[n]!)} is already past; it cannot be registered for use.`);
  }
  if (kind === 'reference' && !facts.expiry && !facts.retestOn) p.push('Give the expiry or the retest date from the certificate.');
  if (facts.potency !== undefined && !percent(facts.potency)) p.push('Potency: a percentage above 0 and up to 100, e.g. 99.6.');
  if (facts.basis !== undefined && !BASES.includes(facts.basis)) p.push(`Basis of the potency: one of ${BASES.join(', ')}.`);
  if (facts.useDays !== undefined && (!Number.isInteger(facts.useDays) || facts.useDays < 1 || facts.useDays > 3650)) p.push('Use period after opening: a whole number of days, 1 or more.');
  if (facts.molarity !== undefined && !/^\d+(\.\d+)?\s*(M|N|mol\/L)$/.test(facts.molarity)) p.push('Stated molarity: e.g. 0.1 M.');
  for (const n of Object.keys(facts) as (keyof ItemFacts)[]) {
    if (n === 'name' || n === 'passage') continue;
    if (!rule.need.includes(n) && !rule.may.includes(n)) p.push(`${FACT_LABEL[n]} is not recorded for a ${ITEM_KIND_NAME[kind].toLowerCase()}.`);
  }
  const unusable = parents.filter((x) => !x.status.usable);
  switch (rule.parents) {
    case 'none':
      if (parents.length) p.push(`A ${ITEM_KIND_NAME[kind].toLowerCase()} is not made from other items.`);
      break;
    case 'one':
      if (parents.length !== 1 || parents[0]!.kind !== 'reference') p.push('A working standard is qualified against one primary (reference) standard: pick it.');
      break;
    case 'culture':
      if (parents.length > 1 || parents.some((x) => x.kind !== 'culture')) p.push('A culture is sub-cultured from one culture: pick it, or none for the reference culture itself.');
      else if (parents[0] && (parents[0].status.passage ?? 0) + 1 > MAX_PASSAGE) {
        p.push(`${parents[0].itemNo} is at passage ${parents[0].status.passage}: a sub-culture would be passage ${(parents[0].status.passage ?? 0) + 1}, beyond the limit of ${MAX_PASSAGE} from the reference culture.`);
      }
      break;
    case 'any':
      break;
  }
  for (const x of unusable) p.push(unusableText(x.itemNo, x.name, x.status).replace('cannot be used', 'cannot be used to make it'));
  return p;
}

/** Why this person may not add this entry to the item now (plain words); null when they may. */
export function itemRefusal(action: ItemAction, item: Item, events: readonly ItemEvent[], person: number, payload: ItemPayload, today: string, primary?: Parent): string | null {
  const name = ITEM_KIND_NAME[item.kind].toLowerCase();
  if (events.some((e) => e.kind === 'disposed')) return item.kind === 'column' ? 'The column is retired: nothing more is recorded.' : 'The item is disposed of: nothing more is recorded.';
  const only = KIND_ACTIONS[action];
  if (only && !only.includes(item.kind)) return `A ${name} has no such entry.`;
  const future = (d: string | undefined, label: string) => (!isDate(d) ? `${label}: give a date, e.g. 2027-03-31.` : d! <= today ? `${label}: give a date after today.` : null);
  switch (action) {
    case 'open':
      return events.some((e) => e.kind === 'opened') ? `The ${name} is already opened.` : null;
    case 'standardise':
      if (!factorOk(payload.factor)) return 'Factor: a number near 1 with 3 or 4 decimals, between 0.900 and 1.100 (e.g. 1.0023); outside, prepare the solution again.';
      return future(payload.nextDue, 'Next standardisation due');
    case 'qualify':
      // LIMS-14: qualified against its primary standard, which must be usable at the time.
      if (primary && !primary.status.usable) return unusableText(primary.itemNo, primary.name, primary.status).replace('cannot be used', 'cannot be used to qualify against');
      if (!percent(payload.potency)) return 'Potency assigned: a percentage above 0 and up to 100, e.g. 99.4.';
      if (!payload.basis || !BASES.includes(payload.basis)) return `Basis of the potency: one of ${BASES.join(', ')}.`;
      return future(payload.nextDue, 'Re-qualification due');
    case 'growth-promotion':
      return typeof payload.passed !== 'boolean' || !payload.organisms?.trim() ? 'Say whether growth promotion passed, and with which organisms.' : null;
    case 'check': {
      const open = events.filter((e) => CHECKED.includes(e.kind)).at(-1);
      if (!open || checkedBy(events, open)) return 'There is no entry waiting for a second person\'s check.';
      if (payload.of !== undefined && payload.of !== open.id) return 'Only the latest entry is checked.';
      if (open.person === person) return 'The person who recorded the entry cannot check it: a second person checks it.';
      return null;
    }
    case 'retest':
      return future(payload.retestOn, 'New retest date');
    case 'block':
      return last(events, ['blocked', 'unblocked'])?.kind === 'blocked' ? `The ${name} is already blocked.` : null;
    case 'unblock':
      return last(events, ['blocked', 'unblocked'])?.kind !== 'blocked' ? `The ${name} is not blocked.` : null;
    case 'dispose':
    case 'note':
      return null;
  }
}
/** The entry waiting for a second person's check, if any. */
export const waitingCheck = (events: readonly ItemEvent[]) => {
  const open = events.filter((e) => CHECKED.includes(e.kind)).at(-1);
  return open && !checkedBy(events, open) ? open : null;
};

// ---- the worksheet's 'item' field ----
/** The values an item field gives: a field named "std" fills "stdPotency", "stdBasis" (and "stdFactor") of its block. */
const FILLS: [keyof ItemValues, string][] = [['potency', 'Potency'], ['basis', 'Basis'], ['factor', 'Factor']];
export function itemFills(block: Block): Record<string, { item: BlockField; value: keyof ItemValues }> {
  const out: Record<string, { item: BlockField; value: keyof ItemValues }> = {};
  for (const f of block.fields.filter((x) => x.kind === 'item')) {
    for (const [value, suffix] of FILLS) if (block.fields.some((x) => x.name === `${f.name}${suffix}`)) out[`${f.name}${suffix}`] = { item: f, value };
  }
  return out;
}
/** The item value of a picked lab item: its id as "lab:<id>", so it never meets a master-data id. */
export const labItemId = (id: number) => `lab:${id}`;
export const parseLabItemId = (v: string) => (/^lab:[1-9]\d{0,15}$/.test(v) ? Number(v.slice(4)) : null);
