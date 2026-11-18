import { describe, expect, it } from 'vitest';
import { l11MicrobialCount, l12Endotoxin, l13MicrobialAssay, MPN_TABLE, tenToN, type L11Input, type L12Input, type L13Input } from '../../shared/templates/lab-micro.js';
import { callTemplate, TEMPLATES } from '../../shared/engine/templates.js';
import { ok, refused } from './helpers.js';

// The microbiology templates with hand-checked numbers (own demo numbers; the arithmetic in the comments; the
// statistics of L12 and L13 checked by an independent floating-point calculation).

const nmt = (high: string, unit: string, alertHigh?: string) => ({ high, unit, ...(alertHigh ? { alertHigh } : {}) });
const counts = (s: string) => s.split(' ').map((v) => ({ value: v, unit: 'CFU' }));
const tamc = (over: Partial<Extract<L11Input, { mode: 'plate count' }>> = {}): Extract<L11Input, { mode: 'plate count' }> => ({
  mode: 'plate count', per: 'CFU/g', countable: 'TAMC: fewer than 250 per plate', amount: '1 mL', acceptance: '10^n',
  levels: [{ dilution: '10', counts: counts('45 52') }, { dilution: '100', counts: counts('5 3') }], ...over,
});

describe('L11 microbial count', () => {
  it('is registered', () => {
    expect(['L11', 'L12', 'L13'].every((k) => k in TEMPLATES)).toBe(true);
  });

  it('plate count: the dilution with the highest count fewer than 250; mean × dilution ÷ amount plated', () => {
    // 1 in 10: 45 and 52, mean 48.5; 48.5 × 10 ÷ 1 mL = 485 CFU/g. 10^3 is read as NMT 2000: within.
    const r = ok(l11MicrobialCount({ ...tamc(), limit: nmt('1000', 'CFU/g') }));
    expect(r.value.toString()).toBe('485');
    expect(r.unit).toBe('CFU/g');
    expect(r.check).toMatchObject({ pass: true, rounded: '485 CFU/g' });
    expect(r.shown).toContain('criterion 10^3 read as not more than 2000 CFU/g');
    expect(r.shown).toContain('48.5 × 10 ÷ 1 mL = 485 CFU/g');
    // 10^2: NMT 200, so 485 fails (an OOS).
    expect(ok(l11MicrobialCount({ ...tamc(), limit: nmt('100', 'CFU/g') })).check).toMatchObject({ pass: false, level: 'fail' });
  });

  it('S8 10^n is read as not more than 2 × 10^n (10 → 20, 100 → 200, 1000 → 2000); a limit that is not a power of ten is refused', () => {
    expect(tenToN(nmt('10', 'CFU/g')).high).toBe('20');
    expect(tenToN(nmt('100', 'CFU/g')).high).toBe('200');
    expect(tenToN(nmt('1000', 'CFU/g')).high).toBe('2000');
    // 200 counted against 10^2 passes (as the pharmacopoeia states), 201 does not.
    const one = (c: string) => l11MicrobialCount({ mode: 'plate count', per: 'CFU/g', countable: 'TAMC: fewer than 250 per plate', amount: '1 mL', acceptance: '10^n', limit: nmt('100', 'CFU/g'), levels: [{ dilution: '1', counts: counts(c) }] });
    expect(ok(one('200 200')).check?.pass).toBe(true);
    expect(ok(one('201 201')).check?.pass).toBe(false);
    expect(refused(l11MicrobialCount({ ...tamc(), limit: nmt('500', 'CFU/g') }))).toMatch(/not a power of ten/);
    // As written (an EM action level), the limit is the number itself.
    expect(ok(l11MicrobialCount({ ...tamc(), acceptance: 'as written', limit: nmt('500', 'CFU/g') })).check?.pass).toBe(true);
  });

  it('a plate at or above the countable maximum moves to the next dilution; TNTC likewise', () => {
    // TYMC fewer than 50: 1 in 10 has 60 and 55; 1 in 100: 6 and 4, mean 5 × 100 = 500 CFU/g.
    const r = ok(l11MicrobialCount({ ...tamc(), countable: 'TYMC: fewer than 50 per plate', levels: [{ dilution: '10', counts: counts('60 55') }, { dilution: '100', counts: counts('6 4') }] }));
    expect(r.value.toString()).toBe('500');
    expect(r.dilution?.toString()).toBe('100');
    // 250 itself is not "fewer than 250".
    const t = ok(l11MicrobialCount(tamc({ levels: [{ dilution: '10', counts: counts('250 240') }, { dilution: '100', counts: counts('25 23') }] })));
    expect(t.value.toString()).toBe('2400');
    const n = ok(l11MicrobialCount(tamc({ levels: [{ dilution: '10', tntc: 'yes' }, { dilution: '100', counts: counts('120 130') }] })));
    expect(n.value.toString()).toBe('12500');
    // 30 to 300, 0.1 mL spread: 1 in 100: 35 and 41, mean 38 × 100 ÷ 0.1 mL = 38000 CFU/mL.
    const s = ok(l11MicrobialCount({ mode: 'plate count', per: 'CFU/mL', countable: '30 to 300 per plate', amount: '0.1 mL',
      levels: [{ dilution: '10', counts: counts('320 310') }, { dilution: '100', counts: counts('35 41') }] }));
    expect(s.value.toString()).toBe('38000');
  });

  it('"less than" when none is counted at the lowest dilution; "more than" when every dilution has too many', () => {
    const r = ok(l11MicrobialCount({ ...tamc({ levels: [{ dilution: '10', counts: counts('0 0') }] }), limit: nmt('100', 'CFU/g') }));
    expect(r).toMatchObject({ qualifier: '<', unit: 'CFU/g' });
    expect(r.value.toString()).toBe('10');
    expect(r.shown).toMatch(/less than 1 × 10 ÷ 1 mL = less than 10 CFU\/g/);
    expect(r.check).toMatchObject({ pass: true, rounded: '< 10 CFU/g' });
    // TNTC at 1 in 10 and 1 in 100: more than 250 × 100 = 25000 CFU/g, above NMT 2000: fails.
    const m = ok(l11MicrobialCount({ ...tamc({ levels: [{ dilution: '10', tntc: true }, { dilution: '100', tntc: true }] }), limit: nmt('1000', 'CFU/g') }));
    expect(m).toMatchObject({ qualifier: '>', check: { pass: false } });
    expect(m.value.toString()).toBe('25000');
    // A "less than" bound above the limit tells nothing: refused (another dilution).
    expect(refused(l11MicrobialCount({ ...tamc({ levels: [{ dilution: '100', counts: counts('0 0') }] }), limit: nmt('10', 'CFU/g') }))).toMatch(/less than 100 CFU\/g, which is above the limit/);
  });

  it('per plate (EM): the colonies on the plate, against alert and action levels', () => {
    const plate = (c: string) => l11MicrobialCount({ mode: 'plate count', per: 'CFU', countable: 'TAMC: fewer than 250 per plate', acceptance: 'as written',
      levels: [{ dilution: '1', counts: counts(c) }], limit: nmt('5', 'CFU', '3') });
    expect(ok(plate('2')).check?.level).toBe('pass');
    expect(ok(plate('4')).check?.level).toBe('alert');
    expect(ok(plate('6')).check?.level).toBe('fail');
    // Air: 12 colonies in 1000 L (1 m³) = 12 CFU/m³.
    expect(ok(l11MicrobialCount({ mode: 'plate count', per: 'CFU/m³', countable: 'TAMC: fewer than 250 per plate', amount: '1000 L', levels: [{ dilution: '1', counts: counts('12') }] })).value.toString()).toBe('12');
  });

  it('MPN: the published 3-tube table with its 95 % limits; scaled for another first level', () => {
    expect(MPN_TABLE).toHaveLength(40);
    const r = ok(l11MicrobialCount({ mode: 'MPN', positives: ['3', '1', '0'], per: 'CFU/g' }));
    expect([r.value.toString(), r.lower?.toString(), r.upper?.toString()]).toEqual(['43', '9', '181']);
    // First level 1 g per tube: the table ÷ 10.
    expect(ok(l11MicrobialCount({ mode: 'MPN', positives: ['3', '1', '0'], per: 'CFU/g', firstLevel: '1 g' })).value.toString()).toBe('4.3');
    expect(ok(l11MicrobialCount({ mode: 'MPN', positives: ['0', '0', '0'], per: 'CFU/g', limit: nmt('100', 'CFU/g'), acceptance: '10^n' }))).toMatchObject({ qualifier: '<', check: { pass: true } });
    expect(ok(l11MicrobialCount({ mode: 'MPN', positives: ['3', '3', '3'], per: 'CFU/g' }))).toMatchObject({ qualifier: '>' });
    expect(refused(l11MicrobialCount({ mode: 'MPN', positives: ['0', '3', '3'], per: 'CFU/g' }))).toMatch(/not in the MPN table/);
    expect(refused(l11MicrobialCount({ mode: 'MPN', positives: ['4', '0', '0'], per: 'CFU/g' }))).toMatch(/0, 1, 2 or 3/);
  });

  it('refusals in plain words', () => {
    expect(refused(l11MicrobialCount(tamc({ countable: 'any' })))).toMatch(/counting range/);
    expect(refused(l11MicrobialCount(tamc({ amount: undefined })))).toMatch(/needs the volume plated/);
    expect(refused(l11MicrobialCount(tamc({ levels: [{ dilution: '10', counts: counts('4.5') }] })))).toMatch(/whole number/);
    expect(refused(l11MicrobialCount(tamc({ levels: [{ dilution: '10' }] })))).toMatch(/record the colonies/);
    expect(refused(l11MicrobialCount(tamc({ levels: [{ dilution: '10', tntc: true, counts: counts('3') }] })))).toMatch(/not both/);
    expect(refused(l11MicrobialCount(tamc({ amount: '1 mg/mL' })))).toMatch(/amount plated/);
    // CFU never becomes a mass (an L11 per g against a limit in mg is refused by the unit list).
    expect(refused(l11MicrobialCount({ ...tamc(), acceptance: 'as written', limit: nmt('100', 'mg') }))).toMatch(/cannot be converted to mg/);
  });
});

