/**
 * A specification version is ONE JSON document (LIMS-01): what it is for (a material or product of master data, its
 * type, market and pharmacopoeia) and the list of tests, each done by a method with a limit of a type picked from a
 * fixed list. It is kept, reviewed and approved exactly as a method version (the same table, kind 'spec').
 *
 * applySpec puts a test's values into its method before an analysis runs: every `{ spec: name }` setting of the method
 * becomes the spec's value (`limit` is the test's limit, release or shelf life), so the engine sees an ordinary method.
 */
import { z } from 'zod';
import { findBlock } from '../blocks/index.js';
import { c1WithinLimits, l19SamplingPlan } from '../templates/index.js';
import { keySchema, limitSchema, type Limit, type MasterDoc, type SettingValue } from './schema.js';
import { masterChecks, type Problem } from './checks.js';

const text = (max = 200) => z.string().trim().max(max);

export const SPEC_TYPES = ['Raw material', 'Packing material', 'Intermediate', 'In-process', 'Finished product', 'Active substance', 'Water',
  'Environmental monitoring'] as const;
// Limit types (plan 2.1): the limit is written as in the monograph; rounding at its decimals (C1).
export const LIMIT_TYPES = ['range', 'not more than', 'not less than', 'conforms', 'report only', 'alert and action', 'release and shelf life'] as const;
export type LimitType = (typeof LIMIT_TYPES)[number];
// When a test applies: at release, on stability (shelf life), or both.
export const TEST_USES = ['release', 'stability', 'release and stability'] as const;

export const specTestSchema = z.object({
  key: keySchema,
  name: text().min(1),
  // The method (its master id; the effective version is used when an analysis starts) and its code and name as read.
  method: z.object({ masterId: z.number().int().positive(), code: text(), name: text() }).strict(),
  // The method's reportable result: "stage/step/name" (by convention a result block's `result`).
  result: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+\/[a-zA-Z0-9]+$/, 'stage/step/name'),
  limitType: z.enum(LIMIT_TYPES),
  // range, not more than, not less than, alert and action, and the release limit of "release and shelf life".
  limit: limitSchema.optional(),
  // "release and shelf life": the wider limit that applies on stability.
  shelfLifeLimit: limitSchema.optional(),
  // LIMS-25: an optional trend limit, inside the limit: a result within the limit but outside it is out of trend (flagged
  // on the sample; QC answers the flag before approval).
  trendLimit: limitSchema.optional(),
  // conforms: what the result must show, as written ("The IR spectrum matches the reference spectrum").
  conforms: text(500).optional(),
  // The other values the method asks the specification for, by name (label claim, average weight …).
  values: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), z.union([text(), limitSchema])).default({}),
  use: z.enum(TEST_USES).default('release and stability'),
  // LIMS-08: an identity test. For a starting material (raw material, active substance) it is done on each container
  // sampled for release (every container of the lot); the decision waits for a result of each.
  identity: z.boolean().optional(),
}).strict();

export const specHeaderSchema = z.object({
  // A material (raw, packing, API) or a product of master data; its code and name as read from master data.
  of: z.enum(['material', 'product']),
  itemId: z.string().min(1).max(100),
  code: text(),
  name: text(),
  type: z.enum(SPEC_TYPES),
  // The document number of the specification ("SPEC-RM-012").
  number: text(60).min(1),
  // Market or customer it is for (blank: all).
  market: text(100).optional(),
  // IP, BP, Ph. Eur., USP, Ph. Int. or In-house, and its edition.
  pharmacopoeia: text(60).min(1),
  edition: text(60).optional(),
  // LIMS-30: the reserve (retention) sample to keep of each lot or batch, with its unit ("60 tablets"): at least twice the
  // quantity needed for all the tests except sterility and pyrogen (US 211.170(a)). QC approval of a release sample waits
  // for a reserve sample of its lot logged at least at this quantity; blank: none is checked (the decision says so).
  reserveQuantity: text(60).regex(/^\d+(\.\d+)?\s*\S.*$/, 'give the quantity with its unit, e.g. 60 tablets').optional(),
  // LIMS-05: the sampling plan of a release sample: how many of the containers received are sampled (template L19: 1 + √N
  // rounded up, or every container), and how (method and tool, equipment, amount per container, sub-division into the
  // test, reserve and retained portions, precautions, storage of the sample). An identity test of a starting material
  // always samples every container (LIMS-08).
  sampling: z.object({
    plan: z.enum(['square root', 'every container']),
    method: text(300).optional(), equipment: text(200).optional(), amount: text(60).optional(), subdivision: text(300).optional(),
    precautions: text(300).optional(), storage: text(200).optional(),
  }).strict().optional(),
}).strict();

