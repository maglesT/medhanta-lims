import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBlock } from '../shared/blocks/index.js';
import { doneProblems, evaluate, openSteps, timers, type StepEvent, type Value } from '../shared/engine/index.js';
import { masterChecks } from '../shared/master/checks.js';
import { masterSchema, type MasterDoc } from '../shared/master/schema.js';
import { specSchema, type SpecDoc } from '../shared/master/spec.js';
import { OOS_CHECKLIST } from '../shared/engine/oos.js';
import { at, ev, unplaced } from './engine-fixture.js';
import { call, freshApp, handLabels, login, proofFor, seedUser, type TestApp, validatedOutside } from './helpers.js';

// The microbiology blocks run by the engine (invented demo numbers; the arithmetic in the comments), and a sterility
// test with growth through the API: it opens an OOS, which is invalidated only through the OOS path of step 4 (an
// assignable laboratory cause in phase I, reviewed, and QA's signature with lims.oos.approve; LIMS-38).

type Settings = Record<string, unknown>;
const q = (value: string, unit = '') => ({ value, unit });
const list = (text: string, unit: string) => text.split(' ').map((v) => q(v, unit));
const step = (key: string, id: string, settings: Settings) => ({ key, block: { id, version: 1 }, checker: findBlock({ id, version: 1 })!.checker, settings });
function method(steps: ReturnType<typeof step>[], over: object = {}): MasterDoc {
  return masterSchema.parse({
    header: { code: 'QC-M-700', name: 'Microbiology worked example', technique: 'Microbiology', reference: 'Ph.Int 3.3.1 style example' },
    stages: [{ key: 'm', name: 'Microbiology', kind: 'normal', role: 'Microbiologist', machineTypes: ['incubator'], ...over, steps }],
  });
}
const results = (doc: MasterDoc, key: string, values: Record<string, Value>, events: StepEvent[] = []) =>
  evaluate(doc, events, { stage: 0, sub: 1, step: doc.stages[0]!.steps.findIndex((t) => t.key === key), round: 1 }, values);
const problems = (doc: MasterDoc) => unplaced(masterChecks(doc)).map((p) => `${p.path}: ${p.message}`);

const incubator = { itemId: 'eq-inc', code: 'INC-01', name: 'Incubator 30-35 °C', version: 1, type: 'Incubator', room: 'MIC-01', area: 'Microbiology laboratory' };
const INCUBATE = { what: 'TAMC plates (casein soya bean digest agar)', atmosphere: 'aerobic', temperatureLimit: { low: '30', high: '35', unit: '°C' }, timeLimit: { low: '72', high: '120', unit: 'h' } };
// TAMC by pour plate: 10 g in 100 mL (1 in 10), 1 mL plated at 1 in 10 and 1 in 100, duplicate plates; 10^3 CFU/g
// with an alert level of 500 CFU/g (an in-house alert inside the action limit).
const TAMC = { method: 'plate count', dilution1: '10', dilution2: '100', amount: '1 mL', per: 'CFU/g', countable: 'TAMC: fewer than 250 per plate', acceptance: '10^n',
  limit: { high: '1000', unit: 'CFU/g', alertHigh: '500' } };

