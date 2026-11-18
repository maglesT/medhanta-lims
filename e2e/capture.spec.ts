import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// Instrument data capture (LIMS-32, LIMS-33): the browser reads the balance over Web Serial (here a stand-in for
// navigator.serial that answers the SICS "S" request with a stable reading); a CDS result file is imported into the
// system suitability step. The values show where they came from and cannot be typed over.

async function trial(page: Page, code: string, stages: object[]) {
  const doc = small(stages);
  doc.header = { code, name: 'Demolol capture', technique: 'Other', reference: `In-house method ${code}` };
  const m = await page.request.post('/api/masters', { data: { doc } });
  expect(m.ok(), await m.text()).toBe(true);
  const { id } = (await m.json()) as { id: number };
  // Made effective by the database owner, as in the server tests.
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id = ${id}`;
  await owner.end();
  await page.goto('/');
  await page.getByRole('button', { name: 'Methods' }).click();
  await page.getByRole('row', { name: new RegExp(code) }).last().getByRole('button', { name: 'Start a trial analysis' }).click();
  await page.getByRole('button', { name: 'Next: sign' }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Sign', exact: true }).click();
  await page.waitForURL(/#\/analysis\/\d+$/);
}

test('LIMS-32 the mass is read from the balance over Web Serial: the server\'s parse of the raw line, shown with its source, not typed over', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // A stand-in serial port: the balance answers "S" with a stable net weight in g.
  await ctx.addInitScript(() => {
    let out: ReadableStreamDefaultController<Uint8Array>;
    const port = {
      readable: null as ReadableStream<Uint8Array> | null, writable: null as WritableStream<Uint8Array> | null,
      async open() {
        port.readable = new ReadableStream({ start: (c) => { out = c; } });
        port.writable = new WritableStream({ write: (chunk) => { if (new TextDecoder().decode(chunk).startsWith('S')) out.enqueue(new TextEncoder().encode('S S     0.05123 g\r\n')); } });
      },
      async close() {},
    };
    Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => port } });
  });
  const page = await ctx.newPage();
  await logIn(page, 'iss1');
  await trial(page, 'QC-M-080', [{ name: 'Weighing', roomTypes: ['QC laboratory'], steps: [{ key: 'weigh', block: { id: 'weigh', version: 1 }, checker: true,
    settings: { what: 'Sample', unit: 'mg' } }] }]);
  await page.getByRole('button', { name: /Weigh: Sample/ }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Record the balance first: the value is then read from it.')).toBeVisible();
  await page.getByRole('group', { name: 'Balance' }).getByRole('button', { name: /BAL-01/ }).click();
  await page.getByRole('button', { name: 'Read from BAL-01' }).click();
  await expect(page.getByText('From the instrument: BAL-01, Mettler Toledo SICS: "S S 0.05123 g" (51.23 mg)')).toBeVisible();
  await expect(page.locator('.recorded').filter({ hasText: '51.23 mg' })).toBeVisible();
  // Not a typing field any more: the value is read again, never typed over.
  await expect(page.locator('#f-mass')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('capture-balance.png') });
  await ctx.close();
});

test('LIMS-33 the system suitability is imported from the CDS result file of the run: values, file and hash shown, kept as import 1', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, 'iss1');
  await trial(page, 'QC-M-081', [
    { name: 'HPLC run', kind: 'preparation', roomTypes: ['Instrument room'], machineTypes: ['hplc'], steps: [{ key: 'run', block: { id: 'instrument-run', version: 1 }, settings: { conditions: 'C18, 1.0 mL/min, 254 nm' } }] },
    { name: 'Suitability', kind: 'preparation', roomTypes: ['Instrument room'], steps: [{ key: 'sst', block: { id: 'system-suitability', version: 1 }, checker: true,
      settings: { rsdLimit: { high: '2.0', unit: '%' } } }] }]);
  await page.getByRole('button', { name: /Instrument run/ }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('group', { name: 'Instrument' }).getByRole('button', { name: /HPLC-01/ }).click();
  await page.locator('#f-runId').fill('RUN-0042');
  await page.locator('#f-runId').press('Enter');
  await expect(page.getByText('✓ Saved')).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: /Suitability/ }).first().click();
  await page.getByRole('button', { name: /System suitability/ }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const text = readFileSync(new URL('../test/fixtures/capture/generic-assay.csv', import.meta.url));
  await page.getByLabel('Pick the CDS result file').setInputFiles({ name: 'PARA_ASSAY_RUN-0042.csv', mimeType: 'text/csv', buffer: text });
  await page.getByRole('button', { name: 'Import the CDS result file' }).click();
  await expect(page.getByText(/Import 1: PARA_ASSAY_RUN-0042\.csv · run RUN-0042 · PARA_ASSAY version 3/)).toBeVisible();
  await expect(page.getByText("From the CDS result file: import 1, run RUN-0042, injections 2, 3, 4, 5, 6.").first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import again' })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('capture-cds.png'), fullPage: true });
  await ctx.close();
});
