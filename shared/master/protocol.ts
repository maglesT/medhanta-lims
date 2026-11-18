/**
 * A stability protocol version is ONE JSON document (LIMS-26): the product or material it is for (master data), why
 * (registration, ongoing, commitment, change), the container closure, the specification version whose stability tests
 * and shelf-life limits are tested, the storage conditions picked from a fixed list with their time points in months,
 * the quantity pulled per time point, the pull window and the design (full, bracketing, matrixing). It is kept, reviewed
 * and approved exactly as a method or specification version (the same table, kind 'protocol').
 */
import { z } from 'zod';
import { keySchema } from './schema.js';
import type { Problem } from './checks.js';
import { l25DesignCheck, type L25Input } from '../templates/index.js';
import type { SpecDoc } from './spec.js';

const text = (max = 200) => z.string().trim().max(max);

export const PROTOCOL_PURPOSES = ['registration', 'ongoing', 'commitment', 'change'] as const;
export type ProtocolPurpose = (typeof PROTOCOL_PURPOSES)[number];
export const PURPOSE_WORDS: Record<ProtocolPurpose, string> = {
  registration: 'Registration (primary) batches', ongoing: 'On-going stability (one batch a year)', commitment: 'Commitment batches', change: 'After a change or deviation',
};

/** The storage conditions (ICH Q1A(R2), Q1B; 30 °C / 75 % RH for India, zone IVb), with the role each normally has. */
export const STORAGE_CONDITIONS = {
  '25/60': { label: '25 °C / 60 % RH', role: 'long-term' },
  '30/65': { label: '30 °C / 65 % RH', role: 'intermediate' },
  '30/75': { label: '30 °C / 75 % RH (India, zone IVb)', role: 'long-term' },
  '40/75': { label: '40 °C / 75 % RH', role: 'accelerated' },
  '5': { label: '5 °C', role: 'long-term' },
  '-20': { label: '−20 °C', role: 'long-term' },
  photo: { label: 'Photostability (ICH Q1B)', role: 'stress' },
  other: { label: 'Other', role: 'long-term' },
} as const;
export type ConditionCode = keyof typeof STORAGE_CONDITIONS;
export const CONDITION_CODES = Object.keys(STORAGE_CONDITIONS) as ConditionCode[];
export const ROLES = ['long-term', 'intermediate', 'accelerated', 'stress'] as const;
export const DESIGNS = ['full', 'bracketing', 'matrixing', 'bracketing and matrixing'] as const;
export const FACTOR_KINDS = ['strength', 'container size', 'fill', 'pack'] as const;

export const conditionSchema = z.object({
  key: keySchema,
  code: z.enum(CONDITION_CODES as [ConditionCode, ...ConditionCode[]]),
  // "other": the condition in words ("25 °C / 40 % RH, semi-permeable pack").
  other: text(120).optional(),
  role: z.enum(ROLES),
  // The time points, in months from placement (T0).
  months: z.array(z.number().int().min(0).max(120)).max(30),
}).strict();

// Bracketing and matrixing (ICH Q1D), as template L25 reads them: the factors (strength, container size, fill, pack),
// their levels (with the quantity that orders them) and those on study; the strengths' formulations, the container
// closure system, why the tested packs are the extremes; matrixing: the time points each cell (a batch with its levels)
// is tested at per condition, the stated reduction, the variability of the supporting data.
export const designSchema = z.object({
  type: z.enum(DESIGNS),
  factors: z.array(z.object({
    name: text(60).min(1),
    kind: z.enum(FACTOR_KINDS),
    levels: z.array(z.object({ name: text(60).min(1), size: text(40).optional(), tested: z.boolean() }).strict()).max(20),
    formulation: z.enum(['identical', 'closely related', 'different']).optional(),
    sameClosureSystem: z.boolean().optional(),
    justification: text(1000).optional(),
  }).strict()).max(5).default([]),
  matrix: z.array(z.object({
    cell: text(120).min(1), condition: keySchema, months: z.array(z.number().int().min(0).max(120)).max(30),
    levels: z.record(text(60), text(60)).optional(),
  }).strict()).max(60).default([]),
  reduction: z.string().regex(/^\d+\/\d+$/, 'a fraction such as 1/2').optional(),
  fullDataBeforeApproval: z.boolean().optional(),
  variability: z.enum(['small', 'moderate', 'large']).optional(),
  statisticallyJustified: z.boolean().optional(),
  justification: text(1000).optional(),
}).strict();

