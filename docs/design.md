# Medhanta LIMS: design decisions

Plan approved by the owner on 18 November 2026 (all 6 questions yes); template test done the same day (114 public
monographs and methods, 3723 rows, no formula language; library v1).

## Product
- **Medhanta LIMS** (`lims`): the QC laboratory system for raw materials, packing materials, intermediates,
  in-process, finished products, APIs, stability, microbiology, environmental monitoring and water.
- **Engine.** The analysis worksheet is a copy of the TrueBatch Tablets engine (master / record / step / sign /
  correct / audit / PDF / timers / repeat-until / preparations alongside / sub-records). Lab items (standards,
  reagents, columns, media, cultures, chambers) copy the Logbook's item + entries + derived status model. Samples,
  specifications, OOS, stability and trends are new, built in the same style. No new engine mechanism without the
  owner.
- **Numbers.** Sample `LS26xxxxx`, analysis `LA26xxxxx`, CoA `COA26xxxxx`, OOS `OOS26xxxx`, stability study
  `STB26xxx`.
- **Owner decisions from the template test (18 Nov 2026).** Particle counters and online water monitors: their
  daily report is imported as a file with a checksum, alarms are entered as excursions with a second person (no live
  link in version 1). Not in version 1: non-linear curve fits, PLS/NIR models, measurement uncertainty. A Tier 1
  failure the method sends to Tier 2 (and a test the method replaces by another on failure) is recorded and shown in
  review but opens no OOS. Dissolution time points are a fixed list.
- **Published views** use the product's own id prefix in their ids: `md5('lims:...' || id)`.

The sections below describe the copied TrueBatch engine; each is rewritten for the lab as its LIMS screens are built.

## Platform
- Runs on the Medhanta platform. Core provides people, sign-in, permissions, e-signature re-authentication and master
  data. Normal platform sign-in (OIDC through core, one person per browser).
- Optional links: MMS (lots, status, assay, LOD, lots waiting to be sampled), TrueBatch (batches waiting for a
  finished-product sample), Logbook (equipment and room status), Deviations, QMS (change control numbers). Every link has a hand-entry fallback with a second-person check.
- Sessions as the Logbook's: 15 minutes idle (background polls never count); a tap or a key on the screen counts as
  use (at most one renewal a minute); the session ends with core's sign-on (8 hours).

## Links
Owner decisions of 15 November 2026. Built as the Logbook's link clients: one client (`server/links.ts`) reads each
provider's report views live through `<PROVIDER>_DATABASE_URL`, which the platform writes only while the link is on;
nothing is copied or cached. A read is **absent** (no URL: not licensed or switched off), **down** (refused or not
answering) or **ok**.
- **Ok: pull only.** The value comes from the provider, as read, and is kept with the record (PL-07); it cannot be
  typed over.
- **Absent or down: by hand.** The value is typed from the label or certificate, the step needs a second-person check,
  the value is stored with source `hand` (and whether the link was absent or down), and QA's review lists it.
