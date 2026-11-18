import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_PRODUCT_ID, E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The OOS journey (LIMS-23, LIMS-24, LIMS-48): a pH out of its limit opens an OOS at once; on screen the analyst answers
// the phase Ia checklist (the meter's buffer had expired), plans and records a re-measurement, and concludes a
// laboratory error; a supervisor reviews phase I; QA invalidates the result; the analyst starts the retest from the
// OOS; the retest passes and QC approves the sample. Setup (method, specification, sample, the first analysis) goes
// through the API, as the other journeys do.

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, username);
  const proof = async (meaning: string) => /"signProof":"([^"]+)"/.exec(await (await page.request.get(`/sign?meanings=${meaning}`)).text())![1]!;
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<{ id: number; masterId: number; analysisNo: string }>;
  };
  return { ctx, page, proof, post };
}
type Person = Awaited<ReturnType<typeof person>>;

/** Signs in the open sign dialog: the sign window opens, the stand-in for core confirms, the window closes. */
async function sign(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** pH recorded and signed in an analysis (through the API): a value out of limits needs its note first. */
async function measure(op: Person, id: number, reading: string) {
  const step = (action: string, body: object = {}) => op.post(`/api/analyses/${id}/steps/0.1.0.1/${action}`, body);
  await step('start');
  await step('record', { values: { reading } });
  if (Number(reading) > 7) await step('note', { text: 'pH above the limit: OOS' });
  const hash = (await (await op.page.request.get(`/api/analyses/${id}`)).json() as { steps: { contentHash: string }[] }).steps[0]!.contentHash;
  await step('done', { proof: await op.proof('performed'), contentHash: hash });
}

test('LIMS-23 LIMS-24 OOS journey: an out-of-limit result opens an OOS; phase I finds a laboratory error; QA invalidates; the retest passes and the sample is approved', async ({ browser }) => {
  // The method and specification (pH 5.0 to 7.0), made effective; a batch of FG-DEM100 registered by hand (TrueBatch
  // is not linked here), checked by a second person and received.
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Measurement', steps: [{ key: 'ph', settings: { what: 'pH', unit: '', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-070', name: 'pH of a 10 % suspension', technique: 'Other', reference: 'In-house method QC-M-070' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const spec = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'product', itemId: E2E_PRODUCT_ID, code: 'FG-DEM100', name: 'Demolol 100 mg tablets', type: 'Finished product', number: 'SPEC-FG-DEM100', pharmacopoeia: 'In-house' },
    tests: [{ key: 'ph', name: 'pH', method: { masterId: m.masterId, code: 'QC-M-070', name: 'pH of a 10 % suspension' }, result: 's0/ph/readingCheck', limitType: 'range',
      limit: { low: '5.0', high: '7.0', unit: '' }, values: {}, use: 'release and stability' }],
  } });
  const owner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await owner`update master_versions set state = ${s} where id in (${m.id}, ${spec.id})`;
  await owner.end();
  await iss.ctx.close();
  const smp1 = await person(browser, 'smp1');
  const sample = await smp1.post('/api/samples', { source: 'truebatch', batchNumber: 'DEM-OOS-01', byHand: true, itemId: E2E_PRODUCT_ID, specVersionId: spec.id, quantity: '40 tablets' });
  const smp2 = await person(browser, 'smp2');
  await smp2.post(`/api/samples/${sample.id}/check`, {});
  await smp2.ctx.close();
  await smp1.post(`/api/samples/${sample.id}/receive`, { condition: 'Sealed' });
  await smp1.ctx.close();

  // The analyst signs pH 7.6: the OOS opens at once and is listed on the OOS tab.
  const op = await person(browser, 'op1');
  const first = await op.post('/api/analyses', { masterVersionId: m.id, sampleId: sample.id, proof: await op.proof('issued') });
  await measure(op, first.id, '7.6');
  await op.page.getByRole('button', { name: 'OOS', exact: true }).click();
  const row = op.page.getByRole('table', { name: 'Open OOS' }).getByRole('row', { name: /DEM-OOS-01/ });
  await expect(row).toContainText('pH: 7.6');
  await expect(row).toContainText('Phase I');
  await row.click();
  const heading = op.page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText(/OOS\d{6}/);
  const oosNo = /OOS\d{6}/.exec(await heading.innerText())![0];
  await expect(op.page.getByRole('region', { name: 'The result' })).toContainText(`limit 5.0 to 7.0`);

  // Phase Ia: every item answered; the "no" says what was found.
  const ia = op.page.getByRole('region', { name: 'Phase Ia: laboratory checklist' });
  for (const g of await ia.getByRole('group').all()) await g.getByLabel('Yes').check();
  await ia.getByRole('group', { name: 'The instrument was fit for use and calibrated' }).getByLabel('No').check();
  await expect(ia.getByRole('button', { name: 'Save the checklist' })).toBeDisabled();
  await ia.getByLabel('The instrument was fit for use and calibrated: what was found').fill('pH meter calibrated with buffer 7.00 that expired on 1 Nov');
  await ia.getByRole('button', { name: 'Save the checklist' }).click();
  await expect(ia).toContainText('The instrument was fit for use and calibrated: no · pH meter calibrated with buffer 7.00 that expired on 1 Nov');

  // Phase Ib: the re-measurement is planned in writing first, then recorded; both results stay on the screen.
  const ib = op.page.getByRole('region', { name: 'Phase Ib: hypothesis testing' });
  await ib.getByLabel('What is re-measured, and how').fill('Calibrate with in-date buffers, then measure the same suspension again');
  await ib.getByLabel('By whom').fill('The analyst, same meter');
  await ib.getByRole('button', { name: 'Save the plan' }).click();
  await ib.getByLabel('Result').fill('6.3');
  await ib.getByLabel('Where its raw data are').fill('pH meter printout 0412');
  await ib.getByRole('button', { name: 'Record the result' }).click();
  await expect(ib).toContainText('Result: 6.3');
  await expect(op.page.getByRole('region', { name: 'The result' })).toContainText('7.6');

  // Phase I concluded: an assignable laboratory error.
  const p1 = op.page.getByRole('region', { name: 'Phase I conclusion and review' });
  await p1.getByLabel('Yes: a laboratory error').check();
  await p1.getByLabel('The assignable cause').fill('pH meter calibrated with an expired buffer');
  await p1.getByRole('button', { name: 'Conclude phase I' }).click();
  await expect(p1).toContainText('Assignable laboratory error: pH meter calibrated with an expired buffer');
  await expect(heading).toContainText('Phase I review');
  const url = op.page.url();

  // A supervisor who did no part of it reviews phase I (e-signature).
  const rev = await person(browser, 'rev1');
  await rev.page.goto(url);
  await rev.page.getByRole('button', { name: 'Sign: phase I reviewed' }).click();
  await sign(rev.page);
  await expect(rev.page.getByRole('heading', { level: 1 })).toContainText('Waiting for QA');

  // QA invalidates the result (e-signature): the analysis stays, marked invalidated (LIMS-48); one retest authorised.
  const qa = await person(browser, 'qaoos1');
  await qa.page.goto(url);
  const qc = qa.page.getByRole('region', { name: 'QA conclusion' });
  await qc.getByLabel('Reason').fill('Assignable laboratory cause confirmed: expired calibration buffer');
  await qc.getByRole('button', { name: 'Sign: invalidate the result' }).click();
  await expect(qa.page.getByRole('dialog')).toContainText('QA approved (OOS)');
  await sign(qa.page);
  await expect(qa.page.getByRole('heading', { level: 1 })).toContainText('Invalidated');
  await expect(qc).toContainText('Invalidated: Assignable laboratory cause confirmed');
  if (process.env.SHOTS) {
    await qa.page.addStyleTag({ content: '.bar { position: static; }' });
    await qa.page.screenshot({ path: `${process.env.SHOTS}/oos-screen.png`, fullPage: true });
  }
  await qa.ctx.close();
  await op.page.goto(`/#/analysis/${first.id}`);
  await expect(op.page.getByRole('note').filter({ hasText: 'Invalidated by QA' })).toContainText(`Invalidated by QA in ${oosNo}`);
  await expect(op.page.locator('.bh')).toContainText('Invalidated');

  // The retest, started from the OOS: a new analysis of the same sample, linked; it passes.
  await op.page.goto(url);
  const retests = op.page.getByRole('region', { name: 'Retests' });
  await expect(retests).toContainText('1 retest authorised');
  await retests.getByRole('button', { name: /Start the retest/ }).click();
  await expect(op.page.getByRole('dialog', { name: 'Start an analysis' })).toContainText(`as a retest of ${oosNo}`);
  await op.page.getByRole('button', { name: 'Next: sign' }).click();
  await sign(op.page);
  await op.page.waitForURL(/#\/analysis\/\d+$/);
  const retestId = Number(/#\/analysis\/(\d+)$/.exec(op.page.url())![1]);
  await expect(op.page.locator('.alerts[aria-label="OOS"]')).toContainText(`Retest of${oosNo}`);
  await measure(op, retestId, '6.2');
  await op.ctx.close();
  const a = (await (await rev.page.request.get(`/api/analyses/${retestId}`)).json()) as { analysis: { contentHash: string } };
  await rev.post(`/api/analyses/${retestId}/review`, { proof: await rev.proof('reviewed'), contentHash: a.analysis.contentHash });
  await rev.page.reload();
  await expect(rev.page.getByRole('region', { name: 'Retests' })).toContainText(/LA\d{7} · reviewed · 6\.2 within limits/);
  await rev.ctx.close();

  // QC: the OOS is invalidated, the invalidated analysis no longer counts, the retest does: the sample is approved.
  const qcp = await person(browser, 'qc1');
  await qcp.page.getByRole('button', { name: 'Samples', exact: true }).click();
  await qcp.page.getByRole('table', { name: 'Samples' }).getByRole('row', { name: /DEM-OOS-01/ }).click();
  const decision = qcp.page.getByRole('region', { name: 'QC decision' });
  await expect(decision).toContainText(`${oosNo} · pH, analysis ${first.analysisNo} · invalidated (laboratory error)`);
  await expect(qcp.page.getByRole('region', { name: 'Tests' })).toContainText(`${first.analysisNo} · invalidated`);
  await decision.getByRole('button', { name: 'Sign: QC approved' }).click();
  await sign(qcp.page);
  await expect(decision).toContainText(/Approved, certificate COA\d{7}/);
  if (process.env.SHOTS) await qcp.page.screenshot({ path: `${process.env.SHOTS}/oos-sample-approved.png`, fullPage: true });
  await qcp.ctx.close();
});
