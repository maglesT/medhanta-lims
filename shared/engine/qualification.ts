/**
 * LIMS-12: an instrument is used only while the Qualification product says it is qualified and its periodic review is
 * not past (report.qualification_v1, read live through the 'qual' link, PL-08). Pure: the server's pull
 * (server/pull.ts) and the step's picker (web/src/floor/StepScreen.tsx) both ask these.
 */
import { plantDate } from '../plant-time.js';

/** One row of qualification_v1 as the link reads it. */
export interface QualRead {
  masterId: string; code: string; name: string; status: string; nextReviewDue: string | null; dataAsOf: string | null;
  // The conditions of a conditional qualification, when Qualification publishes them (read null-safely).
  conditions: string | null;
}
// Usable statuses: qualified, and qualified with conditions (the conditions are shown with the value).
export const QUAL_USABLE = ['qualified', 'qualified_conditions'];
const QUAL_WORDS: Record<string, string> = {
  qualified: 'qualified', qualified_conditions: 'qualified with conditions', requalification_needed: 'due for requalification',
  not_qualified: 'not qualified', in_qualification: 'still being qualified',
};
/** A Qualification status in plain words, never its key. */
export const qualWords = (status: string) => QUAL_WORDS[status] ?? status.replace(/_/g, ' ');

/** Why the instrument may not be used now (null: it may); `row` null: Qualification has no row for it. `today`: plant date. */
export function qualificationProblem(code: string, row: QualRead | null, today: string): string | null {
  if (!row) return `${code} is not in Qualification, so it cannot be used.`;
  if (!QUAL_USABLE.includes(row.status)) return `${code} is ${qualWords(row.status)} (Qualification): only a qualified instrument may be used.`;
  if (row.nextReviewDue && row.nextReviewDue < today) return `${code}: its periodic review was due on ${plantDate(row.nextReviewDue)} (Qualification): it may not be used until it is reviewed.`;
  return null;
}

/** What a usable instrument's qualification shows with the value (kept with the record, PL-07). */
export function qualificationShown(row: QualRead): string {
  const due = row.nextReviewDue ? `, periodic review due ${row.nextReviewDue}` : '';
  const cond = row.status === 'qualified_conditions' ? `; conditions: ${row.conditions?.trim() || 'see Qualification before use'}` : '';
  return `${row.code}: ${qualWords(row.status)}${due}${cond}`;
}

/** An instrument's qualification as the picker needs it: its master-data id and why not (null: usable). */
export interface QualPick { id: string; problem: string | null }

/**
 * The picker (LIMS-12): while Qualification is linked (`read` not null) only qualified instruments are offered; each one
 * left out is named with why. Absent or down: every one is offered and its qualification is answered by hand.
 */
export function inQualification<T extends { itemId: string; code: string }>(items: readonly T[], read: readonly QualPick[] | null): { offered: T[]; leftOut: string[] } {
  if (!read) return { offered: [...items], leftOut: [] };
  const by = new Map(read.map((r) => [r.id, r]));
  const offered: T[] = [];
  const leftOut: string[] = [];
  for (const i of items) {
    const r = by.get(i.itemId);
    const why = r ? r.problem : `${i.code} is not in Qualification, so it cannot be used.`;
    if (why) leftOut.push(`Not offered: ${why}`); else offered.push(i);
  }
  return { offered, leftOut };
}
