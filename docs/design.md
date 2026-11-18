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
