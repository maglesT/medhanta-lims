import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../server/db.js';
import { links } from '../server/links.js';
import { sampleRefusal, sampleStatus, type SampleEvent } from '../shared/engine/sample.js';
import { call, freshApp, login, proofFor, seedUser, TEST_DATABASE_URL, type TestApp } from './helpers.js';

// Samples (LIMS-05, LIMS-07): registered from an MMS lot or a TrueBatch batch waiting to be sampled, against the
// effective specification; by hand only while the link is absent or down, then checked by a second person; then a
// chain of custody of insert-only entries, its status computed.

// ---- The status (shared/engine/sample.ts) ----
const ev = (kind: SampleEvent['kind'], person = 1, payload: SampleEvent['payload'] = {}): SampleEvent => ({ kind, person, payload });
const pulled = { registeredBy: 1, byHand: false };
const typed = { registeredBy: 1, byHand: true };

describe('the status of a sample', () => {
  it('LIMS-07 registered, received, stored or handed over (the last place counts), disposed', () => {
    expect(sampleStatus(pulled, [])).toBe('registered');
    expect(sampleStatus(pulled, [ev('received')])).toBe('received');
    expect(sampleStatus(pulled, [ev('received'), ev('stored')])).toBe('stored');
    expect(sampleStatus(pulled, [ev('received'), ev('stored'), ev('handed_over')])).toBe('handed over');
    expect(sampleStatus(pulled, [ev('received'), ev('handed_over'), ev('stored')])).toBe('stored');
    expect(sampleStatus(pulled, [ev('received'), ev('note'), ev('disposed')])).toBe('disposed');
  });

  it('LIMS-50 a sample typed by hand waits for a second person\'s check', () => {
    expect(sampleStatus(typed, [])).toBe('waiting for check');
    expect(sampleStatus(typed, [ev('checked', 2)])).toBe('registered');
  });

  it('LIMS-07 the order of the entries: received after registration (and the check), stored or handed over after received, nothing after disposal', () => {
    expect(sampleRefusal('store', pulled, [], 1)).toBe('Receive the sample in QC first.');
    expect(sampleRefusal('hand-over', pulled, [], 1)).toBe('Receive the sample in QC first.');
    expect(sampleRefusal('receive', pulled, [], 1)).toBeNull();
    expect(sampleRefusal('receive', pulled, [ev('received')], 1)).toBe('The sample is already received in QC.');
    expect(sampleRefusal('receive', typed, [], 2)).toMatch(/second person checks it before it is received/);
    expect(sampleRefusal('store', pulled, [ev('received')], 1)).toBeNull();
    for (const a of ['receive', 'store', 'hand-over', 'dispose', 'note', 'check'] as const) {
      expect(sampleRefusal(a, pulled, [ev('received'), ev('disposed')], 2)).toBe('The sample is disposed of: nothing more is recorded.');
    }
  });

  it('LIMS-41 the person who typed a sample in cannot check it; a pulled sample has nothing to check', () => {
    expect(sampleRefusal('check', typed, [], 1)).toMatch(/cannot check it/);
    expect(sampleRefusal('check', typed, [], 2)).toBeNull();
    expect(sampleRefusal('check', typed, [ev('checked', 2)], 3)).toMatch(/already checked/);
    expect(sampleRefusal('check', pulled, [], 2)).toMatch(/nothing typed by hand/);
  });
});

// ---- On the server ----
let t: TestApp;
let provider: Sql;
const S = { mms: '', tb: '' };
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
const specs: Record<string, number> = {};
const item = (itemId: string, code: string, name: string) => ({ itemId, code, name, version: 1, active: true });

