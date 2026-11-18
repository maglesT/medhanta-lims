import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links, namesProduct, type Links } from '../server/links.js';
import { findBlock } from '../shared/blocks/index.js';
import { analysisView, deviationText, fieldLabel, filedKey, handFields } from '../shared/engine/index.js';
import { analysisRecordDoc } from '../server/analysis-record.js';
import { loadAnalysis, recordInput } from '../server/routes/analyses.js';
import { call, freshApp, handLabels, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';
import { at, ev, small, method, placed } from './engine-fixture.js';
import { inLogbook } from '../shared/engine/picks.js';

// The links to Deviations, QMS, Logbook and MMS (owner 15 Nov 2026), each read through a fake provider schema in the
// test database with this product's restricted login, as on the platform: absent (no URL), down (refused or not
// answering: people go on by hand with a second-person check) and ok (pulled, never typed over).

let t: TestApp;
let provider: Sql;
const S: Record<'dv' | 'qms' | 'lb' | 'mms' | 'ql', string> = { dv: '', qms: '', lb: '', mms: '', ql: '' };
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
const item = (itemId: string, c: string, name: string) => ({ itemId, code: c, name, version: 1, active: true });

beforeAll(async () => {
  t = await freshApp(async (db) => {
    for (const k of Object.keys(S) as (keyof typeof S)[]) S[k] = `${db.schema}_${k}`;
    // The planned and published views, as tables with the same columns (the providers' own contracts).
    await db.owner.unsafe(`
      create schema ${S.dv}; create schema ${S.qms}; create schema ${S.lb}; create schema ${S.mms}; create schema ${S.ql};
      create table ${S.ql}.qualification_v1 (item_id bigint, master_id text, code text, name text, kind text, status text, next_review_due date,
        status_since timestamptz default now(), status_source text, read_at timestamptz default now(), data_as_of timestamptz default now());
      create table ${S.dv}.deviation_v1 (number text, status text, classification text, opened_at timestamptz, closed_at timestamptz, product text, analysis text,
        analysis_norm text, outcome text, read_at timestamptz default now(), data_as_of timestamptz default now(), title text, source_ref text);
      create table ${S.qms}.change_v1 (number text, status text, title text, products text, qa_approved_at timestamptz, closed_at timestamptz,
        read_at timestamptz default now(), data_as_of timestamptz default now());
      create table ${S.lb}.equipment_status_v1 (master_id text, code text, kind text, state text, fit_for_use boolean, blockers text[], warnings text[],
        in_use_analysis text, clean_until timestamptz, cleaned_at timestamptz, cleaned_by text, calibration_due date, qualification text,
        checked_at timestamptz default now(), read_at timestamptz default now(), data_as_of timestamptz default now());
      create table ${S.mms}.lot_v1 (lot_number text, kind text, material_master_id text, material_code text, product_code text, status text, status_since timestamptz,
        expiry_date date, retest_date date, manufacturer_analysis text, supplier_code text, qc_report_ref text, qc_conclusion text,
        read_at timestamptz default now(), data_as_of timestamptz default now(), stock numeric, unit text);
      create table ${S.mms}.lot_test_v1 (lot_number text, report_ref text, test text, specification text, result text, value numeric, unit text, basis text,
        tested_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now());
      grant usage on schema ${S.dv}, ${S.qms}, ${S.lb}, ${S.mms}, ${S.ql} to lims_app;
      grant select on all tables in schema ${S.dv}, ${S.qms}, ${S.lb}, ${S.mms}, ${S.ql} to lims_app;
      insert into ${S.qms}.change_v1 (number, status, title, products, qa_approved_at) values
        ('CC-2026-0001', 'implementation', 'New HPLC column supplier', 'PRD-001', now()), ('CC-2026-0002', 'qa', 'Mobile phase pH', null, null),
        ('CC-2026-0003', 'rejected', 'Drop the identity test', null, now()),
        ('CC-2026-0004', 'implementation', 'Paracetamol assay by HPLC', 'FG-PCM500 Paracetamol 500 mg tablets', now()),
        ('CC-2026-0005', 'closure', 'New analytical balance', null, now());
      insert into ${S.lb}.equipment_status_v1 (master_id, code, kind, state, fit_for_use, blockers, warnings, in_use_analysis, cleaned_at, cleaned_by, checked_at) values
        ('eq-str', 'STR-01', 'equipment', 'clean', true, '{}', '{"Use allowed under exception EXC-7"}', null, null, null, now()),
        ('eq-str2', 'STR-02', 'equipment', 'dirty', false, '{"Dirty: clean and verify before the next use.","Calibration overdue."}', '{}', null, null, null, now()),
        ('eq-str3', 'STR-03', 'equipment', 'in use', true, '{}', '{}', 'XB26001', null, null, now()),
        ('eq-str4', 'STR-04', 'equipment', 'clean', true, '{}', '{}', null, null, null, now() - interval '10 minutes'),
        ('eq-bal', 'BAL-01', 'instrument', 'clean', true, '{}', '{}', null, null, null, now()),
        ('eq-hplc', 'HPLC-01', 'instrument', 'clean', true, '{}', '{}', null, null, null, now()),
        ('rm-1', 'QCL-01', 'area', 'clean', true, '{}', '{}', null, '2026-11-15 05:30+00', 'CLEANER ONE', now());
      insert into ${S.mms}.lot_v1 (lot_number, kind, material_master_id, material_code, status, expiry_date, retest_date, qc_report_ref) values
        ('API-OK', 'material', 'mat-api', 'MAT-001', 'approved', '2099-01-31', null, 'QC-26-101'),
        ('API-Q', 'material', 'mat-api', 'MAT-001', 'quarantine', '2099-01-31', null, null),
        ('API-EXP', 'material', 'mat-api', 'MAT-001', 'approved', '2020-01-31', null, 'QC-19-001'),
        ('API-RT', 'material', 'mat-api', 'MAT-001', 'approved', '2099-01-31', '2021-06-30', 'QC-20-001'),
        ('API-ASIS', 'material', 'mat-api', 'MAT-001', 'approved', '2099-01-31', null, 'QC-26-102'),
        ('LAC-1', 'material', 'mat-lac', 'MAT-002', 'approved', '2099-01-31', null, 'QC-26-103');
      update ${S.mms}.lot_v1 set stock = 25, unit = 'kg' where lot_number = 'API-OK';
      insert into ${S.mms}.lot_test_v1 (lot_number, report_ref, test, result, value, unit, basis) values
        ('API-OK', 'QC-26-101', 'Assay', '99.1 %', 99.1, '%', 'dried'), ('API-OK', 'QC-26-101', 'LOD', '0.4 %', 0.4, '%', 'as is'),
        ('API-OK', 'QC-26-101', 'Identity', 'complies', null, null, null), ('API-ASIS', 'QC-26-102', 'Assay', '98.0 %', 98.0, '%', 'as is');`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    // Every machine here is qualified (Qualification itself: test/instruments.test.ts).
    await db.owner.unsafe(`insert into ${S.ql}.qualification_v1 (master_id, code, name, kind, status, next_review_due)
      select x, x, x, 'equipment', 'qualified', '2099-12-31' from unnest(array['eq-str', 'eq-str2', 'eq-str3', 'eq-str4', 'eq-str5', 'eq-bal', 'eq-hplc']) x`);
    return links({ deviations: provider, qms: provider, logbook: provider, mms: provider, qual: provider }, { deviations: S.dv, qms: S.qms, logbook: S.lb, mms: S.mms, qual: S.ql });
  });
  t.master.equipment_.push(...['', '2', '3', '4', '5'].map((n) => ({ ...item(`eq-str${n}`, `STR-0${n || 1}`, 'Magnetic stirrer'), kind: 'equipment' as const, type: 'stirrer', room: 'QCL-01' })),
    { ...item('eq-bal', 'BAL-01', 'Analytical balance'), kind: 'instrument', type: 'balance', room: 'QCL-01' },
    { ...item('eq-hplc', 'HPLC-01', 'HPLC system'), kind: 'instrument', type: 'hplc', room: 'QCL-01' });
  t.master.rooms_.push({ ...item('rm-1', 'QCL-01', 'QC laboratory 1'), area: 'QC laboratory', grade: 'D' });
  const people = {
    author: ['lims.master.author'], checker: ['lims.master.check'], quality: ['lims.master.approve'], quality2: ['lims.master.approve'],
    issuer: ['lims.analysis.perform'], asha: ['lims.analysis.perform', 'lims.analysis.check'], ravi: ['lims.analysis.check'],
    meera: ['lims.qc.approve'], mona: ['lims.qc.approve', 'lims.analysis.perform'],
  } as const;
  for (const [name, perms] of Object.entries(people)) {
    ids[name] = await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
});
afterAll(async () => {
  await provider?.end();
  for (const s of Object.values(S)) if (s) await t.owner.unsafe(`drop schema if exists ${s} cascade`);
  await t?.close();
});

const as = (who: string, method: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, method, url, body);
const cut = (schema: string) => t.owner.unsafe(`revoke select on all tables in schema ${schema} from lims_app`);
const restore = (schema: string) => t.owner.unsafe(`grant select on all tables in schema ${schema} to lims_app`);
async function issue(doc: ReturnType<typeof small>) {
  const res = await as('author', 'POST', '/api/masters', { doc });
  expect(res.statusCode).toBe(200);
  const { id } = res.json() as { id: number };
  for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${id}`;
  const b = await as('issuer', 'POST', '/api/analyses', { masterVersionId: id, proof: proofFor('issuer') });
  expect(b.statusCode).toBe(200);
  return b.json() as { id: number; analysisNo: string };
}
type StepJson = { id: string; state: string; values: Record<string, unknown>; source: Record<string, { from: string; state?: string; shown?: string }>;
  handFields: { name: string }[]; problems: string[]; contentHash: string; results: Record<string, { ok: boolean; message?: string }> };
const stepOf = async (id: number, key: string) => ((await as('asha', 'GET', `/api/analyses/${id}`)).json() as { steps: StepJson[] }).steps.find((s) => s.id === key)!;
const act = (who: string, id: number, key: string, action: string, body: object = {}) => as(who, 'POST', `/api/analyses/${id}/steps/${key}/${action}`, body);
const record = (id: number, key: string, values: object) => act('asha', id, key, 'record', { values });
const sign = async (who: string, id: number, key: string, action: string) => act(who, id, key, action, { proof: proofFor(who), contentHash: (await stepOf(id, key)).contentHash });
const problems = async (p: ReturnType<typeof record>) => ((await p).json() as { problems: string[] }).problems;

describe('the link client: absent, down (refused or not answering) and ok', () => {
  const reads = (l: Links) => [l.deviations.byNumbers(['DEV-1']), l.qms.change('CC-2026-0001'), l.logbook.status('eq-str'), l.mms.lot('API-OK')];

  it('absent: no URL (not licensed, or the link is off) reads nothing', async () => {
    expect((await Promise.all(reads(links()))).map((r) => r.state)).toEqual(['absent', 'absent', 'absent', 'absent']);
  });

  it('ok: the rows as the provider has them now, nothing copied', async () => {
    const [d, q, l, m] = await Promise.all(reads(t.app.links));
    expect([d!.state, q!.state, l!.state, m!.state]).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(q).toMatchObject({ value: { number: 'CC-2026-0001', status: 'implementation', title: 'New HPLC column supplier' } });
    expect(l).toMatchObject({ value: { code: 'STR-01', fitForUse: true, warnings: ['Use allowed under exception EXC-7'] } });
    expect(m).toMatchObject({ value: { lotNumber: 'API-OK', status: 'approved', tests: [{ test: 'Assay', value: '99.1', basis: 'dried' }, { test: 'LOD', value: '0.4' }] } });
    await t.owner.unsafe(`update ${S.qms}.change_v1 set title = 'Second HPLC column supplier' where number = 'CC-2026-0001'`);
    expect(await t.app.links.qms.change('CC-2026-0001')).toMatchObject({ value: { title: 'Second HPLC column supplier' } });
  });

  it('down: a refused read (grant revoked, view missing) or a provider that does not answer', async () => {
    for (const s of Object.values(S)) await cut(s);
    try {
      expect((await Promise.all(reads(t.app.links))).map((r) => r.state)).toEqual(['down', 'down', 'down', 'down']);
    } finally {
      for (const s of Object.values(S)) await restore(s);
    }
    const gone = links({ deviations: provider, qms: provider, logbook: provider, mms: provider }, { deviations: 'nope', qms: 'nope', logbook: 'nope', mms: 'nope' });
    expect((await Promise.all(reads(gone))).map((r) => r.state)).toEqual(['down', 'down', 'down', 'down']);
    const nowhere = connect('postgres://lims_app:x@127.0.0.1:1/x', { link: true });
    expect((await Promise.all(reads(links({ deviations: nowhere, qms: nowhere, logbook: nowhere, mms: nowhere })))).map((r) => r.state)).toEqual(['down', 'down', 'down', 'down']);
    await nowhere.end();
  });

  it('the lot pick list offers the lots of a material MMS has released and in date', async () => {
    const r = (await as('asha', 'GET', '/api/mms/lots?material=mat-api')).json() as { link: string; lots: { lotNumber: string }[] };
    expect(r).toMatchObject({ link: 'ok' });
    expect(r.lots.map((l) => l.lotNumber)).toEqual(['API-ASIS', 'API-OK']);
  });

});

describe('the labels people saw', () => {
  it('a label question shows its label, not its name, wherever it is listed, and whether the link is back or not', () => {
    const weigh = findBlock({ id: 'weigh', version: 1 })!.fields;
    expect(fieldLabel(weigh, 'balance')).toBe('Balance');
    expect(fieldLabel(weigh, 'balance.inService')).toBe('Balance: not tagged out of service, maintenance in date');
    // The same text as the question the analyst answered.
    const hand = handFields(weigh, { balance: { from: 'hand', link: 'logbook', state: 'absent' } });
    expect(hand.map((q) => q.name)).toEqual(['balance.clean', 'balance.calibrated', 'balance.inService', 'balance.qualified']);
    for (const q of hand) expect(fieldLabel(weigh, q.name)).toBe(q.label);
    expect(fieldLabel(weigh, 'balance.unknown')).toBe('balance.unknown');
  });
});

describe('LIMS-12 Logbook: equipment and rooms fit for use', () => {
  let b: { id: number; analysisNo: string };
  beforeAll(async () => {
    b = await issue(small([{ machineTypes: ['stirrer'], roomTypes: ['QC laboratory'], steps: [{ block: { id: 'line-clearance', version: 1 }, checker: true, settings: {} },
      { block: { id: 'mix', version: 1 }, settings: {} }] }]));
  });

  it('LIMS-12 bench clearance: the room\'s cleaning facts are pulled from the Logbook and cannot be typed over', async () => {
    await act('asha', b.id, '0.1.0.1', 'start');
    expect((await record(b.id, '0.1.0.1', { room: 'rm-1' })).statusCode).toBe(200);
    const s = await stepOf(b.id, '0.1.0.1');
    expect(s.values).toMatchObject({ room: { code: 'QCL-01' }, clean: 'yes', cleanedBy: 'CLEANER ONE' });
    expect(s.values.cleanedOn).toMatch(/^2026-11-15 05:30/);
    expect(s.source.cleanedBy).toMatchObject({ from: 'logbook' });
    expect(s.handFields).toEqual([]);
    expect(await problems(record(b.id, '0.1.0.1', { cleanedBy: 'SOMEONE ELSE' }))).toEqual(['Cleaned by (name on the label) comes from Logbook and cannot be typed over']);
    expect((await record(b.id, '0.1.0.1', { previousRemoved: 'yes', noOther: 'yes' })).statusCode).toBe(200);
    expect((await sign('asha', b.id, '0.1.0.1', 'done')).statusCode).toBe(200);
  });

  it('LIMS-12 while the Logbook answers, the machine and room pickers offer only what it has (an empty one names the rest); absent or down, every one', async () => {
    const read = async () => (await as('asha', 'GET', '/api/logbook/items')).json() as { link: string; items: string[] };
    const r = await read();
    expect(r.link).toBe('ok');
    expect([...r.items].sort()).toEqual(['eq-bal', 'eq-hplc', 'eq-str', 'eq-str2', 'eq-str3', 'eq-str4', 'rm-1']);
    const stirrers = t.master.equipment_.filter((m) => m.type === 'stirrer');
    const picks = inLogbook(stirrers, r.items);
    expect(picks.offered.map((m) => m.code)).toEqual(['STR-01', 'STR-02', 'STR-03', 'STR-04']);
    // A picker with choices has no note; an empty one names what the Logbook does not have.
    expect(picks.note).toBeNull();
    expect(inLogbook(stirrers.filter((m) => m.code === 'STR-05'), r.items)).toEqual({ offered: [],
      note: 'Not offered, because the Logbook does not have it: STR-05. Only what the Logbook has can be used while it is linked.' });
    expect(inLogbook(t.master.rooms_, r.items).offered.map((x) => x.code)).toEqual(['QCL-01']);
    await cut(S.lb);
    try {
      expect(await read()).toEqual({ link: 'down', items: [] });
    } finally { await restore(S.lb); }
    expect(inLogbook(stirrers, null)).toEqual({ offered: stirrers, note: null });
    expect((await call(t.app, '', 'GET', '/api/logbook/items')).statusCode).toBe(401);
  });

  it('LIMS-12 a machine the Logbook says is not fit for use is refused with the Logbook\'s reasons; one in use by another analysis too', async () => {
    await act('asha', b.id, '0.1.1.1', 'start');
    expect(await problems(record(b.id, '0.1.1.1', { machine: 'eq-str2' }))).toEqual(['STR-02 is not fit for use (Logbook): Dirty: clean and verify before the next use; Calibration overdue.']);
    expect(await problems(record(b.id, '0.1.1.1', { machine: 'eq-str3' }))).toEqual(['STR-03 is in use by analysis XB26001 (Logbook).']);
    expect(await problems(record(b.id, '0.1.1.1', { machine: 'eq-str5' }))).toEqual(['STR-05 is not in the Logbook, so it cannot be used.']);
  });

  it('LIMS-12 a machine fit for use is pulled with its status: no label questions, no extra check', async () => {
    expect((await record(b.id, '0.1.1.1', { machine: 'eq-str', speed: '300' })).statusCode).toBe(200);
    const s = await stepOf(b.id, '0.1.1.1');
    expect(s.source.machine).toMatchObject({ from: 'logbook', shown: 'STR-01: clean; Use allowed under exception EXC-7' });
    expect(s.handFields).toEqual([]);
    expect((await sign('asha', b.id, '0.1.1.1', 'done')).statusCode).toBe(200);
    expect((await stepOf(b.id, '0.1.1.1')).state).toBe('done');
  });

  it('LIMS-12 Logbook down or its status too old: the label questions, answered yes, and a second-person check', async () => {
    const c = await issue(small([{ machineTypes: ['stirrer'], roomTypes: ['QC laboratory'], steps: [{ block: { id: 'mix', version: 1 }, settings: {} }] }]));
    await act('asha', c.id, '0.1.0.1', 'start');
    expect((await record(c.id, '0.1.0.1', { machine: 'eq-str4', speed: '300' })).statusCode).toBe(200);
    expect((await stepOf(c.id, '0.1.0.1')).source.machine).toEqual({ from: 'hand', link: 'logbook', state: 'down' });
    await cut(S.lb);
    try {
      expect((await record(c.id, '0.1.0.1', { machine: 'eq-str' })).statusCode).toBe(200);
    } finally { await restore(S.lb); }
    const s = await stepOf(c.id, '0.1.0.1');
    // Qualification answers: its qualification is pulled, so the "qualified" label question is not asked.
    expect(s.handFields.map((f) => f.name)).toEqual(['machine.clean', 'machine.calibrated', 'machine.inService']);
    expect(s.problems).toContain('Stirrer, shaker or sonicator: the calibration label is in date is not recorded');
    expect(await problems(record(c.id, '0.1.0.1', { 'machine.calibrated': 'no' }))).toEqual(['Stirrer, shaker or sonicator: the calibration label is in date: if not, do not use it; use another, or raise a deviation.']);
    const { 'machine.qualified': _, ...labels } = handLabels('machine', 'machine');
    expect((await record(c.id, '0.1.0.1', labels)).statusCode).toBe(200);
    expect((await sign('asha', c.id, '0.1.0.1', 'done')).statusCode).toBe(200);
    expect((await stepOf(c.id, '0.1.0.1')).state).toBe('done_awaiting_check');
    expect((await sign('asha', c.id, '0.1.0.1', 'check')).json()).toMatchObject({ error: 'own_work' });
    expect((await sign('ravi', c.id, '0.1.0.1', 'check')).statusCode).toBe(200);
    // The reviewer sees every hand entry and why.
    const r = (await as('meera', 'GET', `/api/analyses/${c.id}/review`)).json() as { hand: { step: string; field: string; link: string; state: string; personName: string }[] };
    expect(r.hand).toMatchObject([{ step: '0.1.0.1', field: 'machine', link: 'logbook', state: 'down', personName: 'ASHA' }, { field: 'machine', state: 'down' }]);
  });

  it('LIMS-12 an instrument the Logbook keeps for one product (after an antibiotic) is not refused while the analysis names no product; a view without the column reads as any product', async () => {
    // The stand-in view has no only_product yet (as the Logbook's before it was appended): read as null.
    expect(await t.app.links.logbook.status('eq-str')).toMatchObject({ state: 'ok', value: { code: 'STR-01', onlyProduct: null } });
    await t.owner.unsafe(`alter table ${S.lb}.equipment_status_v1 add column only_product text`);
    try {
      await t.owner.unsafe(`update ${S.lb}.equipment_status_v1 set only_product = 'FG-PWD-EXC1' where master_id = 'eq-str'`);
      expect(await t.app.links.logbook.status('eq-str')).toMatchObject({ state: 'ok', value: { onlyProduct: 'FG-PWD-EXC1' } });
      // The product comes with the sample (step 3 samples); until then the analysis names none and the check is not made.
      const c = await issue(small([{ machineTypes: ['stirrer'], roomTypes: ['QC laboratory'], steps: [{ block: { id: 'mix', version: 1 }, settings: {} }] }]));
      await act('asha', c.id, '0.1.0.1', 'start');
      expect((await record(c.id, '0.1.0.1', { machine: 'eq-str', speed: '300' })).statusCode).toBe(200);
      expect((await stepOf(c.id, '0.1.0.1')).source.machine).toMatchObject({ from: 'logbook' });
    } finally {
      await t.owner.unsafe(`alter table ${S.lb}.equipment_status_v1 drop column only_product`);
    }
  });

});

describe('LIMS-20 Deviations: the deviation number and its status come from the Deviations system', () => {
  let b: { id: number; analysisNo: string };
  const devs = async () => ((await as('meera', 'GET', `/api/analyses/${b.id}`)).json() as { analysis: { deviations: { reference: string; open: boolean; status?: string }[]; deviationsLink: string } }).analysis;
  beforeAll(async () => {
    b = await issue(small([{ steps: [{ checker: true }] }]));
    await t.owner.unsafe(`insert into ${S.dv}.deviation_v1 (number, status, analysis, analysis_norm, title) values
      ('DEV-26-0001', 'investigation', '${b.analysisNo}', '${b.analysisNo.toLowerCase()}', 'pH out of limits'),
      ('DEV-26-0099', 'classification', '${b.analysisNo}', '${b.analysisNo.toLowerCase()}', 'Label torn'),
      ('DEV-26-0500', 'closed', 'OTHER1', 'other1', 'Another analysis')`);
  });

  it('a note\'s reference must be a deviation in the Deviations system; the pick list holds the deviations naming the analysis', async () => {
    const picks = (await as('asha', 'GET', `/api/analyses/${b.id}/deviations`)).json() as { link: string; deviations: { number: string }[] };
    expect(picks.deviations.map((d) => d.number)).toEqual(['DEV-26-0001', 'DEV-26-0099']);
    expect((await act('asha', b.id, '0.1.0.1', 'note', { text: 'pH 7.4', reference: 'DEV-26-9999' })).json())
      .toMatchObject({ error: 'unknown_deviation', problems: ['DEV-26-9999 is not in the Deviations system: pick one of the deviations of this analysis, or check the number.'] });
    expect((await act('asha', b.id, '0.1.0.1', 'note', { text: 'pH 7.4', reference: 'DEV-26-0001' })).statusCode).toBe(200);
  });

  it('LIMS-20 its status is Deviations\' while the link answers: QA cannot close it by hand, and an unlinked deviation is shown', async () => {
    expect(await devs()).toMatchObject({ deviationsLink: 'ok', deviations: [{ reference: 'DEV-26-0001', open: true, status: 'investigation' }] });
    const note = ((await as('meera', 'GET', `/api/analyses/${b.id}/review`)).json() as { deviations: { note: number }[]; unlinked: { number: string }[] });
    expect(note.unlinked.map((d) => d.number)).toEqual(['DEV-26-0099']);
    expect((await as('meera', 'POST', `/api/analyses/${b.id}/close-deviation`, { note: note.deviations[0]!.note, reason: 'Closed' })).json())
      .toMatchObject({ problems: ['The status of DEV-26-0001 comes from the Deviations system (now under investigation): it is closed there.'] });
    await t.owner.unsafe(`update ${S.dv}.deviation_v1 set status = 'closed', closed_at = now() where number = 'DEV-26-0001'`);
    expect(await devs()).toMatchObject({ deviations: [{ reference: 'DEV-26-0001', open: false, status: 'closed' }] });
  });

  it('LIMS-20 a deviation is open until Deviations has it closed or rejected (the server passes the statuses in); without them, until closed by hand', () => {
    const doc = small([{ steps: [{ checker: true }] }]);
    const events = [ev('started', '0.1.0.1', { min: 1 }), ev('done', '0.1.0.1', { min: 2 }), ev('checked', '0.1.0.1', { person: 2, min: 3 }),
      ev('note', '0.1.0.1', { min: 4, payload: { text: 'pH', reference: 'DEV-26-001' } })];
    const open = (status?: string) => analysisView(doc, events, [], at(10), status ? new Map([['DEV-26-001', { status, closedAt: null }]]) : null).deviations
      .map((d) => [d.reference, d.where, d.open, d.status]);
    expect(open('investigation')).toEqual([['DEV-26-001', 'Stage 0 › Check a value against limits: pH', true, 'investigation']]);
    expect([open('closed')[0]![2], open('rejected')[0]![2]]).toEqual([false, false]);
    expect(open()).toEqual([['DEV-26-001', 'Stage 0 › Check a value against limits: pH', true, undefined]]);
  });

  it('LIMS-20 Deviations down: the number is typed, and a QC person other than the one who typed it closes it by hand', async () => {
    await cut(S.dv);
    try {
      expect((await act('mona', b.id, '0.1.0.1', 'note', { text: 'Second pH reading', reference: 'DEV-PAPER-7' })).statusCode).toBe(200);
      const d = await devs();
      expect(d.deviationsLink).toBe('down');
      const typed = d.deviations.find((x) => x.reference === 'DEV-PAPER-7') as unknown as { note: number; open: boolean };
      expect(typed.open).toBe(true);
      expect((await as('mona', 'POST', `/api/analyses/${b.id}/close-deviation`, { note: typed.note, reason: 'Closed on paper' })).json())
        .toMatchObject({ error: 'own_work', problems: ['You typed this deviation number: another person closes it.'] });
      expect((await as('meera', 'POST', `/api/analyses/${b.id}/close-deviation`, { note: typed.note, reason: 'Closed in the deviation system on 15 Nov' })).statusCode).toBe(200);
      const r = (await as('meera', 'GET', `/api/analyses/${b.id}/review`)).json() as { hand: { field: string; link: string; state: string; personName: string }[] };
      expect(r.hand).toMatchObject([{ field: 'reference', link: 'deviations', state: 'down', personName: 'MONA' }]);
    } finally { await restore(S.dv); }
  });
});

describe('LIMS-01 QMS: a new master version needs a QA-approved change control', () => {
  const draft = async () => {
    const { id } = (await as('author', 'POST', '/api/masters', { doc: placed(method()) })).json() as { id: number };
    const hash = async (who: string) => ((await as(who, 'GET', `/api/master-versions/${id}/review`)).json() as { contentHash: string }).contentHash;
    const review = async (who: string, action: string, extra: object = {}) =>
      as(who, 'POST', `/api/master-versions/${id}/${action}`, { proof: proofFor(who), contentHash: await hash(who), ...extra });
    await review('author', 'submit');
    await review('checker', 'pass');
    return { id, review };
  };

  it('LIMS-01 the change control must be in QMS and approved by QA; its title and approval are kept', async () => {
    const { id, review } = await draft();
    expect((await review('quality', 'approve', { changeControl: 'CC-404' })).json()).toMatchObject({ error: 'unknown_change_control' });
    expect((await review('quality', 'approve', { changeControl: 'CC-2026-0002' })).json())
      .toMatchObject({ error: 'change_not_approved', message: 'CC-2026-0002 is at the step “qa” in QMS and not approved by QA: only a QA-approved change control (implementation, closure, closed) can carry a new version.' });
    expect((await review('quality', 'approve', { changeControl: 'CC-2026-0003' })).json()).toMatchObject({ error: 'change_not_approved' });
    expect((await review('quality', 'approve', { changeControl: 'CC-2026-0001' })).statusCode).toBe(200);
    const [e] = await t.owner<{ payload: { source: { changeControl: { from: string; shown: string } } } }[]>`
      select payload from master_events where version_id = ${id} and kind = 'approved'`;
    expect(e!.payload.source.changeControl).toMatchObject({ from: 'qms', shown: expect.stringMatching(/^CC-2026-0001: Second HPLC column supplier \(implementation, QA approved /) });
    // Pulled from QMS: the approver may make it effective.
    expect((await as('quality', 'POST', `/api/master-versions/${id}/make-effective`, {})).statusCode).toBe(200);
    const picks = (await as('quality', 'GET', '/api/change-controls')).json() as { changes: { number: string }[] };
    expect(picks.changes.map((c) => c.number)).toEqual(['CC-2026-0005', 'CC-2026-0004', 'CC-2026-0001']);
  });

  it('LIMS-01 a method serves many products: every QA-approved change control is offered and accepted, whatever products it names', async () => {
    const { id, review } = await draft();
    const picks = (await as('quality', 'GET', `/api/change-controls?version=${id}`)).json() as { changes: { number: string; names: string }[] };
    expect(picks.changes.map((c) => [c.number, c.names])).toEqual([['CC-2026-0005', 'yes'], ['CC-2026-0004', 'yes'], ['CC-2026-0001', 'yes']]);
    expect((await review('quality', 'approve', { changeControl: 'CC-2026-0004' })).statusCode).toBe(200);
    const [e] = await t.owner<{ payload: { source: { changeControl: { shown: string } } } }[]>`select payload from master_events where version_id = ${id} and kind = 'approved'`;
    expect(e!.payload.source.changeControl.shown).toMatch(/^CC-2026-0004: Paracetamol assay by HPLC \(implementation, QA approved .*\); products: FG-PCM500 Paracetamol 500 mg tablets$/);
    // The product check of a change control, for a master that names one.
    const c = (products: string | null) => ({ number: 'CC', status: 'closed', title: null, qaApprovedAt: 'x', products });
    const prd = { productCode: 'FG-ATV20', productName: 'Atorvastatin calcium tablets 20 mg' };
    expect([c('fg-atv20, FG-ATV40'), c('ATORVASTATIN CALCIUM TABLETS 20 MG'), c('FG-ATV200'), c(' '), c(null)].map((x) => namesProduct(x, prd))).toEqual(['yes', 'yes', 'no', 'none', 'none']);
    // QMS writes "none" when no product is ticked: names no product. A material's name inside a product's name is not it.
    expect([c('none'), c('None'), c('n/a')].map((x) => namesProduct(x, prd))).toEqual(['none', 'none', 'none']);
    const api = { productCode: 'API-ATV', productName: 'Atorvastatin calcium' };
    expect([c('FG-ATV20 Atorvastatin calcium film-coated tablets 20 mg'), c('Atorvastatin calcium'), c('API-ATV Atorvastatin calcium'), c('API-ATV, FG-ATV20')].map((x) => namesProduct(x, api)))
      .toEqual(['no', 'yes', 'yes', 'yes']);
  });

  it('LIMS-01 QMS down: the number is typed, and another person makes the version effective', async () => {
    const { id, review } = await draft();
    await cut(S.qms);
    try {
      expect((await review('quality', 'approve', { changeControl: 'CC-PAPER-9' })).statusCode).toBe(200);
    } finally { await restore(S.qms); }
    expect((await as('quality', 'POST', `/api/master-versions/${id}/make-effective`, {})).json()).toMatchObject({ error: 'same_person' });
    expect((await as('quality2', 'POST', `/api/master-versions/${id}/make-effective`, {})).statusCode).toBe(200);
  });
});

describe('the deviation number flows back to the analysis record (owner, 17 Nov 2026)', () => {
  type Dev = { note: number; step: string; reference: string; open: boolean; status?: string; filed?: boolean; typed?: boolean };
  let b: { id: number; analysisNo: string };
  const devs = async () => ((await as('meera', 'GET', `/api/analyses/${b.id}`)).json() as { analysis: { deviations: Dev[]; deviationsLink: string } }).analysis;
  beforeAll(async () => { b = await issue(small([{ steps: [{ checker: true }] }])); });

  it('a note written without a number takes the number of the deviation Deviations filed from it (deviation_v1.source_ref), with its status, read live', async () => {
    expect((await act('asha', b.id, '0.1.0.1', 'note', { text: 'Torn label on the standard vial' })).statusCode).toBe(200);
    // Not filed yet: a note, no deviation.
    expect(await devs()).toMatchObject({ deviationsLink: 'ok', deviations: [] });
    // Deviations names the note it filed the deviation from: "<product>:note:<step event id>".
    const n = (await loadAnalysis(t.sql, b.id))!.events.find((e) => e.kind === 'note')!;
    await t.owner.unsafe(`insert into ${S.dv}.deviation_v1 (number, status, analysis, analysis_norm, title, source_ref) values
      ('DEV-26-0123', 'investigation', '${b.analysisNo}', '${b.analysisNo.toLowerCase()}', 'Torn label', 'lims:note:${n.id}')`);
    const d = await devs();
    expect(d.deviations).toEqual([expect.objectContaining({ note: n!.id, step: '0.1.0.1', reference: 'DEV-26-0123', open: true, status: 'investigation', filed: true })]);
    expect(deviationText(d.deviations[0]!)).toBe('DEV-26-0123 (filed in Deviations from this note) · under investigation (Deviations)');
    // Open in Deviations: QA cannot close it by hand; the review lists it as linked, not as a deviation no note links.
    expect((await as('meera', 'POST', `/api/analyses/${b.id}/close-deviation`, { note: n!.id, reason: 'Closed' })).json())
      .toMatchObject({ problems: ['The status of DEV-26-0123 comes from the Deviations system (now under investigation): it is closed there.'] });
    const r = (await as('meera', 'GET', `/api/analyses/${b.id}/review`)).json() as { deviations: Dev[]; unlinked: { number: string }[] };
    expect([r.deviations.map((x) => x.reference), r.unlinked]).toEqual([['DEV-26-0123'], []]);
    await t.owner.unsafe(`update ${S.dv}.deviation_v1 set status = 'closed', closed_at = now() where number = 'DEV-26-0123'`);
    expect((await devs()).deviations).toMatchObject([{ reference: 'DEV-26-0123', open: false, status: 'closed' }]);
  });

  it('Deviations down: a number typed with the note says "typed by hand"; the filed number is not shown (never stale)', async () => {
    await cut(S.dv);
    try {
      expect((await act('mona', b.id, '0.1.0.1', 'note', { text: 'Second label torn', reference: 'DEV-PAPER-9' })).statusCode).toBe(200);
      const d = await devs();
      expect(d).toMatchObject({ deviationsLink: 'down', deviations: [{ reference: 'DEV-PAPER-9', open: true, typed: true }] });
      expect(d.deviations[0]!.filed).toBeUndefined();
      expect(deviationText(d.deviations[0]!)).toBe('DEV-PAPER-9 (typed by hand) · open');
    } finally { await restore(S.dv); }
  });

  it('the analysis record PDF shows the number and status on the step where the note was written, and in its deviation notes', async () => {
    const l = (await loadAnalysis(t.sql, b.id))!;
    const note = l.events.find((e) => e.kind === 'note' && !e.payload.reference)!;
    const pdf = JSON.stringify(analysisRecordDoc({ ...await recordInput(t.sql, l), deviationsRead: new Map([[filedKey(note.id), { status: 'capa', closedAt: null, number: 'DEV-26-0123' }]]) }, 'QA'));
    expect(pdf).toContain('deviation DEV-26-0123 (filed in Deviations from this note) · waiting for its CAPA (Deviations): Torn label on the standard vial');
    expect(pdf).toContain('deviation DEV-PAPER-9 (typed by hand) · open: Second label torn');
    expect(pdf).toContain('"DEV-26-0123 (filed in Deviations from this note)"');
    expect(pdf).toContain('OPEN: waiting for its CAPA in the Deviations system');
  });
});
