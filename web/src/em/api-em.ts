// The EM and water server calls and types (server/routes/em.ts; plans are master versions, server/routes/masters.ts).
import { api } from '../api.js';
import type { MasterState } from '../../../shared/master/schema.js';
import type { MonitoringDoc } from '../../../shared/master/monitoring.js';
import type { DueState, ExcursionEvent, ExcursionStatus, Level } from '../../../shared/engine/monitoring.js';
import type { LinkState } from '../../../shared/engine/links.js';

export interface PlanRow { id: number; masterId: number; versionNo: number; state: MasterState; header: MonitoringDoc['header']; createdAt: string; createdByName: string }
export interface PlanVersion { id: number; masterId: number; versionNo: number; state: MasterState; kind: 'monitoring'; doc: MonitoringDoc; createdBy: number; createdAt: string }
interface SamplingInfo {
  planVersionId: number; planNumber: string; planVersionNo: number; point: string; code: string; name: string; where: string; of: 'room' | 'water'; grade: string | null;
  critical: boolean; sampling: string; kind: string; state: string | null; frequency: string; quantity: string; person: boolean;
  spec: { number: string; testName: string; limit: string } | null; last: { sampleId: number; sampleNo: string; on: string } | null;
}
export type DueRow = SamplingInfo & { period: { key: string; from: string; to: string }; needed: number; taken: number; due: DueState; missed: string | null; shifts: number; shiftsTaken: number[] };
export interface Due { today: string; due: DueRow[]; perBatch: SamplingInfo[]; plans: { id: number; masterId: number; versionNo: number; number: string; name: string; since: string; points: number }[] }
export interface Result { analysisNo: string; value: string; unit: string; shown: string; level: Level; why: string; growth: boolean }
export interface MapGroup {
  key: string; of: 'room' | 'water'; code: string; name: string; grade: string | null;
  points: { planMasterId: number; planNumber: string; key: string; code: string; name: string; critical: boolean;
    samplings: { key: string; kind: string; state: string | null; frequency: string; limit: string; results: { sampleId: number; sampleNo: string; on: string; shift: number | null; result: Result | null }[];
      latest: { sampleId: number; sampleNo: string; on: string; result: Result | null } | null }[] }[];
}
export interface ExcursionRow {
  id: number; origin: 'result' | 'import'; sampleId: number | null; sampleNo: string | null; importId: number | null; level: 'alert' | 'action';
  point: { code: string; name: string; of: 'room' | 'water'; where: string; grade: string | null; kind?: string; state?: string | null; identify?: string };
  result: { shown: string; value?: string; unit?: string; limit?: string; growth?: boolean; analysisNo?: string; why?: string };
  recordedByName: string; recordedAt: string; status: ExcursionStatus; deviation?: string | null;
}
export interface Pending { sampleId: number; sampleNo: string; on: string; point: { code: string; name: string; where: string }; kind: string; state: string | null; level: Level; shown: string; why: string; analysisNo: string }
export interface Excursions { pending: Pending[]; mayOpen: boolean; excursions: ExcursionRow[] }
export type Entry = ExcursionEvent & { personName: string; at: string };
export interface ExcursionDetail {
  excursion: ExcursionRow; events: Entry[];
  deviation: { number: string; byHand: boolean; link: LinkState; shown: string | null; closed: boolean | null } | null;
  deviations: { link: LinkState; list: { number: string; status: string; title: string | null }[] };
  refusals: Record<'confirm' | 'deviation' | 'check' | 'isolate' | 'close', string | null>;
  methods: { masterId: number; code: string; name: string }[];
}
export interface Imports { layouts: Record<'particle' | 'water', { name: string; header: string[] }>; imports: { id: number; kind: 'particle' | 'water'; fileName: string; size: number; sha256: string;
  reportDate: string; rows: { where: string; channel?: string; values: Record<string, string>; alarm: string | null }[]; importedByName: string; importedAt: string; alarms: number }[] }

export const LEVEL_CHIP: Record<Level, string> = { none: 'chip chip-ok', alert: 'chip chip-warn', action: 'chip chip-bad' };
export const LEVEL_WORDS: Record<Level, string> = { none: 'Within limits', alert: 'Alert', action: 'Action' };
export const STATUS_CHIP: Record<ExcursionStatus, string> = {
  'to confirm': 'chip chip-warn', 'investigation to open': 'chip chip-bad', 'deviation to check': 'chip chip-warn', 'isolates to identify': 'chip chip-warn',
  open: 'chip chip-info', 'trend watch': 'chip chip-warn', closed: 'chip chip-ok',
};
export const DUE_CHIP: Record<DueState, string> = { done: 'chip chip-ok', due: 'chip chip-info', overdue: 'chip chip-bad' };

export const listPlans = () => api<PlanRow[]>('GET', '/api/masters?kind=monitoring');
export const getPlan = (id: number) => api<PlanVersion>('GET', `/api/master-versions/${id}`);
export const savePlan = (id: number, doc: MonitoringDoc) => api<{ ok: true }>('PUT', `/api/master-versions/${id}`, { doc });
export const createPlan = (doc: MonitoringDoc) => api<{ id: number }>('POST', '/api/masters', { kind: 'monitoring', doc });
export const getDue = () => api<Due>('GET', '/api/em/due');
export const emBatches = () => api<{ link: string; batches: { batchNumber: string; productCode: string | null; status: string; edition: string }[] }>('GET', '/api/em/batches');
export const take = (b: object) => api<{ ok: true; sampleId: number; sampleNo: string; byHand: boolean }>('POST', '/api/em/take', b);
export const getMap = (point?: string) => api<{ groups: MapGroup[] }>('GET', `/api/em/map${point ? `?point=${encodeURIComponent(point)}&n=20` : ''}`);
export const listExcursions = () => api<Excursions>('GET', '/api/em/excursions');
export const openExcursion = (b: object) => api<{ id: number }>('POST', '/api/em/excursions', b);
export const getExcursion = (id: number) => api<ExcursionDetail>('GET', `/api/em/excursions/${id}`);
export const excursionAction = (id: number, action: 'confirm' | 'deviation' | 'check' | 'isolate' | 'close' | 'note', b: object) => api<{ ok: true }>('POST', `/api/em/excursions/${id}/${action}`, b);
export const listImports = () => api<Imports>('GET', '/api/em/imports');
export const importReport = (b: object) => api<{ id: number; sha256: string; date: string; rows: number; alarms: number }>('POST', '/api/em/imports', b);