beforeAll(async () => {
  t = await freshApp(async (db) => {
    S.mms = `${db.schema}_mms`;
    S.tb = `${db.schema}_tb`;
    // MMS's lot_v1 and TrueBatch's batch_fact_v1, as tables with the same columns (the providers' contracts).
    await db.owner.unsafe(`
      create schema ${S.mms}; create schema ${S.tb};
      create table ${S.mms}.lot_v1 (lot_number text, kind text, material_master_id uuid, material_code text, product_master_id uuid, product_code text, status text,
        expiry_date date, retest_date date, qc_report_ref text, read_at timestamptz default now(), data_as_of timestamptz default now(), stock numeric, unit text);
      create table ${S.mms}.lot_test_v1 (lot_number text, report_ref text, test text, specification text, result text, value numeric, unit text, basis text,
        tested_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now());
      create table ${S.tb}.batch_fact_v1 (batch_id uuid default gen_random_uuid(), batch_number text, product_code text, strength text, record_kind text, status text,
        issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz default now(), data_as_of timestamptz default now(),
        product_name text, good_quantity numeric, good_unit text);
      grant usage on schema ${S.mms}, ${S.tb} to lims_app;
      grant select on all tables in schema ${S.mms}, ${S.tb} to lims_app;
      insert into ${S.mms}.lot_v1 (lot_number, kind, material_master_id, material_code, status, expiry_date, stock, unit) values
        ('RM-L1', 'material', '00000000-0000-0000-0000-00000000000a', 'RM-012', 'quarantine', '2099-01-31', 120, 'kg'),
        ('RM-L2', 'material', '00000000-0000-0000-0000-00000000000a', 'RM-012', 'under_test', '2099-01-31', 40, 'kg'),
        ('RM-L3', 'material', '00000000-0000-0000-0000-00000000000b', 'RM-020', 'quarantine', '2099-01-31', 5, 'kg'),
        ('RM-OK', 'material', '00000000-0000-0000-0000-00000000000a', 'RM-012', 'approved', '2099-01-31', 10, 'kg'),
        ('FG-Q', 'fg', null, null, 'quarantine', '2099-01-31', 1, 'box');
      insert into ${S.tb}.batch_fact_v1 (batch_number, product_code, product_name, record_kind, status, completed_at, released, good_quantity, good_unit) values
        ('B26001', 'FG-001', 'Examplol 500 mg tablets', 'PROCESSING', 'COMPLETED', now(), false, 98000, 'tablets'),
        ('B26002', 'FG-001', 'Examplol 500 mg tablets', 'PROCESSING', 'RELEASED', now(), true, 99000, 'tablets'),
        ('B26003', 'FG-001', 'Examplol 500 mg tablets', 'PROCESSING', 'IN_PRODUCTION', null, false, null, null),
        ('B26004', 'FG-001', 'Examplol 500 mg tablets', 'PROCESSING', 'REJECTED', now(), false, null, null);`);
    provider = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
    return links({ mms: provider, truebatch: provider }, { mms: S.mms, truebatch: S.tb });
  });
  t.master.materials_.push({ ...item('00000000-0000-0000-0000-00000000000a', 'RM-012', 'Examplol (active substance)'), category: 'API', unit: 'kg' },
    { ...item('00000000-0000-0000-0000-00000000000b', 'RM-020', 'Lactose monohydrate'), category: 'excipient', unit: 'kg' });
  t.master.products_.push({ ...item('prd-1', 'FG-001', 'Examplol 500 mg tablets'), strength: '500 mg', dosageForm: 'tablet' });
  const people = {
    author: ['lims.master.author'], sampler: ['lims.sample.register'], sampler2: ['lims.sample.register'],
    viewer: ['lims.view'], analyst: ['lims.analysis.perform'],
  } as const;
  for (const [name, perms] of Object.entries(people)) {
    ids[name] = await seedUser(t.owner, name, [...perms]);
    cookies[name] = (await login(t.app, name)).cookie;
  }
  // The specifications: RM-012 (effective, then a draft of version 2), FG-001 (effective); RM-020 has none.
  const header = (of: string, itemId: string, number: string, type: string) => ({ of, itemId, code: '', name: '', type, number, pharmacopoeia: 'Ph. Int.' });
  const test = { key: 'assay', name: 'Assay', method: { masterId: 1, code: 'QC-M-001', name: 'Assay by HPLC' }, result: 'run/result/result', limitType: 'range',
    limit: { low: '98.0', high: '102.0', unit: '%' }, values: {}, use: 'release and stability' };
  for (const [k, doc] of [['rm', { header: header('material', '00000000-0000-0000-0000-00000000000a', 'SPEC-RM-012', 'Raw material'), tests: [test] }],
    ['fg', { header: header('product', 'prd-1', 'SPEC-FG-001', 'Finished product'), tests: [test] }]] as const) {
    const r = await as('author', 'POST', '/api/masters', { kind: 'spec', doc });
    expect(r.statusCode, r.body).toBe(200);
    specs[k] = (r.json() as { id: number }).id;
    for (const s of ['in_review', 'approved', 'effective']) await t.owner`update master_versions set state = ${s} where id = ${specs[k]!}`;
  }
  const [rm] = await t.owner<{ master_id: number }[]>`select master_id::int from master_versions where id = ${specs.rm!}`;
  specs.rmDraft = (await as('author', 'POST', `/api/masters/${rm!.master_id}/versions`, {})).json().id;
});
afterAll(async () => {
  await provider?.end();
  for (const s of Object.values(S)) if (s) await t.owner.unsafe(`drop schema if exists ${s} cascade`);
  await t?.close();
});

