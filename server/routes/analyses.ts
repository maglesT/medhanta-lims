import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission, type SessionUser } from '../auth.js';
import { usableItem, type MasterEquipment } from '../master.js';
import { machineRefusal, roomRefusal } from '../../shared/engine/picks.js';
import { handProblem, pullItem, pullLabItem, pullLot, pullQualification, pulledWords } from '../pull.js';
import { itemFills } from '../../shared/engine/items.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';
import { masterVersion } from './masters.js';
import { outsideResults } from './outside.js';
import { analysisRecordDoc, type RecordInput, type Signature } from '../analysis-record.js';
import { linkRetest, oosOfAnalysis, openOos } from './oos.js';
import { render, sendPdf } from '../pdf.js';
import { findBlock, type Block, type BlockField } from '../../shared/blocks/index.js';
import { Dec } from '../../shared/templates/index.js';
import { blocking, masterChecks } from '../../shared/master/checks.js';
import type { MasterDoc, Step } from '../../shared/master/schema.js';
import { applySpec, identityContainers, limitFor, purposeLimits, sampleOnly, testsFor, testsForAnalysis, type SpecDoc, type SpecTest } from '../../shared/master/spec.js';
import { sampleDecision, sampleStatus, type SampleEvent } from '../../shared/engine/sample.js';
import { isHand as sourceByHand } from '../../shared/engine/links.js';
import { createHash } from 'node:crypto';
import { captures, cdsFill, fileText, importSource, imported, isCaptureRaw, MAX_CDS_BYTES, parseCds, readCapture, typedSource } from '../../shared/capture/index.js';
import {
  ACTIONS, ANALYSIS_ACTIONS, CERTIFICATE, currentValues, DEVIATION_DONE, LINK_OF, analysisRefusal, filedKey, stepLabel, stepPlace, stepTitle, handFields, isHand, analysisView, doneProblems, evaluate, lateItems, openSteps, parseKey, readValue, refusal, review, timers,
  trainingCheck, trainingTyped, type Training,
  type Action, type AnalysisAction, type AnalysisEvent, type DeviationStatus, type LinkState, type Source, type StageView, type Stored, type StepEvent, type StepKey, type StepView, type Timer, type Value,
} from '../../shared/engine/index.js';

// Plant time zone: the analysis number's year is the plant's year.
const PLANT_TZ = process.env.DISPLAY_TZ ?? 'Asia/Kolkata';

class StepError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}
function send(reply: FastifyReply, e: unknown) {
  if (e instanceof StepError) return reply.code(e.status).send({ error: e.code, problems: e.problems });
  if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
  throw e;
}

// The sample an analysis is made for: its number, lot, item and specification, and the spec tests the analysis covers.
export interface AnalysisSample { id: number; sampleNo: string; lotNo: string; purpose: string; item: { code: string; name: string };
  spec: { id: number; number: string; versionNo: number }; tests: SpecTest[] }
export interface LoadedAnalysis {
  // container: the container of a starting material an identity analysis tested (LIMS-08), else null.
  analysis: { id: number; analysisNo: string; masterVersionId: number; issuedBy: number; issuedAt: Date; sampleId: number | null; tests: string[]; container?: number | null };
  sample: AnalysisSample | null;
  doc: MasterDoc;
  events: (StepEvent & { personName: string | null })[];
  analysisEvents: (AnalysisEvent & { personName: string })[];
  now: Date;
}

/**
 * The analysis, its method document and every step event, with the database time. An analysis of a sample runs its
 * method with the sample's specification in place (applySpec): the limits and values of the tests it covers, release or
 * shelf-life limits by the sample's purpose.
 */
export async function loadAnalysis(q: Sql | Tx, id: number): Promise<LoadedAnalysis | null> {
  const [b] = await q<(LoadedAnalysis['analysis'] & { doc: MasterDoc; now: Date })[]>`
    select b.id::int, b.analysis_no as "analysisNo", b.master_version_id::int as "masterVersionId", b.issued_by::int as "issuedBy",
      b.issued_at as "issuedAt", b.sample_id::int as "sampleId", b.tests, b.container, v.doc, now() as now
    from analyses b join master_versions v on v.id = b.master_version_id where b.id = ${id}`;
  if (!b) return null;
  let sample: AnalysisSample | null = null;
  if (b.sampleId !== null) {
    const [x] = await q<{ id: number; sampleNo: string; lotNo: string; purpose: string; item: { code: string; name: string }; specId: number; versionNo: number; spec: SpecDoc }[]>`
      select s.id::int, s.sample_no as "sampleNo", s.lot_no as "lotNo", s.purpose, s.item, v.id::int as "specId", v.version_no as "versionNo", v.doc as spec
      from samples s join master_versions v on v.id = s.spec_version_id where s.id = ${b.sampleId}`;
    const tests = x!.spec.tests.filter((t) => b.tests.includes(t.key));
    sample = { id: x!.id, sampleNo: x!.sampleNo, lotNo: x!.lotNo, purpose: x!.purpose, item: { code: x!.item.code, name: x!.item.name },
      spec: { id: x!.specId, number: x!.spec.header.number, versionNo: x!.versionNo }, tests };
    b.doc = applySpec(b.doc, tests, purposeLimits(x!.purpose));
  }
  const events = await q<LoadedAnalysis['events']>`
    select e.id::int, e.stage, e.sub, e.step, e.round, e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at
    from step_events e left join users u on u.id = e.person_id where e.analysis_id = ${id} order by e.id`;
  const analysisEvents = await q<LoadedAnalysis['analysisEvents']>`
    select e.id::int, e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at
    from analysis_events e join users u on u.id = e.person_id where e.analysis_id = ${id} and e.kind <> 'stage_closed' order by e.id`;
  const { doc, now, ...analysis } = b;
  return { analysis, sample, doc, events: [...events], analysisEvents: [...analysisEvents], now };
}

// What a analysis-level signer is shown: the record as it stands, by its last events (the signature is refused if
// anything was added since).
const analysisContent = (l: LoadedAnalysis) => ({ analysis: l.analysis.id, analysisNo: l.analysis.analysisNo, lastStepEvent: l.events.at(-1)?.id ?? 0, lastAnalysisEvent: l.analysisEvents.at(-1)?.id ?? 0 });
const APPROVED_SAMPLE = 'This sample is already approved. Re-testing goes through an OOS or a new sample.';

/** Every signature of the analysis: its issue, its steps and its analysis-level decisions, in order. */
const analysisSignatures = (q: Sql, id: number) => q<Signature[]>`
  select s.object_type as "objectType", s.object_id::int as "objectId", s.printed_name as "printedName", s.meaning, s.signed_at as "signedAt",
    case when e.id is not null then concat_ws('.', e.stage, e.sub, e.step, e.round) end as step
  from signatures s left join step_events e on s.object_type = 'step_event' and e.id = s.object_id
  where (s.object_type = 'analysis' and s.object_id = ${id})
     or e.analysis_id = ${id}
     or (s.object_type = 'analysis_event' and s.object_id in (select b.id from analysis_events b where b.analysis_id = ${id}))
  order by s.signed_at, s.id`;
