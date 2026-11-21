import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { connect, type Sql } from '../server/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from '../server/app.js';
import type { Identity, SignOn } from '../server/signon.js';
import { MEANINGS, makeProof } from '../server/signatures.js';
import { ConnectionOff, type Master, type MasterEquipment, type MasterMaterial, type MasterProduct, type MasterRoom, type MasterSupplier } from '../server/master.js';
import type { Permission } from '../server/auth.js';
import type { Links } from '../server/links.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://lims_owner:dev@localhost:5432/lims_test';

export interface TestDb {
  // Owner connection: migrations and test setup only.
  owner: Sql;
  // Restricted application connection, as the app uses it in production.
  sql: Sql;
  schema: string;
  close: () => Promise<void>;
}

// A fresh schema per test file keeps files independent when Vitest runs them in parallel.
export async function freshDb(): Promise<TestDb> {
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const owner = connect(TEST_DATABASE_URL, { searchPath: schema });
  await owner.unsafe(`create schema ${schema}`);
  await migrate(owner);
  const sql = connect(TEST_DATABASE_URL, { role: 'lims_app', searchPath: schema });
  return {
    owner,
    sql,
    schema,
    close: async () => {
      await sql.end();
      await owner.unsafe(`drop schema ${schema} cascade`);
      await owner.unsafe(`drop schema if exists ${schema}_report cascade`);
      await owner.end();
    },
  };
}

export interface TestApp extends TestDb {
  app: FastifyInstance;
  master: FakeMaster;
}

// Stand-in for master_data's views: tests add, retire items and cut the link.
export interface FakeMaster extends Master {
  products_: MasterProduct[];
  materials_: MasterMaterial[];
  equipment_: MasterEquipment[];
  rooms_: MasterRoom[];
  suppliers_: MasterSupplier[];
  uses_: { product: string; material: string }[];   // product code → material code
  cut: boolean;
}
const ROOMS = [['DSP-01', 'Dispensing'], ['GRN-01', 'Granulation'], ['CMP-01', 'Compression'], ['COT-01', 'Coating'], ['PK-01', 'Packing'], ['PK-02', 'Packing']] as const;
export function fakeMaster(): FakeMaster {
  const read = <T>(rows: () => T[]) => async () => { if (m.cut) throw new ConnectionOff(); return rows().map((r) => ({ ...r })); };
  const m: FakeMaster = {
    // The rooms the fixtures' machines stand in, by area (shared/engine/picks.ts); tests add their own.
    products_: [], materials_: [], equipment_: [], rooms_: ROOMS.map(([code, area]) => ({ itemId: `room-${code}`, code, name: `${area} room`, version: 1, active: true, area, grade: 'D' })), suppliers_: [], uses_: [], cut: false,
    usedBy: async (code: string) => { if (m.cut) throw new ConnectionOff(); return m.products_.filter((p) => p.active && m.uses_.some((u) => u.material === code && u.product === p.code)).map((p) => ({ code: p.code, name: p.name })); },
    products: read(() => m.products_), materials: read(() => m.materials_), equipment: read(() => m.equipment_), rooms: read(() => m.rooms_), suppliers: read(() => m.suppliers_),
  };
  return m;
}

// Stand-in for Medhanta core: the people core knows, by login, with their Medhanta LIMS permissions. Tests change an entry
// to revoke a permission or deactivate someone (`active: false`); renewals then see it, as core's would.
export const directory = new Map<string, Omit<Identity, 'login' | 'refreshToken' | 'idToken'> & { active: boolean }>();

export function fakeSignOn(people = directory): SignOn {
  const who = (login: string): Identity => {
    const p = people.get(login);
    if (!p?.active) throw new Error('sign-on refused');
    return { ...p, login, permissions: [...p.permissions], refreshToken: login, idToken: `id-${login}`, authTime: Math.floor(Date.now() / 1000) };
  };
  return {
    // Core would ask for the password; the stand-in signs in whoever login_hint names.
    authUrl: ({ state, loginHint }) => `/cb?${new URLSearchParams({ state, code: loginHint ?? '' })}`,
    exchange: async (code) => who(code),
    refresh: async (token) => who(token),
    // Core's end-session page; here a page of the app itself, so browser tests stay on the test server.
    logoutUrl: (idToken) => `/?signed-out=${idToken ?? ''}`,
    // Core's signed logout token; the stand-in's is "logout:<sub>" (the real check is in test/backchannel.test.ts).
    verifyLogoutToken: async (token) => {
      if (!token.startsWith('logout:') || token.length <= 7) throw new Error('logout token: invalid');
      return { sub: token.slice(7) };
    },
  };
}

