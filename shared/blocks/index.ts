/** The block library: each block is a description file; a new block (or a new version of one) is a new file here. */
import type { Block } from './format.js';
import { assay } from './assay.js';
import { assayAbsorbance } from './assay-absorbance.js';
import { check } from './check.js';
import { complies } from './complies.js';
import { contentUniformity } from './content-uniformity.js';
import { blendUniformity } from './blend-uniformity.js';
import { densityFlow } from './density-flow.js';
import { dilute } from './dilute.js';
import { disintegration } from './disintegration.js';
import { dissolution } from './dissolution.js';
import { dryConstant } from './dry-constant.js';
import { friability } from './friability.js';
import { impurities } from './impurities.js';
import { instrumentRun } from './instrument-run.js';
import { lineClearance } from './line-clearance.js';
import { lossOnDrying } from './loss-on-drying.js';
import { mix } from './mix.js';
import { opticalRotation } from './optical-rotation.js';
import { periodicCheck } from './periodic-check.js';
import { ph } from './ph.js';
import { relativeDensity } from './relative-density.js';
import { sieveAnalysis } from './sieve-analysis.js';
import { systemSuitability } from './system-suitability.js';
import { titration } from './titration.js';
import { uniformityByWeight } from './uniformity-by-weight.js';
import { waterKf } from './water-kf.js';
import { weigh } from './weigh.js';
import { incubate } from './incubate.js';
import { count } from './count.js';
import { sterilityTest } from './sterility-test.js';
import { bioburden } from './bioburden.js';
import { endotoxin } from './endotoxin.js';
import { microbialAssay } from './microbial-assay.js';
import { VALIDATION_BLOCKS } from './validation.js';

export type { Block, BlockField, BlockSetting } from './format.js';
// In the order of an analysis: clearance, weighing and preparing solutions, the instrument run and its suitability,
// then the tests and their results; last the result blocks of the chemistry lab, each ending in its reportable `result`.
export const BLOCKS: readonly Block[] = [
  lineClearance, weigh, mix, dilute, instrumentRun, systemSuitability, check, periodicCheck, dryConstant, disintegration, friability,
  uniformityByWeight, contentUniformity, blendUniformity, densityFlow, sieveAnalysis,
  assay, assayAbsorbance, impurities, dissolution, titration, waterKf, lossOnDrying, opticalRotation, ph, relativeDensity, complies,
  // The microbiology lab (build step 7): incubation and the counts, and the result blocks of the micro lab.
  incubate, count, sterilityTest, bioburden, endotoxin, microbialAssay,
  // Method validation (build step 8): specificity, linearity, accuracy, precision, DL/QL, robustness, transfer comparison.
  ...VALIDATION_BLOCKS,
];
export function findBlock(ref: { id: string; version: number }): Block | undefined {
  return BLOCKS.find((b) => b.id === ref.id && b.version === ref.version);
}
