import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_PRODUCT_ID, E2E_RETEST_ID, E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The reserve and retest journey (LIMS-30, LIMS-31). A batch of FG-DEM100 whose specification asks for a 60-tablet
// reserve sample has a reviewed pH within limits: QC cannot approve it until the sampler logs the reserve sample on
// screen; then QC approves, and the reserve sample's yearly visual inspection is recorded. A released lot of RM-031 is
// past its retest date in MMS (e2e/server.ts): the sampler registers its retest sample from the retest-due list.
// Setup (method, specifications, the batch's sample and its analysis) goes through the API, as the other journeys do.

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, username);
  const proof = async (meaning: string) => /"signProof":"([^"]+)"/.exec(await (await page.request.get(`/sign?meanings=${meaning}`)).text())![1]!;
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<{ id: number; masterId: number; analysisNo: string }>;
  };
  return { ctx, page, proof, post };
}
async function sign(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('LIMS-30 LIMS-31 reserve and retest journey: QC approval waits for the reserve sample logged at the required quantity; a lot past its retest date gets its retest sample', async ({ browser }) => {
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Measurement', steps: [{ key: 'ph', settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-075', name: 'pH of a 10 % suspension (reserve journey)', technique: 'Other', reference: 'In-house method QC-M-075' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const test1 = { key: 'ph', name: 'pH', method: { masterId: m.masterId, code: 'QC-M-075', name: 'pH' }, result: 's0/ph/readingCheck', limitType: 'range',
    limit: { low: '5.0', high: '7.0', unit: '' }, values: {}, use: 'release and stability' };
  const fg = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'product', itemId: E2E_PRODUCT_ID, code: 'FG-DEM100', name: 'Demolol 100 mg tablets', type: 'Finished product', number: 'SPEC-FG-DEM100-R', pharmacopoeia: 'In-house', reserveQuantity: '60 tablets' },
    tests: [test1] } });
  const rm = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'material', itemId: E2E_RETEST_ID, code: 'RM-031', name: 'Exampline hydrochloride', type: 'Active substance', number: 'SPEC-RM-031', pharmacopoeia: 'Ph. Int.' },
    tests: [test1] } });
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id in (${m.id}, ${fg.id}, ${rm.id})`;
  await owner.end();
  await iss.ctx.close();
  // The batch typed by hand (TrueBatch is not linked here), checked, received; pH 6.2 signed and reviewed.
  const smp2 = await person(browser, 'smp2');
  const sample = await smp2.post('/api/samples', { source: 'truebatch', batchNumber: 'DEM-RSV-01', byHand: true, itemId: E2E_PRODUCT_ID, specVersionId: fg.id, quantity: '40 tablets' });
  const smp1 = await person(browser, 'smp1');
  await smp1.post(`/api/samples/${sample.id}/check`, {});
  await smp1.post(`/api/samples/${sample.id}/receive`, { condition: 'Sealed' });
  await smp2.ctx.close();
  const op = await person(browser, 'op1');
  const a = await op.post('/api/analyses', { masterVersionId: m.id, sampleId: sample.id, proof: await op.proof('issued') });
  const step = (action: string, body: object = {}) => op.post(`/api/analyses/${a.id}/steps/0.1.0.1/${action}`, body);
  await step('start');
  await step('record', { values: { reading: '6.2' } });
  const hash = (await (await op.page.request.get(`/api/analyses/${a.id}`)).json() as { steps: { contentHash: string }[] }).steps[0]!.contentHash;
  await step('done', { proof: await op.proof('performed'), contentHash: hash });
  await op.ctx.close();
  const rev = await person(browser, 'rev1');
  const ah = (await (await rev.page.request.get(`/api/analyses/${a.id}`)).json() as { analysis: { contentHash: string } }).analysis.contentHash;
  await rev.post(`/api/analyses/${a.id}/review`, { proof: await rev.proof('reviewed'), contentHash: ah });
  await rev.ctx.close();

  // QC: every test passed, but no reserve sample is logged: approval waits (LIMS-30).
  const qc = await person(browser, 'qc1');
  await qc.page.getByRole('button', { name: 'Samples', exact: true }).click();
  await qc.page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: /DEM-RSV-01/ }).click();
  const decision = qc.page.getByRole('region', { name: 'QC decision' });
  await expect(decision).toContainText('No reserve sample of this lot or batch is logged: the specification asks for at least 60 tablets');
  await expect(decision.getByRole('button', { name: 'Sign: QC approved' })).toBeDisabled();
  await expect(qc.page.getByRole('region', { name: 'Reserve sample' })).toContainText('QC approval waits for it.');

  // The sampler logs the reserve sample on screen: below the quantity is refused; then 60 tablets, kept to 1 year after expiry.
  await smp1.page.getByRole('button', { name: 'Samples', exact: true }).click();
  await smp1.page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: /DEM-RSV-01/ }).click();
  const panel = smp1.page.getByRole('region', { name: 'Reserve sample' });
  await panel.getByRole('button', { name: 'Log the reserve sample' }).click();
  const dialog = smp1.page.getByRole('dialog', { name: 'Log the reserve sample' });
  await expect(dialog).toContainText('The specification asks for at least 60 tablets');
  await dialog.getByLabel('Quantity kept').fill('40 tablets');
  await dialog.getByLabel('Storage location').fill('Reserve sample store, cabinet 3, shelf B');
  await dialog.getByLabel('Kept for').selectOption('expiry');
  await dialog.getByLabel('Expiry date of the lot or batch').fill('2028-10-31');
  await expect(dialog.getByRole('note')).toContainText('Kept until: on or after 31 Oct 2029 (1 year after the expiry date of the lot or batch).');
  await dialog.getByLabel('Kept until').fill('2029-10-31');
  await dialog.getByRole('button', { name: 'Log the reserve sample' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The specification asks for at least 60 tablets: keep at least that much');
  await dialog.getByLabel('Quantity kept').fill('60 tablets');
  await dialog.getByRole('button', { name: 'Log the reserve sample' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText('60 tablets kept · Reserve sample store, cabinet 3, shelf B · until 31 Oct 2029');
  await expect(panel).toContainText('Kept');

  // QC approves now.
  await qc.page.reload();
  await qc.page.getByRole('button', { name: 'Samples', exact: true }).click();
  await qc.page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: /DEM-RSV-01/ }).click();
  await expect(decision).not.toContainText('reserve sample');
  await decision.getByRole('button', { name: 'Sign: QC approved' }).click();
  await sign(qc.page);
  await expect(decision).toContainText(/Approved, certificate COA\d{7}/);
  await qc.ctx.close();

  // The reserve sample's screen: its facts, and the yearly visual inspection recorded.
  await panel.getByRole('button', { name: 'Open the reserve sample' }).click();
  await expect(smp1.page.getByRole('heading', { level: 1 })).toContainText('Reserve sample DEM-RSV-01');
  await expect(smp1.page.getByRole('region', { name: 'The reserve sample' })).toContainText('60 tablets left of 60 tablets logged');
  await smp1.page.getByRole('button', { name: 'Visual inspection' }).click();
  const insp = smp1.page.getByRole('dialog', { name: 'Yearly visual inspection' });
  await insp.getByLabel('Finding').selectOption('no deterioration');
  await insp.getByRole('button', { name: 'Record the inspection' }).click();
  await expect(smp1.page.getByRole('region', { name: 'Entries' })).toContainText('Visual inspection');
  await expect(smp1.page.getByRole('region', { name: 'Entries' })).toContainText('No deterioration');
  await expect(smp1.page.getByText('The reserve sample is kept until 31 Oct 2029: it is not destroyed earlier.')).toBeVisible();
  if (process.env.SHOTS) await smp1.page.screenshot({ path: `${process.env.SHOTS}/reserve-sample.png`, fullPage: true });
  await smp1.page.getByRole('button', { name: '← Samples' }).click();
  await expect(smp1.page.getByRole('table', { name: 'Reserve list' })).toContainText('DEM-RSV-01');

  // LIMS-31: the released lot RM-R1 is past its retest date with no retest sample; its retest sample is registered.
  const due = smp1.page.getByRole('region', { name: 'Retest due' });
  await expect(due.getByRole('note')).toContainText('Past the retest date with no retest sample: RM-R1.');
  const row = due.getByRole('row', { name: /RM-R1/ });
  await expect(row).toContainText('31 Jan 2026');
  await expect(row).toContainText('past');
  await expect(row).toContainText('SPEC-RM-031, version 1');
  await row.getByRole('button', { name: 'Register the retest sample of RM-R1' }).click();
  const reg = smp1.page.getByRole('dialog', { name: 'Register a sample' });
  await expect(reg.getByLabel('Purpose')).toHaveValue('retest');
  await reg.getByLabel('Quantity').fill('25 g');
  await reg.getByRole('button', { name: 'Register' }).click();
  await expect(smp1.page.getByRole('heading', { level: 1 })).toContainText(/LS\d{7}/);
  const retestNo = /LS\d{7}/.exec(await smp1.page.getByRole('heading', { level: 1 }).innerText())![0];
  await expect(smp1.page.getByRole('region', { name: 'The sample' })).toContainText('Retest');
  await smp1.page.getByRole('button', { name: '← Samples' }).click();
  await expect(due.getByRole('row', { name: /RM-R1/ })).toContainText(retestNo);
  await expect(due.getByRole('note')).toHaveCount(0);
  if (process.env.SHOTS) await smp1.page.screenshot({ path: `${process.env.SHOTS}/retest-due.png`, fullPage: true });
  await smp1.ctx.close();
});