// ---------------------------------------------------------------- L12
// Standard curve: onset time t = 1000 s × c^-0.25 (log t = 3 − 0.25 log c), duplicates with a little scatter.
// Independent calculation: |r| = 0.99998, slope −0.24964; A reads back 0.01994 and 0.02021, mean 0.020073 EU/mL;
// B 0.070127 EU/mL; spike 0.05 EU/mL recovered (0.070127 − 0.020073) ÷ 0.05 = 100.1 %.
// Limit 0.25 EU/mg, solution 10 mg/mL, λ 0.005 EU/mL (the lowest standard): MVD = 0.25 × 10 ÷ 0.005 = 500.
// Tested 1 in 100: 0.020073 × 100 ÷ 10 mg/mL = 0.2007 EU/mg, less than 0.25: complies.
const S = (c: string, ...t: string[]) => ({ concentration: `${c} EU/mL`, responses: t.map((x) => `${x} s`) });
const kinetic = (over: Partial<Extract<L12Input, { mode: 'photometric' }>> = {}): L12Input => ({
  mode: 'photometric', response: 'onset time', standards: [S('0.005', '3761', '3740'), S('0.05', '2115', '2130'), S('0.5', '1189', '1180'), S('5', '669', '672')],
  sample: ['2659 s', '2650 s'], spiked: ['1945 s', '1940 s'], spike: '0.05 EU/mL', negativeControl: 'yes',
  limit: { high: '0.25', unit: 'EU/mg' }, concentration: '10 mg/mL', dilution: '100', ...over,
});

