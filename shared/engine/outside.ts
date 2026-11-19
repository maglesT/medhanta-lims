/**
 * LIMS-22: a test done by an outside (contract) lab, stated in the QC record. Its result is typed from the lab's report
 * (the report's file is named with its SHA-256; the report stays the contract lab's record), checked against the
 * specification's limit by the same rounding as the lab's own results (C1), and counts for QC's decision only once a
 * second person has checked it against the report. The certificate and result_v1 name the outside lab.
 */
import { c1WithinLimits } from '../templates/index.js';
import { limitFor, purposeLimits, type SpecTest } from '../master/spec.js';
import { CERTIFICATE_FIELDS } from './reduced.js';

export interface OutsideEntry { value?: string; unit?: string; conforms?: boolean }
export interface OutsideFigure { shown: string; value: string; unit: string; pass?: boolean }

/** The result as the decision sees it, worked out from what was typed; or why it cannot be taken. */
export function outsideFigure(t: SpecTest, purpose: string, e: OutsideEntry): OutsideFigure | { problem: string } {
  if (t.limitType === 'conforms') {
    if (e.conforms === undefined || e.value !== undefined) return { problem: `${t.name}: say whether the report finds it conforms (${t.conforms ?? ''}); a conforms test has no number.` };
    return { shown: `${e.conforms ? 'Conforms' : 'DOES NOT CONFORM'}: ${t.conforms ?? ''}`.trim(), value: '', unit: '', pass: e.conforms };
  }
  if (e.value === undefined || e.conforms !== undefined) return { problem: `${t.name}: type the result as the report gives it, with its unit.` };
  const unit = e.unit ?? '';
  const limit = limitFor(t, purposeLimits(purpose));
  if (t.limitType === 'report only' || !limit) return { shown: `${e.value} ${unit}`.trim(), value: e.value, unit };
  const r = c1WithinLimits({ value: { value: e.value, unit }, limit });
  if (!r.ok) return { problem: `${t.name}: ${r.message}` };
  return { shown: r.shown, value: e.value, unit, ...(r.check ? { pass: r.check.pass } : {}) };
}

/**
 * Why this outside result cannot be entered for this test of the sample now; null when it may. Not after QC's decision;
 * only a test of the specification that applies to the sample; never an identity test done container by container
 * (LIMS-08: the lab identifies each container itself).
 */
export function outsideEntryRefusal(t: SpecTest | undefined, applies: boolean, perContainer: boolean, decided: string | null, certificate?: { reduced: boolean }): string | null {
  if (decided) return `The sample is already ${decided}.`;
  if (!t || !applies) return 'That test is not one of this sample\'s specification tests.';
  if (perContainer && t.identity) return `${t.name} is done on each container of the starting material, in this lab.`;
  // LIMS-09: a result from the supplier's certificate only for a lot QC recorded as tested on it; identity never.
  if (certificate && !certificate.reduced) return 'This lot is not tested on the supplier\'s certificate: QC records reduced testing on the sample first.';
  if (certificate && t.identity) return `${t.name} is an identity test: it is always done in this lab, never taken from the certificate.`;
  return null;
}

/** Why this person may not check the outside result now; null when they may (a second person, once). */
export function outsideCheckRefusal(o: { enteredBy: number; checked: boolean; certificate?: boolean }, person: number, decided: string | null, certificateFields?: boolean): string | null {
  if (decided) return `The sample is already ${decided}.`;
  if (o.checked) return 'A second person has already checked this result.';
  if (o.enteredBy === person) return 'The person who typed the result cannot check it: a second person checks it against the report.';
  // LIMS-09: the checker confirms the certificate holds the required fields (IN Schedule M 19.7.4).
  if (o.certificate && !certificateFields) return `Confirm the certificate gives ${CERTIFICATE_FIELDS}.`;
  return null;
}
