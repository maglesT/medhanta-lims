# Medhanta LIMS

The QC laboratory system of the Medhanta platform (product `lims`): specifications and methods, samples, analysis
worksheets, review and certificates of analysis, OOS, lab inventory and instruments, stability, microbiology,
environmental monitoring and water, trends.

The idea in one line: a QC lab is a batch record plus an equipment logbook. An **analysis** (one test on one sample)
runs like a TrueBatch batch record: the method is the master, its steps are blocks, every calculation is a fixed,
tested template with pharmacopoeia rounding (no formula language), a second person checks, and it is signed and
printed. **Standards, reagents, columns, chambers and instruments** are kept like Logbook items: their status decides
whether they may be used, and every use is logged.

- Rules and their tests: `docs/rules.md` (the 54 rules of the LIMS compliance register)
- Design decisions: `docs/design.md`
- Calculation templates: `shared/templates/README.md`

## Status
Build step 3 of 8 done (first demo release): methods and specifications, versioned and approved with a change
control; samples registered from MMS quarantine lots and TrueBatch completed batches, with their chain of custody;
analyses of a sample's tests with the specification's limits in place, second-person checks and a second-person review
with the audit trail; QC's decision and the certificate of analysis; the views `coa_v1` and `result_v1` for MMS and
TrueBatch. Next: OOS and OOT with Deviations, lab inventory (standards, reagents, columns) and instruments (step 4).

## Develop
Needs Node 22 and PostgreSQL 16 or later.

```sh
npm install
export DATABASE_URL=postgres://lims_owner:dev@localhost:5432/lims_dev DB_APP_ROLE=lims_app
# Medhanta core: people, sign-in, permissions and master data are managed there
export MASTER_DATA_DATABASE_URL=postgres://lims_app:...@<core db>:5432/master_data   # read through its report views
# Optional links, each set by the platform only while the link is on:
# DEVIATIONS_DATABASE_URL, QMS_DATABASE_URL, LOGBOOK_DATABASE_URL, MMS_DATABASE_URL, RECRUITMENT_DATABASE_URL
export OIDC_ISSUER=https://<core domain>/oidc OIDC_CLIENT_SECRET=... OIDC_REDIRECT_URI=http://localhost:3000/cb
npm run migrate
npm run dev        # API on :3000
npm run dev:web    # UI on :5173 (proxies /api)
npm run ci         # typecheck, tests, build, rule-to-test check: run before pushing
npm run test:e2e   # browser tests (Playwright; once: npx playwright install chromium)
```

Tests use `TEST_DATABASE_URL` (default `postgres://lims_owner:dev@localhost:5432/lims_test`); each test file gets its
own schema. The test login must be able to create roles and databases (the platform test makes its own).

## On the platform
`ops/manifest.draft.json` is the draft of the product's platform manifest: permissions `lims.*`, back-channel logout,
the views it reads and the views it publishes. The app reads its database from `LIMS_DATABASE_URL` and runs as the
restricted login `lims_app`, which cannot change or delete audit rows or signatures. Migrations run as the database
owner. The container listens on 3000; the platform maps it to host port 8120 behind the proxy.

## Demo installations
The platform sets `LIMS_DEMO=1` only for the demo customer's installation, never for a plant's (`server/demo.ts`).
Then every screen shows a DEMO banner, and a person with `lims.demo.skip` may end a running wait at once
(`node dist/server/demo-skip.js <record number> [stage] --as <username>`). Each skip is an insert-only event shown in
the history, the review and the PDF as "DEMO: wait skipped by … at …".

## Conventions
- One app: `server/` (Fastify), `web/` (React), `db/migrations/` (plain SQL), `test/`, `e2e/` (browser tests), `ops/`,
  `docs/`.
- A test that proves a rule starts its name with the rule ID: `LIMS-xx` for LIMS rules, `PL-xx` for platform rules.
- Paraphrase regulations; never paste more than a short phrase.
- Work on a branch, CI green, then merge.
