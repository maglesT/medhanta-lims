// Reserve samples and the retest-due list: server calls and types (server/routes/reserve.ts).
import { api } from '../api.js';
import type { LinkState } from '../../../shared/engine/links.js';
import type { Finding, KeepRule, Qty, ReserveAction, ReserveEventKind, ReserveState, ReserveStatusName } from '../../../shared/engine/reserve.js';
import type { SampleItem, SampleRequest } from './api-samples.js';

export interface ReserveRow {
  id: number; sampleId: number; sampleNo: string; lotNo: string; item: SampleItem; specNumber: string; specVersionNo: number; reserveQuantity: string | null;
  amount: string; unit: string; location: string; rule: KeepRule; fromDate: string; keptUntil: string; loggedByName: string; loggedAt: string;
}
export interface ReserveEntry { id: number; kind: ReserveEventKind; personName: string; at: string; payload: { finding?: Finding; amount?: string; reason?: string; of?: number; text?: string } }
export interface ReserveDetail {
  reserve: ReserveRow; required: Qty | null; state: ReserveState; events: ReserveEntry[]; waitingCheck: ReserveEntry | null;
  actions: ReserveAction[]; refusals: Record<ReserveAction, string | null>;
}
export interface RetestRow extends SampleRequest { retestDate: string; past: boolean; sampleId: number | null; lastRetest: { sampleNo: string; decision: string } | null }
export interface RetestDue { link: LinkState; days: number; until: string; rows: RetestRow[]; pastWithout: string[] }
export interface LogInput { quantity: string; location: string; rule: KeepRule; fromDate: string; keptUntil: string }

export const listReserves = () => api<(ReserveRow & { state: ReserveState; waitingCheck: boolean })[]>('GET', '/api/reserves');
export const getReserve = (id: number) => api<ReserveDetail>('GET', `/api/reserves/${id}`);
export const logReserve = (sampleId: number, b: LogInput) => api<{ id: number }>('POST', `/api/samples/${sampleId}/reserve`, b);
export const reserveEntry = (id: number, action: ReserveAction, body: object) => api<{ ok: true }>('POST', `/api/reserves/${id}/${action}`, body);
export const retestDue = (days: number) => api<RetestDue>('GET', `/api/retest-due?days=${days}`);

export const RESERVE_CHIP: Record<ReserveStatusName, string> = {
  kept: 'chip chip-ok', 'visual inspection overdue': 'chip chip-warn', 'below the required quantity': 'chip chip-bad', destroyed: 'chip chip-draft',
};
export const reserveLabel = (s: ReserveStatusName) => s[0]!.toUpperCase() + s.slice(1);
