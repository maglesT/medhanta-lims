import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { analysisRecordDoc } from '../server/analysis-record.js';
import { recordLate } from '../server/late.js';
import { loadAnalysis, recordInput } from '../server/routes/analyses.js';
import { call, freshApp, handLabels, login, proofFor, seedUser, type TestApp } from './helpers.js';
import { small, method } from './engine-fixture.js';
import { findBlock } from '../shared/blocks/index.js';
import { machineRefusal, roomRefusal } from '../shared/engine/picks.js';
import type { MasterDoc } from '../shared/master/schema.js';

// Method versions (draft, locked once out of draft), starting an analysis from an effective version (LIMS-01), walking
// its steps through the step routes, refused actions (LIMS-41), insert-only step events, the second person's review
// (LIMS-18, LIMS-19), stopping an analysis (LIMS-48) and the timer job (LIMS-44).

let t: TestApp;
const cookies: Record<string, string> = {};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
const item = (itemId: string, c: string, name: string) => ({ itemId, code: c, name, version: 1, active: true });

beforeAll(async () => {
  t = await freshApp();
  t.master.rooms_.push({ ...item('rm-qcl', 'QCL-01', 'QC laboratory 1'), area: 'QC laboratory', grade: 'D' },
    { ...item('rm-ins', 'INS-01', 'Instrument room 1'), area: 'Instrument room', grade: 'D' });
  t.master.equipment_.push(
    { ...item('eq-bal', 'BAL-01', 'Analytical balance'), kind: 'instrument', type: 'balance', room: 'QCL-01' },
    { ...item('eq-son', 'SON-01', 'Ultrasonic bath'), kind: 'equipment', type: 'sonicator', room: 'QCL-01' },
    { ...item('eq-ovn', 'OVN-01', 'Drying oven'), kind: 'equipment', type: 'oven', room: 'QCL-01' },
    { ...item('eq-hplc', 'HPLC-01', 'HPLC system'), kind: 'instrument', type: 'hplc', room: 'INS-01' },
  );
  const people = {
    author: ['lims.master.author', 'lims.view'], issuer: ['lims.analysis.perform'], viewer: ['lims.view'],
    asha: ['lims.analysis.perform', 'lims.analysis.check'], ravi: ['lims.analysis.check'], meera: ['lims.qc.approve'],
    sam: ['lims.analysis.review'], rita: ['lims.analysis.check', 'lims.analysis.review'], quinn: ['lims.qc.approve'],
  } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(() => t.close());

/** The fixture method with the rooms its stages run in (LIMS-12): the bench work in the QC laboratory, the run in the instrument room. */
function lab(doc = method()): MasterDoc {
  for (const s of doc.stages) s.roomTypes = [s.key === 'run' ? 'Instrument room' : 'QC laboratory'];
  return doc;
}
/** Two weighings on a balance: the sample is weighed to the standard's mass ± 2 % (a value of an earlier step). */
const weighings = () => small([{ name: 'Weighing', machineTypes: ['balance'], steps: [
  { key: 'std', block: { id: 'weigh', version: 1 }, checker: true, settings: { what: 'Reference standard', unit: 'mg', target: '50.0 mg', tolerance: '10' } },
  { key: 'smp', block: { id: 'weigh', version: 1 }, checker: true, settings: { what: 'Sample', unit: 'mg', target: { ref: 's0/std/mass' }, tolerance: '2' } },
] }]);

const as = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: object) => call(t.app, cookies[who]!, method as 'GET', url, body);
async function effectiveMaster(change?: (d: MasterDoc) => void, doc = lab()) {
  change?.(doc);
  const res = await as('author', 'POST', '/api/masters', { doc });
  expect(res.statusCode).toBe(200);
  const { id } = res.json() as { id: number };
  for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${id}`;
  return id;
}
async function issue(masterVersionId: number) {
  const res = await as('issuer', 'POST', '/api/analyses', { masterVersionId, proof: proofFor('issuer') });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: number; analysisNo: string };
}
const analysis = async (id: number, who = 'asha') => (await as(who, 'GET', `/api/analyses/${id}`)).json() as {
  stages: { key: string; open: boolean; closed: boolean; blocked?: string }[];
  steps: { id: string; state: string; actions: string[]; contentHash: string; results: Record<string, { ok: boolean; value?: string; check?: { pass: boolean } }>; problems: string[]; blocked?: string }[];
  timers: { id: string; state: string }[];
};
const stepOf = async (id: number, key: string, who = 'asha') => (await analysis(id, who)).steps.find((s) => s.id === key)!;
const act = (who: string, id: number, key: string, action: string, body: object = {}) => as(who, 'POST', `/api/analyses/${id}/steps/${key}/${action}`, body);
const sign = async (who: string, id: number, key: string, action: string, extra: object = {}) =>
  act(who, id, key, action, { proof: proofFor(who), contentHash: (await stepOf(id, key, who)).contentHash, ...extra });
const balance = { balance: 'eq-bal', ...handLabels('balance', 'machine') };

// The text of a PDF document definition, in order: page header, content, and the footer of page 1 of 3 (LIMS-51).
function pdfText(def: TDocumentDefinitions): string {
  const walk = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(walk).join('');
    if (!c || typeof c !== 'object') return '';
    const o = c as { text?: unknown; stack?: unknown[]; table?: { body: unknown[][] }; decoration?: string };
    if (o.stack) return o.stack.map(walk).join('\n');
    if (o.table) return o.table.body.map((r) => r.map((x) => walk(x).trim()).join(' | ')).join('\n');
    const t = walk(o.text);
    return o.decoration === 'lineThrough' ? `~${t}~` : t;
  };
  const footer = typeof def.footer === 'function' ? def.footer(1, 3, { width: 0, height: 0 } as never) : def.footer;
  return [def.header, ...(def.content as Content[]), footer].map(walk).join('\n');
}
const recordText = async (id: number) => pdfText(analysisRecordDoc(await recordInput(t.sql, (await loadAnalysis(t.sql, id))!), 'VIEWER'));

describe('method versions', () => {
  it('a new method is version 1, a draft; the draft can be changed and checked', async () => {
    const res = await as('author', 'POST', '/api/masters', { doc: method() });
    const { id, versionNo } = res.json() as { id: number; versionNo: number };
    expect(versionNo).toBe(1);
    const doc = method();
    doc.header.edition = 'version 2';
    expect((await as('author', 'PUT', `/api/master-versions/${id}`, { doc })).statusCode).toBe(200);
    expect(((await as('viewer', 'GET', `/api/master-versions/${id}`)).json() as { doc: typeof doc }).doc.header.edition).toBe('version 2');
    // The fixture names no rooms for the stages that use instruments (LIMS-12): only that is left to fix.
    expect((await as('viewer', 'GET', `/api/master-versions/${id}/checks`)).json().problems.map((p: { path: string }) => p.path)).toEqual([0, 1, 2].map((i) => `stages[${i}].roomTypes`));
    expect(await t.owner`select 1 from audit_log where action = 'master.updated' and object_id = ${String(id)}`).toHaveLength(1);
    expect((await as('viewer', 'PUT', `/api/master-versions/${id}`, { doc })).statusCode).toBe(403);
  });

  it('only a draft is editable: a version out of draft is locked by the database', async () => {
    const { id, masterId } = (await as('author', 'POST', '/api/masters', { doc: method() })).json() as { id: number; masterId: number };
    expect((await as('author', 'POST', `/api/masters/${masterId}/versions`, {})).statusCode).toBe(409);
    await t.owner`update master_versions set state = 'in_review' where id = ${id}`;
    expect((await as('author', 'PUT', `/api/master-versions/${id}`, { doc: method() })).json()).toMatchObject({ error: 'locked' });
    expect(await code(t.sql`update master_versions set doc = '{}' where id = ${id}`)).toBe('P0001');
    await t.owner`update master_versions set state = 'approved' where id = ${id}`;
    expect(await code(t.owner`update master_versions set state = 'draft' where id = ${id}`)).toBe('P0001');
    expect(await code(t.owner`update master_versions set doc = '{}' where id = ${id}`)).toBe('P0001');
    expect(await code(t.owner`delete from master_versions where id = ${id}`)).toBe('P0001');
    const next = await as('author', 'POST', `/api/masters/${masterId}/versions`, {});
    expect(next.json()).toMatchObject({ masterId, versionNo: 2 });
  });
});

describe('starting an analysis', () => {
  it('LIMS-01 analysis numbers come from the year counter with the fixed prefix, in order, never reused', async () => {
    const mv = await effectiveMaster();
    const a = await issue(mv);
    const b = await issue(mv);
    expect(a.analysisNo).toMatch(/^LA\d{2}\d{5}$/);
    expect(Number(b.analysisNo.slice(4))).toBe(Number(a.analysisNo.slice(4)) + 1);
    expect(await code(t.sql`insert into analyses (analysis_no, master_version_id, issued_by) values (${a.analysisNo}, ${mv}, 1)`)).toBe('23505');
    expect(await t.owner`select 1 from signatures where object_type = 'analysis' and object_id = ${a.id} and meaning = 'issued'`).toHaveLength(1);
  });

  it('LIMS-01 only an effective method version is used, by a person who may perform analyses, and only without errors', async () => {
    const { id } = (await as('author', 'POST', '/api/masters', { doc: lab() })).json() as { id: number };
    expect((await as('issuer', 'POST', '/api/analyses', { masterVersionId: id, proof: proofFor('issuer') })).json()).toMatchObject({ error: 'not_effective' });
    expect((await as('ravi', 'POST', '/api/analyses', { masterVersionId: id, proof: proofFor('ravi') })).statusCode).toBe(403);
    const bad = await effectiveMaster((d) => { d.stages[0]!.steps[0]!.checker = false; });
    expect((await as('issuer', 'POST', '/api/analyses', { masterVersionId: bad, proof: proofFor('issuer') })).json())
      .toMatchObject({ error: 'master_has_errors', problems: ['stages[0].steps[0]: A weighing step needs a second-person check'] });
    // A stage that uses an instrument runs only in the rooms it names (LIMS-12).
    const unplaced = await effectiveMaster(undefined, method());
    expect((await as('issuer', 'POST', '/api/analyses', { masterVersionId: unplaced, proof: proofFor('issuer') })).json()).toMatchObject({ error: 'master_has_errors' });
  });
});

describe('walking an analysis', () => {
  let id: number;
  beforeAll(async () => { id = (await issue(await effectiveMaster())).id; });

  it('the standard and the loss on drying are open; the run and the samples wait, with the reason', async () => {
    const b = await analysis(id);
    expect(b.steps[0]).toMatchObject({ id: '0.1.0.1', state: 'open', actions: ['start', 'note'] });
    expect(b.steps.find((s) => s.id === '1.1.0.1')).toMatchObject({ state: 'open' });
    expect(b.steps.find((s) => s.id === '2.1.0.1')!.blocked).toBe('Waits for stage Loss on drying to close');
    expect(b.steps.find((s) => s.id === '3.2.0.1')!.blocked).toBe('Waits for stage Instrument run to close');
  });

  it('LIMS-47 start → record (the templates compute) → done (signed performed) → checked by another person (signed verified)', async () => {
    expect((await act('asha', id, '0.1.0.1', 'start')).statusCode).toBe(200);
    const rec = await act('asha', id, '0.1.0.1', 'record', { values: { ...balance, mass: '50.20' } });
    expect(rec.statusCode, rec.body).toBe(200);
    const s = await stepOf(id, '0.1.0.1');
    expect(s.results.massCheck?.check?.pass).toBe(true);
    expect(s.problems).toEqual([]);
    const done = await sign('asha', id, '0.1.0.1', 'done');
    expect(done.statusCode).toBe(200);
    const { eventId } = done.json() as { eventId: number };
    expect(await t.owner`select 1 from signatures where object_type = 'step_event' and object_id = ${eventId} and meaning = 'performed'`).toHaveLength(1);
    expect((await stepOf(id, '0.1.0.1')).state).toBe('done_awaiting_check');
    expect((await sign('ravi', id, '0.1.0.1', 'check')).statusCode).toBe(200);
    expect((await stepOf(id, '0.1.0.1')).state).toBe('checked');
    expect(await t.owner`select 1 from audit_log where action = 'step.checked' and object_id = ${String(id)}`).toHaveLength(1);
  });

  it('the bench clearance offers the method and analysis that last used a balance or room, from the analyses that used it (pull, don\'t type)', async () => {
    const later = await issue(await effectiveMaster());
    const r = (await as('asha', 'GET', `/api/analyses/${later.id}/previous-use?item=eq-bal`)).json() as { previous: { analysisNo: string; text: string } | null };
    const first = ((await as('asha', 'GET', `/api/analyses/${id}`)).json() as { analysis: { analysisNo: string } }).analysis.analysisNo;
    expect(r.previous).toMatchObject({ analysisNo: first, text: `QC-M-001 · Examplol assay by HPLC, analysis ${first}` });
    // Nothing used it before the first analysis: typed by hand.
    expect(((await as('asha', 'GET', `/api/analyses/${id}/previous-use?item=eq-bal`)).json() as { previous: unknown }).previous).toBeNull();
  });

  it('a preparation cannot be finished before its minimum time; after it, the standard solution is made and its hold time runs', async () => {
    expect((await act('asha', id, '0.1.1.1', 'start')).statusCode).toBe(200);
    await act('asha', id, '0.1.1.1', 'record', { values: { machine: 'eq-son', ...handLabels('machine', 'machine') } });
    const early = await sign('asha', id, '0.1.1.1', 'done');
    expect(early.statusCode).toBe(409);
    expect(early.json().problems[0]).toMatch(/^The minimum time is 10 min/);
    // As if the sonication had started 11 minutes ago.
    await t.owner`insert into step_events (analysis_id, stage, sub, step, round, kind, person_id, at)
      select ${id}, 0, 1, 1, 1, 'started', person_id, now() - interval '11 minutes' from step_events where analysis_id = ${id} and kind = 'started' limit 1`;
    expect((await sign('asha', id, '0.1.1.1', 'done')).statusCode).toBe(200);
    // The sonicator was entered by hand (no Logbook link): a second person checks the step.
    expect((await stepOf(id, '0.1.1.1')).state).toBe('done_awaiting_check');
    expect((await sign('ravi', id, '0.1.1.1', 'check')).statusCode).toBe(200);
    const b = await analysis(id);
    expect(b.stages[0]).toMatchObject({ key: 'standard', closed: true });
    // The check that closed the preparation recorded it once.
    expect(await t.owner`select payload from analysis_events where analysis_id = ${id} and kind = 'stage_closed'`).toEqual([{ payload: { stage: 0 } }]);
    // The run still waits for the loss on drying; the standard's hold time runs.
    expect(b.steps.find((s) => s.id === '2.1.0.1')!.state).toBe('waiting');
    expect(b.timers).toMatchObject([{ id: 'hold:0:2', state: 'running' }]);
  });

  it('refused: the wrong state, a missing permission, a stale screen, an instrument the stage does not allow', async () => {
    expect((await act('asha', id, '2.1.0.1', 'record', { values: { runId: 'X' } })).json()).toMatchObject({ error: 'wrong_state' });
    expect((await sign('ravi', id, '2.1.0.1', 'check')).json()).toMatchObject({ error: 'wrong_state' });
    expect((await act('ravi', id, '1.1.0.1', 'start')).json()).toMatchObject({ error: 'forbidden' });
    expect((await act('viewer', id, '1.1.0.1', 'note', { text: 'x' })).statusCode).toBe(403);
    expect((await act('asha', id, '9.1.0.1', 'start')).json()).toMatchObject({ error: 'no_such_step' });
    await act('asha', id, '1.1.0.1', 'start');
    const wrong = await act('asha', id, '1.1.0.1', 'record', { values: { machine: 'eq-hplc', weight: 'heavy' } });
    expect(wrong.json()).toMatchObject({ error: 'invalid_values', problems: ['HPLC-01 is not one of the machine types this stage allows (balance, oven)', 'Container with sample: type a number, e.g. "50.300"'] });
    await act('asha', id, '1.1.0.1', 'record', { values: { machine: 'eq-ovn', ...handLabels('machine', 'machine'), weight: '25.4321' } });
    const stale = await act('asha', id, '1.1.0.1', 'done', { proof: proofFor('asha'), contentHash: '0'.repeat(64) });
    expect(stale.json()).toMatchObject({ error: 'content_changed' });
  });

  it('LIMS-12 an instrument not active in master data, or of a type the field does not take, is refused', async () => {
    t.master.equipment_.push({ ...item('eq-old', 'OVN-09', 'Old oven'), active: false, kind: 'equipment', type: 'oven', room: 'QCL-01' });
    expect((await act('asha', id, '1.1.0.1', 'record', { values: { machine: 'eq-old' } })).json()).toMatchObject({ error: 'inactive_item' });
    expect((await act('asha', id, '1.1.0.1', 'record', { values: { machine: 'eq-bal' } })).json()).toMatchObject({ error: 'invalid_values', problems: ['BAL-01 is not a oven or furnace (master data: balance)'] });
  });

  it('LIMS-12 an instrument field takes only the type it asks for, in a room the stage allows; a room only of the stage\'s areas or rooms', () => {
    const stage = { ...method().stages[0]!, machineTypes: ['Balance', 'Sonicator'], roomTypes: ['QC laboratory', 'INS-01'] };
    const weighing = findBlock({ id: 'weigh', version: 1 })!.fields.find((f) => f.name === 'balance')!;
    const rooms = [{ code: 'QCL-01', area: 'QC laboratory' }, { code: 'INS-01', area: 'Instrument room' }, { code: 'MIC-01', area: 'Microbiology' }, { code: 'STB-01', area: 'Stability' }];
    const m = (code: string, type: string, room: string | null) => machineRefusal(stage, weighing, { code, type, room }, rooms);
    expect([m('BAL-01', 'Balance', 'QCL-01'), m('BAL-03', 'balance', 'INS-01')]).toEqual([null, null]);
    expect(m('BAL-02', 'balance', null)).toBe('BAL-02 stands in no room in master data, so it is not in a room this stage allows (QC laboratory, INS-01)');
    expect(m('SON-01', 'Sonicator', 'QCL-01')).toBe('SON-01 is not a balance (master data: Sonicator)');
    expect(m('BAL-07', 'Balance', 'MIC-01')).toBe('BAL-07 stands in MIC-01, not in a room this stage allows (QC laboratory, INS-01)');
    const instrument = findBlock({ id: 'instrument-run', version: 1 })!.fields.find((f) => f.name === 'instrument')!;
    expect(machineRefusal(stage, instrument, { code: 'HPLC-01', type: 'HPLC', room: 'INS-01' }, rooms)).toBe('HPLC-01 is not one of the machine types this stage allows (Balance, Sonicator)');
    expect(rooms.map((r) => roomRefusal(stage, r))).toEqual([null, null, 'MIC-01 is not one of the rooms this stage allows (QC laboratory, INS-01)', 'STB-01 is not one of the rooms this stage allows (QC laboratory, INS-01)']);
  });

  it('LIMS-44 each entry is saved at once, with the person and the server time', async () => {
    const [e] = await t.owner<{ person: string; fresh: boolean }[]>`
      select u.username as person, now() - e.at < interval '1 minute' as fresh from step_events e join users u on u.id = e.person_id
      where e.analysis_id = ${id} order by e.id desc limit 1`;
    expect(e).toEqual({ person: 'asha', fresh: true });
  });

  it('LIMS-46 step events are insert-only: the app role cannot change or delete them, nor can the owner', async () => {
    expect(await code(t.sql`update step_events set kind = 'checked'`)).toBe('42501');
    expect(await code(t.sql`delete from step_events`)).toBe('42501');
    expect(await code(t.owner`update step_events set payload = '{}'`)).toBe('42501');
    expect(await code(t.owner`delete from step_events`)).toBe('42501');
    expect(await code(t.sql`insert into step_events (analysis_id, stage, sub, step, round, kind, person_id, at) values (${id}, 0, 1, 0, 1, 'note', 1, now() - interval '1 day')`)).toBe('42501');
  });
});

describe('corrections: checked by a second person, the original kept', () => {
  let id: number;
  beforeAll(async () => { id = (await issue(await effectiveMaster(undefined, weighings()))).id; });

  it('LIMS-41 the person who performed a step cannot check it', async () => {
    await act('asha', id, '0.1.0.1', 'start');
    expect((await act('asha', id, '0.1.0.1', 'record', { values: { ...balance, mass: '50.20' } })).statusCode).toBe(200);
    expect((await sign('asha', id, '0.1.0.1', 'done')).statusCode).toBe(200);
    expect((await stepOf(id, '0.1.0.1')).actions).not.toContain('check');
    const own = await sign('asha', id, '0.1.0.1', 'check');
    expect(own.statusCode).toBe(403);
    expect(own.json()).toMatchObject({ error: 'own_work' });
  });

  it('LIMS-46 send back, correct with a reason, sign again, check: the original value stays in the record', async () => {
    expect((await act('ravi', id, '0.1.0.1', 'send-back', { reason: 'Mass looks wrong' })).statusCode).toBe(200);
    expect((await act('asha', id, '0.1.0.1', 'record', { values: { mass: '50.12' } })).json()).toMatchObject({ error: 'wrong_state' });
    expect((await act('asha', id, '0.1.0.1', 'correct', { values: { mass: '50.12' } })).statusCode).toBe(400);
    expect((await act('asha', id, '0.1.0.1', 'correct', { values: { mass: '50.12' }, reason: 'Misread the balance' })).statusCode).toBe(200);
    const s = (await stepOf(id, '0.1.0.1')) as unknown as { needsResign: boolean; replaced?: unknown; values: Record<string, { value: string }> };
    expect(s.needsResign).toBe(true);
    expect(s.replaced).toBeUndefined();
    expect(s.values.mass!.value).toBe('50.12');
    const history = (await as('viewer', 'GET', `/api/analyses/${id}/steps/0.1.0.1/events`)).json() as { events: { kind: string }[]; replaced: unknown };
    expect(history.replaced).toMatchObject([{ field: 'mass', was: { value: '50.20' }, now: { value: '50.12' }, reason: 'Misread the balance' }]);
    expect(history.events.map((e) => e.kind)).toEqual(['started', 'value', 'done', 'sent_back', 'corrected']);
    expect((await sign('asha', id, '0.1.0.1', 'done')).statusCode).toBe(200);
    expect((await sign('ravi', id, '0.1.0.1', 'check')).statusCode).toBe(200);
  });

  it('LIMS-46 a correction reaches the step that used the value: it shows the new result and who changed it, and is signed and checked again', async () => {
    expect((await act('asha', id, '0.1.1.1', 'start')).statusCode).toBe(200);
    await act('asha', id, '0.1.1.1', 'record', { values: { ...balance, mass: '50.30' } });
    expect((await stepOf(id, '0.1.1.1')).results.massCheck?.check?.pass).toBe(true);
    expect((await sign('asha', id, '0.1.1.1', 'done')).statusCode).toBe(200);
    expect((await sign('ravi', id, '0.1.1.1', 'check')).statusCode).toBe(200);
    // The standard's mass is corrected after the sample's target was worked out from it.
    expect((await act('asha', id, '0.1.0.1', 'correct', { values: { mass: '48.00' }, reason: 'Weighed into the wrong flask' })).statusCode).toBe(200);
    const s = (await stepOf(id, '0.1.1.1')) as unknown as { state: string; needsResign: boolean; inputChanged: { kind: string; personName: string; payload: { reason: string } }[]; results: { massCheck: { check: { pass: boolean } } } };
    expect([s.state, s.needsResign]).toEqual(['in_progress', true]);
    expect(s.inputChanged).toMatchObject([{ kind: 'corrected', personName: 'ASHA', payload: { reason: 'Weighed into the wrong flask' } }]);
    expect(s.results.massCheck.check.pass).toBe(false);
    // Signed again with the new target, then checked again. 50.30 mg is now 5 % over the new target: a note first.
    await sign('asha', id, '0.1.0.1', 'done');
    await sign('ravi', id, '0.1.0.1', 'check');
    expect((await sign('asha', id, '0.1.1.1', 'done')).json()).toMatchObject({ error: 'not_ready', problems: ['Out of limits: Mass against target. Add a deviation note first.'] });
    await act('asha', id, '0.1.1.1', 'note', { text: 'Sample 5 % over the corrected standard mass', reference: 'DEV-26-003' });
    expect((await sign('asha', id, '0.1.1.1', 'done')).statusCode).toBe(200);
    expect((await stepOf(id, '0.1.1.1')).state).toBe('done_awaiting_check');
    expect((await sign('ravi', id, '0.1.1.1', 'check')).statusCode).toBe(200);
    const after = (await stepOf(id, '0.1.1.1')) as unknown as { inputChanged: unknown[] };
    expect(after.inputChanged).toEqual([]);
  });

  it('LIMS-51 the analysis record PDF shows the corrected value struck through with its reason, the worked lines, limits, notes and who did what', async () => {
    const text = await recordText(id);
    expect(text).toMatch(/^Medhanta LIMS · Analysis record LA\d{7} · M M/);
    expect(text).toContain('Status | Complete');
    expect(text).toContain('Changed values | marked CHANGED');
    // LIMS-32: a mass typed, not read from the balance, says so.
    expect(text).toContain('Net mass: 48.00 mg (BY HAND: not read from the instrument)  CHANGED');
    expect(text).toMatch(/was ~50\.12 mg~ · reason: Weighed into the wrong flask · ASHA, \d+ \w+ 2026, \d\d:\d\d IST/);
    expect(text).toMatch(/was ~50\.20 mg~ · reason: Misread the balance · ASHA/);
    // The label questions typed by hand by their labels, never their names.
    expect(text).toContain('Balance: the calibration label is in date: yes');
    expect(text).not.toMatch(/\b(?:balance|machine|room)\.[a-zA-Z]/);
    expect(text).toContain('50.30 mg is +5 % from 48.00 mg (target); limit ± 2 %\nFAIL: out of limits');
    // Instruments by code and name, without master data's version.
    expect(text).toContain('Balance: BAL-01 · Analytical balance');
    expect(text).not.toMatch(/ \(v\d+\)/);
    expect(text).toMatch(/Checked: RAVI, .* IST · signed "Verified \(second person\)"/);
    expect(text).toMatch(/Sent back: RAVI, .* · reason: Mass looks wrong/);
    expect(text).toMatch(/DEV-26-003 \(typed by hand\) \| Weighing · 1\.2 Weigh: Sample \| Sample 5 % over the corrected standard mass \| ASHA, .* \| OPEN/);
    expect(text).toContain('This copy was made while the analysis is complete: it is not a reviewed record.');
    expect(text).toMatch(/Generated .* IST by VIEWER · true copy of the electronic record · page 1 of 3$/);
  });

  it('GET /api/analyses/:id shows each step\'s last events only', async () => {
    const b = (await as('viewer', 'GET', `/api/analyses/${id}`)).json() as { steps: { id: string; events: unknown[] }[] };
    const all = (await as('viewer', 'GET', `/api/analyses/${id}/steps/0.1.0.1/events`)).json() as { events: unknown[] };
    expect(all.events.length).toBeGreaterThan(5);
    expect(b.steps.find((x) => x.id === '0.1.0.1')!.events).toEqual(all.events.slice(-5));
    expect((await as('viewer', 'GET', `/api/analyses/${id}/steps/9.1.0.1/events`)).statusCode).toBe(404);
  });
});

describe('the second person reviews the complete analysis', () => {
  let id: number;
  let note: number;
  const full = async (who = 'viewer') => (await as(who, 'GET', `/api/analyses/${id}`)).json() as { analysis: { status: string; contentHash: string; actions: string[]; open: string[] } };
  const analysisAct = (who: string, action: string, body: object) => as(who, 'POST', `/api/analyses/${id}/${action}`, body);
  const analysisSign = async (who: string, action: string, extra: object = {}) => analysisAct(who, action, { proof: proofFor(who), contentHash: (await full()).analysis.contentHash, ...extra });
  const toReview = async (who: string) => ((await as(who, 'GET', '/api/analyses/to-review')).json() as { id: number; status: string; actions: string[]; openDeviations: number }[]).filter((b) => b.id === id);
  // One pH reading, checked by a second person.
  beforeAll(async () => { id = (await issue(await effectiveMaster(undefined, small([{ steps: [{ checker: true }] }])))).id; });

  it('LIMS-11 nobody reviews an analysis while anything in its record is open', async () => {
    expect((await analysisSign('sam', 'review')).json()).toMatchObject({ error: 'not_ready', problems: ['Stage 0 › Check a value against limits: pH is not started', 'Stage Stage 0 is not closed'] });
    await act('asha', id, '0.1.0.1', 'start');
    await act('asha', id, '0.1.0.1', 'record', { values: { reading: '6.0' } });
    expect((await sign('asha', id, '0.1.0.1', 'done')).statusCode).toBe(200);
    expect((await analysisSign('sam', 'review')).json()).toMatchObject({ problems: ['Stage 0 › Check a value against limits: pH is waiting for its check', 'Stage Stage 0 is not closed'] });
    expect((await sign('rita', id, '0.1.0.1', 'check')).statusCode).toBe(200);
    expect((await full()).analysis).toMatchObject({ status: 'complete', open: [] });
    const n = await act('asha', id, '0.1.0.1', 'note', { text: 'pH meter found out of calibration after the reading', reference: 'DEV-26-010' });
    expect(n.statusCode).toBe(200);
    note = (n.json() as { eventId: number }).eventId;
  });

  it('LIMS-41 nobody reviews their own work: a reviewer who checked a step is refused; so is a person without the review permission', async () => {
    expect((await full('rita')).analysis.actions).toEqual(['stop']);
    expect((await analysisSign('rita', 'review')).json()).toMatchObject({ error: 'own_work', problems: ['You recorded or signed steps of this analysis: another person reviews it.'] });
    expect((await analysisAct('asha', 'review', { proof: proofFor('asha'), contentHash: (await full()).analysis.contentHash })).statusCode).toBe(401);
  });

  it('LIMS-18 the To review list: the reviewer sees the complete analysis with its open deviations; others may not look', async () => {
    expect(await toReview('sam')).toMatchObject([{ status: 'complete', actions: ['review', 'stop'], openDeviations: 1 }]);
    expect((await as('asha', 'GET', '/api/analyses/to-review')).statusCode).toBe(403);
  });

  it('LIMS-20 a deviation number typed by hand is closed by a QC person who did not type it, with a reason', async () => {
    expect((await analysisAct('sam', 'close-deviation', { note, reason: 'x' })).statusCode).toBe(403);
    expect((await analysisAct('quinn', 'close-deviation', { note, reason: 'Meter recalibrated; the result confirmed by a second meter' })).statusCode).toBe(200);
    expect((await analysisAct('quinn', 'close-deviation', { note, reason: 'again' })).statusCode).toBe(409);
    expect(await toReview('sam')).toMatchObject([{ openDeviations: 0 }]);
  });

  it('LIMS-47 the review is an e-signature on the record as shown; the record is then closed to changes', async () => {
    expect((await analysisAct('sam', 'review', { proof: proofFor('sam'), contentHash: '0'.repeat(64) })).json()).toMatchObject({ error: 'content_changed' });
    const ok = await analysisSign('sam', 'review');
    expect(ok.statusCode).toBe(200);
    const { eventId } = ok.json() as { eventId: number };
    expect(await t.owner`select 1 from signatures where object_type = 'analysis_event' and object_id = ${eventId} and meaning = 'reviewed'`).toHaveLength(1);
    expect((await full()).analysis).toMatchObject({ status: 'reviewed', actions: [] });
    expect((await act('asha', id, '0.1.0.1', 'correct', { values: { reading: '6.1' }, reason: 'x' })).json()).toMatchObject({ error: 'analysis_closed', problems: ['The analysis is reviewed.'] });
    expect((await act('asha', id, '0.1.0.1', 'note', { text: 'x' })).json()).toMatchObject({ error: 'analysis_closed' });
    expect(await toReview('sam')).toEqual([]);
  });

  it('LIMS-19 the review shows the deviations with their status, the corrections and every signature of the analysis', async () => {
    const r = (await as('viewer', 'GET', `/api/analyses/${id}/review`)).json() as { status: string; deviations: unknown[]; signatures: { meaning: string; printedName: string }[]; analysisEvents: { kind: string }[] };
    expect(r.status).toBe('reviewed');
    expect(r.deviations).toMatchObject([{ reference: 'DEV-26-010', open: false, closed: { personName: 'QUINN' } }]);
    expect(r.signatures.map((x) => `${x.meaning} ${x.printedName}`)).toEqual(['issued ISSUER', 'performed ASHA', 'verified RITA', 'reviewed SAM']);
    expect(r.analysisEvents.map((e) => e.kind)).toEqual(['deviation_closed', 'reviewed']);
  });

  it('LIMS-51 the analysis record PDF is produced, with the review and every signature with its meaning', async () => {
    const res = await as('viewer', 'GET', `/api/analyses/${id}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="analysis-record-LA\d{7}\.pdf"$/);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await as('viewer', 'GET', '/api/analyses/999999/pdf')).statusCode).toBe(404);
    const text = await recordText(id);
    expect(text).toContain('Status | Reviewed');
    expect(text).toMatch(/Review\nReviewed \(second person\): SAM, .* IST/);
    expect(text).toMatch(/DEV-26-010 \(typed by hand\) \| .* \| pH meter found out of calibration after the reading \| ASHA, .* \| closed by QUINN, .*: Meter recalibrated; the result confirmed by a second meter/);
    for (const m of ['Issued | ISSUER', 'Performed | ASHA', 'Verified (second person) | RITA', 'Reviewed (second person) | SAM']) expect(text).toContain(m);
    expect(text).not.toContain('not a reviewed record');
  });

  it('LIMS-45 every step and analysis action is in the product\'s own audit trail', async () => {
    const rows = await t.owner<{ action: string }[]>`select distinct action from audit_log where object_type = 'analysis' and object_id = ${String(id)} order by action`;
    // The refused review signature of a person without the permission too (LIMS-41 above).
    expect(rows.map((r) => r.action)).toEqual(['analysis.deviation_closed', 'analysis.issued', 'analysis.reviewed', 'analysis.stage_closed', 'signature.failed', 'signed.issued',
      'step.checked', 'step.done', 'step.note', 'step.started', 'step.value']);
  });

  it('LIMS-18 a reviewed analysis takes no more entries or decisions, once and never both', async () => {
    expect((await analysisSign('sam', 'stop', { reason: 'x' })).json()).toMatchObject({ problems: ['The analysis is reviewed.'] });
    const [m] = await t.owner<{ id: string }[]>`select id from users where username = 'sam'`;
    expect(await code(t.owner`insert into analysis_events (analysis_id, kind, person_id) values (${id}, 'stopped', ${m!.id})`)).toBe('23505');
    expect(await code(t.sql`update analysis_events set kind = 'stopped'`)).toBe('42501');
  });
});

