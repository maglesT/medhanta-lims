import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql, Tx } from '../db.js';
import { audit } from '../audit.js';
import { parseId, requirePermission, type Permission, type SessionUser } from '../auth.js';
import { usableItem, type Master } from '../master.js';
import { SignError, authenticateSigner, contentHash, sign, type Meaning } from '../signatures.js';
import { BLOCKS } from '../../shared/blocks/index.js';
import { blocking, masterChecks, type Problem } from '../../shared/master/checks.js';
import { specChecks, specSchema, type SpecDoc } from '../../shared/master/spec.js';
import { protocolChecks, protocolSchema, type ProtocolDoc } from '../../shared/master/protocol.js';
import { monitoringChecks, monitoringSchema, type MonitoringDoc } from '../../shared/master/monitoring.js';
import { limitText } from '../../shared/master/spec.js';
import { masterSchema, type MasterDoc, type MasterState } from '../../shared/master/schema.js';
import { isHand, type Source } from '../../shared/engine/links.js';
import { CHANGE_STEPS, approvedChange, namesProduct } from '../links.js';

// Master versions: the model, the table, the draft routes, and the review and approval workflow (LIMS-01). A version
// leaves draft only through that workflow (or, in tests, the database owner).

// A version of a method, a specification, a stability protocol or a monitoring plan (kind): the same table, review and
// approval (LIMS-01, LIMS-26, LIMS-36).
interface VersionBase { id: number; masterId: number; versionNo: number; state: MasterState; createdBy: number; createdAt: Date }
export type VersionRow = VersionBase & ({ kind: 'method'; doc: MasterDoc } | { kind: 'spec'; doc: SpecDoc } | { kind: 'protocol'; doc: ProtocolDoc }
  | { kind: 'monitoring'; doc: MonitoringDoc });
type AnyDoc = MasterDoc | SpecDoc | ProtocolDoc | MonitoringDoc;
export type Kind = VersionRow['kind'];

export async function masterVersion(q: Sql | Tx, id: number, lock = false): Promise<VersionRow | undefined> {
  const rows = lock
    ? await q<VersionRow[]>`select id::int, master_id::int as "masterId", version_no as "versionNo", state, kind, doc, created_by::int as "createdBy", created_at as "createdAt"
        from master_versions where id = ${id} for share`
    : await q<VersionRow[]>`select id::int, master_id::int as "masterId", version_no as "versionNo", state, kind, doc, created_by::int as "createdBy", created_at as "createdAt"
        from master_versions where id = ${id}`;
  return rows[0];
}

// A method names nothing of master data in its header (its instruments are picked on the floor). A specification's or
// protocol's material or product must be active in master data now; its code and name are copied from it (PL-08). A
// protocol's specification version: its number and version are read from it (pull, don't type).
async function withMasterData(master: Master, kind: Kind, doc: AnyDoc, q: Sql | Tx): Promise<AnyDoc> {
  if (kind === 'method') return doc;
  if (kind === 'monitoring') return withPlanData(master, doc as MonitoringDoc, q);
  const s = doc as SpecDoc | ProtocolDoc;
  const item = s.header.of === 'product' ? usableItem(await master.products(), s.header.itemId, 'product') : usableItem(await master.materials(), s.header.itemId, 'material');
  const out = { ...s, header: { ...s.header, code: item.code, name: item.name } } as AnyDoc;
  if (kind !== 'protocol') return out;
  const p = out as ProtocolDoc;
  if (!p.spec) return p;
  const [v] = await q<{ number: string; versionNo: number }[]>`
    select doc->'header'->>'number' as number, version_no as "versionNo" from master_versions where id = ${p.spec.versionId} and kind = 'spec'`;
  return { ...p, spec: v ? { versionId: p.spec.versionId, number: v.number, versionNo: v.versionNo } : p.spec };
}
const schemaOf = (kind: Kind) => (kind === 'spec' ? specSchema : kind === 'protocol' ? protocolSchema : kind === 'monitoring' ? monitoringSchema : masterSchema);
const kindOf = (k: unknown): Kind => (k === 'spec' || k === 'protocol' || k === 'monitoring' ? k : 'method');

