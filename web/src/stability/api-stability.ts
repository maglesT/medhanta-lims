// The stability server calls and types (server/routes/stability.ts; protocols are master versions, server/routes/masters.ts).
import { api } from '../api.js';
import type { MasterState } from '../../../shared/master/schema.js';
import type { ProtocolDoc } from '../../../shared/master/protocol.js';
import type { ChamberRef, Stock, StudyEvent } from '../../../shared/engine/stability.js';
import type { LinkState, Source } from '../../../shared/engine/links.js';
import type { SampleItem } from '../samples/api-samples.js';

export interface ProtocolRow { id: number; masterId: number; versionNo: number; state: MasterState; header: ProtocolDoc['header']; createdAt: string; createdByName: string }
export interface ProtocolVersion { id: number; masterId: number; versionNo: number; state: MasterState; kind: 'protocol'; doc: ProtocolDoc; createdBy: number; createdAt: string }
export type PointStateWord = 'pulled' | 'due' | 'overdue' | 'not yet';
export interface Point {
  condition: string; label: string; month: number; due: string; from: string; to: string; state: PointStateWord;
  sampleId: number | null; sampleNo: string | null; late: { reason: string; deviation: string; byHand: boolean } | null; refusal?: string | null;
}
export interface StudyListRow {
  id: number; studyNo: string; lotNo: string; item: SampleItem; t0: string; byHand: boolean; protocolNumber: string; protocolVersionNo: number;
  purpose: string; pack: string; next: Point | null; pulled: number; total: number; overdue: number;
}
export type DueRow = Point & { studyId: number; studyNo: string; lotNo: string; item: SampleItem };
export interface Studies { today: string; studies: StudyListRow[]; due: DueRow[] }
export type Entry = StudyEvent & { personName: string; at: string; signature: { printedName: string; signedAt: string } | null };
export interface Mkt { ok: boolean; value?: string; shown?: string; message?: string }
export interface StudyDetail {
  study: { id: number; studyNo: string; protocolVersionId: number; lotNo: string; item: SampleItem; source: Source; cell: string | null; t0: string;
    createdByName: string; createdAt: string; protocolVersionNo: number; protocolState: string };
  protocol: ProtocolDoc; events: Entry[]; today: string; points: Point[]; stock: Stock[];
  tests: { key: string; name: string }[];
  results: { condition: string; label: string; month: number; sampleId: number; sampleNo: string; tests: Record<string, { analysisNo: string; status: string; shown: string | null; pass: boolean | null } | null> }[];
  excursions: { id: number; chamber: ChamberRef; from: string; to: string; deviation: string; range: { min: string; max: string } | null; mkt: Mkt }[];
  toCheck: { entry: number; refusal: string | null }[];
  extras: { entry: number; condition: string; quantity: string; reason: string; personName: string; approved: boolean; refusal: string | null }[];
  contentHash: string;
}
export interface Chamber { itemId: string; code: string; name: string; link: LinkState; fit: boolean | null; why: string | null }
export interface Excursion {
  id: number; chamber: ChamberRef; fromAt: string; toAt: string; readings: { at: string; temperature: string; humidity?: string }[]; deviation: string; deviationSource: Source;
  recordedByName: string; recordedAt: string; range: { min: string; max: string } | null; mkt: Mkt;
  checked: { personName: string; at: string } | null; assessed: { personName: string; at: string; payload: { text?: string } } | null;
  affected: { studyId: number; studyNo: string; condition: string; months: number[] }[]; checkRefusal: string | null; assessRefusal: string | null;
}
export interface Ongoing { year: number; link: LinkState; flags: { productCode: string; productName: string; pack: string | null; released: string[]; studies: string[]; answer: { text: string; by: string } | null; flag: string | null }[] }
export interface Capacity { today: string; years: number[]; rows: { chamber: ChamberRef; condition: string; studies: string[]; now: number; byYear: Record<number, number>; unit: string }[] }

export const listProtocols = () => api<ProtocolRow[]>('GET', '/api/masters?kind=protocol');
export const getProtocol = (id: number) => api<ProtocolVersion>('GET', `/api/master-versions/${id}`);
export const saveProtocol = (id: number, doc: ProtocolDoc) => api<{ ok: true }>('PUT', `/api/master-versions/${id}`, { doc });
export const createProtocol = (doc: ProtocolDoc) => api<{ id: number }>('POST', '/api/masters', { kind: 'protocol', doc });
export const effectiveProtocols = () => api<{ id: number; versionNo: number; doc: ProtocolDoc }[]>('GET', '/api/stability/protocols');
export const batchesFor = (protocol: number) => api<{ from: 'truebatch' | 'mms'; link: LinkState; batches: { number: string; shown: string }[] }>('GET', `/api/stability/batches?protocol=${protocol}`);
export const listChambers = () => api<Chamber[]>('GET', '/api/stability/chambers');
export const startStudy = (b: object) => api<{ id: number; studyNo: string }>('POST', '/api/stability/studies', b);
export const listStudies = () => api<Studies>('GET', '/api/stability/studies');
export const getStudy = (id: number) => api<StudyDetail>('GET', `/api/stability/studies/${id}`);
export const studyAction = (id: number, action: 'pull' | 'extra' | 'approve-extra' | 'check' | 'note', b: object) =>
  api<{ ok: true; sampleId?: number; sampleNo?: string }>('POST', `/api/stability/studies/${id}/${action}`, b);
export const listExcursions = () => api<Excursion[]>('GET', '/api/stability/excursions');
export const recordExcursion = (b: object) => api<{ id: number }>('POST', '/api/stability/excursions', b);
export const excursionAction = (id: number, action: 'check' | 'assess', b: object) => api<{ ok: true }>('POST', `/api/stability/excursions/${id}/${action}`, b);
export const getOngoing = () => api<Ongoing>('GET', '/api/stability/ongoing');
export const answerOngoing = (b: { productCode: string; pack: string; text: string }) => api<{ ok: true }>('POST', '/api/stability/ongoing', b);
export const getCapacity = () => api<Capacity>('GET', '/api/stability/capacity');

export const STATE_WORDS: Record<PointStateWord, string> = { pulled: 'Pulled', due: 'Due', overdue: 'Overdue', 'not yet': 'Not yet' };
export const STATE_CHIPS: Record<PointStateWord, string> = { pulled: 'chip chip-ok', due: 'chip chip-info', overdue: 'chip chip-bad', 'not yet': 'chip chip-draft' };
