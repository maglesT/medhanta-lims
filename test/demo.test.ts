import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { demoSkipCommand, skipWaits } from '../server/demo.js';
import { analysisRecordDoc } from '../server/analysis-record.js';
import { loadAnalysis, recordInput } from '../server/routes/analyses.js';
import { LIMS } from '../server/product.js';
import { doneProblems, lateItems, openSteps, timers, type StepEvent } from '../shared/engine/index.js';
import { at, ev, pass, reading, small } from './engine-fixture.js';
import { call, fakeSignOn, freshApp, login, proofFor, seedUser, TEST_PROOF_KEY, type TestApp } from './helpers.js';

// Demo installations only (LIMS_DEMO=1): a skip event satisfies the wait the timers compute, nothing else changes;
// the button, the route and the terminal command are refused anywhere else.

const skip = (key: string, timer: string, min: number) => ev('demo_wait_skipped', key, { min, payload: { timer, label: timer } });
const ids = (doc: ReturnType<typeof small>, events: StepEvent[], now: Date) => openSteps(doc, events, now).steps.map((s) => `${s.id} ${s.state} ${s.blocked ?? ''}`);

describe('the engine: a skip ends the wait at once', () => {
  it('a minimum time skipped is due from the skip: the step can be signed', () => {
    const doc = small([{ steps: [{ minMinutes: 30 }] }]);
    const events = [ev('started', '0.1.0.1', { min: 0 }), ev('value', '0.1.0.1', { min: 1, payload: { values: { reading: { value: '6', unit: '' } }, results: { readingCheck: pass as never } } })];
    const done = (e: StepEvent[]) => doneProblems(doc, openSteps(doc, e, at(6)).steps[0]!, at(6));
    expect(done(events)).toEqual([`The minimum time is 30 min: the step can be finished from ${at(30).toISOString()}`]);
    const skipped = [...events, skip('0.1.0.1', 'min:0.1.0.1', 5)];
    expect(timers(doc, skipped, at(6))).toMatchObject([{ id: 'min:0.1.0.1', state: 'due', at: at(5), skipped: { person: 1, at: at(5) } }]);
    expect(done(skipped)).toEqual([]);
    expect(ids(doc, skipped, at(6))).toEqual(ids(doc, events, at(6)));
  });

  it('a periodic check skipped is due now and never late; the rounds are as before', () => {
    const doc = small([{ steps: [{ everyMinutes: 30, flow: { kind: 'repeat-until', maxRounds: 10, stop: 'readingCheck' } }] }]);
    const r1 = [ev('started', '0.1.0.1', { min: 0 }), reading('0.1.0.1', { readingCheck: { ...pass, check: { pass: false, level: 'fail', shown: '' } } }, { min: 2 }), ev('done', '0.1.0.1', { min: 3 })];
    const skipped = [...r1, skip('0.1.0.1', 'every:0.1.0.2', 10)];
    expect(timers(doc, skipped, at(100))).toMatchObject([{ id: 'every:0.1.0.2', state: 'due', at: at(10) }]);
    expect(ids(doc, skipped, at(11))).toEqual(ids(doc, r1, at(11)));
    const next = (e: StepEvent[]) => timers(doc, [...e, ev('started', '0.1.0.2', { min: 50 })], at(55)).map((t) => `${t.id} ${t.state}`);
    expect(next(r1)).toEqual(['every:0.1.0.2 late', 'every:0.1.0.3 running']);
    expect(next(skipped)).toEqual(['every:0.1.0.3 running']);
  });

  it('a hold time skipped is satisfied: never late, the using stage is not blocked', () => {
    const doc = small([{ produces: { name: 'granules', holdHours: 2 } }, { uses: ['s0'] }]);
    const done = [ev('started', '0.1.0.1', { min: 0 }), ev('done', '0.1.0.1', { min: 10 })];
    const skipped = [...done, skip('1.1.0.1', 'hold:0:1', 20)];
    expect(timers(doc, skipped, at(300))).toMatchObject([{ id: 'hold:0:1', state: 'due', at: at(20) }]);
    expect(lateItems(doc, skipped, at(300))).toEqual([]);
    expect(openSteps(doc, done, at(300)).steps[1]!.state).toBe('waiting');
    expect(openSteps(doc, skipped, at(300)).steps[1]!.state).toBe('open');
    expect(timers(doc, [...skipped, ev('started', '1.1.0.1', { min: 400 })], at(500))).toEqual([]);
  });
});