describe('L12 bacterial endotoxins', () => {
  it('MVD = limit × concentration ÷ λ, in the limit\'s terms (S8)', () => {
    expect(ok(l12Endotoxin({ mode: 'MVD', lambda: '0.125 EU/mL', limit: { high: '0.25', unit: 'EU/mg' }, concentration: '10 mg/mL' })).value.toString()).toBe('20');
    expect(ok(l12Endotoxin({ mode: 'MVD', lambda: '0.125 EU/mL', limit: { high: '0.5', unit: 'EU/mL' } })).value.toString()).toBe('4');
    // Per IU of the active: 0.01 EU/IU × 1000 IU/mL ÷ 0.06 EU/mL = 166.7.
    expect(ok(l12Endotoxin({ mode: 'MVD', lambda: '0.06 EU/mL', limit: { high: '0.01', unit: 'EU/IU' }, concentration: '1000 IU/mL' })).value.toFixed(1)).toBe('166.7');
    expect(refused(l12Endotoxin({ mode: 'MVD', lambda: '0.125 EU/mL', limit: { high: '0.25', unit: 'EU/mg' } }))).toMatch(/needs the concentration .* \(safety rule S8\)/);
    expect(refused(l12Endotoxin({ mode: 'MVD', lambda: '0.125 EU/mL', limit: { high: '0.25', unit: 'EU/mg' }, concentration: '10 IU/mL' }))).toMatch(/S8: in mg\/mL/);
  });

  it('LIMS-38 photometric: |r| ≥ 0.980, spike 50-200 %, the result less than the limit (hand-checked)', () => {
    const r = ok(l12Endotoxin(kinetic()));
    expect(r.value.toFixed(4)).toBe('0.2007');
    expect(r.unit).toBe('EU/mg');
    expect(r.r?.abs().toFixed(5)).toBe('0.99998');
    expect(r.recovery?.toFixed(1)).toBe('100.1');
    expect(r.mvd?.toString()).toBe('500');
    expect(r.check).toMatchObject({ pass: true });
    // Limit 0.2 EU/mg: 0.2007 rounds to 0.2 at the limit's decimals: not LESS than 0.2, so it does not comply.
    expect(ok(l12Endotoxin(kinetic({ limit: { high: '0.20', unit: 'EU/mg' } }))).check).toMatchObject({ pass: false });
  });

  it('LIMS-38 an invalid photometric test is refused with the reason (no result: repeat)', () => {
    expect(refused(l12Endotoxin(kinetic({ standards: [S('0.005', '3761'), S('0.05', '1000'), S('0.5', '3000'), S('5', '669')] })))).toMatch(/\|r\| is .*less than 0\.980/);
    expect(refused(l12Endotoxin(kinetic({ spiked: ['2600 s', '2610 s'] })))).toMatch(/spike was recovered at .* outside 50-200 %/);
    expect(refused(l12Endotoxin(kinetic({ negativeControl: 'no' })))).toMatch(/negative control/);
    expect(refused(l12Endotoxin(kinetic({ dilution: '1000' })))).toMatch(/beyond the maximum valid dilution 500\.0/);
    expect(refused(l12Endotoxin(kinetic({ standards: [S('0.005', '3761'), S('0.05', '2115')] })))).toMatch(/at least 3/);
    // A below the lowest standard: less than λ × dilution.
    const below = ok(l12Endotoxin(kinetic({ sample: ['4000 s', '4100 s'], spiked: ['2073 s', '2070 s'] })));
    expect(below).toMatchObject({ qualifier: '<' });
    expect(below.value.toString()).toBe('0.05');
  });

  it('gel clot: confirmation of λ by the geometric mean of the end-points (0.5λ to 2λ)', () => {
    // End-points λ, λ, 0.5λ, 2λ of λ 0.125: geometric mean = 0.125 × (1 × 1 × 0.5 × 2)^(1/4) = 0.125 EU/mL.
    const r = ok(l12Endotoxin({ mode: 'gel clot confirm', lambda: '0.125 EU/mL', endpoints: ['λ', 'λ', '0.5λ', '2λ'] }));
    expect(r.value.toString()).toBe('0.125');
    expect(r.check?.pass).toBe(true);
    // 2λ in every series: 0.25 EU/mL = 2λ, still within.
    expect(ok(l12Endotoxin({ mode: 'gel clot confirm', lambda: '0.125 EU/mL', endpoints: ['2λ', '2λ', '2λ', '2λ'] })).check?.pass).toBe(true);
    expect(refused(l12Endotoxin({ mode: 'gel clot confirm', lambda: '0.125 EU/mL', endpoints: ['λ', '0.25λ', 'λ', 'λ'] }))).toMatch(/0\.25λ, which must be negative/);
  });

  it('LIMS-38 gel clot limit test: the controls; both A negative complies, both positive does not, one each is repeated', () => {
    const base = { mode: 'gel clot limit' as const, lambda: '0.125 EU/mL', b: ['+', '+'], c: ['+', '+'], dControl: ['−', '−'], limit: { high: '0.5', unit: 'EU/mL' }, dilution: '4' };
    // MVD 0.5 ÷ 0.125 = 4: tested at 1 in 4. Negative: less than 0.125 × 4 = 0.5 EU/mL.
    const pass = ok(l12Endotoxin({ ...base, a: ['−', '−'] }));
    expect(pass).toMatchObject({ decision: 'complies', qualifier: '<', check: { pass: true } });
    expect(pass.value.toString()).toBe('0.5');
    expect(ok(l12Endotoxin({ ...base, a: ['+', '+'] }))).toMatchObject({ decision: 'does not comply', check: { pass: false } });
    expect(refused(l12Endotoxin({ ...base, a: ['+', '−'] }))).toMatch(/repeat the test/);
    expect(ok(l12Endotoxin({ ...base, a: ['+', '−'], repeat: 'yes' })).check?.pass).toBe(false);
    expect(ok(l12Endotoxin({ ...base, a: ['−', '−'], repeat: 'yes' })).check?.pass).toBe(true);
    expect(refused(l12Endotoxin({ ...base, a: ['−', '−'], dControl: ['+', '−'] }))).toMatch(/not valid/);
    expect(refused(l12Endotoxin({ ...base, a: ['−', '−'], b: ['+', '−'] }))).toMatch(/not valid/);
  });

  it('S8 gel clot quantitative: end-point dilution × λ × the sample\'s own dilution; censored results', () => {
    const base = { mode: 'gel clot quantitative' as const, lambda: '0.125 EU/mL', b: ['+', '+'], cEndpoints: ['λ', 'λ'], dControl: ['−', '−'], limit: { high: '5', unit: 'EU/mL' }, dilution: '10' };
    // End-points 1 in 2 and 1 in 4: 2 × 0.125 × 10 = 2.5 and 4 × 0.125 × 10 = 5 EU/mL; the higher is reported: 5, not less than 5: fails.
    const r = ok(l12Endotoxin({ ...base, aEndpoints: ['2', '4'] }));
    expect(r.value.toString()).toBe('5');
    expect(r.check?.pass).toBe(false);
    expect(ok(l12Endotoxin({ ...base, aEndpoints: ['2', '2'] }))).toMatchObject({ check: { pass: true } });
    const none = ok(l12Endotoxin({ ...base, aEndpoints: ['none positive', 'none positive'] }));
    expect(none).toMatchObject({ qualifier: '<', check: { pass: true } });
    expect(none.value.toString()).toBe('1.25');
    expect(ok(l12Endotoxin({ ...base, aEndpoints: ['8', '8'] }))).toMatchObject({ qualifier: '≥', check: { pass: false } });
    expect(refused(l12Endotoxin({ ...base, aEndpoints: ['2', '2'], cEndpoints: ['2λ', 'no clot'] }))).toMatch(/not valid/);
  });
});