/** What the analysis record PDF is made from: the analysis with its master version, issuer and signatures. */
export async function recordInput(q: Sql, l: LoadedAnalysis): Promise<RecordInput> {
  const v = await masterVersion(q, l.analysis.masterVersionId);
  const [issuer] = await q<{ name: string }[]>`select full_name as name from users where id = ${l.analysis.issuedBy}`;
  return { ...l, versionNo: v!.versionNo, issuedByName: issuer?.name ?? '', signatures: [...await analysisSignatures(q, l.analysis.id)] };
}
const analysisHash = (l: LoadedAnalysis) => contentHash('analysis', l.analysis.id, analysisContent(l));
const view = (l: LoadedAnalysis, read?: ReadonlyMap<string, DeviationStatus> | null) => analysisView(l.doc, l.events, l.analysisEvents, l.now, read);
/**
 * LIMS-20: the analysis's deviation references as the Deviations system has them now, and (owner, 17 Nov 2026) the
 * deviation filed from each note written without one, found by the note's source_ref (keyed filedKey(note)); null when
 * the link does not answer.
 */
async function deviationsRead(app: FastifyInstance, l: LoadedAnalysis): Promise<{ read: Map<string, DeviationStatus> | null; link: LinkState }> {
  const notes = l.events.filter((e) => e.kind === 'note');
  const refs = [...new Set(notes.flatMap((e) => (e.payload.reference ? [e.payload.reference] : [])))];
  const r = await app.links.deviations.byNumbers(refs);
  if (r.state !== 'ok') return { read: null, link: r.state };
  const read = new Map<string, DeviationStatus>(r.value);
  const bare = notes.filter((e) => !e.payload.reference);
  if (!bare.length) return { read, link: 'ok' };
  const f = await app.links.deviations.bySourceRefs(bare.map((e) => `${app.product.id}:note:${e.id}`));
  if (f.state !== 'ok') return { read: null, link: f.state };
  for (const e of bare) {
    const d = f.value.get(`${app.product.id}:note:${e.id}`);
    if (d) read.set(filedKey(e.id), { status: d.status, closedAt: d.closedAt, number: d.number });
  }
  return { read, link: 'ok' };
}

// What a signer is shown of a step, and its hash: the signature is refused if the step changed since (PL-05).
const stepContent = (analysisId: number, v: StepView) => ({ analysis: analysisId, step: v.id, values: v.values, results: v.results });
const stepHash = (analysisId: number, v: StepView) => contentHash('analysis_step', analysisId, stepContent(analysisId, v));

/**
 * Reads the values of a step. Machines and rooms are read from master data now (PL-08) and must fit the stage; then,
 * like lots, through their link (Logbook, MMS): pulled when it answers, else typed by hand with the label questions
 * (server/pull.ts). A pulled value cannot be typed over; certificate values come with the lot.
 */
async function readValues(app: FastifyInstance, tx: Tx, l: LoadedAnalysis, key: StepKey, raw: Record<string, unknown>, current: StepView, cds?: { name: string; content: string }, reason?: string) {
  const { doc, now } = l;
  const analysisNo = l.analysis.analysisNo;
  const stage = doc.stages[key.stage]!;
  const step = stage.steps[key.step]!;
  const block = findBlock(step.block)!;
  const unitFor = (f: BlockField) => { const s = f.unit?.startsWith('$') ? step.settings[f.unit.slice(1)] : f.unit; return typeof s === 'string' ? s : ''; };
  const taken = new Set<string>();
  const out: Record<string, Value> = {};
  const source: Record<string, Source> = {};
  const problems: string[] = [];
  // 1. the linked values: machines, rooms and lots
  for (const [name, x] of Object.entries(raw)) {
    const f = block.fields.find((y) => y.name === name);
    if (!f || (!LINK_OF[f.kind] && f.kind !== 'item')) continue;
    let pulled;
    if (f.kind === 'item') {
      // A lab inventory item (LIMS-12, 13, 14): usable now, its values with it.
      pulled = await pullLabItem(tx, block, f, x, now);
      if (!pulled.problems.length) out[name] = pulled.value;
    } else if (f.kind === 'machine' || f.kind === 'room') {
      const rooms = await app.master.rooms();
      const item = f.kind === 'machine' ? usableItem(await app.master.equipment(), String(x), 'machine') : usableItem(rooms, String(x), 'room');
      const type = 'type' in item ? item.type : item.area;
      const no = 'type' in item ? machineRefusal(stage, f, item, rooms) : roomRefusal(stage, item);
      if (no) { problems.push(no); continue; }
      // The area of the room it stands in, so a later stage that runs in that area keeps it in use by the analysis (equipment_use_v1).
      const room = 'room' in item ? item.room : item.code;
      const area = 'area' in item ? item.area : rooms.find((r) => r.code === room)?.area ?? null;
      out[name] = { itemId: item.itemId, code: item.code, name: item.name, version: item.version, type, room, area };
      pulled = await pullItem(app, block, f, item, analysisNo);
      // LIMS-12: a machine is also qualified, as Qualification has it now.
      if (f.kind === 'machine') {
        const q = await pullQualification(app, f, item as MasterEquipment, now);
        problems.push(...q.problems);
        Object.assign(source, q.sources);
      }
    } else {
      const v = readValue(f, x, '');
      if (typeof v !== 'string') { problems.push((v as { error: string }).error); continue; }
      out[name] = v;
      pulled = await pullLot(app, block, v, current.values, now, PLANT_TZ);
    }
    problems.push(...pulled.problems);
    for (const n of pulled.taken ?? []) taken.add(n);
    source[name] = pulled.source;
    Object.assign(out, pulled.values);
    Object.assign(source, pulled.sources);
  }
  // 2. everything typed, with the questions of what is now entered by hand
  const sources = { ...current.source, ...source };
  const fields = [...block.fields, ...handFields(block.fields, sources)];
  const lot = block.fields.find((f) => f.kind === 'lot');
  const fills = itemFills(block);
  for (const [name, x] of Object.entries(raw)) {
    const f = fields.find((y) => y.name === name);
    if (!f) { problems.push(`There is no field ${name}`); continue; }
    if (LINK_OF[f.kind] || f.kind === 'item') continue;
    // A standard's potency, a VS factor: only with the item picked from the inventory, never typed.
    if (fills[name]) { problems.push(`${f.label} comes from the QLIMS inventory with the ${fills[name].item.label.toLowerCase()} and cannot be typed`); continue; }
    if (taken.has(name)) continue;
    // LIMS-32: read from the step's machine over its serial port; the server parses the raw lines itself.
    if (isCaptureRaw(x)) {
      if (!captures(f, step.settings) || f.capture === 'cds') { problems.push(`${f.label} is not read from an instrument on this step.`); continue; }
      const mf = block.fields.find((y) => y.kind === 'machine')!;
      const mv = (out[mf.name] ?? current.values[mf.name]) as { code?: string } | undefined;
      const r = readCapture(f, x.capture, { label: mf.label, code: mv?.code ?? null }, unitFor(f), now);
      if (!r.ok) { problems.push(r.why); continue; }
      out[name] = { value: r.value, unit: r.unit };
      source[name] = r.source;
      // A pH meter prints the temperature with the pH: it fills the temperature too (unless typed in the same save).
      const tf = block.fields.find((y) => y.capture === 'ph-temperature');
      if (f.capture === 'ph' && tf && r.temperature !== undefined && !(tf.name in raw)) { out[tf.name] = { value: r.temperature, unit: unitFor(tf) }; source[tf.name] = r.source; }
      continue;
    }
    const was = source[name] ?? current.source[name];
    // While the step's lot is typed by hand (its link off or down), the lot's date and certificate values are typed from
    // its label, whatever an earlier lot from MMS gave (they are never signed with this lot: doneProblems).
    const lotHand = lot && (name.startsWith(`${lot.name}.`) || CERTIFICATE[name]) && isHand(sources[lot.name]);
    if (was && !isHand(was) && !lotHand) { problems.push(`${f.label} ${pulledWords(was)}`); continue; }
    if (lot && CERTIFICATE[name]) {
      const from = sources[lot.name];
      if (!from) { problems.push(`${f.label}: record the lot first`); continue; }
      if (!isHand(from)) { problems.push(`${f.label} comes from MMS with the lot and cannot be typed`); continue; }
    }
    // Whole seconds, as the time templates read them (T13).
    if (f.kind === 'timer') { out[name] = `${now.toISOString().slice(0, 19)}Z`; continue; }
    const setting = f.unit?.startsWith('$') ? step.settings[f.unit.slice(1)] : f.unit;
    const v = readValue(f, x, typeof setting === 'string' ? setting : '');
    if (typeof v === 'object' && !Array.isArray(v) && 'error' in v) { problems.push(v.error); continue; }
    const no = typeof v !== 'string' ? null : name.includes('.') ? handProblem(f, v, now, PLANT_TZ) : null;
    if (no) problems.push(no);
    else {
      out[name] = v as Value;
      // LIMS-32, LIMS-50: a value an instrument or the CDS gives, typed instead, is marked typed and checked by a second person.
      if (captures(f, step.settings)) source[name] = typedSource(f);
    }
  }
  // 3. a CDS result file (LIMS-33, LIMS-49, LIMS-50): its peaks fill the step's chromatography fields.
  if (cds) {
    const got = cdsValues(l, block, step.settings, current, out, cds, reason);
    problems.push(...got.problems);
    for (const [name, v] of Object.entries(got.values)) {
      if (name in raw) { problems.push(`${block.fields.find((f) => f.name === name)!.label} comes from the CDS file: do not type it in the same save.`); continue; }
      const f = block.fields.find((y) => y.name === name)!;
      const r = readValue(f, v, unitFor(f));
      if (typeof r === 'object' && !Array.isArray(r) && 'error' in r) { problems.push(r.error); continue; }
      out[name] = r as Value;
      source[name] = got.source!;
    }
  }
  if (problems.length) throw new StepError(400, 'invalid_values', problems);
  return { values: out, source };
}

