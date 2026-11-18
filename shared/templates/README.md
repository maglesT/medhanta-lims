# Medhanta LIMS: calculation and check templates (version 2)

Small, pure TypeScript functions. One function per template. No formula language, no parser, no
expression engine. The master analysis record picks a template and its inputs. Underneath there is
only GMP maths: exact decimals, unit conversion, pharmacopoeia rounding at limits, and refusals in
plain English.

Shared code: the server and the designer's live preview both use it. Tests are in `test/templates/` and run
with the rest of the suite (`npm test`, `npm run ci`). They need no database.

## How every template works

- **Inputs are text.** Each value is a string with its unit: `"50.300 kg"`, or `{ value: "50.300", unit: "kg" }`.
  A JavaScript number is refused, because it is binary floating point. Values are held as
  `decimal.js` decimals with 50 significant digits. Large counts can be written `"3e9"`.
- **The result** is `{ ok: true, value, unit, shown, check? }`:
  - `value` is the full-precision decimal. It is never replaced by a rounded figure.
  - `shown` is the worked line in plain words for the screen, e.g. `50.300 kg ÷ 51.000 kg × 100 = 98.6 %`.
  - `check` is present when the master attached a `limit` (see C1).
  - Some templates add their own fields (T4 `unaccounted`, T7 `stats`, T14 `decision` …).
- **A refusal** is `{ ok: false, message }`. The message says in plain English what is wrong and what to do.
- **Display decimals** can be set with `decimals`. Defaults: kg 3, g/mg 2, % 1.
- **Numbers inside a worked line** follow one rule (`shownNumber` in `core.ts`): a value written with at most 4
  decimals is shown as written; a full-precision value passed on from an earlier calculation is shown at the unit's
  display decimals + 1 (kg 4, g and mg 3, % 2; at least 4 significant figures when small), cut and marked "…"
  (`10.2553… kg`), so rounding the shown figure gives the same result. The value before rounding at a limit is shown
  with 2 decimals more than the limit. Only the display is shortened; nothing is rounded inside a calculation.

## Units (`units.ts`)

There is one fixed list, one line per unit. Only units of the same kind convert.