export const protocolHeaderSchema = z.object({
  of: z.enum(['material', 'product']),
  itemId: z.string().min(1).max(100),
  code: text(),
  name: text(),
  // The document number of the protocol ("STP-FG-001").
  number: text(60).min(1),
  purpose: z.enum(PROTOCOL_PURPOSES),
  // The primary pack ("Alu-Alu blister, 10 tablets") and whether it is the one marketed (211.166(a)(4)).
  containerClosure: text(200),
  sameAsMarketed: z.boolean(),
  // The shelf life (or retest period) the study runs to, in months.
  shelfLifeMonths: z.number().int().min(1).max(120),
}).strict();

export const protocolSchema = z.object({
  header: protocolHeaderSchema,
  // The specification version whose stability tests and shelf-life limits are tested; its number as read.
  spec: z.object({ versionId: z.number().int().positive(), number: text(60), versionNo: z.number().int().positive() }).strict().nullable(),
  // Pulled at each time point of each condition, in the unit written ("60 tablets").
  quantity: z.object({ amount: z.string().regex(/^\d+(\.\d{1,3})?$/, 'a number'), unit: text(30).min(1) }).strict(),
  // A pull is on time within this many days before or after its date.
  pullWindowDays: z.number().int().min(0).max(60),
  conditions: z.array(conditionSchema).max(10),
  design: designSchema,
}).strict();

export type ProtocolDoc = z.infer<typeof protocolSchema>;
export type ProtocolCondition = z.infer<typeof conditionSchema>;

/** A condition in words: "25 °C / 60 % RH", or the "other" text. */
export const conditionLabel = (c: Pick<ProtocolCondition, 'code' | 'other'>) => (c.code === 'other' ? c.other?.trim() || 'Other' : STORAGE_CONDITIONS[c.code].label);

/** The specification version a protocol names, as the server read it: its state and document. */
export interface ProtocolSpec { state: string; doc: SpecDoc }

/**
 * Protocol checks (LIMS-26): a protocol is approved only when every element the rule names is there: what and why, the
 * container closure (the marketed one), the specification version with stability tests, the conditions with time points
 * to the end of shelf life, the quantity per time point, the pull window and the design.
 */
export function protocolChecks(doc: ProtocolDoc, spec: ProtocolSpec | null): Problem[] {
  const out: Problem[] = [];
  const error = (path: string, message: string) => out.push({ level: 'error', path, message, rule: 'LIMS-26' });
  const h = doc.header;
  if (!h.containerClosure.trim()) error('header.containerClosure', 'Give the container closure (the primary pack) the samples are stored in.');
  if (!h.sameAsMarketed) error('header.sameAsMarketed', 'The samples are stored in the container closure that is marketed (or proposed for marketing).');
  if (!doc.spec) error('spec', 'Pick the specification version whose stability tests and shelf-life limits are tested.');
  else if (!spec) error('spec', `Specification ${doc.spec.number} version ${doc.spec.versionNo} does not exist.`);
  else {
    if (!['approved', 'effective'].includes(spec.state)) error('spec', `Specification ${doc.spec.number} version ${doc.spec.versionNo} is ${spec.state.replace('_', ' ')}: pick an approved or effective version.`);
    const sh = spec.doc.header;
    if (sh.of !== h.of || (h.of === 'material' ? sh.itemId !== h.itemId : sh.code !== h.code)) error('spec', `Specification ${doc.spec.number} is for ${sh.code} ${sh.name}, not for ${h.code} ${h.name}.`);
    if (!spec.doc.tests.some((t) => t.use !== 'release')) error('spec', `Specification ${doc.spec.number} has no test that applies on stability.`);
  }
  if (!(Number(doc.quantity.amount) > 0)) error('quantity', 'Give the quantity pulled at each time point.');
  if (!doc.conditions.length) error('conditions', 'Add the storage conditions.');
  doc.conditions.forEach((c, i) => {
    const p = `conditions[${i}]`;
    if (doc.conditions.findIndex((x) => x.key === c.key) !== i) error(p, `The key ${c.key} is used twice.`);
    if (c.code === 'other' && !c.other?.trim()) error(p, 'Say what the "other" condition is.');
    if (doc.conditions.findIndex((x) => conditionLabel(x) === conditionLabel(c)) !== i) error(p, `${conditionLabel(c)} is listed twice.`);
    if (!c.months.length) error(p, `${conditionLabel(c)}: give its time points in months.`);
    if (c.months.some((m, j) => j > 0 && m <= c.months[j - 1]!)) error(p, `${conditionLabel(c)}: the time points go up, each once.`);
  });
  // To the end of shelf life (211.166(a)): a long-term condition reaches it.
  const longTerm = doc.conditions.filter((c) => c.role === 'long-term' && c.months.length);
  if (doc.conditions.length && !longTerm.some((c) => c.months.at(-1)! >= h.shelfLifeMonths)) {
    error('conditions', `No long-term condition has a time point at the end of the shelf life (${h.shelfLifeMonths} months).`);
  }
  out.push(...designProblems(doc));
  return out;
}

