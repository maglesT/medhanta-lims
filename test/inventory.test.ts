import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshApp, login, proofFor, seedUser, type TestApp, validatedOutside } from './helpers.js';
import { small } from './engine-fixture.js';

// The lab inventory through the API (server/routes/inventory.ts): items registered as received or prepared, their
// entries, a second person's checks, the pick list of usable items, the worksheet's item field (potency and factor
// pulled, never typed; an unusable item refused with why) and the usage log (LIMS-12, 13, 14, 34, 35).

let t: TestApp;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  t = await freshApp();
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    analyst: ['lims.analysis.perform'], analyst2: ['lims.analysis.perform', 'lims.analysis.review'], reviewer: ['lims.analysis.review'], viewer: ['lims.view'], sampler: ['lims.sample.register'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(() => t.close());

const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
async function register(kind: string, facts: object, parentIds: number[] = [], who = 'analyst') {
  const r = await as(who, 'POST', '/api/inventory', { kind, facts, parentIds });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { id: number; itemNo: string };
}
const entry = (who: string, id: number, action: string, body: object = {}) => as(who, 'POST', `/api/inventory/${id}/${action}`, body);
const item = async (id: number) => (await as('viewer', 'GET', `/api/inventory/${id}`)).json() as {
  item: { itemNo: string; facts: { passage?: number } }; status: { usable: boolean; why: string[]; values: Record<string, string> };
  parents: { itemNo: string }[]; children: { itemNo: string }[]; uses: { analysisNo: string; where: string; personName: string }[]; actions: string[];
};
const RS = { name: 'Examplol RS', source: 'USP', lot: 'R0A123', potency: '99.6', basis: 'as is', retestOn: day(200), storage: '2-8 °C' };

describe('registering and the entries', () => {
  it('LIMS-14 a primary standard is numbered by its kind; a working standard is qualified against it and checked by a second person', async () => {
    const rs = await register('reference', RS);
    expect(rs.itemNo).toMatch(/^RS\d{6}$/);
    expect((await item(rs.id)).status).toMatchObject({ usable: true, values: { potency: '99.6', basis: 'as is' } });
    // Without its primary: refused.
    const r = await as('analyst', 'POST', '/api/inventory', { kind: 'working', facts: { name: 'Examplol WS', lot: 'WS-26-01' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().problems).toEqual(['A working standard is qualified against one primary (reference) standard: pick it.']);
    const ws = await register('working', { name: 'Examplol WS', lot: 'WS-26-01' }, [rs.id]);
    expect(ws.itemNo).toMatch(/^WS\d{6}$/);
    expect((await item(ws.id)).status.why).toEqual(['not qualified against its primary standard']);
    expect((await entry('analyst', ws.id, 'qualify', { potency: '99.2', basis: 'as is', nextDue: day(90) })).statusCode).toBe(200);
    // The analyst cannot check (no review right); the reviewer who did not record it can.
    expect((await entry('analyst', ws.id, 'check')).statusCode).toBe(403);
    expect((await entry('reviewer', ws.id, 'check')).statusCode).toBe(200);
    const w = await item(ws.id);
    expect(w.status).toMatchObject({ usable: true, values: { potency: '99.2', basis: 'as is' } });
    expect(w.parents.map((p) => p.itemNo)).toEqual([rs.itemNo]);
    expect((await item(rs.id)).children.map((c) => c.itemNo)).toEqual([ws.itemNo]);
  });

  it('LIMS-41 the person who standardised a VS cannot check it', async () => {
    const vs = await register('vs', { name: '0.1 M Sodium hydroxide', molarity: '0.1 M', procedure: 'SOP-QC-021', expiry: day(60) });
    expect((await entry('analyst2', vs.id, 'standardise', { factor: '1.0021', nextDue: day(30), against: 'Potassium hydrogen phthalate RS' })).statusCode).toBe(200);
    const r = await entry('analyst2', vs.id, 'check');
    expect(r.statusCode).toBe(403);
    expect(r.json().problems).toEqual(['The person who recorded the entry cannot check it: a second person checks it.']);
    expect((await entry('reviewer', vs.id, 'check')).statusCode).toBe(200);
    expect((await entry('reviewer', vs.id, 'check')).json().problems).toEqual(['There is no entry waiting for a second person\'s check.']);
    expect((await item(vs.id)).status).toMatchObject({ usable: true, values: { factor: '1.0021' } });
  });

  it('LIMS-13 a solution is made only from usable items; an expired reagent is not one', async () => {
    const rg = await register('reagent', { name: 'Acetonitrile HPLC', supplier: 'Examplo Chemicals', lot: 'AC-7', expiry: day(1), useDays: 30 });
    expect((await entry('analyst', rg.id, 'block', { reason: 'Bottle seal broken' })).statusCode).toBe(200);
    const r = await as('analyst', 'POST', '/api/inventory', { kind: 'solution', facts: { name: 'Mobile phase A', procedure: 'QC-M-001', expiry: day(7) }, parentIds: [rg.id] });
    expect(r.statusCode).toBe(409);
    expect(r.json().problems[0]).toMatch(/cannot be used to make it: blocked: Bottle seal broken\.$/);
  });

  it('LIMS-34 LIMS-35 a medium waits for its growth promotion; a culture beyond passage 5 is refused', async () => {
    const md = await register('medium', { name: 'Soya-bean casein digest agar', lot: 'SCDA-0412', sterilisation: 'Autoclave AC-01, cycle 233', expiry: day(20) });
    expect((await item(md.id)).status.why).toEqual(['growth promotion not tested']);
    expect((await entry('analyst', md.id, 'growth-promotion', { passed: true, organisms: 'S. aureus, B. subtilis, P. aeruginosa' })).statusCode).toBe(200);
    expect((await entry('analyst2', md.id, 'check')).statusCode).toBe(200);
    expect((await item(md.id)).status.usable).toBe(true);
    let parent = await register('culture', { name: 'S. aureus', organism: 'Staphylococcus aureus', strain: 'ATCC 6538', expiry: day(30) });
    for (let p = 1; p <= 5; p++) parent = await register('culture', { name: `S. aureus passage ${p}`, organism: 'Staphylococcus aureus', strain: 'ATCC 6538', expiry: day(30) }, [parent.id]);
    expect((await item(parent.id)).item.facts.passage).toBe(5);
    const r = await as('analyst', 'POST', '/api/inventory', { kind: 'culture', facts: { name: 'S. aureus p6', organism: 'Staphylococcus aureus', strain: 'ATCC 6538', expiry: day(30) }, parentIds: [parent.id] });
    expect(r.statusCode).toBe(409);
    expect(r.json().problems[0]).toMatch(/at passage 5: a sub-culture would be passage 6/);
  });

  it('LIMS-43 a viewer cannot register or record entries', async () => {
    expect((await as('viewer', 'POST', '/api/inventory', { kind: 'column', facts: { name: 'C18', columnType: 'C18', serial: 'S' } })).statusCode).toBe(403);
    expect((await as('sampler', 'GET', '/api/inventory')).statusCode).toBe(403);
  });
});

// Three methods of one step each: the instrument run (its column from the inventory), the assay (its standard) and a
// titration (its VS); every value the method needs is written in it.
const STEPS = {
  run: { block: { id: 'instrument-run', version: 1 }, settings: { conditions: 'C18, 1.0 mL/min, 254 nm' } },
  assay: { block: { id: 'assay', version: 1 }, checker: true, settings: { mode: 'external standard', response: 'peak area', responseUnit: '', stdMass: '50.00 mg', stdVolume: '100 mL',
    preparations: '1', sample1Mass: '50.00 mg', sampleVolume: '100 mL', per: 'mass', limit: { low: '98.0', high: '102.0', unit: '%' } } },
  tit: { block: { id: 'titration', version: 1 }, checker: true, settings: { mode: 'direct', titrant: '0.1 M sodium hydroxide', titrantMolarity: '0.1 M',
    equivalence: '10.00 mg', equivalenceMolarity: '0.1 M', preparations: '1', sample1Mass: '500.0 mg', limit: { low: '98.0', high: '102.0', unit: '%' } } },
};
const hash = async (id: number, who: string) => ((await as(who, 'GET', `/api/master-versions/${id}/review`)).json() as { contentHash: string }).contentHash;
/** An analysis of a one-step method with this step. */
async function analysisOf(key: keyof typeof STEPS) {
  const doc = small([{ role: 'Analyst', roomTypes: ['QC laboratory'], ...(key === 'run' ? { machineTypes: ['hplc'] } : {}), steps: [{ key, ...STEPS[key] }] }]);
  const r = await as('author', 'POST', '/api/masters', { kind: 'method', doc: { ...doc, header: { ...doc.header, code: `M-${key}` } } });
  expect(r.statusCode, r.body).toBe(200);
  const v = r.json() as { id: number };
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-001' }]] as const) {
    const res = await as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hash(v.id, who), ...x });
    expect(res.statusCode, `${a}: ${res.body}`).toBe(200);
  }
  await validatedOutside(t.owner, v.id);
  expect((await as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {})).statusCode).toBe(200);
  const a = await as('analyst', 'POST', '/api/analyses', { masterVersionId: v.id, proof: proofFor('analyst') });
  expect(a.statusCode, a.body).toBe(200);
  return (a.json() as { id: number }).id;
}

