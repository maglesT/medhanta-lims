import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_PACK_ID, E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The reduced testing journey (LIMS-09): two lots of a packing material from Demo Pack Co through Demo Traders, whom
// QMS approves for reduced testing (e2e/server.ts). The first lot is tested in full (here by a contract lab, on
// screen); on the second QC records reduced testing, the identity is still tested, the thickness is typed from the
// manufacturer's certificate and checked by a second person who confirms its required fields, and QC approves.
// Setup (method, specification, the samples of the MMS lots) goes through the API, as the other journeys do.

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
async function openSample(page: Page, lot: string) {
  await page.getByRole('button', { name: 'Samples', exact: true }).click();
  await page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: new RegExp(lot) }).click();
}
const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${name}`) });
async function outside(page: Page, lot: string, test: string, lab: string | null, no: string, value: string) {
  await openSample(page, lot);
  const tests = page.getByRole('region', { name: 'Tests' });
  await tests.getByRole('button', { name: lab ? 'Outside lab result' : 'Supplier\'s certificate result' }).click();
  const dlg = page.getByRole('dialog', { name: lab ? 'Outside lab result' : 'Supplier\'s certificate result' });
  await dlg.getByLabel('Test').selectOption({ label: test });
  if (lab) await dlg.getByLabel('Outside lab').fill(lab);
  await dlg.getByLabel(lab ? 'Report number' : 'Certificate number').fill(no);
  await dlg.getByLabel(lab ? 'Report file' : 'Certificate file').setInputFiles(pdf(`${no}.pdf`));
  await dlg.getByLabel('Result').fill(value);
  await dlg.getByRole('button', { name: 'Record the result' }).click();
  await expect(tests).toContainText(no);
  await page.getByRole('button', { name: '← Samples' }).click();
}
async function approve(page: Page, lot: string) {
  await openSample(page, lot);
  const decision = page.getByRole('region', { name: 'QC decision' });
  await decision.getByRole('button', { name: 'Sign: QC approved' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(decision).toContainText(/Approved, certificate COA\d{7}/);
  await page.getByRole('button', { name: '← Samples' }).click();
}

test('LIMS-09 reduced testing journey: the first lot of a manufacturer tested in full, the next on its certificate with identity tested; the certificate checked with its fields; QC approves', async ({ browser }) => {
  test.setTimeout(180_000); // two lots, four people, all on screen
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Measurement', steps: [{ key: 'ph', settings: { what: 'Reading', unit: '', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-041', name: 'PVC film tests (reduced testing journey)', technique: 'Other', reference: 'In-house method QC-M-041' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const t = (key: string, name: string, extra: object = {}) => ({ key, name, method: { masterId: m.masterId, code: 'QC-M-041', name: 'PVC film' }, result: 's0/ph/readingCheck',
    limitType: 'range', limit: { low: '5.0', high: '7.0', unit: '' }, ...extra });
  const spec = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'material', itemId: E2E_PACK_ID, code: 'PM-041', name: 'Demo PVC film 250 µm', type: 'Packing material', number: 'SPEC-PM-041', pharmacopoeia: 'In-house',
      sampling: { plan: 'square root' }, reducedTesting: { fullEvery: 3, months: 12 } },
    tests: [t('id', 'Identity (IR)', { identity: true }), t('thk', 'Thickness index')] } });
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id in (${m.id}, ${spec.id})`;
  await owner.end();
  await iss.ctx.close();
  const smp = await person(browser, 'smp1');
  for (const lot of ['PK-1', 'PK-2']) {
    const s = await smp.post('/api/samples', { source: 'mms', lotNumber: lot, specVersionId: spec.id, quantity: '2 m2', purpose: 'release', received: 3, sampled: [1, 2, 3] });
    await smp.post(`/api/samples/${s.id}/receive`, { condition: 'Sealed rolls' });
  }
  await smp.ctx.close();

  // Lot 1: no lot of Demo Pack Co tested in full yet: QC sees why, and it is tested in full.
  const qc = await person(browser, 'qc1');
  await openSample(qc.page, 'PK-1');
  const panel = qc.page.getByLabel('Reduced testing');
  await expect(panel).toContainText('No lot of Demo Pack Co has been tested in full and approved yet');
  await expect(panel.getByRole('button', { name: 'Test this lot on the supplier\'s certificate' })).toHaveCount(0);
  await qc.page.getByRole('button', { name: '← Samples' }).click();
  const lab1 = await person(browser, 'lab1');
  await outside(lab1.page, 'PK-1', 'Identity (IR)', 'Demo Analytical Services, Pune', 'DAS-2026-411', '6.0');
  await outside(lab1.page, 'PK-1', 'Thickness index', 'Demo Analytical Services, Pune', 'DAS-2026-412', '6.1');
  const lab2 = await person(browser, 'lab2');
  await openSample(lab2.page, 'PK-1');
  const checks = lab2.page.getByRole('region', { name: 'Tests' }).getByRole('button', { name: 'Check against the report' });
  for (const left of [1, 0]) { await checks.first().click(); await expect(checks).toHaveCount(left); }
  await lab2.page.getByRole('button', { name: '← Samples' }).click();
  await approve(qc.page, 'PK-1');

  // Lot 2: QC records reduced testing, with the basis pulled from MMS, QMS and master data.
  await openSample(qc.page, 'PK-2');
  await expect(panel).toContainText('Manufacturer Demo Pack Co, batch DPC-2602; supplier Demo Traders; QMS approval SA-26-0041');
  await panel.getByRole('button', { name: 'Test this lot on the supplier\'s certificate' }).click();
  await expect(panel).toContainText('tested on the certificate');
  await expect(panel).toContainText('Recorded by QC1');
  await qc.page.getByRole('button', { name: '← Samples' }).click();
  // The identity is still tested (not offered from the certificate); the thickness comes from the certificate.
  await openSample(lab1.page, 'PK-2');
  await lab1.page.getByRole('region', { name: 'Tests' }).getByRole('button', { name: 'Supplier\'s certificate result' }).click();
  const dlg = lab1.page.getByRole('dialog', { name: 'Supplier\'s certificate result' });
  await expect(dlg.getByLabel('Test').locator('option')).toHaveText(['Thickness index']);
  await expect(dlg).toContainText('Manufacturer: Demo Pack Co');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await lab1.page.getByRole('button', { name: '← Samples' }).click();
  await outside(lab1.page, 'PK-2', 'Thickness index', null, 'DPC-COA-2602', '6.2');
  await outside(lab1.page, 'PK-2', 'Identity (IR)', 'Demo Analytical Services, Pune', 'DAS-2026-421', '6.0');
  await lab1.ctx.close();
  // The second person confirms the certificate's required fields before the check counts.
  await openSample(lab2.page, 'PK-2');
  const tests = lab2.page.getByRole('region', { name: 'Tests' });
  await expect(tests).toContainText('supplier\'s certificate Demo Pack Co, certificate DPC-COA-2602');
  await expect(tests.getByRole('button', { name: 'Check against the certificate' })).toBeDisabled();
  await tests.locator('label.check', { hasText: /The certificate gives the manufacturer's name and address/ }).click();
  await expect(tests.getByRole('checkbox')).toBeChecked();
  await tests.getByRole('button', { name: 'Check against the certificate' }).click();
  await expect(tests.getByRole('button', { name: 'Check against the certificate' })).toHaveCount(0);
  await tests.getByRole('button', { name: 'Check against the report' }).click();
  await expect(tests.getByRole('button', { name: /^Check against/ })).toHaveCount(0);
  if (process.env.SHOTS) await lab2.page.screenshot({ path: `${process.env.SHOTS}/reduced-sample.png`, fullPage: true });
  await lab2.page.getByRole('button', { name: '← Samples' }).click();
  await lab2.ctx.close();
  await approve(qc.page, 'PK-2');
  await qc.ctx.close();
});
