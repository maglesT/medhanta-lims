import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { SignDialog } from '../components/SignDialog.js';
import { getVersion, type Version } from '../api-designer.js';
import { analysisLink, go, plainError } from '../api-floor.js';

// LIMS-01: start an analysis from the effective method version, signed "issued"; for a sample, it covers the sample's
// specification tests done by that method.
export function IssueDialog({ row, sampleId, sampleNo, onCancel }: { row: { id: number; versionNo: number; header: { code: string; name: string } }; sampleId?: number; sampleNo?: string; onCancel: () => void }) {
  const [v, setV] = useState<Version | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [signing, setSigning] = useState(false);
  useEffect(() => { getVersion(row.id).then(setV, (e) => setProblems([plainError(e)])); }, [row.id]);
  const doc = v?.doc;
  if (!doc) return null;
  const issue = async ({ proof }: { proof: string }) => {
    try {
      const b = await api<{ id: number }>('POST', '/api/analyses', { masterVersionId: row.id, proof, ...(sampleId ? { sampleId } : {}) });
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
        <p>{doc.header.code} · {doc.header.name}, version {row.versionNo}{sampleNo ? `, for sample ${sampleNo}` : ''}. The analysis number is given by the server.</p>
        {problems.length > 0 && <div className="notice bad" role="alert">{problems.map((p, i) => <p key={i}>{p}</p>)}</div>}
        <div className="actions">
          <button type="button" className="big" onClick={onCancel}>Cancel</button>
          <button className="big primary" type="submit">Next: sign</button>
        </div>
      </form>
    </div>
    {signing && <SignDialog meaning="issued" what={`A new analysis by ${doc.header.code} ${doc.header.name}, method version ${row.versionNo}${sampleNo ? `, of sample ${sampleNo}` : ''}.`} onCancel={() => setSigning(false)} onSign={issue} />}
  </>);
}