// ---------------------------------------------------------------- L13
// 3 + 3 doses (1, 2, 4 IU/mL), 4 plates each, zone diameters in mm; the test made at an assumed 1000 IU/mg.
// Independent calculation (float): slope 3.06573 mm per ln dose; F regression 4335, parallelism 0.60, linearity 0.20
// (df 18; F(0.95; 1, 18) = 4.41, F(0.95; 2, 18) = 3.55); potency 1114.86 IU/mg, 95 % fiducial limits 1075.23 to
// 1156.20 IU/mg (96.45 to 103.71 %).
const mm = (s: string) => s.split(' ').map((v) => `${v} mm`);
const assay = (over: Partial<L13Input> = {}): L13Input => ({
  design: 'completely randomised', assumedPotency: '1000 IU/mg',
  standard: { doses: ['1 IU/mL', '2 IU/mL', '4 IU/mL'], responses: [mm('15.8 16.0 15.9 16.1'), mm('18.0 18.2 17.9 18.1'), mm('20.1 20.3 20.0 20.2')] },
  test: { doses: ['1 IU/mL', '2 IU/mL', '4 IU/mL'], responses: [mm('16.2 16.4 16.1 16.3'), mm('18.3 18.5 18.4 18.2'), mm('20.6 20.4 20.5 20.7')] },
  ...over,
});