/**
 * LIMS-33, LIMS-49, LIMS-50: the values a CDS result file gives a step, from its bytes. The file must be one of the
 * layouts QLIMS reads, of the run the analysis' instrument run recorded, with injections of this sample that fit the
 * step. Its SHA-256 is worked out here; the file itself is not kept (the CDS is the raw-data record). An import over an
 * earlier one needs a reason, and the earlier one stays in the record.
 */
function cdsValues(l: LoadedAnalysis, block: Block, settings: Step['settings'], current: StepView, now: Record<string, Value>, cds: { name: string; content: string }, reason?: string) {
  const none = (...problems: string[]) => ({ values: {} as Record<string, string | string[]>, problems, source: undefined });
  if (!block.fields.some((f) => f.capture === 'cds' && captures(f, settings))) return none('This step takes no CDS result file.');
  const bytes = Buffer.from(cds.content, 'base64');
  if (!bytes.length) return none('The file is empty.');
  if (bytes.length > MAX_CDS_BYTES) return none(`The file is ${Math.round(bytes.length / 1024)} kB; a CDS result export is at most ${MAX_CDS_BYTES / 1024} kB: export only the peak table of this run.`);
  const file = parseCds(fileText(bytes));
  if ('error' in file) return none(file.error);
  // LIMS-49: the file is of the run the analysis recorded on its instrument run.
  const runs = l.doc.stages.flatMap((s, si) => s.steps.flatMap((t, ti) => (t.block.id !== 'instrument-run' ? [] : [currentValues(l.events.filter((e) => e.stage === si && e.step === ti)).values.runId])));
  const recorded = runs.filter((x): x is string => typeof x === 'string');
  if (runs.length && !recorded.length) return none('Record the run id on the instrument run step first: the file must be of that run.');
  if (recorded.length && !recorded.includes(file.run)) return none(`The file is of CDS run ${file.run}; the instrument run of this analysis recorded ${recorded.join(', ')}: import the result of that run.`);
  const std = (now.std ?? current.values.std) as { code?: string } | undefined;
  const names = [l.sample?.sampleNo, l.analysis.analysisNo].filter((x): x is string => !!x);
  const fill = cdsFill({ block, settings, names, standard: std?.code ?? null, file });
  if (fill.problems.length) return none(...fill.problems);
  const before = current.events.filter((e) => Object.values(e.payload.source ?? {}).some((s) => s.from === 'cds')).length;
  if (before && !reason) return none('This step already has an imported CDS result: give the reason for importing again. The earlier import stays in the record.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { values: fill.values, problems: [] as string[], source: importSource(imported(file, { name: cds.name, size: bytes.length, hash }, fill.injections, before + 1), l.now) };
}

const reason = z.string().trim().min(1).max(1000);
const values = z.record(z.string(), z.unknown());
// A CDS result file as the browser read it: its name and its bytes in base64 (the hash is worked out from the bytes).
const cdsFile = z.object({ name: z.string().trim().min(1).max(200), content: z.string().min(1).max(Math.ceil(MAX_CDS_BYTES / 3) * 4 + 8) });
const BODIES: Record<Action, z.ZodTypeAny> = {
  start: z.object({}),
  // A reason only with a CDS file imported again (LIMS-24: the values it replaces stay, with the reason).
  record: z.object({ values: values.optional(), cds: cdsFile.optional(), reason: reason.optional() }).refine((b) => (b.values || b.cds) && (!b.reason || b.cds), 'values or a CDS file'),
  // trained: the signer ticked "I am trained in …" while Recruitment was not reachable (shared/engine/training.ts).
  done: signBody.extend({ trained: z.boolean().optional() }),
  check: signBody.extend({ trained: z.boolean().optional() }),
  'send-back': z.object({ reason }),
  correct: z.object({ values: values.optional(), cds: cdsFile.optional(), reason }).refine((b) => b.values || b.cds, 'values or a CDS file'),
  'not-applicable': signBody.extend({ reason }),
  note: z.object({ text: reason, reference: z.string().trim().min(1).max(60).optional() }),
};
const ANALYSIS_BODIES: Record<AnalysisAction, z.ZodTypeAny> = {
  review: signBody,
  stop: signBody.extend({ reason }),
  'close-deviation': z.object({ note: z.number().int().positive(), reason }),
};
// GET /api/analyses/:id shows the last few events of each step; the full history is per step.
const LAST_EVENTS = 5;
const NAMES = Object.keys(ACTIONS) as Action[];
const ANALYSIS_NAMES = Object.keys(ANALYSIS_ACTIONS) as AnalysisAction[];
const flowOf = (doc: MasterDoc, k: StepKey) => doc.stages[k.stage]!.steps[k.step]!.flow.kind;
const context = (doc: MasterDoc, v: StepView, user: SessionUser) => ({ state: v.state, events: v.events, flow: flowOf(doc, v.key), user });

/** "My work": what in this analysis waits for the person, and where the analysis stands. Null when nothing does. */
function myWork(l: LoadedAnalysis, user: SessionUser) {
  const { stages, steps } = openSteps(l.doc, l.events, l.now);
  const bv = view(l);
  const title = (v: StepView) => stepTitle(l.doc, l.doc.stages[v.key.stage]!.steps[v.key.step]!);
  const stageName = (i: number) => l.doc.stages[i]?.name ?? '';
  const badges: { kind: 'check' | 'resign' | 'due' | 'late' | 'review'; step?: string; stage: string; title: string; at?: Date; timer?: string }[] = [];
  for (const v of steps) {
    // LIMS-41: the checker's own list holds only steps the person was not involved in.
    if (!refusal('check', context(l.doc, v, user))) badges.push({ kind: 'check', step: v.id, stage: stageName(v.key.stage), title: title(v) });
    if (v.needsResign && user.permissions.includes('lims.analysis.perform')) badges.push({ kind: 'resign', step: v.id, stage: stageName(v.key.stage), title: title(v) });
  }
  // A periodic check's badge names the check: "Coding check due in 59 min".
  const check = (t: Timer) => (t.kind === 'periodic' ? stepTitle(l.doc, l.doc.stages[t.key.stage]!.steps[t.key.step]!) : t.label);
  for (const t of timers(l.doc, l.events, l.now)) {
    if (t.kind === 'periodic' && t.state !== 'late') badges.push({ kind: 'due', step: `${t.key.stage}.${t.key.sub}.${t.key.step}.${t.key.round - 1}`, stage: stageName(t.key.stage), title: check(t), at: t.at, timer: t.kind });
  }
  for (const { timer: t } of lateItems(l.doc, l.events, l.now).filter((x) => !x.notes.length)) {
    badges.push({ kind: 'late', stage: stageName(t.key.stage), title: check(t), at: t.at, timer: t.kind });
  }
  if (!analysisRefusal('review', bv, user)) badges.push({ kind: 'review', stage: '', title: 'Review' });
  const now = steps.find((s) => s.state === 'in_progress') ?? steps.find((s) => s.state === 'open');
  const operates = user.permissions.includes('lims.analysis.perform') && bv.status === 'in progress';
  if (!operates && !badges.length) return null;
  return {
    id: l.analysis.id, analysisNo: l.analysis.analysisNo, methodCode: l.doc.header.code, methodName: l.doc.header.name, status: bv.status,
    issuedAt: l.analysis.issuedAt, stagesClosed: stages.filter((s) => s.closed).length, stageCount: stages.length,
    current: now ? { step: now.id, stage: stageName(now.key.stage), title: title(now), state: now.state } : null, badges,
  };
}

/**
 * A stage closed by this action, recorded once as a analysis event 'stage_closed' (the engine works it out: every step
 * done, checked or not applicable). A machine or room is in use by the analysis until the last stage that names it, or
 * may run in its room, has closed (equipment_use_v1).
 */
async function recordClosedStages(tx: Tx, id: number, before: readonly StageView[], person: number) {
  const l = (await loadAnalysis(tx, id))!;
  for (const s of openSteps(l.doc, l.events, l.now).stages) {
    if (!s.closed || before[s.index]?.closed) continue;
    const [e] = await tx<{ id: number }[]>`
      insert into analysis_events (analysis_id, kind, payload, person_id) values (${id}, 'stage_closed', ${tx.json({ stage: s.index })}, ${person})
      on conflict do nothing returning id::int`;
    if (e) await audit(tx, { actorId: person, action: 'analysis.stage_closed', objectType: 'analysis', objectId: id, new: { event: e.id, stage: s.index, name: s.name } });
  }
}

// A spec test's result in an analysis: the method's result step (stage/step/name), from its last signed round.
export interface TestResult { analysisId: number; analysisNo: string; status: string;
  // individual: the units' results (unitValues); figure: what the value is (figureOf).
  result: { shown: string; value: string; unit: string; pass?: boolean; individual?: string[]; figure?: 'AV' | 'mean' | 'result' } | null;
  // Who recorded, signed or checked its steps, and its open deviations (read from Deviations while linked).
  people: number[]; openDeviations: number; reviewedAt: Date | null; method: string;
  // LIMS-08: the container an identity analysis tested. LIMS-22: a result of an outside lab (analysisNo: its report number).
  container?: number | null; outside?: OutsideFacts }
/** An outside (contract) lab's result as typed from its report (LIMS-22), and its second person's check. */
export interface OutsideFacts { id: number; certificate?: boolean; lab: string; reportNo: string; fileName: string; size: number; sha256: string; enteredBy: string; enteredAt: Date; checkedBy: string | null; checkedAt: Date | null }
/**
 * The results of the individual units (BU locations, CU tablets) behind a result, in order, as recorded: the block's
 * `units` fields one after the other (10, or 30 after a second stage), else the contents a uniformity template worked
 * out (T14 by weight variation, to 1 decimal); null when the result has none.
 */
export function unitValues(block: Block, values: Record<string, Value>, r: Stored): string[] | null {
  if (block.units?.length) {
    const xs = block.units.flatMap((u) => { const x = values[u]; return Array.isArray(x) ? x.map((y) => y.value).filter((y) => y !== '') : []; });
    return xs.length ? xs : null;
  }
  const contents = (r as Record<string, unknown>).contents;
  return Array.isArray(contents) && contents.length ? contents.map((c) => new Dec(String(c)).toFixed(1)) : null;
}
/** What a result's figure is: the acceptance value of a uniformity test, the mean of readings, or the result itself. */
export function figureOf(block: Block | undefined, calc: string): 'AV' | 'mean' | 'result' {
  const tpl = block?.calcs.find((c) => c.name === calc)?.template;
  return tpl === 'T14' || (tpl === 'C6' && block?.id === 'content-uniformity') ? 'AV' : tpl === 'T7' ? 'mean' : 'result';
}
/** The analyses of a sample, per spec test they cover, oldest first, each with its status and its result once worked out. */
export async function sampleTestResults(q: Sql | Tx, sampleId: number, app?: FastifyInstance): Promise<Record<string, TestResult[]>> {
  const ids = await q<{ id: number; container: number | null }[]>`select id::int, container from analyses where sample_id = ${sampleId} order by id`;
  const out: Record<string, TestResult[]> = {};
  for (const { id, container } of ids) {
    const l = (await loadAnalysis(q, id))!;
    const { steps } = openSteps(l.doc, l.events, l.now);
    const v = analysisView(l.doc, l.events, l.analysisEvents, l.now, app ? (await deviationsRead(app, l)).read : undefined);
    const status = v.status;
    const reviewedAt = l.analysisEvents.find((e) => e.kind === 'reviewed')?.at ?? null;
    for (const t of l.sample?.tests ?? []) {
      const [sk, tk, name] = t.result.split('/') as [string, string, string];
      const at = steps.filter((x) => x.stageKey === sk && x.stepKey === tk && ['done', 'checked'].includes(x.state)).at(-1);
      const r = at?.results[name];
      const block = at ? findBlock(l.doc.stages.find((x) => x.key === sk)?.steps.find((x) => x.key === tk)?.block ?? { id: '', version: 0 }) : undefined;
      const units = at && block && r?.ok ? unitValues(block, at.values, r) : null;
      (out[t.key] ??= []).push({ analysisId: id, analysisNo: l.analysis.analysisNo, status, people: v.people, openDeviations: v.deviations.filter((d) => d.open).length,
        reviewedAt, method: l.doc.header.code, ...(container ? { container } : {}),
        // A judgement (Complies / does not comply, L35) is its word, with no number.
        result: r?.ok && typeof r.text === 'string' ? { shown: r.text, value: '', unit: '', ...(r.check ? { pass: r.check.pass } : {}), figure: 'result' as const }
        : r?.ok ? { shown: r.shown, value: r.value, unit: r.unit, ...(r.check ? { pass: r.check.pass } : {}),
          ...(units ? { individual: units } : {}), figure: figureOf(block, name) } : null });
    }
  }
  // LIMS-22: the results of outside labs, after the lab's own (the latest counts); a result counts once a second person checked it.
  for (const o of await outsideResults(q, sampleId)) (out[o.testKey] ??= []).push(o.result);
  return out;
}

export function analysisRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };

  // LIMS-01: issue a analysis from an effective master version, with the next number of the year (never reused).
  // LIMS-01: start an analysis from an effective method version, with the next number of the year (never reused). For a
  // sample (sampleId): the sample is in QC (received, not disposed), and the analysis covers the tests of the sample's
  // specification that this method does for the sample's purpose; their limits and values go into the method.
  app.post('/api/analyses', { preHandler: requirePermission('lims.analysis.perform') }, async (req, reply) => {
    // oosId: a retest of an OOS whose result QA invalidated (LIMS-24), linked to it.
    // container: LIMS-08, the container of a starting material an identity analysis is done on.
    const b = z.object({ masterVersionId: z.number().int().positive(), sampleId: z.number().int().positive().optional(), oosId: z.number().int().positive().optional(),
      container: z.number().int().min(1).max(100000).optional(), proof: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid' });
    const user = req.user!;
    try {
      const signer = await authenticateSigner(sql, app.proofKey, user, b.data, { objectType: 'master_version', objectId: b.data.masterVersionId, meaning: 'issued' });
      return await sql.begin(async (tx) => {
        const v = await masterVersion(tx, b.data.masterVersionId, true);
        if (v?.state !== 'effective' || v.kind !== 'method') throw new StepError(409, 'not_effective', ['Only an effective method version can be issued.']);
        // Approval will refuse a version with errors; until that workflow exists, issuing checks it too.
        const errors = masterChecks(v.doc).filter(blocking);
        if (errors.length) throw new StepError(409, 'master_has_errors', errors.map((p) => `${p.path}: ${p.message}`));
        let sample: { id: number; sampleNo: string; tests: string[] } | null = null;
        // A validation worksheet runs without a sample: its results go into a validation report (LIMS-02).
        if (b.data.sampleId !== undefined && v.doc.header.use === 'validation') throw new StepError(409, 'validation_worksheet', [`${v.doc.header.code} is a validation worksheet: it is run without a sample.`]);
        if (b.data.sampleId !== undefined) {
          await tx`select pg_advisory_xact_lock(${-b.data.sampleId}::bigint)`;
          const [x] = await tx<{ id: number; sampleNo: string; purpose: string; registeredBy: number; source: Source; spec: SpecDoc; containers: number | null;
            monitoring: { testKey: string } | null; request: { tests: { name: string }[] } | null }[]>`
            select s.id::int, s.sample_no as "sampleNo", s.purpose, s.registered_by::int as "registeredBy", s.source, v.doc as spec, s.containers, s.monitoring, s.request
            from samples s join master_versions v on v.id = s.spec_version_id where s.id = ${b.data.sampleId}`;
          if (!x) throw new StepError(404, 'no_such_sample', ['There is no such sample.']);
          const events = await tx<SampleEvent[]>`select kind, payload, person_id::int as person from sample_events where sample_id = ${x.id} order by id`;
          const status = sampleStatus({ registeredBy: x.registeredBy, byHand: sourceByHand(x.source) }, events);
          if (sampleDecision(events) === 'approved') throw new StepError(409, 'sample_approved', [APPROVED_SAMPLE]);
          // LIMS-07: a sample is tested once QC has received it; never after it is disposed of.
          if (!['received', 'stored', 'handed over'].includes(status)) throw new StepError(409, 'sample_not_in_qc', [`Sample ${x.sampleNo} is ${status}: it is tested once QC has received it.`]);
          const covers = testsForAnalysis(x.spec, v.masterId, x.purpose, identityContainers(x.spec, x.purpose, x.containers), b.data.container);
          if ('problem' in covers) throw new StepError(409, 'container', [covers.problem]);
          // A monitoring sample is of its plan's test; an in-process one of the tests its request names (sampleOnly).
          const only = sampleOnly(x.spec, x);
          const tests = covers.tests.filter((t) => !only || only.includes(t.key));
          if (covers.tests.length && !tests.length) throw new StepError(409, 'no_tests', [`${v.doc.header.code} does none of the tests sample ${x.sampleNo} is tested for.`]);
          if (!tests.length) throw new StepError(409, 'method_not_in_spec', [`The specification of sample ${x.sampleNo} has no ${x.purpose === 'stability' ? 'stability' : 'release'} test done by method ${v.doc.header.code}.`]);
          // The same test is not started twice: a second analysis waits until the open one is reviewed or stopped.
          const keys = tests.map((t) => t.key);
          const [again] = await tx<{ analysisNo: string }[]>`
            select a.analysis_no as "analysisNo" from analyses a
            where a.sample_id = ${x.id} and a.tests && ${keys}::text[] and a.container is not distinct from ${b.data.container ?? null}
              and not exists (select 1 from analysis_events e where e.analysis_id = a.id and e.kind in ('reviewed', 'stopped', 'invalidated'))
            order by a.id limit 1`;
          if (again) throw new StepError(409, 'analysis_open', [`An analysis of this test is already open: ${again.analysisNo}.`]);
          sample = { id: x.id, sampleNo: x.sampleNo, tests: keys };
        }
        const [c] = await tx<{ n: number; yy: string }[]>`
          insert into analysis_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
          on conflict (year) do update set last_no = analysis_counters.last_no + 1
          returning last_no as n, right(year::text, 2) as yy`;
        const analysisNo = `${app.analysisPrefix}${c!.yy}${String(c!.n).padStart(5, '0')}`;
        const [row] = await tx<{ id: number }[]>`
          insert into analyses (analysis_no, master_version_id, issued_by, sample_id, tests, container)
          values (${analysisNo}, ${v.id}, ${user.id}, ${sample?.id ?? null}, ${sample?.tests ?? []}, ${sample ? b.data.container ?? null : null}) returning id::int`;
        const content = { analysisNo, masterVersionId: v.id, masterId: v.masterId, versionNo: v.versionNo, method: v.doc.header.code,
          ...(sample ? { sample: sample.sampleNo, tests: sample.tests, ...(b.data.container ? { container: b.data.container } : {}) } : {}) };
        await sign(tx, { signer, objectType: 'analysis', objectId: row!.id, meaning: 'issued', content, shownHash: contentHash('analysis', row!.id, content) });
        await audit(tx, { actorId: user.id, action: 'analysis.issued', objectType: 'analysis', objectId: row!.id, new: content });
        if (b.data.oosId !== undefined) {
          const no = await linkRetest(tx, b.data.oosId, { id: row!.id, analysisNo, sampleId: sample?.id ?? null, tests: sample?.tests ?? [] }, user.id);
          if (no) throw new StepError(409, 'not_a_retest', [no]);
        }
        return { id: row!.id, analysisNo };
      });
    } catch (e) {
      return send(reply, e);
    }
  });

  // My work: the analyses not yet reviewed or stopped, with what waits for this person.
  app.get('/api/analyses', anyUser, async (req) => {
    const ids = await sql<{ id: number }[]>`
      select b.id::int from analyses b
      where not exists (select 1 from analysis_events e where e.analysis_id = b.id and e.kind in ('reviewed', 'stopped', 'invalidated'))
      order by b.issued_at desc limit 100`;
    const out = [];
    for (const { id } of ids) {
      const l = await loadAnalysis(sql, id);
      const w = l && myWork(l, req.user!);
      if (w) out.push(w);
    }
    return out;
  });

  // Done on the floor: the latest analyses the person recorded or signed a step of whose steps are all done (waiting for
  // production approval, or approved, released or rejected) and that are not in their work list, so the finished
  // record stays one tap away from My work (owner, 17 Nov 2026).
  app.get('/api/analyses/finished', anyUser, async (req) => {
    const ids = await sql<{ id: number }[]>`
      select b.id::int from analyses b
      where exists (select 1 from step_events e where e.analysis_id = b.id and e.person_id = ${req.user!.id})
      order by b.issued_at desc limit 20`;
    const out = [];
    for (const { id } of ids) {
      const l = (await loadAnalysis(sql, id))!;
      if (view(l).status === 'in progress' || myWork(l, req.user!)) continue;
      if (out.length < 10) out.push({ id, analysisNo: l.analysis.analysisNo, methodCode: l.doc.header.code, methodName: l.doc.header.name, status: view(l).status });
    }
    return out;
  });

  // To review (LIMS-18): the complete analyses waiting for a second person's review, oldest first, and those still in
  // progress, which the reviewer may stop.
  app.get('/api/analyses/to-review', { preHandler: requirePermission('lims.analysis.review') }, async (req) => {
    const ids = await sql<{ id: number }[]>`
      select b.id::int from analyses b
      where not exists (select 1 from analysis_events e where e.analysis_id = b.id and e.kind in ('reviewed', 'stopped', 'invalidated'))
      order by b.issued_at limit 200`;
    const out = [];
    for (const { id } of ids) {
      const l = (await loadAnalysis(sql, id))!;
      const bv = view(l, (await deviationsRead(app, l)).read);
      const last = l.events.at(-1);
      out.push({ id, analysisNo: l.analysis.analysisNo, methodCode: l.doc.header.code, methodName: l.doc.header.name, status: bv.status,
        since: last?.at ?? l.analysis.issuedAt, by: last?.personName ?? '', openDeviations: bv.deviations.filter((d) => d.open).length,
        actions: ANALYSIS_NAMES.filter((a) => a !== 'close-deviation' && !analysisRefusal(a, bv, req.user!)) });
    }
    return out;
  });

  // The analysis with, per step, its state, current values, why it is not open, the actions open to this person, and
  // the timers. All computed from the step events; nothing is stored.
  app.get<{ Params: { id: string } }>('/api/analyses/:id', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadAnalysis(sql, id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const v = await masterVersion(sql, l.analysis.masterVersionId);
    const { stages, steps } = openSteps(l.doc, l.events, l.now);
    const dv = await deviationsRead(app, l);
    const bv = view(l, dv.read);
    // A reviewed or stopped analysis takes no more step actions and runs no more timers.
    const decided = bv.status === 'reviewed' || bv.status === 'stopped' || bv.status === 'invalidated';
    return {
      sample: l.sample,
      analysis: { ...l.analysis, ...bv, deviationsLink: dv.link, contentHash: analysisHash(l), actions: ANALYSIS_NAMES.filter((a) => a !== 'close-deviation' && !analysisRefusal(a, bv, req.user!)),
        stopped: l.analysisEvents.find((e) => e.kind === 'stopped') ?? null, invalidated: l.analysisEvents.find((e) => e.kind === 'invalidated') ?? null },
      // The OOS this analysis opened or is a retest of (LIMS-23, LIMS-24).
      oos: await oosOfAnalysis(sql, l.analysis.id),
      // The server time: the screens count timers down on the server clock.
      now: l.now, master: { id: v!.id, masterId: v!.masterId, versionNo: v!.versionNo, doc: l.doc }, stages, timers: decided ? [] : timers(l.doc, l.events, l.now),
      steps: steps.map((s) => {
        const { events, replaced: _, ...current } = s;
        return {
          ...current, events: events.slice(-LAST_EVENTS), contentHash: stepHash(l.analysis.id, s),
          // The label questions of what was entered by hand (shared/engine/links.ts).
          handFields: handFields(findBlock(l.doc.stages[s.key.stage]!.steps[s.key.step]!.block)?.fields ?? [], s.source),
          actions: decided ? [] : NAMES.filter((a) => !refusal(a, context(l.doc, s, req.user!))),
          problems: s.state === 'in_progress' ? doneProblems(l.doc, s, l.now) : [],
        };
      }),
    };
  });

  // The full history of one step, with every correction (the original value, the new one, the reason).
  app.get<{ Params: { id: string; key: string } }>('/api/analyses/:id/steps/:key/events', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadAnalysis(sql, id);
    const s = l && openSteps(l.doc, l.events, l.now).steps.find((x) => x.id === req.params.key);
    return s ? { events: s.events, replaced: s.replaced, inputChanged: s.inputChanged } : reply.code(404).send({ error: 'not_found' });
  });

  // LIMS-18, LIMS-19: what the reviewer reviews: corrections, sent-backs, late items, values out of limits with
  // their notes, deviation notes and their status, steps not applicable, and every signature of the analysis.
  app.get<{ Params: { id: string } }>('/api/analyses/:id/review', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadAnalysis(sql, id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const signatures = await analysisSignatures(sql, l.analysis.id);
    const names = new Map(l.events.map((e) => [e.person, e.personName]));
    const dv = await deviationsRead(app, l);
    const r = review(l.doc, l.events, l.analysisEvents, l.now, dv.read);
    // Deviations that name this analysis in the Deviations system but no note of the record links.
    const named = await app.links.deviations.byBatch(l.analysis.analysisNo, l.sample?.lotNo ?? '');
    const unlinked = named.state === 'ok' ? named.value.filter((d) => !r.deviations.some((x) => x.reference === d.number)) : [];
    return { status: view(l, dv.read).status, ...r, deviationsLink: dv.link, unlinked, signatures,
      corrections: r.corrections.map((c) => ({ ...c, personName: names.get(c.person) ?? null })),
      hand: r.hand.map((h) => ({ ...h, personName: names.get(h.person) ?? null })),
      captured: r.captured.map((h) => ({ ...h, personName: names.get(h.person) ?? null })),
      trainingTyped: r.trainingTyped.map((h) => ({ ...h, personName: names.get(h.person) ?? null })) };
  });

  // The deviations that name this analysis in the Deviations system, for the note's pick list (pull, don't type).
  app.get<{ Params: { id: string } }>('/api/analyses/:id/deviations', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const [b] = id === null ? [] : await sql<{ analysisNo: string; lotNo: string | null }[]>`
      select a.analysis_no as "analysisNo", s.lot_no as "lotNo" from analyses a left join samples s on s.id = a.sample_id where a.id = ${id}`;
    if (!b) return reply.code(404).send({ error: 'not_found' });
    const r = await app.links.deviations.byBatch(b.analysisNo, b.lotNo ?? '');
    return { link: r.state, deviations: r.state === 'ok' ? r.value : [] };
  });

  // TA-10, pull don't type (owner, 17 Nov 2026): the analysis that last used a room or line before this one, from this
  // product's own records, for the line clearance's "previous product and analysis" (one tap; typed only when unknown).
  app.get<{ Params: { id: string }; Querystring: { item?: string } }>('/api/analyses/:id/previous-use', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const item = String(req.query.item ?? '');
    if (id === null || !item) return reply.code(404).send({ error: 'not_found' });
    const [u] = await sql<{ analysisNo: string; productCode: string | null; productName: string | null }[]>`
      select b.analysis_no as "analysisNo", v.doc->'header'->>'code' as "productCode", v.doc->'header'->>'name' as "productName"
      from step_events e join analyses b on b.id = e.analysis_id join master_versions v on v.id = b.master_version_id
      where e.analysis_id <> ${id} and e.kind in ('value', 'corrected') and b.issued_at < (select issued_at from analyses where id = ${id})
        and exists (select 1 from jsonb_each(e.payload->'values') f where jsonb_typeof(f.value) = 'object' and f.value->>'itemId' = ${item})
      order by e.at desc limit 1`;
    return { previous: u ? { ...u, text: `${[u.productCode, u.productName].filter(Boolean).join(' · ')}, analysis ${u.analysisNo}` } : null };
  });

  // Before a step that names a training is signed: the person's training in it, as Recruitment answers now (the sign
  // dialog shows it; the signature reads it again). Link off or down: the dialog asks for the tick.
  app.get<{ Params: { id: string; key: string } }>('/api/analyses/:id/steps/:key/training', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const key = parseKey(req.params.key);
    const l = id === null || key === null ? null : await loadAnalysis(sql, id);
    const st = key && l?.doc.stages[key.stage]?.steps[key.step];
    if (!l || !st) return reply.code(404).send({ error: 'not_found' });
    if (!st.training) return { skill: null };
    const read = await app.links.recruitment.training(req.user!.username, st.training.code);
    const t = trainingCheck(st.training, req.user!.fullName, read, false);
    return { skill: st.training, link: read.state, ok: t.ok, ...(t.ok ? { training: t.training } : { message: t.message }) };
  });

  // The skills Recruitment trains people in, for the designer's "Training needed" pick list (pull, don't type).
  app.get('/api/recruitment/skills', anyUser, async () => {
    const r = await app.links.recruitment.skills();
    return { link: r.state, skills: r.state === 'ok' ? r.value : [] };
  });

  // The lots of a material MMS has released and in date today, for the lot's pick list.
  app.get<{ Querystring: { material?: string } }>('/api/mms/lots', anyUser, async (req) => {
    const r = await app.links.mms.usable(String(req.query.material ?? ''), new Date().toLocaleDateString('en-CA', { timeZone: PLANT_TZ }));
    return { link: r.state, lots: r.state === 'ok' ? r.value : [] };
  });

  // The machines and rooms the Logbook has (their master-data ids), for the pick lists: while the link answers, only
  // these are offered (any other is refused, server/pull.ts); absent or down, every one is offered and typed by hand.
  app.get('/api/logbook/items', anyUser, async () => {
    const r = await app.links.logbook.known();
    return { link: r.state, items: r.state === 'ok' ? r.value : [] };
  });

  // LIMS-12: the machines Qualification has (their master-data ids) and why each may not be used today, for the pick
  // lists: while the link answers only qualified ones are offered; absent or down, every one, its label answered by hand.
  app.get('/api/qual/instruments', anyUser, async () => {
    const r = await app.links.qual.picks(new Date().toLocaleDateString('en-CA', { timeZone: PLANT_TZ }));
    return { link: r.state, items: r.state === 'ok' ? r.value : [] };
  });

  // LIMS-51: the analysis record as a PDF: a complete copy with its values, calculations, changes, notes and signatures.
  app.get<{ Params: { id: string } }>('/api/analyses/:id/pdf', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadAnalysis(sql, id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const def = analysisRecordDoc({ ...await recordInput(sql, l), deviationsRead: (await deviationsRead(app, l)).read }, req.user!.fullName, new Date(), app.demo);
    return sendPdf(reply, `analysis-record-${l.analysis.analysisNo}`, await render(def));
  });

  // The review and a stop (each an e-signature), and closing a deviation note typed by hand.
  for (const action of ANALYSIS_NAMES) {
    const rule = ANALYSIS_ACTIONS[action];
    app.post<{ Params: { id: string } }>(`/api/analyses/:id/${action}`, anyUser, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = ANALYSIS_BODIES[action].safeParse(req.body);
      if (id === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
      const b = body.data as { proof?: string; contentHash?: string; reason?: string; note?: number };
      const user = req.user!;
      try {
        const signer = rule.meaning ? await authenticateSigner(sql, app.proofKey, user, { proof: b.proof! }, { objectType: 'analysis', objectId: id, meaning: rule.meaning }) : null;
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(${id}::bigint)`;
          const l = await loadAnalysis(tx, id);
          if (!l) throw new StepError(404, 'not_found');
          if (action === 'review' && l.analysis.sampleId !== null) {
            const ev = await tx<SampleEvent[]>`select kind, payload, person_id::int as person from sample_events where sample_id = ${l.analysis.sampleId} order by id`;
            if (sampleDecision(ev) === 'approved') throw new StepError(409, 'sample_approved', [APPROVED_SAMPLE]);
          }
          const no = analysisRefusal(action, view(l, (await deviationsRead(app, l)).read), user, b.note);
          if (no) throw new StepError(no.status, no.error, no.problems);
          if (signer && b.contentHash !== analysisHash(l)) throw new StepError(409, 'content_changed', ['The analysis record changed since you opened it.']);
          const payload = { ...(b.reason ? { reason: b.reason } : {}), ...(b.note ? { note: b.note } : {}) };
          const [ev] = await tx<{ id: number }[]>`
            insert into analysis_events (analysis_id, kind, payload, person_id) values (${id}, ${rule.event}, ${tx.json(payload)}, ${user.id}) returning id::int`;
          if (signer && rule.meaning) {
            const content = { ...analysisContent(l), action, ...payload };
            await sign(tx, { signer, objectType: 'analysis_event', objectId: ev!.id, meaning: rule.meaning, content, shownHash: contentHash('analysis_event', ev!.id, content) });
          }
          await audit(tx, { actorId: user.id, action: `analysis.${rule.event}`, objectType: 'analysis', objectId: id, new: { event: ev!.id, ...payload }, reason: b.reason ?? null });
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) {
        return send(reply, e);
      }
    });
  }

  // One route per action. Each does the same five things: read the step's events, work out its state, check the
  // action is allowed (state, permission, checker not the performer), insert one event (and its signature), audit.
  for (const action of NAMES) {
    const rule = ACTIONS[action];
    app.post<{ Params: { id: string; key: string } }>(`/api/analyses/:id/steps/:key/${action}`, anyUser, async (req, reply) => {
      const id = parseId(req.params.id);
      const key = parseKey(req.params.key);
      const body = BODIES[action].safeParse(req.body);
      if (id === null || key === null || !body.success) return reply.code(400).send({ error: 'invalid', problems: body.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [] });
      const b = body.data as { proof?: string; contentHash?: string; reason?: string; text?: string; reference?: string; values?: Record<string, unknown>; cds?: { name: string; content: string }; trained?: boolean };
      const user = req.user!;
      try {
        const signer = rule.meaning ? await authenticateSigner(sql, app.proofKey, user, { proof: b.proof! }, { objectType: 'analysis', objectId: id, meaning: rule.meaning }) : null;
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(${id}::bigint)`;
          // 1. the step's events, 2. its state
          const l = await loadAnalysis(tx, id);
          if (!l) throw new StepError(404, 'not_found');
          const before = openSteps(l.doc, l.events, l.now);
          const v = before.steps.find((s) => s.id === req.params.key);
          if (!v) throw new StepError(404, 'no_such_step');
          // Once reviewed or stopped the record is closed to changes.
          const decided = l.analysisEvents.find((e) => e.kind === 'reviewed' || e.kind === 'stopped' || e.kind === 'invalidated');
          if (decided) throw new StepError(409, 'analysis_closed', [`The analysis is ${decided.kind}.`]);
          // 3. allowed?
          const no = refusal(action, context(l.doc, v, user));
          if (no) throw new StepError(no.status, no.error, [no.message]);
          if (action === 'done') { const p = doneProblems(l.doc, v, l.now); if (p.length) throw new StepError(409, 'not_ready', p); }
          if (signer && b.contentHash !== stepHash(id, v)) throw new StepError(409, 'content_changed', ['The step changed since you opened it.']);
          let payload: Record<string, unknown> = {};
          const uses: number[] = [];
          if (b.values || b.cds) {
            const typed = await readValues(app, tx, l, key, b.values ?? {}, v, b.cds, b.reason);
            payload = { values: typed.values, results: evaluate(l.doc, l.events, key, { ...v.values, ...typed.values }, uses), uses,
              ...(Object.keys(typed.source).length ? { source: typed.source } : {}) };
          }
          // Signed again after an input changed: the results worked out again, as shown, are stored with the signature.
          if (action === 'done' && v.inputChanged.length) payload = { results: evaluate(l.doc, l.events, key, v.values, uses), uses };
          // Only trained people sign (owner, 17 Nov 2026): the signer's training in the step's skill, read from Recruitment now.
          const skill = l.doc.stages[key.stage]!.steps[key.step]!.training;
          if (skill && (action === 'done' || action === 'check')) {
            const t = trainingCheck(skill, user.fullName, await app.links.recruitment.training(user.username, skill.code), b.trained === true);
            if (!t.ok) throw new StepError(409, t.error, [t.message]);
            payload.training = t.training;
          }
          if (b.reason) payload.reason = b.reason;
          if (b.text) payload.text = b.text;
          // Where the note was written, in words, for the deviation filed from it (deviation_note_v1.step).
          if (action === 'note') payload.where = stepLabel(l.doc, key);
          // Where the step is, in words, for the uses other products read (equipment_use_v1, material_use_v1: step_name).
          if (action === 'start') payload.where = stepPlace(l.doc, key);
          if (b.reference) {
            // The reference must be a deviation of the Deviations system while it answers; else typed, and QA closes it by hand.
            const r = await app.links.deviations.byNumbers([b.reference]);
            const d = r.state === 'ok' ? r.value.get(b.reference) : undefined;
            if (r.state === 'ok' && !d) throw new StepError(409, 'unknown_deviation', [`${b.reference} is not in the DIVE system: pick one of the deviations of this analysis, or check the number.`]);
            payload.reference = b.reference;
            payload.source = { reference: d ? { from: 'deviations', asOf: null, shown: `${d.number}: ${d.title ?? ''} (${d.status})` } : { from: 'hand', link: 'deviations', state: r.state as 'absent' | 'down' } };
          }
          // 4. one event, and its signature
          const [ev] = await tx<{ id: number }[]>`
            insert into step_events (analysis_id, stage, sub, step, round, kind, payload, person_id)
            values (${id}, ${key.stage}, ${key.sub}, ${key.step}, ${key.round}, ${rule.event}, ${tx.json(payload as never)}, ${user.id})
            returning id::int`;
          if (signer && rule.meaning) {
            const content = { ...stepContent(id, v), action, ...(b.reason ? { reason: b.reason } : {}), ...(payload.training ? { training: payload.training as Training } : {}) };
            await sign(tx, { signer, objectType: 'step_event', objectId: ev!.id, meaning: rule.meaning, content, shownHash: contentHash('step_event', ev!.id, content) });
          }
          // 5. audit
          await audit(tx, { actorId: user.id, action: `step.${rule.event}`, objectType: 'analysis', objectId: id, new: { step: v.id, event: ev!.id, ...payload }, reason: b.reason ?? null });
          await recordClosedStages(tx, id, before.stages, user.id);
          // LIMS-23: a signed result of a spec test out of its limit opens an OOS at once.
          if (action === 'done') await openOos(tx, id, user.id);
          return { ok: true, eventId: ev!.id };
        });
      } catch (e) {
        return send(reply, e);
      }
    });
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    analysisPrefix: string;
  }
}