/** The latest approved or effective version of each of these specifications (a plan's tests, LIMS-36). */
export async function planSpecs(q: Sql | Tx, masterIds: number[]) {
  const ids = [...new Set(masterIds)];
  return ids.length ? [...await q<{ masterId: number; id: number; versionNo: number; state: string; doc: SpecDoc }[]>`
    select distinct on (master_id) master_id::int as "masterId", id::int, version_no as "versionNo", state, doc from master_versions
    where kind = 'spec' and master_id = any(${ids}) and state in ('approved', 'effective') order by master_id, (state = 'effective') desc, version_no desc`] : [];
}

// A monitoring plan's rooms are read from master data (code, name and grade, PL-08); its specification tests' number,
// name, method and limit from their latest approved or effective version (pull, don't type).
async function withPlanData(master: Master, doc: MonitoringDoc, q: Sql | Tx): Promise<MonitoringDoc> {
  const rooms = doc.points.some((p) => p.room) ? await master.rooms() : [];
  const specs = await planSpecs(q, doc.points.flatMap((p) => p.samplings.flatMap((s) => (s.spec ? [s.spec.masterId] : []))));
  return { ...doc, points: doc.points.map((p) => {
    const r = p.room && usableItem(rooms, p.room.itemId, 'room');
    return { ...p, ...(r ? { room: { itemId: r.itemId, code: r.code, name: r.name, grade: (r.grade ?? '').trim().toUpperCase() } } : {}),
      samplings: p.samplings.map((s) => {
        const v = s.spec && specs.find((x) => x.masterId === s.spec!.masterId);
        const t = v && v.doc.tests.find((x) => x.key === s.spec!.testKey);
        return v && s.spec ? { ...s, spec: { ...s.spec, number: v.doc.header.number, testName: t?.name ?? '', method: t ? `${t.method.code} ${t.method.name}` : '', limit: t ? limitText(t) : '' } } : s;
      }) };
  }) };
}

/**
 * The problems that stop a version going for review or approval: a method's own checks, or a specification's against
 * its methods as they stand now (each method's latest approved or effective version, LIMS-01).
 */
export async function docProblems(q: Sql | Tx, v: { kind: 'method'; doc: MasterDoc } | { kind: 'spec'; doc: SpecDoc } | { kind: 'protocol'; doc: ProtocolDoc }
  | { kind: 'monitoring'; doc: MonitoringDoc }): Promise<Problem[]> {
  if (v.kind === 'method') return masterChecks(v.doc);
  if (v.kind === 'monitoring') {
    // LIMS-36, LIMS-37: the plan against its specifications as they stand now.
    const specs = await planSpecs(q, v.doc.points.flatMap((p) => p.samplings.flatMap((s) => (s.spec ? [s.spec.masterId] : []))));
    return monitoringChecks(v.doc, (id) => specs.find((x) => x.masterId === id) ?? null);
  }
  if (v.kind === 'protocol') {
    // LIMS-26: the protocol against the specification version it names; its design by template L25 (ICH Q1D).
    const [spec] = v.doc.spec ? await q<{ state: string; doc: SpecDoc }[]>`select state, doc from master_versions where id = ${v.doc.spec.versionId} and kind = 'spec'` : [];
    return protocolChecks(v.doc, spec ?? null);
  }
  const ids = [...new Set(v.doc.tests.map((t) => t.method.masterId))];
  const rows = ids.length ? await q<{ masterId: number; doc: MasterDoc; state: string }[]>`
    select distinct on (master_id) master_id::int as "masterId", doc, state from master_versions
    where kind = 'method' and master_id = any(${ids}) and state in ('approved', 'effective') order by master_id, (state = 'effective') desc, version_no desc` : [];
  return specChecks(v.doc, (id) => rows.find((x) => x.masterId === id) ?? null);
}

