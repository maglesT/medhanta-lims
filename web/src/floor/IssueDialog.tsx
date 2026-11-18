import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import { getVersion, type Version } from '../api-designer.js';
import { analysisLink, go, plainError } from '../api-floor.js';

// LIMS-01: start an analysis from the effective method version, signed "issued"; for a sample, it covers the sample's
// specification tests done by that method.
// oos: a retest of an OOS whose result QA invalidated (LIMS-24): the new analysis is linked to it.
// container: LIMS-08, the container of a starting material whose identity this analysis tests.
export function IssueDialog({ row, sampleId, sampleNo, oos, container, onCancel }: { row: { id: number; versionNo: number; header: { code: string; name: string } }; sampleId?: number; sampleNo?: string; oos?: { id: number; oosNo: string }; container?: number; onCancel: () => void }) {
  const [v, setV] = useState<Version | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [signing, setSigning] = useState(false);
  useEffect(() => { getVersion(row.id).then(setV, (e) => setProblems([plainError(e)])); }, [row.id]);
  const doc = v?.doc;
  if (!doc) return null;
  const issue = async ({ proof }: { proof: string }) => {
    try {
      const b = await api<{ id: number }>('POST', '/api/analyses', { masterVersionId: row.id, proof, ...(sampleId ? { sampleId } : {}), ...(oos ? { oosId: oos.id } : {}), ...(container ? { container } : {}) });
      go(analysisLink(b.id));
    } catch (e) {
      if (!(e instanceof ApiError && e.problems.length)) throw e;
      setSigning(false);
      setProblems(e.problems);
    }
  };
  return (<>
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Start an analysis">
      <form className="card dialog fl" onSubmit={(e) => { e.preventDefault(); setSigning(true); }}>
        <h2>Start an analysis</h2>
        <p>{doc.header.code} · {doc.header.name}, version {row.versionNo}{sampleNo ? `, for sample ${sampleNo}` : ''}{container ? `, identity of container ${container}` : ''}{oos ? `, as a retest of ${oos.oosNo}` : ''}. The analysis number is given by the server.</p>
        {problems.length > 0 && <div className="notice bad" role="alert">{problems.map((p, i) => <p key={i}>{p}</p>)}</div>}
        <div className="actions">
          <button type="button" className="big" onClick={onCancel}>Cancel</button>
          <button className="big primary" type="submit">Next: sign</button>
        </div>
      </form>
    </div>
    {signing && <SignDialog meaning="issued" what={`A new analysis by ${doc.header.code} ${doc.header.name}, method version ${row.versionNo}${sampleNo ? `, of sample ${sampleNo}` : ''}${oos ? `, retest of ${oos.oosNo}` : ''}.`} onCancel={() => setSigning(false)} onSign={issue} />}
  </>);
}
