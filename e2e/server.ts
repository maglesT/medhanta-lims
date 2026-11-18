// Starts the real app with the built UI on a fresh database schema for the browser tests. The test people are seeded;
// master data is an in-memory stand-in.
import { connect } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from '../server/app.js';
import globalSetup from '../test/global-setup.js';
import { TEST_DATABASE_URL, TEST_PROOF_KEY, fakeMaster, fakeSignOn, seedUser } from '../test/helpers.js';
import { E2E_MATERIAL_ID, E2E_MMS, E2E_PORT, E2E_QUAL, E2E_RECRUITMENT, E2E_SCHEMA, USERS } from './config.js';
import { links } from '../server/links.js';
import { seedMasterData } from './master-data.js';

await globalSetup();
const owner = connect(TEST_DATABASE_URL);
await owner.unsafe(`drop schema if exists ${E2E_SCHEMA} cascade`);
await owner.unsafe(`create schema ${E2E_SCHEMA}`);
await owner.end();

const schemaOwner = connect(TEST_DATABASE_URL, { searchPath: E2E_SCHEMA });
await migrate(schemaOwner);
for (const [username, permissions] of Object.entries(USERS)) await seedUser(schemaOwner, username, permissions);
await schemaOwner.end();

// The lab instruments and rooms of the journeys.
const master = fakeMaster();
seedMasterData(master);

// Recruitment's training_v1 (only trained people sign, owner 17 Nov 2026), a stand-in table in its own schema read with
// the app's login; MMS below; the other links are absent. op1 is trained in SOP-QC-012; chk1 is not.
const rc = connect(TEST_DATABASE_URL);
await rc.unsafe(`drop schema if exists ${E2E_RECRUITMENT} cascade; create schema ${E2E_RECRUITMENT};
  create table ${E2E_RECRUITMENT}.training_v1 (person_id uuid, person_login text, person_name text, skill_code text, skill_title text, trained_on date,
    valid_until date, qualified boolean, approved_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now());
  insert into ${E2E_RECRUITMENT}.training_v1 (person_login, person_name, skill_code, skill_title, trained_on, valid_until, qualified) values
    ('op1', 'Analyst One', 'SOP-QC-012', 'pH measurement', '2026-01-10', '2099-01-09', true);
  grant usage on schema ${E2E_RECRUITMENT} to lims_app; grant select on all tables in schema ${E2E_RECRUITMENT} to lims_app;`);
// MMS's lot_v1 and lot_test_v1 (the samples journey): a received lot of RM-012 in quarantine waits to be sampled.
await rc.unsafe(`drop schema if exists ${E2E_MMS} cascade; create schema ${E2E_MMS};
  create table ${E2E_MMS}.lot_v1 (lot_number text, kind text, material_master_id uuid, material_code text, product_master_id uuid, product_code text, status text,
    expiry_date date, retest_date date, qc_report_ref text, read_at timestamptz default now(), data_as_of timestamptz default now(), stock numeric, unit text);
  create table ${E2E_MMS}.lot_test_v1 (lot_number text, report_ref text, test text, specification text, result text, value numeric, unit text, basis text,
    tested_at timestamptz, read_at timestamptz default now(), data_as_of timestamptz default now());
  insert into ${E2E_MMS}.lot_v1 (lot_number, kind, material_master_id, material_code, status, expiry_date, stock, unit) values
    ('RM-E1', 'material', '${E2E_MATERIAL_ID}', 'RM-012', 'quarantine', '2029-10-31', 250, 'kg');
  grant usage on schema ${E2E_MMS} to lims_app; grant select on all tables in schema ${E2E_MMS} to lims_app;`);
// Qualification's qualification_v1 (LIMS-12): the lab instruments qualified, BAL-02 due for requalification.
await rc.unsafe(`drop schema if exists ${E2E_QUAL} cascade; create schema ${E2E_QUAL};
  create table ${E2E_QUAL}.qualification_v1 (item_id bigint, master_id text, code text, name text, kind text, status text, next_review_due date,
    status_since timestamptz default now(), status_source text, read_at timestamptz default now(), data_as_of timestamptz default now());
  insert into ${E2E_QUAL}.qualification_v1 (item_id, master_id, code, name, kind, status, next_review_due) values
    (1, 'eq-bal', 'BAL-01', 'Analytical balance 220 g', 'equipment', 'qualified', '2099-12-31'),
    (2, 'eq-son', 'SON-01', 'Ultrasonic bath', 'equipment', 'qualified', '2099-12-31'),
    (3, 'eq-ovn', 'OVN-01', 'Hot air oven', 'equipment', 'qualified', '2099-12-31'),
    (4, 'eq-hplc', 'HPLC-01', 'HPLC with UV detector', 'equipment', 'qualified', '2099-12-31'),
    (5, 'eq-bal2', 'BAL-02', 'Analytical balance 120 g', 'equipment', 'requalification_needed', null);
  grant usage on schema ${E2E_QUAL} to lims_app; grant select on all tables in schema ${E2E_QUAL} to lims_app;`);
await rc.end();

const sql = connect(TEST_DATABASE_URL, { role: 'lims_app', searchPath: E2E_SCHEMA });
const linked = connect(TEST_DATABASE_URL, { role: 'lims_app', link: true });
const app = await buildApp({ sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, master,
  links: links({ recruitment: linked, mms: linked, qual: linked }, { recruitment: E2E_RECRUITMENT, mms: E2E_MMS, qual: E2E_QUAL }),
  webRoot: new URL('../dist/web', import.meta.url).pathname, cookieSecure: false });
await app.listen({ port: E2E_PORT, host: '127.0.0.1' });