const invalid = (reply: FastifyReply, issues?: z.ZodIssue[]) =>
  reply.code(400).send({ error: 'invalid', problems: (issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`) });

export function masterRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };
  const author = { preHandler: requirePermission('lims.master.author') };

  app.get('/api/blocks', anyUser, async () => BLOCKS);

  // Methods (default) or specifications (?kind=spec).
  app.get<{ Querystring: { kind?: string } }>('/api/masters', anyUser, async (req) => sql`
    select v.id::int, v.master_id::int as "masterId", v.version_no as "versionNo", v.state, v.kind, v.doc->'header' as header, v.created_at as "createdAt",
      u.full_name as "createdByName"
    from master_versions v join users u on u.id = v.created_by where v.kind = ${kindOf(req.query.kind)} order by v.master_id, v.version_no`);

  // A new method or specification: version 1, a draft.
  app.post('/api/masters', author, async (req, reply) => {
    const kind = kindOf((req.body as { kind?: string } | null)?.kind);
    const b = z.object({ kind: z.enum(['method', 'spec', 'protocol', 'monitoring']).optional(), doc: schemaOf(kind) }).safeParse(req.body);
    if (!b.success) return invalid(reply, b.error.issues);
    const doc = await withMasterData(app.master, kind, b.data.doc, sql);
    return sql.begin(async (tx) => {
      const [v] = await tx<{ id: number; masterId: number }[]>`
        insert into master_versions (version_no, kind, doc, created_by) values (1, ${kind}, ${tx.json(doc as never)}, ${req.user!.id})
        returning id::int, master_id::int as "masterId"`;
      await audit(tx, { actorId: req.user!.id, action: 'master.created', objectType: 'master_version', objectId: v!.id, new: doc });
      return { id: v!.id, masterId: v!.masterId, versionNo: 1 };
    });
  });

  // A new draft version of a master, starting from its latest version (or from the document sent).
  app.post<{ Params: { masterId: string } }>('/api/masters/:masterId/versions', author, async (req, reply) => {
    const masterId = parseId(req.params.masterId);
    const [latest] = masterId === null ? [] : await sql<{ versionNo: number; kind: Kind; doc: AnyDoc }[]>`
      select version_no as "versionNo", kind, doc from master_versions where master_id = ${masterId} order by version_no desc limit 1`;
    if (!latest) return reply.code(404).send({ error: 'not_found' });
    const b = z.object({ doc: schemaOf(latest.kind).optional() }).safeParse(req.body);
    if (!b.success) return invalid(reply, b.error?.issues);
    const doc = await withMasterData(app.master, latest.kind, b.data.doc ?? latest.doc, sql);
    try {
      return await sql.begin(async (tx) => {
        const [v] = await tx<{ id: number }[]>`
          insert into master_versions (master_id, version_no, kind, doc, created_by) values (${masterId}, ${latest.versionNo + 1}, ${latest.kind}, ${tx.json(doc as never)}, ${req.user!.id})
          returning id::int`;
        await audit(tx, { actorId: req.user!.id, action: 'master.version_created', objectType: 'master_version', objectId: v!.id, new: doc });
        return { id: v!.id, masterId, versionNo: latest.versionNo + 1 };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'draft_exists', message: 'This master already has a draft version.' });
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/api/master-versions/:id', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const v = id === null ? undefined : await masterVersion(sql, id);
    return v ?? reply.code(404).send({ error: 'not_found' });
  });

  // Only a draft is edited; the database refuses any change to a version that left draft.
  app.put<{ Params: { id: string } }>('/api/master-versions/:id', author, async (req, reply) => {
    const id = parseId(req.params.id);
    const was = id === null ? undefined : await masterVersion(sql, id);
    if (!was) return reply.code(404).send({ error: 'not_found' });
    const b = z.object({ doc: schemaOf(was.kind) }).safeParse(req.body);
    if (!b.success) return invalid(reply, b.error?.issues);
    const doc = await withMasterData(app.master, was.kind, b.data.doc, sql);
    return sql.begin(async (tx) => {
      const v = await masterVersion(tx, id!, true);
      if (!v) return reply.code(404).send({ error: 'not_found' });
      if (v.state !== 'draft') return reply.code(409).send({ error: 'locked', message: `This version is ${v.state.replace('_', ' ')} and cannot be changed.` });
      await tx`update master_versions set doc = ${tx.json(doc as never)} where id = ${id}`;
      await audit(tx, { actorId: req.user!.id, action: 'master.updated', objectType: 'master_version', objectId: id, old: v.doc, new: doc });
      return { ok: true };
    });
  });

  app.get<{ Params: { id: string } }>('/api/master-versions/:id/checks', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const v = id === null ? undefined : await masterVersion(sql, id);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    return { problems: await docProblems(sql, v) };
  });

  reviewRoutes(app, sql);
}

// ---- Review and approval (LIMS-01) ----

export const REVIEW_ACTIONS = {
  submit: { from: 'draft', to: 'in_review', event: 'submitted', meaning: 'prepared', needs: ['lims.master.author'] },
  pass: { from: 'in_review', to: null, event: 'passed', meaning: 'checked', needs: ['lims.master.check'] },
  return: { from: 'in_review', to: 'draft', event: 'returned', meaning: null, needs: ['lims.master.check', 'lims.master.approve'] },
  approve: { from: 'in_review', to: 'approved', event: 'approved', meaning: 'approved', needs: ['lims.master.approve'] },
  'make-effective': { from: 'approved', to: 'effective', event: 'effective', meaning: null, needs: ['lims.master.approve'] },
} as const satisfies Record<string, { from: MasterState; to: MasterState | null; event: string; meaning: Meaning | null; needs: Permission[] }>;
export type ReviewAction = keyof typeof REVIEW_ACTIONS;
const REVIEW_NAMES = Object.keys(REVIEW_ACTIONS) as ReviewAction[];

interface MasterEvent { id: number; kind: string; payload: { reason?: string; changeControl?: string; source?: { changeControl?: Source } }; person: number; personName: string; at: Date }
// previous: the document of the version before this one of the same master (none for version 1).
interface Loaded { v: VersionRow; events: MasterEvent[]; authors: number[]; problems: Problem[]; previous?: { id: number; versionNo: number; state: MasterState; doc: AnyDoc } }

async function loadReview(q: Sql | Tx, id: number, lock = false): Promise<Loaded | null> {
  const v = await masterVersion(q, id, lock);
  if (!v) return null;
  const events = await q<MasterEvent[]>`
    select e.id::int, e.kind, e.payload, e.person_id::int as person, u.full_name as "personName", e.at
    from master_events e join users u on u.id = e.person_id where e.version_id = ${id} order by e.id`;
  // The authors: whoever created or changed this version, or sent it for review.
  const edited = await q<{ id: number }[]>`
    select distinct actor_id::int as id from audit_log where object_type = 'master_version' and object_id = ${String(id)} and actor_id is not null
      and action in ('master.created', 'master.version_created', 'master.updated')`;
  const authors = [...new Set([v.createdBy, ...edited.map((r) => r.id), ...events.filter((e) => e.kind === 'submitted').map((e) => e.person)])];
  const [previous] = await q<NonNullable<Loaded['previous']>[]>`
    select id::int, version_no as "versionNo", state, doc from master_versions where master_id = ${v.masterId} and version_no < ${v.versionNo} order by version_no desc limit 1`;
  return { v, events: [...events], authors, problems: await docProblems(q, v), ...(previous ? { previous } : {}) };
}

// What a signer is shown: the version's document, as it stands, after its last event.
const versionContent = (l: Loaded) => ({ version: l.v.id, masterId: l.v.masterId, versionNo: l.v.versionNo, state: l.v.state, doc: l.v.doc, lastEvent: l.events.at(-1)?.id ?? 0 });
const versionHash = (l: Loaded) => contentHash('master_version', l.v.id, versionContent(l));

interface No { status: number; error: string; message: string }
/** Why this person may not take this review action now; null when they may. */
export function reviewRefusal(action: ReviewAction, l: Loaded, user: SessionUser): No | null {
  const rule = REVIEW_ACTIONS[action];
  const no = (status: number, error: string, message: string): No => ({ status, error, message });
  if (!rule.needs.some((p) => user.permissions.includes(p))) return no(403, 'forbidden', 'You do not have the right for this.');
  if (l.v.state !== rule.from) return no(409, 'wrong_state', `This version is ${l.v.state.replace('_', ' ')}.`);
  // This round of review: the events since the version was last sent for review.
  const since = l.events.map((e) => e.kind).lastIndexOf('submitted');
  const round = since < 0 ? [] : l.events.slice(since + 1);
  const passed = round.find((e) => e.kind === 'passed');
  const author = l.authors.includes(user.id);
  // A new version that changes nothing has nothing to review.
  if (action === 'submit' && l.previous && JSON.stringify(l.previous.doc) === JSON.stringify(l.v.doc)) {
    return no(409, 'no_changes', `This version is the same as version ${l.previous.versionNo}: change what the new version is for, then send it for review.`);
  }
  if (action === 'submit' || action === 'approve') {
    // LIMS-01, and the calculation checks: errors, and warnings that need an answer and have none.
    const open = l.problems.filter(blocking);
    if (open.length) return no(409, 'master_has_errors', `The master check shows ${open.length} problem${open.length === 1 ? '' : 's'} to fix or answer first (LIMS-01).`);
  }
  if (action === 'pass') {
    if (author) return no(403, 'author_cannot_check', 'The person who wrote this version cannot check it: a second person checks it.');
    if (passed) return no(409, 'already_checked', `${passed.personName} has already checked this version.`);
  }
  if (action === 'approve') {
    if (!passed) return no(409, 'not_checked', 'A second person checks the version before QA approves it.');
    if (author || passed.person === user.id) return no(403, 'author_cannot_approve', 'QA approval is by a person who neither wrote nor checked this version.');
  }
  if (action === 'make-effective') {
    // LIMS-01: a change control number typed by hand at approval (QMS absent or down) is confirmed by a second person.
    const approved = l.events.filter((e) => e.kind === 'approved').at(-1);
    if (isHand(approved?.payload.source?.changeControl) && approved!.person === user.id) {
      return no(403, 'same_person', 'The change control number was typed by hand at approval: another person makes the version effective, after checking the number and its QA approval in QMS or its paper record.');
    }
  }
  return null;
}

/**
 * LIMS-01: while QMS answers, the change control must be one of its change controls, approved by QA (CHANGE_STEPS);
 * its title and approval are kept with the approval (PL-07). Otherwise the number is typed by hand.
 */
/** The product a change control must name: a specification's material or product; none for a method (a method serves
 *  many products). */
const productOf = (v: VersionRow | undefined): { productCode: string; productName: string } | undefined =>
  (v?.kind === 'spec' || v?.kind === 'protocol' ? { productCode: v.doc.header.code, productName: v.doc.header.name } : undefined);

async function changeControlSource(app: FastifyInstance, number: string, product?: { productCode: string; productName: string }): Promise<Source> {
  const r = await app.links.qms.change(number);
  if (r.state !== 'ok') return { from: 'hand', link: 'qms', state: r.state };
  const c = r.value;
  if (!c) throw new ReviewError(409, 'unknown_change_control', [`${number} is not a change control in QMS.`]);
  // The change control must name the master's product; one that names no product is taken, with a warning for QA.
  const names = product ? namesProduct(c, product) : 'yes';
  if (names === 'no') throw new ReviewError(409, 'other_product', [`${number} is for ${c.products} in QMS, not for ${product!.productCode} ${product!.productName}: pick the change control of this product.`]);
  if (!approvedChange(c)) throw new ReviewError(409, 'change_not_approved', [`${number} is at the step “${c.status.replaceAll('_', ' ')}” in QMS${c.qaApprovedAt ? '' : ' and not approved by QA'}: only a QA-approved change control (${CHANGE_STEPS.join(', ')}) can carry a new version.`]);
  return { from: 'qms', asOf: c.qaApprovedAt, shown: `${c.number}: ${c.title ?? ''} (${c.status}, QA approved ${c.qaApprovedAt})${c.products ? `; products: ${c.products}` : `; QMS names no product: QA checked that it covers ${product?.productCode ?? 'this product'}`}` };
}

class ReviewError extends Error {
  constructor(public status: number, public code: string, public problems: string[] = []) { super(code); }
}
const reviewBodies = {
  submit: z.object({ proof: z.string().min(1).max(2000), contentHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  pass: z.object({ proof: z.string().min(1).max(2000), contentHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  return: z.object({ reason: z.string().trim().min(1).max(1000) }),
  approve: z.object({ proof: z.string().min(1).max(2000), contentHash: z.string().regex(/^[0-9a-f]{64}$/), changeControl: z.string().trim().min(1, 'the change control number is required').max(60) }),
  'make-effective': z.object({}),
} satisfies Record<ReviewAction, z.ZodTypeAny>;

function reviewRoutes(app: FastifyInstance, sql: Sql) {
  const anyUser = { preHandler: requirePermission() };
  const reviewer = { preHandler: requirePermission('lims.master.author', 'lims.master.check', 'lims.master.approve') };

  // What a reviewer sees: the events (who did what, when), the comments, the previous version for the changes view,
  // the hash a signer signs, and the actions open to this person (with why the others are not).
  app.get<{ Params: { id: string } }>('/api/master-versions/:id/review', anyUser, async (req, reply) => {
    const id = parseId(req.params.id);
    const l = id === null ? null : await loadReview(sql, id);
    if (!l) return reply.code(404).send({ error: 'not_found' });
    const comments = await sql`
      select c.id::int, c.path, c.text, u.full_name as "personName", c.at from master_comments c join users u on u.id = c.person_id
      where c.version_id = ${l.v.id} order by c.id`;
    const refusals = Object.fromEntries(REVIEW_NAMES.map((a) => [a, reviewRefusal(a, l, req.user!)?.message ?? null]));
    return {
      events: l.events, comments, previous: l.previous ?? null, contentHash: versionHash(l),
      actions: REVIEW_NAMES.filter((a) => refusals[a] === null), refusals,
    };
  });

  // QA-approved change controls in QMS, for the approval's pick list (pull, don't type).
  // Only those that name the version's product (or name no product: offered with a warning).
  app.get<{ Querystring: { version?: string } }>('/api/change-controls', reviewer, async (req) => {
    const id = parseId(String(req.query.version ?? ''));
    const v = id === null ? undefined : await masterVersion(sql, id);
    const r = await app.links.qms.approved();
    const changes = r.state === 'ok' ? r.value.map((c) => ({ ...c, names: productOf(v) ? namesProduct(c, productOf(v)!) : 'yes' })).filter((c) => c.names !== 'no') : [];
    return { link: r.state, changes };
  });

  app.post<{ Params: { id: string } }>('/api/master-versions/:id/comments', reviewer, async (req, reply) => {
    const id = parseId(req.params.id);
    const b = z.object({ text: z.string().trim().min(1).max(2000), path: z.string().regex(/^[a-zA-Z0-9_.[\]]{1,120}$/).optional() }).safeParse(req.body);
    if (id === null || !b.success) return invalid(reply, b.error?.issues);
    return sql.begin(async (tx) => {
      if (!(await masterVersion(tx, id))) return reply.code(404).send({ error: 'not_found' });
      const [c] = await tx<{ id: number }[]>`
        insert into master_comments (version_id, path, text, person_id) values (${id}, ${b.data.path ?? null}, ${b.data.text}, ${req.user!.id}) returning id::int`;
      await audit(tx, { actorId: req.user!.id, action: 'master.commented', objectType: 'master_version', objectId: id, new: { comment: c!.id, ...b.data } });
      return { id: c!.id };
    });
  });

  // One route per review action, each in the same five steps: read the version and its events, check the action is
  // allowed, insert the event (and change the state), sign it, audit it.
  for (const action of REVIEW_NAMES) {
    const rule = REVIEW_ACTIONS[action];
    app.post<{ Params: { id: string } }>(`/api/master-versions/:id/${action}`, { preHandler: requirePermission(...rule.needs) }, async (req, reply) => {
      const id = parseId(req.params.id);
      const body = reviewBodies[action].safeParse(req.body);
      if (id === null || !body.success) return invalid(reply, body.error?.issues);
      const b = body.data as { proof?: string; contentHash?: string; reason?: string; changeControl?: string };
      const user = req.user!;
      try {
        const signer = rule.meaning ? await authenticateSigner(sql, app.proofKey, user, { proof: b.proof! }, { objectType: 'master_version', objectId: id, meaning: rule.meaning }) : null;
        const source = b.changeControl ? await changeControlSource(app, b.changeControl, productOf(await masterVersion(sql, id))) : null;
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(${-id}::bigint)`;
          // 1. read
          const l = await loadReview(tx, id, true);
          if (!l) throw new ReviewError(404, 'not_found');
          // 2. allowed?
          const no = reviewRefusal(action, l, user);
          if (no) throw new ReviewError(no.status, no.error, [no.message]);
          if (signer && b.contentHash !== versionHash(l)) throw new ReviewError(409, 'content_changed', ['The version changed since you opened it.']);
          // 3. insert the event; the state follows
          const payload = { ...(b.reason ? { reason: b.reason } : {}), ...(b.changeControl ? { changeControl: b.changeControl } : {}), ...(source ? { source: { changeControl: source } } : {}) };
          const [ev] = await tx<{ id: number }[]>`
            insert into master_events (version_id, kind, payload, person_id) values (${id}, ${rule.event}, ${tx.json(payload)}, ${user.id}) returning id::int`;
          const retired: number[] = [];
          if (action === 'make-effective') {
            // LIMS-01: one effective version; the previous one is retired.
            for (const r of await tx<{ id: number }[]>`update master_versions set state = 'retired' where master_id = ${l.v.masterId} and state = 'effective' returning id::int`) {
              await tx`insert into master_events (version_id, kind, payload, person_id) values (${r.id}, 'retired', ${tx.json({ by: id })}, ${user.id})`;
              retired.push(r.id);
            }
          }
          if (rule.to) await tx`update master_versions set state = ${rule.to} where id = ${id}`;
          // 4. sign
          if (signer && rule.meaning) {
            const content = { ...versionContent(l), action, ...payload };
            await sign(tx, { signer, objectType: 'master_event', objectId: ev!.id, meaning: rule.meaning, content, shownHash: contentHash('master_event', ev!.id, content) });
          }
          // 5. audit
          await audit(tx, { actorId: user.id, action: `master.${rule.event}`, objectType: 'master_version', objectId: id,
            old: { state: l.v.state }, new: { state: rule.to ?? l.v.state, event: ev!.id, ...payload, ...(retired.length ? { retired } : {}) }, reason: b.reason ?? null });
          return { ok: true, eventId: ev!.id, state: rule.to ?? l.v.state };
        });
      } catch (e) {
        if (e instanceof ReviewError) return reply.code(e.status).send({ error: e.code, problems: e.problems, message: e.problems[0] });
        if (e instanceof SignError) return reply.code(e.code === 'wrong_credentials' ? 401 : e.code === 'not_allowed' ? 403 : 409).send({ error: e.code });
        // Returned to draft while the master already has a newer draft (one draft per master).
        if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'draft_exists', message: 'This master already has a draft version.' });
        throw e;
      }
    });
  }
}
