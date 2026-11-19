import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { call, freshApp, login, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';
import { c1WithinLimits, Dec } from '../shared/templates/index.js';
import { convert, findUnit, unit, whyNot } from '../shared/templates/units.js';

// Hotfix 19 Nov 2026 (the TrueBatch Liquids release CoA): viscosity units, the batches of every TrueBatch production
// edition, and a release (bulk) sample of a batch still in production.

describe('viscosity units', () => {
  it('LIMS-15 dynamic viscosity in mPa·s (= cP), Pa·s and P converts exactly; kinematic viscosity (mm²/s = cSt) is another kind', () => {
    expect(convert(new Dec('1.25'), unit('Pa·s'), unit('mPa·s')).toString()).toBe('1250');
    expect(convert(new Dec('85'), unit('cP'), unit('mPa·s')).toString()).toBe('85');
    expect(convert(new Dec('1'), unit('P'), unit('mPa·s')).toString()).toBe('100');
    expect(convert(new Dec('20'), unit('cSt'), unit('mm²/s')).toString()).toBe('20');
    expect(whyNot(findUnit('mPa·s')!, findUnit('mm²/s')!)).toMatch(/cannot be converted/);
    expect(whyNot(findUnit('mPa·s')!, findUnit('Pa')!)).toMatch(/cannot be converted/);
    const r = c1WithinLimits({ value: { value: '85', unit: 'mPa·s' }, limit: { low: '50', high: '150', unit: 'mPa·s' } });
    expect(r.ok && r.check?.pass).toBe(true);
  });
});

let t: TestApp;
let provider: Sql;
const S = { tb: '', lq: '', cp: '' };
const cookies: Record<string, string> = {};
const batchTable = (schema: string) => `create table ${schema}.batch_fact_v1 (batch_id uuid default gen_random_uuid(), batch_number text, product_code text, strength text, record_kind text,
  status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now(),
  product_name text, good_quantity numeric, good_unit text);`;
beforeAll(async () => {
  t = await freshApp(async (db) => {
    S.tb = `${db.schema}_tb`; S.lq = `${db.schema}_lq`; S.cp = `${db.schema}_cp`;
    await db.owner.unsafe(`create schema ${S.tb}; create schema ${S.lq}; create schema ${S.cp};
      ${batchTable(S.tb)} ${batchTable(S.lq)}
      insert into ${S.tb}.batch_fact_v1 (batch_number, product_code, product_name, status, completed_at, released) values ('TB26001', 'FG-001', 'Examplol 500 mg tablets', 'COMPLETED', now(), false);
      insert into ${S.lq}.batch_fact_v1 (batch_number, product_code, product_name, status, completed_at, released) values
        ('TL260004', 'LQ-001', 'Examplol syrup 125 mg/5 mL', 'IN_PRODUCTION', null, false),
        ('TL260009', 'LQ-001', 'Examplol syrup 125 mg/5 mL', 'RELEASED', now(), true);
      grant usage on schema ${S.tb}, ${S.lq}, ${S.cp} to lims_app; grant select on all tables in schema ${S.tb}, ${S.lq} to lims_app;`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    // Capsules is linked but its view is not there: that edition is down.
    return links({ truebatch: provider, truebatch_liquids: provider, truebatch_capsules: provider }, { truebatch: S.tb, truebatch_liquids: S.lq, truebatch_capsules: S.cp });
  });
  await seedUser(t.owner, 'sampler', ['lims.sample.register']);
  cookies.sampler = (await login(t.app, 'sampler')).cookie;
});
afterAll(async () => { await provider?.end(); await t.close(); });

describe('the batches of every TrueBatch production edition', () => {
  it('PL-08 batches waiting come from every linked edition, each named by it; an edition that does not answer leaves the others answering', async () => {
    const w = await t.app.links.truebatch.waiting();
    expect(w.state).toBe('ok');
    expect(w.state === 'ok' && w.value.map((b) => [b.batchNumber, b.edition, b.status])).toEqual([['TB26001', 'truebatch', 'COMPLETED'], ['TL260004', 'truebatch_liquids', 'IN_PRODUCTION']]);
    const found = await t.app.links.truebatch.batch('TL260004');
    expect(found).toMatchObject({ state: 'ok', value: { batchNumber: 'TL260004', edition: 'truebatch_liquids' } });
    // Not found in those that answer while one is down: down, so it may be typed by hand.
    expect((await t.app.links.truebatch.batch('TC260001')).state).toBe('down');
    const r = await call(t.app, cookies.sampler!, 'GET', '/api/sample-requests');
    expect(r.json().requests.map((x: { lotNo: string; shown: string }) => [x.lotNo, x.shown.split(':')[0]])).toEqual([['TB26001', 'TrueBatch Tablets batch TB26001'], ['TL260004', 'TrueBatch Liquids batch TL260004']]);
  });
});
