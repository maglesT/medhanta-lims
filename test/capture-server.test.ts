import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { analysisRecordDoc } from '../server/analysis-record.js';
import { loadAnalysis, recordInput } from '../server/routes/analyses.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';
import { small } from './engine-fixture.js';

// Instrument data capture through the step routes (LIMS-32, LIMS-33, LIMS-49, LIMS-50; plan 2.8, question 3): a value
// read from the step's machine is the server's own parse of the raw line; a CDS result file fills the chromatography
// fields with its hash and run; typed instead, a value is marked typed and checked by a second person; the reviewer and
// the PDF show what was captured, imported and typed (LIMS-19).

let t: TestApp;
let provider: Sql;
const S = { lb: '', ql: '' };
const cookies: Record<string, string> = {};
const MACHINES = [['eq-bal', 'BAL-01', 'Analytical balance', 'balance'], ['eq-bal2', 'BAL-02', 'Analytical balance', 'balance'],
  ['eq-ph', 'PH-01', 'pH meter', 'ph meter'], ['eq-hplc', 'HPLC-01', 'HPLC system', 'hplc']] as const;

beforeAll(async () => {
  t = await freshApp(async (db) => {
    S.lb = `${db.schema}_lb`;
    S.ql = `${db.schema}_ql`;
    const rows = (f: (m: (typeof MACHINES)[number], i: number) => string) => MACHINES.map(f).join(', ');
    await db.owner.unsafe(`
      create schema ${S.lb}; create schema ${S.ql};
      create table ${S.lb}.equipment_status_v1 (master_id text, code text, kind text, state text, fit_for_use boolean, blockers text[], warnings text[],
        in_use_batch text, clean_until timestamptz, cleaned_at timestamptz, cleaned_by text, calibration_due date, qualification text,
        checked_at timestamptz default now(), read_at timestamptz default now(), data_as_of timestamptz default now());
      create table ${S.ql}.qualification_v1 (item_id bigint, master_id text, code text, name text, kind text, status text, next_review_due date,
        status_since timestamptz default now(), status_source text, read_at timestamptz default now(), data_as_of timestamptz default now());
      grant usage on schema ${S.lb}, ${S.ql} to lims_app;
      grant select on all tables in schema ${S.lb}, ${S.ql} to lims_app;
      insert into ${S.lb}.equipment_status_v1 (master_id, code, kind, state, fit_for_use, blockers, warnings) values
        ${rows(([id, code]) => `('${id}', '${code}', 'instrument', 'clean', true, '{}', '{}')`)};
      insert into ${S.ql}.qualification_v1 (item_id, master_id, code, name, kind, status, next_review_due) values
        ${rows(([id, code, name], i) => `(${i + 1}, '${id}', '${code}', '${name}', 'equipment', 'qualified', '2099-12-31')`)};`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ logbook: provider, qual: provider }, { logbook: S.lb, qual: S.ql });
  });
  t.master.equipment_.push(...MACHINES.map(([itemId, code, name, type]) => ({ itemId, code, name, version: 1, active: true, kind: 'instrument' as const, type, room: 'QCL-01' })));
  t.master.rooms_.push({ itemId: 'rm-1', code: 'QCL-01', name: 'QC laboratory 1', version: 1, active: true, area: 'QC laboratory', grade: 'D' });
  for (const [name, perms] of Object.entries({ author: ['lims.master.author'], issuer: ['lims.analysis.perform'], asha: ['lims.analysis.perform', 'lims.analysis.check'],
    ravi: ['lims.analysis.check'], rev: ['lims.analysis.review'] } as const)) {
    await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(async () => {
  await provider?.end();
  for (const s of Object.values(S)) if (s) await t.owner.unsafe(`drop schema if exists ${s} cascade`);
  await t?.close();
});

const as = (who: string, method: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, method, url, body);
type Src = { from: string; link?: string; shown?: string; capture?: { raw: string[] }; cds?: { hash: string; size: number; run: string; version: number; injections: number[] } };
type StepJson = { id: string; state: string; values: Record<string, unknown>; source: Record<string, Src>; contentHash: string };
const stepOf = async (id: number, key: string) => ((await as('asha', 'GET', `/api/analyses/${id}`)).json() as { steps: StepJson[] }).steps.find((s) => s.id === key)!;
const act = (who: string, id: number, key: string, action: string, body: object = {}) => as(who, 'POST', `/api/analyses/${id}/steps/${key}/${action}`, body);
const record = (id: number, key: string, body: object) => act('asha', id, key, 'record', body);
const sign = async (who: string, id: number, key: string, action: string) => act(who, id, key, action, { proof: proofFor(who), contentHash: (await stepOf(id, key)).contentHash });
const problems = async (p: ReturnType<typeof record>) => ((await p).json() as { problems: string[] }).problems;
const capture = (instrument: string, raw: string[], protocol = 'sics') => ({ capture: { instrument, protocol, raw, readAt: new Date().toISOString() } });

// A weighing, a pH, the instrument run, its system suitability and an assay by external standard, in a QC laboratory;
// each its own preparation, so each opens at once.
const STEPS = [
  { block: { id: 'weigh', version: 1 }, checker: true, settings: { what: 'Sample', unit: 'mg' } },
  { block: { id: 'ph', version: 1 }, settings: { readingUnit: '' } },
  { block: { id: 'instrument-run', version: 1 }, settings: { conditions: 'C18, 1.0 mL/min, 254 nm' } },
  { block: { id: 'system-suitability', version: 1 }, checker: true, settings: { rsdLimit: { high: '2.0', unit: '%' } } },
  { block: { id: 'assay', version: 1 }, checker: true, settings: { mode: 'external standard', response: 'peak area', responseUnit: '', stdMass: '50.00 mg', stdVolume: '100 mL',
    preparations: '2', sampleVolume: '100 mL', sample1Mass: '50.00 mg', sample2Mass: '50.00 mg', per: 'mass' } }];
const doc = () => small(STEPS.map((st) => ({ kind: 'preparation', machineTypes: ['hplc', 'ph meter'], roomTypes: ['QC laboratory'], steps: [st] })));
const [WEIGH, PH, RUN, SST, ASSAY] = STEPS.map((_, i) => `${i}.1.0.1`) as [string, string, string, string, string];
async function issue() {
  const res = await as('author', 'POST', '/api/masters', { doc: doc() });
  expect(res.statusCode, res.body).toBe(200);
  const { id } = res.json() as { id: number };
  for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${id}`;
  const b = await as('issuer', 'POST', '/api/analyses', { masterVersionId: id, proof: proofFor('issuer') });
  expect(b.statusCode, b.body).toBe(200);
  return b.json() as { id: number; analysisNo: string };
}
// The invented CDS files name the sample LS2600123; a trial analysis's injections are named by its analysis number.
const fixture = (name: string, analysisNo: string) => readFileSync(new URL(`./fixtures/capture/${name}`, import.meta.url), 'utf8').replaceAll('LS2600123', analysisNo);
const file = (name: string, text: string) => ({ name, content: Buffer.from(text).toString('base64') });

function pdfText(def: TDocumentDefinitions): string {
  const walk = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(walk).join('');
    if (!c || typeof c !== 'object') return '';
    const o = c as { text?: unknown; stack?: unknown[]; table?: { body: unknown[][] } };
    if (o.stack) return o.stack.map(walk).join('\n');
    if (o.table) return o.table.body.map((r) => r.map((x) => walk(x).trim()).join(' | ')).join('\n');
    return walk(o.text);
  };
  return (def.content as Content[]).map(walk).join('\n');
}

describe('LIMS-32 a value read from the step\'s machine', () => {
  it('LIMS-32 the server parses the raw line itself (never the browser\'s number), keeps the machine, protocol and raw line, and the value cannot be typed over', async () => {
    const a = await issue();
    await act('asha', a.id, WEIGH, 'start');
    expect((await record(a.id, WEIGH, { values: { balance: 'eq-bal' } })).statusCode).toBe(200);
    // A number the browser adds is ignored: the value is the server's parse of "S S 0.05123 g", in mg.
    const r = await record(a.id, WEIGH, { values: { mass: { ...capture('BAL-01', ['S S     0.05123 g']), value: '99.9' } } });
    expect(r.statusCode, r.body).toBe(200);
    const s = await stepOf(a.id, WEIGH);
    expect(s.values.mass).toEqual({ value: '51.23', unit: 'mg' });
    expect(s.source.mass).toMatchObject({ from: 'instrument', shown: 'BAL-01, Mettler Toledo SICS: "S S     0.05123 g" (51.23 mg)', capture: { instrument: 'BAL-01', protocol: 'sics', raw: ['S S     0.05123 g'] } });
    expect(await problems(record(a.id, WEIGH, { values: { mass: '50.00' } }))).toEqual(['Net mass comes from the instrument and cannot be typed over']);
    // Read again: the new reading replaces it.
    expect((await record(a.id, WEIGH, { values: { mass: capture('BAL-01', ['S S     0.05009 g']) } })).statusCode).toBe(200);
    expect((await stepOf(a.id, WEIGH)).values.mass).toEqual({ value: '50.09', unit: 'mg' });
  });

  it('LIMS-50 a reading from another machine, or an unstable one, is refused; a machine changed after the reading must be read again before signing', async () => {
    const a = await issue();
    await act('asha', a.id, WEIGH, 'start');
    await record(a.id, WEIGH, { values: { balance: 'eq-bal' } });
    expect(await problems(record(a.id, WEIGH, { values: { mass: capture('BAL-02', ['S S     0.05123 g']) } })))
      .toEqual(['Net mass: the reading came from BAL-02, but the balance of this step is BAL-01: read it from BAL-01.']);
    expect(await problems(record(a.id, WEIGH, { values: { mass: capture('BAL-01', ['S D     0.05123 g']) } })))
      .toEqual(['Net mass: The balance is not stable yet: wait until the reading settles, then read again.']);
    expect((await record(a.id, WEIGH, { values: { mass: capture('BAL-01', ['S S     0.05123 g']) } })).statusCode).toBe(200);
    expect((await record(a.id, WEIGH, { values: { balance: 'eq-bal2' } })).statusCode).toBe(200);
    expect((await sign('asha', a.id, WEIGH, 'done')).json()).toMatchObject({ error: 'not_ready', problems: ['Net mass was read from BAL-01, but the balance is now BAL-02: read it again from BAL-02'] });
    expect((await record(a.id, WEIGH, { values: { mass: capture('BAL-02', ['S S     0.05123 g']) } })).statusCode).toBe(200);
    expect((await sign('asha', a.id, WEIGH, 'done')).statusCode).toBe(200);
  });

  it('LIMS-32 a pH read from the meter brings its temperature and needs no second person; typed, it is marked typed and a second person checks it', async () => {
    const a = await issue();
    await act('asha', a.id, PH, 'start');
    await record(a.id, PH, { values: { meter: 'eq-ph' } });
    expect((await record(a.id, PH, { values: { reading: capture('PH-01', ['pH meter print', 'pH          6.85 pH   24.8 °C   |A|'], 'ph-print'), calibrationTemperature: '25.0' } })).statusCode).toBe(200);
    let s = await stepOf(a.id, PH);
    expect(s.values).toMatchObject({ reading: { value: '6.85', unit: '' }, temperature: { value: '24.8', unit: '°C' } });
    expect(s.source.temperature).toMatchObject({ from: 'instrument' });
    expect((await sign('asha', a.id, PH, 'done')).statusCode).toBe(200);
    expect((await stepOf(a.id, PH)).state).toBe('done');

    const b = await issue();
    await act('asha', b.id, PH, 'start');
    await record(b.id, PH, { values: { meter: 'eq-ph' } });
    expect((await record(b.id, PH, { values: { reading: '6.85', temperature: '24.8', calibrationTemperature: '25.0' } })).statusCode).toBe(200);
    s = await stepOf(b.id, PH);
    expect(s.source.reading).toEqual({ from: 'hand', link: 'instrument', state: 'absent' });
    expect((await sign('asha', b.id, PH, 'done')).statusCode).toBe(200);
    // The pH step has no checker of its own: the typed reading makes one.
    expect((await stepOf(b.id, PH)).state).toBe('done_awaiting_check');
    expect((await sign('asha', b.id, PH, 'check')).json()).toMatchObject({ error: 'own_work' });
    expect((await sign('ravi', b.id, PH, 'check')).statusCode).toBe(200);
    const r = (await as('rev', 'GET', `/api/analyses/${b.id}/review`)).json() as { hand: { field: string; link: string }[] };
    expect(r.hand.filter((h) => h.link === 'instrument').map((h) => h.field)).toEqual(['reading', 'temperature']);
  });
});

describe('LIMS-33 LIMS-49 the CDS result file', () => {
  async function run(a: { id: number }, runId = 'RUN-0042') {
    await act('asha', a.id, RUN, 'start');
    expect((await record(a.id, RUN, { values: { instrument: 'eq-hplc', runId, asWritten: 'yes' } })).statusCode).toBe(200);
  }

  it('LIMS-33 LIMS-49 the import fills the peaks with the file\'s SHA-256, size, run and processing method; they cannot be typed over', async () => {
    const a = await issue();
    await run(a);
    await act('asha', a.id, SST, 'start');
    const text = fixture('generic-assay.csv', a.analysisNo);
    const res = await record(a.id, SST, { cds: file('PARA_ASSAY_RUN-0042.csv', text) });
    expect(res.statusCode, res.body).toBe(200);
    const s = await stepOf(a.id, SST);
    expect(s.values.responses).toEqual(['1520345.2', '1518876.9', '1522010.4', '1519654.0', '1521233.7'].map((value) => ({ value, unit: 'units' })));
    expect(s.values.tailing).toEqual({ value: '1.13', unit: 'units' });
    const hash = createHash('sha256').update(Buffer.from(text)).digest('hex');
    expect(s.source.responses).toMatchObject({ from: 'cds', cds: { file: 'PARA_ASSAY_RUN-0042.csv', size: Buffer.byteLength(text), hash, format: 'generic', run: 'RUN-0042',
      sequence: 'PARA-ASSAY-2611', method: 'PARA_ASSAY version 3', injections: [2, 3, 4, 5, 6], version: 1 } });
    expect(await problems(record(a.id, SST, { values: { tailing: '1.0' } }))).toEqual(['Tailing factor comes from the CDS result file and cannot be typed over']);
    // The assay of the same run: the standard and both preparations; the other sample of the sequence is left out.
    await act('asha', a.id, ASSAY, 'start');
    expect((await record(a.id, ASSAY, { cds: file('PARA_ASSAY_RUN-0042.csv', text) })).statusCode).toBe(200);
    const y = await stepOf(a.id, ASSAY);
    expect(Object.keys(y.values).sort()).toEqual(['responses1', 'responses2', 'stdResponses']);
    expect(y.source.responses1!.cds!.injections).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('LIMS-49 LIMS-50 a file of another run, of another sample, before the run id is recorded, or that does not fit the step is refused with the reason', async () => {
    const a = await issue();
    await act('asha', a.id, SST, 'start');
    const text = fixture('generic-assay.csv', a.analysisNo);
    expect(await problems(record(a.id, SST, { cds: file('a.csv', text) }))).toEqual(['Record the run id on the instrument run step first: the file must be of that run.']);
    await run(a, 'RUN-0041');
    expect(await problems(record(a.id, SST, { cds: file('a.csv', text) }))).toEqual(['The file is of CDS run RUN-0042; the instrument run of this analysis recorded RUN-0041: import the result of that run.']);
    await record(a.id, RUN, { values: { runId: 'RUN-0042' } });
    await act('asha', a.id, ASSAY, 'start');
    expect(await problems(record(a.id, ASSAY, { cds: file('a.csv', fixture('generic-assay.csv', 'LS2600555')) })))
      .toEqual([`The file has no injection of ${a.analysisNo} (it has STD, LS2600555-1, LS2600555-2, LS2600999-1): import the run of this sample.`]);
    const four = text.split('\n').filter((l) => !/^[56],/.test(l)).join('\n');
    expect(await problems(record(a.id, SST, { cds: file('a.csv', four) }))).toEqual(['Responses of the replicate injections: the file has 3 injections (2, 3, 4); this step takes 5 to 6.']);
    expect(await problems(record(a.id, SST, { cds: file('a.csv', 'not,a,result\n1,2,3\n') })))
      .toEqual([expect.stringMatching(/^This file is not a CDS result export LIMS reads/)]);
    await act('asha', a.id, WEIGH, 'start');
    expect(await problems(record(a.id, WEIGH, { cds: file('a.csv', text) }))).toEqual(['This step takes no CDS result file.']);
  });

  it('LIMS-33 LIMS-24 a re-import needs a reason, is a new version, and the earlier values stay visible; typed peaks are marked typed', async () => {
    const a = await issue();
    await run(a);
    await act('asha', a.id, SST, 'start');
    const text = fixture('generic-assay.csv', a.analysisNo);
    expect((await record(a.id, SST, { cds: file('first.csv', text) })).statusCode).toBe(200);
    const again = text.replace('1520345.2', '1520399.9');
    expect(await problems(record(a.id, SST, { cds: file('second.csv', again) }))).toEqual(['This step already has an imported CDS result: give the reason for importing again. The earlier import stays in the record.']);
    expect((await record(a.id, SST, { cds: file('second.csv', again), reason: 'Reprocessed with the corrected integration events (CDS audit trail)' })).statusCode).toBe(200);
    const s = await stepOf(a.id, SST);
    expect(s.source.responses!.cds).toMatchObject({ file: 'second.csv', version: 2 });
    const h = (await as('asha', 'GET', `/api/analyses/${a.id}/steps/${SST}/events`)).json() as { replaced: { field: string; reason: string }[] };
    expect(h.replaced.find((x) => x.field === 'responses')).toMatchObject({ reason: 'Reprocessed with the corrected integration events (CDS audit trail)' });

    // Typed instead of imported (the CDS export is not available): marked typed, for the second person and QA.
    await act('asha', a.id, ASSAY, 'start');
    expect((await record(a.id, ASSAY, { values: { stdResponses: ['100', '101'] } })).statusCode).toBe(200);
    expect((await stepOf(a.id, ASSAY)).source.stdResponses).toEqual({ from: 'hand', link: 'cds', state: 'absent' });
  });

  it('LIMS-19 LIMS-49 the reviewer and the analysis record PDF see what was read from instruments (with the raw line), imported (file, SHA-256, run) and typed', async () => {
    const a = await issue();
    await act('asha', a.id, WEIGH, 'start');
    await record(a.id, WEIGH, { values: { balance: 'eq-bal' } });
    await record(a.id, WEIGH, { values: { mass: capture('BAL-01', ['S S     0.05123 g']) } });
    await run(a);
    await act('asha', a.id, SST, 'start');
    const text = fixture('generic-assay.csv', a.analysisNo);
    await record(a.id, SST, { cds: file('PARA_ASSAY_RUN-0042.csv', text) });
    const hash = createHash('sha256').update(Buffer.from(text)).digest('hex');
    const r = (await as('rev', 'GET', `/api/analyses/${a.id}/review`)).json() as { captured: { step: string; from: string; fields: string[]; shown: string; personName: string }[] };
    expect(r.captured).toMatchObject([
      { step: WEIGH, from: 'instrument', fields: ['mass'], shown: 'BAL-01, Mettler Toledo SICS: "S S     0.05123 g" (51.23 mg)', personName: 'ASHA' },
      { step: SST, from: 'cds', fields: ['responses', 'tailing', 'plates', 'signalToNoise'], shown: expect.stringContaining(`SHA-256 ${hash}`) },
    ]);
    const pdf = pdfText(analysisRecordDoc(await recordInput(t.sql, (await loadAnalysis(t.sql, a.id))!), 'VIEWER'));
    expect(pdf).toContain('Read from instruments and imported from the CDS');
    expect(pdf).toContain('raw: "S S     0.05123 g"');
    expect(pdf).toContain(`Imported from the CDS: CDS run RUN-0042, sequence PARA-ASSAY-2611, processing method PARA_ASSAY version 3, injections 2, 3, 4, 5, 6; file PARA_ASSAY_RUN-0042.csv (generic CSV layout, ${Buffer.byteLength(text)} bytes, SHA-256 ${hash}), import 1`);
    expect(pdf).toContain('Net mass: 51.23 mg (BAL-01, Mettler Toledo SICS: "S S     0.05123 g" (51.23 mg))');
  });
});