// Signing proofs (PL-05): what /cb makes after core re-authenticated the person, for the stand-in's people.
export const TEST_PROOF_KEY = Buffer.alloc(32, 7);
export function proofFor(username: string, at?: number, meanings: string[] = [...MEANINGS]): string {
  const p = directory.get(username);
  return makeProof(TEST_PROOF_KEY, { sub: p?.sub ?? '00000000-0000-0000-0000-000000000000', permissions: p?.permissions ?? [] }, meanings, at);
}

// withLinks: the links to the other products (test/links.test.ts); without, every link is absent.
export async function freshApp(withLinks?: (db: TestDb) => Promise<Links>, demo = false): Promise<TestApp> {
  const db = await freshDb();
  const master = fakeMaster();
  const links = withLinks ? await withLinks(db) : undefined;
  const app = await buildApp({ sql: db.sql, signOn: fakeSignOn(), proofKey: TEST_PROOF_KEY, master, links, webRoot: '/nonexistent', demo });
  return {
    ...db,
    app,
    master,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

// Seeds a person as core knows them (directory), with their Medhanta LIMS permissions, and their id-map row.
export async function seedUser(owner: Sql, username: string, permissions: readonly Permission[]): Promise<number> {
  const sub = randomUUID();
  directory.set(username, { sub, name: username.toUpperCase(), permissions: [...permissions], active: true });
  const [u] = await owner<{ id: number }[]>`
    insert into users (employee_id, username, full_name) values (${sub}, ${username}, ${username.toUpperCase()}) returning id::int`;
  return u!.id;
}

// Signs on through the stand-in for core: /login, then /cb.
export async function login(app: FastifyInstance, username: string) {
  const start = await app.inject({ method: 'GET', url: `/login?login_hint=${encodeURIComponent(username)}` });
  const pending = start.cookies.find((c) => c.name === 'signon');
  const res = await app.inject({ method: 'GET', url: String(start.headers.location), headers: { cookie: `signon=${pending?.value ?? ''}` } });
  const cookie = res.cookies.find((c) => c.name === 'sid');
  return { res, cookie: cookie ? `sid=${cookie.value}` : '' };
}

// JSON request helper carrying the session cookie.
export function call(app: FastifyInstance, cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(method === 'GET' ? {} : { payload: payload ?? {} }) });
}

// The label questions of a machine, room or lot entered by hand (no Logbook or MMS link), all answered yes.
export function handLabels(field: string, kind: 'machine' | 'room' | 'lot'): Record<string, string> {
  const names = { machine: ['clean', 'calibrated', 'inService', 'qualified'], room: ['clean', 'inService', 'qualified'], lot: ['released'] }[kind];
  return { ...Object.fromEntries(names.map((n) => [`${field}.${n}`, 'yes'])), ...(kind === 'lot' ? { [`${field}.expiry`]: '2099-12-31' } : {}) };
}

/**
 * LIMS-02 in the tests that are not about it: before a method version is made effective, the database owner records it
 * as validated outside LIMS (paper report) and approved, as the e2e journeys make versions effective by the owner.
 * The rule itself is proven through the screens' routes in test/method-validation.test.ts. Specifications, protocols,
 * plans and validation worksheets need nothing.
 */
export async function validatedOutside(owner: Sql, versionId: number): Promise<void> {
  const [v] = await owner<{ masterId: number; versionNo: number; kind: string; use: string | null; origin: string | null }[]>`
    select master_id::int as "masterId", version_no as "versionNo", kind, doc->'header'->>'use' as use, doc->'header'->>'origin' as origin
    from master_versions where id = ${versionId}`;
  if (!v || v.kind !== 'method' || v.use === 'validation') return;
  const [u] = await owner<{ id: number }[]>`select id::int from users order by id limit 1`;
  const kind = v.origin === 'pharmacopoeial' ? 'verification' : v.origin === 'transferred' ? 'transfer' : 'validation';
  const [r] = await owner<{ id: number }[]>`
    insert into method_reports (report_no, kind, outside, method_master_id, method_version_id, method_version_no, test_type, reference, sending_lab, receiving_lab,
      inputs, outputs, conclusion, person_id)
    values (${`MVR99${String(versionId % 10000).padStart(4, '0')}`}, ${kind}, true, ${v.masterId}, ${versionId}, ${v.versionNo}, 'other (as the protocol says)', 'VAL-PAPER-01',
      ${kind === 'transfer' ? 'Sending lab' : null}, ${kind === 'transfer' ? 'Receiving lab' : null}, '{}', '{}', 'met', ${u!.id})
    on conflict (report_no) do nothing returning id::int`;
  if (r) await owner`insert into method_report_events (report_id, kind, person_id) values (${r.id}, 'approved', ${u!.id})`;
}
