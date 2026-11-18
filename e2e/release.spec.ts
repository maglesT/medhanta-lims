import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The second person's review in the browser (LIMS-18, LIMS-19), on an analysis made complete through the API: a pH check
// out of limits with a deviation note (DEV-26-021, typed: no Deviations link here) and the sample weighed on an
// analytical balance. And stopping an analysis that cannot be finished (LIMS-48).

/** A signed-in person's browser, with its signing proofs (as the sign window gets them from the stand-in for core). */
async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, username);
  const proof = async (meaning: string) => {
    const r = await page.request.get(`/sign?meanings=${meaning}`);
    return /"signProof":"([^"]+)"/.exec(await r.text())![1]!;
  };
  return { ctx, page, proof };
}

/** An analysis started from a small effective method, nothing done yet. */
async function startedAnalysis(browser: Browser): Promise<{ id: number; analysisNo: string }> {
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Sample', steps: [{ checker: true },
    { block: { id: 'weigh', version: 1 }, checker: true, settings: { what: 'Sample', unit: 'mg', target: '100.0 mg', tolerance: '10' } }] }]);
  doc.header = { code: 'QC-M-060', name: 'Demolol tablets: pH and sample weighing', technique: 'Other', reference: 'In-house method QC-M-060' };
  const { id: mv } = await (await iss.page.request.post('/api/masters', { data: { doc } })).json() as { id: number };
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id = ${mv}`;
  await owner.end();
  const analysis = await (await iss.page.request.post('/api/analyses', { data: { masterVersionId: mv, proof: await iss.proof('issued') } })).json() as { id: number; analysisNo: string };
  await iss.ctx.close();
  return analysis;
}

async function completeAnalysis(browser: Browser): Promise<{ id: number; analysisNo: string }> {
  const analysis = await startedAnalysis(browser);
  const op = await person(browser, 'op1');
  const chk = await person(browser, 'chk1');
  const rev2 = await person(browser, 'rev2');
  const hash = async (p: Page, key: string) => {
    const b = await (await p.request.get(`/api/analyses/${analysis.id}`)).json() as { steps: { id: string; contentHash: string }[] };
    return b.steps.find((s) => s.id === key)!.contentHash;
  };
  const step = async (who: typeof op, key: string, action: string, body: object = {}) => {
    const r = await who.page.request.post(`/api/analyses/${analysis.id}/steps/${key}/${action}`, { data: body });
    expect(r.ok(), `${action} ${key}: ${await r.text()}`).toBe(true);
  };
  const signed = async (who: typeof op, key: string, action: 'done' | 'check') =>
    step(who, key, action, { proof: await who.proof(action === 'done' ? 'performed' : 'verified'), contentHash: await hash(who.page, key) });
  await step(op, '0.1.0.1', 'start');
  await step(op, '0.1.0.1', 'record', { values: { reading: '7.4' } });
  await step(op, '0.1.0.1', 'note', { text: 'pH 7.4 on the second reading; meter calibration checked', reference: 'DEV-26-021' });
  await signed(op, '0.1.0.1', 'done');
  await signed(chk, '0.1.0.1', 'check');
  // The balance typed by hand (no Logbook link): its status labels answered yes.
  const labels = Object.fromEntries(['clean', 'calibrated', 'inService', 'qualified'].map((n) => [`balance.${n}`, 'yes']));
  await step(op, '0.1.1.1', 'start');
  await step(op, '0.1.1.1', 'record', { values: { balance: 'eq-bal', ...labels, mass: '101.2' } });
  await signed(op, '0.1.1.1', 'done');
  // rev2 checks the weighing: a part of the record, so rev2 may not review it.
  await signed(rev2, '0.1.1.1', 'check');
  for (const p of [op, chk, rev2]) await p.ctx.close();
  return analysis;
}

/** Signs in the open sign dialog: the sign window opens, the stand-in for core confirms, the window closes. */
async function sign(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('LIMS-18 review journey: a second person reviews the complete analysis with its audit trail, closes the deviation note, signs, and the analysis record PDF downloads', async ({ browser }) => {
  const analysis = await completeAnalysis(browser);

  // LIMS-41: the reviewer who checked a step sees the analysis, but another person reviews it.
  const rev2 = await person(browser, 'rev2');
  await rev2.page.getByRole('button', { name: 'To review' }).click();
  const own = rev2.page.getByRole('region', { name: 'Waiting for review' }).getByRole('button', { name: new RegExp(analysis.analysisNo) });
  await expect(own).toContainText('Not yours to review');
  await own.click();
  await expect(rev2.page.getByText('You recorded or signed steps of this analysis: another person reviews it.')).toBeVisible();
  await expect(rev2.page.getByRole('button', { name: 'Sign: reviewed' })).toHaveCount(0);
  await rev2.ctx.close();

  // LIMS-19: the reviewer reads the record and its audit trail: the value out of limits, its deviation note, the hand entries, every signature.
  const rev = await person(browser, 'rev1');
  await rev.page.getByRole('button', { name: 'To review' }).click();
  const row = rev.page.getByRole('region', { name: 'Waiting for review' }).getByRole('button', { name: new RegExp(analysis.analysisNo) });
  await expect(row).toContainText('1 open deviation');
  await expect(row).toContainText('Ready for your review');
  await row.click();
  const review = rev.page.getByRole('region', { name: 'Review of the record and its audit trail' });
  await expect(review.locator('li.bad').first()).toContainText('Sample › Check a value against limits: pH');
  await expect(review).toContainText('OUT OF LIMITS');
  await expect(review).toContainText('DEV-26-021 (typed by hand)');
  await expect(review).toContainText('Typed by hand (a link was off or down)');
  await expect(review).toContainText('Balance');
  await expect(review).toContainText('Signatures (5)');
  await expect(review).toContainText('Verified (second person)');
  // The deviation note typed by hand is closed by QC, with a reason.
  await rev.page.getByRole('button', { name: 'Close the deviation…' }).click();
  await rev.page.getByLabel('Reason for closing').fill('Meter recalibrated; pH confirmed with a second meter');
  await rev.page.getByRole('button', { name: 'Close the deviation', exact: true }).click();
  await expect(review).toContainText('Closed by REV1');
  // SHOTS=<folder>: a picture of the review screen for the docs (the sticky bar is unpinned for a full-page picture).
  if (process.env.SHOTS) {
    await rev.page.addStyleTag({ content: '.bar { position: static; }' });
    await rev.page.screenshot({ path: `${process.env.SHOTS}/review-screen.png`, fullPage: true });
  }
  await rev.page.getByRole('button', { name: 'Sign: reviewed' }).click();
  await expect(rev.page.getByRole('dialog')).toContainText('audit trail');
  await sign(rev.page);
  await expect(rev.page.getByRole('status')).toContainText('The analysis is reviewed.');
  await expect(rev.page.locator('.bh')).toContainText('Reviewed');

  // The analysis record PDF.
  const [download] = await Promise.all([rev.page.waitForEvent('download'), rev.page.getByRole('link', { name: 'Analysis record (PDF)' }).last().click()]);
  expect(download.suggestedFilename()).toBe(`analysis-record-${analysis.analysisNo}.pdf`);
  const path = await download.path();
  const { readFileSync, copyFileSync } = await import('node:fs');
  expect(readFileSync(path).subarray(0, 5).toString()).toBe('%PDF-');
  if (process.env.SHOTS) copyFileSync(path, `${process.env.SHOTS}/analysis-record.pdf`);
  await rev.page.getByRole('button', { name: '← To review' }).click();
  await expect(rev.page.getByRole('region', { name: 'Waiting for review' })).not.toContainText(analysis.analysisNo);
  await rev.ctx.close();
});

test('LIMS-48 the reviewer stops an analysis still in progress from the To review list: a reason, a signature; the record is kept and says who, when and why', async ({ browser }) => {
  const analysis = await startedAnalysis(browser);
  // The first step was performed and waits for its second-person check when the analysis is stopped.
  const op = await person(browser, 'op1');
  const step = async (key: string, action: string, body: object = {}) => expect((await op.page.request.post(`/api/analyses/${analysis.id}/steps/${key}/${action}`, { data: body })).ok()).toBe(true);
  await step('0.1.0.1', 'start');
  await step('0.1.0.1', 'record', { values: { reading: '6.0' } });
  const hash = (await (await op.page.request.get(`/api/analyses/${analysis.id}`)).json() as { steps: { id: string; contentHash: string }[] }).steps.find((s) => s.id === '0.1.0.1')!.contentHash;
  await step('0.1.0.1', 'done', { proof: await op.proof('performed'), contentHash: hash });
  await op.ctx.close();
  const rev = await person(browser, 'rev1');
  await rev.page.getByRole('button', { name: 'To review' }).click();
  const inProgress = rev.page.getByRole('region', { name: 'In progress' });
  await expect(inProgress).toContainText(analysis.analysisNo);
  if (process.env.SHOTS) await rev.page.screenshot({ path: `${process.env.SHOTS}/to-review-in-progress.png`, fullPage: true });
  await inProgress.locator('.pending-row', { hasText: analysis.analysisNo }).getByRole('button', { name: 'Stop the analysis' }).click();
  await rev.page.getByLabel('Reason for stopping').fill('The pH meter failed and no other is qualified: the analysis cannot be finished');
  await rev.page.getByRole('button', { name: 'Continue to sign' }).click();
  await expect(rev.page.getByRole('dialog')).toContainText('Sign: Stopped');
  await sign(rev.page);
  await expect(inProgress).not.toContainText(analysis.analysisNo);
  await rev.page.goto(`/#/analysis/${analysis.id}`);
  await expect(rev.page.getByRole('note')).toContainText(/^Stopped by REV1 at \d{1,2} \w{3}, \d\d:\d\d IST: The pH meter failed/);
  await expect(rev.page.locator('.bh')).toContainText('Stopped');
  await expect(rev.page.getByRole('button', { name: 'Stop the analysis' })).toHaveCount(0);
  await expect(rev.page.getByRole('region', { name: 'Review' })).toHaveCount(0);
  // The analysis runs no more: no stage is "now"; the stage left unclosed says Stopped.
  const stages = rev.page.getByRole('navigation', { name: 'Stages' });
  await expect(stages).toContainText('Stopped');
  await expect(stages.locator('small', { hasText: /^(Now|Open|Waiting)$/ })).toHaveCount(0);
  // Its steps never read as still to come (owner, 16 Nov 2026): no "Ready to start", "Waiting for check" or "Waits for".
  const steplist = rev.page.locator('.steplist');
  await expect(steplist.locator('.chip', { hasText: /^(Waiting|Ready to start|In progress|Waiting for check)$/ })).toHaveCount(0);
  await expect(steplist).not.toContainText('Waits for');
  if (process.env.SHOTS) await rev.page.screenshot({ path: `${process.env.SHOTS}/analysis-stopped.png`, fullPage: true });
  // The step left waiting for its check: no "Waiting for a second person"; what was recorded is kept and shown.
  await steplist.locator('.step-row').first().click();
  await expect(rev.page.getByRole('region', { name: 'What was recorded' })).toBeVisible();
  await expect(rev.page.getByRole('region', { name: 'What was recorded' })).toContainText('6.0');
  await expect(rev.page.getByText(/Waiting for a second person|a second person checks it/)).toHaveCount(0);
  await rev.page.goto(`/#/analysis/${analysis.id}`);
  await steplist.locator('.step-row').nth(1).click();
  await expect(rev.page.getByText('Not open yet')).toHaveCount(0);
  await rev.ctx.close();
});
