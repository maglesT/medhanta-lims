// The individuals chart and its moving range chart (template L18), drawn as plain SVG: the results in decision order,
// the centre line, the 1, 2 and 3 sigma lines, the specification limits; the points of a Nelson rule break in red.
import type { Chart } from './api-trends.js';

const W = 900;
const PAD = { l: 84, r: 16, t: 14, b: 26 };
const n = (s: string | null | undefined) => (s == null ? null : Number(s));

function scale(lo: number, hi: number, h: number) {
  const span = hi - lo || Math.abs(hi) || 1;
  const a = lo - span * 0.08;
  const b = hi + span * 0.08;
  return (v: number) => PAD.t + (h - PAD.t - PAD.b) * (1 - (v - a) / (b - a));
}
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3));

export function ControlChart({ c, values, labels }: { c: NonNullable<Chart['chart']>; values: number[]; labels: string[] }) {
  const H = 300;
  const flagged = new Set(c.breaks.flatMap((b) => b.points));
  const lines: { y: number; label: string; cls: string }[] = [
    { y: n(c.mean)!, label: 'CL', cls: 'cc-centre' },
    { y: n(c.ucl)!, label: 'UCL', cls: 'cc-limit' }, { y: n(c.lcl)!, label: 'LCL', cls: 'cc-limit' },
    { y: n(c.zones.plus2)!, label: '+2σ', cls: 'cc-zone' }, { y: n(c.zones.minus2)!, label: '−2σ', cls: 'cc-zone' },
    { y: n(c.zones.plus1)!, label: '+1σ', cls: 'cc-zone' }, { y: n(c.zones.minus1)!, label: '−1σ', cls: 'cc-zone' },
    ...(c.specHigh ? [{ y: n(c.specHigh)!, label: 'USL', cls: 'cc-spec' }] : []), ...(c.specLow ? [{ y: n(c.specLow)!, label: 'LSL', cls: 'cc-spec' }] : []),
  ];
  const all = [...values, ...lines.map((l) => l.y)];
  const y = scale(Math.min(...all), Math.max(...all), H);
  const x = (i: number) => PAD.l + (values.length === 1 ? 0 : (i * (W - PAD.l - PAD.r)) / (values.length - 1));
  const mr = c.movingRanges.map((m) => Number(m));
  const MH = 140;
  const my = scale(0, Math.max(...mr, Number(c.mrUcl)), MH);
  return (
    <figure className="cc">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Individuals control chart">
        {lines.map((l) => (
          <g key={l.label} className={l.cls}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(l.y)} y2={y(l.y)} />
            <text x={PAD.l - 6} y={y(l.y) + 4} textAnchor="end">{l.label} {fmt(l.y)}</text>
          </g>
        ))}
        <polyline className="cc-path" points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
        {values.map((v, i) => (
          <circle key={i} className={flagged.has(i + 1) ? 'cc-pt cc-break' : 'cc-pt'} cx={x(i)} cy={y(v)} r={flagged.has(i + 1) ? 5.5 : 4}>
            <title>{`${i + 1}: ${labels[i]} = ${values[i]}`}</title>
          </circle>
        ))}
        {values.map((_, i) => (values.length <= 40 || i % 5 === 0) && <text key={`n${i}`} className="cc-n" x={x(i)} y={H - 8} textAnchor="middle">{i + 1}</text>)}
      </svg>
      <svg viewBox={`0 0 ${W} ${MH}`} role="img" aria-label="Moving range chart">
        <g className="cc-limit"><line x1={PAD.l} x2={W - PAD.r} y1={my(Number(c.mrUcl))} y2={my(Number(c.mrUcl))} /><text x={PAD.l - 6} y={my(Number(c.mrUcl)) + 4} textAnchor="end">UCL {fmt(Number(c.mrUcl))}</text></g>
        <g className="cc-centre"><line x1={PAD.l} x2={W - PAD.r} y1={my(Number(c.mrBar))} y2={my(Number(c.mrBar))} /><text x={PAD.l - 6} y={my(Number(c.mrBar)) + 4} textAnchor="end">MR̄ {fmt(Number(c.mrBar))}</text></g>
        <polyline className="cc-path" points={mr.map((v, i) => `${x(i + 1)},${my(v)}`).join(' ')} />
        {mr.map((v, i) => <circle key={i} className={c.mrBreaks.includes(i + 2) ? 'cc-pt cc-break' : 'cc-pt'} cx={x(i + 1)} cy={my(v)} r={3.5} />)}
      </svg>
      <figcaption className="muted">Individuals chart (top) and moving range chart (bottom). Red: a point of a Nelson rule break (or a moving range above its limit).</figcaption>
    </figure>
  );
}
