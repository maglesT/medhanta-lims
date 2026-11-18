/**
 * LIMS-54: the paper fallback. A blank worksheet for one sample and method is issued with its own number (LF26xxxxx,
 * printed on every page) and a reason (the system or a link down, a bench without a terminal). Each comes back once:
 * used (its record transcribed into an analysis of the same sample by the same method, whose number is given), unused,
 * or voided with its reason (spoiled, lost). The forms not back yet are the reconciliation list. The state is computed
 * here from the one entry a form takes, never stored.
 */
export type FormState = 'issued' | 'used' | 'unused' | 'voided';
export const FORM_OUTCOMES = ['used', 'unused'] as const;
export interface FormEntry { kind: 'returned' | 'voided'; payload: { outcome?: (typeof FORM_OUTCOMES)[number]; analysisNo?: string; reason?: string } }

export function formState(e: FormEntry | null | undefined): FormState {
  if (!e) return 'issued';
  return e.kind === 'voided' ? 'voided' : e.payload.outcome === 'used' ? 'used' : 'unused';
}
export const FORM_STATE_WORDS: Record<FormState, string> = {
  issued: 'issued, not back yet', used: 'returned, transcribed', unused: 'returned unused', voided: 'voided',
};

/**
 * Why the form cannot be returned or voided now; null when it may. A used form names the analysis it was transcribed
 * into: one of the form's sample, by the form's method (`analyses`: that sample's analyses with their method).
 */
export function formRefusal(action: 'return' | 'void', e: FormEntry | null | undefined, input: FormEntry['payload'],
  form: { methodMasterId: number; methodCode: string }, analyses: readonly { analysisNo: string; methodMasterId: number }[]): string | null {
  if (e) return `The form is already ${FORM_STATE_WORDS[formState(e)]}.`;
  if (action === 'void') return input.reason?.trim() ? null : 'Give the reason the form is voided (spoiled, lost …).';
  if (input.outcome !== 'used') return null;
  const a = analyses.find((x) => x.analysisNo === input.analysisNo?.trim());
  if (!a) return 'Give the number of the analysis of this sample the form was transcribed into.';
  if (a.methodMasterId !== form.methodMasterId) return `Analysis ${a.analysisNo} is not by method ${form.methodCode}, the form's method.`;
  return null;
}
