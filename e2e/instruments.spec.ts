import { expect, test } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The instruments journey (LIMS-12): Qualification is linked (e2e/server.ts). At a weighing step the balance picker
// offers only the qualified balance and says why the other is not offered; the picked balance shows its qualification
// as Qualification has it, and only the Logbook's label questions are asked (the Logbook is not linked here).

test('LIMS-12 the balance picker offers only qualified instruments, names the one left out with why, and shows the qualification read from Qualification', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, 'iss1');
  const doc = small([{ name: 'Weighing', roomTypes: ['QC laboratory'], steps: [{ key: 'weigh', block: { id: 'weigh', version: 1 }, checker: true,
    settings: { what: 'Sample', unit: 'mg' } }] }]);
  doc.header = { code: 'QC-M-070', name: 'Demolol weighing', technique: 'Other', reference: 'In-house method QC-M-070' };
  const m = await page.request.post('/api/masters', { data: { doc } });
  expect(m.ok(), await m.text()).toBe(true);
  const { id } = (await m.json()) as { id: number };
  // Made effective by the database owner, as in the server tests.
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id = ${id}`;
  await owner.end();
  await page.goto('/');
  await page.getByRole('button', { name: 'Methods' }).click();
  await page.getByRole('row', { name: /QC-M-070/ }).last().getByRole('button', { name: 'Start a trial analysis' }).click();
  await page.getByRole('button', { name: 'Next: sign' }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Sign', exact: true }).click();
  await page.waitForURL(/#\/analysis\/\d+$/);

  await page.getByRole('button', { name: /Weigh: Sample/ }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const balance = page.getByRole('group', { name: 'Balance' });
  await expect(balance.getByRole('button', { name: /BAL-01/ })).toBeVisible();
  await expect(balance.getByRole('button', { name: /BAL-02/ })).toHaveCount(0);
  await expect(page.getByText('Not offered: BAL-02 is due for requalification (Qualification): only a qualified instrument may be used.')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('instrument-picker.png') });

  await balance.getByRole('button', { name: /BAL-01/ }).click();
  await expect(page.getByText('From Qualification: BAL-01: qualified, periodic review due 31 Dec 2099')).toBeVisible();
  // The Logbook is not linked: its label questions, answered by hand; the qualification question is not asked.
  await expect(page.getByRole('group', { name: /^Balance: / })).toHaveCount(3);
  await expect(page.getByRole('group', { name: /^Balance: qualified/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('instrument-qualified.png') });
  await ctx.close();
});