describe('the worksheet takes items from the inventory', () => {
  const analyses = { run: 0, assay: 0, tit: 0 };
  let ws = { id: 0, itemNo: '' };
  let vs = { id: 0, itemNo: '' };
  let col = { id: 0, itemNo: '' };
  let old = { id: 0, itemNo: '' };
  beforeAll(async () => {
    for (const k of ['run', 'assay', 'tit'] as const) analyses[k] = await analysisOf(k);
    const rs = await register('reference', { ...RS, name: 'Examplol RS 2' });
    ws = await register('working', { name: 'Examplol WS 2', lot: 'WS-26-02' }, [rs.id]);
    await entry('analyst', ws.id, 'qualify', { potency: '99.4', basis: 'as is', nextDue: day(90) });
    await entry('reviewer', ws.id, 'check');
    vs = await register('vs', { name: '0.1 M Sodium hydroxide', molarity: '0.1 M', procedure: 'SOP-QC-021', expiry: day(60) });
    await entry('analyst', vs.id, 'standardise', { factor: '0.9985', nextDue: day(30) });
    await entry('reviewer', vs.id, 'check');
    col = await register('column', { name: 'C18 250 x 4.6 mm, 5 µm', columnType: 'C18 250 x 4.6 mm, 5 µm', serial: 'SN-0091' });
    old = await register('vs', { name: '0.1 M Hydrochloric acid', molarity: '0.1 M', procedure: 'SOP-QC-022', expiry: day(60) });
  });
  const KEY = '0.1.0.1';
  const step = (of: keyof typeof analyses, action: string, body: object = {}) => as('analyst', 'POST', `/api/analyses/${analyses[of]}/steps/${KEY}/${action}`, body);
  const values = async (of: keyof typeof analyses) => ((await as('analyst', 'GET', `/api/analyses/${analyses[of]}`)).json() as { steps: { id: string; values: Record<string, unknown>; source: Record<string, { from: string; shown: string }>; results: Record<string, { ok: boolean; value?: string }> }[] }).steps[0]!;

  it('LIMS-13 the pick list offers only usable items of the field\'s kinds, and names those left out with why', async () => {
    const p = (await as('analyst', 'GET', '/api/inventory/picks?kinds=vs')).json() as { items: { code: string; itemId: string }[]; leftOut: { code: string; why: string[] }[] };
    expect(p.items.map((i) => i.code)).toContain(vs.itemNo);
    expect(p.items.map((i) => i.code)).not.toContain(old.itemNo);
    expect(p.leftOut.find((x) => x.code === old.itemNo)?.why).toEqual(['not standardised']);
  });

  it('LIMS-14 the assay\'s standard potency and basis come with the working standard, and cannot be typed', async () => {
    expect((await step('assay', 'start')).statusCode).toBe(200);
    // Typed before or after picking: refused.
    const typed = await step('assay', 'record', { values: { stdPotency: '100.0' } });
    expect(typed.statusCode).toBe(400);
    expect(typed.json().problems).toEqual(['Standard: potency (from the inventory) comes from the QLIMS inventory with the reference or working standard used and cannot be typed']);
    const r = await step('assay', 'record', { values: { std: `lab:${ws.id}`, stdResponses: ['1000000'], responses1: ['995000'] } });
    expect(r.statusCode, r.body).toBe(200);
    const s = await values('assay');
    expect(s.values.std).toMatchObject({ itemId: `lab:${ws.id}`, code: ws.itemNo });
    expect(s.values.stdPotency).toEqual({ value: '99.4', unit: '%' });
    expect(s.values.stdBasis).toBe('as is');
    expect(s.source.stdPotency).toMatchObject({ from: 'inventory', shown: `potency 99.4 % of ${ws.itemNo} (as is)` });
    // 995000 ÷ 1000000 × 50.00 mg × 99.4 % = 49.4515 mg in the same volume as 50.00 mg of sample: 98.903 %.
    expect(Number(s.results.result!.value)).toBeCloseTo(98.903, 3);
    expect((await step('assay', 'record', { values: { stdPotency: '100.0' } })).statusCode).toBe(400);
  });

  it('LIMS-13 the titration\'s VS factor comes with the VS; a VS not standardised is refused with why', async () => {
    expect((await step('tit', 'start')).statusCode).toBe(200);
    const no = await step('tit', 'record', { values: { vs: `lab:${old.id}` } });
    expect(no.statusCode).toBe(400);
    expect(no.json().problems).toEqual([`${old.itemNo} 0.1 M Hydrochloric acid cannot be used: not standardised.`]);
    const wrong = await step('tit', 'record', { values: { vs: `lab:${ws.id}` } });
    expect(wrong.json().problems[0]).toMatch(/is a working standard; pick a volumetric solution/);
    expect((await step('tit', 'record', { values: { vs: `lab:${vs.id}`, titre1: '49.60' } })).statusCode).toBe(200);
    const s = await values('tit');
    expect(s.values.vsFactor).toBe('0.9985');
    expect(s.source.vsFactor?.from).toBe('inventory');
    expect(s.results.prep1?.ok).toBe(true);
  });

  it('LIMS-12 LIMS-14 a column named by the run counts a use; each item lists the analysis steps that used it (look-back)', async () => {
    expect((await step('run', 'start')).statusCode).toBe(200);
    expect((await step('run', 'record', { values: { column: `lab:${col.id}` } })).statusCode).toBe(200);
    const c = await item(col.id);
    expect(c.uses).toHaveLength(1);
    expect(c.uses[0]).toMatchObject({ where: 'Stage 0 › Instrument run', analysisNo: expect.stringMatching(/^LA/), personName: 'ANALYST' });
    const w = await item(ws.id);
    expect(w.uses.map((u) => u.where)).toEqual(['Stage 0 › Assay by external standard']);
    // Retired, it is no longer offered and is refused.
    expect((await entry('analyst', col.id, 'dispose', { reason: 'Plates below 2000' })).statusCode).toBe(200);
    expect((await as('analyst', 'GET', '/api/inventory/picks?kinds=column')).json().items.map((i: { code: string }) => i.code)).not.toContain(col.itemNo);
    const r = await step('run', 'record', { values: { column: `lab:${col.id}` } });
    expect(r.json().problems[0]).toMatch(/cannot be used: retired on/);
  });
});