| Kind | Units |
|---|---|
| mass | µg mg g kg |
| volume | µL mL L m³; US gal (231 in³), imp gal (20 % larger: they never share a symbol, a bare "gal" is refused) |
| length, area | µm mm cm m; mm² cm² |
| time | s min h d |
| temperature | °C °F K (offsets exact); temperature difference Δ°C ΔK Δ°F |
| force | N kN kp (1 kp = 9.80665 N exactly) |
| pressure | Pa hPa kPa MPa N/mm² bar mbar psi mmHg atm kgf/cm² kN/cm² |
| content | % %w/w ppm µg/mg mg/g (1000 µg/mg = 100 %); %w/v mg/mL g/L (a separate kind); density g/mL g/cm³ kg/L kg/m³ |
| rates | rpm; g/h g/min kg/h g/s; mL/h mL/min L/h L/min m³/h cfm; units/h units/min tablets/h tablets/min |
| electrical | mA A; W kW; kJ/kg kWh/kg |
| humidity | %RH, g/kg (dry air) and g/m³ (of air). These never convert into each other: use T25. |
| potency | IU, CFU, U (activity units); IU/g IU/mg, CFU/g CFU/mg, U/g U/mg; mg/IU. These never convert to a mass. |
| other | ° (angle); mg/cm² g/m² (coat per area); mm³; rad/min (↔ rpm); kgf alongside kp; SCU (Strong-Cobb hardness, its own kind: published factors to kp disagree, so it never converts) |
| frequency | Hz (drive frequency): never converts to rpm; Hz × rpm/Hz (the equipment record's factor) = rpm in T8 product |
| charge | mEq: becomes a mass only in T11, with the ion's charge |
| count | units, tablets; plain number; log |

Temperatures are never added (T2 refuses them). A difference of two temperatures is a temperature
difference. When it is compared with a limit written in °C, the difference unit is used.

## Rounding at limits (`rounding.ts`, also C1)

- The result is rounded to the number of decimals of the limit as written, half up, and only then compared.
  The rule paraphrases the USP General Notices. Example: 94.95 against 95.0–105.0 passes; 94.94 fails.
- When the two bounds are written with different decimals, the finer one is used.
- One-sided limits are allowed (low only or high only), and either bound may be strict ("more than").
- Tiers: the action limits are the specification. Optional alert limits sit inside them. The result is
  `pass`, `alert` (passes, flagged) or `fail`.
- The value is converted into the limit's unit before rounding.

## Calculation templates

| ID | Name | Inputs | Output | Settings | Refusals |
|---|---|---|---|---|---|
| T1 | Difference | a, b (gross, tare; inlet, exhaust …) | a − b | result unit; names; `allowNegative` | tare above gross (unless allowed); different kinds |
| T2 | Total | list of values | sum | result unit | empty list; temperatures; percentages; mixed kinds |
| T3 | % of target (yield) | actual, theoretical | actual ÷ theoretical × 100 % | limit | theoretical ≤ 0; negative actual; temperatures |
| T4 | Accountability and unaccounted | input; named parts (output, samples, rejects, waste) | Σ parts ÷ input × 100 %; also unaccounted = input − Σ parts (quantity and %) | limit on %; limit on unaccounted (kg, tablets or %) | input ≤ 0; no parts; negative part; mixed kinds |
| T5 | % change | before, after | change ÷ base × 100; gain = after − before, loss = before − after | mode gain/loss; **base (one setting, required)**: this layer's own starting weight, the final weight, or a named earlier stage (e.g. the uncoated core) | no base chosen; base ≤ 0; temperatures |
| T6 | Ratio and powder indices | a, b | a ÷ b; Carr = (tapped − bulk) ÷ tapped × 100; Hausner = tapped ÷ bulk; log10(a ÷ b); angle of repose = arctan(height ÷ radius), or arctan(2 × height ÷ diameter), in degrees; **whole containers** = a ÷ b rounded up, with the excess (F0087) | mode; result unit (tablets, %, MPa, kN/cm², g/mL, mg/cm², mg per unit …) | ÷ 0; tapped < bulk; kinds that do not make a ratio; log of ≤ 0; height or radius ≤ 0 |
| T7 | Statistics of readings | series; or a per-unit value from 2 readings (first − second) or from any number of readings on the same unit (first minus rest, sum, or split loss % = (whole − Σ parts) ÷ whole × 100) | mean (value), SD (n − 1), % RSD, min, max, count | limit on the mean; limit on % RSD | no readings; mixed kinds; RSD from one reading |
| T8 | Analysis scaling | per unit × count; % w/w × analysis weight; rate × time; per area: mg/cm² × surface area (from the tooling record) × count; product of 2 or 3 recorded values (L × W × H; Hz × rpm/Hz) | quantity (kg by default; IU stay IU; lengths give mm² or mm³) | mode; result unit | count not a count; % outside 0–100; rate not per time |
| T9 | Potency-adjusted quantity | standard quantity (or the T11 result), assay, basis, water / LOD / solvents | standard × 100 ÷ assay as is. As is = A × (100 − W) ÷ 100 (anhydrous), A × (100 − LOD) ÷ 100 (dried), A × (100 − LOI) ÷ 100 (ignited), A × (100 − W − S) ÷ 100 (anhydrous and solvent-free) | basis; `standardIs` anhydrous or hydrate/solvate; `assayExpressedAs`; `potencyAs` parent or element; assay above 100 % used or taken as 100 | **C5 rules** (below); missing water/LOD/solvents; assay ≤ 0; water/LOD outside 0 to <100 %; standard not a mass |
| T10 | Compensating excipient | filler(s) with standard quantity (and ratio); adjusted materials (standard, adjusted) | filler = standard − Σ (adjusted − standard), shared over several fillers in a ratio (default: their standard quantities) | several adjusted materials at once (excesses + or −); several fillers | **any filler negative** (the analysis weight cannot be kept); no filler; not masses |
| T11 | Salt / base factor | quantity of form A; MW and molecules per unit of form A and form B; whether form B's MW includes crystal water/solvent | quantity × (MW B ÷ n B) ÷ (MW A ÷ n A) | any two named forms (base ↔ salt, salt ↔ salt, element ↔ compound, cocrystal); **molecules per formula unit** (default 1; hemifumarate, calcium salts = 2); **a quantity in mEq**: mmol = mEq ÷ the ion's `charge`, ÷ ions per unit × MW (F0393); **`writtenFactor`** checked against the MWs at its decimals (F0062); **`mwFromLot`** with `lotMw`: an average MW from the lot's certificate (F0018) | MW ≤ 0; molecules not a whole number ≥ 1; **a hemi-salt at 1 molecule per unit with a MW at least twice the other form's** (the whole formula unit's MW: the dose would double); not a mass; a written factor the MWs do not give; mEq without the ion charge; a lot MW not given |
| T12 | Quantity from dry basis | quantity, LOD | dry → as is: dry × 100 ÷ (100 − LOD); reverse: as is × (100 − LOD) ÷ 100 | direction | LOD outside 0 to <100 % |
| T13 | Duration and hold time | start, end; or timed readings of a monitored value | end − start; or time counted only while the value is inside limits | unit min/h; limit (max and/or min); target time (accumulated mode) | end before start; bad or impossible date; readings out of time order |
| T14 | Content uniformity acceptance value | 10 or 30 individual contents (% of label claim); or unit weights + assay + label claim | AV = \|M − X̄\| + k·s, with the stage decision; **stratified** (`t14Stratified`, F0229): RSD of N locations × n units against the largest RSD of the master's Bergum (ASTM E2709) table at that mean, interpolated | method: content uniformity, weight variation, large sample; target T; L1, L2; coating type; "individual results only" | **weight variation for sugar-coated or other coated tablets**; weight variation below 25 mg or 25 %; weight variation with "individual results only"; n not 10/30; large sample with ≤ 30 units |
| T15 | Re-scale to actual yield | formula quantity, actual and theoretical intermediate | formula × actual ÷ theoretical | window on actual ÷ theoretical (e.g. 90.0–102.0 %) | outside the window (with rounding); theoretical ≤ 0 |
| T16 | Overage | quantity (after potency), overage % | quantity × (100 + overage) ÷ 100, and the overage amount kept separate | highest allowed overage | negative overage; above the allowed overage |
| T17 | Liquid make-up | w/w: dry components, liquid ingredients with their own solids (by mass, or by volume with density), overage, target % solids. w/v: solutes at % w/v, final volume | w/w: total solids, total liquid, **solvent to add** (and its volume with a density). w/v: each solute's mass; make up to volume | mode; overage; solvent density | **solvent to add negative** (target solids too high); target ≤ 0 or > 100 %; liquid by volume without density |
| T18 | Content-adjusted quantity (any material) | formula quantity, the lot's content | pure × 100 ÷ content %; units ÷ units per gram (IU/g, CFU/g, U/mg); IU × mg/IU | `formulaQuantityIs` dry or wet (wet needs the nominal content); content source (certificate or in-process result); **`resultType`** content or % of theoretical (× the nominal content, F0205); **`second`**: a second API in the same intermediate, its delivered quantity shown and checked (F0187) | **IU/CFU/U with a % content** (never a mass); target and content units that do not match; content ≤ 0 or > 100 %; % of theoretical without the nominal content; **the second API out of its limits** |
| T19 | Split into portions | total; portions as %, fixed quantity or the remainder | each portion; remainder = what is left; check that the parts add up | which portion is the remainder | remainder negative; not exactly one remainder |
| T20 | Multi-lot quantity | required pure quantity; lots with weighed quantity and content | pure content per lot; quantity still to weigh from the last lot; total weighed (feeds T10) | without a required quantity: pure content delivered (e.g. amylase units) | earlier lots already give more than needed; lots with different kinds of content |
| T21 | Lesser / greater of values | named values | the smallest or largest, and which one | lesser or greater | fewer than two; mixed kinds |
| T22 | Sieve analysis | sample weight; sieves (coarsest first) with weight retained; pan. **Mixed lots** (`t22MixPsd`, F0418): each lot's mass and laser-diffraction table | % retained (of the weight recovered), cumulative %, % passing, recovery % (value). Mixed lots: mass-weighted cumulative % undersize, then D0.5, D0.9 … by interpolation, with limits | % fines below a named sieve; d50 by linear or log interpolation; limits on recovery and fines | sieves not coarsest-first; negative weights; fines sieve not used; d50 outside the sieve range |
| T23 | Compact strength and solid fraction | breaking force, diameter, thickness (convex: wall thickness); weight and true density | tensile strength MPa: flat round 2F ÷ (πDt); convex round by Pitt, Newton and Stanley (1988); **fracture area** F ÷ (D × H) in N/mm² (F0039); apparent density, solid fraction, porosity | shape; ribbon mode: envelope density ÷ true density | missing wall thickness; wall > thickness; SF > 1; convex SF without a volume |
| T24 | Extruder specific mechanical energy (optional) | motor power, torque %, screw speed, maximum speed, feed rate, efficiency (default 1) | SME kWh/kg = P × torque/100 × N/Nmax × η ÷ feed | limit | torque outside 0–100; speed above maximum; feed ≤ 0; efficiency outside (0, 1] |
| T25 | Absolute humidity (optional) | % RH, temperature, pressure (default 1013.25 hPa) | g water per kg dry air (Magnus formula, WMO constants), or **per m³ of air** e × 18.01528 ÷ (8.314462618 × T) (F0033); and the dew point | `per`; limit in g/kg or g/m³ | RH outside (0, 100]; temperature outside −45 to 60 °C |
| T26 | Mix to a target | mass of the main lot A and its value a; the donor lot's value b; the target t (a % size fraction, an assay, an LOD …) | donor to add = mA × (t − a) ÷ (b − t); the mixed total; other markers of the mix (F0450) | result unit; **`scale: 'ethanol % v/v'`**: strengths to % w/w at 20 °C by the OIML R 22 formula, donor volume shown (F0008); **`basis`** of each value (F0027); **`others`** with limits | **b not on the far side of t from a** (no amount can reach the target); temperatures; mass not a mass; **values on different bases**; **properties that do not mix by mass** (sizes, hardness, pressure, pH: F0418); another marker out of its limits |
| F8 | Diversion window (pure calculation only) | excursion start and end; shortest and longest residence delay; line rate | divert from start + shortest to end + longest; window minutes; quantity = rate × window. Reverse: the lots that could be in the tablets made in a window | rate in kg/h, tablets/h or L/h | end before start; longest delay shorter than shortest |

| T27 | Expiry from the shelf life (packing, TB-P8) | date of manufacture (YYYY-MM-DD), approved shelf life in months, rule ("month before": the end of the month before; or "same month") | expiry month = month of manufacture + shelf life (− 1); the worked line | — | date not YYYY-MM-DD; shelf life not 1–120 whole months |

F1–F7 and the rest of F8 (step flow) belong to the analysis engine and are not here.

## Check templates

| ID | Name | Inputs | What it checks | Refusals |
|---|---|---|---|---|
| C1 | Within limits | value, limit; or ± % / ± amount around a value computed earlier in the analysis (e.g. the target tablet weight from the blend assay) | low–high, one side, strict bounds, alert/action tiers, pharmacopoeia rounding, unit conversion; around a centre: the deviation is rounded to the decimals of the ± figure | bad limit text (no exponents), low above high, alert outside action, unit of another kind |
| C2 | Count of readings | the readings (or the count), required number | exactly N, or at least N | count not a whole number |
| C3 | All individual values | series (or pairs); band: absolute limits or ± % of the mean / of a target; number allowed outside; outer band where none may be outside | each unit; e.g. not more than 2 outside ± 5 %, none outside ± 10 %. A ± % deviation is rounded to the decimals of the % written | negative band; bad count allowed |
| C4 | Observation | question; answers (per unit or one); expected answer(s); fixed list (default yes/no); failures allowed | pass/fail; `triggersF3` when it fails | answer not in the list; no answer |
| C5 | Same basis (safety rule, built into T9) | whether the standard is the anhydrous or hydrate/solvate weight; assay basis; what the assay is expressed as; whether the potency is "as parent"; whether a T11 factor is in the chain | refuses: (1) hydrate/solvate MW **and** a water/LOD/solvent correction (pantoprazole: about 6.7 % too much); (2) hydrate weight with an as-is assay expressed as the anhydrous substance; (3) anhydrous weight with an assay expressed as the hydrate; (4) **potency "as parent" (µg parent per mg of material) or "as element" (% Ca, % Zn, % Fe) with a T11 salt/ester/hydrate/compound factor in the same chain** (azithromycin dihydrate ×1.048, cefuroxime axetil ×1.203, faropenem sodium hemipentahydrate ×1.235, calcium carbonate ×2.497, zinc sulfate monohydrate ×2.745 too much); (5) "as parent"/"as element" with a salt/compound weight as the standard. **Allowed**: a factor from the labelled salt or hydrate *down* to the form the potency or assay is on (below 1, to a form without crystal water): procaterol HCl hemihydrate → anhydrous then a water correction (F0088), desmopressin acetate → base with the peptide content as base (F0434). A solvate MW with a solvent-free basis counts the solvent twice (F0201) | — |
| F2 helper | No further change (`noFurtherChange`) | previous round's reading, this round's reading, the largest change (an amount, or % of the previous reading) | "constant weight": \|current − previous\| rounded to the limit's decimals ≤ limit → stop repeating. The round loop itself is the engine's (F2) | readings of different kinds; % change from zero |
| C6 | Staged test | test type and the results of each stage | disintegration (6, then 12 more, 16 of 18); content uniformity L1/L2 (via T14); dissolution IR S1–S3; ER L1–L3 per time point; delayed release acid A1–A3 and buffer B1–B3. Says pass, "next stage" (and how many more units) or fail | wrong number of units per stage; wrong number of time points |
| C7 | Sampling plan by lot size (AQL) | lot size, inspection level (S-1…S-4, I, II, III), AQL per defect class, defects found (optional) | code letter (Table I), sample size, accept/reject per class (Table II-A single, normal, arrows followed); 100 % inspection when the sample would reach the lot size; accept/reject when defects are given | AQL not a table column (0.010–10 only); unknown level; lot size not a whole number |
| C8 | Printed data (packing, TB-P5, TB-P9) | what is checked; the text as printed; the analysis record's value: a text (analysis number), a month (date of manufacture), the expiry (worked out by T27 from the date of manufacture and shelf life) or the MRP (none when the pack has none) | the printed text against the analysis record, after its printed label in any punctuation, spacing and case ("B.No.", "MFG.DT.", "MFD.", "Mfg. Date", "EXP.DT.", "EXP.", "Use before", "M.R.P. Rs. … (Incl. of all taxes)"): text without spaces and case, months in the usual printed forms ("10/2028", "OCT.2028", "10-28"), money as its amount; the values themselves exactly | no printed text; a bad date of manufacture or shelf life |
| C9 | Serialisation codes (packing, TB-P5) | the codes read from sample packs ("(01)…(17)…(10)…(21)…" or raw with a group separator); the pack GTIN; analysis number; date of manufacture and shelf life; the codes of earlier rounds | each code: GTIN, analysis and expiry (AI 17, YYMMDD) are this analysis's; a serial of 1 to 20 GS1 characters; no serial twice in the round or in an earlier round. Checks only: no serial numbers are made or kept | no code; a pack GTIN without its right check digit |

C7 uses the MIL-STD-105E tables, which are US government work in the public domain. They give the
same numbers as ANSI/ASQ Z1.4 and ISO 2859-1 single sampling, normal inspection. The ISO text is not
copied. "AQL 0" for critical defects is treated as a plant rule: accept 0, reject 1, at the code
letter's sample size.

## Calculation checks in the master check

Error-proofing at master-building time (owner decision of 15 November 2026), not GMP rules. The master check
(`shared/master/checks.ts`) shows each on its item, with its path. Tests: `test/master-checks.test.ts`
("calculation check").

| | Check | Where |
|---|---|---|
| ⛔ | Water counted twice: hydrate or solvate MW together with a water/LOD correction | C5 in T9, on the formula line |
| ⛔ | Potency "as parent/base" or "as element" with a salt, ester, hydrate or compound factor up to the weighed form (a factor down from the labelled salt to the parent is allowed: F0434) | C5 in T9, on the formula line |
| ⛔ | Molecules per salt unit ignored: a hemi-salt at 1 molecule per unit with a MW at least twice the other form's | T11, on the formula line |
| ⛔ | Negative filler: a compensating filler that cannot take the adjustments even at the nominal certificate values (salt factor, overage) | T10, on the filler |
| ⛔ | IU, CFU or activity units turned into a mass | T18, on the formula line |
| ⛔ | Negative water or solvent, or target solids out of range (T17): a calculation that needs no recorded value is worked out from the step's settings | the binder solution or coating suspension step |
| ⛔ | Weight-variation content uniformity on coated tablets other than film-coated (T14): the block's coating list has only uncoated and film-coated, and T14 refuses any other in the analysis | the uniformity by weight variation step |
| ⚠️ | (a) Label basis: an API with a salt factor or a salt name: is the strength stated as the formula form or the other form, for this master's market? | formula line |
| ⚠️ | (b) A herbal or extract line: raw-herb equivalent or extract weight? | formula line |
| ⚠️ | (c) A ratio or % in a step instruction that involves the API: as weighed, as base or as anhydrous? | step |
| ⚠️ | (d) The API potency-adjusted at dispensing (T9/T18) and a line set again from an in-process granule or blend assay (T18): confirm intended, with a reason, or remove one | the in-process line |
| ⚠️ | (e) A salt factor written in the formula that differs from the molecular-weight ratio of the named forms by more than 0.5 %: confirm, with a reason, or correct it (the quantity uses the molecular weights) | formula line |

| ⛔ | A analysis quantity written on a line that the quantity per tablet × the analysis size (T8) does not give, at its decimals (F0303, F0388) | formula line, `analysisQuantity` |
| ⛔ | One material twice in the same place (and layer) with two quantities (F0250) | the second line |
| ⛔ | The coating lines do not add up to the coated − core weight (the core lines against the core weight were already checked: F0159, F0042) | formula |
| ⛔ | The API per tablet does not give the label claim (0.5 %), on the label basis answered in (a): the formula form, or the other form by the MWs. An excess must be a declared overage (T16), which the analysis quantity adds (F0122, F0123, F0229) | formula line, `labelClaim` |
| ⛔ | The same for each strength compressed from the same blend: API per tablet × that strength's core weight ÷ this core weight (F0225, F0366) | `header.otherStrengths` |
| ⛔ | A label claim in mEq without the ion charge on the salt form (F0393: 3 times the potassium when read as mmol of the salt) | formula line |
| ⛔ | An in-process result into T18 without saying whether it is the content or a % of theoretical (F0205: about a third of the dose) | the in-process line |
| ⛔ | A coat or spray step using a liquid made with an overage, without the liquid to apply per charge (F0339: +4.5 % drug, +14 % coat when all is sprayed) | the spray step |
| ⛔ | T26 refuses properties that do not mix by mass (D50, hardness, pH: F0418), values on different bases (F0027) and a second marker pushed out (F0450) | the step using T26 |
| ⚠️ | (f) Label basis for each other strength from the same blend | `header.otherStrengths` |
| ⚠️ | (g) The core weight against the die bore area × the compression thickness: an apparent density outside 0.5-2.5 g/cm³ (F0135: a 10 × unit error) | the compression step |
| ⚠️ | (h) A mean-weight limit that holds neither the core nor the coated weight: the weight at which stage? (F0175) | the limit |
| ⚠️ | (i) An API named wet, cake or damp with no solvent correction (F0204: about 23 % too little) | formula line |
| ⚠️ | (j) A processing aid (polyethylene, camphor, menthol …) not marked removed in processing (F0476: about 12.5 % too much drug) | formula line |
| ⚠️ | (k) A particle-size, surface-area or crystal-form test with one limit only (F0490: Cmax 67.5-130 %) | the limit |
| ⚠️ | (l) An order-critical step (`orderAfter`) no longer after the step it must follow (F0318) | the step |

A ⚠️ needs an answer: one of its choices, with a reason for (d) and (e). The answer is kept in the master document
(`answers`, by warning and item) and shown in the review and changes views. It counts while the warning reads the same
as when it was answered; until then the warning blocks "Send for review" and approval like a ⛔.

## Pharmacopoeia rules written from the chapters (paraphrased; no chapter text copied)

- **T14 (USP <905> / Ph. Eur. 2.9.40).**
  - Reference value M: for T ≤ 101.5, M = 98.5 if X̄ < 98.5, M = X̄ up to 101.5, and M = 101.5 above that.
    For T > 101.5, M = 98.5 if X̄ < 98.5, M = X̄ up to T, and M = T above that.
  - k = 2.4 for 10 units and 2.0 for 30 units.
  - Stage 1 passes if AV ≤ L1 = 15.0. Stage 2 passes if AV ≤ 15.0 and every unit lies within 0.75 M to 1.25 M (L2 = 25.0).
  - Weight variation is only for uncoated and film-coated tablets, with ≥ 25 mg of drug making up ≥ 25 % of the unit.
- **C6.** USP <701> / Ph. Eur. 2.9.1 for disintegration, and the USP <711> acceptance tables for dissolution.

## Settings left to the engine (smallest data-level option)

- **F4 by a rule** (F0040): a step's `onlyIf` (a limit on the analysis size or the core analysis weight) leaves it out as not
  applicable, with no operator choice. A rule on a value recorded during the analysis is not supported.
- **F6 with a changing interval** (F0030): `everyMinutesLater` (after N minutes from the first round, a round every M
  minutes; still at most the block's interval, TA-15). A change "as the target nears" (on a value) is not supported.

## Decisions taken while building (see also the report)

- **T13 accumulated time:** an interval between two readings counts only when both readings are inside the limits.
  This is conservative: time next to an out-of-limit reading never counts.
- **T14 large sample (Ph. Eur. 2.9.47):** the library does not hold that chapter's table. The master supplies k
  for the sample size and the number of units allowed outside 0.75 M–1.25 M.
- **T9 "as is" with a hydrate weight:** refused unless the master confirms that the assay is expressed as the hydrate.
  This is stricter than "no further water correction", because an as-is assay expressed as the anhydrous
  substance also counts the water twice.
- **T22:** % retained is of the total weight recovered. Recovery against the sample weight is the template's value.
- **T26 ethanol:** % v/v ↔ % w/w at 20 °C from the density polynomial of the international alcoholometric tables
  (OIML R 22, Council Directive 76/766/EEC, 12 coefficients), solved by bisection; 96 % v/v = 93.84 % w/w.
- **Written salt factor:** in the master it stays the answered warning (e), because the analysis quantity uses the
  molecular weights, not the written factor; T11 refuses a `writtenFactor` only where a calculation is given one.
- **T14 stratified:** the library does not compute Bergum's acceptance limits (ASTM E2709); the master supplies the
  table for its sample size, confidence and coverage, as for the large sample.
- **T25:** Magnus formula over water with the WMO (Sonntag 1990) constants 6.112 hPa, 17.62, 243.12 °C. The ratio
  621.98 is 1000 × M(water) ÷ M(dry air).

## Files

- `dec.ts`, `refuse.ts`, `core.ts`: decimals, refusals, reading values, display. `index.ts` exports everything.
- `units.ts`, `rounding.ts`
- `basic.ts` (T1–T6, T21), `series.ts` (T7, C1–C4, noFurtherChange), `mixing.ts` (T26 and the alcohol table),
  `dispensing.ts` (T8–T12, T15, T16, T18–T20, C5), `liquid.ts` (T17), `time.ts` (T13, F8), `uniformity.ts` (T14),
  `physical.ts` (T22, T22 mixed lots, T23–T25), `staged.ts` (C6), `sampling.ts` (C7); `uniformity.ts` also T14 stratified;
  `packing.ts` (T27, C8, C9: TrueBatch Tablets Packing)
- `test/templates/*.test.ts`: table-style tests. Every test name starts with its template ID. Each expected number
  has its hand calculation in a comment. Real cases cite the formulation number from the formulation test.

## Lab assay templates (`lab-assay.ts`: L1-L4, L9, L20)

From the LIMS template library (3b, 8b, 8d). Same rules as above: text inputs with units, exact decimals, the result
kept at full precision and rounded only at the limit (C1). Tests: `test/templates/lab-assay.test.ts`.

New units: **µg/mL** (mass concentration, 1000 µg/mL = 1 mg/mL); **AU, mAU** (absorbance, their own kind: never a
concentration); aliases **µg/g = ppm**, ug/mL, mcg/mL. A peak area or height is a plain number.

| ID | Name | Inputs | Output | Modes / settings | Refusals |
|---|---|---|---|---|---|
| L1 | Assay by external standard | sample readings (mean of replicates); standard readings; the standard from its item: weighed mass, potency and its basis (as is, dried, anhydrous; with the standard's own LOD/water, or "dried before use"), or a declared concentration (reference solution, prepared standard TS); dilution chains (first flask, then aliquot → volume made up to); the sample by mass, by volume or as N whole units; average unit weight; weight per mL | C sample = R sample × C standard ÷ R standard (mg/mL); × sample dilution = amount found; result per mass (% , mg/g, ppm, µg/mg …), per unit (mg), per volume (mg/mL, % w/v); `sampleConcentration`, `standardConcentration`, `amount`, `curve` | `mode`: **external standard** (single); **bracketing** (mean of the mean before and the mean after); **internal standard** (ratio analyte ÷ internal standard per injection, mean of the ratios); **calibration curve** (least squares of ≥ 3 standards, optional through the origin, optional internal standard ratios, `minR` checked with rounding, read-back); **specific absorbance** (A ÷ (A(1 %, 1 cm) × b) in g/100 mL, or A ÷ (a × b) in g/L; no reference standard; optional IU per mg). `response` peak area, peak height or absorbance. A fixed blank or untreated reading taken off the mean (sample and standard). `onBasis`: the L3 conversion of a result per mass | **S1** the form of the specific absorbance not stated (10 ×); path length missing; **S3** standard dried before use with an LOD/water correction, as-is potency with a correction, dried/anhydrous potency without the standard's LOD/water; **S7** result per mL from a liquid taken by mass without its weight per mL; sample outside the calibration range; r below the method's minimum; fewer than 3 standards, one concentration, flat or falling curve; aliquot larger than its flask; readings of different kinds; a reading of another mode (bracketing, internal standard, curve) given in the wrong mode |
| L2 | % label claim | content (an L1 result or a value) per unit or per mL; label claim; the volume the label is per (e.g. 125 mg per 5 mL) | content ÷ label × 100 % of label claim | — | **S7** a content per mL against a label claim without its volume, or a content per unit against a label per volume; label ≤ 0; IU against mg |
| L3 | Result on a basis | the result as is (%, mg/g, ppm, µg/mg, IU/mg; or an earlier result); basis; the sample's own LOD, water, solvents or loss on ignition | as is × 100 ÷ (100 − LOD / water / solvents / water + solvents / LOI) | basis dried, anhydrous, solvent-free, anhydrous and solvent-free, ignited; result unit | **S3** a test portion dried before the test put on the dried or anhydrous basis; a correction the basis does not use (it would apply a basis twice); the needed LOD/water/solvents missing; corrections outside 0 to < 100 % |
| L4 | Impurities | peaks: area, RRT, name, principal, excluded (with reason), factor, reference; named impurities (RRT window, factor, limit); excluded RRT windows; groups; references (a dilution of the test solution in %, or an impurity / substance standard as in L1) and the test solution (mass and dilution, or concentration) | % per impurity; value = total of the reported impurities; `impurities`, `disregarded`, `excluded`, `groups`, `largestUnknown`, `countCheck`, `allPass` | `mode` **area normalisation** (% of the total corrected area of the peaks not excluded; the principal peak counts in the total) or **external standard** (area ÷ reference area × the reference's % of the test solution). Factors (**S4**): a **correction factor** multiplies the area, a **relative response factor** divides it. Split peaks of one named impurity are summed; unknowns stay separate. Disregard limit, reporting threshold, unknown limit, total limit, "not more than N peaks above x %" | **S4** a factor whose kind is not stated (the wrong direction is the factor squared: 4 × at RRF 0.5); an excluded peak without a reason; overlapping RRT windows; no or two principal peaks in normalisation; a reference not given; a reference that is both a dilution and a standard |
| L9 | Residual solvents | the sample by mass with its dilution (headspace vial or flask); per solvent: name, ICH class, L1 measurement (external standard, bracketing, internal standard or curve), limit | ppm (µg/g) per solvent; value = the sum | limit per solvent (the class limit, in ppm, µg/g or %); limit on the sum (class 3 NMT 5000 ppm) | sample not by mass; a solvent twice; class other than 1-3; specific absorbance; any L1 refusal, named after the solvent |
| L20 | Chromatographic adjustment check (Ph.Int 1.14.1, harmonised with Ph. Eur. 2.2.46 and USP <621>) | the method's and the actual: column length, internal diameter, particle size, particle type, plate number, flow, injection volume, gradient time points, dwell volume (or the step-gradient test t0.5, tG, F) | value = the adjusted flow F2 = F1 × (dc2² × dp1) ÷ (dc1² × dp2); items with status within / outside / conditional; `ldpChange`, `adjustedInjectionVolume` = V1 × (L2 × dc2²) ÷ (L1 × dc1²), `gradientFactor` = (F1 ÷ F2) × (L2 × dc2²) ÷ (L1 × dc1²), `adjustedGradientTimes`, `dwellOffset`; `check` fail if any item is outside, alert if any is conditional | isocratic or gradient. L/dp within −25 % to +50 % (rounded as written); a change to superficially porous particles judged by the plate number (−25 % to +50 %); flow: isocratic a further ± 50 % around F2, gradient none (F2 at the decimals the flow is written); injection volume other than the scaled one: conditional (system suitability); gradient time points scaled, and the table used compared at its decimals; dwell volume: (D1 × column volume ratio − D2) ÷ F2: positive adds an initial isocratic hold, negative delays the injection | gas chromatography (its ranges are C1 checks); superficially porous to totally porous particles; a particle-type change without plate numbers; gradient data on an isocratic method; a gradient table not from 0 or not in order; one dwell volume only; values ≤ 0 or of the wrong kind |

Decisions taken while building:

- **Bracketing:** the standard response is the mean of the mean before and the mean after (each side weighs the same,
  whatever the number of injections).
- **Disregard limit and reporting threshold:** compared after rounding to the decimals they are written with. A peak
  at or below the disregard limit is left out (Ph. Eur. 2.2.46 wording, "at or below"); in normalisation the total is
  then taken again without it. An impurity is reported, and counted in the total and the groups, when it is above the
  reporting threshold.
- **L3 and T9:** L3 is T9's basis correction the other way round (T9 brings an assay on a basis to as is; L3 brings
  an as-is result to the basis), with the same plain refusals. It is used inside L1 (`onBasis`).
- **L20 flow in gradient elution:** the harmonised text allows the ± 50 % further change only for isocratic methods.
  The flow used must equal F2 at the decimals it is written with.
- **L20 dwell volume:** the method's dwell volume is scaled with the column volume before the system's own is taken off
  (with the same column this is the plain (D1 − D2) ÷ F). The pharmacopoeia leaves the formula to the user; this is the
  geometric transfer of the gradient.
- **Out of L20:** temperature, pH, buffer salts, mobile phase composition, wavelength and the GC ranges are C1 checks
  against the method (± amount or ± % around the method's value), as the library says.
- **S1 in L1:** the template cannot tell A(1 %, 1 cm) from the absorptivity by the number alone, so the form is a
  required input; a figure taken in the wrong form gives a result 10 times off, which the limit then fails.

## Inputs the result blocks pass (build step 3)

A block's optional settings left out leave an optional group of inputs with every value left out (`given` in
`core.ts`): such a group (a basis, a VS in excess, an aliquot, a drift, a constant-mass rule, a factor, an acceptance)
counts as not given; its values given without its key (a LOD without the basis) are refused. Additive inputs:

- **L1**: a dilution as one `factor` (a plain number or the dilute step's L21 factor) instead of its steps, never
  both, at least 1; `labelClaim` (per unit): the result is the % of label claim (L2), the mg per unit kept as
  `perUnit`; a standard dried before use may be a recorded "yes"/"no".
- **L4**: the peak table `table` (RRTs and areas as two lists in the same order, the principal peak's area on its
  own) instead of `peaks`; a reference list left empty is none; `limitsCheck` fails when any individual, group or
  count limit fails (so the step shows it, beside the total's `check`).
- **L5**: responses `byTime` (per time point, per vessel set: 6, 6 more, 12 more) instead of `vessels`; the standard
  `prepared` (weighed amount, potency, flask and dilution, as L1) instead of its concentration; the dilution as a
  plain number or the dilute step's factor; `acceptance`: the C6 stage rules applied to the vessels' own results
  (immediate release and delayed-release buffer with Q = the limit's lower bound; acid stage with its upper bound;
  extended release with one range per time point), giving `decision`, `stageReached`, `nextStageUnits` and `check`.
- **L10** specific rotation of a solution: the mass weighed and its `volume` instead of the concentration.

## Lab templates, physical-chemical (`lab-physchem.ts`: L5-L8, L10, L14, L17, L19)

The LIMS library v1 (section 3b). Same rules as every template above: text inputs with units, exact decimals, plain
refusals, rounding only at a limit (C1). Tests: `test/templates/lab-physchem.test.ts`.

| ID | Name | Modes and inputs | Output | Refusals and safety rules |
|---|---|---|---|---|
| L5 | Dissolution | label claim (content per unit); standard response(s) and concentration (as L1 gives it); sample dilution; volume mode **replace and correct** (aliquots added back to the amount), **no replacement** (volume falls by each aliquot), **replace, no correction**; stages: the first with its volume, later ones **add medium** (Method A: 750 + 250 mL, the dissolved drug stays) or **drain** (a new medium, with **add earlier amount** or **this stage only**); responses per vessel per time point; `express` % of label claim, amount per unit (mg) or per area (mg/cm², transdermal); `label` (Tier 1, Tier 2); `reportAt` | per vessel per time point (`vessels`), per time point mean, SD, RSD, min, max (`points`); value = mean at the reported time. **`atTime[k]`** feeds C6 IR/DR (S1-S3, A/B), **`perVessel`** feeds C6 ER (L1-L3): L5 never decides the stage | **S9**: a delivery rate as label claim; added medium without its volume; a drain without the earlier-amount choice. Responses count ≠ time points; aliquot not less than the volume left; time points not rising; standard response ≤ 0 |
| L6 | Titration | direct or back; titrant volume, stated molarity, **factor** (VS item); blank; back without blank: the excess VS with its own factor and a reaction ratio; equivalence E (mg per mL) with the molarity it is written for and which VS; aliquot; titre temperature correction V × [1 + 0.001 (t1 − t2)]; sample by mass or volume; average unit weight; basis | % (or mg/g, g/g), mg, mg per unit, mg/mL. Content = n ÷ M(eq) × E, n in mmol: direct (V − Vb) × M; back with blank (Vb − V) × M (the excess VS cancels: only the titrant factor counts); back without blank Vex × Mex − V × M × r | **S5**: a VS of another molarity than the equivalence is followed automatically; a back titration without blank needs the excess VS's own factor; a factor outside 0.8-1.2 (molarity typed as factor). Blank above titre (direct) or below (back); **S3** basis on a sample already dried |
| L7 | Water by Karl Fischer | volumetric (V − blank) × F − drift × time; **volumetric back** (method B) V(reagent) × F − V(water-methanol) × its water; coulometric µg − blank − drift × time; sample mass | % (or mg/g, g/g, ppm); `waterMg` | a negative result (blank, drift or back-titre too large); F not in mg/mL; drift not a mass rate |
| L8 | Mass loss / residue | LOD, loss on ignition, residue on ignition, sulfated ash, residue (unsaponifiable matter), container weight loss (stability); tare, before, after (one or successive weighings); constant mass by the F2 helper (`noFurtherChange`), option "or the result complies" (Ph.Int 2.3); basis | % (or mg/g, g/g, ppm); `sampleMass`; `constantMass` check | no tare; no sample; mass gained; residue below the tare or above the sample; not yet at constant mass ("heat again"); **S3** |
| L10 | Readings with a fixed rule | **specific rotation**: solution 100α ÷ (l × c), neat liquid α ÷ (l × d), solution by mass 100α ÷ (l × p × d), basis; **content from rotation** α × written factor; **relative density** and **weight per mL** (pycnometer, × water density from the table item); **ethanol content** from the density at 20 °C (OIML R 22, as T26); **pH** with temperature; **conductivity** stages 1-3 (USP <645>); **TOC** with system suitability (USP <643>); **melting point** with thermometer and emergent-stem 0.00015 × N × (T − t) corrections | [α] in °, a density, % v/v or % w/w, pH, µS/cm (with `decision` pass / next stage / fail), ppb, °C | **S12**: path length without unit, or outside 0.1-5 dm (mm typed as dm = 100 ×). **S11**: a temperature-compensated reading at stage 1. pH calibration more than 2 °C away; stage 2 outside 25 ± 1 °C; TOC response efficiency outside 85-115 % (system not suitable); water density outside 0.95-1.000 g/mL |
| L14 | Statistics | **summary** (T7 statistics + confidence interval of the mean, two-sided or a one-sided bound; CI of the SD by χ²; prediction interval; tolerance interval by Howe's k; bias against a true value with its CI; RSD limit); **two means** (pooled or Welch); **F test** (two-sided larger ÷ smaller, or one-sided); confidence level in % | the mean, the difference or F; `ci`, `sdCi`, `predictionInterval`, `toleranceInterval`, `k`, `t`, `df`, `critical`, `significant` | fewer than two results; confidence not between 50 and 100; a series with no spread |
| L17 | Standardisation | **VS factor** f = m × purity ÷ (E × (V − blank)), mean, RSD limit, molarity = stated × f; **KF water equivalent** F = m × water % ÷ V; **working standard** potency = (R ÷ c)(ws) ÷ (R ÷ c)(primary) × primary potency, c = mass ÷ volume, per preparation, mean; basis | factor, mg/mL or %; `replicates`, `rsd`, `rsdCheck`, `molarity` | a replicate factor outside 0.8-1.2; purity, water or potency not in (0, 100] %; dilution volume given for some preparations only; RSD with one replicate |
| L19 | Sampling plan size | **square root**: 1 + √N rounded up (WHO "n plan"), not more than N; **every container**; tested each, as one composite or composites of n; **sterility containers** by product type and batch size (Ph.Int 3.2 / Ph. Eur. 2.6.1 / USP <71> Table 3), doubled when one container cannot inoculate both media; **sterility quantity** per container per medium (Table 2); **extractable volume** containers by nominal volume (Ph.Int 5.6) | number of containers (`tests` = tests to run), or the quantity per medium | N not a whole number ≥ 1; the both-media answer missing; a cream container below 200 mg |

Units added for these templates (one line each in `units.ts`): µg/mL, g/g (= 100 %), ppb, dm, µg/min (KF drift), µg/cm²,
µS/cm and mS/cm (conductivity, a kind of its own), mol/L and mmol/L (VS molarity; aliases M, mM), % v/v (a volume
fraction, never a mass fraction); aliases g/100 mL (= % w/v) and g/100 g (= % w/w).

### Pharmacopoeia rules and tables in these templates (paraphrased; no chapter text copied)

- **L5:** amount = C × V(now) + Σ C(earlier) × aliquot(earlier) (+ the amount from drained media when cumulative).
  All aliquots count, whichever analyte they were taken for (two actives from one vessel set, safety rule S9).
  The stage decision is C6's. Tier 1 and Tier 2 are separate runs (owner, 18 Nov 2026: a Tier 1 failure that the
  method sends to Tier 2 opens no OOS; the workflow records it).
- **L6:** the volume correction for temperature follows Ph.Int 2.6 (coefficient 0.001 per °C by default; the master
  may set another, e.g. 0.0011 for perchloric acid in glacial acetic acid as in USP).
- **L10 conductivity:** stage 1 table of USP <645> (also Ph. Eur. water for injections), 0-100 °C in 5 °C steps, the
  next lower temperature used; stage 2 NMT 2.1 µS/cm at 25 ± 1 °C; stage 3 the pH 5.0-7.0 table (pH rounded to 0.1).
  The Ph. Eur. purified-water table (with interpolation) is not included.
- **L10 TOC:** limit response r(s) − r(w); response efficiency (r(ss) − r(w)) ÷ (r(s) − r(w)) × 100, 85-115 %.
- **L14 critical values** are computed, not typed: Student t, F and χ² from the regularized incomplete beta and gamma
  functions (Abramowitz and Stegun 26.5.8, 6.5.29 and 6.5.31; continued fractions as in Numerical Recipes), ln Γ by
  Stirling's series, quantiles by bisection, at 30 significant digits. The tests check them against the usual published
  tables to their printed decimals (t to 3, F to 3, χ² to 3). Howe's k for the tolerance interval is an approximation
  (n = 10, 95/95: 3.382 against the exact 3.379).
- **L19:** sterility Table 3: parenteral and devices ≤ 100: 10 % or 4 (greater); 101-500: 10; > 500: 2 % or 20 (less);
  large-volume parenterals 2 % or 10 (less); antibiotic bulk packages < 5 g: 20, ≥ 5 g: 6; ophthalmic and other
  non-injectable ≤ 200: 5 % or 2 (greater), > 200: 10; bulk solids ≤ 4: each, 5-50: 20 % or 4 (greater), > 50: 2 % or 10
  (greater). Percentages rounded up to whole containers; never more than the batch. Table 2: liquids < 1 mL whole,
  1-40 mL half (NLT 1 mL), 40-100 mL 20 mL, > 100 mL 10 % (NLT 20 mL), antibiotic liquids 1 mL; solids < 50 mg whole,
  50-300 mg half (NLT 50 mg), 300 mg-5 g 150 mg, > 5 g 500 mg; insoluble preparations, creams, ointments 200 mg.