describe('stopping an analysis that cannot be finished', () => {
  let id: number;
  const full = async (who = 'viewer') => (await as(who, 'GET', `/api/analyses/${id}`)).json() as {
    analysis: { status: string; contentHash: string; actions: string[]; stopped: { personName: string; payload: { reason: string } } | null };
    steps: { actions: string[] }[]; timers: unknown[] };
  const why = 'The HPLC pump failed; the standard solution is out of its hold time';
  const stop = async (who: string, extra: object = { reason: why }) =>
    as(who, 'POST', `/api/analyses/${id}/stop`, { proof: proofFor(who), contentHash: (await full()).analysis.contentHash, ...extra });
  beforeAll(async () => {
    id = (await issue(await effectiveMaster())).id;
    // The standard: weighed and checked, then the sonication running.
    await act('asha', id, '0.1.0.1', 'start');
    await act('asha', id, '0.1.0.1', 'record', { values: { ...balance, mass: '50.20' } });
    await sign('asha', id, '0.1.0.1', 'done');
    await sign('ravi', id, '0.1.0.1', 'check');
    await act('asha', id, '0.1.1.1', 'start');
    await act('asha', id, '0.1.1.1', 'record', { values: { machine: 'eq-son', ...handLabels('machine', 'machine') } });
  });

  it('LIMS-48 the reviewer sees the analysis in progress on the To review list and may stop it, with a reason; nobody else may', async () => {
    const rows = ((await as('sam', 'GET', '/api/analyses/to-review')).json() as { id: number; status: string; actions: string[] }[]).filter((b) => b.id === id);
    expect(rows).toMatchObject([{ status: 'in progress', actions: ['stop'] }]);
    expect((await full('sam')).analysis.actions).toEqual(['stop']);
    expect((await full('meera')).analysis.actions).toEqual([]);
    // Without the review permission at core, the signature itself is refused.
    expect((await stop('meera')).statusCode).toBe(401);
    expect((await stop('sam', {})).statusCode).toBe(400);
    expect((await full()).analysis.status).toBe('in progress');
    // In progress, the record says what is still to come.
    const live = await recordText(id);
    expect(live).toContain('1.2 Prepare (mix, shake, sonicate)\nin progress |');
  });

  it('LIMS-48 a stop is a signed decision with its reason; the analysis keeps its record and runs no more timers', async () => {
    const res = await stop('sam');
    expect(res.statusCode).toBe(200);
    const { eventId } = res.json() as { eventId: number };
    expect(await t.owner`select 1 from signatures where object_type = 'analysis_event' and object_id = ${eventId} and meaning = 'stopped'`).toHaveLength(1);
    const [e] = await t.owner<{ payload: object }[]>`select payload from analysis_events where id = ${eventId}`;
    expect(e!.payload).toEqual({ reason: why });
    const b = await full();
    expect(b.analysis).toMatchObject({ status: 'stopped', actions: [], stopped: { personName: 'SAM', payload: { reason: why } } });
    expect(b.steps.every((s) => !s.actions.length)).toBe(true);
    expect(b.timers).toEqual([]);
  });

  it('LIMS-48 actions are refused after the stop; the record is kept and leaves My work and the To review list', async () => {
    expect((await act('asha', id, '0.1.1.1', 'record', { values: { speed: '310' } })).json()).toMatchObject({ error: 'analysis_closed', problems: ['The analysis is stopped.'] });
    expect((await act('asha', id, '0.1.1.1', 'note', { text: 'x' })).json()).toMatchObject({ error: 'analysis_closed' });
    expect((await stop('sam')).json()).toMatchObject({ error: 'not_ready', problems: ['The analysis is stopped.'] });
    expect((await as('sam', 'POST', `/api/analyses/${id}/review`, { proof: proofFor('sam'), contentHash: (await full()).analysis.contentHash })).statusCode).toBe(409);
    expect(((await as('sam', 'GET', '/api/analyses/to-review')).json() as { id: number }[]).some((b) => b.id === id)).toBe(false);
    expect(((await as('asha', 'GET', '/api/analyses')).json() as { id: number }[]).some((b) => b.id === id)).toBe(false);
    expect(await t.owner`select 1 from step_events where analysis_id = ${id}`).not.toHaveLength(0);
  });

  it('LIMS-51 the PDF and the review show "Stopped by … at …: reason"', async () => {
    const text = await recordText(id);
    expect(text).toContain('Status | Stopped');
    expect(text.match(new RegExp(`Stopped by SAM at \\d{1,2} \\w{3} 20\\d\\d, \\d\\d:\\d\\d IST: ${why}`, 'g'))).toHaveLength(2);
    expect(text).toContain('Stopped | SAM');
    // Nothing it never did reads as still to come.
    expect(text).toMatch(/1\.2 Prepare \(mix, shake, sonicate\)\n\w+, not finished \|/);
    expect(text).toMatch(/3\.1 Instrument run\n\w+, not started \|/);
    expect(text).not.toMatch(/\byet\b|\nnot started|\nin progress/);
    const r = (await as('viewer', 'GET', `/api/analyses/${id}/review`)).json() as { status: string; analysisEvents: { kind: string; payload: object; personName: string }[] };
    expect(r).toMatchObject({ status: 'stopped', analysisEvents: [{ kind: 'stopped', payload: { reason: why }, personName: 'SAM' }] });
  });
});

