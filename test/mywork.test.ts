import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp } from './helpers.js';
import { small } from './engine-fixture.js';

// GET /api/analyses: "My work" on the lab screens: the analyses in progress with what waits for each person.

let t: TestApp;
const cookies: Record<string, string> = {};
const as = (who: string, method: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, method, url, body);
interface Work { id: number; analysisNo: string; status: string; current: { step: string; stage: string; title: string; state: string } | null; badges: { kind: string; step?: string; title: string; at?: string }[] }
const mine = async (who: string) => (await as(who, 'GET', '/api/analyses')).json() as Work[];
const step = async (id: number, key: string, who: string) =>
  ((await as(who, 'GET', `/api/analyses/${id}`)).json() as { steps: { id: string; contentHash: string }[] }).steps.find((s) => s.id === key)!;
const act = (who: string, id: number, key: string, action: string, body: object = {}) => as(who, 'POST', `/api/analyses/${id}/steps/${key}/${action}`, body);
const sign = async (who: string, id: number, key: string, action: string) =>
  act(who, id, key, action, { proof: proofFor(who), contentHash: (await step(id, key, who)).contentHash });

async function issue(doc: ReturnType<typeof small>) {
  const { id: mv } = (await as('author', 'POST', '/api/masters', { doc })).json() as { id: number };
  for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${mv}`;
  return (await as('issuer', 'POST', '/api/analyses', { masterVersionId: mv, proof: proofFor('issuer') })).json() as { id: number; analysisNo: string };
}

beforeAll(async () => {
  t = await freshApp();
  const people = { author: ['lims.master.author'], issuer: ['lims.analysis.perform'], asha: ['lims.analysis.perform', 'lims.analysis.check'],
    ravi: ['lims.analysis.check'], sam: ['lims.analysis.review'], viewer: ['lims.view'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(() => t.close());

describe('My work', () => {
  let b: { id: number; analysisNo: string };
  beforeAll(async () => {
    b = await issue(small([{ steps: [{ checker: true }] }]));
  });

  it('an analyst sees the analysis with its current step; a checker without work does not; the analysis shows the server time', async () => {
    expect((await mine('asha')).find((w) => w.id === b.id)).toMatchObject({ analysisNo: b.analysisNo, status: 'in progress',
      current: { step: '0.1.0.1', stage: 'Stage 0', title: 'Check a value against limits: pH', state: 'open' }, badges: [] });
    expect((await mine('ravi')).some((w) => w.id === b.id)).toBe(false);
    expect((await mine('viewer'))).toEqual([]);
    const now = ((await as('viewer', 'GET', `/api/analyses/${b.id}`)).json() as { now: string }).now;
    expect(Math.abs(Date.parse(now) - Date.now())).toBeLessThan(60_000);
  });

  it('LIMS-41 the checker\'s own list: a step waiting for check is listed for a second person only, never for its performer', async () => {
    await act('asha', b.id, '0.1.0.1', 'start');
    await act('asha', b.id, '0.1.0.1', 'record', { values: { reading: '6.0' } });
    expect((await sign('asha', b.id, '0.1.0.1', 'done')).statusCode).toBe(200);
    expect((await mine('ravi')).find((w) => w.id === b.id)!.badges).toEqual([{ kind: 'check', step: '0.1.0.1', stage: 'Stage 0', title: 'Check a value against limits: pH' }]);
    expect((await mine('asha')).find((w) => w.id === b.id)!.badges).toEqual([]);
  });

  it('LIMS-18 a corrected value asks for signing again; a complete analysis waits for the second person\'s review, then leaves the list', async () => {
    expect((await act('asha', b.id, '0.1.0.1', 'correct', { values: { reading: '6.1' }, reason: 'Misread the meter' })).statusCode).toBe(200);
    expect((await mine('asha')).find((w) => w.id === b.id)!.badges).toMatchObject([{ kind: 'resign', step: '0.1.0.1' }]);
    await sign('asha', b.id, '0.1.0.1', 'done');
    expect((await mine('sam')).some((w) => w.id === b.id)).toBe(false);
    await sign('ravi', b.id, '0.1.0.1', 'check');
    const w = (await mine('sam')).find((x) => x.id === b.id)!;
    expect(w).toMatchObject({ status: 'complete', current: null, badges: [{ kind: 'review' }] });
    // The analyst and the checker took part: the review is not on their lists.
    expect((await mine('ravi')).some((x) => x.id === b.id)).toBe(false);
    const full = (await as('sam', 'GET', `/api/analyses/${b.id}`)).json() as { analysis: { contentHash: string } };
    expect((await as('sam', 'POST', `/api/analyses/${b.id}/review`, { proof: proofFor('sam'), contentHash: full.analysis.contentHash })).statusCode).toBe(200);
    expect((await mine('sam')).some((x) => x.id === b.id)).toBe(false);
    // Done on the bench: the reviewed analysis stays one tap away for the people who did it.
    expect(((await as('asha', 'GET', '/api/analyses/finished')).json() as { id: number; status: string }[]).find((x) => x.id === b.id)).toMatchObject({ status: 'reviewed' });
  });

  it('a reading at intervals started shows when the next round is due', async () => {
    const c = await issue(small([{ steps: [{ block: { id: 'periodic-check', version: 1 }, everyMinutes: 30, flow: { kind: 'repeat-until', maxRounds: 40 },
      settings: { what: 'Column temperature', unit: '°C', limit: { low: '28', high: '32', unit: '°C' } } }] }]));
    await act('asha', c.id, '0.1.0.1', 'start');
    const due = (await mine('asha')).find((w) => w.id === c.id)!.badges;
    expect(due).toMatchObject([{ kind: 'due', step: '0.1.0.1', stage: 'Stage 0', title: 'Read a value at intervals: Column temperature' }]);
    expect(Date.parse(due[0]!.at!) - Date.now()).toBeGreaterThan(29 * 60_000);
  });
});
