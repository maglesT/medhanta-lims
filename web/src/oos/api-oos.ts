// The OOS server calls and types (server/routes/oos.ts).
import { api } from '../api.js';
import type { OosAction, OosEventKind, OosPayload, OosStatus } from '../../../shared/engine/oos.js';

export interface OosResult { name: string; value: string; unit: string; shown: string; line: string; limit: string; step: string }
export interface OosRow {
  id: number; oosNo: string; sampleId: number; analysisId: number | null; outsideResultId: number | null; testKey: string; result: OosResult; openedBy: number; openedByName: string; openedAt: string;
  sampleNo: string; lotNo: string; purpose: string; item: { of: string; code: string; name: string }; duringBatch?: string | null; analysisNo: string; specNumber: string; specVersionNo: number;
}
export interface OosListRow extends OosRow { status: OosStatus; closedAt: string | null; deviation: string | null }
export interface OosEntry {
  id: number; kind: OosEventKind; payload: OosPayload; person: number; personName: string; at: string;
  signature: { printedName: string; meaning: string; signedAt: string } | null;
}
export interface AnalysisResult { analysisId: number; analysisNo: string; status: string; result: { shown: string; value: string; unit: string; pass?: boolean } | null; method: string }
export interface OosDetail {
  oos: OosRow; status: OosStatus; events: OosEntry[]; checklist: [string, string][];
  plans: { plan: OosEntry; result: OosEntry | null }[]; conclusion: OosEntry | null;
  phase2: { event: OosEntry | null; reference: string; typed: boolean; checked: boolean; filed?: boolean; deviation: { number: string; status: string; title: string | null; closedAt: string | null } | null; link: string } | null;
  deviations: { link: string; list: { number: string; status: string; title: string | null }[] };
  retests: { authorised: number; by: OosEntry | null; analyses: AnalysisResult[] };
  original: AnalysisResult | null;
  test: { name: string; limit: string; method: { masterId: number; code: string; name: string } } | null;
  others: { id: number; sampleNo: string; lotNo: string; purpose: string; registeredAt: string; decision: string | null }[];
  actions: OosAction[]; refusals: Record<OosAction, string | null>; contentHash: string; retestRefusal: string | null;
  retestMethod: { id: number; versionNo: number; code: string; name: string } | null;
}

export const listOos = () => api<OosListRow[]>('GET', '/api/oos');
export const getOos = (id: number) => api<OosDetail>('GET', `/api/oos/${id}`);
export const oosAction = (id: number, action: OosAction, body: object) => api<{ ok: true }>('POST', `/api/oos/${id}/${action}`, body);

export const OOS_CHIP: Record<OosStatus, string> = {
  'phase I': 'chip chip-warn', 'phase I review': 'chip chip-warn', 'QA approval': 'chip chip-warn', 'phase II': 'chip chip-info', confirmed: 'chip chip-bad', invalidated: 'chip chip-draft',
};
export const OOS_LABEL: Record<OosStatus, string> = {
  'phase I': 'Phase I', 'phase I review': 'Phase I review', 'QA approval': 'Waiting for QA', 'phase II': 'Phase II', confirmed: 'OOS confirmed', invalidated: 'Invalidated',
};