const as = (who: string, method: 'GET' | 'POST', url: string, body?: object) => call(t.app, cookies[who]!, method, url, body);
const registerLot = (lot: string, over: object = {}) => as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: lot, specVersionId: specs.rm, quantity: '120 g', containers: 3, purpose: 'release', ...over });
const detail = async (id: number, who = 'sampler') => (await as(who, 'GET', `/api/samples/${id}`)).json() as {
  status: string; actions: string[]; refusals: Record<string, string | null>; contentHash: string;
  sample: { sampleNo: string; source: { from: string; state?: string; shown?: string }; item: { code: string; name: string }; quantity: string };
  spec: { number?: string; versionNo: number; header: { number: string }; tests: { name: string }[] };
  events: { kind: string; personName: string; at: string; payload: Record<string, string>; signature: { printedName: string } | null }[];
};
const entry = (who: string, id: number, action: string, body: object = {}) => as(who, 'POST', `/api/samples/${id}/${action}`, body);
const cut = (schema: string) => t.owner.unsafe(`revoke select on all tables in schema ${schema} from lims_app`);
const restore = (schema: string) => t.owner.unsafe(`grant select on all tables in schema ${schema} to lims_app`);
const plantYY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(2, 4);

describe('samples waiting to be sampled (PL-08: pulled from MMS and TrueBatch)', () => {
  it('PL-08 the MMS material lots in quarantine or under test and the unreleased TrueBatch batches (in production or completed, not rejected) wait, each with its effective specification or why none', async () => {
    const r = await as('sampler', 'GET', '/api/sample-requests');
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { links: Record<string, string>; requests: { source: string; lotNo: string; code: string; specs: { id: number; number: string }[]; noSpec: string | null; shown: string }[] };
    expect(body.links).toEqual({ mms: 'ok', truebatch: 'ok' });
    expect(body.requests.map((x) => [x.source, x.lotNo])).toEqual([['mms', 'RM-L1'], ['mms', 'RM-L2'], ['mms', 'RM-L3'], ['truebatch', 'B26001'], ['truebatch', 'B26003']]);
    const [l1, , l3, b1] = body.requests;
    expect(l1!.specs.map((s) => [s.id, s.number])).toEqual([[specs.rm, 'SPEC-RM-012']]);
    expect(l1!.shown).toMatch(/^MMS lot RM-L1: RM-012, quarantine, expiry 31 Jan 2099/);
    expect(l3).toMatchObject({ specs: [], noSpec: 'No effective specification for RM-020.' });
    expect(b1!.specs.map((s) => s.id)).toEqual([specs.fg]);
  });

  it('PL-08 a link that is down is said plainly; the other still answers', async () => {
    await cut(S.tb);
    try {
      const body = (await as('sampler', 'GET', '/api/sample-requests')).json() as { links: Record<string, string>; requests: { source: string }[] };
      expect(body.links).toEqual({ mms: 'ok', truebatch: 'down' });
      expect(body.requests.every((x) => x.source === 'mms')).toBe(true);
    } finally { await restore(S.tb); }
  });
});

