// The lab inventory's server calls and types (server/routes/inventory.ts).
import { api } from '../api.js';
import type { ItemAction, ItemEventKind, ItemFacts, ItemKind, ItemPayload, ItemStatus } from '../../../shared/engine/items.js';

export interface ItemRow {
  id: number; itemNo: string; kind: ItemKind; name: string; facts: ItemFacts; parentIds: number[]; registeredByName: string; registeredAt: string;
  status: ItemStatus; waitingCheck: boolean;
}
export interface ItemEntry { id: number; kind: ItemEventKind; payload: ItemPayload; person: number; personName: string; at: string; day: string }
export interface ItemDetail {
  item: Omit<ItemRow, 'status' | 'waitingCheck'>; status: ItemStatus; events: ItemEntry[]; waitingCheck: ItemEntry | null;
  parents: { id: number; itemNo: string; kind: ItemKind; name: string; status: ItemStatus }[];
  children: { id: number; itemNo: string; kind: ItemKind; name: string }[];
  uses: { analysisId: number; analysisNo: string; sampleNo: string | null; method: string; where: string; at: string; personName: string | null }[];
  actions: ItemAction[]; refusals: Record<ItemAction, string | null>;
}

export const listItems = () => api<ItemRow[]>('GET', '/api/inventory');
export const getItem = (id: number) => api<ItemDetail>('GET', `/api/inventory/${id}`);
export const registerItem = (b: { kind: ItemKind; facts: Partial<ItemFacts>; parentIds: number[] }) => api<{ id: number; itemNo: string }>('POST', '/api/inventory', b);
export const itemEntry = (id: number, action: ItemAction, body: object) => api<{ ok: true }>('POST', `/api/inventory/${id}/${action}`, body);

/** The status chip: usable, or the first reason. */
export const statusChip = (s: ItemStatus) => (s.usable ? 'chip chip-ok' : 'chip chip-bad');
export const statusWords = (s: ItemStatus) => (s.usable ? 'Usable' : `Not usable: ${s.why.join('; ')}`);
