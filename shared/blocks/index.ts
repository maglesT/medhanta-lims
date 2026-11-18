/** The block library: each block is a description file; a new block (or a new version of one) is a new file here. */
import type { Block } from './format.js';
import { check } from './check.js';
import { contentUniformity } from './content-uniformity.js';
import { densityFlow } from './density-flow.js';
import { dilute } from './dilute.js';
import { disintegration } from './disintegration.js';
import { dryConstant } from './dry-constant.js';
import { friability } from './friability.js';
import { instrumentRun } from './instrument-run.js';
import { lineClearance } from './line-clearance.js';
import { mix } from './mix.js';
import { periodicCheck } from './periodic-check.js';
import { sieveAnalysis } from './sieve-analysis.js';
import { systemSuitability } from './system-suitability.js';
import { uniformityByWeight } from './uniformity-by-weight.js';
import { weigh } from './weigh.js';

export type { Block, BlockField, BlockSetting } from './format.js';
// In the order of an analysis: clearance, weighing and preparing solutions, the instrument run and its suitability,
// then the tests and their results.
export const BLOCKS: readonly Block[] = [
  lineClearance, weigh, mix, dilute, instrumentRun, systemSuitability, check, periodicCheck, dryConstant, disintegration, friability,
  uniformityByWeight, contentUniformity, densityFlow, sieveAnalysis,
];
export function findBlock(ref: { id: string; version: number }): Block | undefined {
  return BLOCKS.find((b) => b.id === ref.id && b.version === ref.version);
}