describe('the timer job', () => {
  // A standard solution kept 24 h, used by the next stage.
  const held = () => small([{ name: 'Standard solution', kind: 'preparation', produces: { name: 'standard solution', holdHours: 24 } }, { name: 'Run', uses: ['s0'] }]);

  it('LIMS-44 a hold time that ran out is recorded late once, and blocks the using stage until a deviation note', async () => {
    const { id } = await issue(await effectiveMaster(undefined, held()));
    // The standard solution was made 25 hours ago (hold time 24 h).
    const [p] = await t.owner<{ id: string }[]>`select id from users where username = 'asha'`;
    await t.owner`insert into step_events (analysis_id, stage, sub, step, round, kind, person_id, at) values
      (${id}, 0, 1, 0, 1, 'started', ${p!.id}, now() - interval '26 hours'), (${id}, 0, 1, 0, 1, 'done', ${p!.id}, now() - interval '25 hours')`;
    const b = await analysis(id);
    expect(b.stages[1]!.blocked).toBe('Hold time of standard solution (24 h) before Run ran out: a deviation note is needed');
    expect(b.steps.find((s) => s.id === '1.1.0.1')!.state).toBe('waiting');
    expect(await recordLate(t.sql)).toBeGreaterThanOrEqual(1);
    expect(await recordLate(t.sql)).toBe(0);
    expect(await t.owner`select 1 from step_events where analysis_id = ${id} and kind = 'late' and payload->>'timer' = 'hold:0:1' and person_id is null`).toHaveLength(1);
    expect(await code(t.sql`insert into step_events (analysis_id, stage, sub, step, round, kind, payload) values (${id}, 1, 1, 0, 1, 'late', '{"timer": "hold:0:1"}')`)).toBe('23505');
    expect((await act('asha', id, '1.1.0.1', 'note', { text: 'Standard solution held 25 h; deviation raised' })).statusCode).toBe(200);
    expect((await stepOf(id, '1.1.0.1')).state).toBe('open');
  });

  it('skips an analysis that is reviewed or stopped', async () => {
    const { id } = await issue(await effectiveMaster(undefined, held()));
    const [p] = await t.owner<{ id: string }[]>`select id from users where username = 'asha'`;
    await t.owner`insert into step_events (analysis_id, stage, sub, step, round, kind, person_id, at) values
      (${id}, 0, 1, 0, 1, 'started', ${p!.id}, now() - interval '26 hours'), (${id}, 0, 1, 0, 1, 'done', ${p!.id}, now() - interval '25 hours')`;
    await t.owner`insert into analysis_events (analysis_id, kind, person_id) values (${id}, 'stopped', ${p!.id})`;
    await recordLate(t.sql);
    expect(await t.owner`select 1 from step_events where analysis_id = ${id} and kind = 'late'`).toHaveLength(0);
  });
});
