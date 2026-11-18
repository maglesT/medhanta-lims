import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_PRODUCT_ID, E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The paper journey (build step 8c): the sampler prints the sample's labels (LIMS-06); the analyst issues a numbered
// blank worksheet for paper and prints it (LIMS-54), enters a contract lab's result from its report (LIMS-22), a
// second person checks it, the form comes back unused and leaves the reconciliation list, and QC approves on the outside
// result. Setup (method, specification, the batch's sample) goes through the API, as the other journeys do.

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, username);
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<{ id: number; masterId: number }>;
  };
  return { ctx, page, post };
}
async function openSample(page: Page, batch: string) {
  await page.getByRole('button', { name: 'Samples', exact: true }).click();
  await page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: new RegExp(batch) }).click();
}

test('LIMS-06 LIMS-22 LIMS-54 paper journey: labels printed, a numbered blank worksheet issued and reconciled, an outside lab result checked and approved', async ({ browser }) => {
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Measurement', steps: [{ key: 'ph', settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-080', name: 'pH of a 10 % suspension (paper journey)', technique: 'Other', reference: 'In-house method QC-M-080' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const spec = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'product', itemId: E2E_PRODUCT_ID, code: 'FG-DEM100', name: 'Demolol 100 mg tablets', type: 'Finished product', number: 'SPEC-FG-DEM100-P', pharmacopoeia: 'In-house' },
    tests: [{ key: 'ph', name: 'pH', method: { masterId: m.masterId, code: 'QC-M-080', name: 'pH' }, result: 's0/ph/readingCheck', limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' } }] } });
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id in (${m.id}, ${spec.id})`;
  await owner.end();
  await iss.ctx.close();
  const smp2 = await person(browser, 'smp2');
  const sample = await smp2.post('/api/samples', { source: 'truebatch', batchNumber: 'DEM-PAP-01', byHand: true, itemId: E2E_PRODUCT_ID, specVersionId: spec.id, quantity: '40 tablets', containers: 2 });
  await smp2.ctx.close();
  const smp1 = await person(browser, 'smp1');
  await smp1.post(`/api/samples/${sample.id}/check`, {});
  await smp1.post(`/api/samples/${sample.id}/receive`, { condition: 'Sealed, 2 containers' });

  // LIMS-06: the sampler prints the labels from the sample screen.
  await openSample(smp1.page, 'DEM-PAP-01');
  const [labels] = await Promise.all([smp1.page.waitForEvent('download'), smp1.page.getByRole('link', { name: 'Print labels (PDF)' }).click()]);
  expect(labels.suggestedFilename()).toMatch(/^labels-LS\d{7}\.pdf$/);
  await smp1.ctx.close();

  // LIMS-54: the analyst issues a blank worksheet for paper, with its reason, and prints it.
  const lab1 = await person(browser, 'lab1');
  await openSample(lab1.page, 'DEM-PAP-01');
  const forms = lab1.page.getByRole('region', { name: 'Paper worksheets' });
  await forms.getByRole('button', { name: 'Issue a blank worksheet' }).click();
  await lab1.page.getByRole('dialog').getByLabel('Reason').fill('Balance room terminal down');
  await lab1.page.getByRole('dialog').getByRole('button', { name: 'Issue' }).click();
  await expect(forms).toContainText(/LF\d{7}/);
  await expect(forms).toContainText('issued, not back yet');
  const formNo = /LF\d{7}/.exec(await forms.innerText())![0];
  const [blank] = await Promise.all([lab1.page.waitForEvent('download'), forms.getByRole('link', { name: 'Print (PDF)' }).click()]);
  expect(blank.suggestedFilename()).toBe(`form-${formNo}.pdf`);

  // LIMS-22: a contract lab's result, from its report.
  const tests = lab1.page.getByRole('region', { name: 'Tests' });
  await tests.getByRole('button', { name: 'Outside lab result' }).click();
  const dlg = lab1.page.getByRole('dialog', { name: 'Outside lab result' });
  await dlg.getByLabel('Outside lab').fill('Demo Analytical Services, Pune');
  await dlg.getByLabel('Report number').fill('DAS-2026-201');
  await dlg.getByLabel('Report file').setInputFiles({ name: 'DAS-2026-201.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo contract lab report') });
  await dlg.getByLabel('Result').fill('6.3');
  await dlg.getByRole('button', { name: 'Record the result' }).click();
  await expect(tests).toContainText('Demo Analytical Services, Pune, report DAS-2026-201');
  await expect(tests).toContainText('waits for a second person\'s check');
  // The Samples tab lists the form as not back.
  await lab1.page.getByRole('button', { name: '← Samples' }).click();
  await expect(lab1.page.getByRole('region', { name: 'Paper worksheets not back' })).toContainText(formNo);
  if (process.env.SHOTS) await lab1.page.screenshot({ path: `${process.env.SHOTS}/paper-not-back.png`, fullPage: true });

  // A second person checks the typed result against the report.
  const lab2 = await person(browser, 'lab2');
  await openSample(lab2.page, 'DEM-PAP-01');
  await lab2.page.getByRole('region', { name: 'Tests' }).getByRole('button', { name: 'Check against the report' }).click();
  await expect(lab2.page.getByRole('region', { name: 'Tests' })).toContainText('checked by LAB2');
  await lab2.ctx.close();

  // The form comes back unused and leaves the reconciliation list.
  await lab1.page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: /DEM-PAP-01/ }).click();
  await lab1.page.getByLabel(`Return of ${formNo}`).selectOption('unused');
  await lab1.page.getByRole('region', { name: 'Paper worksheets' }).getByRole('button', { name: 'Record' }).click();
  await expect(lab1.page.getByRole('region', { name: 'Paper worksheets' })).toContainText('returned unused');
  if (process.env.SHOTS) await lab1.page.screenshot({ path: `${process.env.SHOTS}/paper-sample.png`, fullPage: true });
  await lab1.page.getByRole('button', { name: '← Samples' }).click();
  await expect(lab1.page.getByRole('region', { name: 'Paper worksheets not back' })).toHaveCount(0);
  await lab1.ctx.close();

  // QC approves on the checked outside result.
  const qc = await person(browser, 'qc1');
  await openSample(qc.page, 'DEM-PAP-01');
  const decision = qc.page.getByRole('region', { name: 'QC decision' });
  await decision.getByRole('button', { name: 'Sign: QC approved' }).click();
  await qc.page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(decision).toContainText(/Approved, certificate COA\d{7}/);
  await qc.ctx.close();
});
