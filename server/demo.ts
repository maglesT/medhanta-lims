import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connect, type Sql, type Tx } from './db.js';
import { audit } from './audit.js';
import { parseId, requirePermission } from './auth.js';
import { loadAnalysis, type LoadedAnalysis } from './routes/analyses.js';
import type { Product } from './product.js';
import { keyId, skipKey, skippable, timers, type Timer } from '../shared/engine/index.js';

// Demo installations only. The platform sets LIMS_DEMO=1 only for the demo customer's installation, never for a
// plant's: every screen then says DEMO, and a person with the demo permission (lims.demo.skip)
// may end a running wait at once (a minimum time, a periodic check, a hold time, a mixing
// time: its lower limit then counts as met, shared/engine/values.ts evaluate). Each skip is one insert-only step event,
// shown in the step history, QA's review and the analysis record PDF. Anywhere else the button is absent, the route
// answers 403 and the terminal command exits non-zero.
export const isDemo = (env: NodeJS.ProcessEnv = process.env) => env.LIMS_DEMO === '1';

const closed = (l: LoadedAnalysis) => l.analysisEvents.some((e) => ['reviewed', 'stopped'].includes(e.kind));

/** Ends a running wait at once: one insert-only event with who, when and which wait, and its audit row. */
async function skipWait(tx: Tx, l: LoadedAnalysis, t: Timer, person: number): Promise<boolean> {
  const k = skipKey(t);
  const payload = { timer: t.id, kind: t.kind, label: t.label, due: t.at.toISOString() };
  const [e] = await tx<{ id: number }[]>`
    insert into step_events (analysis_id, stage, sub, step, round, kind, payload, person_id)
    values (${l.analysis.id}, ${k.stage}, ${k.sub}, ${k.step}, ${k.round}, 'demo_wait_skipped', ${tx.json(payload)}, ${person})
    on conflict do nothing returning id::int`;
  if (e) await audit(tx, { actorId: person, action: 'step.demo_wait_skipped', objectType: 'analysis', objectId: l.analysis.id, new: { step: keyId(k), event: e.id, ...payload } });
  return !!e;
}

/** POST /api/analyses/:id/demo-skip { timer }: the "Skip wait (demo)" button. */
export function demoRoutes(app: FastifyInstance, sql: Sql) {
  app.post<{ Params: { id: string } }>('/api/analyses/:id/demo-skip', { preHandler: requirePermission('lims.demo.skip') }, async (req, reply) => {
    if (!app.demo) return reply.code(403).send({ error: 'not_demo', problems: ['This is not a demo installation: waits run on the server clock.'] });
    const id = parseId(req.params.id);
    const body = z.object({ timer: z.string().min(1).max(100) }).safeParse(req.body);
    if (id === null || !body.success) return reply.code(400).send({ error: 'invalid' });
    return sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${id}::bigint)`;
      const l = await loadAnalysis(tx, id);
      if (!l) return reply.code(404).send({ error: 'not_found' });
      if (closed(l)) return reply.code(409).send({ error: 'analysis_closed', problems: ['The analysis record is closed to changes.'] });
      const t = timers(l.doc, l.events, l.now).find((x) => x.id === body.data.timer);
      if (!t || !skippable(t)) return reply.code(409).send({ error: 'no_wait', problems: ['This wait is not running.'] });
      await skipWait(tx, l, t, req.user!.id);
      return { ok: true };
    });
  });
}

/** Every wait running now in the analysis (or in one of its stages: its key, name or number) skipped as the named person. */
export async function skipWaits(sql: Sql, analysisNo: string, stage: string | undefined, username: string): Promise<{ skipped: string[] } | { error: string }> {
  const [u] = await sql<{ id: number }[]>`select id::int from users where username = ${username}`;
  if (!u) return { error: `There is no person ${username} here: they sign in once first.` };
  const [b] = await sql<{ id: number }[]>`select id::int from analyses where analysis_no = ${analysisNo}`;
  if (!b) return { error: `There is no analysis ${analysisNo}.` };
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${b.id}::bigint)`;
    const l = (await loadAnalysis(tx, b.id))!;
    if (closed(l)) return { error: `Analysis ${analysisNo} is closed to changes.` };
    const si = stage === undefined ? -1 : l.doc.stages.findIndex((s, i) => [s.key, s.name.toLowerCase(), String(i + 1)].includes(stage.toLowerCase()));
    if (stage !== undefined && si < 0) return { error: `Analysis ${analysisNo} has no stage ${stage}: ${l.doc.stages.map((s, i) => `${i + 1} ${s.key} (${s.name})`).join(', ')}.` };
    const skipped: string[] = [];
    for (const t of timers(l.doc, l.events, l.now).filter((x) => skippable(x) && (si < 0 || x.key.stage === si))) {
      if (await skipWait(tx, l, t, u.id)) skipped.push(t.label);
    }
    return { skipped };
  });
}

/**
 * The terminal command for preparing demos: node dist/server/demo-skip.js <analysis> [stage] --as <username>.
 * Returns the exit code: 0 done, 1 wrong use or refused, 2 not a demo installation.
 */
export async function demoSkipCommand(product: Product, argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void = console.log): Promise<number> {
  if (!isDemo(env)) { log(`Refused: ${product.name} here is not a demo installation (LIMS_DEMO is not 1).`); return 2; }
  const as = argv.indexOf('--as');
  const person = as < 0 ? undefined : argv[as + 1];
  const [analysisNo, stage] = argv.filter((_, i) => as < 0 || (i !== as && i !== as + 1));
  const url = env.DATABASE_URL ?? env[`${product.id.toUpperCase()}_DATABASE_URL`];
  if (!analysisNo || !person || !url) { log('Use: demo-skip <analysis no.> [stage] --as <username of the demo person> (with DATABASE_URL set)'); return 1; }
  const sql = connect(url, { role: env.DB_APP_ROLE });
  try {
    const r = await skipWaits(sql, analysisNo, stage, person);
    if ('error' in r) { log(`Refused: ${r.error}`); return 1; }
    log(r.skipped.length ? r.skipped.map((s) => `DEMO: wait skipped by ${person}: ${s}`).join('\n') : `No wait is running in ${analysisNo}${stage ? `, stage ${stage}` : ''}.`);
    return 0;
  } finally {
    await sql.end();
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    demo: boolean;
  }
}