describe('registering a sample', () => {
  let first: { id: number; sampleNo: string };

  it('LIMS-05 an authorised person registers a sample of a waiting MMS lot against the effective specification; the lot is read again now, its facts kept', async () => {
    const r = await registerLot('RM-L1');
    expect(r.statusCode, r.body).toBe(200);
    first = r.json();
    expect(first.sampleNo).toMatch(new RegExp(`^LS${plantYY()}\\d{5}$`));
    const d = await detail(first.id);
    expect(d.status).toBe('registered');
    expect(d.sample).toMatchObject({ item: { code: 'RM-012', name: 'Examplol (active substance)' }, quantity: '120 g', source: { from: 'mms' } });
    expect(d.sample.source.shown).toMatch(/^MMS lot RM-L1: RM-012, quarantine/);
    expect(d.spec).toMatchObject({ versionNo: 1, header: { number: 'SPEC-RM-012' }, tests: [{ name: 'Assay' }] });
  });

  it('LIMS-05 sample numbers LS + plant year + 5 digits come one after another and are never reused', async () => {
    const second = (await registerLot('RM-L2')).json() as { sampleNo: string };
    expect(Number(second.sampleNo.slice(4))).toBe(Number(first.sampleNo.slice(4)) + 1);
    const nos = await t.owner<{ n: number; d: number }[]>`select count(*)::int as n, count(distinct sample_no)::int as d from samples`;
    expect(nos[0]!.n).toBe(nos[0]!.d);
    await expect(t.owner`insert into samples (sample_no, spec_version_id, lot_no, item, source, quantity, registered_by)
      values (${first.sampleNo}, ${specs.rm!}, 'X', '{}', '{}', '1 g', ${ids.sampler!})`).rejects.toThrow(/duplicate key/);
  });

  it('LIMS-05 a lot already sampled for release is not offered again and cannot be registered twice for release; a retest sample may follow', async () => {
    const r = await registerLot('RM-L1');
    expect(r.statusCode).toBe(409);
    expect(r.json().problems).toEqual([`Lot RM-L1 already has its release sample ${first.sampleNo}.`]);
    const req = (await as('sampler', 'GET', '/api/sample-requests')).json() as { requests: { lotNo: string; sampleNo: string | null }[] };
    expect(req.requests.find((x) => x.lotNo === 'RM-L1')!.sampleNo).toBe(first.sampleNo);
    expect((await registerLot('RM-L1', { purpose: 'investigation' })).statusCode).toBe(200);
  });

  it('LIMS-31 a lot MMS sent back to QC (its release sample decided, the lot in quarantine again) is offered for a retest sample, once', async () => {
    type Req = { lotNo: string; sampleNo: string | null; releaseDecided?: boolean; retestNo?: string | null };
    const lot = async () => ((await as('sampler', 'GET', '/api/sample-requests')).json() as { requests: Req[] }).requests.find((x) => x.lotNo === 'RM-L1')!;
    expect(await lot()).toMatchObject({ sampleNo: first.sampleNo, releaseDecided: false, retestNo: null });
    await t.owner`insert into sample_events (sample_id, kind, payload, person_id) values (${first.id}, 'approved', ${t.owner.json({ coaNo: 'COA-T-SB', results: [] } as never)}, ${ids.sampler!})`;
    expect(await lot()).toMatchObject({ sampleNo: first.sampleNo, releaseDecided: true, retestNo: null });
    const r = await registerLot('RM-L1', { purpose: 'retest' });
    expect(r.statusCode, r.body).toBe(200);
    expect(await lot()).toMatchObject({ releaseDecided: true, retestNo: r.json().sampleNo });
    expect((await registerLot('RM-L1', { purpose: 'retest' })).json().problems).toEqual([`Lot RM-L1 already has its retest sample ${r.json().sampleNo}, waiting for QC's decision.`]);
  });

  it('LIMS-05 a lot that is not waiting (approved in MMS, or not in MMS) is refused', async () => {
    const r = await registerLot('RM-OK');
    expect(r.statusCode).toBe(409);
    expect(r.json().problems[0]).toMatch(/^Lot RM-OK is approved in MMS: only a lot in quarantine or under test waits to be sampled/);
    expect((await registerLot('NOPE')).json().problems).toEqual(['Lot NOPE is not in MMS.']);
  });

  it('LIMS-01 a sample is registered only against the effective specification of its item: none, a draft, or another item\'s is refused', async () => {
    const none = await registerLot('RM-L3');
    expect(none.statusCode).toBe(409);
    expect(none.json().problems[0]).toMatch(/^No effective specification for RM-020/);
    const draft = await registerLot('RM-L2', { specVersionId: specs.rmDraft, purpose: 'retest' });
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error).toBe('not_effective');
    expect((await registerLot('RM-L2', { specVersionId: specs.fg, purpose: 'retest' })).json().error).toBe('not_effective');
  });

  it('LIMS-05 the quantity with its unit and a purpose from the list are needed', async () => {
    expect((await registerLot('RM-L2', { quantity: 'some', purpose: 'retest' })).statusCode).toBe(400);
    expect((await registerLot('RM-L2', { quantity: '', purpose: 'retest' })).statusCode).toBe(400);
    expect((await registerLot('RM-L2', { purpose: 'whenever' })).statusCode).toBe(400);
  });

  it('LIMS-05 a finished-product sample of a TrueBatch batch (completed, or its bulk in production), against the product\'s effective specification; a released or rejected batch is refused', async () => {
    const r = await as('sampler', 'POST', '/api/samples', { source: 'truebatch', batchNumber: 'B26001', specVersionId: specs.fg, quantity: '60 tablets', purpose: 'release' });
    expect(r.statusCode, r.body).toBe(200);
    const d = await detail(r.json().id);
    expect(d.sample).toMatchObject({ item: { code: 'FG-001' }, source: { from: 'truebatch' } });
    expect(d.sample.source.shown).toMatch(/^TrueBatch Tablets batch B26001: FG-001 Examplol 500 mg tablets, completed, completed .*, 98,000 tablets made$/);
    for (const [no, why] of [['B26002', 'already released'], ['B26004', 'rejected']]) {
      const x = await as('sampler', 'POST', '/api/samples', { source: 'truebatch', batchNumber: no, specVersionId: specs.fg, quantity: '60 tablets', purpose: 'release' });
      expect(x.statusCode).toBe(409);
      expect(x.json().problems[0]).toContain(why);
    }
  });
});