export const specSchema = z.object({
  header: specHeaderSchema,
  tests: z.array(specTestSchema).max(100),
}).strict();

export type SpecDoc = z.infer<typeof specSchema>;
export type SpecTest = z.infer<typeof specTestSchema>;

/** The `{ spec: name }` settings a method asks for, with the step that asks; `limit` is the test's limit. */
export function specNames(doc: MasterDoc): { name: string; where: string; kind: 'limit' | 'value' }[] {
  const out: { name: string; where: string; kind: 'limit' | 'value' }[] = [];
  for (const s of doc.stages) for (const t of s.steps) {
    const b = findBlock(t.block);
    for (const [n, v] of Object.entries(t.settings)) {
      if (typeof v !== 'object' || !('spec' in v)) continue;
      if (out.some((x) => x.name === v.spec)) continue;
      out.push({ name: v.spec, where: `${s.name} › ${t.name ?? b?.name ?? t.key}`, kind: b?.settings.find((x) => x.name === n)?.kind === 'limit' ? 'limit' : 'value' });
    }
  }
  return out;
}

/** The result names a method offers a specification: the calculations of its steps outside replicate stages. */
export function resultsOf(doc: MasterDoc): { ref: string; label: string }[] {
  return doc.stages.flatMap((s) => (s.kind === 'replicate' ? [] : s.steps.flatMap((t) => {
    const b = findBlock(t.block);
    return (b?.calcs ?? []).map((c) => ({ ref: `${s.key}/${t.key}/${c.name}`, label: `${s.name} › ${t.name ?? b!.name} › ${c.label}` }));
  })));
}

/** The limit a test applies for a purpose: the shelf-life limit on stability when the spec has one. */
export function limitFor(t: SpecTest, purpose: 'release' | 'stability'): Limit | undefined {
  return purpose === 'stability' && t.limitType === 'release and shelf life' ? t.shelfLifeLimit : t.limit;
}

/**
 * The method with the specification's values in place of its `{ spec: name }` settings (release or stability). One
 * method may serve several tests of a specification (an assay and the impurities from one run): a `limit` is the limit
 * of the test whose result is that step (or of the only test); other names come from the tests' values. A name no
 * test gives is left as it is: the calculation needing it waits, and specChecks reports it before approval.
 */
export function applySpec(doc: MasterDoc, tests: SpecTest | readonly SpecTest[], purpose: 'release' | 'stability' = 'release'): MasterDoc {
  const list = Array.isArray(tests) ? tests : [tests as SpecTest];
  const stepOf = (t: SpecTest) => t.result.split('/').slice(0, 2).join('/');
  const limitAt = (where: string) => {
    const t = list.find((x) => stepOf(x) === where) ?? (list.length === 1 ? list[0] : undefined);
    return t && limitFor(t, purpose);
  };
  const valueOf = (name: string) => list.map((t) => t.values[name]).find((x) => x !== undefined);
  return {
    ...doc,
    stages: doc.stages.map((s) => ({ ...s, steps: s.steps.map((st) => ({
      ...st,
      settings: Object.fromEntries(Object.entries(st.settings).flatMap(([n, v]): [string, SettingValue][] => {
        if (typeof v !== 'object' || !('spec' in v)) return [[n, v]];
        const x = v.spec === 'limit' ? limitAt(`${s.key}/${st.key}`) : valueOf(v.spec);
        return x === undefined ? (v.spec === 'limit' ? [] : [[n, v]]) : [[n, x]];
      })),
    })) })),
  };
}

const sides = (l: Limit | undefined) => ({ low: l?.low !== undefined, high: l?.high !== undefined });

/**
 * Specification checks (LIMS-01): complete before it can be approved. `methods` gives each test's method as it stands
 * now (its latest approved or effective version), or null when it has none.
 */
