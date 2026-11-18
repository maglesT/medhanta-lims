// The samples' server calls and types (server/routes/samples.ts).
import { api } from '../api.js';
import type { LinkState, SampleAction, SamplePurpose, SampleStatus, Source } from '../../../shared/engine/index.js';
import type { SpecDoc, SpecTest } from '../../../shared/master/spec.js';
import type { ReserveState } from '../../../shared/engine/reserve.js';

export type From = 'mms' | 'truebatch';
export interface SpecChoice { id: number; masterId: number; versionNo: number; number: string; type: string; market: string | null }
export interface SampleRequest {
  source: From; lotNo: string; of: 'material' | 'product'; itemId: string | null; code: string; name: string | null; status: string;
  shown: string; asOf: string | null; stock: string | null; specs: SpecChoice[]; noSpec: string | null; sampleNo: string | null;
}
export interface Requests { links: Record<From, LinkState>; requests: SampleRequest[] }
// A monitoring sample is of a room (master data) or a water system (server/routes/em.ts).
export interface SampleItem { of: 'material' | 'product' | 'room' | 'water'; itemId: string; code: string; name: string }
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
    registeredByName: string; registeredAt: string;
    // A stability sample: its study and time point.
    stability?: { studyId: number; studyNo: string; condition: string; label: string; month: number } | null;
    // An EM or water sample: the plan, point and sampling it was taken for (LIMS-36, LIMS-37).
    monitoring?: { planNumber: string; planVersionNo: number; pointCode: string; pointName: string; kind: string; frequency: string; state: string | null; grade: string | null;
      takenOn: string; shift: number | null; batch: string | null; person: string | null } | null };
  status: SampleStatus; events: SampleEntry[];
  spec: { id: number; versionNo: number; state: string; header: SpecDoc['header']; tests: (SpecTest & { applies: boolean; analyses: TestResult[] })[] } | null;
  methods: { versionId: number; masterId: number; versionNo: number; code: string; name: string }[];
  actions: SampleAction[]; refusals: Record<SampleAction, string | null>; contentHash: string;
  // QC's decision (LIMS-20): made, or what stands in the way of approval for this person.
  decision: 'approved' | 'rejected' | null; decisionHash: string | null; approvalProblems: string[]; rejectionRefusal: string | null;
  // LIMS-23, LIMS-25: the sample's OOS, and the tests whose reviewed result is out of trend with QC's answer.
  oos: { id: number; oosNo: string; testName: string; testKey: string; analysisNo: string; status: 'open' | 'confirmed' | 'invalidated'; detail: string }[];
  oot: { key: string; name: string; analysisNo: string; shown: string; trend: string; answer: SampleEntry | null }[]; ootRefusal: string | null;
  // LIMS-30: a release sample's reserve sample (null: none logged), the specification's reserve quantity, and the decision's word when it names none.
  reserve: { id: number; amount: string; unit: string; location: string; keptUntil: string; state: ReserveState } | null;
  reserveRequired: string | null; reserveNote: string | null;
  // LIMS-08: the containers each identity test is done on (null: once); LIMS-54: the blank worksheets issued for the sample.
  identityContainers: number | null; forms: FormRow[];
}
// LIMS-54: a blank worksheet issued for paper and its state.
export interface FormRow { id: number; formNo: string; sampleId: number; sampleNo: string; methodCode: string; methodName: string; versionNo: number; reason: string;
  issuedByName: string; issuedAt: string; state: 'issued' | 'used' | 'unused' | 'voided'; entry: { kind: string; payload: { outcome?: string; analysisNo?: string; reason?: string }; personName: string; at: string } | null }
// LIMS-22: an outside lab's result, as typed from its report.
export interface OutsideFacts { id: number; lab: string; reportNo: string; fileName: string; size: number; sha256: string; enteredBy: string; enteredAt: string; checkedBy: string | null; checkedAt: string | null }
// A spec test's analysis: its status and, once worked out, its result (pass or fail against the test's limit).
export interface TestResult { analysisId: number; analysisNo: string; status: string; result: { shown: string; value: string; unit: string; pass?: boolean } | null;
  container?: number | null; outside?: OutsideFacts }
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
export const PURPOSE_LABEL: Record<SamplePurpose, string> = { release: 'Release', retest: 'Retest', stability: 'Stability', investigation: 'Investigation', monitoring: 'EM and water' };

export const labelsLink = (id: number) => `/api/samples/${id}/labels`;
export const enterOutside = (id: number, body: object) => api<{ ok: true; sha256: string }>('POST', `/api/samples/${id}/outside`, body);
export const checkOutside = (id: number, rid: number) => api<{ ok: true }>('POST', `/api/samples/${id}/outside/${rid}/check`, {});
export const issueForm = (id: number, body: { masterVersionId: number; reason: string }) => api<{ ok: true; id: number; formNo: string }>('POST', `/api/samples/${id}/forms`, body);
export const listForms = (open = false) => api<FormRow[]>('GET', `/api/forms${open ? '?open=1' : ''}`);
export const formLink = (id: number) => `/api/forms/${id}/pdf`;
export const formEntry = (id: number, action: 'return' | 'void', body: object) => api<{ ok: true }>('POST', `/api/forms/${id}/${action}`, body);