describe('L13 microbial assay of antibiotics', () => {
  it('parallel lines, 3 + 3: the analysis of variance, the potency and its fiducial limits (hand-checked)', () => {
    const r = ok(l13MicrobialAssay(assay({ limit: { low: '900', high: '1100', unit: 'IU/mg' } })));
    expect(r.value.toFixed(2)).toBe('1114.86');
    expect([r.lower.toFixed(2), r.upper.toFixed(2)]).toEqual(['1075.23', '1156.20']);
    expect([r.lowerPercent.toFixed(2), r.upperPercent.toFixed(2)]).toEqual(['96.45', '103.71']);
    expect(r.slope.toFixed(5)).toBe('3.06573');
    expect(r.anova.map((a) => [a.source, a.df, a.f?.toFixed(2)])).toEqual([
      ['preparations', 1, undefined], ['regression', 1, '4335.00'], ['parallelism', 1, '0.60'], ['linearity', 2, '0.20'], ['residual error', 18, undefined]]);
    expect(r.anova[1]!.critical!.toFixed(2)).toBe('4.41');
    // The estimate 1114.9 is above 1100: fails; on the lower fiducial limit (1075.2) it passes.
    expect(r.check?.pass).toBe(false);
    expect(ok(l13MicrobialAssay(assay({ limit: { low: '900', high: '1100', unit: 'IU/mg' }, checkOn: 'lower fiducial limit' }))).check?.pass).toBe(true);
    expect(ok(l13MicrobialAssay(assay({ precision: { low: '95', high: '105', unit: '%' } }))).precisionCheck?.pass).toBe(true);
    expect(ok(l13MicrobialAssay(assay({ precision: { low: '97', high: '103', unit: '%' } }))).precisionCheck?.pass).toBe(false);
  });

  it('2 + 2 doses and randomised blocks (plates) work the same way', () => {
    const two = ok(l13MicrobialAssay(assay({
      standard: { doses: ['1 IU/mL', '4 IU/mL'], responses: [mm('15.8 16.0 15.9 16.1'), mm('20.1 20.3 20.0 20.2')] },
      test: { doses: ['1 IU/mL', '4 IU/mL'], responses: [mm('16.2 16.4 16.1 16.3'), mm('20.6 20.4 20.5 20.7')] },
    })));
    // mean T − mean S = 18.4 − 18.05 = 0.35 mm; slope = 4 × ln 2 × (4.2 + 4.3) ÷ (2 × 4 × 2 × (ln 2)²) = 2.125 ÷ ln 2 = 3.06573;
    // potency = 1000 × e^(0.35 ÷ 3.06573) = 1120.94 IU/mg.
    expect(two.value.toFixed(2)).toBe('1120.94');
    expect(two.anova.map((a) => a.source)).not.toContain('linearity');
    const blocks = ok(l13MicrobialAssay(assay({ design: 'randomised blocks' })));
    expect(blocks.value.toFixed(2)).toBe('1114.86');
    expect(blocks.anova.find((a) => a.source === 'residual error')!.df).toBe(15);
  });

  it('an assay that is not valid is refused: regression not significant, lines not parallel', () => {
    expect(refused(l13MicrobialAssay(assay({ test: { doses: ['1 IU/mL', '2 IU/mL', '4 IU/mL'], responses: [mm('16.2 16.4 16.1 16.3'), mm('20.3 20.5 20.4 20.2'), mm('24.6 24.4 24.5 24.7')] } })))).toMatch(/deviate significantly from parallel/);
    const flat = { doses: ['1 IU/mL', '2 IU/mL', '4 IU/mL'], responses: [mm('15 17 16 18'), mm('17 15 18 16'), mm('16 18 15 17')] };
    expect(refused(l13MicrobialAssay(assay({ standard: flat, test: flat })))).toMatch(/regression is not significant/);
    expect(refused(l13MicrobialAssay(assay({ test: { doses: ['1 IU/mL', '3 IU/mL', '9 IU/mL'], responses: assay().test.responses } })))).toMatch(/same dose ratio/);
    expect(refused(l13MicrobialAssay(assay({ test: { doses: ['1 IU/mL', '2 IU/mL', '4 IU/mL'], responses: [mm('16.2 16.4 16.1'), mm('18.3 18.5 18.4 18.2'), mm('20.6 20.4 20.5 20.7')] } })))).toMatch(/balanced/);
    expect(refused(l13MicrobialAssay(assay({ standard: { doses: ['4 IU/mL', '2 IU/mL', '1 IU/mL'], responses: assay().standard.responses } })))).toMatch(/lowest to the highest/);
  });

  it('through the engine\'s call: a bug-level input becomes a refusal, never a crash', () => {
    expect(callTemplate('L13', {}).ok).toBe(false);
    expect(callTemplate('L11', { mode: 'plate count' }).ok).toBe(false);
    expect(callTemplate('L12', { mode: 'photometric' }).ok).toBe(false);
  });
});
