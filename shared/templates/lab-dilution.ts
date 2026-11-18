/**
 * L21 Dilution factor: the overall factor of up to three dilutions in a row, each "aliquot into a flask of volume":
 * factor = (V1 ÷ a1) × (V2 ÷ a2) × (V3 ÷ a3). Volumes of any volume unit; each aliquot must be less than its flask.
 */
import { Dec, fmt, parse, refuse, run, sameKind, needKind, to, type Outcome, type Q } from './core.js';

export interface L21Input {
  /** The dilutions in order; a pair with neither value given is left out. */
  readonly steps: readonly { readonly aliquot?: Q; readonly volume?: Q }[];
  readonly decimals?: number;
}

export function l21DilutionFactor(i: L21Input): Outcome {
  return run(() => {
    const given = i.steps.filter((s) => s.aliquot !== undefined || s.volume !== undefined);
    if (!given.length) refuse('A dilution needs an aliquot and a flask volume');
    let factor = new Dec(1);
    const parts: string[] = [];
    given.forEach((s, n) => {
      if (s.aliquot === undefined || s.volume === undefined) refuse(`Dilution ${n + 1} needs both the aliquot and the flask volume`);
      const a = parse(s.aliquot, `The aliquot of dilution ${n + 1}`);
      const v = parse(s.volume, `The flask volume of dilution ${n + 1}`);
      needKind(a, ['volume'], `The aliquot of dilution ${n + 1}`);
      sameKind([a, v], `Dilution ${n + 1}`);
      if (!a.v.isPositive() || a.v.isZero()) refuse(`The aliquot of dilution ${n + 1} must be more than zero`);
      const av = to(a, v.unit);
      if (av.gt(v.v)) refuse(`Dilution ${n + 1}: the aliquot (${a.text}) is more than the flask volume (${v.text}); check the method`);
      factor = factor.times(v.v.div(av));
      parts.push(`${v.text} ÷ ${a.text}`);
    });
    const value = factor;
    return { ok: true, value, unit: 'units', shown: `Dilution factor = ${parts.join(' × ')} = ${fmt(value, i.decimals ?? (value.isInteger() ? 0 : 3))}` };
  });
}
