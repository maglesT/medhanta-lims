import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { findBlock } from '../shared/blocks/index.js';
import { fieldLabel, handFields, inQualification, qualificationProblem, qualificationShown, qualKey, type QualRead } from '../shared/engine/index.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';
import { small } from './engine-fixture.js';

// Instruments (LIMS-12, plan 2.8): an instrument is used only while the Logbook says it is fit for use and Qualification
// (report.qualification_v1, the 'qual' link, PL-08) says it is qualified with its periodic review not past; absent or
// down, its qualification label is answered by hand with a second person. Its use is published for the Logbook
// (report.instrument_use_v1).

let t: TestApp;
let provider: Sql;
const S = { lb: '', ql: '' };
const cookies: Record<string, string> = {};
const HPLC = ['', '2', '3', '4', '5', '6'];
const hplcId = (n: string) => `eq-hplc${n}`;

beforeAll(async () => {
  t = await freshApp(async (db) => {
    S.lb = `${db.schema}_lb`;
    S.ql = `${db.schema}_ql`;
    await db.owner.unsafe(`
      create schema ${S.lb}; create schema ${S.ql};
      create table ${S.lb}.equipment_status_v1 (master_id text, code text, kind text, state text, fit_for_use boolean, blockers text[], warnings text[],
        in_use_analysis text, clean_until timestamptz, cleaned_at timestamptz, cleaned_by text, calibration_due date, qualification text,
        checked_at timestamptz default now(), read_at timestamptz default now(), data_as_of timestamptz default now());
      -- Qualification's published columns (master_id is a uuid there; the stand-in's master-data ids are text).
      create table ${S.ql}.qualification_v1 (item_id bigint, master_id text, code text, name text, kind text, status text, next_review_due date,
        status_since timestamptz default now(), status_source text, read_at timestamptz default now(), data_as_of timestamptz default now());
      grant usage on schema ${S.lb}, ${S.ql} to lims_app;
      grant select on all tables in schema ${S.lb}, ${S.ql} to lims_app;
      insert into ${S.lb}.equipment_status_v1 (master_id, code, kind, state, fit_for_use, blockers, warnings)
        select 'eq-hplc' || n, 'HPLC-0' || coalesce(nullif(n, ''), '1'), 'instrument', 'clean', true, '{}'::text[], '{}'::text[] from unnest(array['', '2', '3', '4', '5', '6']) n
        union all select 'eq-bal', 'BAL-01', 'instrument', 'clean', true, '{}', '{}';
      insert into ${S.ql}.qualification_v1 (item_id, master_id, code, name, kind, status, next_review_due) values
        (1, 'eq-hplc', 'HPLC-01', 'HPLC system', 'equipment', 'qualified', '2099-12-31'),
        (2, 'eq-hplc2', 'HPLC-02', 'HPLC system', 'equipment', 'not_qualified', null),
        (3, 'eq-hplc3', 'HPLC-03', 'HPLC system', 'equipment', 'requalification_needed', null),
        (4, 'eq-hplc4', 'HPLC-04', 'HPLC system', 'equipment', 'qualified', '2020-01-31'),
        (5, 'eq-hplc5', 'HPLC-05', 'HPLC system', 'equipment', 'qualified_conditions', '2099-12-31'),
        (6, 'eq-bal', 'BAL-01', 'Analytical balance', 'equipment', 'qualified', '2099-12-31');`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ logbook: provider, qual: provider }, { logbook: S.lb, qual: S.ql });
  });
  const item = (itemId: string, code: string, name: string, type: string) => ({ itemId, code, name, version: 1, active: true, kind: 'instrument' as const, type, room: 'QCL-01' });
  t.master.equipment_.push(...HPLC.map((n) => item(hplcId(n), `HPLC-0${n || 1}`, 'HPLC system', 'hplc')), item('eq-bal', 'BAL-01', 'Analytical balance', 'balance'));
  t.master.rooms_.push({ itemId: 'rm-1', code: 'QCL-01', name: 'QC laboratory 1', version: 1, active: true, area: 'QC laboratory', grade: 'D' });
  for (const [name, perms] of Object.entries({ author: ['lims.master.author'], issuer: ['lims.analysis.perform'], asha: ['lims.analysis.perform', 'lims.analysis.check'],
    ravi: ['lims.analysis.check'] } as const)) {
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
type StepJson = { id: string; state: string; values: Record<string, unknown>; source: Record<string, { from: string; link?: string; state?: string; shown?: string }>;
  handFields: { name: string }[]; contentHash: string };
const stepOf = async (id: number, key: string) => ((await as('asha', 'GET', `/api/analyses/${id}`)).json() as { steps: StepJson[] }).steps.find((s) => s.id === key)!;
const act = (who: string, id: number, key: string, action: string, body: object = {}) => as(who, 'POST', `/api/analyses/${id}/steps/${key}/${action}`, body);
const record = (id: number, key: string, values: object) => act('asha', id, key, 'record', { values });
const sign = async (who: string, id: number, key: string, action: string) => act(who, id, key, action, { proof: proofFor(who), contentHash: (await stepOf(id, key)).contentHash });
const problems = async (p: ReturnType<typeof record>) => ((await p).json() as { problems: string[] }).problems;
// A weighing on a balance, then an HPLC run, in a QC laboratory.
const doc = () => small([{ machineTypes: ['hplc'], roomTypes: ['QC laboratory'], steps: [
  { block: { id: 'weigh', version: 1 }, checker: true, settings: { what: 'Sample', unit: 'mg' } },
  { block: { id: 'instrument-run', version: 1 }, settings: { conditions: 'C18, 1.0 mL/min, 254 nm' } }] }]);
/** A weighing recorded, signed and checked. */
async function weighed(id: number, mass: string) {
  await act('asha', id, WEIGH, 'start');
  expect((await record(id, WEIGH, { balance: 'eq-bal', mass })).statusCode).toBe(200);
  expect((await sign('asha', id, WEIGH, 'done')).statusCode).toBe(200);
  expect((await sign('ravi', id, WEIGH, 'check')).statusCode).toBe(200);
}
async function issue() {
  const res = await as('author', 'POST', '/api/masters', { doc: doc() });
  expect(res.statusCode, res.body).toBe(200);
  const { id } = res.json() as { id: number };
  for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${id}`;
  const b = await as('issuer', 'POST', '/api/analyses', { masterVersionId: id, proof: proofFor('issuer') });
  expect(b.statusCode, b.body).toBe(200);
  return b.json() as { id: number; analysisNo: string };
}
const RUN = '0.1.1.1';
const WEIGH = '0.1.0.1';
const row = (code: string, status: string, nextReviewDue: string | null = '2099-12-31', conditions: string | null = null): QualRead =>
  ({ masterId: 'x', code, name: code, status, nextReviewDue, dataAsOf: null, conditions });

describe('LIMS-12 the qualification rule', () => {
  it('LIMS-12 qualified or qualified with conditions, periodic review not past, may be used; anything else is refused in plain words', () => {
    const today = '2026-11-18';
    expect(qualificationProblem('HPLC-01', row('HPLC-01', 'qualified'), today)).toBeNull();
    expect(qualificationProblem('HPLC-01', row('HPLC-01', 'qualified', null), today)).toBeNull();
    expect(qualificationProblem('HPLC-01', row('HPLC-01', 'qualified', today), today)).toBeNull();
    expect(qualificationProblem('HPLC-05', row('HPLC-05', 'qualified_conditions'), today)).toBeNull();
    expect(qualificationProblem('HPLC-02', row('HPLC-02', 'not_qualified', null), today)).toBe('HPLC-02 is not qualified (Qualification): only a qualified instrument may be used.');
    expect(qualificationProblem('HPLC-03', row('HPLC-03', 'requalification_needed', null), today)).toBe('HPLC-03 is due for requalification (Qualification): only a qualified instrument may be used.');
    expect(qualificationProblem('HPLC-04', row('HPLC-04', 'qualified', '2026-11-17'), today))
      .toBe('HPLC-04: its periodic review was due on 17 Nov 2026 (Qualification): it may not be used until it is reviewed.');
    expect(qualificationProblem('HPLC-06', null, today)).toBe('HPLC-06 is not in Qualification, so it cannot be used.');
    // A conditional qualification shows its conditions with the value (or where to read them).
    expect(qualificationShown(row('HPLC-05', 'qualified_conditions'))).toBe('HPLC-05: qualified with conditions, periodic review due 2099-12-31; conditions: see Qualification before use');
    expect(qualificationShown(row('HPLC-05', 'qualified_conditions', null, 'Gradient runs only'))).toBe('HPLC-05: qualified with conditions; conditions: Gradient runs only');
  });

  it('LIMS-12 the picker offers only qualified instruments and names each one left out with why; unlinked, every one', () => {
    const items = [{ itemId: 'a', code: 'A' }, { itemId: 'b', code: 'B' }, { itemId: 'c', code: 'C' }];
    expect(inQualification(items, [{ id: 'a', problem: null }, { id: 'b', problem: 'B is not qualified (Qualification): only a qualified instrument may be used.' }])).toEqual({
      offered: [items[0]], leftOut: ['Not offered: B is not qualified (Qualification): only a qualified instrument may be used.', 'Not offered: C is not in Qualification, so it cannot be used.'] });
    expect(inQualification(items, null)).toEqual({ offered: items, leftOut: [] });
  });

  it('PL-08 LIMS-12 the "qualified" label question is asked only while Qualification does not answer; a record from before the link asks it with the Logbook\'s', () => {
    const run = findBlock({ id: 'instrument-run', version: 1 })!.fields;
    const names = (source: Parameters<typeof handFields>[1]) => handFields(run, source).map((f) => f.name);
    const hand = (link: 'logbook' | 'qual', state: 'absent' | 'down' = 'down') => ({ from: 'hand' as const, link, state });
    const pulled = (from: 'logbook' | 'qual') => ({ from, asOf: null, shown: 'x' });
    expect(names({ instrument: pulled('logbook'), [qualKey('instrument')]: pulled('qual') })).toEqual([]);
    expect(names({ instrument: pulled('logbook'), [qualKey('instrument')]: hand('qual', 'absent') })).toEqual(['instrument.qualified']);
    expect(names({ instrument: hand('logbook'), [qualKey('instrument')]: pulled('qual') })).toEqual(['instrument.clean', 'instrument.calibrated', 'instrument.inService']);
    expect(names({ instrument: hand('logbook'), [qualKey('instrument')]: hand('qual') })).toEqual(['instrument.clean', 'instrument.calibrated', 'instrument.inService', 'instrument.qualified']);
    expect(names({ instrument: hand('logbook') })).toEqual(['instrument.clean', 'instrument.calibrated', 'instrument.inService', 'instrument.qualified']);
    expect(fieldLabel(run, 'instrument.qualified')).toBe('Instrument: qualified, status label checked (periodic review in date)');
    expect(fieldLabel(run, qualKey('instrument'))).toBe('Instrument: qualification');
  });
});

describe('LIMS-12 Qualification: only qualified instruments are used', () => {
  let b: { id: number; analysisNo: string };
  beforeAll(async () => {
    b = await issue();
    await weighed(b.id, '50.2');
    await act('asha', b.id, RUN, 'start');
  });

  it('PL-08 the link reads Qualification live: absent without a URL, down when refused, ok with the row as it is now', async () => {
    expect((await links().qual.status('eq-hplc')).state).toBe('absent');
    expect(await t.app.links.qual.status('eq-hplc')).toMatchObject({ state: 'ok', value: { code: 'HPLC-01', status: 'qualified', nextReviewDue: '2099-12-31', conditions: null } });
    expect(await t.app.links.qual.status('eq-hplc6')).toEqual({ state: 'ok', value: null });
    await t.owner.unsafe(`revoke select on all tables in schema ${S.ql} from lims_app`);
    try {
      expect((await t.app.links.qual.status('eq-hplc')).state).toBe('down');
    } finally { await t.owner.unsafe(`grant select on all tables in schema ${S.ql} to lims_app`); }
  });

  it('LIMS-12 an instrument not qualified, due for requalification, past its periodic review, or not in Qualification is refused', async () => {
    expect(await problems(record(b.id, RUN, { instrument: 'eq-hplc2' }))).toEqual(['HPLC-02 is not qualified (Qualification): only a qualified instrument may be used.']);
    expect(await problems(record(b.id, RUN, { instrument: 'eq-hplc3' }))).toEqual(['HPLC-03 is due for requalification (Qualification): only a qualified instrument may be used.']);
    expect(await problems(record(b.id, RUN, { instrument: 'eq-hplc4' }))).toEqual(['HPLC-04: its periodic review was due on 31 Jan 2020 (Qualification): it may not be used until it is reviewed.']);
    expect(await problems(record(b.id, RUN, { instrument: 'eq-hplc6' }))).toEqual(['HPLC-06 is not in Qualification, so it cannot be used.']);
    expect((await stepOf(b.id, RUN)).values.instrument).toBeUndefined();
  });

  it('LIMS-12 qualified with conditions is used, its conditions shown with the value (null-safe until Qualification publishes them)', async () => {
    expect((await record(b.id, RUN, { instrument: 'eq-hplc5' })).statusCode).toBe(200);
    expect((await stepOf(b.id, RUN)).source[qualKey('instrument')]).toMatchObject({ from: 'qual',
      shown: 'HPLC-05: qualified with conditions, periodic review due 2099-12-31; conditions: see Qualification before use' });
    await t.owner.unsafe(`alter table ${S.ql}.qualification_v1 add column conditions text`);
    try {
      await t.owner.unsafe(`update ${S.ql}.qualification_v1 set conditions = 'Isocratic runs only' where master_id = 'eq-hplc5'`);
      expect((await record(b.id, RUN, { instrument: 'eq-hplc5' })).statusCode).toBe(200);
      expect((await stepOf(b.id, RUN)).source[qualKey('instrument')]!.shown).toMatch(/; conditions: Isocratic runs only$/);
    } finally { await t.owner.unsafe(`alter table ${S.ql}.qualification_v1 drop column conditions`); }
  });

  it('LIMS-12 a qualified instrument, fit for use in the Logbook, is pulled with both: no label questions, no extra check', async () => {
    expect((await record(b.id, RUN, { instrument: 'eq-hplc', runId: 'SEQ-001', asWritten: 'yes' })).statusCode).toBe(200);
    const s = await stepOf(b.id, RUN);
    expect(s.source.instrument).toMatchObject({ from: 'logbook', shown: 'HPLC-01: clean' });
    expect(s.source[qualKey('instrument')]).toMatchObject({ from: 'qual', shown: 'HPLC-01: qualified, periodic review due 2099-12-31' });
    expect(s.handFields).toEqual([]);
    expect((await sign('asha', b.id, RUN, 'done')).statusCode).toBe(200);
    expect((await stepOf(b.id, RUN)).state).toBe('done');
  });

  it('LIMS-12 the pick list: Qualification\'s instruments with why each may not be used today; down, none (every one offered, answered by hand)', async () => {
    const read = async () => (await as('asha', 'GET', '/api/qual/instruments')).json() as { link: string; items: { id: string; problem: string | null }[] };
    const r = await read();
    expect(r.link).toBe('ok');
    const hplcs = t.master.equipment_.filter((m) => m.type === 'hplc');
    const picks = inQualification(hplcs, r.items);
    expect(picks.offered.map((m) => m.code)).toEqual(['HPLC-01', 'HPLC-05']);
    expect(picks.leftOut).toEqual([
      'Not offered: HPLC-02 is not qualified (Qualification): only a qualified instrument may be used.',
      'Not offered: HPLC-03 is due for requalification (Qualification): only a qualified instrument may be used.',
      'Not offered: HPLC-04: its periodic review was due on 31 Jan 2020 (Qualification): it may not be used until it is reviewed.',
      'Not offered: HPLC-06 is not in Qualification, so it cannot be used.']);
    await t.owner.unsafe(`revoke select on all tables in schema ${S.ql} from lims_app`);
    try {
      expect(await read()).toEqual({ link: 'down', items: [] });
    } finally { await t.owner.unsafe(`grant select on all tables in schema ${S.ql} to lims_app`); }
    expect((await call(t.app, '', 'GET', '/api/qual/instruments')).statusCode).toBe(401);
  });

  it('PL-08 LIMS-12 Qualification down: the analyst answers "qualified, status label checked" by hand and a second person checks', async () => {
    const c = await issue();
    await weighed(c.id, '50.1');
    await act('asha', c.id, RUN, 'start');
    await t.owner.unsafe(`revoke select on all tables in schema ${S.ql} from lims_app`);
    try {
      expect((await record(c.id, RUN, { instrument: 'eq-hplc', runId: 'SEQ-002', asWritten: 'yes' })).statusCode).toBe(200);
    } finally { await t.owner.unsafe(`grant select on all tables in schema ${S.ql} to lims_app`); }
    const s = await stepOf(c.id, RUN);
    expect(s.source.instrument).toMatchObject({ from: 'logbook' });
    expect(s.source[qualKey('instrument')]).toEqual({ from: 'hand', link: 'qual', state: 'down' });
    expect(s.handFields.map((f) => f.name)).toEqual(['instrument.qualified']);
    expect(await problems(record(c.id, RUN, { 'instrument.qualified': 'no' }))).toEqual(['Instrument: qualified, status label checked (periodic review in date): if not, do not use it; use another, or raise a deviation.']);
    expect((await record(c.id, RUN, { 'instrument.qualified': 'yes' })).statusCode).toBe(200);
    expect((await sign('asha', c.id, RUN, 'done')).statusCode).toBe(200);
    // The run step has no checker of its own: the hand entry makes one.
    expect((await stepOf(c.id, RUN)).state).toBe('done_awaiting_check');
    expect((await sign('asha', c.id, RUN, 'check')).json()).toMatchObject({ error: 'own_work' });
    expect((await sign('ravi', c.id, RUN, 'check')).statusCode).toBe(200);
    const r = (await as('asha', 'GET', `/api/analyses/${c.id}/review`)).json() as { hand: { field: string; link: string; state: string }[] };
    expect(r.hand).toMatchObject([{ field: qualKey('instrument'), link: 'qual', state: 'down' }]);
  });

  it('LIMS-12 the use is published for the Logbook (instrument_use_v1): one row per analysis and instrument, ended when its steps are signed; a balance\'s use is the weighing', async () => {
    const uses = async (no: string) => t.owner.unsafe(`select batch_number, equipment_code, equipment_type, room_code, step, started_at, ended_at, step_name, use_id::text,
      equipment_master_id, read_at, data_as_of from ${t.schema}_report.instrument_use_v1 where batch_number = '${no}' order by equipment_code`);
    const rows = await uses(b.analysisNo);
    // HPLC-05 was recorded, then replaced by HPLC-01 in the same step: both were named on the step, both ended with it.
    expect(rows.map((r) => [r.equipment_code, r.equipment_type, r.room_code, r.step, r.equipment_master_id])).toEqual([
      ['BAL-01', 'balance', 'QCL-01', 's0/t0', 'eq-bal'], ['HPLC-01', 'hplc', 'QCL-01', 's0/t1', 'eq-hplc'], ['HPLC-05', 'hplc', 'QCL-01', 's0/t1', 'eq-hplc5']]);
    for (const r of rows) {
      expect(r.ended_at).not.toBeNull();
      expect(r.ended_at.getTime()).toBeGreaterThanOrEqual(r.started_at.getTime());
      expect(r.use_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(rows[1]!.step_name).toBe('Stage 0 › Instrument run');
    // An instrument recorded on a step not yet signed is in use by the analysis; a balance never is.
    const c = await issue();
    await weighed(c.id, '50.3');
    await act('asha', c.id, RUN, 'start');
    expect((await record(c.id, RUN, { instrument: 'eq-hplc' })).statusCode).toBe(200);
    const open = await uses(c.analysisNo);
    expect(open.map((r) => [r.equipment_code, r.ended_at === null])).toEqual([['BAL-01', false], ['HPLC-01', true]]);
    // The view's columns as the Logbook reads them, in this order; new ones only at the end.
    const cols = await t.owner.unsafe(`select column_name from information_schema.columns where table_schema = '${t.schema}_report' and table_name = 'instrument_use_v1' order by ordinal_position`);
    expect(cols.map((x) => x.column_name)).toEqual(['batch_number', 'equipment_code', 'equipment_type', 'room_code', 'step', 'started_at', 'ended_at', 'read_at',
      'data_as_of', 'step_name', 'use_id', 'equipment_master_id']);
  });
});
