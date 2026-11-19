import { expect, test } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { E2E_MATERIAL_ID, E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The samples journey (LIMS-05, LIMS-07): a lot of RM-012 waits in quarantine in MMS (the stand-in, e2e/server.ts); its
// specification is effective. The sampler registers a sample of it on screen, receives and stores it, and sees its chain
// of custody. TrueBatch is not linked here: the screen says so and offers registering by hand.

test('LIMS-07 a sample of a waiting MMS lot is registered, received and stored on screen, and its chain of custody shows who did what and when', async ({ browser }) => {
  // The effective specification of RM-012 (written through the API; the review is the specifications' own journey).
  const author = await browser.newContext();
  const ap = await author.newPage();
  await logIn(ap, 'iss1');
  const doc = {
    header: { of: 'material', itemId: E2E_MATERIAL_ID, code: '', name: '', type: 'Raw material', number: 'SPEC-RM-012', pharmacopoeia: 'Ph. Int.', edition: '2025',
      // LIMS-05: a starting material is sampled by the specification's plan.
      sampling: { plan: 'square root', equipment: 'Stainless steel sampling thief', storage: 'Amber jar, below 25 °C' } },
    tests: [{ key: 'assay', name: 'Assay', method: { masterId: 1, code: 'QC-M-001', name: 'Assay by HPLC' }, result: 'run/result/result', limitType: 'range',
      limit: { low: '98.0', high: '102.0', unit: '%' }, values: {}, use: 'release and stability' }],
  };
  const created = await ap.request.post('/api/masters', { data: { kind: 'spec', doc } });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json() as { id: number };
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id = ${id}`;
  await owner.end();
  await author.close();

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, 'smp1');
  await page.getByRole('button', { name: 'Samples', exact: true }).click();
  const waiting = page.getByRole('region', { name: 'Waiting to be sampled' });
  await expect(waiting.getByText('MMS is linked: its lots are listed as read now.')).toBeVisible();
  await expect(waiting.getByText('TrueBatch is not linked: register its batches by hand; a second person checks each one.')).toBeVisible();
  const row = waiting.getByRole('row', { name: /RM-E1/ });
  await expect(row).toContainText('SPEC-RM-012, version 1');
  await expect(row).toContainText('MMS lot RM-E1: RM-012, quarantine, expiry 31 Oct 2029');

  // Register: the lot's facts as pulled, the specification found; the quantity, containers and purpose.
  await row.getByRole('button', { name: 'Register RM-E1' }).click();
  const dialog = page.getByRole('dialog', { name: 'Register a sample' });
  await expect(dialog).toContainText('RM-012 Demolol (active substance)');
  await expect(dialog.getByLabel('Specification')).toHaveValue(String(id));
  await dialog.getByLabel('Quantity').fill('120 g');
  // LIMS-05: the plan: 1 + √9 = 4 of the 9 containers received; the sampler confirms which.
  await dialog.getByLabel('Containers received').fill('9');
  await expect(dialog.getByLabel('Sampling plan')).toContainText('sample 4 of 9 containers (1 + √9 = 4.00, rounded up = 4)');
  await expect(dialog.getByLabel('Sampling plan')).toContainText('Equipment: Stainless steel sampling thief');
  await dialog.getByLabel('Container numbers sampled').fill('1, 3, 6, 9');
  await dialog.getByRole('button', { name: 'Register' }).click();

  // The sample screen: its number of the plant year, registered.
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText(/LS\d{7}/);
  await expect(heading).toContainText('Registered');
  await expect(page.getByRole('region', { name: 'The sample' })).toContainText('From MMS: MMS lot RM-E1');
  await expect(page.getByRole('region', { name: 'The sample' })).toContainText('containers sampled: 1, 3, 6, 9');
  await expect(page.getByRole('region', { name: 'Tests' })).toContainText('Assay');
  await expect(page.getByRole('region', { name: 'Tests' })).toContainText('Limit not less than 98.0 and not more than 102.0 %');

  await page.getByRole('button', { name: 'Receive' }).click();
  await page.getByLabel('Condition on receipt').fill('Sealed, labelled, 3 containers');
  await page.getByRole('button', { name: 'Record received' }).click();
  await expect(heading).toContainText('Received');
  await page.getByRole('button', { name: 'Store' }).click();
  await page.getByLabel('Where').fill('Sample store, shelf B2');
  await page.getByRole('button', { name: 'Record stored' }).click();
  await expect(heading).toContainText('Stored');

  // The chain of custody: registered, received, stored, each with the person and the plant time.
  const custody = page.getByRole('region', { name: 'Chain of custody' }).getByRole('listitem');
  await expect(custody).toHaveCount(3);
  await expect(custody.nth(0)).toContainText(/Registered\s*SMP1, \d{1,2} \w{3}, \d{2}:\d{2} IST/);
  await expect(custody.nth(1)).toContainText('Received in QC');
  await expect(custody.nth(1)).toContainText('Condition: Sealed, labelled, 3 containers');
  await expect(custody.nth(2)).toContainText(/Stored\s*Where: Sample store, shelf B2\s*SMP1, \d{1,2} \w{3}, \d{2}:\d{2} IST/);

  // Back on the list: the sample, stored; the lot is no longer offered for a release sample.
  await page.getByRole('button', { name: '← Samples' }).click();
  await expect(page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: /RM-E1/ })).toContainText('Stored');
  // (Other journeys' lots may still wait here: the reduced testing journey's packing material lots.)
  await expect(page.getByRole('region', { name: 'Waiting to be sampled' })).toContainText(/Already sampled for release: .*RM-E1 \(LS\d{7}\)/);
  await ctx.close();
});
