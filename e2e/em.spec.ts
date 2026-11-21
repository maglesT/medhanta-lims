import { expect, test, type Browser, type Page } from '@playwright/test';
import { connect } from '../server/db.js';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { small } from '../test/engine-fixture.js';
import { E2E_EM_ID, E2E_SCHEMA } from './config.js';
import { logIn } from './helpers.js';

// The EM journey (LIMS-36): QA approves a monitoring plan on screen and another QA person makes it effective (the change
// control was typed: QMS is not linked); the sampler takes the settle plate of a grade B room from "Due today", which
// makes an ordinary sample; its reviewed result (7 CFU) is over the action limit (5 CFU): on the Excursions tab the
// sampler opens the investigation with the deviation number (typed by hand: Deviations is not linked here), a second
// person checks it, and the isolate is identified. Setup (method, specification, the plan's draft, its submission and
// check, the analysis and its review) goes through the API, as the other journeys do.

async function person(browser: Browser, username: string) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await logIn(page, username);
  const proof = async (meaning: string) => /"signProof":"([^"]+)"/.exec(await (await page.request.get(`/sign?meanings=${meaning}`)).text())![1]!;
  const post = async (url: string, data: object) => {
    const r = await page.request.post(url, { data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json() as Promise<{ id: number; masterId: number }>;
  };
  return { ctx, page, proof, post };
}
type Person = Awaited<ReturnType<typeof person>>;
async function sign(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
const emTab = async (p: Person, sub: string) => {
  await p.page.getByRole('button', { name: 'EM and water', exact: true }).click();
  await p.page.getByRole('navigation', { name: 'EM and water' }).getByRole('button', { name: sub }).click();
};

test('LIMS-36 EM journey: a plan approved, a settle plate taken from "due today" in a grade B room, its result over the action limit opens an excursion with a deviation', async ({ browser }) => {
  // The plate count method and the grade B specification (settle plate, action NMT 5 CFU, alert above 3), made effective.
  const iss = await person(browser, 'iss1');
  const doc = small([{ name: 'Count', steps: [{ key: 'count', settings: { what: 'Colonies on the plate', unit: 'CFU', limit: { spec: 'limit' } } }] }]);
  doc.header = { code: 'QC-M-EM1', name: 'Settle plate count', technique: 'Other', reference: 'In-house method QC-M-EM1' };
  const m = await iss.post('/api/masters', { kind: 'method', doc });
  const spec = await iss.post('/api/masters', { kind: 'spec', doc: {
    header: { of: 'material', itemId: E2E_EM_ID, code: 'QC-EM', name: 'Environmental monitoring, sterile block', type: 'Environmental monitoring', number: 'SPEC-EM-B', pharmacopoeia: 'In-house' },
    tests: [{ key: 'sp', name: 'Settle plate (4 h)', method: { masterId: m.masterId, code: 'QC-M-EM1', name: 'Settle plate count' }, result: 's0/count/readingCheck', limitType: 'alert and action',
      limit: { high: '5', alertHigh: '3', unit: 'CFU' }, values: {}, use: 'release' }],
  } });
  const o = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
  for (const s of ['in_review', 'approved', 'effective']) await o`update master_versions set state = ${s} where id in (${m.id}, ${spec.id})`;
  await o.end();
  await iss.ctx.close();

  // The plan's draft (a settle plate in operation, daily, at B101-SP1 of the grade B room B101), sent for review and checked.
  const author = await person(browser, 'author1');
  const p = await author.post('/api/masters', { kind: 'monitoring', doc: { header: { number: 'EMP-B-001', name: 'Sterile block: grade B filling', shifts: 1 }, points: [
    { key: 'p1', code: 'B101-SP1', name: 'Beside the filling line', of: 'room', room: { itemId: 'rm-b101', code: '', name: '', grade: '' }, critical: true, samplings: [
      { key: 'sp', kind: 'settle plate', frequency: 'daily', state: 'in operation', spec: { masterId: spec.masterId, testKey: 'sp', number: '', testName: '', method: '', limit: '' }, quantity: '1 plate', identify: 'on action' }] }] } });
  const hash = async (who: Person) => ((await (await who.page.request.get(`/api/master-versions/${p.id}/review`)).json()) as { contentHash: string }).contentHash;
  await author.post(`/api/master-versions/${p.id}/submit`, { proof: await author.proof('prepared'), contentHash: await hash(author) });
  await author.ctx.close();
  const checker = await person(browser, 'mcheck1');
  await checker.post(`/api/master-versions/${p.id}/pass`, { proof: await checker.proof('checked'), contentHash: await hash(checker) });
  await checker.ctx.close();

  // QA approves the plan on screen, with the change control; another QA person makes it effective.
  const qa = await person(browser, 'qa1');
  await emTab(qa, 'Plans');
  await qa.page.getByRole('table', { name: 'Plans' }).getByRole('row', { name: /EMP-B-001/ }).click();
  await expect(qa.page.locator('.d-title')).toContainText('In review');
  await expect(qa.page.locator('.plain-view')).toContainText('B101-SP1, Beside the filling line: B101 Aseptic filling room (grade B), a critical location.');
  await expect(qa.page.locator('.plain-view')).toContainText('Settle plate, daily, in operation, 1 plate: specification SPEC-EM-B, Settle plate (4 h) (NMT 5 CFU (alert above 3))');
  await expect(qa.page.getByLabel('Master check')).toContainText('No problems');
  await qa.page.screenshot({ path: test.info().outputPath('em-plan-review.png'), fullPage: true });
  await qa.page.getByRole('button', { name: 'Approve' }).click();
  await qa.page.getByLabel('Change control number').fill('CC-2026-071');
  await qa.page.getByRole('button', { name: 'Continue to sign' }).click();
  await sign(qa.page);
  await expect(qa.page.locator('.d-title')).toContainText('Approved');
  await qa.ctx.close();
  const qa2 = await person(browser, 'qa2');
  await emTab(qa2, 'Plans');
  await qa2.page.getByRole('table', { name: 'Plans' }).getByRole('row', { name: /EMP-B-001/ }).click();
  await qa2.page.getByRole('button', { name: 'Make effective' }).click();
  await qa2.page.getByRole('dialog').getByRole('button', { name: 'Make effective' }).click();
  await expect(qa2.page.locator('.d-title')).toContainText('Effective');
  await qa2.ctx.close();

  // The sampler takes the settle plate from "Due today": an ordinary sample of the room, purpose EM and water.
  const smp = await person(browser, 'smp1');
  await emTab(smp, 'Due today');
  const due = smp.page.getByRole('table', { name: 'Samplings due' });
  await expect(due.getByRole('row', { name: /B101-SP1/ })).toContainText('B101 Aseptic filling room (grade B)');
  await expect(due.getByRole('row', { name: /B101-SP1/ })).toContainText('Due');
  await smp.page.getByRole('button', { name: 'Take B101-SP1 settle plate in operation' }).click();
  await smp.page.getByRole('dialog', { name: 'Take the sampling' }).getByRole('button', { name: 'Take the sample' }).click();
  await expect(smp.page.getByRole('status')).toContainText(/Sample LS\d{7} taken/);
  const sampleNo = /LS\d{7}/.exec(await smp.page.getByRole('status').innerText())![0];
  await expect(due.getByRole('row', { name: /B101-SP1/ })).toContainText('Done');
  await smp.page.screenshot({ path: test.info().outputPath('em-due.png'), fullPage: true });
  await due.getByRole('button', { name: sampleNo }).click();
  const facts = smp.page.getByRole('region', { name: 'The sample' });
  await expect(facts).toContainText('EM and water');
  await expect(facts).toContainText('Plan EMP-B-001 version 1 · point B101-SP1 Beside the filling line · settle plate, in operation · grade B');
  await expect(smp.page.getByRole('heading', { level: 1 })).toContainText(sampleNo);
  const sampleId = ((await (await smp.page.request.get('/api/samples')).json()) as { id: number; sampleNo: string }[]).find((x) => x.sampleNo === sampleNo)!.id;

  // Received, incubated and counted: 7 CFU, signed and reviewed (API).
  await smp.post(`/api/samples/${sampleId}/receive`, { condition: 'Plate closed; incubated 30-35 °C then 20-25 °C' });
  const op = await person(browser, 'op1');
  const a = await op.post('/api/analyses', { masterVersionId: m.id, sampleId, proof: await op.proof('issued') });
  const step = (action: string, body: object = {}) => op.post(`/api/analyses/${a.id}/steps/0.1.0.1/${action}`, body);
  await step('start');
  await step('record', { values: { reading: '7' } });
  await step('note', { text: 'Over the action limit: excursion' });
  const sh = (await (await op.page.request.get(`/api/analyses/${a.id}`)).json() as { steps: { contentHash: string }[] }).steps[0]!.contentHash;
  await step('done', { proof: await op.proof('performed'), contentHash: sh });
  await op.ctx.close();
  const rev = await person(browser, 'rev1');
  const ah = (await (await rev.page.request.get(`/api/analyses/${a.id}`)).json() as { analysis: { contentHash: string } }).analysis.contentHash;
  await rev.post(`/api/analyses/${a.id}/review`, { proof: await rev.proof('reviewed'), contentHash: ah });
  await rev.ctx.close();

  // Over the action limit: the sampler opens the investigation with the deviation number (typed by hand).
  await smp.page.getByRole('button', { name: '← EM and water' }).click();
  await smp.page.getByRole('navigation', { name: 'EM and water' }).getByRole('button', { name: 'Excursions' }).click();
  const over = smp.page.getByRole('table', { name: 'Results over a limit' }).getByRole('row', { name: new RegExp(sampleNo) });
  await expect(over).toContainText('B101-SP1');
  await expect(over).toContainText('Action');
  await over.getByRole('button', { name: 'Open the investigation' }).click();
  await smp.page.getByRole('dialog', { name: 'Excursion' }).getByLabel('Deviation number').fill('DEV-26-301');
  await smp.page.getByRole('dialog', { name: 'Excursion' }).getByRole('button', { name: 'Record' }).click();
  await expect(smp.page.getByRole('heading', { level: 1 })).toContainText('Excursion at B101-SP1');
  const ex = smp.page.getByRole('region', { name: 'The excursion' });
  await expect(ex).toContainText('Deviation DEV-26-301 (typed by hand: Deviations not linked)');
  await expect(ex).toContainText('B101 Aseptic filling room');
  await expect(ex).toContainText('NMT 5 CFU (alert above 3)');
  await expect(smp.page.getByRole('heading', { level: 1 })).toContainText('deviation to check');
  await expect(ex).toContainText('You typed the deviation number: a second person checks it.');
  await smp.ctx.close();

  // A second person checks the number; the isolate is identified from the identification report.
  const smp2 = await person(browser, 'smp2');
  await emTab(smp2, 'Excursions');
  await smp2.page.getByRole('table', { name: 'Excursions' }).getByRole('row', { name: /B101-SP1/ }).click();
  await smp2.page.getByRole('button', { name: 'Check the deviation number (second person)' }).click();
  await expect(smp2.page.getByRole('heading', { level: 1 })).toContainText('isolates to identify');
  await smp2.page.getByRole('button', { name: 'Record an isolate' }).click();
  const iso = smp2.page.getByRole('dialog', { name: 'Record an isolate' });
  await iso.getByLabel('Genus').fill('Staphylococcus');
  await iso.getByLabel('Species').fill('epidermidis');
  await iso.getByLabel('Identification method').selectOption({ label: 'QC-M-EM1 Settle plate count' });
  await iso.getByLabel('Report number').fill('ID-26-014');
  await iso.getByRole('button', { name: 'Record' }).click();
  await expect(smp2.page.getByRole('heading', { level: 1 })).toContainText('open');
  await expect(smp2.page.getByRole('region', { name: 'Entries' })).toContainText('Staphylococcus epidermidis by QC-M-EM1 Settle plate count, report ID-26-014');
  await smp2.page.screenshot({ path: test.info().outputPath('em-excursion.png'), fullPage: true });

  // The EM map shows the point in red (action) with its latest result.
  await smp2.page.getByRole('button', { name: '← EM and water' }).click();
  await smp2.page.getByRole('navigation', { name: 'EM and water' }).getByRole('button', { name: 'EM map' }).click();
  const point = smp2.page.getByRole('button', { name: /Point B101-SP1/ });
  await expect(point).toHaveClass(/em-action/);
  await expect(point).toContainText('7 CFU');
  await smp2.page.screenshot({ path: test.info().outputPath('em-map.png'), fullPage: true });
  await smp2.ctx.close();

  // EU Annex 1 adverse trend: the first Staphylococcus epidermidis at B101 is a new organism; QC acknowledges it on the
  // Excursions tab with the reason.
  const qc = await person(browser, 'qc1');
  await emTab(qc, 'Excursions');
  const trends = qc.page.getByRole('table', { name: 'Adverse trends' });
  const flora = trends.getByRole('row', { name: /new organism/ });
  await expect(flora).toContainText('B101, B101-SP1: new organism Staphylococcus epidermidis (not identified at B101 in the 12 months before)');
  await flora.getByRole('textbox').fill('Skin flora: gowning retraining under DEV-26-301');
  await flora.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(flora).toContainText('Skin flora: gowning retraining under DEV-26-301');
  await expect(flora).toContainText('QC1');
  await qc.page.screenshot({ path: test.info().outputPath('em-adverse.png'), fullPage: true });
  await qc.ctx.close();
});
