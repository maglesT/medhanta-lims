import { readFileSync } from 'node:fs';
import { expect, test, type Browser } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_SCHEMA, E2E_TREND_PRODUCT_ID } from './config.js';
import { logIn } from './helpers.js';

// The trends journey (LIMS-25, LIMS-42): nine batches of a product have their pH decided by QC; on the Trends tab the
// control chart of the product's pH shows the last batch beyond 3 sigma (Nelson rule 1) with its point; the APQR summary
// of the product lists the results with their Cpk and is exported as CSV. Setup (method, specification, the samples,
// their analyses, reviews and decisions) goes through the API, as the other journeys do.

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  await logIn(page, username);
  const proof = async (meaning: string) => /"signProof":"([^"]+)"/.exec(await (await page.request.get(`/sign?meanings=${meaning}`)).text())![1]!;
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<{ id: number; masterId: number }>;
  };
  const get = async <T>(url: string) => (await (await page.request.get(url)).json()) as T;
  return { ctx, page, proof, post, get };
}

// 6.0 6.1 5.9 6.0 6.1 5.9 6.0 6.1, then 6.8: mean 54.9 ÷ 9 = 6.1, MR̄ 1.6 ÷ 8 = 0.2, sigma 0.177, upper limit 6.632.
const READINGS = ['6.0', '6.1', '5.9', '6.0', '6.1', '5.9', '6.0', '6.1', '6.8'];

test('LIMS-25 LIMS-42 trends journey: the control chart of a product\'s pH shows a Nelson rule break; the APQR summary exports CSV', async ({ browser }) => {
  test.setTimeout(180_000);
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Measurement', steps: [{ key: 'ph', settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-081', name: 'pH of a 5 % solution', technique: 'Other', reference: 'In-house method QC-M-081' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const spec = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'product', itemId: E2E_TREND_PRODUCT_ID, code: 'FG-TRD050', name: 'Trendolol 50 mg tablets', type: 'Finished product', number: 'SPEC-FG-TRD050', pharmacopoeia: 'In-house' },
    tests: [{ key: 'ph', name: 'pH', method: { masterId: m.masterId, code: 'QC-M-081', name: 'pH of a 5 % solution' }, result: 's0/ph/readingCheck', limitType: 'range',
      limit: { low: '5.0', high: '7.0', unit: '' }, values: {}, use: 'release and stability' }],
  } });
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id in (${m.id}, ${spec.id})`;
  await owner.end();
  await iss.ctx.close();

  const [smp1, smp2, op, rev, qc] = await Promise.all([person(browser, 'smp1'), person(browser, 'smp2'), person(browser, 'op1'), person(browser, 'rev1'), person(browser, 'qc1')]);
  for (const [k, reading] of READINGS.entries()) {
    const sample = await smp1.post('/api/samples', { source: 'truebatch', batchNumber: `TRD-${String(k + 1).padStart(2, '0')}`, byHand: true, itemId: E2E_TREND_PRODUCT_ID,
      specVersionId: spec.id, quantity: '40 tablets' });
    await smp2.post(`/api/samples/${sample.id}/check`, {});
    await smp1.post(`/api/samples/${sample.id}/receive`, { condition: 'Sealed' });
    const a = await op.post('/api/analyses', { masterVersionId: m.id, sampleId: sample.id, proof: await op.proof('issued') });
    const step = (action: string, body: object = {}) => op.post(`/api/analyses/${a.id}/steps/0.1.0.1/${action}`, body);
    await step('start');
    await step('record', { values: { reading } });
    await step('done', { proof: await op.proof('performed'), contentHash: (await op.get<{ steps: { contentHash: string }[] }>(`/api/analyses/${a.id}`)).steps[0]!.contentHash });
    await rev.post(`/api/analyses/${a.id}/review`, { proof: await rev.proof('reviewed'), contentHash: (await rev.get<{ analysis: { contentHash: string } }>(`/api/analyses/${a.id}`)).analysis.contentHash });
    await qc.post(`/api/samples/${sample.id}/approve`, { proof: await qc.proof('qc_approved'), contentHash: (await qc.get<{ decisionHash: string }>(`/api/samples/${sample.id}`)).decisionHash });
  }
  await Promise.all([smp1, smp2, op, rev].map((p) => p.ctx.close()));

  // QC opens Trends: the control chart of FG-TRD050 pH, with the specification and the rule break at batch TRD-09.
  const page = qc.page;
  await page.goto('/');
  await page.getByRole('button', { name: 'Trends', exact: true }).click();
  await page.getByLabel('Series').selectOption({ label: 'FG-TRD050 Trendolol 50 mg tablets · pH · 9 results' });
  const chart = page.getByRole('region', { name: 'Control chart' });
  await expect(chart.getByRole('heading', { level: 2 })).toContainText('FG-TRD050 Trendolol 50 mg tablets · pH');
  await expect(chart).toContainText('SPEC-FG-TRD050 v1: NLT 5.0, NMT 7.0');
  await expect(chart).toContainText('Individuals chart of 9 results: centre line 6.100, sigma = MR̄ 0.2000 ÷ 1.128 = 0.1773, control limits 5.568 to 6.632; 1 rule break (rule 1)');
  await expect(chart.getByRole('img', { name: 'Individuals control chart' })).toBeVisible();
  const breaks = chart.getByRole('table', { name: 'Rule breaks' });
  await expect(breaks.getByRole('row')).toHaveCount(2);
  await expect(breaks).toContainText('Rule 1');
  await expect(breaks).toContainText('One point more than 3 sigma from the centre line');
  await expect(breaks).toContainText('9 (TRD-09)');
  await expect(chart.getByRole('table', { name: 'Results' }).getByRole('row')).toHaveCount(10);
  await page.screenshot({ path: test.info().outputPath('trends-control-chart.png'), fullPage: true });

  // The APQR summary of the product for this year, and its CSV export.
  await page.getByRole('navigation', { name: 'Trends' }).getByRole('button', { name: 'APQR' }).click();
  await page.getByLabel('Product or material').selectOption({ label: 'FG-TRD050 Trendolol 50 mg tablets (product)' });
  await page.getByLabel('Period from').fill('2026-01-01');
  await page.getByLabel('Period to').fill('2099-12-31');
  await page.getByRole('button', { name: 'Show the summary' }).click();
  const summary = page.getByRole('region', { name: 'APQR summary' });
  await expect(summary).toContainText('9 lots decided, 0 rejected');
  const results = summary.getByRole('table', { name: 'Results summary' });
  // n 9, min 5.900, max 6.800, mean 6.100; Cpk = min(0.9, 1.1) ÷ (3 × 0.17730) = 1.69; rule 1 broken.
  await expect(results.getByRole('row', { name: /pH/ })).toContainText('5.0 to 7.0');
  await expect(results.getByRole('row', { name: /pH/ }).getByRole('cell')).toHaveText(['pH', '5.0 to 7.0', '9', '0', '9', '5.900', '6.800', '6.100', '0.274', '1.69', '1']);
  // The setup made the versions effective directly (no approval entries): no change in the period is listed.
  await expect(summary).toContainText('No version made effective in the period.');
  await page.screenshot({ path: test.info().outputPath('trends-apqr.png'), fullPage: true });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toBe('APQR-FG-TRD050-2026-01-01-2099-12-31.csv');
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv).toContain('Results,pH,5.0 to 7.0,9,0,9,5.900,6.800,6.100,0.274,1.69,1');
  expect(csv).toContain('Lots,LS');
  expect(csv).toContain(',TRD-09,release,approved,');
  await qc.ctx.close();
});
