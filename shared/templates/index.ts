/** TrueBatch Tablets calculation and check templates, version 2 (with the packing templates T27, C8 and C9). */
export { Dec, type Q, type Outcome, type Done, type Refusal, type ResultValue } from './core.js';
export { checkLimit, roundHalfUp, writtenDecimals, type Check, type Limit, type Level } from './rounding.js';
export { convert, findUnit, UNIT_LIST, type Kind, type Unit } from './units.js';
export { t1Difference, t2Total, t3PercentOfTarget, t4Accountability, t5PercentChange, t6Ratio, t21LesserGreater } from './basic.js';
export { t7Statistics, c1WithinLimits, c2Count, c3AllIndividual, c4Observation, noFurtherChange } from './series.js';
export { t26MixToTarget, ethanolWw, ethanolDensity } from './mixing.js';
export {
  t8AnalysisScaling, t9PotencyAdjusted, c5SameBasis, t10Compensating, t11SaltFactor, t12DryBasis,
  t15Rescale, t16Overage, t18ContentAdjusted, t19Split, t20MultiLot,
} from './dispensing.js';
export { t13Duration, f8DiversionWindow, f8LotsInWindow } from './time.js';
export { t14ContentUniformity, t14Stratified } from './uniformity.js';
export { t17LiquidMakeUp } from './liquid.js';
export { t22SieveAnalysis, t22MixPsd, t23CompactStrength, t24SpecificEnergy, t25AbsoluteHumidity } from './physical.js';
export { c6StagedTest } from './staged.js';
export { c7SamplingPlan, codeLetter, plan } from './sampling.js';
export { t27Expiry, c8PrintedData, c9SerialCodes, expiryMonth, printedMonth, gs1 } from './packing.js';
export { l1Assay, l2LabelClaim, l3OnBasis, l4Impurities, l9ResidualSolvents, l20ChromAdjustment } from './lab-assay.js';
export {
  l5Dissolution, l6Titration, l7WaterKf, l8MassLoss, l10Reading, l14Statistics, l17Standardisation, l19SamplingPlan,
  tQuantile, fQuantile, chi2Quantile,
} from './lab-physchem.js';
export { l21DilutionFactor, type L21Input } from './lab-dilution.js';
export {
  l15ShelfLife, l22PredictionInterval, l23Mkt, l24Arrhenius, l25DesignCheck, monthsOf, fUpperP,
  type L15Input, type L15Extrapolation, type L22Input, type L23Input, type L24Input, type L25Input, type StabilityBatch, type StabilityPoint,
} from './lab-stability.js';