describe('the microbiology blocks through the engine', () => {
  it('a microbial limits method (incubate, count) passes the method check; the counts wait for the plates', () => {
    const doc = method([step('incubate', 'incubate', INCUBATE), step('tamc', 'count', TAMC)]);
    expect(problems(doc)).toEqual([]);
    expect(results(doc, 'tamc', {})).toEqual({});
  });

  it('incubate: the incubation time is a T13 duration whose lower bound is a minimum wait; the temperature range is checked', () => {
    const doc = method([step('incubate', 'incubate', INCUBATE)]);
    const values = { medium: 'lab:1', incubator, start: `${at(0).toISOString().slice(0, 19)}Z` };
    const events = [ev('started', '0.1.0.1', { min: 0 }), ev('value', '0.1.0.1', { min: 0, payload: { values, results: results(doc, 'incubate', values) } })];
    // 72 h from the start: a running wait.
    expect(timers(doc, events, at(60))).toMatchObject([{ kind: 'duration', state: 'running', at: at(72 * 60) }]);
    // Ended after 48 h: too short (the check fails, a deviation note is needed); 31.0 to 36.0 °C: the high one is out.
    const early = results(doc, 'incubate', { ...values, end: `${at(48 * 60).toISOString().slice(0, 19)}Z`, temperatureLow: q('31.0', '°C'), temperatureHigh: q('36.0', '°C'), reading: 'ready to count' });
    expect(early.duration).toMatchObject({ ok: true, check: { pass: false } });
    expect(early.temperatureHighCheck).toMatchObject({ ok: true, check: { pass: false } });
    const right = results(doc, 'incubate', { ...values, end: `${at(96 * 60).toISOString().slice(0, 19)}Z`, temperatureLow: q('31.0', '°C'), temperatureHigh: q('34.5', '°C'), reading: 'ready to count' });
    expect([right.duration, right.temperatureLowCheck, right.temperatureHighCheck].map((r) => r?.ok && r.check?.pass)).toEqual([true, true, true]);
  });

  it('count: plates counted per dilution → L11; within the action limit, at the alert level, above it', () => {
    const doc = method([step('tamc', 'count', TAMC)]);
    const plates = (a: string, b: string) => ({ plates1: list(a, 'CFU'), plates2: list(b, 'CFU'), negativeControl: 'no growth' });
    // 1 in 10: 45 and 52, mean 48.5 × 10 ÷ 1 mL = 485 CFU/g: within (alert 500).
    expect(results(doc, 'tamc', plates('45 52', '5 3')).result).toMatchObject({ ok: true, value: '485', unit: 'CFU/g', check: { pass: true, level: 'pass' } });
    // 1 in 10: 61 and 63 = 620 CFU/g: above the alert level 500, within NMT 2000 (10^3): ALERT.
    expect(results(doc, 'tamc', plates('61 63', '6 7')).result).toMatchObject({ ok: true, value: '620', check: { pass: true, level: 'alert' } });
    // 1 in 10 TNTC (one plate 260); 1 in 100: 230 and 242, mean 236 × 100 = 23600 CFU/g: above 2000: fails.
    expect(results(doc, 'tamc', { plates1: list('260 248', 'CFU'), plates2: list('230 242', 'CFU'), negativeControl: 'no growth' }).result)
      .toMatchObject({ ok: true, value: '23600', check: { pass: false, level: 'fail' } });
    // None at the lowest dilution: less than 10 CFU/g.
    expect(results(doc, 'tamc', plates('0 0', '0 0')).result).toMatchObject({ ok: true, value: '10', qualifier: '<', check: { pass: true } });
    // Growth on the negative control: no result (not valid).
    expect(results(doc, 'tamc', { ...plates('45 52', '5 3'), negativeControl: 'growth' }).result).toMatchObject({ ok: false, message: expect.stringMatching(/negative control shows growth/) });
    // The MPN method: 3-1-0 tubes = 43 CFU/g.
    const { dilution2: _d2, ...mpnSettings } = TAMC;
    const mpn = method([step('mpn', 'count', { ...mpnSettings, method: 'MPN', dilution1: '1' })]);
    expect(results(mpn, 'mpn', { tubes1: q('3', 'units'), tubes2: q('1', 'units'), tubes3: q('0', 'units'), negativeControl: 'no growth' }).result).toMatchObject({ ok: true, value: '43' });
  });

  it('LIMS-01 a count limit in a unit of another kind (CFU/mL on a count per g) is refused by the method check', () => {
    const doc = method([step('tamc', 'count', { ...TAMC, limit: { high: '1000', unit: 'CFU/mL' } })]);
    expect(problems(doc).join('\n')).toMatch(/every reading would be refused/);
  });

  it('bioburden: the count × the recovery factor of the validated method, against the limit as written', () => {
    const doc = method([step('bb', 'bioburden', { technique: 'membrane filtration', dilution1: '1', amount: '100 mL', per: 'CFU/mL', countable: 'membrane: up to 100',
      acceptance: 'as written', recoveryFactor: '1.25', limit: { high: '0.1', unit: 'CFU/mL' } })]);
    expect(problems(doc)).toEqual([]);
    // 6 and 8 colonies on 100 mL filtered: 7 × 1 × 1.25 ÷ 100 mL = 0.0875 CFU/mL, rounded to 0.1: within NMT 0.1.
    const r = results(doc, 'bb', { medium: 'lab:2', plates1: list('6 8', 'CFU'), negativeControl: 'no growth' }).result;
    expect(r).toMatchObject({ ok: true, value: '0.0875', unit: 'CFU/mL', check: { pass: true } });
  });

  it('LIMS-38 sterility test: containers against the sterility table; no growth conforms, growth fails the result check (an OOS when signed)', () => {
    const doc = method([step('st', 'sterility-test', { method: 'membrane filtration', productType: 'parenteral', bothMedia: 'no',
      ftmTemperatureLimit: { low: '30', high: '35', unit: '°C' }, scdmTemperatureLimit: { low: '20', high: '25', unit: '°C' }, incubationTime: { low: '14', unit: 'd' } })]);
    expect(problems(doc)).toEqual([]);
    const t = (d: number) => `${at(d * 24 * 60).toISOString().slice(0, 19)}Z`;
    const media = (m: string, result: string) => ({ [`${m}Medium`]: 'lab:3', [`${m}Incubator`]: incubator, [`${m}Start`]: t(0), [`${m}End`]: t(14), [`${m}Readings`]: list('0 0 0 0 0', 'units'),
      [`${m}TemperatureLow`]: q(m === 'ftm' ? '31.5' : '21.5', '°C'), [`${m}TemperatureHigh`]: q(m === 'ftm' ? '33.0' : '23.0', '°C'), [`${m}Result`]: result, [`${m}Negative`]: 'no growth' });
    // Batch of 3000 vials: 2 % or 20, whichever is less = 20 per medium, × 2 (one vial cannot do both) = 40.
    const clean = results(doc, 'st', { batchSize: q('3000', 'units'), containers: q('40', 'units'), ...media('ftm', 'no growth'), ...media('scdm', 'no growth') });
    expect(clean.required).toMatchObject({ ok: true, value: '40', check: { pass: true } });
    expect(clean.ftmDuration).toMatchObject({ ok: true, check: { pass: true } });
    expect(clean.result).toMatchObject({ ok: true, value: '0', check: { pass: true } });
    const growth = results(doc, 'st', { batchSize: q('3000', 'units'), containers: q('20', 'units'), ...media('ftm', 'growth'), ...media('scdm', 'no growth') });
    expect(growth.required).toMatchObject({ ok: true, check: { pass: false } });
    expect(growth.result).toMatchObject({ ok: true, value: '1', check: { pass: false } });
    // The growth (and the too few containers) need a deviation note before the step is signed; then the server opens the OOS.
    const values = { batchSize: q('3000', 'units'), containers: q('40', 'units'), ...media('ftm', 'growth'), ...media('scdm', 'no growth') };
    const events = [ev('started', '0.1.0.1', { min: 0 }), ev('value', '0.1.0.1', { min: 1, payload: { values, results: results(doc, 'st', values) } })];
    const later = at(15 * 24 * 60);
    expect(doneProblems(doc, openSteps(doc, events, later).steps[0]!, later)).toEqual(['Out of limits: Sterility. Add a deviation note first.']);
  });

  it('LIMS-38 endotoxin, kinetic: MVD, |r|, spike recovery; the result less than the limit', () => {
    const doc = method([step('bet', 'endotoxin', { mode: 'photometric', response: 'onset time', responseUnit: 's', std1: '0.005 EU/mL', std2: '0.05 EU/mL', std3: '0.5 EU/mL', std4: '5 EU/mL',
      spike: '0.05 EU/mL', concentration: '10 mg/mL', dilution: '100', limit: { high: '0.25', unit: 'EU/mg' } })], { machineTypes: ['endotoxin reader'] });
    expect(problems(doc)).toEqual([]);
    const reader = { ...incubator, itemId: 'eq-bet', code: 'BET-01', type: 'Endotoxin reader' };
    const values = { lysate: 'lab:4', reader, stdResponses1: list('3761 3740', 's'), stdResponses2: list('2115 2130', 's'), stdResponses3: list('1189 1180', 's'), stdResponses4: list('669 672', 's'),
      sampleResponses: list('2659 2650', 's'), spikedResponses: list('1945 1940', 's'), negativeControl: 'yes' };
    // As the template test: 0.020073 EU/mL × 100 ÷ 10 mg/mL = 0.2007 EU/mg, less than 0.25: complies.
    const r = results(doc, 'bet', values).result;
    expect(r).toMatchObject({ ok: true, unit: 'EU/mg', check: { pass: true } });
    expect(r?.ok && Number(r.value).toFixed(4)).toBe('0.2007');
    // Gel clot limit test of the same product at 1 in 4 (MVD 0.25 × 10 ÷ 0.125 = 20).
    const gel = method([step('bet', 'endotoxin', { mode: 'gel clot limit', concentration: '10 mg/mL', dilution: '4', limit: { high: '0.25', unit: 'EU/mg' } })], { machineTypes: ['heating block'] });
    const pm = { lysate: 'lab:4', reader: { ...reader, type: 'Heating block' }, lambda: q('0.125', 'EU/mL'), b1: '+', b2: '+', c1: '+', c2: '+', d1: '−', d2: '−' };
    expect(results(gel, 'bet', { ...pm, a1: '−', a2: '−' }).result).toMatchObject({ ok: true, qualifier: '<', check: { pass: true } });
    expect(results(gel, 'bet', { ...pm, a1: '+', a2: '+' }).result).toMatchObject({ ok: true, check: { pass: false } });
  });

  it('microbial assay: 3 + 3 doses, zone diameters → potency with fiducial limits', () => {
    const doc = method([step('mic', 'microbial-assay', { design: 'completely randomised', responseUnit: 'mm', stdDose1: '1 IU/mL', stdDose2: '2 IU/mL', stdDose3: '4 IU/mL',
      testDose1: '1 IU/mL', testDose2: '2 IU/mL', testDose3: '4 IU/mL', assumedPotency: '1000 IU/mg', checkOn: 'lower fiducial limit', limit: { low: '900', high: '1100', unit: 'IU/mg' } })]);
    expect(problems(doc)).toEqual([]);
    const r = results(doc, 'mic', { culture: 'lab:5', medium: 'lab:6', s1: list('15.8 16.0 15.9 16.1', 'mm'), s2: list('18.0 18.2 17.9 18.1', 'mm'), s3: list('20.1 20.3 20.0 20.2', 'mm'),
      t1: list('16.2 16.4 16.1 16.3', 'mm'), t2: list('18.3 18.5 18.4 18.2', 'mm'), t3: list('20.6 20.4 20.5 20.7', 'mm') }).result;
    expect(r).toMatchObject({ ok: true, unit: 'IU/mg', check: { pass: true } });
    expect(r?.ok && Number(r.value).toFixed(1)).toBe('1114.9');
  });
});