export function specChecks(doc: SpecDoc, methods: (masterId: number) => { doc: MasterDoc; state: string } | null): Problem[] {
  const out: Problem[] = [];
  const error = (path: string, message: string, rule?: string) => out.push({ level: 'error', path, message, ...(rule ? { rule } : {}) });
  if (!doc.tests.length) error('tests', 'The specification has no tests');
  // LIMS-05: a starting material or a packing material is sampled by an approved plan (US 211.84(b); Schedule M 19.6):
  // its specification names it (1 + √N or every container, and how).
  if (doc.header.of === 'material' && SAMPLED_BY_PLAN.includes(doc.header.type) && !doc.header.sampling?.plan) {
    error('header.sampling', `A ${doc.header.type.toLowerCase()} is sampled by a written plan: choose the sampling plan (1 + √N containers or every container) and say how it is sampled`, 'LIMS-05');
  }
  doc.tests.forEach((t, i) => {
    const p = `tests[${i}]`;
    if (doc.tests.findIndex((x) => x.key === t.key) !== i) error(p, `The key ${t.key} is used twice`);
    const { low, high } = sides(t.limit);
    const need = (ok: boolean, message: string) => { if (!ok) error(`${p}.limit`, `${t.name}: ${message}`, 'LIMS-01'); };
    switch (t.limitType) {
      case 'range': need(low && high, 'a range needs both limits'); break;
      case 'not more than': need(high && !low, '"not more than" needs only the upper limit'); break;
      case 'not less than': need(low && !high, '"not less than" needs only the lower limit'); break;
      case 'conforms': need(!!t.conforms?.trim() && !t.limit, 'say what the result must show, and give no number'); break;
      case 'report only': need(!t.limit, 'a result reported only has no limit'); break;
      case 'alert and action': need((low || high) && (t.limit?.alertLow !== undefined || t.limit?.alertHigh !== undefined), 'give the action limit and the alert limit'); break;
      case 'release and shelf life': need((low || high) && !!t.shelfLifeLimit, 'give the release limit and the shelf-life limit'); break;
    }
    if (t.trendLimit && t.limitType === 'conforms') error(`${p}.trendLimit`, `${t.name}: a conforms test has no number to trend`, 'LIMS-25');
    for (const [name, l] of [['limit', t.limit], ['shelfLifeLimit', t.shelfLifeLimit], ['trendLimit', t.trendLimit]] as const) {
      if (!l) continue;
      const r = c1WithinLimits({ value: { value: '0', unit: l.unit }, limit: l });
      if (!r.ok) error(`${p}.${name}`, `${t.name}: ${r.message}`);
    }
    const m = methods(t.method.masterId);
    if (!m) return void error(`${p}.method`, `${t.name}: method ${t.method.code} has no approved or effective version`, 'LIMS-01');
    if (!resultsOf(m.doc).some((x) => x.ref === t.result)) error(`${p}.result`, `${t.name}: method ${t.method.code} has no result ${t.result}`);
    // The method with this test's values in place passes its own checks: a limit in a unit of another kind than the
    // result it checks (a pH limit in %) is refused here (LIMS-01), for release and for stability.
    for (const purpose of ['release', 'stability'] as const) {
      if (purpose === 'stability' && t.limitType !== 'release and shelf life') continue;
      for (const pr of masterChecks(applySpec(m.doc, t, purpose)).filter((x) => x.rule === 'LIMS-01' && /unit|kind/i.test(x.message))) {
        error(`${p}.${purpose === 'stability' ? 'shelfLifeLimit' : 'limit'}`, `${t.name}: ${pr.message}`, 'LIMS-01');
      }
    }
    for (const n of specNames(m.doc)) {
      if (n.name === 'limit') {
        if (t.limitType === 'conforms' || t.limitType === 'report only') error(`${p}.limit`, `${t.name}: method ${t.method.code} checks its result against a limit; a ${t.limitType} test cannot give one`);
        continue;
      }
      if (t.values[n.name] === undefined) error(`${p}.values.${n.name}`, `${t.name}: method ${t.method.code} asks the specification for "${n.name}" (${n.where})`, 'LIMS-01');
    }
  });
  return out;
}

/** LIMS-05: the specification types whose material is sampled by the plan the specification names. */
export const SAMPLED_BY_PLAN: readonly string[] = ['Raw material', 'Active substance', 'Packing material'];
/** The specification types of starting materials (LIMS-08): their identity is tested on each container. */
export const STARTING_MATERIALS: readonly string[] = ['Raw material', 'Active substance'];
/**
 * LIMS-08: the number of containers each identity test of this sample is done on, or null when it is done once. A release
 * sample of a starting material is identified container by container. A validated reduced identity (fewer containers)
 * needs the supplier's qualification and whether it is a broker, which no linked system publishes: it is not offered.
 */
export function identityContainers(doc: SpecDoc, purpose: string, containers: number | null): number | null {
  return purpose === 'release' && STARTING_MATERIALS.includes(doc.header.type) && doc.tests.some((t) => t.identity) ? containers ?? 0 : null;
}

/** LIMS-05: the plan details a sampler follows, in the order the register lists them (label, value). */
export const SAMPLING_DETAILS = [['method', 'Method and tool'], ['equipment', 'Equipment'], ['amount', 'Amount per container'], ['subdivision', 'Sub-division'],
  ['precautions', 'Precautions'], ['storage', 'Storage of the sample']] as const;

/**
 * LIMS-05: the sampling plan of a release sample, or null when its specification names none (and has no identity test
 * of a starting material): the containers to sample of those received, worked out by template L19, with its worked line.
 */
