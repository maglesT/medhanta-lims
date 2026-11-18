/**
 * A method version is ONE JSON document: the header and the stages in order with their steps in order.
 * This schema checks only its shape; whether it makes a good master is for checks.ts. A draft may be incomplete.
 */
import { z } from 'zod';

const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'a plain decimal, e.g. "250.0"');
export const keySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower-case letters, digits and -');
const text = (max = 200) => z.string().trim().max(max);

export const limitSchema = z.object({
  low: z.string().optional(), high: z.string().optional(), unit: z.string(),
  lowStrict: z.boolean().optional(), highStrict: z.boolean().optional(),
  alertLow: z.string().optional(), alertHigh: z.string().optional(),
}).strict();

// A step setting: a value as written ("0.5", "250.0 mg"), a limit, a reference to an earlier step's field or
// calculation ("stage/step/name"), or `{ spec: name }`: a value the product's specification gives (a label claim, an
// average weight, the limit of a result). Before an analysis runs, applySpec (shared/master/spec.ts) puts the spec's
// values in their place, so the engine never sees `spec`.
export const specNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/, 'a name: letters and digits, starting lower-case');
export const settingValueSchema = z.union([
  text(),
  limitSchema,
  z.object({ ref: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+\/[a-zA-Z0-9]+$/, 'stage/step/name') }).strict(),
  z.object({ spec: specNameSchema }).strict(),
]);

const flowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  // Rounds of the same step until the stop check passes, at most maxRounds (then a deviation note is needed).
  z.object({ kind: z.literal('repeat-until'), maxRounds: z.number().int().min(1).max(500).optional(), stop: z.string().optional() }).strict(),
  z.object({ kind: z.literal('optional-with-reason') }).strict(),
]);

export const stepSchema = z.object({
  key: keySchema,
  block: z.object({ id: z.string(), version: z.number().int().min(1) }).strict(),
  // The name people read (e.g. "Punch and die check — after compression"); without it, the block's name and material.
  name: text(120).optional(),
  instruction: text(4000).optional(),
  settings: z.record(settingValueSchema).default({}),
  // The performer always signs; a second person checks when true.
  checker: z.boolean(),
  // The next step waits for the check (otherwise it opens when this step is done).
  waitForCheck: z.boolean().default(false),
  critical: z.boolean().default(false),
  minMinutes: z.number().int().positive().max(10_000).optional(),
  everyMinutes: z.number().int().positive().max(10_000).optional(),
  // F6 with a changing interval: after `afterMinutes` from the first round, a round every `everyMinutes` (F0030).
  everyMinutesLater: z.object({ afterMinutes: z.number().int().positive().max(10_000), everyMinutes: z.number().int().positive().max(10_000) }).strict().optional(),
  // Order-critical: this step must come after the step with this key in the same stage (F0318: the drug after the PVP).
  orderAfter: keySchema.optional(),
  flow: flowSchema.default({ kind: 'none' }),
  // Only trained people sign (owner, 17 Nov 2026): the skill Recruitment publishes (training_v1) that the performer and
  // the checker must hold, picked from Recruitment's list (typed only while the link is off). None: anyone may sign.
  training: z.object({ code: text(60).min(1), title: text(200).optional() }).strict().optional(),
}).strict();

export const stageSchema = z.object({
  key: keySchema,
  name: text().min(1),
  kind: z.enum(['normal', 'preparation', 'replicate']),
  count: z.number().int().min(2).max(50).optional(),
  roomTypes: z.array(text()).max(20).default([]),
  machineTypes: z.array(text()).max(50).default([]),
  role: text().default(''),
  produces: z.object({ name: text().min(1), holdHours: z.number().positive().max(100_000).optional() }).strict().optional(),
  // Stages whose intermediate this stage uses (preparations must be closed first; their hold time ends here).
  uses: z.array(keySchema).max(20).default([]),
  steps: z.array(stepSchema).max(200),
}).strict();

// The method's header: what it is and where it comes from. The product's own values (label claim, average weight,
// limits) are not here: the specification gives them.
export const TECHNIQUES = ['HPLC', 'GC', 'UV-Vis', 'IR', 'Titration', 'Karl Fischer', 'Dissolution', 'Gravimetric', 'Physical',
  'Microbiology', 'Other'] as const;
export const headerSchema = z.object({
  code: text(40).min(1),
  name: text().min(1),
  technique: z.enum(TECHNIQUES),
  // The source: a pharmacopoeia monograph or general chapter, or an in-house method number.
  reference: text(),
  edition: text(60).optional(),
  // LIMS-02, LIMS-04 (build step 8): where the method comes from, so what it needs before routine use: an in-house
  // method a validation report, a pharmacopoeial method a verification report, a method transferred from another
  // laboratory a transfer report (shared/engine/method-validation.ts). Not set: in-house.
  origin: z.enum(['in-house', 'pharmacopoeial', 'transferred']).optional(),
  // 'validation': a validation, verification or transfer protocol run as a worksheet: its analyses have no sample and
  // feed a validation report; it needs no validation itself. Not set: routine.
  use: z.enum(['routine', 'validation']).optional(),
}).strict();

// The author's answer to a calculation warning (checks.ts), keyed by the warning and its item. `about` is the warning
// as answered: when the warning reads differently (the item changed), it needs a new answer.
export const answerSchema = z.object({ about: text(1000), choice: text().min(1), reason: text(1000) }).strict();

export const masterSchema = z.object({
  header: headerSchema,
  stages: z.array(stageSchema).max(50),
  answers: z.record(z.string().max(120), answerSchema).optional(),
}).strict();

export type MasterDoc = z.infer<typeof masterSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type Step = z.infer<typeof stepSchema>;
export type SettingValue = z.infer<typeof settingValueSchema>;
export type Limit = z.infer<typeof limitSchema>;
export type Answer = z.infer<typeof answerSchema>;


export const MASTER_STATES = ['draft', 'in_review', 'approved', 'effective', 'retired'] as const;
export type MasterState = (typeof MASTER_STATES)[number];
