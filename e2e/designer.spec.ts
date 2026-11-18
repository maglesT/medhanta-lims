import { expect, test, type Browser, type Page } from '@playwright/test';
import { logIn } from './helpers.js';

// The method designer: a small method built from a skeleton, its master-check problems found and fixed, then the review
// and approval workflow with three people, each in their own browser (LIMS-01).

async function as(browser: Browser, who: string, viewport?: { width: number; height: number }): Promise<Page> {
  const page = await (await browser.newContext(viewport ? { viewport } : {})).newPage();
  await logIn(page, who);
  await page.getByRole('button', { name: 'Methods' }).click();
  return page;
}
// Opens the master's review again, as read now.
async function review(page: Page) {
  await page.getByRole('button', { name: '← Methods' }).click();
  await page.getByRole('row', { name: /QC-M-201/ }).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Review and approval' }).click();
}
// Signing opens core's password window; the stand-in answers at once and the window closes itself.
async function sign(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Sign' }).click();
  await expect(dialog).toBeHidden();
}

test('LIMS-01 build a method from a skeleton, fix the master-check problems, then check, approve and (another QA person) make it effective', async ({ browser }) => {
  const author = await as(browser, 'author1');
  await author.getByRole('button', { name: 'New method' }).click();
  await author.getByLabel('Method code').fill('QC-M-201');
  await author.getByLabel('Method name').fill('Examplol assay by titration');
  await author.getByLabel('Technique').selectOption('Titration');
  await author.getByLabel('Reference').fill('Ph. Int. Examplol tablets, assay');
  await author.getByText('Method skeleton: Titration').click();
  await author.getByRole('button', { name: 'Create draft' }).click();
  await expect(author.getByRole('heading', { name: 'QC-M-201 · Examplol assay by titration' })).toBeVisible();

  // The steps: the skeleton's sample stage (two weighings, dissolve) and its titration result step. Here the result is a
  // simple check from the block library instead: the titration step is removed, and the check added.
  await author.getByRole('button', { name: 'Steps', exact: true }).click();
  await expect(author.locator('.steps-col .olist li').first()).toContainText('Weigh sample 1');
  await expect(author.locator('.steps-col .olist li')).toHaveCount(4);
  await author.getByRole('button', { name: 'Remove Titration' }).click();
  await author.getByRole('button', { name: '+ Add a step' }).click();
  await author.getByRole('button', { name: /^Check a value against limits/ }).click();
  await expect(author.locator('.steps-col .olist li')).toHaveCount(4);
  // Remove is there without selecting the step first: a second result step added by mistake is removed.
  await author.getByRole('button', { name: '+ Add a step' }).click();
  await author.getByRole('button', { name: /^Read a value at intervals/ }).click();
  await expect(author.locator('.steps-col .olist li')).toHaveCount(5);
  await author.getByRole('button', { name: 'Remove Read a value at intervals' }).click();
  await expect(author.locator('.steps-col .olist li')).toHaveCount(4);

  // The master check shows what is missing; its link selects the step, and the step settings take the input.
  const check = author.getByRole('complementary', { name: 'Master check' });
  await check.getByRole('button', { name: /What is checked is not set/ }).click();
  await expect(author.getByRole('heading', { name: 'Check a value against limits' })).toBeVisible();
  await author.getByLabel('What is checked').fill('Assay');
  await author.getByLabel('Unit', { exact: true }).selectOption('%');
  await author.getByLabel('Limits: lowest').fill('95.0');
  await author.getByLabel('Limits: highest').fill('105.0');
  await author.getByLabel('Limits: unit').selectOption('%');
  await author.getByLabel('A second person checks it (checker)').check();
  await expect(check.getByRole('button', { name: /What is checked is not set/ })).toBeHidden();
  await expect(check.getByRole('button', { name: /Limits is not set/ })).toBeHidden();
  // The worked example shows the check with example values.
  await author.getByLabel('Example Reading').fill('99.2');
  await expect(author.locator('.ex-results')).toContainText('99.2 %; limit 95.0 to 105.0 %: within limits');

  // LIMS-12: the skeleton names no rooms; the check opens its stage settings, where the rooms are picked.
  await check.getByRole('button', { name: /Stage Sample: choose the rooms/ }).click();
  await author.getByLabel('Add to rooms this stage may run in (an area, or a room)').selectOption('QC laboratory');
  await expect(check).toContainText('No problems');
  await expect(author.getByRole('status')).toHaveText('All changes saved');

  // Sent for review: the author signs "prepared".
  await author.getByRole('button', { name: 'Review and approval' }).click();
  await expect(author.locator('.plain-view')).toContainText('The reading must be within 95.0 to 105.0 %. Signed by the analyst and checked by a second person.');
  await author.getByRole('button', { name: 'Send for review' }).click();
  await sign(author);
  await expect(author.locator('.d-title')).toContainText('In review');

  // A second person returns it with a long reason, then checks it once sent again, in their own browser.
  const checker = await as(browser, 'mcheck1');
  await checker.getByRole('row', { name: /QC-M-201/ }).getByRole('button', { name: 'Open' }).click();
  await checker.getByRole('button', { name: 'Return to the author' }).click();
  await checker.getByLabel('Reason').fill(`Returned for the re-test: ${'the titration end point must be read from the potentiometric curve, not by colour, '.repeat(5)}see QMS/change-controls/CC-2026-0007/approval-history/without-a-single-break-in-this-long-reference-to-the-record.`);
  await checker.getByRole('dialog').getByRole('button', { name: 'Return' }).click();
  await expect(checker.locator('.timeline')).toContainText('Returned to the author');
  await review(author);
  await author.getByRole('button', { name: 'Send for review' }).click();
  await sign(author);
  await expect(author.locator('.d-title')).toContainText('In review');
  await review(checker);
  await checker.getByRole('button', { name: 'Pass the check' }).click();
  await sign(checker);
  await expect(checker.locator('.timeline')).toContainText('Checked (passed) · MCHECK1');

  // QA approves with a change control number, then makes it effective. At 1366×900 the review history with the long
  // reason wraps in its column: nothing lies over the Approve button.
  const qa = await as(browser, 'qa1', { width: 1366, height: 900 });
  await qa.getByRole('row', { name: /QC-M-201/ }).getByRole('button', { name: 'Open' }).click();
  const approve = qa.getByRole('button', { name: 'Approve' });
  await expect(qa.locator('.timeline')).toContainText('without-a-single-break');
  const box = (await approve.boundingBox())!;
  expect(await qa.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('button')?.textContent, [box.x + box.width / 2, box.y + box.height / 2])).toBe('Approve');
  const timeline = (await qa.locator('.timeline').boundingBox())!;
  expect(timeline.x + timeline.width).toBeLessThanOrEqual(box.x);
  await approve.click();
  await qa.getByLabel('Change control number').fill('CC-2026-031');
  await qa.getByRole('button', { name: 'Continue to sign' }).click();
  await sign(qa);
  await expect(qa.locator('.d-title')).toContainText('Approved');
  // No QMS link here: the number was typed by hand, so another person makes the version effective.
  await expect(qa.getByRole('button', { name: 'Make effective' })).toBeDisabled();
  await expect(qa.locator('.review-actions')).toContainText('another person makes the version effective');
  const qa2 = await as(browser, 'qa2');
  await qa2.getByRole('row', { name: /QC-M-201/ }).getByRole('button', { name: 'Open' }).click();
  await qa2.getByRole('button', { name: 'Make effective' }).click();
  await qa2.getByRole('dialog').getByRole('button', { name: 'Make effective' }).click();
  await expect(qa2.locator('.d-title')).toContainText('Effective');
  await expect(qa2.locator('.timeline')).toContainText('change control CC-2026-031');
});
