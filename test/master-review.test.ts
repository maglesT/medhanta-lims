import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp, validatedOutside } from './helpers.js';
import { method, placed } from './engine-fixture.js';

// Review and approval of method versions (LIMS-01): the author sends for review (signs "prepared"), a second person
// checks ("checked") or returns, QA approves ("approved") with a change control number, and making a version
// effective retires the previous one. A method names no product: the change control is not matched to one.

let t: TestApp;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  t = await freshApp();
  const people = {
    author: ['lims.master.author'], author2: ['lims.master.author', 'lims.master.check'],
    checker: ['lims.master.check'], quality: ['lims.master.approve'], qachecker: ['lims.master.approve', 'lims.master.check'],
    viewer: ['lims.view'],
  } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(() => t.close());

const as = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: object) => call(t.app, cookies[who]!, method as 'GET', url, body);
const review = async (id: number, who = 'viewer') => (await as(who, 'GET', `/api/master-versions/${id}/review`)).json() as {
  contentHash: string; actions: string[]; refusals: Record<string, string | null>; events: { kind: string; payload: Record<string, string> }[];
  comments: { text: string; personName: string }[]; previous: { versionNo: number } | null;
};
const state = async (id: number) => ((await as('viewer', 'GET', `/api/master-versions/${id}`)).json() as { state: string }).state;
const act = async (who: string, id: number, action: string, extra: object = {}) =>
  as(who, 'POST', `/api/master-versions/${id}/${action}`, { proof: proofFor(who), contentHash: (await review(id, who)).contentHash, ...extra });
const draft = async (doc = placed(method())) => ((await as('author', 'POST', '/api/masters', { doc })).json() as { id: number; masterId: number });
async function approved(doc = placed(method())) {
  const v = await draft(doc);
  expect((await act('author', v.id, 'submit')).statusCode).toBe(200);
  expect((await act('checker', v.id, 'pass')).statusCode).toBe(200);
  expect((await act('quality', v.id, 'approve', { changeControl: 'CC-2026-001' })).statusCode).toBe(200);
  return v;
}