describe('registering by hand while a link is down (LIMS-50)', () => {
  const byHand = (over: object = {}) => as('sampler', 'POST', '/api/samples', { source: 'mms', lotNumber: 'RM-H1', byHand: true, itemId: '00000000-0000-0000-0000-00000000000a',
    specVersionId: specs.rm, quantity: '50 g', purpose: 'release', ...over });

  it('LIMS-50 a sample is typed by hand only while its link is absent or down; while it answers, it is pulled', async () => {
    const r = await byHand();
    expect(r.statusCode).toBe(409);
    expect(r.json().problems).toEqual(['MMS answers: register the lot from the list of those waiting to be sampled.']);
  });

  it('LIMS-41 typed by hand while MMS is down, marked so, and checked by a second person, never by the person who typed it, before it is received', async () => {
    await cut(S.mms);
    let id = 0;
    try {
      // Pulling is not possible while the link is down.
      expect((await registerLot('RM-L2', { purpose: 'retest' })).json().error).toBe('link_off');
      const r = await byHand();
      expect(r.statusCode, r.body).toBe(200);
      id = r.json().id;
    } finally { await restore(S.mms); }
    const d = await detail(id);
    expect(d.status).toBe('waiting for check');
    expect(d.sample.source).toEqual({ from: 'hand', link: 'mms', state: 'down' });
    expect(d.refusals.receive).toMatch(/second person checks it/);
    const own = await entry('sampler', id, 'check');
    expect(own.statusCode).toBe(403);
    expect(own.json().problems[0]).toMatch(/cannot check it: a second person checks it/);
    expect((await entry('sampler', id, 'receive', { condition: 'Sealed' })).statusCode).toBe(409);
    expect((await entry('sampler2', id, 'check')).statusCode).toBe(200);
    expect((await detail(id)).status).toBe('registered');
    expect((await entry('sampler', id, 'receive', { condition: 'Sealed, labelled' })).statusCode).toBe(200);
  });

  it('LIMS-50 by hand, the item must be an active material of master data and its effective specification is still needed', async () => {
    await cut(S.mms);
    try {
      expect((await byHand({ itemId: 'nothing' })).statusCode).toBe(409);
      expect((await byHand({ lotNumber: 'RM-H2', itemId: '00000000-0000-0000-0000-00000000000b' })).json().error).toBe('no_spec');
    } finally { await restore(S.mms); }
  });
});

