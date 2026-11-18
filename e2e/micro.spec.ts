import { expect, test, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// A microbial limits analysis on the screens (build step 7): the TAMC plates of two dilutions are counted, the count
// (L11) is worked out on the step and checked against the action limit (10^3 read as NMT 2000 CFU/g) and the alert
// level (500 CFU/g): first at the alert level, then, recounted, within both; signed and waiting for the check.

/** Signs in the open sign dialog: the sign window opens, the stand-in for core confirms, the window closes. */
async function sign(page: Page) {
  await page.getByRole('dialog').last().getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** Writes the method through the API, makes it effective (the database owner, as in the other journeys) and starts an analysis on the methods screen. */
async function issueAnalysis(page: Page): Promise<{ id: number; analysisNo: string }> {
  await logIn(page, 'iss1');
  const doc = small([{ name: 'TAMC', role: 'Microbiologist', roomTypes: ['QC laboratory'], steps: [{ key: 'count-tamc', name: 'Count the TAMC plates', block: { id: 'count', version: 1 }, checker: true, settings: {
    method: 'plate count', dilution1: '10', dilution2: '100', amount: '1 mL', per: 'CFU/g', countable: 'TAMC: fewer than 250 per plate', acceptance: '10^n',
    limit: { high: '1000', unit: 'CFU/g', alertHigh: '500' } } }] }]);
  doc.header = { code: 'QC-M-071', name: 'Demolol tablets: microbial limits (TAMC)', technique: 'Microbiology', reference: 'Ph.Int 3.3.1' };
  const m = await page.request.post('/api/masters', { data: { doc } });
  expect(m.ok(), await m.text()).toBe(true);
  const { id } = (await m.json()) as { id: number };
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id = ${id}`;
  await owner.end();
  await page.goto('/');
  await page.getByRole('button', { name: 'Methods' }).click();
  await page.getByRole('row', { name: /QC-M-071/ }).last().getByRole('button', { name: 'Start a trial analysis' }).click();
  await page.getByRole('button', { name: 'Next: sign' }).click();
  await sign(page);
  await page.waitForURL(/#\/analysis\/\d+$/);
  return { id: Number(/#\/analysis\/(\d+)$/.exec(page.url())![1]), analysisNo: (await page.locator('.bno').textContent())! };
}

/** Types the colonies on each plate of a dilution and saves them. */
async function plates(page: Page, dilution: number, counts: string[]) {
  const field = page.locator('.fl-field', { hasText: `Dilution ${dilution}: colonies on each plate` });
  for (const [i, c] of counts.entries()) await page.getByLabel(`Dilution ${dilution}: colonies on each plate ${i + 1}`, { exact: true }).fill(c);
  await field.getByRole('button', { name: /^Save the readings/ }).click();
  await expect(field.locator('.saved')).toBeVisible();
}

test('microbial limits journey: the TAMC plates are counted, the count is checked against the alert and action levels, and the step is signed', async ({ browser }) => {
  const setup = await browser.newContext();
  const analysis = await issueAnalysis(await setup.newPage());
  await setup.close();

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const op = await ctx.newPage();
  await logIn(op, 'op1');
  await op.goto(`/#/analysis/${analysis.id}`);
  await op.getByRole('button', { name: /Count the TAMC plates/ }).click();
  await op.getByRole('button', { name: 'Start', exact: true }).click();
  await op.getByRole('group', { name: 'Negative control (diluent only)' }).getByRole('button', { name: 'no growth' }).click();

  // 1 in 10: 61 and 63 colonies (mean 62 × 10 ÷ 1 mL = 620 CFU/g): within NMT 2000 CFU/g, but above the alert level.
  await plates(op, 1, ['61', '63']);
  await plates(op, 2, ['6', '7']);
  const results = op.getByRole('region', { name: 'Results' });
  await expect(results).toContainText('620 CFU/g');
  await expect(results).toContainText('Alert');
  await expect(results).toContainText('criterion 10^3 read as not more than 2000 CFU/g');
  await op.screenshot({ path: test.info().outputPath('micro-alert.png'), fullPage: true });

  // Recounted (a plate read twice): 45 and 52 (mean 48.5 × 10 = 485 CFU/g): within both.
  await plates(op, 1, ['45', '52']);
  await expect(results).toContainText('485 CFU/g');
  await expect(results).toContainText('Within limits');
  await op.getByRole('button', { name: 'Done', exact: true }).click();
  await sign(op);
  await expect(op.locator('.step-title')).toContainText('Waiting for check');
  await op.screenshot({ path: test.info().outputPath('micro-done.png'), fullPage: true });
  await ctx.close();
});