- **Deviations** (`deviation_v1`): a note's reference must exist; while the link answers its status is Deviations'
  (closed or rejected there counts as closed) and QA cannot close it by hand. By hand: a QA person other than the one
  who typed the number closes it. The number flows back (owner, 17 November 2026): a note written without a number
  that Deviations filed a deviation from (`deviation_v1.source_ref` = the note's `deviation_note_v1.source_ref`) is
  that deviation, read live while the link answers: its number and status are shown on the step, the batch screen,
  QA's review and the PDF, and it blocks release until closed there. A number typed while the link was off says
  "typed by hand".
- **QMS** (`change_v1`, planned): the change control at approval must exist and be QA-approved, in a step of
  `CHANGE_STEPS`, and its products must name the master's product (code or name, without case); one that names no
  product is taken with a warning to QA. By hand: another person makes the version effective.
- **Logbook** (`equipment_status_v1`, planned): a machine or room must be fit for use and not in use by another batch,
  and not kept for another product: after an antibiotic the Logbook names in `only_product` (its last column, read
  null-safely through `to_jsonb`, so a view without it means any product) the one product that may follow until a
  product-changeover cleaning is verified there; any other product is refused in plain words, the same product goes on
  (owner, 17 Nov 2026). The product compared is the one the batch publishes (`batch_fact_v1` / `packing_batch_v1`
  `product_code`, the master's header);
  the Logbook's reasons are shown word for word (each without its own closing stop inside our sentence); a status
  older than 5 minutes counts as down. While the link answers, the machine and room pickers offer only what the
  Logbook has and name the ones left out (`shared/engine/picks.ts`, `inLogbook`); absent or down, every one is offered. Line clearance takes
  clean, cleaned on and cleaned by from it; the previous product and batch is offered from this product's own batches
  that named the room or line before (one tap; typed only when another product used it since). An empty picker says
  why: where the machines of its type stand, or that master data has none (owner, 17 Nov 2026). By hand: the status-label questions, each answered yes.
- **MMS** (`lot_v1`, `lot_test_v1`, planned, with numbers): the lot must exist, be the line's material, released, in
  date and not past retest; assay, water, LOD and content come as numbers in %, the assay on the master's basis. By
  hand: the lot label's status and date, the certificate values and their report number. A quantity taken from a lot
  pulled from MMS (a net weight, a packing material issued) may not be more than MMS shows available (owner, 16 Nov
  2026): MMS's balance of the lot (`lot_v1.stock`, in `lot_v1.unit`, MMS D-61) less what this product already used from it as
  its `material_use_v1` gives it (`shared/engine/stock.ts`), checked when it is recorded or corrected and when the
  step is signed done. An MMS whose `lot_v1` has no stock yet, or a lot typed by hand, is not compared. What the other
  TrueBatch product used from the same lot is not read (each product uses its own kind of material).
- **Recruitment** (`training_v1`, owner 17 Nov 2026: only trained people sign): one row per person and skill
  (`person_login`, `skill_code`, `skill_title`, `trained_on`, `valid_until`, `qualified`, already false when expired),
  read through `RECRUITMENT_DATABASE_URL`. A master step may name the training it needs (`step.training`: the skill's
  code and title, picked in the designer's Signatures section from the skills `training_v1` lists; typed only while
  the link is off or down; none by default, so existing masters do not change). The plain view says "Done by a
  person trained in SOP-… (Recruitment)". When a person signs such a step as performed or checked, the server reads
  their row by their login and the skill now (`shared/engine/training.ts`, `trainingCheck`): qualified, the signing
  event records `training` (code, title, trained on, valid until, as read) and the signed content includes it; not
  qualified, expired or missing, the signature is refused in plain words ("<name> has no valid training in <skill>
  (Recruitment): ask QA, or another trained person signs."). Link off or down: the sign dialog asks the signer to
  tick "I am trained in <skill>", and the signature records `training` from `hand` ("training typed by hand
  (Recruitment not reachable)"), shown on the step, listed in QA's release review and in the PDF (LIMS-40). A step
  marked not applicable, a QA hold release and the batch-level signatures do not read training.
- **Samples** (build step 3, round 3): MMS `lot_v1` (already read) gives the material lots waiting to be sampled
  (`kind` 'material', status quarantine or under test); **TrueBatch** `batch_fact_v1` (new read, manifest `reads`
  `truebatch`, through `TRUEBATCH_DATABASE_URL`) gives the batches waiting for a finished-product sample
  (`completed_at` set, not `released`; `product_name`, `good_quantity` and `good_unit` read null-safely). Each is
  offered with the effective specification found for it (material: `header.itemId` = `material_master_id`; product:
  `header.code` = `product_code`), or why none, and its release sample if one exists. Registering reads the lot or
  batch again and refuses one no longer waiting; what was read is kept with the sample (`source.shown`, PL-07). By
  hand only while that link is absent or down: the number typed, the item picked from master data, source `hand`, and
  a second person (not the registrar) checks it before it is received (LIMS-41, LIMS-50).
- **Published** (`db/migrations/0006_report_views.sql`): `batch_fact_v1` and `equipment_use_v1` with Batchwright's
  names and columns, so the Logbook and Deviations read TrueBatch as they read Batchwright, and `deviation_note_v1`
  for Deviations to file notes later. `batch_fact_v1` has one more column at its end (`0007`): `manufactured_on`, the
  date of manufacture, the plant-time date the batch's first processing step started (null before), which TrueBatch
  Tablets Packing reads; readers of Batchwright's columns select them by name and are not affected. `0008` adds
  `product_name` and `master_version` at the end (family_code is the master version's number); `0015` adds the
  output counts for OEE and packing: `good_quantity` (the good tablets of the tablet reconciliation, whole),
  `good_unit` ('tablets') and `yield_percent`, null until that step is done; `0017` adds `released_at` (the time of
  QA's release event) and `released_by` (the name printed on its e-signature), null until released, as packing; it publishes
  `material_use_v1`: per signed weighing step its lot, material and net quantity (status dispensed, or corrected with
  the corrected quantity); MMS reduces the lot's stock by reading it (owner decision), nothing is sent. `0011`: a
  machine or room is in use by its **batch**, not its step or stage (cleaning is due between batches, not between the
  stages of one batch): `equipment_use_v1` has one row per batch and machine or room (sub-batches included), from the
  first start of a step of the batch that names it until every stage of the batch that names it, or whose rooms allow
  its room (by code or area), has closed (the batch event `stage_closed`, recorded once by the action that closes it,
  `0010`), or the production approval or rejection if earlier. So the binder preparation and the granulation in RM-104
  are one use, not dirty between them, and the Logbook marks it dirty after the last; another batch is another use. A
  picked machine or room keeps its room's area for this. A weighing instrument (a balance, by the type rule of
  `shared/engine/picks.ts`) is never a use: shared by the batches weighing on it, it is neither in use by a batch nor
  dirty between weighings; the record keeps which balance was used and the Logbook checks its calibration as before. Both views add `step_name` at the end ("Granulation › Granulate to
  an end point", kept with the step's start); `step` stays the keys. `0013` (17 Nov 2026): the use's `step` and
  `step_name` are the step that names it **last** (the latest started), so the Logbook's "last used by … (stage ›
  step)" names where it was last used. `0014`: a machine or room named only in line clearance steps (a room, the
  packing line) was used by the stage, so its `step_name` is the stage's name ("Blending"); a machine operated in a
  process step keeps that step. `0016` (whole-suite run, S17): a use starts when the machine or room was first
  recorded on a step, not at that step's start, so a room refused until its changeover cleaning was done does not
  overlap that cleaning in the Logbook. `material_use_v1` gives the quantity in the
  material's unit in master data, read when the step is signed done (g and mg exactly in kg for a kg material).
- **QA terminates a batch** (owner, 16 Nov 2026): a batch still in production (before production approval) that
  cannot be finished is terminated by QA (`qa.release`) from the batch screen or the "To review" list, with a reason
  and an e-signature meaning "rejected". It is a rejection (batch event `rejected` with `terminated`), so the status is
  rejected (`batch_fact_v1`: REJECTED), the record is kept and takes no more actions, and `equipment_use_v1` ends every
  open use of the batch then (machines and rooms dirty, no longer in use). Screens, review and PDF say "Terminated by
  … at …: reason", followed by what went back to stores.
  **Material of a terminated batch** (owner, 16 Nov 2026, both products): when the batch has used material (signed
  weighings, packing material issued), the "Terminate batch" window also asks, for each lot it used, how much went
  back to stores unused; the rest counts as used (destroyed or in the batch). Refused unless every lot is answered,
  from 0 up to what the batch counts as used of the lot (as published), and only for lots it used. The answers are
  kept in the terminate event, `payload.returns` [{lot, material, value, unit}], in the unit `material_use_v1`
  publishes for the lot, and signed with it. `material_use_v1` (`db/migrations/0012`; packing `0105`) takes them off:
  same columns and rows, `quantity` is now the quantity as before less what was returned of the same lot and unit,
  taken off the batch's uses of that lot from its last step back (stage, sub-batch, step, round), never below 0;
  `data_as_of` is then the later of the step's last event and the termination. So MMS shows the returned material
  available again with no change there. The app counts the same when it compares a lot with MMS's stock
  (`shared/engine/stock.ts`: materialUses, issuedLots, returnProblems). A batch that used no material is asked nothing.
- **Where machines are**: a stage that works machines or names a room chooses the rooms it may run in (master check,
  LIMS-12); the floor is offered the machines of the field's type standing in those rooms. A balance is offered where
  the weighing is done: in one of the master's **dispensing rooms** (header, picked from master data's rooms; a new
  tablet master starts with none, as a segregated block's booth may also be in a "Dispensing" area (17 Nov 2026 run);
  the rooms where a weighing balance stands are listed first; a master that weighs and names none is ⛔),
  or in a room the stage allows, never in a QC or laboratory area (`shared/engine/picks.ts`, the same rule on the
  server and the screen). Not every area called dispensing: a liquids block's "Liquid dispensing" balance is not
  offered to a tablet weighing. A version approved before the setting reads the rooms of the Dispensing area.
  The designer lists first the areas and rooms where the stage's machines stand (by type, from master data), and the
  master check warns (⚠️, LIMS-12) when no machine of a step's type stands in the rooms its stage allows, naming where
  the machines of that type stand: the floor's picker would be empty (17 Nov 2026 run: the disintegration tester in
  the QC lab). A warning, not ⛔: master data changes without a new master version, and the floor checks it again.
- **Pick lists from master data** (17 Nov 2026 run): the product pick lists offer the products whose dosage form
  names the product's dosage form (tablets; `web/src/product.ts`), not injections or capsules. Master data does not
  say whether a product is a bulk or a pack, so a pack product is still offered. Rooms read "code · name (area)".
- **What the master check reports**: everything the plain view would show as not set (a required setting, a hold
  time, a stage's responsible role, the stop check of a repeat-until step); an optional setting left empty is left out
  of the plain view's sentences, as the engine leaves it out. A temperature recorded with its optional limits left
  empty is a warning (the disintegration medium, an inlet or forming temperature). A stage's yield on an earlier
  stage's output is ⛔ when the stage adds formula materials (blending with extragranular materials and the
  lubricant: the yield would read above 100 %); the skeletons take blending's yield on the theoretical core batch
  weight. The messages carry no internal codes (rules, templates, failure cases).

## Rules and where they are enforced
- 22 TrueBatch GMP rules (EU GMP Part I and Annex 11, 21 CFR 211 and Part 11, Revised Schedule M), listed in
  `rules.md`. Each is checked **once, in the app**.
- The database only protects records: an insert-only audit trail, locked signed records, and only the app may write.

## Engine
- About 40 calculation and check templates, each a small pure function. No formula language.
- Step blocks are **data**: a description of their fields, templates, signatures and limits. One engine runs all blocks.
  The library holds the standard tablet steps, from sifting to the reconciliation of tablets (`shared/blocks/`). A text
  setting may have a fixed list the author picks from.
- A fixed, short list of units. Counts are whole (owner, 17 Nov 2026): tablets counted by weight are rounded to the
  whole tablet, packs from tablets to whole packs (down); a count is named as people count it (tablets, packs, nos).
- A result is shown by its figure and its limit in a few words, with one verdict (the screen's chip, the PDF's
  verdict line); its worked line stays with it ("How it was worked out"; in the PDF under the figure)
  (`shared/engine/plain.ts`, owner 17 Nov 2026). Times are shown to the minute.
- A master version is stored as one JSON document.
- The designer is forms and ordered lists.
- Server timers as the Logbook does them. In a demo installation only (`LIMS_DEMO=1`, set by the platform for the
  demo customer alone) a person with the demo permission may end a running wait at once; the skip is an insert-only
  step event the timers count as the wait satisfied (owner, 15 November 2026; README "Demo installations"). A mixing
  time (T13 from a start timer to an end timer) is such a wait too: once skipped, its lower limit counts as met, the
  recorded duration and the upper limit are kept, and the result says "DEMO: wait skipped" (16 November 2026).
- The second-person checker signs on their own device.
- Balances, pH meters, Karl Fischer titrators and titrators are read from the browser over Web Serial; chromatography
  results are imported from the CDS result file (Step 5 below). Typed instead, a value is marked typed and checked by a second person.
- PDF output as the Logbook does its exports.

## Calculation checks
Owner decision of 15 November 2026. The master check also runs calculation checks: error-proofing of the
calculations while a master is built. They are **not GMP rules** and are not among the 22. A **refusal** (⛔) is a
clear maths error: a calculation the templates library refuses (water or solvent counted twice, a salt factor up to
the weighed form with a potency stated as parent or element, molecules per salt unit ignored, a negative filler or
solvent, IU or CFU turned into a mass, weight variation on coated tablets other than film-coated, a property that does
not mix by mass), or the master's own numbers disagreeing (a batch quantity against per tablet × batch size, one
material twice with two quantities, the coating lines against coated − core, the API per tablet against the label
claim for each strength, mEq without the ion charge, an in-process result without its type, a liquid made in excess
without the amount to apply per charge); it shows on its item and must be fixed. A **warning** (⚠️) is an "it depends"
question only the author can answer (label basis per market and strength, herbal line, ratio basis, double
adjustment, a written salt factor, a weight that does not fit the tooling, a weight target without its stage, a
solvent-wet API, a removed processing aid, a one-sided particle-size limit, a moved order-critical step): the author
picks an answer, with a reason where asked, and the answer is kept in the master document and shown to the checker
and QA. An unanswered warning blocks "Send for review" like a refusal. The list, with the formulation each comes from
(1,000-formulation test, waves 1-5), is in `shared/templates/README.md`.

## Testing
- Tests per rule and per template, and a few browser journeys.
- No Batchwright machinery: no control register, mutation testing, golden batches, API contract package, CLI, sandbox,
  continuity or markets.

## Step 3: specifications, methods, samples, worksheets, review, CoA (design, 18 Nov 2026)
Owner rule: full pharma depth, simplest software design. Every record below is a copy of something TrueBatch or the
Logbook already does; there is no new engine mechanism.

| LIMS record | Copied from | How |
|---|---|---|
| **Method** (version: draft, in review, approved, effective, retired) | TrueBatch master version | Same table, lifecycle, master check, second-person check, QA approval and change-control number. The document is a header (code, name, technique, reference and edition) and the stages and steps; there is no formula. A setting the product decides (label claim, average weight, dilution volume …) is written `{ spec: name }`: the spec gives it. |
| **Specification** (same lifecycle) | TrueBatch master version, second kind | Same table (`kind = 'spec'`), same review and approval. The document is a header (material or product from master data, type, stage, market, pharmacopoeia and edition) and a list of tests: name, method, the method's result step, limit type picked from a list (range, NMT, NLT, conforms, report only, alert/action, two-band release/shelf life, staged), limit, and the values the method asks the spec for. |
| **Sample** (`LS26xxxxx`) | Logbook item + entries | A row (what, lot or batch, spec version effective at registration, purpose, quantity, containers; `0007`) and insert-only events (`sample_events`): checked (second person, for a sample typed by hand), received (condition), stored (where), handed over (to whom), disposed (reason and method, e-signature meaning `disposed`), note; approved and rejected come with QC's decision (round 5). Its status is computed from the events (`shared/engine/sample.ts`): waiting for check, registered, received, stored or handed over, disposed. Screens: the Samples tab (waiting to be sampled, the list), the register dialog and the sample screen with its chain of custody. Registered from an MMS lot (`lot_v1`) or a TrueBatch batch (`batch_fact_v1`); by hand only when the link is down, marked and checked by a second person. |
| **Analysis** (`LA26xxxxx`) | TrueBatch batch | Issued from the effective method version for one sample; covers the sample's spec tests that name this method. Steps, signatures, second-person checks, corrections, timers, deviation notes and PDF exactly as a batch. Before every engine call the spec's limits and values are put into the method's result steps (`applySpec`, a pure function): the engine sees an ordinary master. |
| **Review** | TrueBatch production approval | A different person reviews the complete analysis with its audit trail and signs "reviewed" (LIMS-18, LIMS-19). |
| **Decision and CoA** (`COA26xxxxx`) | TrueBatch QC approval and batch record PDF | When every spec test has a reviewed result, QC approves or rejects the sample with an e-signature; the CoA (PDF) shows only reviewed results with limits, method and lot/batch. |
| **Views** | TrueBatch `batch_fact_v1` | `result_v1` (approved results per lot/batch) and `coa_v1` (CoA number, decision, date), ids `md5('lims:...' || id)`. |

Worksheet blocks kept from TrueBatch: weigh, check, mix (as "prepare"), disintegration, content uniformity,
uniformity by weight, friability, density and flow, sieve analysis, line clearance (as bench clearance, optional).
New blocks (library v1): dilute, instrument run, system suitability, and the result blocks of the chemistry lab:
assay (external standard, single or bracketing), assay by specific absorbance (UV), related substances, dissolution
(with the stage rules), titration, water by Karl Fischer, loss on drying / residue on ignition, specific optical
rotation, pH and relative density. Each result block's reportable value is its calculation `result`, its main limit
the setting `limit` (normally `{ spec: 'limit' }`); up to 3 preparations are numbered fields and settings, their
masses and dilution factors refer to the weigh and dilute steps before it, and a check (C2) flags a preparation the
method sets but whose result is missing. All production blocks and the tablet formula, dispensing, stock and yield
parts are removed.

Permissions (`lims.*`): master.author, master.check, master.approve (methods and specs), sample.register, oos.approve (step 4),
analysis.perform, analysis.check, analysis.review, qc.approve, view, demo.skip.

## Step 4: lab inventory (build step 4, 18 Nov 2026)
Copied from the Logbook's item + entries + derived status, as samples are (`db/migrations/0011`, `server/routes/inventory.ts`,
`shared/engine/items.ts`). "May this item be used now, and if not, why" is computed once (`itemStatus`, a pure function)
and shown in the inventory and at the worksheet step.
- **Items** (`lab_items`, insert-only): reference standard (primary or official: issued by, lot, potency and basis from
  its certificate, expiry or retest date), working standard (qualified against one primary, its parent), reagent
  (supplier, lot, expiry, use period after opening), prepared or test solution and volumetric solution (procedure,
  use-by, the items it was made from; a VS its stated molarity), column (type, serial), culture medium (lot,
  sterilisation, use-by), culture (organism, strain; its passage is its parent culture's plus one, 0 for the reference
  culture). Registering is the receipt (bought) or the preparation (made); the number is the kind's prefix, plant year
  and a counter per kind: RS, WS, RG, SO, VS, CO, MD, CU (RS260001). What it was made from must be usable then
  (`registerProblems`); a culture past passage 5 is refused (LIMS-35).
