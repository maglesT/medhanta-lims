import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { masterSchema } from '../shared/master/schema.js';
import { E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The method validation journey (LIMS-02, plan 2.12): an in-house HPLC assay method is approved but cannot be made
// effective; its validation worksheet (linearity 50-150 %, accuracy at 80, 100 and 120 %) is run on the screens, the
// results worked out by L27 and L28; checked and reviewed; the validation report is prepared from the reviewed analysis
// (the conclusion read, not typed), reviewed by QC and approved by QA on screen; then QA makes the method effective and
// the methods list says "validated".

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, username);
  const proof = async (meaning: string) => /"signProof":"([^"]+)"/.exec(await (await page.request.get(`/sign?meanings=${meaning}`)).text())![1]!;
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<Record<string, unknown>>;
  };
  return { ctx, page, proof, post };
}
async function sign(page: Page) {
  await page.getByRole('dialog').last().getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function readings(page: Page, label: string, values: string[]) {
  for (const [i, v] of values.entries()) await page.getByLabel(`${label} ${i + 1}`, { exact: true }).fill(v);
  const field = page.locator('.fl-field', { hasText: label }).first();
  await field.getByRole('button', { name: /^Save the readings/ }).click();
  await expect(field.locator('.saved')).toBeVisible();
}
const methods = async (page: Page) => { await page.goto('/'); await page.getByRole('button', { name: 'Methods' }).click(); };

test('LIMS-02 validation journey: a linearity and accuracy validation is run, its report reviewed by QC and approved by QA, then the method becomes effective', async ({ browser }) => {
  // The method under validation (approved, not effective) and its validation worksheet (effective): written through the
  // API, their review and approval set by the database owner, as in the other journeys.
  const iss = await person(browser, 'iss1');
  const method = masterSchema.parse({
    header: { code: 'QC-M-091', name: 'Demolol tablets: assay by HPLC', technique: 'HPLC', reference: 'In-house method QC-M-091', origin: 'in-house' },
    stages: [{ key: 's', name: 'Assay', kind: 'normal', role: 'Analyst', steps: [{ key: 'r', block: { id: 'check', version: 1 }, checker: false,
      settings: { what: 'Assay', unit: '%', limit: { low: '95.0', high: '105.0', unit: '%' } } }] }],
  });
  const worksheet = masterSchema.parse({
    header: { code: 'VP-091', name: 'Validation protocol: Demolol assay by HPLC', technique: 'HPLC', reference: 'VP-2026-091', use: 'validation' },
    stages: [{ key: 'v', name: 'Validation characteristics', kind: 'normal', role: 'Analyst', steps: [
      { key: 'linearity', block: { id: 'linearity', version: 1 }, checker: true, settings: { levelUnit: '%', limit: { low: '0.999', unit: '' }, interceptLimit: { low: '-2.0', high: '2.0', unit: '%' }, use: 'assay' } },
      { key: 'accuracy', block: { id: 'accuracy', version: 1 }, checker: true, settings: { mode: 'recovery', amountUnit: 'mg', level1: '80 %', level2: '100 %', level3: '120 %',
        limit: { low: '98.0', high: '102.0', unit: '%' }, ciLimit: { low: '98.0', high: '102.0', unit: '%' } } },
    ] }],
  });
  const m = await iss.post('/api/masters', { doc: method }) as { id: number };
  const w = await iss.post('/api/masters', { doc: worksheet }) as { id: number };
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved']) await owner`update master_versions set state = ${s} where id in (${m.id}, ${w.id})`;
  await owner`update master_versions set state = 'effective' where id = ${w.id}`;
  await owner.end();

  // QA cannot make the method effective: it is not validated yet.
  const qa2 = await person(browser, 'qa2');
  await methods(qa2.page);
  await expect(qa2.page.getByRole('row', { name: /QC-M-091/ })).toContainText('not yet validated');
  await qa2.page.getByRole('row', { name: /QC-M-091/ }).click();
  await qa2.page.getByRole('button', { name: 'Review and approval' }).click();
  await expect(qa2.page.getByRole('button', { name: 'Make effective' })).toBeDisabled();
  await expect(qa2.page.getByText(/not validated yet: it becomes effective for routine use once its validation report is approved by QA/)).toBeVisible();

  // The worksheet is started on the methods screen and run on the analysis screens.
  await methods(iss.page);
  await iss.page.getByRole('row', { name: /VP-091/ }).last().getByRole('button', { name: 'Start a trial analysis' }).click();
  await iss.page.getByRole('button', { name: 'Next: sign' }).click();
  await sign(iss.page);
  await iss.page.waitForURL(/#\/analysis\/\d+$/);
  const id = Number(/#\/analysis\/(\d+)$/.exec(iss.page.url())![1]);
  await iss.ctx.close();

  const op = await person(browser, 'op1');
  await op.page.goto(`/#/analysis/${id}`);
  await op.page.getByRole('button', { name: /Linearity/ }).first().click();
  await op.page.getByRole('button', { name: 'Start', exact: true }).click();
  await readings(op.page, 'Levels (concentration or % of the test concentration)', ['50', '75', '100', '125', '150']);
  await readings(op.page, 'Responses (same order)', ['1012', '1498', '2003', '2510', '2995']);
  const results = op.page.getByRole('region', { name: 'Results' });
  await expect(results).toContainText('r = 0.99997');
  await expect(results).toContainText('y-intercept = 0.62 % of the response at 100 %');
  await expect(results).toContainText('Within limits');
  await op.page.screenshot({ path: test.info().outputPath('validation-linearity.png'), fullPage: true });
  await op.page.getByRole('button', { name: 'Done', exact: true }).click();
  await sign(op.page);
  await op.page.goto(`/#/analysis/${id}`);
  await op.page.getByRole('button', { name: /Accuracy/ }).first().click();
  await op.page.getByRole('button', { name: 'Start', exact: true }).click();
  for (const [k, added, found] of [[1, '8.0', ['7.94', '8.02', '7.97']], [2, '10.0', ['10.05', '9.96', '10.02']], [3, '12.0', ['11.93', '12.05', '12.01']]] as const) {
    await readings(op.page, `Level ${k}: amounts added`, [added, added, added]);
    await readings(op.page, `Level ${k}: amounts found`, [...found]);
  }
  await expect(results).toContainText('mean recovery 99.93 %');
  await expect(results).toContainText('95 % CI 99.57 to 100.28 %');
  await op.page.screenshot({ path: test.info().outputPath('validation-accuracy.png'), fullPage: true });
  await op.page.getByRole('button', { name: 'Done', exact: true }).click();
  await sign(op.page);
  await op.ctx.close();

  // The second person's checks and the review (through the API; their screens are the floor and review journeys').
  const chk = await person(browser, 'chk1');
  const rev = await person(browser, 'rev1');
  for (const key of ['0.1.0.1', '0.1.1.1']) {
    const a = await (await chk.page.request.get(`/api/analyses/${id}`)).json() as { steps: { id: string; contentHash: string }[] };
    await chk.post(`/api/analyses/${id}/steps/${key}/check`, { proof: await chk.proof('verified'), contentHash: a.steps.find((s) => s.id === key)!.contentHash });
  }
  await chk.ctx.close();
  const a = await (await rev.page.request.get(`/api/analyses/${id}`)).json() as { analysis: { contentHash: string } };
  await rev.post(`/api/analyses/${id}/review`, { proof: await rev.proof('reviewed'), contentHash: a.analysis.contentHash });

  // The author prepares the report on screen: the method version, the protocol number and the reviewed analysis;
  // the conclusion per characteristic is read from it.
  const author = await person(browser, 'author1');
  await methods(author.page);
  await author.page.getByRole('button', { name: 'Validation reports' }).click();
  await author.page.getByRole('button', { name: 'New report' }).click();
  const dialog = author.page.getByRole('dialog', { name: 'New report' });
  await dialog.getByLabel('Method version').selectOption({ label: 'QC-M-091 Demolol tablets: assay by HPLC · version 1 (in-house; not yet validated)' });
  await dialog.getByLabel('Type of test').selectOption('other (as the protocol says)');
  await dialog.getByLabel('Reference').fill('VP-2026-091');
  await dialog.getByRole('checkbox', { name: /VP-091/ }).check();
  await dialog.getByRole('button', { name: 'Work out the conclusion' }).click();
  await expect(dialog).toContainText('Conclusion: met');
  await expect(dialog).toContainText('linearity');
  await expect(dialog).toContainText('accuracy');
  await author.page.screenshot({ path: test.info().outputPath('validation-report-new.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Sign as prepared' }).click();
  await sign(author.page);
  await expect(author.page.getByRole('heading', { level: 1 })).toContainText(/MVR\d{6} · validation of QC-M-091 version 1/);
  await expect(author.page.locator('.greeting')).toContainText('to review');
  const reportNo = /MVR\d{6}/.exec(await author.page.getByRole('heading', { level: 1 }).innerText())![0];
  await author.ctx.close();

  // QC reviews it on screen; QA approves it on screen.
  await methods(rev.page);
  await rev.page.getByRole('button', { name: 'Validation reports' }).click();
  await rev.page.getByRole('row', { name: new RegExp(reportNo) }).click();
  await rev.page.getByRole('button', { name: 'Review (QC)' }).click();
  await sign(rev.page);
  await expect(rev.page.locator('.greeting')).toContainText('to approve');
  await rev.ctx.close();
  const qa = await person(browser, 'qa1');
  await methods(qa.page);
  await qa.page.getByRole('button', { name: 'Validation reports' }).click();
  await qa.page.getByRole('row', { name: new RegExp(reportNo) }).click();
  await qa.page.getByRole('button', { name: 'Approve (QA)' }).click();
  await sign(qa.page);
  await expect(qa.page.locator('.greeting')).toContainText('approved');
  await qa.page.screenshot({ path: test.info().outputPath('validation-report-approved.png'), fullPage: true });
  await qa.ctx.close();

  // Now QA makes the method effective; the methods list says validated, with the report.
  await methods(qa2.page);
  await qa2.page.getByRole('row', { name: /QC-M-091/ }).click();
  await qa2.page.getByRole('button', { name: 'Review and approval' }).click();
  await qa2.page.getByRole('button', { name: 'Make effective' }).click();
  await qa2.page.getByRole('dialog').getByRole('button', { name: 'Make effective' }).click();
  await expect(qa2.page.locator('.d-title')).toContainText('Effective');
  await methods(qa2.page);
  await expect(qa2.page.getByRole('row', { name: /QC-M-091/ })).toContainText('validated');
  await expect(qa2.page.getByRole('row', { name: /QC-M-091/ })).toContainText(reportNo);
  await qa2.page.screenshot({ path: test.info().outputPath('validation-method-effective.png'), fullPage: true });
  await qa2.ctx.close();
});