describe('demo skip through the server', () => {
  let t: TestApp;
  let plain: FastifyInstance;
  const cookies: Record<string, string> = {};
  const plainCookies: Record<string, string> = {};
  const as = (who: string, method: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, method, url, body);
  type Step = { id: string; contentHash: string };
  const step = async (id: number, key: string) => ((await as('asha', 'GET', `/api/analyses/${id}`)).json() as { steps: Step[] }).steps.find((s) => s.id === key)!;
  async function issue() {
    const m = await as('author', 'POST', '/api/masters', { doc: small([{ steps: [{ minMinutes: 30 }] }]) });
    const { id: mv } = m.json() as { id: number };
    for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${mv}`;
    const r = await as('issuer', 'POST', '/api/analyses', { masterVersionId: mv, proof: proofFor('issuer') });
    const b = r.json() as { id: number; analysisNo: string };
    expect((await as('asha', 'POST', `/api/analyses/${b.id}/steps/0.1.0.1/start`)).statusCode).toBe(200);
    return b;
  }

  beforeAll(async () => {
    t = await freshApp(undefined, true);
    const people = { author: ['lims.master.author'], issuer: ['lims.analysis.perform'], asha: ['lims.analysis.perform', 'lims.demo.skip'],
      ravi: ['lims.analysis.perform'], meera: ['lims.qc.approve'] } as const;
    for (const [name, perms] of Object.entries(people)) {
      await seedUser(t.owner, name, [...perms]);
      cookies[name] = (await login(t.app, name)).cookie;
    }
    // The same database served by an installation that is not a demo.
    plain = await buildApp({ sql: t.sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, master: t.master, webRoot: '/nonexistent' });
    plainCookies.asha = (await login(plain, 'asha')).cookie;
  });
  afterAll(async () => { await plain?.close(); await t.close(); });

  it('the person with the demo permission skips the minimum time; the step history, the review and the PDF say who and when', async () => {
    const b = await issue();
    expect((await as('asha', 'POST', `/api/analyses/${b.id}/steps/0.1.0.1/record`, { values: { reading: '6.0' } })).statusCode).toBe(200);
    const done = async () => as('asha', 'POST', `/api/analyses/${b.id}/steps/0.1.0.1/done`, { proof: proofFor('asha'), contentHash: (await step(b.id, '0.1.0.1')).contentHash });
    expect((await done()).json()).toMatchObject({ error: 'not_ready' });
    const timer = 'min:0.1.0.1';
    expect((await as('ravi', 'POST', `/api/analyses/${b.id}/demo-skip`, { timer })).statusCode).toBe(403);
    expect((await as('asha', 'POST', `/api/analyses/${b.id}/demo-skip`, { timer })).statusCode).toBe(200);
    expect((await as('asha', 'POST', `/api/analyses/${b.id}/demo-skip`, { timer })).json()).toMatchObject({ error: 'no_wait' });
    const d = (await as('asha', 'GET', `/api/analyses/${b.id}`)).json() as { timers: { id: string; state: string; skipped?: object }[] };
    expect(d.timers).toMatchObject([{ id: timer, state: 'due', skipped: { person: expect.any(Number) } }]);
    const signed = await done();
    expect(signed.statusCode, signed.body).toBe(200);

    const history = (await as('asha', 'GET', `/api/analyses/${b.id}/steps/0.1.0.1/events`)).json() as { events: { kind: string; personName: string; payload: { label: string } }[] };
    expect(history.events.map((e) => e.kind)).toEqual(['started', 'value', 'demo_wait_skipped', 'done']);
    expect(history.events[2]).toMatchObject({ personName: 'ASHA', payload: { label: 'Minimum time of “Check a value against limits: pH” (30 min)' } });
    const review = (await as('meera', 'GET', `/api/analyses/${b.id}/review`)).json() as { demoSkips: { kind: string; personName: string }[] };
    expect(review.demoSkips).toMatchObject([{ kind: 'demo_wait_skipped', personName: 'ASHA' }]);
    const pdf = JSON.stringify(analysisRecordDoc(await recordInput(t.sql, (await loadAnalysis(t.sql, b.id))!), 'QA'));
    expect(pdf).toMatch(/DEMO: wait skipped by ASHA at \d+ \w+ 2026, \d\d:\d\d IST/);
    // A demo installation's PDF says DEMO in the header and footer of every page; any other's does not.
    const page = (demo: boolean) => { const d = analysisRecordDoc({ ...input }, 'QA', new Date(), demo); return JSON.stringify([d.header, typeof d.footer === 'function' ? d.footer(2, 3, { width: 0, height: 0 } as never) : d.footer]); };
    const input = await recordInput(t.sql, (await loadAnalysis(t.sql, b.id))!);
    expect(page(true)).toMatch(/"text":"DEMO · ".*DEMO installation, not a GMP record/);
    expect(page(false)).not.toContain('DEMO');
    const [a] = await t.owner<{ action: string }[]>`select action from audit_log where action = 'step.demo_wait_skipped' and object_id = ${String(b.id)}`;
    expect(a).toEqual({ action: 'step.demo_wait_skipped' });
  });

  it('the screens know a demo installation; one that is not a demo refuses the skip, and its screens show no DEMO', async () => {
    const b = await issue();
    expect((await as('asha', 'GET', '/api/me')).json()).toMatchObject({ demo: true });
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ demo: true });
    const refused = await call(plain, plainCookies.asha!, 'POST', `/api/analyses/${b.id}/demo-skip`, { timer: 'min:0.1.0.1' });
    expect([refused.statusCode, refused.json().error]).toEqual([403, 'not_demo']);
    expect((await call(plain, plainCookies.asha!, 'GET', '/api/me')).json().demo).toBeUndefined();
    expect((await plain.inject({ method: 'GET', url: '/api/health' })).json().demo).toBeUndefined();
    expect(timers((await loadAnalysis(t.sql, b.id))!.doc, (await loadAnalysis(t.sql, b.id))!.events, new Date())[0]!.skipped).toBeUndefined();
  });

  it('the terminal command skips every running wait of an analysis or a stage as the named person, and is refused when not a demo', async () => {
    const lines: string[] = [];
    expect(await demoSkipCommand(LIMS, ['LA260001', '--as', 'asha'], {}, (l) => lines.push(l))).toBe(2);
    expect(await demoSkipCommand(LIMS, ['LA260001', '--as', 'asha'], { LIMS_DEMO: 'yes' }, (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual(['Refused: Medhanta LIMS here is not a demo installation (LIMS_DEMO is not 1).',
      'Refused: Medhanta LIMS here is not a demo installation (LIMS_DEMO is not 1).']);
    expect(await demoSkipCommand(LIMS, ['LA260001'], { LIMS_DEMO: '1' }, () => {})).toBe(1);
    const b = await issue();
    expect(await skipWaits(t.sql, b.analysisNo, undefined, 'nobody')).toEqual({ error: 'There is no person nobody here: they sign in once first.' });
    expect(await skipWaits(t.sql, b.analysisNo, 'drying', 'asha')).toEqual({ error: `Analysis ${b.analysisNo} has no stage drying: 1 s0 (Stage 0).` });
    expect(await skipWaits(t.sql, b.analysisNo, 'Stage 0', 'asha')).toEqual({ skipped: ['Minimum time of “Check a value against limits: pH” (30 min)'] });
    expect(await skipWaits(t.sql, b.analysisNo, undefined, 'asha')).toEqual({ skipped: [] });
  });

});
