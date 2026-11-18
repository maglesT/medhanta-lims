import { expect, test, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The lab inventory journey (LIMS-13, LIMS-14): a primary standard is received and a working standard qualified against
// it, checked by a second person on their own device; the analyst picks it in an assay step and its potency comes with
// it (never typed); the expired reagent and the out-of-date standard are not offered. The item lists the analysis that
// used it.

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** An assay method of one step, made effective (the database owner does it, as in the server tests), and a trial analysis started on screen. */
async function issueAssay(page: Page): Promise<string> {
  await logIn(page, 'iss1');
  const doc = small([{ name: 'Assay', roomTypes: ['QC laboratory'], steps: [{ key: 'assay', block: { id: 'assay', version: 1 }, checker: true,
    settings: { mode: 'external standard', response: 'peak area', responseUnit: '', stdMass: '50.00 mg', stdVolume: '100 mL', preparations: '1', sample1Mass: '50.00 mg',
      sampleVolume: '100 mL', per: 'mass', limit: { low: '98.0', high: '102.0', unit: '%' } } }] }]);
  doc.header = { code: 'QC-M-060', name: 'Demolol assay by HPLC', technique: 'HPLC', reference: 'In-house method QC-M-060' };
  const m = await page.request.post('/api/masters', { data: { doc } });
  expect(m.ok(), await m.text()).toBe(true);
  const { id } = (await m.json()) as { id: number };
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id = ${id}`;
  // Set-up only: a reagent and a primary standard registered earlier, now past their dates (the screens refuse a past date).
  const [u] = await owner<{ id: number }[]>`select id::int from users where username = 'op1'`;
  await owner`insert into lab_items (item_no, kind, name, facts, registered_by) values
    ('RG250001', 'reagent', 'Acetonitrile HPLC grade', ${owner.json({ name: 'Acetonitrile HPLC grade', supplier: 'Examplo Chemicals', lot: 'AC-0915', expiry: day(-3) })}, ${u!.id}),
    ('RS250001', 'reference', 'Demolol RS (old lot)', ${owner.json({ name: 'Demolol RS (old lot)', source: 'USP', lot: 'F0K001', potency: '99.8', basis: 'as is', retestOn: day(-1) })}, ${u!.id})`;
  await owner.end();
  await page.goto('/');
  await page.getByRole('button', { name: 'Methods' }).click();
  await page.getByRole('row', { name: /QC-M-060/ }).last().getByRole('button', { name: 'Start a trial analysis' }).click();
  await page.getByRole('button', { name: 'Next: sign' }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Sign', exact: true }).click();
  await page.waitForURL(/#\/analysis\/\d+$/);
  return (await page.locator('.bno').textContent())!;
}

test('LIMS-14 a working standard qualified against its primary, checked by a second person, is picked in an assay step and its potency pulled; LIMS-13 an expired reagent cannot be picked', async ({ browser }) => {
  const setup = await browser.newContext();
  const analysisNo = await issueAssay(await setup.newPage());
  await setup.close();

  const opCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const op = await opCtx.newPage();
  await logIn(op, 'op1');
  await op.getByRole('button', { name: 'Inventory', exact: true }).click();
  await expect(op.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  // The expired reagent and the standard past its retest date: not usable, with why.
  const list = op.getByRole('table', { name: 'Inventory' });
  await expect(list.getByRole('row', { name: /RG250001/ })).toContainText('Not usable');
  await expect(list.getByRole('row', { name: /RG250001/ })).toContainText('expired on');
  await expect(list.getByRole('row', { name: /RS250001/ })).toContainText('past its retest date');

  // Receive a primary standard from its certificate.
  await op.getByRole('button', { name: 'Register an item' }).click();
  let dialog = op.getByRole('dialog', { name: 'Register an item' });
  await dialog.getByLabel('Kind').selectOption('reference');
  await dialog.getByLabel('Name').fill('Demolol RS');
  await dialog.getByLabel('Issued by (pharmacopoeia or primary source)').fill('USP');
  await dialog.getByLabel('Lot or batch').fill('R1A044');
  await dialog.getByLabel('Potency (%)').fill('99.7');
  await dialog.getByLabel('Basis of the potency').selectOption('as is');
  await dialog.getByLabel('Retest date').fill(day(300));
  await dialog.getByRole('button', { name: 'Register' }).click();
  const heading = op.getByRole('heading', { level: 1 });
  await expect(heading).toContainText(/RS26\d{4}/);
  await expect(heading).toContainText('Usable');
  const rsNo = (await heading.textContent())!.slice(0, 8);

  // A working standard qualified against it: not usable until qualified and checked.
  await op.getByRole('button', { name: '← Inventory' }).click();
  await op.getByRole('button', { name: 'Register an item' }).click();
  dialog = op.getByRole('dialog', { name: 'Register an item' });
  await dialog.getByLabel('Kind').selectOption('working');
  await dialog.getByLabel('Name').fill('Demolol WS');
  await dialog.getByLabel('Lot or batch').fill('WS-26-007');
  await expect(dialog.getByRole('group', { name: /Qualified against the primary/ })).not.toContainText('RS250001');
  await dialog.getByRole('radio', { name: new RegExp(rsNo) }).check();
  await dialog.getByRole('button', { name: 'Register' }).click();
  await expect(heading).toContainText(/WS26\d{4}/);
  const wsNo = (await heading.textContent())!.slice(0, 8);
  await expect(op.getByRole('status')).toContainText('Not usable: not qualified against its primary standard');
  await expect(op.getByRole('region', { name: 'The item' })).toContainText(`${rsNo} Demolol RS`);
  await op.getByRole('button', { name: 'Qualify' }).click();
  await op.getByLabel('Potency assigned (%)').fill('99.4');
  await op.getByLabel('Basis of the potency').selectOption('as is');
  await op.getByLabel('Re-qualification due').fill(day(180));
  await op.getByRole('button', { name: 'Record the qualification' }).click();
  await expect(op.getByRole('status')).toContainText('waits for a second person\'s check');
  await expect(op.getByRole('button', { name: 'Check (second person)' })).toHaveCount(0);

  // LIMS-13: a solution is made only from usable items: the expired reagent is not offered.
  await op.getByRole('button', { name: '← Inventory' }).click();
  await op.getByRole('button', { name: 'Register an item' }).click();
  dialog = op.getByRole('dialog', { name: 'Register an item' });
  await dialog.getByLabel('Kind').selectOption('solution');
  const madeFrom = dialog.getByRole('group', { name: /Made from/ });
  await expect(madeFrom).toContainText(rsNo);
  await expect(madeFrom).not.toContainText('RG250001');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // The reviewer checks the qualification on their own device.
  const revCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const rev = await revCtx.newPage();
  await logIn(rev, 'rev1');
  await rev.getByRole('button', { name: 'Inventory', exact: true }).click();
  await rev.getByRole('table', { name: 'Inventory' }).getByRole('row', { name: new RegExp(wsNo) }).click();
  await rev.getByRole('button', { name: 'Check (second person)' }).click();
  await expect(rev.getByRole('dialog')).toContainText('Potency 99.4 % (as is)');
  await rev.getByRole('button', { name: 'Confirm the check' }).click();
  await expect(rev.getByRole('heading', { level: 1 })).toContainText('Usable');
  await expect(rev.getByRole('region', { name: 'The item' })).toContainText('99.4 % (as is)');
  await revCtx.close();

  // The analyst picks the working standard in the assay step: its potency and basis come with it.
  await op.goto('/');
  await op.getByRole('button', { name: new RegExp(`${analysisNo} · Demolol assay`) }).click();
  await op.getByRole('button', { name: /^1 Assay by external standard/ }).click();
  await op.getByRole('button', { name: 'Start', exact: true }).click();
  const picks = op.getByRole('group', { name: 'Reference or working standard used' });
  await expect(picks.getByRole('button')).toHaveCount(2);
  await expect(picks).toContainText(wsNo);
  await expect(picks).not.toContainText('RS250001');
  await expect(op.getByText(/Not offered: RS250001 Demolol RS \(old lot\): past its retest date/)).toBeVisible();
  // Nothing to type: the potency waits for the standard.
  await expect(op.getByLabel('Standard: potency (from the inventory)')).toHaveCount(0);
  await picks.getByRole('button', { name: new RegExp(wsNo) }).click();
  const potency = op.locator('.fl-field', { hasText: 'Standard: potency (from the inventory)' });
  await expect(potency).toContainText('99.4 %');
  await expect(potency).toContainText(`From the LIMS inventory: potency 99.4 % of ${wsNo} (as is)`);
  await expect(potency.getByRole('button', { name: 'Correct' })).toHaveCount(0);
  await expect(op.locator('.fl-field', { hasText: 'Standard: basis of the potency' })).toContainText('as is');

  // LIMS-14 look-back: the working standard lists the analysis that used it.
  await op.goto('/');
  await op.getByRole('button', { name: 'Inventory', exact: true }).click();
  await op.getByRole('table', { name: 'Inventory' }).getByRole('row', { name: new RegExp(wsNo) }).click();
  const used = op.getByRole('region', { name: 'Usage' });
  await expect(used).toContainText(analysisNo);
  await expect(used).toContainText('Assay › Assay by external standard');
  await opCtx.close();
});
