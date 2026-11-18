import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_LB, E2E_PRODUCT_ID, E2E_SCHEMA, E2E_TB } from './config.js';
import { logIn } from './helpers.js';

// The stability journey (LIMS-26, LIMS-28): QA approves a stability protocol on screen and another QA person makes it
// effective (the change control was typed: QMS is not linked); the sampler places a study for a TrueBatch batch, each
// condition in a chamber the Logbook says is fit; the 0-month pull, within its window, makes a stability sample of the
// protocol's specification, which names the study and time point. Setup (method, specification, the protocol's draft,
// its submission and check) goes through the API, as the other journeys do.

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, username);
  const proof = async (meaning: string) => /"signProof":"([^"]+)"/.exec(await (await page.request.get(`/sign?meanings=${meaning}`)).text())![1]!;
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<{ id: number; masterId: number }>;
  };
  return { ctx, page, proof, post };
}
async function sign(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const owner = () => connect(TEST_DATABASE_URL);
test.beforeAll(async () => {
  // TrueBatch's batch_fact_v1 and the Logbook's equipment_status_v1, for this journey only.
  const o = owner();
  await o.unsafe(`drop schema if exists ${E2E_TB} cascade; drop schema if exists ${E2E_LB} cascade; create schema ${E2E_TB}; create schema ${E2E_LB};
    create table ${E2E_TB}.batch_fact_v1 (batch_id uuid default gen_random_uuid(), batch_number text, product_code text, strength text, record_kind text, status text,
      issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now(),
      product_name text, good_quantity numeric, good_unit text, released_at timestamptz);
    insert into ${E2E_TB}.batch_fact_v1 (batch_number, product_code, product_name, status, completed_at, released, good_quantity, good_unit) values
      ('DEM-STB-01', 'FG-DEM100', 'Demolol 100 mg tablets', 'QC_APPROVED', now(), false, 98000, 'tablets');
    create view ${E2E_LB}.equipment_status_v1 as select * from (values
      ('eq-ch1', 'CH-01', 'equipment', 'in service', true, '{}'::text[], '{}'::text[], null::text, null::timestamptz, null::text),
      ('eq-ch2', 'CH-02', 'equipment', 'in service', true, '{}'::text[], '{}'::text[], null::text, null::timestamptz, null::text))
      as x (master_id, code, kind, state, fit_for_use, blockers, warnings, in_use_batch, cleaned_at, cleaned_by), lateral (select now() as checked_at) n;
    grant usage on schema ${E2E_TB}, ${E2E_LB} to lims_app; grant select on all tables in schema ${E2E_TB}, ${E2E_LB} to lims_app;`);
  await o.end();
});
test.afterAll(async () => {
  const o = owner();
  await o.unsafe(`drop schema if exists ${E2E_TB} cascade; drop schema if exists ${E2E_LB} cascade;`);
  await o.end();
});

test('LIMS-26 LIMS-28 stability journey: a protocol approved, a study placed for a TrueBatch batch, a pull within its window makes the stability sample', async ({ browser }) => {
  // Method and specification of FG-DEM100 (assay 95.0 to 105.0 %, on stability too), made effective.
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Measurement', steps: [{ key: 'ph', settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-090', name: 'pH of a 10 % suspension', technique: 'Other', reference: 'In-house method QC-M-090' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const spec = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'product', itemId: E2E_PRODUCT_ID, code: 'FG-DEM100', name: 'Demolol 100 mg tablets', type: 'Finished product', number: 'SPEC-FG-DEM100-S', pharmacopoeia: 'In-house' },
    tests: [{ key: 'ph', name: 'pH', method: { masterId: m.masterId, code: 'QC-M-090', name: 'pH of a 10 % suspension' }, result: 's0/ph/readingCheck', limitType: 'range',
      limit: { low: '5.0', high: '7.0', unit: '' }, values: {}, use: 'release and stability' }],
  } });
  const o = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await o`update master_versions set state = ${s} where id in (${m.id}, ${spec.id})`;
  await o.end();
  await iss.ctx.close();

  // The protocol's draft, sent for review and checked (API).
  const author = await person(browser, 'author1');
  const p = await author.post('/api/masters', { kind: 'protocol', doc: {
    header: { of: 'product', itemId: E2E_PRODUCT_ID, code: '', name: '', number: 'STP-FG-DEM100', purpose: 'registration', containerClosure: 'Alu-Alu blister, 10 tablets',
      sameAsMarketed: true, shelfLifeMonths: 24 },
    spec: { versionId: spec.id, number: '', versionNo: 1 }, quantity: { amount: '20', unit: 'tablets' }, pullWindowDays: 7,
    conditions: [{ key: 'lt', code: '30/75', role: 'long-term', months: [0, 3, 6, 9, 12, 18, 24] }, { key: 'acc', code: '40/75', role: 'accelerated', months: [0, 3, 6] }],
    design: { type: 'full', factors: [], matrix: [] },
  } });
  const hash = async (who: Awaited<ReturnType<typeof person>>) => ((await (await who.page.request.get(`/api/master-versions/${p.id}/review`)).json()) as { contentHash: string }).contentHash;
  await author.post(`/api/master-versions/${p.id}/submit`, { proof: await author.proof('prepared'), contentHash: await hash(author) });
  await author.ctx.close();
  const checker = await person(browser, 'mcheck1');
  await checker.post(`/api/master-versions/${p.id}/pass`, { proof: await checker.proof('checked'), contentHash: await hash(checker) });
  await checker.ctx.close();

  // QA approves the protocol on screen, with the change control; another QA person makes it effective.
  const qa = await person(browser, 'qa1');
  await qa.page.getByRole('button', { name: 'Stability', exact: true }).click();
  await qa.page.getByRole('button', { name: 'Protocols' }).click();
  await qa.page.getByRole('table', { name: 'Protocols' }).getByRole('row', { name: /STP-FG-DEM100/ }).click();
  await expect(qa.page.locator('.d-title')).toContainText('In review');
  await expect(qa.page.locator('.plain-view')).toContainText('30 °C / 75 % RH (India, zone IVb) (long-term): 0, 3, 6, 9, 12, 18, 24 months.');
  await expect(qa.page.getByLabel('Master check')).toContainText('No problems');
  await qa.page.getByRole('button', { name: 'Approve' }).click();
  await qa.page.getByLabel('Change control number').fill('CC-2026-044');
  await qa.page.getByRole('button', { name: 'Continue to sign' }).click();
  await sign(qa.page);
  await expect(qa.page.locator('.d-title')).toContainText('Approved');
  await qa.ctx.close();
  const qa2 = await person(browser, 'qa2');
  await qa2.page.getByRole('button', { name: 'Stability', exact: true }).click();
  await qa2.page.getByRole('button', { name: 'Protocols' }).click();
  await qa2.page.getByRole('table', { name: 'Protocols' }).getByRole('row', { name: /STP-FG-DEM100/ }).click();
  await qa2.page.getByRole('button', { name: 'Make effective' }).click();
  await qa2.page.getByRole('dialog').getByRole('button', { name: 'Make effective' }).click();
  await expect(qa2.page.locator('.d-title')).toContainText('Effective');
  await qa2.ctx.close();

  // The sampler places a study for the TrueBatch batch: each condition in a chamber the Logbook says is fit.
  const smp = await person(browser, 'smp1');
  await smp.page.getByRole('button', { name: 'Stability', exact: true }).click();
  await smp.page.getByRole('button', { name: 'New study' }).click();
  const dlg = smp.page.getByRole('dialog', { name: 'New study' });
  await dlg.getByLabel('Protocol').selectOption({ label: 'STP-FG-DEM100 · FG-DEM100 Demolol 100 mg tablets · Alu-Alu blister, 10 tablets (version 1)' });
  await expect(dlg.getByLabel('Batch')).toContainText('TrueBatch batch DEM-STB-01');
  await dlg.getByLabel('Batch').selectOption('DEM-STB-01');
  await dlg.getByLabel('Chamber for lt').selectOption('eq-ch1');
  await dlg.getByLabel('Quantity for lt').fill('140');
  await dlg.getByLabel('Chamber for acc').selectOption('eq-ch2');
  await dlg.getByLabel('Quantity for acc').fill('60');
  await dlg.getByRole('button', { name: 'Place the study' }).click();
  const heading = smp.page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(/^STB\d{5}$/);
  const studyNo = await heading.innerText();
  await expect(smp.page.getByRole('region', { name: 'The study' })).toContainText('From TrueBatch: TrueBatch batch DEM-STB-01');
  const stock = smp.page.getByRole('table', { name: 'Stock per condition' });
  await expect(stock.getByRole('row', { name: /30 °C/ })).toContainText('140 tablets');

  // The 0-month pull at 30 °C / 75 % RH is due today, within its window: pulling it registers the stability sample.
  const points = smp.page.getByRole('table', { name: 'Time points' });
  await expect(points.getByRole('row').nth(2)).toContainText('Not yet');
  await smp.page.getByRole('button', { name: 'Pull 30 °C / 75 % RH (India, zone IVb) 0 months' }).click();
  await expect(smp.page.getByRole('status')).toContainText(/Stability sample LS\d{7} registered/);
  const sampleNo = /LS\d{7}/.exec(await smp.page.getByRole('status').innerText())![0];
  await expect(points.getByRole('row').nth(1)).toContainText('Pulled');
  await expect(points.getByRole('row').nth(1)).toContainText(sampleNo);
  await expect(stock.getByRole('row', { name: /30 °C/ })).toContainText('120');
  await expect(smp.page.getByRole('table', { name: 'Results' })).toContainText(sampleNo);

  // The sample: purpose stability, the protocol's specification, the study and time point named.
  await smp.page.getByRole('button', { name: 'Samples', exact: true }).click();
  await smp.page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: new RegExp(sampleNo) }).click();
  const facts = smp.page.getByRole('region', { name: 'The sample' });
  await expect(facts).toContainText('Stability');
  await expect(facts).toContainText(`${studyNo}, 30 °C / 75 % RH (India, zone IVb), 0 months`);
  await expect(facts).toContainText('SPEC-FG-DEM100-S, version 1');
  await smp.ctx.close();
});
