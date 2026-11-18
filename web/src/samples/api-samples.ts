// The samples' server calls and types (server/routes/samples.ts).
import { api } from '../api.js';
import type { LinkState, SampleAction, SamplePurpose, SampleStatus, Source } from '../../../shared/engine/index.js';
import type { SpecDoc, SpecTest } from '../../../shared/master/spec.js';

export type From = 'mms' | 'truebatch';
export interface SpecChoice { id: number; masterId: number; versionNo: number; number: string; type: string; market: string | null }
export interface SampleRequest {
  source: From; lotNo: string; of: 'material' | 'product'; itemId: string | null; code: string; name: string | null; status: string;
  shown: string; asOf: string | null; stock: string | null; specs: SpecChoice[]; noSpec: string | null; sampleNo: string | null;
}
export interface Requests { links: Record<From, LinkState>; requests: SampleRequest[] }
export interface SampleItem { of: 'material' | 'product'; itemId: string; code: string; name: string }
export interface SampleListRow {
  id: number; sampleNo: string; purpose: SamplePurpose; lotNo: string; item: SampleItem; byHand: boolean; quantity: string; containers: number | null;
  registeredByName: string; registeredAt: string; specNumber: string; specVersionNo: number; status: SampleStatus;
}
export interface SampleEntry {
  id: number; kind: 'checked' | 'received' | 'stored' | 'handed_over' | 'disposed' | 'note' | 'approved' | 'rejected' | 'oot_answered'; personName: string; at: string;
  payload: { condition?: string; where?: string; to?: string; reason?: string; method?: string; text?: string; coaNo?: string; test?: string; analysisNo?: string; answer?: string };
  signature: { printedName: string; signedAt: string } | null;
}
export interface SampleDetail {
  sample: { id: number; sampleNo: string; purpose: SamplePurpose; lotNo: string; item: SampleItem; source: Source; quantity: string; containers: number | null;
    registeredByName: string; registeredAt: string };
  status: SampleStatus; events: SampleEntry[];
  spec: { id: number; versionNo: number; state: string; header: SpecDoc['header']; tests: (SpecTest & { applies: boolean; analyses: TestResult[] })[] } | null;
  methods: { versionId: number; masterId: number; versionNo: number; code: string; name: string }[];
  actions: SampleAction[]; refusals: Record<SampleAction, string | null>; contentHash: string;
  // QC's decision (LIMS-20): made, or what stands in the way of approval for this person.
  decision: 'approved' | 'rejected' | null; decisionHash: string | null; approvalProblems: string[]; rejectionRefusal: string | null;
  // LIMS-23, LIMS-25: the sample's OOS, and the tests whose reviewed result is out of trend with QC's answer.
  oos: { id: number; oosNo: string; testName: string; testKey: string; analysisNo: string; status: 'open' | 'confirmed' | 'invalidated'; detail: string }[];
  oot: { key: string; name: string; analysisNo: string; shown: string; trend: string; answer: SampleEntry | null }[]; ootRefusal: string | null;
}
// A spec test's analysis: its status and, once worked out, its result (pass or fail against the test's limit).
export interface TestResult { analysisId: number; analysisNo: string; status: string; result: { shown: string; value: string; unit: string; pass?: boolean } | null }
export interface RegisterInput {
  source: From; lotNumber?: string; batchNumber?: string; byHand?: boolean; itemId?: string; specVersionId: number;
  quantity: string; containers?: number; purpose: SamplePurpose;
}

export const sampleRequests = () => api<Requests>('GET', '/api/sample-requests');
export const listSamples = () => api<SampleListRow[]>('GET', '/api/samples');
export const getSample = (id: number) => api<SampleDetail>('GET', `/api/samples/${id}`);
export const specsFor = (of: 'material' | 'product', itemId: string) => api<SpecChoice[]>('GET', `/api/sample-specs?of=${of}&itemId=${encodeURIComponent(itemId)}`);
export const registerSample = (b: RegisterInput) => api<{ id: number; sampleNo: string }>('POST', '/api/samples', b);
export const decide = (id: number, decision: 'approve' | 'reject', body: object) => api<{ ok: true; coaNo?: string }>('POST', `/api/samples/${id}/${decision}`, body);
export const answerOot = (id: number, body: { test: string; answer: 'no action' | 'investigation'; reason: string }) => api<{ ok: true }>('POST', `/api/samples/${id}/oot`, body);
export const coaLink = (id: number) => `/api/samples/${id}/coa`;
export const sampleEntry = (id: number, action: SampleAction, body: object) => api<{ ok: true }>('POST', `/api/samples/${id}/${action}`, body);

export const STATUS_CHIP: Record<SampleStatus, string> = {
  'waiting for check': 'chip chip-warn', registered: 'chip chip-info', received: 'chip chip-info', stored: 'chip chip-ok', 'handed over': 'chip chip-ok',
  disposed: 'chip chip-draft', approved: 'chip chip-ok', rejected: 'chip chip-bad',
};
export const STATUS_LABEL: Record<SampleStatus, string> = {
  'waiting for check': 'Waiting for check', registered: 'Registered', received: 'Received', stored: 'Stored', 'handed over': 'Handed over',
  disposed: 'Disposed of', approved: 'Approved', rejected: 'Rejected',
};
export const PURPOSE_LABEL: Record<SamplePurpose, string> = { release: 'Release', retest: 'Retest', stability: 'Stability', investigation: 'Investigation' };