export function samplingPlan(doc: SpecDoc, purpose: string, received: number): { mode: 'square root' | 'every container'; n: number; line: string } | { problem: string } | null {
  const perContainer = identityContainers(doc, purpose, received) !== null;
  if (purpose !== 'release' || (!doc.header.sampling && !perContainer)) return null;
  const mode = perContainer ? 'every container' : doc.header.sampling!.plan;
  const r = l19SamplingPlan({ mode, containers: String(received), test: 'each container' });
  if (!r.ok) return { problem: `Containers received: ${r.message}` };
  return { mode, n: Number(r.value.toString()), line: `${r.shown.replace(/; each tested: .*$/, '')}${perContainer ? ' (each identified, LIMS-08)' : ''}` };
}
/** LIMS-05: why the container numbers the sampler confirms do not fit the plan; null when they do. */
export function sampledProblem(numbers: readonly number[], n: number, received: number): string | null {
  if (numbers.some((x) => !Number.isInteger(x) || x < 1 || x > received)) return `Container numbers are 1 to ${received}, the containers received.`;
  if (new Set(numbers).size !== numbers.length) return 'A container number is given twice.';
  if (numbers.length !== n) return `The plan samples ${n} of ${received} containers: give ${n} container numbers (${numbers.length} given).`;
  return null;
}

/** Which limits a sample's purpose is tested against: stability samples the shelf-life ones, the others release. */
export const purposeLimits = (purpose: string): 'release' | 'stability' => (purpose === 'stability' ? 'stability' : 'release');

/** The tests of a specification done by a method that apply to a sample's purpose (release tests, or stability tests). */
export function testsFor(doc: SpecDoc, methodMasterId: number, purpose: string): SpecTest[] {
  const on = purposeLimits(purpose);
  return doc.tests.filter((t) => t.method.masterId === methodMasterId && (t.use === 'release and stability' || t.use === on));
}

/**
 * LIMS-08: the tests an analysis by this method covers for a sample whose identity is tested per container
 * (perContainer: identityContainers), or why it cannot start. An analysis for a container covers the identity tests
 * only, for that container; one without a container covers the method's other tests.
 */
export function testsForAnalysis(doc: SpecDoc, methodMasterId: number, purpose: string, perContainer: number | null, container?: number): { tests: SpecTest[] } | { problem: string } {
  const all = testsFor(doc, methodMasterId, purpose);
  if (perContainer === null) return container === undefined ? { tests: all } : { problem: 'This sample is not identified container by container: start the analysis without a container.' };
  const ids = all.filter((t) => t.identity);
  const others = all.filter((t) => !t.identity);
  if (container === undefined) {
    return others.length || !ids.length ? { tests: others } : { problem: `Pick the container this identity test is done on (1 to ${perContainer}): each container of a starting material is identified.` };
  }
  if (!ids.length) return { problem: 'This method does no identity test of the sample: start it without a container.' };
  if (container > perContainer) return { problem: `The sample was taken from ${perContainer} container${perContainer === 1 ? '' : 's'}: pick 1 to ${perContainer}.` };
  return { tests: ids };
}

/** A test's limit in words, as the certificate and the published results show it ("98.0 to 102.0 %", "NMT 0.5 %"). */
export function limitText(t: SpecTest, purpose: 'release' | 'stability' = 'release'): string {
  if (t.limitType === 'conforms') return `Conforms: ${t.conforms ?? ''}`.trim();
  if (t.limitType === 'report only') return 'Report';
  const l = limitFor(t, purpose);
  return l ? limitWords(l) : '';
}

/** A limit in words: "98.0 to 102.0 %", "NMT 0.5 %", "NLT 80 %". */
export function limitWords(l: Limit): string {
  const u = l.unit ? ` ${l.unit}` : '';
  const main = l.low !== undefined && l.high !== undefined ? `${l.low} to ${l.high}${u}` : l.high !== undefined ? `NMT ${l.high}${u}` : `NLT ${l.low}${u}`;
  const alert = l.alertLow !== undefined || l.alertHigh !== undefined ? ` (alert ${[l.alertLow && `below ${l.alertLow}`, l.alertHigh && `above ${l.alertHigh}`].filter(Boolean).join(', ')})` : '';
  return main + alert;
}

/** LIMS-25: a result within its limit but outside the test's trend limit is out of trend; false without a trend limit. */
export function outOfTrend(t: SpecTest, value: string, unit: string): boolean {
  if (!t.trendLimit) return false;
  const r = c1WithinLimits({ value: { value, unit }, limit: t.trendLimit });
  return r.ok && r.check?.pass === false;
}