describe('master review and approval', () => {
  it('LIMS-01 a version with master-check errors cannot be sent for review', async () => {
    const doc = placed(method());
    delete doc.stages[0]!.produces!.holdHours;
    const { id } = await draft(doc);
    expect((await review(id, 'author')).refusals.submit).toMatch(/master check shows 1 problem/);
    const res = await act('author', id, 'submit');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('master_has_errors');
    expect(await state(id)).toBe('draft');
  });

  it('LIMS-01 a limit written through the API in a unit of another kind than its value: saved as a draft, refused by the check, not sent for review', async () => {
    const doc = placed(method());
    const temp = doc.stages[2]!.steps.find((t) => t.key === 'temp')!;
    temp.settings.limit = { low: '28', high: '32', unit: 'min' };
    const { id } = await draft(doc);
    const checks = (await as('author', 'GET', `/api/master-versions/${id}/checks`)).json() as { problems: { level: string; rule?: string; path: string; message: string }[] };
    expect(checks.problems).toEqual([{ level: 'error', rule: 'LIMS-01', path: 'stages[2].steps[3].settings.limit', message: expect.stringMatching(/^Limits: min is a time, but the value checked is a temperature/) }]);
    expect((await act('author', id, 'submit')).json().error).toBe('master_has_errors');
    // The same limit in a unit of the right kind is accepted.
    temp.settings.limit = { low: '301.15', high: '305.15', unit: 'K' };
    expect((await as('author', 'PUT', `/api/master-versions/${id}`, { doc })).statusCode).toBe(200);
    expect(((await as('author', 'GET', `/api/master-versions/${id}/checks`)).json() as { problems: unknown[] }).problems).toEqual([]);
    expect((await act('author', id, 'submit')).statusCode).toBe(200);
  });

  it('an answer the author gives to a method-check warning is saved with the draft and kept in the method document', async () => {
    const doc = { ...placed(method()), answers: { 'dried/weigh-std': { about: 'Is the standard dried first?', choice: 'yes', reason: 'Dried at 105 °C for 3 hours' } } };
    const { id } = await draft(doc);
    expect((await act('author', id, 'submit')).statusCode).toBe(200);
    const saved = (await as('checker', 'GET', `/api/master-versions/${id}`)).json() as { doc: { answers: Record<string, { choice: string }> } };
    expect(saved.doc.answers['dried/weigh-std']!.choice).toBe('yes');
  });

  it('LIMS-01 the author cannot check their own version; a second person checks it', async () => {
    const { id } = await draft();
    expect((await act('author', id, 'submit')).statusCode).toBe(200);
    expect(await state(id)).toBe('in_review');
    // The version is locked while in review.
    expect((await as('author', 'PUT', `/api/master-versions/${id}`, { doc: placed(method()) })).statusCode).toBe(409);
    expect((await review(id, 'checker')).actions).toEqual(['pass', 'return']);
    expect((await act('checker', id, 'pass')).statusCode).toBe(200);
    expect((await act('qachecker', id, 'pass')).json().error).toBe('already_checked');
    const sigs = await t.owner`select s.meaning, s.printed_name from signatures s join master_events e on e.id = s.object_id
      where s.object_type = 'master_event' and e.version_id = ${id} order by s.id`;
    expect(sigs.map((s) => `${s.meaning} ${s.printed_name}`)).toEqual(['prepared AUTHOR', 'checked CHECKER']);
  });

  it('LIMS-01 an author who edited a version cannot check it', async () => {
    const { id } = await draft();
    expect((await as('author2', 'PUT', `/api/master-versions/${id}`, { doc: placed(method()) })).statusCode).toBe(200);
    expect((await act('author', id, 'submit')).statusCode).toBe(200);
    expect((await act('author2', id, 'pass')).json().error).toBe('author_cannot_check');
  });

  it('LIMS-01 only QA approves, and only a version a second person has checked', async () => {
    const { id } = await draft();
    expect((await act('author', id, 'submit')).statusCode).toBe(200);
    expect((await act('quality', id, 'approve', { changeControl: 'CC-1' })).json().error).toBe('not_checked');
    expect((await act('checker', id, 'pass')).statusCode).toBe(200);
    expect((await act('checker', id, 'approve', { changeControl: 'CC-1' })).statusCode).toBe(403);
    expect((await act('quality', id, 'approve', { changeControl: 'CC-1' })).statusCode).toBe(200);
    expect(await state(id)).toBe('approved');
  });

  it('LIMS-01 QA who checked the version cannot also approve it', async () => {
    const { id } = await draft();
    expect((await act('author', id, 'submit')).statusCode).toBe(200);
    expect((await act('qachecker', id, 'pass')).statusCode).toBe(200);
    expect((await act('qachecker', id, 'approve', { changeControl: 'CC-1' })).json().error).toBe('author_cannot_approve');
  });

  it('LIMS-01 approval needs a change control number (route and database)', async () => {
    const { id } = await draft();
    await act('author', id, 'submit');
    await act('checker', id, 'pass');
    const res = await act('quality', id, 'approve', { changeControl: '  ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().problems.join()).toMatch(/change control number is required/);
    const qa = (await t.owner<{ id: number }[]>`select id::int from users where username = 'quality'`)[0]!.id;
    const db = await t.owner`insert into master_events (version_id, kind, person_id) values (${id}, 'approved', ${qa})`.then(() => 'ok', (e: { code?: string }) => e.code);
    expect(db).toBe('23514');
    expect((await act('quality', id, 'approve', { changeControl: 'CC-2026-014' })).statusCode).toBe(200);
    expect((await review(id)).events.at(-1)).toMatchObject({ kind: 'approved', payload: { changeControl: 'CC-2026-014' } });
  });

  it('LIMS-01 without QMS no change control is offered; the number typed at approval is kept as typed by hand, for any product', async () => {
    const { id } = await draft();
    await act('author', id, 'submit');
    await act('checker', id, 'pass');
    expect((await as('quality', 'GET', `/api/change-controls?version=${id}`)).json()).toMatchObject({ changes: [] });
    expect((await as('viewer', 'GET', `/api/change-controls?version=${id}`)).statusCode).toBe(403);
    expect((await act('quality', id, 'approve', { changeControl: 'CC-2026-031' })).statusCode).toBe(200);
    expect((await review(id)).events.at(-1)).toMatchObject({ kind: 'approved', payload: { changeControl: 'CC-2026-031', source: { changeControl: { from: 'hand', link: 'qms' } } } });
    // Typed by hand: the QA person who approved cannot also make it effective.
    await validatedOutside(t.owner, id);
    expect((await as('quality', 'POST', `/api/master-versions/${id}/make-effective`, {})).json().error).toBe('same_person');
  });

  it('LIMS-01 one effective version: making a new version effective retires the previous one', async () => {
    // Without QMS the change control number is typed by hand: a second person makes the version effective.
    const v1 = await approved();
    await validatedOutside(t.owner, v1.id);
    expect((await as('qachecker', 'POST', `/api/master-versions/${v1.id}/make-effective`, {})).statusCode).toBe(200);
    expect(await state(v1.id)).toBe('effective');
    const next = await as('author', 'POST', `/api/masters/${v1.masterId}/versions`, {});
    const v2 = (next.json() as { id: number }).id;
    expect((await review(v2)).previous?.versionNo).toBe(1);
    // A new version that changes nothing cannot be sent for review.
    expect((await review(v2, 'author')).refusals.submit).toBe('This version is the same as version 1: change what the new version is for, then send it for review.');
    expect((await act('author', v2, 'submit')).json()).toMatchObject({ error: 'no_changes' });
    const doc = placed(method());
    doc.header.edition = 'version 2';
    expect((await as('author', 'PUT', `/api/master-versions/${v2}`, { doc })).statusCode).toBe(200);
    expect((await act('author', v2, 'submit')).statusCode).toBe(200);
    await act('checker', v2, 'pass');
    await act('quality', v2, 'approve', { changeControl: 'CC-2026-020' });
    await validatedOutside(t.owner, v2);
    expect((await as('checker', 'POST', `/api/master-versions/${v2}/make-effective`, {})).statusCode).toBe(403);
    await validatedOutside(t.owner, v2);
    expect((await as('qachecker', 'POST', `/api/master-versions/${v2}/make-effective`, {})).statusCode).toBe(200);
    expect([await state(v1.id), await state(v2)]).toEqual(['retired', 'effective']);
    const effective = await t.owner`select id from master_versions where master_id = ${v1.masterId} and state = 'effective'`;
    expect(effective).toHaveLength(1);
    await validatedOutside(t.owner, v2);
    expect((await as('quality', 'POST', `/api/master-versions/${v2}/make-effective`, {})).json().error).toBe('wrong_state');
  });

  it('a returned version goes back to draft with its reason; comments are kept and insert-only', async () => {
    const { id } = await draft();
    await act('author', id, 'submit');
    expect((await as('checker', 'POST', `/api/master-versions/${id}/return`, { reason: '' })).statusCode).toBe(400);
    expect((await as('checker', 'POST', `/api/master-versions/${id}/comments`, { text: 'Hold time of the standard solution?', path: 'stages[0].produces' })).statusCode).toBe(200);
    expect((await as('checker', 'POST', `/api/master-versions/${id}/return`, { reason: 'See my comment' })).statusCode).toBe(200);
    expect(await state(id)).toBe('draft');
    const r = await review(id);
    expect(r.events.map((e) => e.kind)).toEqual(['submitted', 'returned']);
    expect(r.comments).toMatchObject([{ text: 'Hold time of the standard solution?', personName: 'CHECKER' }]);
    expect((await as('viewer', 'POST', `/api/master-versions/${id}/comments`, { text: 'x' })).statusCode).toBe(403);
    const change = await t.owner`update master_comments set text = 'changed'`.then(() => 'ok', (e: { code?: string }) => e.code);
    expect(change).toBe('42501');
    // Sent again: a new round, so the checker may check it again.
    expect((await act('author', id, 'submit')).statusCode).toBe(200);
    expect((await act('checker', id, 'pass')).statusCode).toBe(200);
  });

  it('LIMS-01 a draft is discarded with its reason, by its author or QA: kept as a record, retired; a new draft can be made', async () => {
    const { id, masterId } = await draft();
    expect((await as('author2', 'POST', `/api/master-versions/${id}/discard`, { reason: 'Not mine' })).json()).toMatchObject({ error: 'not_author' });
    expect((await as('author', 'POST', `/api/master-versions/${id}/discard`, { reason: ' ' })).statusCode).toBe(400);
    const dr = await as('author', 'POST', `/api/master-versions/${id}/discard`, { reason: 'Duplicate draft made by a retry' });
    expect(dr.statusCode).toBe(200);
    expect(await state(id)).toBe('retired');
    expect((await review(id)).events).toMatchObject([{ kind: 'retired', payload: { reason: 'Duplicate draft made by a retry', discarded: true } }]);
    expect((await as('author', 'POST', `/api/master-versions/${id}/discard`, { reason: 'again' })).json()).toMatchObject({ error: 'wrong_state' });
    // QA discards another person's draft (a stale copy).
    const other = await draft();
    expect((await as('quality', 'POST', `/api/master-versions/${other.id}/discard`, { reason: 'Stale draft' })).statusCode).toBe(200);
    expect(masterId).toBeGreaterThan(0);
  });

  it('LIMS-01 QA retires an effective version with its reason and e-signature; no version is effective after it', async () => {
    const v = await approved();
    await validatedOutside(t.owner, v.id);
    expect((await as('qachecker', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
    expect((await act('author', v.id, 'retire', { reason: 'Wrong material' })).statusCode).toBe(403);
    expect((await act('quality', v.id, 'retire', {})).statusCode).toBe(400);
    expect((await act('quality', v.id, 'retire', { reason: 'Written on the wrong material' })).statusCode).toBe(200);
    expect(await state(v.id)).toBe('retired');
    expect(await t.owner`select id from master_versions where master_id = ${v.masterId} and state = 'effective'`).toHaveLength(0);
    const [g] = await t.owner<{ meaning: string }[]>`select g.meaning from signatures g join master_events e on g.object_type = 'master_event' and g.object_id = e.id where e.version_id = ${v.id} and e.kind = 'retired'`;
    expect(g?.meaning).toBe('approved');
    expect((await review(v.id)).events.at(-1)).toMatchObject({ kind: 'retired', payload: { reason: 'Written on the wrong material' } });
  });
});
