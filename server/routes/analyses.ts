import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission, type SessionUser } from '../auth.js';
import { usableItem } from '../master.js';
import { machineRefusal, roomRefusal } from '../../shared/engine/picks.js';
import { handProblem, pullItem, pullLot, pulledWords } from '../pull.js';
import { SignError, authenticateSigner, contentHash, sign, signBody } from '../signatures.js';
import { masterVersion } from './masters.js';
import { analysisRecordDoc, type RecordInput, type Signature } from '../analysis-record.js';
import { render, sendPdf } from '../pdf.js';
import { findBlock } from '../../shared/blocks/index.js';
import { blocking, masterChecks } from '../../shared/master/checks.js';
import type { MasterDoc } from '../../shared/master/schema.js';
import {
  ACTIONS, ANALYSIS_ACTIONS, CERTIFICATE, DEVIATION_DONE, LINK_OF, analysisRefusal, filedKey, stepLabel, stepPlace, stepTitle, handFields, isHand, analysisView, doneProblems, evaluate, lateItems, openSteps, parseKey, readValue, refusal, review, timers,
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

export interface LoadedAnalysis {
  analysis: { id: number; analysisNo: string; masterVersionId: number; issuedBy: number; issuedAt: Date };
  doc: MasterDoc;
  events: (StepEvent & { personName: string | null })[];
  analysisEvents: (AnalysisEvent & { personName: string })[];
  now: Date;
}

/** The analysis, its master document and every step event, with the database time. */
export async function loadAnalysis(q: Sql | Tx, id: number): Promise<LoadedAnalysis | null> {
  const [b] = await q<(LoadedAnalysis['analysis'] & { doc: MasterDoc; now: Date })[]>`
    select b.id::int, b.analysis_no as "analysisNo", b.master_version_id::int as "masterVersionId", b.issued_by::int as "issuedBy",
      b.issued_at as "issuedAt", v.doc, now() as now
    from analyses b join master_versions v on v.id = b.master_version_id where b.id = ${id}`;
  if (!b) return null;
  const events = await q<LoadedAnalysis['events']>`
    select e.id::int, e.stage, e.sub, e.step, e.round, e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at
    from step_events e left join users u on u.id = e.person_id where e.analysis_id = ${id} order by e.id`;
  const analysisEvents = await q<LoadedAnalysis['analysisEvents']>`
    select e.id::int, e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at
    from analysis_events e join users u on u.id = e.person_id where e.analysis_id = ${id} and e.kind <> 'stage_closed' order by e.id`;
  const { doc, now, ...analysis } = b;
  return { analysis, doc, events: [...events], analysisEvents: [...analysisEvents], now };
}

// What a analysis-level signer is shown: the record as it stands, by its last events (the signature is refused if
// anything was added since).
const analysisContent = (l: LoadedAnalysis) => ({ analysis: l.analysis.id, analysisNo: l.analysis.analysisNo, lastStepEvent: l.events.at(-1)?.id ?? 0, lastAnalysisEvent: l.analysisEvents.at(-1)?.id ?? 0 });
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
async function readValues(app: FastifyInstance, tx: Tx, doc: MasterDoc, key: StepKey, raw: Record<string, unknown>, now: Date, current: StepView, analysisNo: string) {
  const stage = doc.stages[key.stage]!;
  const step = stage.steps[key.step]!;
  const block = findBlock(step.block)!;
  const taken = new Set<string>();
  const out: Record<string, Value> = {};
  const source: Record<string, Source> = {};
  const problems: string[] = [];
  // 1. the linked values: machines, rooms and lots
  for (const [name, x] of Object.entries(raw)) {
    const f = block.fields.find((y) => y.name === name);
    if (!f || !LINK_OF[f.kind]) continue;
    let pulled;
    if (f.kind === 'machine' || f.kind === 'room') {
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
  for (const [name, x] of Object.entries(raw)) {
    const f = fields.find((y) => y.name === name);
    if (!f) { problems.push(`There is no field ${name}`); continue; }
    if (LINK_OF[f.kind]) continue;
    if (taken.has(name)) continue;
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
    else out[name] = v as Value;
  }
  if (problems.length) throw new StepError(400, 'invalid_values', problems);
  return { values: out, source };
}

const reason = z.string().trim().min(1).max(1000);
const values = z.record(z.unknown());
const BODIES: Record<Action, z.ZodTypeAny> = {
  start: z.object({}),
  record: z.object({ values }),
  // trained: the signer ticked "I am trained in …" while Recruitment was not reachable (shared/engine/training.ts).
  done: signBody.extend({ trained: z.boolean().optional() }),
  check: signBody.extend({ trained: z.boolean().optional() }),
  'send-back': z.object({ reason }),
  correct: z.object({ values, reason }),
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

export function analysisRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };

  // LIMS-01: issue a analysis from an effective master version, with the next number of the year (never reused).
  app.post('/api/analyses', { preHandler: requirePermission('lims.analysis.perform') }, async (req, reply) => {
    const b = z.object({ masterVersionId: z.number().int().positive(), proof: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid' });
    const user = req.user!;
    try {
      const signer = await authenticateSigner(sql, app.proofKey, user, b.data, { objectType: 'master_version', objectId: b.data.masterVersionId, meaning: 'issued' });
      return await sql.begin(async (tx) => {
        const v = await masterVersion(tx, b.data.masterVersionId, true);
        if (v?.state !== 'effective') throw new StepError(409, 'not_effective', ['Only an effective master version can be issued.']);
        // Approval will refuse a version with errors; until that workflow exists, issuing checks it too.
        const errors = masterChecks(v.doc).filter(blocking);
        if (errors.length) throw new StepError(409, 'master_has_errors', errors.map((p) => `${p.path}: ${p.message}`));
        const [c] = await tx<{ n: number; yy: string }[]>`
          insert into analysis_counters (year, last_no) values (extract(year from now() at time zone ${PLANT_TZ})::int, 1)
          on conflict (year) do update set last_no = analysis_counters.last_no + 1
          returning last_no as n, right(year::text, 2) as yy`;
        const analysisNo = `${app.analysisPrefix}${c!.yy}${String(c!.n).padStart(5, '0')}`;
        const [row] = await tx<{ id: number }[]>`
          insert into analyses (analysis_no, master_version_id, issued_by) values (${analysisNo}, ${v.id}, ${user.id}) returning id::int`;
        const content = { analysisNo, masterVersionId: v.id, masterId: v.masterId, versionNo: v.versionNo, method: v.doc.header.code };
        await sign(tx, { signer, objectType: 'analysis', objectId: row!.id, meaning: 'issued', content, shownHash: contentHash('analysis', row!.id, content) });
        await audit(tx, { actorId: user.id, action: 'analysis.issued', objectType: 'analysis', objectId: row!.id, new: content });
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
      where not exists (select 1 from analysis_events e where e.analysis_id = b.id and e.kind in ('reviewed', 'stopped'))
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
      where not exists (select 1 from analysis_events e where e.analysis_id = b.id and e.kind in ('reviewed', 'stopped'))
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
    const decided = bv.status === 'reviewed' || bv.status === 'stopped';
    return {
      analysis: { ...l.analysis, ...bv, deviationsLink: dv.link, contentHash: analysisHash(l), actions: ANALYSIS_NAMES.filter((a) => a !== 'close-deviation' && !analysisRefusal(a, bv, req.user!)),
        stopped: l.analysisEvents.find((e) => e.kind === 'stopped') ?? null },
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
    const named = await app.links.deviations.byAnalysis(l.analysis.analysisNo);
    const unlinked = named.state === 'ok' ? named.value.filter((d) => !r.deviations.some((x) => x.reference === d.number)) : [];
    return { status: view(l, dv.read).status, ...r, deviationsLink: dv.link, unlinked, signatures,
      corrections: r.corrections.map((c) => ({ ...c, personName: names.get(c.person) ?? null })),
      hand: r.hand.map((h) => ({ ...h, personName: names.get(h.person) ?? null })),
      trainingTyped: r.trainingTyped.map((h) => ({ ...h, personName: names.get(h.person) ?? null })) };
  });

  // The deviations that name this analysis in the Deviations system, for the note's pick list (pull, don't type).
  app.get<{ Params: { id: string } }>('/api/analyses/:id/deviations', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const [b] = id === null ? [] : await sql<{ analysisNo: string }[]>`select analysis_no as "analysisNo" from analyses where id = ${id}`;
    if (!b) return reply.code(404).send({ error: 'not_found' });
    const r = await app.links.deviations.byAnalysis(b.analysisNo);
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
      const b = body.data as { proof?: string; contentHash?: string; reason?: string; text?: string; reference?: string; values?: Record<string, unknown>; trained?: boolean };
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
          const decided = l.analysisEvents.find((e) => e.kind === 'reviewed' || e.kind === 'stopped');
          if (decided) throw new StepError(409, 'analysis_closed', [`The analysis is ${decided.kind}.`]);
          // 3. allowed?
          const no = refusal(action, context(l.doc, v, user));
          if (no) throw new StepError(no.status, no.error, [no.message]);
          if (action === 'done') { const p = doneProblems(l.doc, v, l.now); if (p.length) throw new StepError(409, 'not_ready', p); }
          if (signer && b.contentHash !== stepHash(id, v)) throw new StepError(409, 'content_changed', ['The step changed since you opened it.']);
          let payload: Record<string, unknown> = {};
          const uses: number[] = [];
          if (b.values) {
            const typed = await readValues(app, tx, l.doc, key, b.values, l.now, v, l.analysis.analysisNo);
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
            if (r.state === 'ok' && !d) throw new StepError(409, 'unknown_deviation', [`${b.reference} is not in the Deviations system: pick one of the deviations of this analysis, or check the number.`]);
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
