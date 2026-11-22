import { expect, test, type Browser } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_IPC_PRODUCT_ID, E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The in-process journey (owner 19 Nov 2026): TrueBatch Oral Liquids' bulk test of batch DEM-IPC-01 is an open lab request
// (e2e/server.ts). The analyst picks it on the Samples screen: the in-process sample is made from it, nothing typed but
// the quantity; it is tested for the request's field only; QC approves an in-process test report (IPR). Setup (method,
// in-process specification) and the analysis go through the API, as the other journeys do.

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, username);
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<{ id: number; masterId: number }>;
  };
  // A signing proof, as the sign window gets it from the stand-in for core.
  const proof = async (meaning: string) => /"signProof":"([^"]+)"/.exec(await (await page.request.get(`/sign?meanings=${meaning}`)).text())![1]!;
  return { ctx, page, post, proof };
}

test('in-process journey: an open TrueBatch Oral Liquids request picked, its sample tested for its field, QC approves an in-process test report', async ({ browser }) => {
  test.setTimeout(120_000);
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Measurement', steps: [{ key: 'ph', settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-090', name: 'pH of the bulk (in-process journey)', technique: 'Other', reference: 'In-house method QC-M-090' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const t = (key: string, name: string, ipcField: string) => ({ key, name, method: { masterId: m.masterId, code: 'QC-M-090', name: 'pH' }, result: 's0/ph/readingCheck',
    limitType: 'range', limit: { low: '4.5', high: '6.0', unit: '' }, use: 'release', ipcField });
  const spec = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'product', itemId: E2E_IPC_PRODUCT_ID, code: 'LQ-IPC125', name: 'Demolol syrup 125 mg/5 mL', type: 'In-process', number: 'SPEC-IP-LQ-IPC125', pharmacopoeia: 'In-house' },
    tests: [t('ph', 'pH of the bulk', 'ph'), t('ph-final', 'pH after filling', 'ph_final')] } });
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id in (${m.id}, ${spec.id})`;
  await owner.end();

  // The analyst picks the open request: nothing typed but the quantity taken.
  const lab1 = await person(browser, 'lab1');
  await lab1.page.getByRole('button', { name: 'Samples', exact: true }).click();
  const panel = lab1.page.getByRole('region', { name: 'In-process requests' });
  const row = panel.getByRole('row', { name: /DEM-IPC-01/ });
  await expect(row).toContainText('TrueBatch Oral Liquids');
  await expect(row).toContainText('Bulk test (QA hold)');
  await expect(row).toContainText('SPEC-IP-LQ-IPC125, version 1');
  await row.getByRole('button', { name: /^Take the sample of/ }).click();
  const dlg = lab1.page.getByRole('dialog', { name: 'Take the in-process sample' });
  await expect(dlg).toContainText('for: pH of the bulk');
  await dlg.getByLabel('Quantity taken').fill('100 mL');
  await dlg.getByRole('button', { name: 'Make the sample' }).click();
  // The sample screen: the request named; only the requested test applies.
  await expect(lab1.page.getByText('DEM-IPC-01/bulk: Compounding › Bulk test (QA hold) · pH of the bulk')).toBeVisible();
  const tests = lab1.page.getByRole('region', { name: 'Tests' });
  await expect(tests.getByRole('row', { name: /pH after filling/ })).toContainText('not for this sample');
  const sampleId = ((await (await lab1.page.request.get('/api/samples')).json()) as { id: number; lotNo: string }[]).find((x) => x.lotNo === 'DEM-IPC-01')!.id;
  await lab1.ctx.close();

  // Received; analysed by iss1 and reviewed by rev1 (through the API).
  const smp = await person(browser, 'smp1');
  await smp.post(`/api/samples/${sampleId}/receive`, { condition: 'Bulk sample, 100 mL amber bottle' });
  await smp.ctx.close();
  const a = await iss.post('/api/analyses', { masterVersionId: m.id, sampleId, proof: await iss.proof('issued') });
  const step = (action: string, data: object = {}) => iss.post(`/api/analyses/${a.id}/steps/0.1.0.1/${action}`, data);
  await step('start');
  await step('record', { values: { reading: '5.2' } });
  const hash = ((await (await iss.page.request.get(`/api/analyses/${a.id}`)).json()) as { steps: { id: string; contentHash: string }[] }).steps.find((x) => x.id === '0.1.0.1')!.contentHash;
  await step('done', { proof: await iss.proof('performed'), contentHash: hash });
  await iss.ctx.close();
  const rev = await person(browser, 'rev1');
  const ah = ((await (await rev.page.request.get(`/api/analyses/${a.id}`)).json()) as { analysis: { contentHash: string } }).analysis.contentHash;
  await rev.post(`/api/analyses/${a.id}/review`, { proof: await rev.proof('reviewed'), contentHash: ah });
  await rev.ctx.close();

  const qc = await person(browser, 'qc1');
  await qc.page.getByRole('button', { name: 'Samples', exact: true }).click();
  await qc.page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: /DEM-IPC-01/ }).click();
  await expect(qc.page.getByRole('region', { name: 'Tests' })).toContainText('pH of the bulk');
  const decision = qc.page.getByRole('region', { name: 'QC decision' });
  await decision.getByRole('button', { name: 'Sign: QC approved' }).click();
  await qc.page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(decision).toContainText(/Approved, in-process test report IPR\d{7}/);
  await expect(decision.getByRole('link', { name: 'In-process test report (PDF)' })).toBeVisible();
  if (process.env.SHOTS) await qc.page.screenshot({ path: `${process.env.SHOTS}/in-process-approved.png`, fullPage: true });
  await qc.ctx.close();
});