describe('the chain of custody (LIMS-07)', () => {
  let id: number;
  beforeAll(async () => {
    const r = await registerLot('RM-L2', { purpose: 'retest' });
    expect(r.statusCode, r.body).toBe(200);
    id = r.json().id;
  });

  it('LIMS-07 received, stored, handed over and disposed of, in that order, each with who and the server\'s time', async () => {
    expect((await entry('sampler', id, 'store', { where: 'Shelf B2' })).json().problems).toEqual(['Receive the sample in QC first.']);
    expect((await entry('sampler', id, 'receive', { condition: 'Sealed, 3 containers' })).statusCode).toBe(200);
    expect((await entry('sampler', id, 'receive', { condition: 'Again' })).statusCode).toBe(409);
    expect((await entry('sampler2', id, 'store', { where: 'Sample store, shelf B2' })).statusCode).toBe(200);
    expect((await detail(id)).status).toBe('stored');
    expect((await entry('sampler2', id, 'hand-over', { to: 'Wet chemistry section' })).statusCode).toBe(200);
    expect((await entry('sampler', id, 'note', { text: 'One container opened for the identity test' })).statusCode).toBe(200);
    const d = await detail(id, 'viewer');
    expect(d.status).toBe('handed over');
    expect(d.events.map((e) => [e.kind, e.personName])).toEqual([['received', 'SAMPLER'], ['stored', 'SAMPLER2'], ['handed_over', 'SAMPLER2'], ['note', 'SAMPLER']]);
    expect(d.events[1]!.payload).toEqual({ where: 'Sample store, shelf B2' });
    expect(d.events.every((e) => Math.abs(Date.parse(e.at) - Date.now()) < 60_000)).toBe(true);
  });

  it('LIMS-47 disposal is an e-signature with its reason and method; nothing is recorded after it', async () => {
    const hash = (await detail(id)).contentHash;
    const bad = await entry('sampler', id, 'dispose', { reason: 'Testing complete', method: 'Chemical waste', proof: 'nope', contentHash: hash });
    expect(bad.statusCode).toBe(401);
    const stale = await entry('sampler', id, 'dispose', { reason: 'Testing complete', method: 'Chemical waste', proof: proofFor('sampler'), contentHash: '0'.repeat(64) });
    expect(stale.statusCode).toBe(409);
    const ok = await entry('sampler', id, 'dispose', { reason: 'Testing complete', method: 'Chemical waste', proof: proofFor('sampler'), contentHash: hash });
    expect(ok.statusCode, ok.body).toBe(200);
    const d = await detail(id);
    expect(d.status).toBe('disposed');
    expect(d.events.at(-1)).toMatchObject({ kind: 'disposed', payload: { reason: 'Testing complete', method: 'Chemical waste' }, signature: { printedName: 'SAMPLER', meaning: 'disposed' } });
    const [sig] = await t.owner<{ meaning: string }[]>`select meaning from signatures where object_type = 'sample_event' and object_id = (select max(id) from sample_events)`;
    expect(sig!.meaning).toBe('disposed');
    expect(d.actions).toEqual([]);
    expect((await entry('sampler', id, 'note', { text: 'After' })).json().problems).toEqual(['The sample is disposed of: nothing more is recorded.']);
  });

  it('LIMS-45 every registration and entry is in the audit trail with who and what, a refused signature too', async () => {
    const rows = await t.owner<{ action: string; actor: string }[]>`
      select a.action, u.username as actor from audit_log a join users u on u.id = a.actor_id where a.object_type = 'sample' and a.object_id = ${String(id)} order by a.id`;
    expect(rows.map((r) => [r.action, r.actor])).toEqual([['sample.registered', 'sampler'], ['sample.received', 'sampler'], ['sample.stored', 'sampler2'],
      ['sample.handed_over', 'sampler2'], ['sample.note', 'sampler'], ['signature.failed', 'sampler'], ['sample.disposed', 'sampler']]);
    const signed = await t.owner`select 1 from audit_log where action = 'signed.disposed' and object_type = 'sample_event'`;
    expect(signed.length).toBe(1);
  });

  it('LIMS-46 samples and their entries are insert-only: nothing is changed or deleted', async () => {
    await expect(t.owner`update samples set quantity = '1 g' where id = ${id}`).rejects.toThrow();
    await expect(t.owner`delete from samples where id = ${id}`).rejects.toThrow();
    await expect(t.owner`update sample_events set payload = '{}' where sample_id = ${id}`).rejects.toThrow();
    await expect(t.owner`delete from sample_events where sample_id = ${id}`).rejects.toThrow();
    await expect(t.sql`update samples set quantity = '1 g' where id = ${id}`).rejects.toThrow();
  });
});

describe('who may do what (LIMS-43)', () => {
  it('LIMS-43 only lims.sample.register registers samples and records entries; lims.view reads them; others neither', async () => {
    const [s] = await t.owner<{ id: number }[]>`select id::int from samples order by id limit 1`;
    expect((await as('viewer', 'GET', '/api/samples')).statusCode).toBe(200);
    expect((await as('viewer', 'GET', `/api/samples/${s!.id}`)).json().refusals.note).toMatch(/do not have the right/);
    expect((await as('viewer', 'GET', '/api/sample-requests')).statusCode).toBe(403);
    expect((await as('viewer', 'POST', '/api/samples', { source: 'mms', lotNumber: 'RM-L2', specVersionId: specs.rm, quantity: '1 g', purpose: 'retest' })).statusCode).toBe(403);
    expect((await entry('viewer', s!.id, 'note', { text: 'x' })).statusCode).toBe(403);
    expect((await as('analyst', 'GET', '/api/samples')).statusCode).toBe(403);
    const list = (await as('sampler', 'GET', '/api/samples')).json() as { sampleNo: string; status: string }[];
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list.every((x) => /^LS\d{7}$/.test(x.sampleNo) && x.status)).toBe(true);
  });
});