/**
 * The design (LIMS-26, ICH Q1D): a reduced design says why; each matrix cell is of a condition of the protocol; and
 * template L25 checks the design's rules: for each condition with a matrix, its cells' time points against the
 * condition's; otherwise the factors once (bracketing).
 */
export function designProblems(doc: ProtocolDoc): Problem[] {
  const out: Problem[] = [];
  const error = (path: string, message: string) => out.push({ level: 'error', path, message, rule: 'LIMS-26' });
  const d = doc.design;
  if (d.type !== 'full' && !d.justification?.trim()) error('design', `A ${d.type} design says why it is justified.`);
  d.matrix.forEach((m, i) => { if (!doc.conditions.some((c) => c.key === m.condition)) error(`design.matrix[${i}]`, `${m.cell}: no such condition.`); });
  const base: L25Input = {
    design: d.type,
    factors: d.factors.map((f) => ({ name: f.name, kind: f.kind, levels: f.levels.map((l) => ({ name: l.name, tested: l.tested, ...(l.size ? { size: l.size } : {}) })),
      ...(f.formulation ? { formulation: f.formulation } : {}), ...(f.sameClosureSystem !== undefined ? { sameClosureSystem: f.sameClosureSystem } : {}),
      ...(f.justification ? { justification: f.justification } : {}) })),
    ...(d.reduction ? { reduction: d.reduction } : {}), ...(d.fullDataBeforeApproval !== undefined ? { fullDataBeforeApproval: d.fullDataBeforeApproval } : {}),
    ...(d.variability ? { variability: d.variability } : {}), ...(d.statisticallyJustified !== undefined ? { statisticallyJustified: d.statisticallyJustified } : {}),
  };
  const say = (where: string, r: ReturnType<typeof l25DesignCheck>) => {
    if (!r.ok) error('design', `${where}${r.message}.`);
    else for (const p of r.problems) error('design', `${where}${p}.`);
  };
  const matrixed = doc.conditions.filter((c) => c.months.length && d.matrix.some((m) => m.condition === c.key));
  if (d.type === 'matrixing' || d.type === 'bracketing and matrixing') {
    if (!d.matrix.length) error('design', 'A matrixing design gives the time points each cell (batch, strength or pack) is tested at.');
    for (const c of matrixed) {
      say(`${conditionLabel(c)}: `, l25DesignCheck({ ...base, condition: c.role === 'stress' ? 'accelerated' : c.role, timePoints: c.months.map(String),
        schedule: d.matrix.filter((m) => m.condition === c.key).map((m) => ({ batch: m.cell, times: m.months.map(String), ...(m.levels ? { levels: m.levels } : {}) })) }));
    }
  } else if (d.type === 'bracketing' || d.factors.length) {
    say('', l25DesignCheck(base));
  }
  return out;
}