- **Entries** (`lab_item_events`, insert-only): opened, standardised (VS: factor 0.900 to 1.100, next due, against
  what), qualified (working standard: potency, basis, next re-qualification; its primary must be usable), growth
  promotion (passed or failed, organisms), checked (a second person, not the one who recorded it, checks the latest
  standardisation, qualification or growth promotion; until then the item is not usable and its values are not used),
  retest (a reference standard's new retest date), blocked, unblocked, disposed (a column: retired), note.
- **Why not usable** (all reasons at once): disposed or retired, blocked, expired or past its use-by date, past its
  retest date, its use period after opening over, not qualified or re-qualification overdue, not standardised or
  standardisation overdue, growth promotion not tested or failed, an entry waiting for its check, passage beyond 5.
- **Worksheet field kind `item`** (`shared/blocks/format.ts`, with `itemKinds`): copied from the `lot` field. The step
  offers only usable items of those kinds and names those left out with why (`GET /api/inventory/picks`); the server
  reads the item again when it is recorded and refuses an unusable one in plain words (`server/pull.ts` pullLabItem).
  Its values fill the block's fields named after it, with source "from the LIMS inventory", never typed and never
  typed over: the assay's `std` (reference or working standard) fills `stdPotency` and `stdBasis`; the titration's
  `vs` fills `vsFactor` and `excess` fills `excessFactor` (the factor of the checked standardisation); the instrument
  run's `column` names the column. No hand fallback: the inventory is this product's own. The other blocks are
  unchanged (the dissolution block's optional standard potency is still typed).
- **Usage log** (LIMS-14 look-back, LIMS-12 column runs): an item's screen lists every analysis step whose recorded
  values name it (`lab:<id>` in the step events), with the analysis, its sample, who and when; nothing is stored twice.
- **Screens**: the Inventory tab (list by kind with status and why, search, register), the item screen (facts, status,
  made from and used to make, entries, usage), the register and entry dialogs. Permissions: registering and entries
  `lims.analysis.perform`; the second person's check `lims.analysis.review`; reading also `lims.view`. No new code.
- Not in this round: printed labels, stability chambers (with stability, step 6) and instruments with the Logbook and
  Qualification links (step 4, instruments).

## Step 4: OOS and OOT (18 Nov 2026)
Built the Logbook way, like samples: a row and insert-only entries, the status computed by a pure function
(`shared/engine/oos.ts`), no workflow engine. FDA guidance on OOS results (2022), paraphrased.

| LIMS record | Copied from | How |
|---|---|---|
| **OOS** (`OOS26xxxx`, migration `0010`) | Sample + entries | Opened at once, in the transaction of the step signature that gave a spec test's result out of its limit (one per analysis and test; `server/routes/oos.ts` openOos, called from the step "done" route). The row keeps the result as recorded. Entries (`oos_events`): phase Ia checklist (8 fixed items, yes/no, a "no" with what was found), phase Ib plan and its re-measurement (only as planned first; each result checked against the limit and shown on its own, never averaged), phase I conclusion (laboratory error with cause, or none), its return or its review (e-signature `reviewed`, `lims.analysis.review`, not a person of the analysis or of phase I), phase II deviation number and its second-person check, QA's conclusion (e-signature `oos_approved`, new permission `lims.oos.approve`), and each retest. Status: phase I, phase I review, QA approval, phase II, confirmed, invalidated. |
| **Invalidation** (LIMS-24, LIMS-48) | Analysis stop | Only after a reviewed phase I that found an assignable laboratory cause (or a phase II that found one, with the cause written): QA signs; the analysis gets an analysis event `invalidated` (status `invalidated`, it stays and is printed marked); QA authorises 1 to 3 retests; each retest is a new analysis of the sample started from the OOS (`oosId`), linked by an entry. |
| **Phase II** | Analysis deviation notes | A deviation of Deviations' `deviation_v1`: picked from the deviations naming the analysis while linked (a number not there is refused); typed by hand while absent or down, then checked by a second person. QA concludes when Deviations has it closed (read live), or by hand when Deviations does not answer. |
| **QC decision** | `approvalProblems` | Refused while an OOS of the sample is open; a confirmed OOS leaves only rejection; an invalidated analysis no longer counts (the latest reviewed, not invalidated, analysis per test counts). |
| **OOT** (LIMS-25) | Spec limit | Optional `trendLimit` on a spec test (spec editor). A reviewed result within the limit but outside it is flagged on the sample; QC answers it (sample entry `oot_answered`: no action or investigation, with the reason) before approval. |
| **View** | `coa_v1` | `report.oos_v1` (OOS number, sample, lot, item, test, result, status OPEN/CONFIRMED/INVALIDATED, phase_ii_needed, deviation number, opened/closed), ids `md5('lims:oos:'||id)`, for Deviations to file phase II from. |

Screens: the OOS tab (open and concluded), the OOS screen (the result, phase Ia, Ib, conclusion and review, phase II,
QA conclusion, retests, other lots of the item for the impact, history); the sample screen shows each OOS and OOT flag
in the decision; the analysis screen links its OOS and says when it is invalidated.

- Not in this round: printed labels, stability chambers (with stability, step 6).

## Step 4: instruments (build step 4, 18 Nov 2026)
LIMS-12 and plan 2.8: a machine field (an HPLC, a balance) is checked against two links when it is recorded or
corrected (`server/pull.ts`), each the Logbook way (pulled when the link answers, by hand with a second person when it
is absent or down).
- **Logbook** (`equipment_status_v1`, as before): fit for use (clean, calibration and maintenance in date, not out of
  service, the balance's daily check, as the Logbook computes it), not in use by another analysis.
- **Qualification** (new link `qual`, `QUAL_DATABASE_URL`, manifest reads `qual: [qualification_v1]`): the row whose
  `master_id` is the machine's master-data id (`server/links.ts` qualClient). Usable: `qualified`, and
  `qualified_conditions` (its conditions shown with the value: Qualification's `conditions` column, read null-safely,
  else "see Qualification before use"); refused in plain words: `requalification_needed`, `not_qualified` (any other
  status in words); `next_review_due` before today (plant date): "its periodic review was due on …". No row while the
  link answers: "… is not in Qualification, so it cannot be used." The rule is one pure function
  (`shared/engine/qualification.ts`, `qualificationProblem`). What was read is kept as the source
  `<field>.qualification` with the machine's value (PL-07; shown on the step, in QA's review list when by hand, and in
  the PDF). Absent or down: the label question "qualified, status label checked (periodic review in date)" is asked
  (`handFields`; also while the Logbook answers), and the hand entry makes the step need a second person. A record
  from before the link asks it with the Logbook's label questions, as before. Rooms are not checked against
  Qualification.
- **Picker**: `GET /api/qual/instruments` gives Qualification's machines and why each may not be used today; while it
  answers the machine picker offers only those that may be used and names each one left out with why
  (`inQualification`); absent or down, every one (answered by hand).
- **Published for the Logbook** (`db/migrations/0012`): `report.instrument_use_v1`, TrueBatch's `equipment_use_v1`
  columns in its order (`batch_number` is the analysis number, `equipment_code`, `equipment_type`, `room_code`,
  `step` "stage/step" keys, `started_at`, `ended_at`, `read_at`, `data_as_of`, `step_name` "Stage › Step"), then
  `use_id` (md5 of `lims:instrument_use:<analysis id>:<code>`) and `equipment_master_id`. One row per analysis and
  instrument (machine values only: not rooms, not inventory items). Started when first recorded on a step; ended when
  every step round naming it is signed done or not applicable after its last recording (sent back or recorded again:
  open again), or when the analysis is stopped or reviewed. A balance (type contains "balance") is shared: its use is
  the weighing itself (ended when recorded), so it is never held in use by an analysis. The Logbook reads it as it
  reads TrueBatch's view (its reader of LIMS is a Logbook change).

## Step 5: instrument data capture (build step 5, 18 Nov 2026)
Plan 2.8 and question 3 (LIMS-32, LIMS-33, LIMS-49, LIMS-50). No new table, no new engine mechanism: a captured or
imported value is an ordinary step value with its **source** (`shared/engine/links.ts`), as a value pulled through a link
is; it cannot be typed over, the review lists it and the PDF prints it. The parsers are fixed, pure and tested
(`shared/capture/`); there is no user-defined format.
- **Which fields.** A number field may say `capture` in the block format: `balance` (the weighing's mass), `ph` (the pH
  reading; `ph-temperature`, the sample's temperature, comes with it), `kf` (the Karl Fischer readings), `titrator` (the
  titres), `cds` (the peaks of the assay, system suitability and related substances; not an assay that reads
  absorbances). A serial capture field is one number of a block with one machine field: it is read from that machine.
- **Serial instruments (Web Serial, Chrome or Edge, no install).** Next to the field: "Read from BAL-01" and the
  protocol (remembered per machine in the browser). Protocols (`shared/capture/serial.ts`, each with its port
  settings): Mettler Toledo SICS (sends "S", takes "S S"), Sartorius SBI print (ESC P; the net line of a GLP print),
  Ohaus print ("IP"), any balance printing "value unit", pH meter print (pH and temperature), Karl Fischer result print
  (the titre in mL or the water found in µg or mg; the content % is LIMS's own calculation and is skipped), titrator
  result print (the end point volume). Refused in plain words: not stable (SICS "S D", no unit, "?"), overload,
  underload, negative mass, an error, drift, abort, no end point, two readings in one print, a line the protocol does
  not know. The browser parses to show the reading and sends `{ capture: { instrument, protocol, raw lines, readAt } }`;
  the **server parses the raw lines again** and stores only its own value (never the browser's number), in the step's
  unit (g to mg exactly: the decimal point is moved, nothing is rounded; mL never becomes mg). Refused: a reading from
  another machine than the one recorded on the step, no machine recorded yet, a protocol of another kind, a reading
  more than 10 minutes old or ahead of the server clock. A machine changed after a reading: the step cannot be signed
  until it is read again. The source keeps the machine, protocol, raw lines and reading time; shown as
  `BAL-01, Mettler Toledo SICS: "S S 0.05123 g" (51.23 mg)`. A captured value is corrected by reading it again (with
  the reason), never by typing. A pH read from the meter needs no second person (the pH block has no checker).
- **Typed instead (LIMS-32).** The instrument has no interface, the browser has no Web Serial, or the CDS export is not
  available: the value is typed and its source is `{ from: 'hand', link: 'instrument' | 'cds' }`, "not read from the
  instrument" / "not imported from the CDS". As for a link that is down, the step then needs a second-person check
  and the value is listed for the reviewer ("Typed by hand") and marked BY HAND in the PDF.
- **CDS result file (LIMS-33).** On an assay, system suitability or related substances step: "Import the CDS result
  file" (at most 512 kB). Fixed parsers (`shared/capture/cds.ts`): Empower report CSV (UTF-8 or UTF-16), Chromeleon
  export (tab separated, with its units line), OpenLab CDS CSV, and the **generic layout**:
  ```
  # run: RUN-0042
  # sequence: PARA-ASSAY-2611
  # processing method: PARA_ASSAY
  # processing method version: 3
  # instrument: HPLC-01
  injection,sample name,peak,retention time,area,tailing,plates,resolution,signal to noise,rrt
  2,STD,Paracetamol,4.51,1520345.2,1.12,8650,,310,
  ```
  (the last five columns optional). Every layout must give the run id and the processing method; a number with a
  thousands separator, a row with more cells than the header, or a non-number is refused, never guessed.
- **Naming and which peaks fill which field** (`shared/capture/cds-fill.ts`). Sample injections are named by the
  sample number (or the analysis number), a preparation by `-1`, `-2`, `-3`; the standard `STD…`/`Standard…` (or the
  inventory number of the standard picked on the step); the reference solution `REF…`/`Reference…`; other injections
  (blanks, other samples of the sequence) are left out. The peak read is the one the method names (new optional
  setting `cdsPeak`, "its name in the CDS"), else the largest. Assay: the standard injections (bracketing: those
  before and after the samples; one between them is refused) and each preparation's injections; the preparations must
  be exactly those the method sets. System suitability: the 5 or 6 replicate standard injections, and each check on its
  worst injection (highest tailing, fewest plates, lowest resolution and signal-to-noise). Related substances: one
  injection of the test solution; its other peaks in run order with the CDS's RRT, else the retention time over the
  principal peak's to 2 decimals (half up), their areas, the principal area, and the reference solution's injections.
  Counts that do not fit the field are refused with the numbers of the injections.
- **Checks against the analysis (LIMS-49, LIMS-50).** The file must be of the run recorded on the analysis' instrument
  run step (recorded first); it must have injections of this sample.
- **What is kept (LIMS-49).** The uploaded file itself is **not stored**: the CDS stays the raw-data record (with its
  own audit trail, which the reviewer checks, LIMS-19). LIMS keeps, with the values, the file's name, size and SHA-256
  (worked out by the server from the bytes, so it matches `sha256sum` of the export), the layout, the CDS run,
  sequence, processing method and version, instrument, the injections used and the import number. A **re-import**
  needs a reason; it is a new import (number 2, 3 …), and the values it replaces stay visible as replaced values with
  that reason (LIMS-24). After signing, a re-import is a correction.
- **Where it shows (LIMS-19).** The step shows each value's source and the step's imports (number, file, run, method,
  hash, fields, reason, who); the review lists "Read from instruments and imported from the CDS" (each reading with its
  raw line, each import with its file, hash and run) next to "Typed by hand"; the analysis PDF prints the same section
  and each value's source.
- Not in this round: a direct CDS connection (later, plan question 3), UV spectrophotometer capture, the run id read
  from the file onto the instrument run step.


## Step 6: reserve samples and retest of stored materials (build step 6, 18 Nov 2026)
Plan 2.2 and question 5 (LIMS-30, LIMS-31). The Logbook model again: a row, insert-only entries, a status computed by
a pure function (`shared/engine/reserve.ts`), tested. No new permission: the sampler (`lims.sample.register`) logs and
records; a second sampler checks.
- **Required quantity.** The specification's header has an optional `reserveQuantity` ("60 tablets": at least twice the
  quantity for all its tests except sterility and pyrogen, US 211.170(a)), set in the specification editor. When it is
  set, QC approval of a **release** sample is refused until a reserve sample of its lot or batch is logged with at least
  that quantity, in that unit, not destroyed (`approvalProblems`, via `reserveShortfall`; "shall": US 211.170, EU Annex
  19; owner, question 5). When it is not set, the decision says "the specification names no reserve quantity: the
  reserve sample is not checked at approval". Retest, stability and investigation samples need none.
- **Reserve sample** (`reserve_samples`, migration 0014): one per lot or batch, logged from its release sample (the
  sample's item, lot and specification version), on the sample screen ("Log the reserve sample"): the quantity kept
  (refused below the required quantity or in another unit), the storage location, and how long it is kept. That date is
  **typed and checked, not computed from data LIMS does not hold**: the rule is picked (1 year after the expiry date;
  3 years after the batch is completely distributed, for an API with a retest date, Q7 11.71; 2 years after release,
  other starting materials, India), the date it counts from is typed, and the kept-until date must be on or after that
  date plus the rule's years (shown in the dialog as it is typed).
- **Entries** (`reserve_sample_events`, insert-only): the yearly visual inspection (no deterioration, or deterioration
  with what was seen), a withdrawal (quantity in the reserve's unit, at most what is left, with its reason), the
  destruction (with its reason; refused before the kept-until date), a second person's check of a withdrawal or the
  destruction (not by the person who recorded it; nothing else is withdrawn or destroyed while one waits), a note.
- **Status**: destroyed, else below the required quantity (after withdrawals), else visual inspection overdue (a year
  after the last inspection, or after logging), else kept; with every point in words (a check waiting, a deterioration
  seen, the kept-until date passed). Shown on the sample screen's "Reserve sample" panel, the reserve sample screen
  (facts, status, entries, next entries) and the "Reserve samples" section of the Samples screen.
- **Retest due (LIMS-31).** The Samples screen lists MMS's released (or approved) material lots whose retest date is
  past or within 30, 60 or 90 days, read live through the MMS link (`lot_v1.retest_date`; nothing copied), each with its
  effective specification, its retest sample waiting for QC (a link) or "Register the retest sample", and its last
  decided one. The lots past their date with no retest sample are named at the top. Registering uses the normal
  registration (purpose `retest`, the effective specification, pulled from MMS): a retest sample is only of a released
  lot (or one still waiting to be sampled), and one at a time per lot until QC decides on it. Its decision is published as any sample's (`coa_v1`,
  `result_v1`); MMS owns the lot's status and moves its retest date. MMS absent or down: the list says so and the retest
  sample is registered by hand (second-person check), as any sample.

## Step 6: stability protocols and studies (build step 6, 18 Nov 2026)
Plan 2.6 and 2b items 1, 2, 5, 6 (LIMS-26, LIMS-27, LIMS-28), the Logbook way: a record row, insert-only entries, and
everything else computed by pure functions (`shared/engine/stability.ts`); migration `0013`; no new permission.

| LIMS record | Copied from | How |
|---|---|---|
| **Protocol** (version: draft … effective) | Specification (`kind = 'spec'`) | A third kind of master version, `kind = 'protocol'` (`shared/master/protocol.ts`): same table, review, second-person check, QA approval with a change control, effective version. Its document: the product or material (master data, code and name pulled), purpose (registration, on-going, commitment, change), container closure and "the one marketed", shelf life in months, the specification version (approved or effective, same item, with stability tests; its number pulled), the quantity per time point, the pull window (± days), the conditions from a fixed list (25/60, 30/65, 30/75 India, 40/75, 5 °C, −20 °C, photostability, other with its words) each with its role and time points in months, and the design (full, bracketing, matrixing: factors with levels, sizes and those tested; formulations or closure system; the matrix of time points per cell and condition; reduction, variability). `protocolChecks` refuses approval while an element is missing or no long-term condition reaches the shelf life; the design is checked by template **L25** (ICH Q1D) per matrixed condition (or once for bracketing). |
| **Study** (`STB26001`) | Sample | A row (`stability_studies`: the effective protocol version, the batch or lot, item, source, matrix cell, T0 = the plant date it was placed) and entries (`stability_events`): placed (per condition: the chamber and the units), extra (more placed, with a reason), extra_approved (QA, e-signature "QC approved", not the person who placed it), pulled (time point, the sample made; late: reason and deviation), checked (a second person checks what was typed by hand: the batch, a chamber without the Logbook, a deviation without Deviations), note. Batch from TrueBatch `batch_fact_v1` (a completed batch of the protocol's product), lot from MMS `lot_v1`; by hand only while the link is absent or down. Chambers: master-data equipment named a chamber; used only while the Logbook's `equipment_status_v1` says fit for use (not in the Logbook: refused; Logbook absent or down: accepted, its label checked by a second person before any pull). |
| **Schedule and stock** | Item status | `schedule` (each time point due T0 + months, the 31st to the month's end, window ± days; a matrixed batch its cell's own months), `pointState` (pulled, due, overdue, not yet), `stock` (placed + approved extra − pulled, against what the later time points need), `pullRefusal` (before the window; late without reason and deviation; typed by hand not checked; the pull that would leave a later time point short, until QA approves more placement). |
| **Pull** | Sample registration | A pull makes the stability sample through `newSample` (the code of sample registration, now one function): purpose `stability`, the protocol's specification version (shelf-life limits), the protocol's quantity, and `samples.stability` naming the study and time point (shown on the sample screen). |
| **Excursion** | Logbook entry | Entered by QC until the Logbook publishes excursions (`stability_excursions`): chamber, period, readings at equal intervals, the deviation (one Deviations knows while it answers); the mean kinetic temperature by template **L23** (readings it refuses are refused at entry); the studies and time points whose samples were in the chamber (`affectedBy`); a second person checks the readings, QC assesses the impact. |
| **On-going stability** (LIMS-27) | — | Per product and primary pack: the batches TrueBatch released this plant year (`releasedSince`), the effective on-going protocols and the on-going studies started this year (`ongoingFlags`); a flag with no study (or no on-going protocol at all), cleared by a study or QA's reason (`stability_ongoing_answers`). |
| **Chamber capacity** | — | `capacity`: per chamber and condition the units in it now and still in it on 1 January of each of the next five years. |

Screens: the Stability tab (pulls due this week and overdue, on-going flags, the studies; protocols; excursions; chamber
capacity), the protocol editor (as the specification editor, with the same review screen and master check), the new
study dialog (protocol, batch from TrueBatch, chamber and units per condition) and the study screen (schedule with Pull,
late pull with reason and deviation, stock with "Place more" and QA's approval, checks, results per time point from the
stability samples' analyses, excursions, entries). Permissions: protocols `lims.master.*`; studies, pulls, extra
placement, excursions and checks `lims.sample.register`; QA's approval of extra placement, the excursion assessment and
the on-going reason `lims.qc.approve`; reading also `lims.view`.

Not in this round: excursions read from the Logbook (the evaluation follows below).

## Step 6: stability evaluation (build step 6, 18 Nov 2026)
Plan 2.6 and 2b items 3, 4, 7, 8 (LIMS-29, LIMS-25). Nothing is typed: the results are the reportable values of the
stability samples' **reviewed** analyses (the latest reviewed, not invalidated, per test; the sample's QC decision
shown beside it), read per study, condition and time point (`server/routes/stability-evaluation.ts` `itemData`). The
calculations are pure functions (`shared/engine/stability-evaluation.ts`) over templates L15, L22 and L24; migration
`0015`; no new permission.

| What | How |
|---|---|
| **Stability-indicating tests** | The specification's tests that apply on stability with a numeric shelf-life limit (range, NMT, NLT; the shelf-life limit of "release and shelf life"). |
| **Q1E evaluation** (L15) | Per protocol (all its versions) and long-term condition, per test: the batches with 3 or more time points (the others named, not used), pooled as the poolability tests allow (level 0.25), the estimate, the model, the limiting line; on the study screen for its batch alone, on the product screen across the product's studies. QA (`lims.qc.approve`) answers the Q1E decision tree (storage, significant change at accelerated and at intermediate, little or no change, statistics performed), may pick a log fit per test, sees the proposed shelf life (the shortest over the tests, capped, rounded down) and signs it (e-signature "QC approved"). |
| **Evaluation record** | `stability_evaluations`, insert-only: scope, item, protocol, condition, the studies, the kind (shelf life; retest period for a material), the months, the inputs as read (every result with its sample and analysis, the answers, the fits) and the outputs. Signing is refused when a result changed since the screen was read (content hash). |
| **Out of trend** (L22, LIMS-25) | A stability result outside the 95 % prediction interval of its batch's earlier results at the condition (3 or more time points), or of the product's other batches there pooled, is the sample's existing OOT flag (`testStates(..., trend)` via `stabilityTrend`), answered by QC ("no action" or "investigation") before approval. Computed when read, like the spec's trend limit. |
| **To be reported** (LIMS-29) | A confirmed OOS of a stability sample, or an OOT answered "investigation", on a marketed batch (TrueBatch released; an MMS lot released; link down: treated as marketed and said) shows on the study and product screens as "to be reported", with the OOS number. QA records whether a regulator notice is needed (yes/no with the reference or why not; `stability_report_answers`, insert-only); the app never sends one. |
| **Arrhenius** (L24) | On the product screen when the protocol has accelerated (or intermediate, stress) results: per test the rate at each condition with a temperature (slope of all batches, towards the limit), the allowed change from the mean initial value to the limit, the time to it at the long-term condition; humidity-corrected when 4 or more conditions with 2 humidities allow. Always shown as "advisory: for development decisions, not for the label"; it never sets a shelf life. |
| **CTD tables** | `GET /api/stability/ctd` (PDF, `server/ctd.ts`, as the CoA; CSV): 3.2.P.8.3 for a product, 3.2.S.7.3 for a material; per batch and condition the tests with their acceptance criteria as rows and the schedule's time points as columns, OOS and OOT marked, pending QC decisions starred; the signed evaluations at the end; the CSV one row per batch, condition, test and time point with the signed shelf life. |
| **View** | `report.stability_v1`, one row per study (ids `md5('lims:stability:'||id)`): product or material, batch, protocol, conditions, last time point, ON_STUDY / COMPLETE, and the latest signed evaluation covering it as `shelf_life_months` or `retest_period_months` (MMS reads the latter in a later readers round). |

Screens: the Stability tab's **Evaluation** list (products and materials on stability, their signed shelf life), the
product evaluation screen (CTD downloads, studies, to be reported, data, Q1E per condition with "Propose the shelf life
(QA)", signed evaluations, Arrhenius), and the same panel on the study screen (its batch alone).

## Step 7: microbiology worksheets (build step 7, 18 Nov 2026)
Plan 2.9 (sterility, bioburden, endotoxin, microbial limits) and library 2b, 3b (L11-L13), 8b. No migration, no new
table, no new permission and no new engine mechanism: six new blocks of the block library and three templates
(`shared/templates/lab-micro.ts`, README "Lab templates, microbiology"); the method designer offers four skeletons
(microbial limits TAMC/TYMC, sterility by membrane filtration, kinetic endotoxins, bioburden).

| Block | Records | Calculation | Reportable `result` against `limit` |
|---|---|---|---|
| `incubate` | the medium lot (inventory item, LIMS-34), the incubator (machine: Logbook and Qualification, LIMS-12), start and end timers, lowest and highest temperature, the reading | T13 incubation time (its lower bound is a minimum wait, as a mixing time), C1 temperature range | none (a preparation step); two temperatures = two incubate steps |
| `count` | the colonies per plate of up to 3 dilutions (counted lists) or TNTC; or MPN tubes; negative control | L11 | the count, with the spec's alert and action levels (C1 tiers); 10^n read as NMT 2 × 10^n |
| `bioburden` | the medium lot, the plates, negative control | L11 × the method's recovery factor | the count |
| `sterility-test` | batch size and containers tested; per medium (FTM, SCDM: inventory items) its incubator, timers, readings during the incubation, temperatures, final reading and negative control; the organism found | L19 (the containers the sterility table requires, against those tested), T13 (14 days), C1, C4 | C4 "no growth in FTM or SCDM": the number of media with growth; a "conforms" spec test |
| `endotoxin` | the lysate (reagent item), the reader or heating block; photometric: the standards' and A/B responses, negative control; gel clot: + / − per replicate, end-points, λ of the lot | L12 (MVD, validity, result) | endotoxin in the limit's terms, checked as less than the limit |
| `microbial-assay` | the test organism (culture item, LIMS-35), the medium lot, the responses per dose of standard and test | L13 | potency on the estimate or a fiducial limit; precision checked beside it |

**A positive sterility test (LIMS-38)** is an ordinary failed result: the step's `result` check fails, the step needs
a deviation note before it is signed, and signing it opens the OOS (step 4, `openOos`), one per analysis and test.
There is no other way to set it aside: the result is invalidated only through that OOS, i.e. phase I by the analyst
records the assignable laboratory cause (e.g. the EM of the isolator, the organism's identity), a supervisor who did no
part of it reviews phase I (e-signature `reviewed`), and QA signs the invalidation (e-signature `oos_approved`,
permission `lims.oos.approve`); the original analysis stays, marked invalidated, and QA authorises the retest. QC's
decision waits for the OOS (`approvalProblems`). An invalid test (growth in a count's negative control, a failed
endotoxin curve or control, a microbial assay without parallelism) is not an OOS: its template refuses with the reason
and the test is repeated. Growth in a sterility negative control fails its own check (a deviation note on the step),
not the result.

## Step 7: environmental monitoring and water (build step 7, 18 Nov 2026)
Plan 2.9 (LIMS-36, LIMS-37; library 8c item 33, safety rule S11; owner decision of 18 Nov 2026 on continuous
monitoring). The Logbook way again: master versions, ordinary samples, a record row with insert-only entries, and pure
functions (`shared/master/monitoring.ts`, `shared/engine/monitoring.ts`); migration `0019`; no new permission.

| LIMS record | Copied from | How |
|---|---|---|
| **Monitoring plan** (version: draft … effective) | Stability protocol | A fourth kind of master version, `kind = 'monitoring'`: same table, review, second-person check, QA approval with a change control, effective version. Its document: number, name, shifts a day, and the points: code and place, a room of master data (code, name and grade A/B/C/D read from `room_v1` when saved) or a water system (PW, WFI), critical location; each with its samplings: what (settle plate, contact plate, active air, glove print, personnel; TOC, conductivity, micro, endotoxin), how often (per shift, daily, weekly, monthly, per batch), the state (at rest, in operation; rooms only), the quantity, when isolates are identified (no, on action, any growth), and the specification test whose limits apply (its number, test, method and limit pulled from its latest approved or effective version). `monitoringChecks` refuses approval while a room has no grade, a sampling has no state or test, a room test has no alert and action limits, a limit is per ft³ (S11: 1 per ft³ = 35.3 per m³; convert in the specification), an active air limit is not per m³, a count is not in CFU, an at-rest action limit is looser than the in-operation one (S11), a water specification is in-house, or a water system's points miss a test its pharmacopoeial specification asks (PW: TOC, conductivity, micro; WFI: and endotoxin, LIMS-37). Grade A: a warning that any colony is acted on whatever the limit. |
| **Due today** | Stability pulls due | `dueList`: per sampling of a frequency, the current period (the day; the week from Monday; the month), the samples needed (per shift: the plan's shifts a day) and taken; due while short, overdue when the previous period (since the plan first became effective) was short too, the missed period named. Per batch samplings are listed apart. |
| **Sampling taken** | Stability pull | `POST /api/em/take` makes an ordinary sample through `newSample`: purpose `monitoring` (refused at registration), the lot number is the point code, the item `{ of: 'room', itemId, code, name }` (the room as master data has it now) or `{ of: 'water', itemId: 'water:PW', code: 'PW', name }` (the sample item type gained `room` and `water`; no placeholder material), source `{ from: 'plan', shown }` (a batch typed while TrueBatch does not answer makes it `hand`, checked by a second person as any sample), and `samples.monitoring` naming the plan version, point, sampling, kind, frequency, state, grade, identification rule, the test, its limit, the plant date, shift, batch and person sampled. Tested to the effective version of the specification; only the sampling's test applies to the sample (`testStates(..., only)`), so QC's decision needs that test alone. A second sampling in the same period (or shift) needs a reason (a note on the sample). Analysis, review, OOS (an out-of-limit result opens one at once, LIMS-23) and QC decision are the existing ones. |
| **Excursion** | Stability chamber excursion | `excursionLevel`: the reviewed result against its test's limit by C1 (action over the action limit, alert over the alert limit); grade A acts on any colony (settle, contact, air, glove, personnel, micro). Results over a limit are listed until recorded: action opens the investigation with a deviation number (one Deviations knows while it answers, picked from those it files for the sample or point; typed by hand while absent or down, then checked by a second person), alert is recorded as a trend watch. `em_excursions` (one per result; origin `result` or `import`) and `em_excursion_events` (confirmed, deviation, checked, isolate, closed, note). `excursionStatus`: to confirm (an imported alarm) → investigation to open → deviation to check → isolates to identify (genus and species from the identification method's report, the method picked from the effective methods, its report number; when the sampling says on action or any growth and there was growth) → open → closed by QA (`lims.qc.approve`), refused while Deviations has the deviation open, or by the person who typed it by hand. |
| **Monitoring reports** | CDS result file | The owner's decision: no live link in version 1. A particle counter's or online water monitor's daily summary (CSV) is imported by a FIXED layout: `date,room,channel_um,count_per_m3,max_per_m3,alarm` (room a master-data code; channel 0.5 or 5.0 µm) or `date,point,toc_ppb,conductivity_us_cm,alarm` (point a water point code of an effective plan); one plant date per file, not in the future, at most 2000 rows; a per-ft³ header refused (S11); alarm empty, ALERT or ACTION. The file's name, size and SHA-256 are kept (the same file twice is refused; the monitoring system keeps the file), its rows stored as read (`em_imports`), and each alarm an excursion a second person (not the importer) confirms before anything else. Conductivity is stored as the monitor reports it; the uncompensated comparison with the temperature table (S11) is a template for the conductivity method, not the import. |
| **Map and trends** | — | `GET /api/em/map`: per room (with its grade) and water system, the points of the effective plans with each sampling's latest reviewed result and level; with `?point=` the last results per sampling (the trend table, with the limit). Charts: step 8. |
| **View** | `stability_v1` | `report.em_v1`, one row per monitoring sample (ids `md5('lims:em:'||id)`): plan, point, ROOM or WATER, room code and grade or water system, sampling kind, state, frequency, the plant date taken, the test, the result as QC decided on it (null until decided, LIMS-21), the limit and the alert and action limits as taken, level NONE / ALERT / ACTION (grade A: any colony), the excursion's status (NONE, OPEN, CLOSED) and deviation number, the decision. |

Screens: the **EM and water** tab: Due today (with "Take": shift, batch, person sampled, or the reason to take again),
Excursions (results over a limit with "Open the investigation" or "Record the trend watch", and the excursions), EM map
(a card per point, coloured by its worst latest level; a point opens its trend table), Plans, Monitoring reports (the
layout and the upload). The plan editor (as the specification editor, same review screen and master check) and the
excursion screen (facts, investigation read live from Deviations, the next actions with why not, entries). Permissions:
plans `lims.master.*`; taking, opening, confirming, checking, isolates and imports `lims.sample.register`; closing
`lims.qc.approve`; reading also `lims.view`.

Not in this round: trend charts and EM trend rules (consecutive alerts, flora) (step 8); a room's status for use read
from the Logbook; an EM summary per batch for release; personnel picked from a list of people (typed with the sample).

## Step 8: trends, KPIs, workload and APQR data (build step 8, 18 Nov 2026)
Plan 2.10 (second half), 2.11 and section 3 (`trend_v1`); LIMS-25, LIMS-42. Everything is read from this product's own
records when asked and computed by pure functions (`shared/engine/trends.ts`, template **L18** in
`shared/templates/lab-trend.ts`); migration `0020`; no new permission, no chart library (plain SVG).

| What | How |
|---|---|
| **Control charts** (LIMS-25) | Any numeric test of a product or material (its release and retest samples) or of an EM or water point: the results as QC decided on them (the decision's payload, as `result_v1`), oldest first. L18: individuals chart, centre line, sigma = MR̄ ÷ 1.128, ± 1, 2, 3 sigma, the moving range chart (3.267 × MR̄), the specification limits drawn, Cpk and Ppk with a two-sided limit, and the eight Nelson rules with the points that break them. |
| **Out of trend** | One way only: `sampleTrend` (server/routes/trends.ts) gives `testStates` its `trend` argument. A stability sample: the prediction interval (L22, as before). A release, retest or monitoring sample: the control chart of the at least 10 (at most the last 30) results of its item or point and test decided before it, with the new reviewed result appended; a Nelson rule break that includes it is the sample's existing OOT flag, answered by QC before approval. The spec's trend limit stays in `testStates`. A result out of its limit is an OOS, not a trend. |
| **KPIs** (plan 2.11) | Per plant month: right first time (finished analyses reviewed, never corrected, sent back or invalidated), OOS rate (of the reviewed analyses, those that opened an OOS), invalid-run rate (stopped or invalidated, of those finished), turnaround (samples by the month QC decided: days from receipt in QC to the decision, the mean and the share within the target); per analyst (who started the analysis) and per test method over the period; the backlog today (received, not decided, not disposed) by age (0-7, 8-14, 15-30, over 30 days) with those over target. |
| **Turnaround targets** | The simplest settings place: an insert-only table `tat_targets` (purpose, days, who, when; the latest row of a purpose applies), set on the KPI screen by QC (`lims.qc.approve`, audited); until set, the product defaults in code (release and retest 10 days, stability and investigation 15, monitoring 7). |
| **Workload planner** (plan 2.10) | The open samples' tests per method (received, not decided; not those whose analysis is reviewed) due on the plant date received plus the purpose's target, with the analysis if started and the assignment; the analysts (people who started or signed analyses, or have the perform permission) with their open analyses and assignments. Assigning (`lims.analysis.review` or `lims.qc.approve`) is an insert-only `lab_assignments` row (assigned again: a new row; the latest applies), refused while Recruitment answers and the analyst is not trained in a skill the method's steps name (`assignRefusal`); while it does not answer, the assignment says "not checked" (the training is checked again at every step signature, as before). My work lists "Assigned to you". |
| **APQR** (LIMS-42) | Per product or material and period: the results per test (n, min, max, mean, SD, Cpk, rules broken: L18), the lots and their decisions (rejected = failed batches), the OOS opened (status, phase II deviation), the OOT flags QC answered, the method and specification versions made effective with their change controls, the stability studies (last time point, latest signed evaluation) and the stability results, and the plant's EM and water results (alert and action counts per point and sampling) and excursions. On screen; PDF (pdfmake, as the CoA) and CSV (one section after another). The review itself is QMS's. |
| **View** | `report.trend_v1`, one row per decided result of any sample (ids `md5('lims:trend:'||sample id||':'||test key)`): purpose, item, lot or batch, EM point, stability study and time point and condition, test, value, unit, reported figure, limit as written and its bounds (the shelf-life limit for a stability sample), PASS/FAIL, method, analysis, the OOS number the analysis opened, out of trend with QC's answer, specification number and version, decision, decided at. For QMS's APQR (manifest `publishes`). |

Screens: the **Trends** tab: Control charts (series and test, period, the I-MR chart, the rule breaks, the results with
OOS and OOT), KPIs (per month, per analyst and method, backlog, targets), Workload (open tests by due date with
"Assign", analysts), APQR (product, period, the summary, Export CSV and PDF); My work's "Assigned to you". Reading: any
of `lims.view`, `lims.qc.approve`, `lims.analysis.review`, `lims.sample.register`, `lims.analysis.perform`.

**EM adverse trends** (LIMS-36, EU Annex 1; `shared/engine/em-trends.ts`, pure and tested): three fixed checks over the
decided EM and water results (level by the sampling's alert and action limits, grade A any colony) and the isolates
identified, each an "adverse trend" entry with a stable key, computed when read:
- **Repeated alerts at a point**: at an alert or action result, n or more of the last m samplings of that point's
  sampling were alert or action. The plan's sampling has an optional setting "n alert-or-action results in the last m
  samplings" (two numbers, n ≤ m, checked by `monitoringChecks`). Empty: the defaults, a starting point the plan's
  author can change: grade A and B **2 in 3**, grade C and D (and water) **3 in 5**.
- **Alerts across a room**: alert or action results at 2 or more points of one room in the same week (Monday to
  Sunday, plant dates).
- **New organism (flora shift)**: an isolate whose genus (or genus and species, when the species is given) was not
  identified at that room (or water system) in the 12 months before.

QC acknowledges each (`lims.qc.approve`): an insert-only answer with the reason (`em_trend_answers`, one per key, in
migration 0020), as the OOT answer. Shown on the Excursions tab ("Adverse trends", with "Acknowledge"), on a point's
trend screen, and in the APQR EM summary (screen, PDF, CSV).

Not in this round: QMS's reader of `trend_v1` (a QMS round).

## Step 8c: the register rules still open (build step 8, 18 Nov 2026)
Each built the Logbook way (a row and insert-only entries, the meaning computed by a pure function), in migration
`0022`; no new permission, no new mechanism.

| Rule | What | How |
|---|---|---|
| **LIMS-05 sampling plan** | spec header `sampling`, `samples.sampling` | The specification may name its sampling plan (header, spec editor): 1 + √N or every container (template L19), with the method and tool, equipment, amount per container, sub-division, precautions and storage. A release sample under a plan (or with an identity test of a starting material: every container, LIMS-08) is registered with the containers received; the dialog shows L19's worked line and the details, and the sampler confirms the container numbers sampled (`samplingPlan`, `sampledProblem`). Recorded on the sample (`sampling`: received, plan, line, numbers, details as given); `containers` is the number sampled. The sample screen shows it; the labels print one per sampled container number. Compulsory (step 8d): `specChecks` refuses a material specification of type Raw material, Active substance or Packing material without `sampling.plan` (LIMS-05, US 211.84(b) covers components, containers and closures), so it cannot be sent for review or approved; specifications already effective are left as they are (the check runs at review and approval), and their release samples keep containers sampled optional until a new version names a plan. |
| **LIMS-06 labels** | PDF from the sample screen | `GET /api/samples/:id/labels` (`server/labels.ts`, pdfmake as the CoA): the sample's label (sample number, material or product, lot or batch, containers, quantity, purpose, specification, storage under the plan, who sampled it, the date) and one "SAMPLED · container k of N" label per container sampled. Everything from the record; nothing typed. |
| **LIMS-08 identity per container** | spec test `identity` | A specification test may be marked an identity test (spec editor). For a release sample of a starting material (spec type Raw material or Active substance) it is done on each container (`identityContainers`): registration needs the number of containers; an analysis by the identity method names its container (`analyses.container`, 1 to n; `testsForAnalysis`), one without a container covers the method's other tests; QC approval waits for a reviewed result of every container (`approvalProblems`: "containers 2, 3 of 3 have no reviewed identity result"); the analysis record names the container, the CoA says "each of n containers", result_v1 lists the analyses. **Reduced identity is not offered**: QMS `supplier_approval_v1` approves reduced testing (LIMS-09) but publishes no qualification of a validated reduced identity-sampling procedure, and nothing tells whether the material goes into a parenteral product, so no rule can allow it; every container is identified (the strict branch of the rule). |
| **LIMS-09 supplier certificate** | spec header `reducedTesting`, sample entry `reduced_testing`, `outside_results.certificate` (migration `0023`) | The specification (master, change control) may allow reduced testing with its full-test interval: every `fullEvery`-th lot and at least every `months` months; `specChecks` refuses it on a product or intermediate and without an identity test. On a release sample QC (`lims.qc.approve`) records it (`POST /api/samples/:id/reduced-testing`) only when `reducedTestingProblems` (shared/engine/reduced.ts) finds nothing: the lot's manufacturer and supplier from MMS `lot_v1` (its last columns), their approval from QMS `supplier_approval_v1` (approved, `approved_until` not past, `reduced_testing_approved`), the full test not due (`fullTestDue`: this lab's own approved release samples of the manufacturer's lots, read by their lot numbers from MMS), no open OOS of those lots and none confirmed on or after `reduced_testing_approved_at`. The entry keeps the basis as read (manufacturer and address from master data `supplier_v1`, supplier, the manufacturer's batch number, broker, the QMS record, the last full test). The tests other than identity are then outside results (LIMS-22) marked `certificate`: the lab is the recorded manufacturer, the certificate number and scan (SHA-256) typed and attached, checked by a second person who confirms the certificate's required fields (`certificate_fields`, IN Schedule M 19.7.4); a result out of limit opens an OOS as any outside result. Identity is always tested here. The CoA says SUPPLIER'S CERTIFICATE; `result_v1.outside_lab` reads "supplier's certificate (<manufacturer>)". New reads: QMS `supplier_approval_v1`, master data `supplier_v1`. Reduced identity sampling (LIMS-08) stays not offered: no published flag of a validated reduced identity procedure, and none for parenteral use. |
| **LIMS-10, LIMS-15** | tests only | The analysis record already holds the complete worksheet (copied engine); tests prove it, and that values keep full precision and are rounded half up as the limit is written only to compare and report, by registered templates only. |
| **LIMS-22 outside lab** | `outside_results`, `outside_result_checks` | `POST /api/samples/:id/outside` (`lims.analysis.perform`): test, lab, report number, the report's file (its name, size and SHA-256 worked out on the server; the file is not kept: the contract lab's report is its record) and the result as the report gives it (value and unit, or conforms yes/no), checked against the limit by C1 (`shared/engine/outside.ts`). It counts once a second person checks it (`POST …/outside/:rid/check`, `lims.analysis.review`, not the person who typed it). `sampleTestResults` lists it after the lab's own analyses (the latest reviewed counts): method "Outside lab: <lab>", the report number in place of an analysis number. The CoA says OUTSIDE LAB with the report and its SHA-256; `result_v1` gains `outside_lab` at its end. An identity per container is never outside. The lab is typed: no linked system publishes approved contract labs (master data `supplier_v1` is not read by LIMS). An outside result out of its limit opens an OOS when the second person checks it (`openOutsideOos`): the `oos` row names the outside result (`outside_result_id`) instead of an analysis (exactly one of the two; `oos_v1` shows the report number as the analysis number and gains `outside_lab` at its end). Its phase I is the contract lab's investigation: no checklist or re-measurement in LIMS; the phase I conclusion carries the contract lab's report (number, file name, size, SHA-256), reviewed by a second person who did not type or check the result; then QA approval or phase II as any OOS. Invalidated by QA (`lims.oos.approve`), the outside result stays, shown "invalidated", and no longer counts. |
| **LIMS-39 lab animals** | lab item kind `animal` | "Lab animal" in the lab inventory: species (organism), its own tag, supplier, housing; blocked with the reason when not suitable; health checks and uses as notes. No worksheet block takes an animal (animal tests are out of the plan; endotoxin replaces the rabbit pyrogen test). |
| **LIMS-52 retention** | trigger + tests | `analyses` gains its insert-only trigger (the app role already could not change it; now the owner cannot either). A test checks that every table of records refuses UPDATE, DELETE and TRUNCATE (counters, users and signing proofs are not records), so nothing is deleted and any retention period is met; PDFs are made again from the stored record with the same content. Backup and restore are the platform's (PL-11). |
| **LIMS-53 controlled changes** | tests | Every template in the registry has tests named by its ID (L21, T27, C8 and C9 gained theirs); every block is versioned and a method names its version; CI runs type check, all tests, the build and traceability. |
| **LIMS-54 paper fallback** | `issued_forms`, `issued_form_events` | `POST /api/samples/:id/forms` (an effective method that does a test of the received sample, with the reason): number `LF26xxxxx` (own counter, never reused), printed on every page of the blank worksheet (`GET /api/forms/:id/pdf`: the method's stages and steps, a blank per field with its unit, performed and checked lines; each print audited). It comes back once (`/return`: used, naming an analysis of the same sample by the same method, or unused; `/void` with the reason; `shared/engine/forms.ts`). `GET /api/forms?open=1` is the reconciliation list, shown on the Samples tab ("Paper worksheets not back"). |

## Step 8: method validation, verification and transfer (build step 8, 18 Nov 2026)
Plan 2.12 (LIMS-02, LIMS-04; library L16, W003 ICH Q2(R2)). Copied, not invented: a validation is an ordinary analysis
of an ordinary method, and the report is a record row with insert-only events and a status computed by a pure
function (`shared/engine/method-validation.ts`), as the OOS and the stability evaluation are. Migration `0021`; no new
permission, no new engine mechanism.

| What | How |
|---|---|
| **Method header** | Two optional fields. `origin`: in-house (default), pharmacopoeial, transferred: what the method needs before routine use (a validation, a verification or a transfer report). `use`: routine (default) or validation: a **validation worksheet** (validation, verification or transfer protocol). |
| **Validation worksheet** | A method of validation blocks (`shared/blocks/validation.ts`): specificity (L34), linearity (L27), accuracy (L28), precision (L29: repeatability, intermediate precision by ANOVA), DL/QL by calibration or signal to noise (L30), robustness (L32), transfer comparison (L33). The acceptance criteria are the blocks' limit settings. Its analyses run without a sample (refused with one), are signed, checked and reviewed as any analysis. Skeletons: "Validation: assay (HPLC)", "Verification: pharmacopoeial method", "Method transfer: comparative testing". |
| **Report** (`MVR26xxxx`) | `method_reports` (insert-only): kind validation / verification / transfer, the method version, the type of test (ICH Q2 Table 1: assay, impurity quantitative, impurity limit test, identity, other), the protocol number, the sending and receiving laboratory (transfer), the reviewed worksheet analyses it covers, the results as read (`inputs`) and per characteristic met or not (`outputs`, conclusion met / not met). Nothing typed but the protocol number and the laboratories: the results are read from the analyses (the last signed round of each validation step); the range (L31) is worked out from the last linearity, accuracy and precision steps against the use the linearity step names (Table 2). The conclusion is met when every characteristic shown is met and none Table 1 asks for the test type is missing (verification: what its protocol chose; transfer: the comparison). Signed by its preparer (`prepared`, `lims.master.author`), reviewed by QC (`reviewed`, `lims.analysis.review`, another person) and approved by QA (`approved`, `lims.master.approve`, a third person); `method_report_events` insert-only. |
| **Validated outside LIMS** | The fallback for a method validated on paper before LIMS: a report with `outside`, the paper report's number, no analyses; QA approves it as a second person (not the person who recorded it). |
| **LIMS-02, LIMS-04: where checked** | In the method's **make-effective** step (`reviewRefusal`, `useRefusal`): the version becomes effective only with an approved report whose conclusion is met, of the kind its origin needs (a validation also counts for a pharmacopoeial method), for this version or an earlier one of the same method. Why there: one check, at the one place a method becomes usable; every analysis (release, stability, monitoring, retest) starts from an effective version, so none needs its own check, and the existing analysis code is untouched. A later version keeps its earlier validation; QA sees on the methods list which version and report it rests on, and its change control decides on revalidation (Q2 / Q14). A transferred method is used only after its approved transfer report (LIMS-04). A validation worksheet needs none. |
| **Screens** | Methods: a Validation column (validated / verified / transferred, outside LIMS, or not yet; the report number) and "Validation reports": the list, "New report" (method version, kind, type of test, protocol number, laboratories, the reviewed worksheet analyses; "Work out the conclusion" shows each characteristic, then "Sign as prepared"), and the report screen with "Review (QC)" and "Approve (QA)". The method header has "Source" and "Used for". QC reviewers see the Methods tab. |

**Report PDF**: `GET /api/method-reports/:id/pdf` (`server/method-report-pdf.ts`, pdfmake as the CoA), made again from the stored
report and its signatures: number, method code, version and origin, protocol (or "validated outside LIMS: paper report"),
laboratories, per characteristic the protocol's acceptance criteria, the result with its worked figures and analysis
number, met or not, the conclusion and the three signatures with times. "Download the report (PDF)" on the report screen.

Not in this round: a published view for QMS (method status
in the APQR, step 8 APQR views may read `method_reports`); non-linear and multivariate calibration (owner, 18 Nov 2026);
the CDS import on the validation blocks (their responses are typed and checked by a second person, as every validation
step has a checker).

## Hotfix 19 Nov 2026: viscosity, every TrueBatch edition, bulk release samples

Found making the TrueBatch Liquids release CoA (TL260004) on the demo screens.

| What | How |
|---|---|
| Viscosity units | `shared/templates/units.ts`: dynamic viscosity mPa·s (= cP), Pa·s, P; kinematic viscosity mm²/s (= cSt), m²/s. The two kinds never convert into each other (that needs the density). |
| Every production edition | One link per TrueBatch edition (`TRUEBATCH_<EDITION>_DATABASE_URL`, `shared/engine/links.ts` `TB_EDITIONS`), read as one provider "TrueBatch": `batch_fact_v1` of truebatch, truebatch_capsules, truebatch_liquids, truebatch_injectables and truebatch_api. A list is the rows of the editions that answer (down only when none does); a lookup that finds nothing while one edition is down answers down, so the batch may be typed by hand. Each batch names its edition ("TrueBatch Liquids batch TL260004"). |
| Bulk release sample | A batch takes its release sample from production on (the bulk at its QA hold, before packing) until it is released; never when rejected or cancelled (`batchWaiting`). |
| OOS as reported | The OOS screens and `oos_v1` (value and shown, migration `0024`) give the result rounded half up as its limit is written, the CoA's rule (`reportedFigure`); the full value stays in the OOS record and its worked line. Found on the demo: OOS260001 showed 0.8991… % for 0.9 %. |
| Bare reported figure | The TrueBatch–LIMS contract: `result_v1.reported` is the figure as reported, rounded as the limit is written, as text without its unit ('1.25', '0.500'); a result with no number gives its text ('Conforms: …'). Every row, those decided before `reported` was kept too (rounded in the view). `reported_text` appended at the end: the printed text with its unit, as on the CoA. Migration `0025`. |
| Packing batches | A packing edition's finished packs (`packing_batch_v1`, the same columns) take their release sample as a production batch does: truebatch_packing, truebatch_capsules_packing, truebatch_liquids_packing and truebatch_injectables_packing are read with the production editions. |

## In-process samples, individual values, sample_v1 (owner 19 Nov 2026)

In-process tests in every TrueBatch edition (Injectables and Liquids bulk tests, API IPC, Tablets and Capsules BU/CU) are picked from LIMS, not typed. Migration `0026`. No new mechanism: a sample purpose, a column, a counter and published columns.

| What | How |
|---|---|
| Requests | Every TrueBatch edition publishes `lab_request_v1` (one row per request a step with in-process QC fields opens: `request_id` '<batch>/<step key>', batch, product, stage and step titles, `tests` [{name, label, unit, individual}], `requested_at`, status open/done/cancelled). LIMS reads it from each edition's link (`truebatchClient.openRequests`, `request`, `requestFields`). |
| The sample | Samples screen, "In-process requests" (sampler or analyst): the open requests of every edition, oldest first, each with the product's effective **In-process** specification or why it cannot be tested (`requestProblems`: not open; no specification; a field with no test). "Take the sample" asks only the quantity: `POST /api/samples/in-process` makes the sample with purpose `in_process`, the batch as its lot, the product from master data, and the request as read (`samples.request`); one sample per request (unique index). Never typed by hand: while the link is down the request waits. |
| Its tests | An in-process specification test names the TrueBatch field it answers (`ipcField`, picked in the spec editor from the fields the product's requests have named; `specChecks`: each test of an In-process specification names one, once). The sample is tested for the tests whose field its request names (`sampleOnly`, `testApplies`: the same rule as a monitoring sample's one test); an analysis covers only those. |
| Decision | Received, analysed, reviewed and approved as any sample; approval numbers an **in-process test report** `IPR` + plant year + 5 digits (`ipr_counters`) in `coa_number`; the PDF from the sample screen is titled "In-process test report", with the request. |
| Turnaround | The in-process target is hours: `tat_targets.days` takes 3 decimals (default 0.125 day = 3 h); the work list shows the due time and flags it overdue. |
| Individual values | A block may name its `units` fields (the units' results, in order): content uniformity (10, then 20 more), the new blend uniformity block (10 locations: mean and % RSD by T7, each location by C3). Uniformity by weight gives T14's contents. `result_v1` gains at its end `request_id`, `purpose`, `individual_values` numeric[] (as recorded; CU: one row with 10 or 30 values, L1's first), `figure` ('mean', 'AV', 'result': what `reported` is) and `ipc_field`; `coa_v1` gains `request_id`. The CoA and report list the individual values. |
| Phase II auto-link | The deviation Deviations files from an OOS (`deviation_v1.source_ref` 'lims:oos:<oos_v1 oos_id>', or the OOS row id or number) is its phase II deviation, read live, nobody picking it (`OosFacts.filedDeviation`, `phase2`); the pick stays for a deviation filed without it. |
| sample_v1 | For MMS (D-77: while LIMS is linked, LIMS owns sampling of a received lot; MMS shows it and takes the quantity off stock once): one row per material or product sample: `sample_id`, `sample_number`, `lot_number`, `item_kind`, `item_master_id`, `purpose`, `quantity` numeric and `unit` (split from the registered "120 g"), `containers`, `sampled_by`, `sampled_at`, `status` (registered, received, decided, disposed), `read_at`, `data_as_of`, `container_numbers`, `request_id`. |

## EM: time taken and batch (owner 19 Nov 2026, LIMS owns EM)

`em_v1` gains at its end `sampled_at` (when the sample was taken; `taken_on` is only the plant day) and `batch_number` (the TrueBatch batch it was taken during; null when none). Migration `0027`. The sampling dialog picks the batch from TrueBatch's running batches of every edition (`GET /api/em/batches`): needed for a per-batch sampling, optional for any other; typed by hand (then checked by a second person) only while TrueBatch does not answer.

## In-process tests matched by code (TrueBatch round 45)

`lab_request_v1` tests carry a `code` unique within the product ('<block id>.<field>'; content uniformity one test of up to 30 units); `name` stays the TrueBatch field name. An in-process specification test's TrueBatch field holds the code (picked from the codes the product's requests published; a request without codes matches by its name, `testCode`). At QC approval the result keeps the field name it fills (`ipcName`): `result_v1.ipc_field` publishes the name, and `ipc_code` (appended, migration `0028`) the code. `ipc_code` is null for a request without codes (opened before TrueBatch round 45; migration `0029`): TrueBatch reads a non-null `ipc_code` as a code.
