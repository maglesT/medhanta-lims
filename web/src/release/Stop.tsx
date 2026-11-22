import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import { plainError, statusText, type AnalysisDetail } from '../api-floor.js';
import { ReasonDialog } from '../floor/ReasonDialog.js';
import { stoppedText } from '../../../shared/engine/release.js';

// The reviewer stops an analysis that cannot be finished (a broken instrument, a spilled sample): a reason, then a
// signature meaning "stopped". The record is kept (LIMS-48: aborted tests are kept); no more actions. The analysis is
// read when the window opens, and the signature covers it as read then. Its windows open over the whole page (a portal).
export function Stop({ id, analysisNo, onDone }: { id: number; analysisNo: string; onDone: () => Promise<void> | void }) {
  const [step, setStep] = useState<'reason' | 'sign' | null>(null);
  const [reason, setReason] = useState('');
  const [d, setD] = useState<AnalysisDetail | null>(null);
  const [error, setError] = useState('');
  const close = () => { setStep(null); setD(null); };
  const open = async () => {
    setError('');
    try { setD(await api<AnalysisDetail>('GET', `/api/analyses/${id}`)); setStep('reason'); } catch (e) { setError(plainError(e)); }
  };
  return (<>
    <button type="button" className="big soft-bad" onClick={() => void open()}>Stop the analysis</button>
    {error && <p className="notice bad" role="alert">{error}</p>}
    {step && d && createPortal(<>{step === 'reason' && (
      <ReasonDialog title={`Stop analysis ${analysisNo}`} label="Reason for stopping" submit="Stop the analysis (sign)" onCancel={close} wide
        hint="The analysis stops here. Its record is kept; no step can be recorded any more. A new analysis of the sample may be started."
        onSubmit={async (why) => { setReason(why); setStep('sign'); }} />
    )}
    {step === 'sign' && (
      <SignDialog meaning="stopped" what={`Stop analysis ${analysisNo} · ${d.master.doc.header.name} (status now: ${statusText(d.analysis.status)})`} onCancel={close}
        onSign={async ({ proof }) => { await api('POST', `/api/analyses/${id}/stop`, { proof, contentHash: d.analysis.contentHash, reason }); close(); await onDone(); }}>
        <div className="summary-box"><p>Reason: <b>{reason}</b></p></div>
      </SignDialog>
    )}</>, document.body)}
  </>);
}

export { stoppedText };
