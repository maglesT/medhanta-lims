/**
 * LIMS-09: a lot tested on its supplier's certificate (reduced testing; US 211.84(d)(2), EU C5 5.35-5.36, IN Schedule M
 * 19.7.4). QC records it on a release sample when all of these hold, worked out here from pulled facts only:
 * - the specification allows it (its header names the full-test interval: every n-th lot and at least every m months);
 * - MMS names the lot's manufacturer and supplier (lot_v1);
 * - QMS approves that material, manufacturer and supplier (supplier_approval_v1): approved, not past its date, and
 *   approved for reduced testing;
 * - the periodic full test is not due: a lot of this manufacturer was tested in full and approved, fewer than n − 1
 *   lots were tested on the certificate since, and it is less than m months old;
 * - no OOS of a lot of this material and manufacturer is open, and none was confirmed since QA approved reduced testing
 *   in QMS (a full-test mismatch stops reduced testing until the investigation closes and QA approves it again).
 * Then the tests other than identity may be taken from the certificate (an outside result with `certificate`, the
 * manufacturer as the lab, checked against the scan by a second person); identity is always tested here.
 */
import type { SpecDoc } from '../master/spec.js';

export interface SupplierApproval {
  recordNumber: string | null; status: string; approvedUntil: string | null; isBroker: boolean;
  reducedTestingApproved: boolean; reducedTestingApprovedAt: string | null;
}
export interface LotSupplier { supplierId: string | null; manufacturerId: string | null; manufacturerBatchNo: string | null }
/** An approved release sample of a lot of the same material and manufacturer; `reduced`: tested on the certificate. */
export interface PastLot { sampleNo: string; approvedOn: string; reduced: boolean }
/** An OOS of a release sample of a lot of the same material and manufacturer. */
export interface PastOos { oosNo: string; status: 'open' | 'confirmed' | 'invalidated'; openedOn: string }

export interface ReducedFacts {
  spec: SpecDoc; purpose: string; decided: string | null; recorded: boolean;
  lot: LotSupplier | null; approval: SupplierApproval | null;
  past: readonly PastLot[]; oos: readonly PastOos[]; today: string;
  manufacturer?: string;
  // QMS could not be read now (absent or down).
  approvalUnread?: boolean;
}

const monthsBetween = (from: string, to: string) => {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
};

/** Why this lot must be tested in full by the periodic check; null when the full test is not due. `past`: newest first. */
export function fullTestDue(rt: { fullEvery: number; months: number }, past: readonly PastLot[], today: string, manufacturer = 'this manufacturer'): string | null {
  const last = past.findIndex((p) => !p.reduced);
  const every = `full testing every ${rt.fullEvery} lots and at least every ${rt.months} months`;
  if (last < 0) return `No lot of ${manufacturer} has been tested in full and approved yet: this lot is tested in full (${every}).`;
  const full = past[last]!;
  if (last >= rt.fullEvery - 1) return `${last} lots of ${manufacturer} were tested on the certificate since ${full.sampleNo}: this lot is tested in full (${every}).`;
  if (monthsBetween(full.approvedOn, today) >= rt.months) return `The last full test of ${manufacturer} (${full.sampleNo}, ${full.approvedOn}) is ${rt.months} months old or more: this lot is tested in full (${every}).`;
  return null;
}

/** Why QC may not test this sample's lot on the supplier's certificate now (plain words, all at once); empty when it may. */
export function reducedTestingProblems(f: ReducedFacts): string[] {
  if (f.decided) return [`The sample is already ${f.decided}.`];
  if (f.recorded) return ['This lot is already tested on the supplier\'s certificate.'];
  const rt = f.spec.header.reducedTesting;
  if (f.purpose !== 'release') return ['Only a release sample of a lot is tested on the supplier\'s certificate.'];
  if (!rt) return [`Specification ${f.spec.header.number} does not allow reduced testing: every test is done here.`];
  if (!f.lot) return ['MMS cannot be read now: the lot\'s manufacturer and supplier are not known, so the lot is tested in full.'];
  if (!f.lot.manufacturerId || !f.lot.supplierId) return ['MMS does not name the lot\'s manufacturer and supplier: the lot is tested in full.'];
  const out: string[] = [];
  const a = f.approval;
  const who = f.manufacturer ?? 'the manufacturer';
  if (!a && f.approvalUnread) out.push('QMS cannot be read now: the supplier approval is not known, so the lot is tested in full.');
  else if (!a) out.push(`QMS has no supplier approval of ${f.spec.header.code} from ${who} through this supplier.`);
  else {
    const rec = a.recordNumber ? ` (${a.recordNumber})` : '';
    if (a.status !== 'approved') out.push(`The supplier approval${rec} is ${a.status.replaceAll('_', ' ')} in QMS, not approved.`);
    if (a.approvedUntil && a.approvedUntil < f.today) out.push(`The supplier approval${rec} ran out on ${a.approvedUntil}.`);
    if (!a.reducedTestingApproved) out.push(`QA has not approved reduced testing for this supplier in QMS${rec}.`);
    for (const o of f.oos.filter((x) => x.status === 'confirmed' && (!a.reducedTestingApprovedAt || x.openedOn >= a.reducedTestingApprovedAt))) {
      out.push(`${o.oosNo} on a lot of ${who} was confirmed after reduced testing was approved: QA approves reduced testing again in QMS first.`);
    }
  }
  for (const o of f.oos.filter((x) => x.status === 'open')) out.push(`${o.oosNo} on a lot of ${who} is open: lots are tested in full until it is closed.`);
  const due = fullTestDue(rt, f.past, f.today, who);
  if (due) out.push(due);
  return out;
}

/** LIMS-09: what the second person confirms on the certificate's scan before its results count (IN Schedule M 19.7.4). */
export const CERTIFICATE_FIELDS = 'the manufacturer\'s name and address, the batch number, the manufacturing and expiry or retest dates, each result against the specification, and the signature of the manufacturer\'s quality unit';
