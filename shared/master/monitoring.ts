/**
 * A monitoring plan version is ONE JSON document (LIMS-36, LIMS-37): the environmental monitoring and water sampling
 * points, each in a room of master data (with its grade A/B/C/D as read) or on a water system (purified water, water for
 * injections), what is sampled there (settle plate, contact plate, active air, glove print, personnel; TOC,
 * conductivity, micro, endotoxin), how often, in which state (at rest, in operation), and the specification test whose
 * alert and action limits apply (its method is the test's). It is kept, reviewed and approved exactly as a method,
 * specification or stability protocol version (the same table, kind 'monitoring').
 */
import { z } from 'zod';
import { keySchema, type Limit } from './schema.js';
import type { Problem } from './checks.js';
import { limitWords, type SpecDoc } from './spec.js';

const text = (max = 200) => z.string().trim().max(max);

export const EM_KINDS = ['settle plate', 'contact plate', 'active air', 'glove print', 'personnel'] as const;
export const WATER_KINDS = ['TOC', 'conductivity', 'micro', 'endotoxin'] as const;
export const SAMPLING_KINDS = [...EM_KINDS, ...WATER_KINDS] as const;
export type SamplingKind = (typeof SAMPLING_KINDS)[number];
/** The kinds that count colonies: grade A acts on any colony (library S11). */
export const COLONY_KINDS: readonly SamplingKind[] = [...EM_KINDS, 'micro'];
/** The kinds sampled from a person: the person is named when the sample is taken. */
export const PERSON_KINDS: readonly SamplingKind[] = ['glove print', 'personnel'];
export const FREQUENCIES = ['per shift', 'daily', 'weekly', 'monthly', 'per batch'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const STATES = ['at rest', 'in operation'] as const;
export type RoomState = (typeof STATES)[number];
export const WATER_SYSTEMS = { PW: 'Purified water', WFI: 'Water for injections' } as const;
export type WaterSystem = keyof typeof WATER_SYSTEMS;
/** The tests each water system's pharmacopoeial specification needs at its points (LIMS-37). */
export const WATER_NEEDS: Record<WaterSystem, readonly SamplingKind[]> = { PW: ['TOC', 'conductivity', 'micro'], WFI: ['TOC', 'conductivity', 'micro', 'endotoxin'] };
export const GRADES = ['A', 'B', 'C', 'D'] as const;
/** When the isolates of a plate are identified: never, on an action excursion, or on any growth. */
export const IDENTIFY = ['no', 'on action', 'any growth'] as const;
export type Identify = (typeof IDENTIFY)[number];

export const samplingSchema = z.object({
  key: keySchema,
  kind: z.enum(SAMPLING_KINDS),
  frequency: z.enum(FREQUENCIES),
  // Rooms: at rest or in operation (the limits differ, library S11); water: none.
  state: z.enum(STATES).optional(),
  // The specification (its master; the effective version is used when the sample is taken) and the test whose limits
  // apply; its number, the test's name, method and limit as read when the plan was saved (pull, don't type).
  spec: z.object({ masterId: z.number().int().positive(), testKey: keySchema, number: text(60), testName: text(), method: text(), limit: text(200) }).strict().nullable(),
  // Taken each time, with its unit ("1 plate", "1 m³ air", "250 mL").
  quantity: text(60).regex(/^\d+(\.\d+)?\s*\S.*$/, 'give the quantity with its unit, e.g. 1 plate'),
  identify: z.enum(IDENTIFY).default('on action'),
  // EU Annex 1 adverse trend: "n alert-or-action results in the last m samplings" (empty: the default by grade,
  // shared/engine/em-trends.ts adverseRule).
  adverse: z.object({ n: z.number().int().min(1).max(20), m: z.number().int().min(1).max(20) }).strict().optional(),
}).strict();

export const pointSchema = z.object({
  key: keySchema,
  // The point's code on the drawings ("B101-SP1") and where it is ("Filling LAF, left of the needles").
  code: text(40).min(1),
  name: text(120),
  of: z.enum(['room', 'water']),
  // A room of master data, its code, name and grade as read when the plan was saved.
  room: z.object({ itemId: z.string().min(1).max(100), code: text(60), name: text(), grade: text(10) }).strict().optional(),
  // A water system and the loop or outlet ("Loop 1, outlet 4").
  system: z.enum(Object.keys(WATER_SYSTEMS) as [WaterSystem, ...WaterSystem[]]).optional(),
  // A critical location (next to open product, library 8c-33).
  critical: z.boolean().default(false),
  samplings: z.array(samplingSchema).max(20),
}).strict();

export const monitoringSchema = z.object({
  header: z.object({
    // The document number ("EMP-001") and its name ("Sterile block: EM and water").
    number: text(60).min(1),
    name: text(200),
    // Shifts a day: a "per shift" sampling is due this many times each day.
    shifts: z.number().int().min(1).max(4).default(3),
  }).strict(),
  points: z.array(pointSchema).max(300),
}).strict();

export type MonitoringDoc = z.infer<typeof monitoringSchema>;
export type MonitoringPoint = z.infer<typeof pointSchema>;
export type Sampling = z.infer<typeof samplingSchema>;

/** Where a point is, in words: "B101 Filling room (grade B)" or "Purified water". */
export const pointWhere = (p: Pick<MonitoringPoint, 'of' | 'room' | 'system'>) =>
  (p.of === 'room' ? (p.room ? `${p.room.code} ${p.room.name} (grade ${p.room.grade || '?'})` : '(no room)') : p.system ? WATER_SYSTEMS[p.system] : '(no system)');

/** A specification version as the server read it for a plan: its state and document. */
export interface PlanSpec { state: string; doc: SpecDoc }

// Library S11: EM counts are per m³ of air; a limit per cubic foot is 35.3 times smaller and refused until converted.
const PER_FT3 = /ft|cu\.?\s*f|cubic\s*f/i;
const PER_M3 = /m³|m3/i;
const num = (x: string | undefined) => (x === undefined ? undefined : Number(x));

/**
 * Plan checks (LIMS-36, LIMS-37): a plan is approved only when every point is where it says (a graded room of master
 * data, or a water system), every sampling has its frequency, its state (rooms), and a specification test of the right
 * kind (environmental monitoring or water, approved or effective) with alert and action limits per m³ (S11); the
 * at-rest limit is no looser than the in-operation one; each water system is tested to its pharmacopoeial
 * specification (TOC, conductivity, micro; endotoxin for WFI). `specs` gives each specification's latest approved or
 * effective version, or null.
 */
export function monitoringChecks(doc: MonitoringDoc, specs: (masterId: number) => PlanSpec | null): Problem[] {
  const out: Problem[] = [];
  const error = (path: string, message: string, rule: string) => out.push({ level: 'error', path, message, rule });
  const warn = (path: string, message: string, rule: string) => out.push({ level: 'warning', path, message, rule });
  if (!doc.points.length) error('points', 'Add the sampling points.', 'LIMS-36');
  const limits: { point: string; kind: string; state?: RoomState; limit: Limit }[] = [];
  doc.points.forEach((p, i) => {
    const path = `points[${i}]`;
    const rule = p.of === 'room' ? 'LIMS-36' : 'LIMS-37';
    if (doc.points.findIndex((x) => x.key === p.key) !== i) error(path, `The key ${p.key} is used twice.`, rule);
    if (doc.points.findIndex((x) => x.code === p.code) !== i) error(path, `The point code ${p.code} is used twice.`, rule);
    if (p.of === 'room') {
      if (!p.room) error(path, `${p.code}: pick its room from master data.`, rule);
      else if (!(GRADES as readonly string[]).includes(p.room.grade)) error(path, `${p.code}: master data gives room ${p.room.code} no clean-room grade (A, B, C or D); its limits cannot be checked.`, rule);
    } else if (!p.system) error(path, `${p.code}: pick its water system.`, rule);
    if (!p.samplings.length) error(path, `${p.code}: say what is sampled there.`, rule);
    p.samplings.forEach((s, j) => {
      const sp = `${path}.samplings[${j}]`;
      const what = `${p.code}, ${s.kind}`;
      if (p.samplings.findIndex((x) => x.key === s.key) !== j) error(sp, `The key ${s.key} is used twice.`, rule);
      if (p.of === 'room' && !(EM_KINDS as readonly string[]).includes(s.kind)) error(sp, `${what}: a room is sampled by plates, active air or personnel.`, rule);
      if (p.of === 'water' && !(WATER_KINDS as readonly string[]).includes(s.kind)) error(sp, `${what}: water is tested for TOC, conductivity, micro or endotoxin.`, rule);
      if (p.of === 'room' && !s.state) error(sp, `${what}: say whether it is sampled at rest or in operation (the limits differ).`, rule);
      if (p.of === 'water' && s.state) error(sp, `${what}: water has no at rest or in operation state.`, rule);
      if (s.adverse && s.adverse.n > s.adverse.m) error(sp, `${what}: the adverse trend is n results in the last m samplings: n (${s.adverse.n}) cannot be more than m (${s.adverse.m}).`, 'LIMS-36');
      if (!s.spec) return void error(sp, `${what}: pick the specification test whose alert and action limits apply.`, rule);
      const spec = specs(s.spec.masterId);
      if (!spec) return void error(sp, `${what}: specification ${s.spec.number || s.spec.masterId} has no approved or effective version.`, rule);
      const h = spec.doc.header;
      const type = p.of === 'room' ? 'Environmental monitoring' : 'Water';
      if (h.type !== type) error(sp, `${what}: specification ${h.number} is a ${h.type.toLowerCase()} specification, not ${type.toLowerCase()}.`, rule);
      if (p.of === 'water' && /in-?house/i.test(h.pharmacopoeia)) error(sp, `${what}: water is tested to its pharmacopoeial specification; ${h.number} is in-house.`, 'LIMS-37');
      const t = spec.doc.tests.find((x) => x.key === s.spec!.testKey);
      if (!t) return void error(sp, `${what}: specification ${h.number} has no test ${s.spec.testName || s.spec.testKey}.`, rule);
      if (t.use === 'stability') error(sp, `${what}: ${t.name} applies on stability only.`, rule);
      if (p.of === 'room' && t.limitType !== 'alert and action') error(sp, `${what}: ${t.name} has no alert and action limits (it is ${t.limitType}).`, rule);
      if (p.of === 'water' && !['alert and action', 'not more than', 'range'].includes(t.limitType)) error(sp, `${what}: ${t.name} has no numeric limit (it is ${t.limitType}).`, rule);
      const l = t.limit;
      if (!l) return;
      if (PER_FT3.test(l.unit)) error(sp, `${what}: the limit is per cubic foot (${l.unit}); limits are per m³ (1 per ft³ = 35.3 per m³): convert it in the specification.`, rule);
      else if (s.kind === 'active air' && !PER_M3.test(l.unit)) error(sp, `${what}: an active air limit is per m³ of air, not ${l.unit || 'without a unit'}.`, rule);
      if (COLONY_KINDS.includes(s.kind) && !/cfu/i.test(l.unit)) error(sp, `${what}: a plate or micro count is in CFU, not ${l.unit || 'without a unit'}.`, rule);
      if (p.room?.grade === 'A' && COLONY_KINDS.includes(s.kind) && num(l.high) !== undefined && num(l.high)! > 0) {
        warn(sp, `${what}: grade A acts on any colony, whatever the limit (${limitWords(l)}): one colony opens an investigation.`, rule);
      }
      limits.push({ point: p.key, kind: s.kind, ...(s.state ? { state: s.state } : {}), limit: l });
    });
  });
  // S11: at rest is cleaner than in operation; an at-rest action limit looser than the in-operation one is a mix-up.
  for (const r of limits.filter((x) => x.state === 'at rest')) {
    const op = limits.find((x) => x.point === r.point && x.kind === r.kind && x.state === 'in operation');
    if (op && op.limit.unit === r.limit.unit && num(r.limit.high) !== undefined && num(op.limit.high) !== undefined && num(r.limit.high)! > num(op.limit.high)!) {
      const p = doc.points.findIndex((x) => x.key === r.point);
      error(`points[${p}]`, `${doc.points[p]!.code}, ${r.kind}: the at-rest action limit (${limitWords(r.limit)}) is looser than the in-operation one (${limitWords(op.limit)}): the states are mixed up.`, 'LIMS-36');
    }
  }
  // LIMS-37: each water system of the plan is tested for what its pharmacopoeial specification asks, at its points.
  for (const sys of Object.keys(WATER_SYSTEMS) as WaterSystem[]) {
    const pts = doc.points.filter((p) => p.of === 'water' && p.system === sys);
    if (!pts.length) continue;
    const missing = WATER_NEEDS[sys].filter((k) => !pts.some((p) => p.samplings.some((s) => s.kind === k)));
    if (missing.length) error('points', `${WATER_SYSTEMS[sys]}: no point is tested for ${missing.join(', ')}.`, 'LIMS-37');
  }
  return out;
}