// ---- On the server: a sterility test with growth opens an OOS; invalidated only through the step 4 path ----
let t: TestApp;
const cookies: Record<string, string> = {};
const MAT = '00000000-0000-0000-0000-0000000000a7';
const as = (who: string, m: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, m as 'GET', url, body);
const ok = async <R extends { statusCode: number; body: string }>(r: Promise<R>): Promise<R> => { const x = await r; expect(x.statusCode, x.body).toBe(200); return x; };
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

beforeAll(async () => {
  t = await freshApp();
  t.master.materials_.push({ itemId: MAT, code: 'FP-700', name: 'Demoxine injection', version: 1, active: true, category: 'Finished product', unit: 'vials' });
  t.master.rooms_.push({ itemId: 'rm-mic', code: 'MIC-01', name: 'Microbiology laboratory 1', version: 1, active: true, area: 'Microbiology laboratory', grade: 'B' });
  t.master.equipment_.push({ itemId: 'eq-inc1', code: 'INC-01', name: 'Incubator 30-35 °C', version: 1, active: true, kind: 'equipment', type: 'incubator', room: 'MIC-01' },
    { itemId: 'eq-inc2', code: 'INC-02', name: 'Incubator 20-25 °C', version: 1, active: true, kind: 'equipment', type: 'incubator', room: 'MIC-01' });
  const people = { author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    sampler: ['lims.sample.register', 'lims.view'], sampler2: ['lims.sample.register'], micro: ['lims.analysis.perform', 'lims.view'], micro2: ['lims.analysis.perform', 'lims.analysis.check', 'lims.analysis.review'],
    supervisor: ['lims.analysis.review'], qalead: ['lims.oos.approve'] } as const;
  for (const [name, perms] of Object.entries(people)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(async () => { await t.close(); });

async function effective(kind: 'method' | 'spec', doc: object) {
  const v = (await ok(as('author', 'POST', '/api/masters', { kind, doc }))).json() as { id: number; masterId: number };
  const hash = async (who: string) => ((await as(who, 'GET', `/api/master-versions/${v.id}/review`)).json() as { contentHash: string }).contentHash;
  for (const [who, a, x] of [['author', 'submit', {}], ['checker', 'pass', {}], ['quality', 'approve', { changeControl: 'CC-2026-070' }]] as const) {
    await ok(as(who, 'POST', `/api/master-versions/${v.id}/${a}`, { proof: proofFor(who), contentHash: await hash(who), ...x }));
  }
  await validatedOutside(t.owner, v.id);
  await ok(as('quality2', 'POST', `/api/master-versions/${v.id}/make-effective`, {}));
  return v;
}
const sterilityMethod = () => method([step('st', 'sterility-test', { method: 'membrane filtration', productType: 'parenteral', bothMedia: 'no',
  ftmTemperatureLimit: { low: '30', high: '35', unit: '°C' }, scdmTemperatureLimit: { low: '20', high: '25', unit: '°C' }, incubationTime: { low: '14', unit: 'd' } })],
{ roomTypes: ['Microbiology laboratory'] });
const sterilitySpec = (m: number): SpecDoc => specSchema.parse({
  header: { of: 'material', itemId: MAT, code: 'FP-700', name: 'Demoxine injection', type: 'Finished product', number: 'SPEC-FP-700', pharmacopoeia: 'Ph. Int.' },
  tests: [{ key: 'sterility', name: 'Sterility', method: { masterId: m, code: 'QC-M-700', name: 'Sterility' }, result: 'm/st/result', limitType: 'conforms', conforms: 'No growth in FTM or SCDM (sterile)' }],
});

async function medium(name: string) {
  const r = (await ok(as('micro', 'POST', '/api/inventory', { kind: 'medium', facts: { name, lot: `${name.slice(0, 4).toUpperCase()}-0412`, sterilisation: 'Autoclave AC-01, cycle 233', expiry: day(20) } }))).json() as { id: number };
  await ok(as('micro', 'POST', `/api/inventory/${r.id}/growth-promotion`, { passed: true, organisms: 'S. aureus, P. aeruginosa, B. subtilis, C. sporogenes, C. albicans, A. brasiliensis' }));
  await ok(as('micro2', 'POST', `/api/inventory/${r.id}/check`, {}));
  return `lab:${r.id}`;
}

describe('LIMS-38 a positive sterility test on the server', () => {
  it('LIMS-38 growth opens an OOS when the step is signed; QA invalidates it only after phase I found a laboratory cause and was reviewed', async () => {
    const m = await effective('method', sterilityMethod());
    const spec = await effective('spec', sterilitySpec(m.masterId));
    const s = (await ok(as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: 'FP-700-26-01', byHand: true, itemId: MAT, specVersionId: spec.id, quantity: '40 vials', purpose: 'release' }))).json() as { id: number };
    await ok(as('sampler2', 'POST', `/api/samples/${s.id}/check`, {}));
    await ok(as('sampler', 'POST', `/api/samples/${s.id}/receive`, { condition: 'Sealed, 2-8 °C' }));
    const a = (await ok(as('micro', 'POST', '/api/analyses', { masterVersionId: m.id, sampleId: s.id, proof: proofFor('micro') }))).json() as { id: number };
    const key = '0.1.0.1';
    const act = (who: string, action: string, body: object = {}) => as(who, 'POST', `/api/analyses/${a.id}/steps/${key}/${action}`, body);
    const stepNow = async (who = 'micro') => ((await as(who, 'GET', `/api/analyses/${a.id}`)).json() as { steps: { id: string; contentHash: string; results: Record<string, { check?: { pass: boolean } }>; handFields: { name: string }[] }[] }).steps.find((x) => x.id === key)!;
    await ok(act('micro', 'start'));
    const [ftm, scdm] = [await medium('Fluid thioglycollate medium'), await medium('Soya-bean casein digest medium')];
    // The incubators are recorded by hand (no Logbook link here): their label questions are answered and a second person checks.
    const media = { ftmMedium: ftm, scdmMedium: scdm, ftmIncubator: 'eq-inc1', scdmIncubator: 'eq-inc2', ...handLabels('ftmIncubator', 'machine'), ...handLabels('scdmIncubator', 'machine') };
    await ok(act('micro', 'record', { values: { batchSize: '3000', containers: '40', ...media, ftmStart: 'now', scdmStart: 'now' } }));
    await ok(act('micro', 'record', { values: { ftmReadings: ['0', '0', '1'], scdmReadings: ['0', '0', '0'], ftmEnd: 'now', scdmEnd: 'now', ftmTemperatureLow: '31.5', ftmTemperatureHigh: '33.0',
      scdmTemperatureLow: '21.5', scdmTemperatureHigh: '23.0', ftmResult: 'growth', scdmResult: 'no growth', ftmNegative: 'no growth', scdmNegative: 'no growth', organism: 'Staphylococcus epidermidis (Gram-positive coccus)' } }));
    const st = await stepNow();
    expect(st.results.result?.check?.pass).toBe(false);
    await ok(act('micro', 'note', { text: 'Growth in one FTM canister on day 3: OOS. Incubation ended early for this test record.' }));
    await ok(act('micro', 'done', { proof: proofFor('micro'), contentHash: (await stepNow()).contentHash }));
    await ok(act('micro2', 'check', { proof: proofFor('micro2'), contentHash: (await stepNow('micro2')).contentHash }));
    // The OOS is open at once, for the sterility test.
    const oos = ((await as('micro', 'GET', `/api/samples/${s.id}`)).json() as { oos: { id: number; oosNo: string; status: string }[] }).oos;
    expect(oos).toMatchObject([{ oosNo: expect.stringMatching(/^OOS\d{6}$/), status: 'open' }]);
    const id = oos[0]!.id;
    const get = async (who = 'micro') => (await as(who, 'GET', `/api/oos/${id}`)).json() as { status: string; contentHash: string; oos: { result: { limit: string } } };
    expect((await get()).oos.result.limit).toBe('Conforms: No growth in FTM or SCDM (sterile)');
    const conclude = async (who: string, body: object) => as(who, 'POST', `/api/oos/${id}/conclude`, { ...body, proof: proofFor(who), contentHash: (await get(who)).contentHash });
    // QA cannot invalidate a phase I that is not concluded and reviewed.
    expect((await conclude('qalead', { outcome: 'invalidated', reason: 'Probable contamination', retests: 1 })).statusCode).toBe(409);
    const all = Object.fromEntries(OOS_CHECKLIST.map(([k]) => [k, { yes: true }]));
    await ok(as('micro', 'POST', `/api/oos/${id}/checklist`, { answers: { ...all, equipment: { yes: false, comment: 'EM of the isolator during the test: glove print 3 CFU, same organism as found in the FTM canister' } } }));
    await ok(as('micro', 'POST', `/api/oos/${id}/conclude-phase1`, { labError: true, cause: 'Isolator glove contamination during the test (EM glove print, same organism)' }));
    // The supervisor reviews phase I (signature "reviewed"); only then QA, with lims.oos.approve, invalidates it.
    expect((await conclude('supervisor', { outcome: 'invalidated', reason: 'x' })).statusCode).toBe(401);
    await ok(as('supervisor', 'POST', `/api/oos/${id}/review`, { proof: proofFor('supervisor'), contentHash: (await get('supervisor')).contentHash }));
    expect((await get()).status).toBe('QA approval');
    await ok(conclude('qalead', { outcome: 'invalidated', reason: 'Laboratory cause proven: isolator glove contamination, organism identical (identification report MIC-ID-26-014)', retests: 1 }));
    expect((await get()).status).toBe('invalidated');
    const an = (await as('micro', 'GET', `/api/analyses/${a.id}`)).json() as { analysis: { status: string } };
    expect(an.analysis.status).toBe('invalidated');
  });
});
