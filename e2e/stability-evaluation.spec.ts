import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { plantToday } from '../server/routes/inventory.js';
import { addDays } from '../shared/engine/stability.js';
import { E2E_SCHEMA, E2E_STAB_PRODUCT_ID } from './config.js';
import { logIn } from './helpers.js';

// The stability evaluation journey (LIMS-29): a product with three studies whose time points to 12 months were pulled,
// analysed and reviewed (setup through the API: the studies were placed 400 days ago, as the database owner, so their
// pulls are late with a reason and a deviation typed by hand). On screen QA opens the product's evaluation: ICH Q1E over
// the three batches (template L15); QA answers the decision tree, sees the proposed shelf life and signs it; the study
// screen shows the signed evaluation; the CTD 3.2.P.8.3 tables download as PDF and CSV.

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  await logIn(page, username);
  const proof = async (meaning: string) => /"signProof":"([^"]+)"/.exec(await (await page.request.get(`/sign?meanings=${meaning}`)).text())![1]!;
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<{ id: number; masterId: number; analysisNo: string; sampleId: number }>;
  };
  return { ctx, page, proof, post };
}
async function sign(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('LIMS-29 stability evaluation journey: Q1E over three batches, QA signs the shelf life, the CTD tables download', async ({ browser }) => {
  test.setTimeout(180_000);
  // Method (assay by a reading) and specification of FG-DEM200 (95.0 to 105.0 %, on stability too), and the protocol, effective.
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Measurement', steps: [{ key: 'as', settings: { what: 'Assay', unit: '%', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-200', name: 'Assay of Demolol', technique: 'Other', reference: 'In-house method QC-M-200' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const spec = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'product', itemId: E2E_STAB_PRODUCT_ID, code: 'FG-DEM200', name: 'Demolol 200 mg tablets', type: 'Finished product', number: 'SPEC-FG-DEM200', pharmacopoeia: 'In-house' },
    tests: [{ key: 'assay', name: 'Assay', method: { masterId: m.masterId, code: 'QC-M-200', name: 'Assay of Demolol' }, result: 's0/as/readingCheck', limitType: 'range',
      limit: { low: '95.0', high: '105.0', unit: '%' }, values: {}, use: 'release and stability' }],
  } });
  const o = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await o`update master_versions set state = ${s} where id in (${m.id}, ${spec.id})`;
  await iss.ctx.close();
  const author = await person(browser, 'author1');
  const p = await author.post('/api/masters', { kind: 'protocol', doc: {
    header: { of: 'product', itemId: E2E_STAB_PRODUCT_ID, code: '', name: '', number: 'STP-FG-DEM200', purpose: 'registration', containerClosure: 'HDPE bottle, 30 tablets',
      sameAsMarketed: true, shelfLifeMonths: 24 },
    spec: { versionId: spec.id, number: '', versionNo: 1 }, quantity: { amount: '20', unit: 'tablets' }, pullWindowDays: 7,
    conditions: [{ key: 'lt', code: '30/75', role: 'long-term', months: [0, 3, 6, 9, 12, 18, 24] }, { key: 'acc', code: '40/75', role: 'accelerated', months: [0, 3, 6] }],
    design: { type: 'full', factors: [], matrix: [] },
  } });
  await author.ctx.close();
  const smp1 = await person(browser, 'smp1');
  for (const s of ['in_review', 'approved', 'effective']) await o`update master_versions set state = ${s} where id = ${p.id}`;
  const smp = (await o<{ smp: number }[]>`select id::int as smp from users where username = 'smp1'`)[0]!.smp;
  const t0 = addDays(plantToday(new Date()), -400);
  const results: Record<string, string[]> = {
    'DEM-STB-11': ['100.2', '99.8', '99.3', '99.0', '98.5'],
    'DEM-STB-12': ['100.0', '99.7', '99.1', '98.8', '98.4'],
    'DEM-STB-13': ['100.1', '99.6', '99.2', '98.8', '98.3'],
  };
  const studyIds: number[] = [];
  for (const [n, lot] of Object.keys(results).entries()) {
    const [s] = await o<{ id: number }[]>`insert into stability_studies (study_no, protocol_version_id, lot_no, item, source, t0, created_by)
      values (${`STB25${String(201 + n)}`}, ${p.id}, ${lot}, ${o.json({ of: 'product', itemId: E2E_STAB_PRODUCT_ID, code: 'FG-DEM200', name: 'Demolol 200 mg tablets' })},
        ${o.json({ from: 'truebatch', asOf: null, shown: `TrueBatch batch ${lot}` })}, ${t0}, ${smp!}) returning id::int`;
    studyIds.push(s!.id);
    for (const c of ['lt', 'acc']) {
      await o`insert into stability_events (study_id, kind, payload, person_id) values (${s!.id}, 'placed', ${o.json({ condition: c, chamber: { itemId: 'eq-ch1', code: 'CH-01', name: 'Stability chamber' }, quantity: '200' })}, ${smp!})`;
    }
  }
  await o.end();

  // Pulled (late, with the reason and the deviation typed by hand), received, analysed and reviewed.
  const op = await person(browser, 'op1');
  const rev = await person(browser, 'rev1');
  for (const [n, lot] of Object.keys(results).entries()) {
    for (const [k, reading] of results[lot]!.entries()) {
      const pull = await smp1.post(`/api/stability/studies/${studyIds[n]}/pull`, { condition: 'lt', month: [0, 3, 6, 9, 12][k], late: { reason: 'Study set up late', deviation: 'DEV-26-077' } });
      await smp1.post(`/api/samples/${pull.sampleId}/receive`, { condition: 'Sealed' });
      const a = await op.post('/api/analyses', { masterVersionId: m.id, sampleId: pull.sampleId, proof: await op.proof('issued') });
      const step = (action: string, body: object = {}) => op.post(`/api/analyses/${a.id}/steps/0.1.0.1/${action}`, body);
      await step('start');
      await step('record', { values: { reading } });
      const hash = (await (await op.page.request.get(`/api/analyses/${a.id}`)).json() as { steps: { contentHash: string }[] }).steps[0]!.contentHash;
      await step('done', { proof: await op.proof('performed'), contentHash: hash });
      const ah = (await (await rev.page.request.get(`/api/analyses/${a.id}`)).json() as { analysis: { contentHash: string } }).analysis.contentHash;
      await rev.post(`/api/analyses/${a.id}/review`, { proof: await rev.proof('reviewed'), contentHash: ah });
    }
  }
  await Promise.all([smp1.ctx.close(), op.ctx.close(), rev.ctx.close()]);

  // QA opens the product's evaluation: the three batches, Q1E on the long-term condition.
  const qa = await person(browser, 'qa1');
  await qa.page.getByRole('button', { name: 'Stability', exact: true }).click();
  await qa.page.getByRole('button', { name: 'Evaluation', exact: true }).click();
  await qa.page.getByRole('table', { name: 'Products on stability' }).getByRole('row', { name: /FG-DEM200/ }).click();
  await expect(qa.page.getByRole('heading', { level: 1 })).toHaveText('FG-DEM200 Demolol 200 mg tablets');
  await expect(qa.page.getByRole('table', { name: 'Data DEM-STB-11 30 °C / 75 % RH (India, zone IVb)' })).toContainText('98.5 % *');
  const ev = qa.page.getByRole('table', { name: 'Evaluation 30 °C / 75 % RH (India, zone IVb)' });
  await expect(ev.getByRole('row', { name: /Assay/ })).toContainText('DEM-STB-11, DEM-STB-12, DEM-STB-13');
  await expect(ev.getByRole('row', { name: /Assay/ })).toContainText(/pooled|common slope|separate/);

  // QA answers the Q1E decision tree, sees the proposal and signs it.
  await qa.page.getByRole('button', { name: 'Propose the shelf life (QA)' }).click();
  const dlg = qa.page.getByRole('dialog', { name: 'Propose the shelf life' });
  await expect(dlg.getByLabel('Storage')).toHaveValue('room temperature');
  await dlg.getByLabel('Significant change at accelerated').selectOption('no significant change');
  await expect(dlg.getByRole('status')).toContainText('Say whether the data show little or no change');
  await dlg.getByLabel('Long-term data show').selectOption('change or variability');
  await expect(dlg.getByRole('status')).toContainText(/Proposed shelf life: \d+ months \(limited by Assay/);
  const proposed = /Proposed shelf life: (\d+) months/.exec(await dlg.getByRole('status').innerText())![1]!;
  await dlg.getByRole('button', { name: 'Continue to sign' }).click();
  await expect(qa.page.getByRole('dialog')).toContainText(`Proposed shelf life: ${proposed} months`);
  await sign(qa.page);
  const signed = qa.page.getByRole('table', { name: 'Signed evaluations' });
  await expect(signed).toContainText(`${proposed} months`);
  await expect(signed).toContainText('STB25201, STB25202, STB25203');

  // The CTD tables download: PDF and CSV.
  const [pdf] = await Promise.all([qa.page.waitForEvent('download'), qa.page.getByRole('link', { name: 'CTD 3.2.P.8.3 (PDF)' }).click()]);
  expect(pdf.suggestedFilename()).toBe('CTD-3.2.P.8.3-FG-DEM200.pdf');
  expect((await readFile((await pdf.path())!)).subarray(0, 5).toString()).toBe('%PDF-');
  const [csv] = await Promise.all([qa.page.waitForEvent('download'), qa.page.getByRole('link', { name: 'CTD table (CSV)' }).click()]);
  expect(csv.suggestedFilename()).toBe('CTD-3.2.P.8.3-FG-DEM200.csv');
  const text = (await readFile((await csv.path())!)).toString('utf8');
  expect(text).toContain('Acceptance criterion,Time point (months),Result');
  expect(text).toMatch(new RegExp(`STB25201,DEM-STB-11,.*,12,98\\.5 %,yes,.*,${proposed}\\r\\n`));

  // The study screen shows its data and the signed evaluation that covers it.
  await qa.page.getByRole('button', { name: 'STB25201' }).click();
  await expect(qa.page.getByRole('heading', { level: 1 })).toHaveText('STB25201');
  await expect(qa.page.getByRole('table', { name: 'Signed evaluations' })).toContainText(`${proposed} months`);
  await qa.ctx.close();
});
