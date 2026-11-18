// The trends, KPI, workload and APQR server calls and types (server/routes/trends.ts).
import { api } from '../api.js';
import type { Kpis } from '../../../shared/engine/trends.js';

export interface SeriesRow { series: string; kind: 'item' | 'point'; code: string; name: string; testKey: string; testName: string; unit: string; n: number; last: string }
export interface Chart {
  series: string; test: string; testName?: string; unit?: string; item?: { code: string; name: string };
  spec: { number: string; versionNo: number; limit: { low?: string; high?: string; unit: string } | null } | null;
  points: { n: number; sampleId: number; sampleNo: string; lotNo: string; value: string; reported: string | null; shown: string; pass: boolean | null; analysisNo: string; decidedAt: string; decision: string; oos: string | null; oot: string | null }[];
  chart: {
    shown: string; mean: string; sigma: string; sd: string; ucl: string; lcl: string; mrBar: string; mrUcl: string; zones: { plus1: string; plus2: string; minus1: string; minus2: string };
    movingRanges: string[]; mrBreaks: number[]; specLow: string | null; specHigh: string | null; cpk: string | null; ppk: string | null; breaks: { rule: number; text: string; points: number[] }[];
  } | null;
  message: string | null;
}
export interface Target { purpose: string; days: number; setBy: string | null; at: string | null }
export type KpiData = Omit<Kpis, 'backlog'> & { from: string; to: string; today: string; targets: Target[]; backlog: Kpis['backlog'] };
export interface WorkRow {
  sampleId: number; sampleNo: string; purpose: string; lotNo: string; item: { code: string; name: string }; received: string; due: string; overdue: boolean; targetDays: number;
  methodMasterId: number; method: { code: string; name: string; skills: { code: string; title?: string }[] } | null; tests: string[];
  analysis: { id: number; analysisNo: string; status: string; by: string } | null;
  assigned: { analystId: number; analyst: string; by: string; at: string; training: { checked?: string } } | null;
}
export interface Workload { today: string; link: 'ok' | 'absent' | 'down'; rows: WorkRow[]; trained: Record<number, Record<number, string | null>>; analysts: { id: number; name: string; openAnalyses: number; assigned: number }[] }
export interface Mine { sampleId: number; sampleNo: string; item: { code: string; name: string }; lotNo: string; method: { code: string; name: string } | null; tests: string[]; due: string; overdue: boolean;
  analysis: { id: number; analysisNo: string; status: string } | null; by: string; at: string }
export interface ApqrItem { of: 'product' | 'material'; code: string; name: string }
export interface Apqr {
  item: ApqrItem; period: { from: string; to: string };
  lots: { sampleNo: string; lotNo: string; purpose: string; decision: string; decidedAt: string; coaNo: string | null }[];
  failed: { sampleNo: string; lotNo: string }[];
  results: { key: string; name: string; limit: string; unit: string; results: number; failed: number; n: number; min: string | null; max: string | null; mean: string | null; sd: string | null; cpk: string | null; rules: number[] }[];
  oos: { oosNo: string; sampleNo: string; lotNo: string; purpose: string; test: string; shown: string; status: string; deviation: string | null; openedAt: string }[];
  oot: { sampleNo: string; lotNo: string; test: string; analysisNo: string; answer: string; reason: string; at: string }[];
  changes: { kind: string; number: string; name: string; versionNo: number; effectiveAt: string; changeControl: string | null; retiredAt: string | null }[];
  stability: { studyNo: string; lotNo: string; protocol: string; t0: string; lastMonth: number | null; evaluation: string | null }[];
  stabilityResults: { n: number; failed: number };
  em: { point: string; name: string; where: string; grade: string | null; kind: string; n: number; alert: number; action: number }[];
  excursions: { point: string; level: string; shown: string; deviation: string | null; closed: boolean; at: string }[];
}

const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1])).toString();
export const getSeries = () => api<SeriesRow[]>('GET', '/api/trends/series');
export const getChart = (o: { series: string; test: string; unit?: string; from?: string; to?: string }) => api<Chart>('GET', `/api/trends/chart?${qs(o)}`);
export const getKpis = (from?: string, to?: string) => api<KpiData>('GET', `/api/kpis?${qs({ from, to })}`);
export const setTarget = (purpose: string, days: number) => api<{ ok: true }>('POST', '/api/kpis/targets', { purpose, days });
export const getWorkload = () => api<Workload>('GET', '/api/workload');
export const assign = (sampleId: number, methodMasterId: number, analystId: number) => api<{ ok: true; training: { checked: string } }>('POST', '/api/workload/assign', { sampleId, methodMasterId, analystId });
export const getMine = () => api<Mine[]>('GET', '/api/workload/mine', undefined, true);
export const getApqrItems = () => api<ApqrItem[]>('GET', '/api/apqr/items');
export const apqrUrl = (i: { of: string; code: string; from: string; to: string }, format: 'json' | 'csv' | 'pdf') => `/api/apqr?${qs({ of: i.of, code: i.code, from: i.from, to: i.to, format })}`;
export const getApqr = (i: { of: string; code: string; from: string; to: string }) => api<Apqr>('GET', apqrUrl(i, 'json'));
