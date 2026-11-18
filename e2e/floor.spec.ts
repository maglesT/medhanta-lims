import { expect, test, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_RECRUITMENT, E2E_SCHEMA } from './config.js';
import { clearOfActionBar, justAboveActionBar, logIn } from './helpers.js';

// The analysis screens, one stage of a small fixture method: a pH check (second-person check) and the weighing of the
// sample on an analytical balance (second-person check).

/** Writes the fixture method through the API, makes it effective (the database owner does it, as in the server tests) and starts an analysis on the methods screen (LIMS-01). */
async function issueAnalysis(page: Page, step: object = {}): Promise<{ id: number; analysisNo: string }> {
  await logIn(page, 'iss1');
  const doc = small([{ name: 'Sample', steps: [{ checker: true, ...step },
    { block: { id: 'weigh', version: 1 }, checker: true, settings: { what: 'Sample', unit: 'mg', target: '100.0 mg', tolerance: '10' } }] }]);
  doc.header = { code: 'QC-M-050', name: 'Demolol tablets: pH and sample weighing', technique: 'Other', reference: 'In-house method QC-M-050' };
  const m = await page.request.post('/api/masters', { data: { doc } });
  expect(m.ok()).toBe(true);
  const { id } = (await m.json()) as { id: number };
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id = ${id}`;
  await owner.end();
  await page.goto('/');
  await page.getByRole('button', { name: 'Methods' }).click();
  await page.getByRole('row', { name: /QC-M-050/ }).last().getByRole('button', { name: 'Start an analysis' }).click();
  await expect(page.getByRole('dialog', { name: 'Start an analysis' })).toContainText('QC-M-050 · Demolol tablets: pH and sample weighing, version 1');
  await page.getByRole('button', { name: 'Next: sign' }).click();
  await sign(page);
  await page.waitForURL(/#\/analysis\/\d+$/);
  const analysisNo = (await page.locator('.bno').textContent())!;
  return { id: Number(/#\/analysis\/(\d+)$/.exec(page.url())![1]), analysisNo };
}

/** Signs in the open sign dialog: the sign window opens, the stand-in for core confirms, the window closes. */
async function sign(page: Page) {
  await page.getByRole('dialog').last().getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('LIMS-17 analysis journey: start, a value out of limits needs a deviation note, done, checked by a second person on their own device, the sample weighed on My work', async ({ browser }) => {
  const setup = await browser.newContext();
  const analysis = await issueAnalysis(await setup.newPage());
  await setup.close();

  // The analyst, on the lab's tablet.
  const opCtx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const op = await opCtx.newPage();
  await logIn(op, 'op1');
  await expect(op.getByRole('heading', { name: 'My work' })).toBeVisible();
  await op.getByRole('button', { name: new RegExp(`${analysis.analysisNo} · Demolol tablets`) }).click();
  await expect(op.locator('.bh')).toContainText('Method version 1');
  await expect(op.getByRole('navigation', { name: 'Stages' })).toContainText('Sample');
  await op.getByRole('button', { name: /^1 Check a value against limits: pH/ }).click();
  await op.getByRole('button', { name: 'Start', exact: true }).click();
  // A refusal under the field is shown in full above the sticky Done bar (here on a 1366 × 900 screen).
  await op.setViewportSize({ width: 1366, height: 900 });
  await justAboveActionBar(op.getByLabel('Reading'));
  await op.getByLabel('Reading').fill('7.5 pH');
  await op.getByLabel('Reading').press('Enter');
  await clearOfActionBar(op, op.locator('.fl-field', { hasText: 'Reading' }).getByRole('alert'));
  await op.setViewportSize({ width: 1024, height: 768 });
  await op.getByLabel('Reading').fill('7.5');
  await op.getByLabel('Reading').press('Enter');
  const results = op.getByRole('region', { name: 'Results' });
  await expect(results).toContainText('Out of limits');
  await expect(results).toContainText('Limit 5.0 to 7.0');
  await expect(op.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await expect(op.locator('.action-bar')).toContainText('Add a deviation note first');
  await op.getByRole('button', { name: 'Add deviation note' }).click();
  await op.getByLabel('What happened').fill('pH 7.5 on the second reading; the meter calibration was checked');
  await op.getByLabel('Deviation number (if one was raised)').fill('DEV-26-001');
  await op.getByRole('button', { name: 'Add the note' }).click();
  await expect(op.getByRole('region', { name: 'History' })).toContainText('Deviation note DEV-26-001');
  await op.getByRole('button', { name: 'Done', exact: true }).click();
  await sign(op);
  await expect(op.locator('.step-title')).toContainText('Waiting for check');
  await expect(op.getByRole('region', { name: 'What was recorded' })).toContainText('a second person checks it on their own device');

  // The checker, on their own device.
  const chkCtx = await browser.newContext();
  const chk = await chkCtx.newPage();
  await logIn(chk, 'chk1');
  const waiting = chk.getByRole('region', { name: 'Waiting for your check' });
  await waiting.getByRole('button', { name: /Check a value against limits: pH/ }).click();
  const recorded = chk.getByRole('region', { name: 'What was recorded' });
  await expect(recorded).toContainText('7.5');
  await expect(recorded).toContainText('OP1');
  await chk.getByRole('button', { name: 'Checked', exact: true }).click();
  await sign(chk);
  await expect(chk.locator('.step-title')).toContainText('Checked');

  // The sample is weighed on an analytical balance of master data. Without the Logbook link its status labels are
  // answered by hand. Back on the analysis, the check made on the other device shows at once (read again on the way back,
  // not at the next poll).
  await op.getByRole('button', { name: `← Analysis ${analysis.analysisNo}` }).click();
  await expect(op.locator('.step-row').first()).toContainText('Checked', { timeout: 5_000 });
  await op.getByRole('button', { name: /Weigh: Sample/ }).click();
  await op.getByRole('button', { name: 'Start', exact: true }).click();
  await op.getByRole('group', { name: 'Balance' }).getByRole('button', { name: /BAL-01/ }).click();
  const labels = op.getByRole('group', { name: /^Balance: / });
  await expect(labels).toHaveCount(4);
  for (const g of await labels.all()) await g.getByRole('button', { name: 'Yes' }).click();
  await op.getByLabel('Net mass').fill('101.2');
  await op.getByLabel('Net mass').press('Enter');
  await expect(op.getByRole('region', { name: 'Results' })).toContainText('101.2 mg');
  await expect(op.getByRole('region', { name: 'Results' })).toContainText('Within limits');
  await op.getByRole('button', { name: 'Done', exact: true }).click();
  await sign(op);
  await expect(op.locator('.step-title')).toContainText('Waiting for check');

  // It shows on the checker's My work.
  await chk.getByRole('button', { name: 'My work' }).click();
  await expect(chk.getByRole('region', { name: 'Waiting for your check' })).toContainText('Weigh: Sample');
  await expect(chk.getByRole('region', { name: 'Waiting for your check' })).toContainText(analysis.analysisNo);

  // LIMS-46: a correction keeps the old value struck through; the new value and the reason are not struck.
  await op.getByRole('button', { name: `← Analysis ${analysis.analysisNo}` }).click();
  await op.getByRole('button', { name: /^1 Check a value against limits: pH/ }).click();
  await op.getByRole('button', { name: 'Correct', exact: true }).click();
  await op.getByRole('dialog').getByLabel('Reading').fill('6.5');
  await op.getByLabel('Reason for the correction').fill('Meter read before the electrode had settled');
  await op.getByRole('button', { name: 'Save the correction' }).click();
  const line = op.locator('.corrected').first();
  await expect(line).toContainText('Meter read before the electrode had settled');
  expect(await line.evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('none');
  expect(await line.locator('s').evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('line-through');
  await opCtx.close();
  await chkCtx.close();
});

test('LIMS-40 only trained people sign: the sign dialog shows the training from Recruitment, refuses an untrained checker, and asks for the tick while Recruitment is down', async ({ browser }) => {
  const setup = await browser.newContext();
  const analysis = await issueAnalysis(await setup.newPage(), { training: { code: 'SOP-QC-012', title: 'pH measurement' } });
  await setup.close();

  // op1 is trained in it (e2e/server.ts): the dialog says so and the signature records it.
  const opCtx = await browser.newContext();
  const op = await opCtx.newPage();
  await logIn(op, 'op1');
  await op.goto(`/#/analysis/${analysis.id}`);
  await op.getByRole('button', { name: /^1 Check a value against limits: pH/ }).click();
  await expect(op.getByRole('region', { name: 'Instruction' })).toContainText('Done by a person trained in SOP-QC-012 pH measurement; checked by a person trained in it too (Recruitment).');
  await op.getByRole('button', { name: 'Start', exact: true }).click();
  await op.getByLabel('Reading').fill('6.0');
  await op.getByLabel('Reading').press('Enter');
  await op.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(op.getByRole('dialog')).toContainText('Your training: trained: SOP-QC-012 pH measurement, valid until 9 Jan 2099 (Recruitment).');
  await sign(op);
  await expect(op.getByRole('region', { name: 'History' })).toContainText('Signed: performed · trained: SOP-QC-012 pH measurement, valid until 9 Jan 2099 (Recruitment)');
  await opCtx.close();

  // chk1 is not: refused in plain words, Sign is off.
  const chkCtx = await browser.newContext();
  const chk = await chkCtx.newPage();
  await logIn(chk, 'chk1');
  await chk.getByRole('region', { name: 'Waiting for your check' }).getByRole('button', { name: /Check a value against limits: pH/ }).click();
  await chk.getByRole('button', { name: 'Checked', exact: true }).click();
  const dialog = chk.getByRole('dialog');
  await expect(dialog).toContainText('CHK1 has no valid training in SOP-QC-012 pH measurement (Recruitment): ask QA, or another trained person signs.');
  await expect(dialog.getByRole('button', { name: 'Sign', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Recruitment down: the checker ticks "I am trained in …"; the signature says so, for QA.
  const owner = connect(TEST_DATABASE_URL);
  await owner.unsafe(`revoke select on all tables in schema ${E2E_RECRUITMENT} from lims_app`);
  try {
    await chk.getByRole('button', { name: 'Checked', exact: true }).click();
    await expect(dialog).toContainText('Recruitment cannot be reached');
    await expect(dialog.getByRole('button', { name: 'Sign', exact: true })).toBeDisabled();
    await dialog.getByLabel('I am trained in SOP-QC-012 pH measurement').check();
    await sign(chk);
  } finally {
    await owner.unsafe(`grant select on all tables in schema ${E2E_RECRUITMENT} to lims_app`);
    await owner.end();
  }
  await expect(chk.locator('.step-title')).toContainText('Checked');
  await expect(chk.getByRole('region', { name: 'History' })).toContainText('Signed: verified (second person) · training typed by hand (Recruitment not reachable): SOP-QC-012 pH measurement');
  await chkCtx.close();
});
