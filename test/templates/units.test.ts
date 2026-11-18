import { describe, expect, it } from 'vitest';
import { Dec } from '../../shared/templates/dec.js';
import { convert, findUnit, unit } from '../../shared/templates/units.js';
import { Refused } from '../../shared/templates/refuse.js';

const c = (v: string, from: string, to: string): string => convert(new Dec(v), unit(from), unit(to)).toSignificantDigits(15).toString();

describe('units: same-kind conversion', () => {
  // Every expected value is the definition of the unit (hand check in the comment).
  it.each([
    ['1', 'kg', 'g', '1000'],
    ['250', 'mg', 'g', '0.25'],
    ['12.5', 'g', 'kg', '0.0125'],
    ['25', 'µg', 'mg', '0.025'],
    ['1.5', 'L', 'mL', '1500'],
    ['500', 'µL', 'mL', '0.5'],
    ['0.85', 'mm', 'µm', '850'],
    ['1.2', 'cm', 'mm', '12'],
    ['90', 'min', 'h', '1.5'],
    ['2', 'h', 's', '7200'],
    ['1', 'kp', 'N', '9.80665'], // 1 kp = 9.80665 N exactly
    ['21.2', 'kp', 'N', '207.90098'], // 21.2 × 9.80665
    ['15', 'kN', 'N', '15000'],
    ['1', 'bar', 'kPa', '100'],
    ['50', 'mbar', 'Pa', '5000'],
    ['760', 'mmHg', 'Pa', '101325.0144354'], // 760 × 133.322387415 = 101325.01443540
    ['1', 'psi', 'Pa', '6894.75729316836'], // 0.45359237 × 9.80665 ÷ 0.0254²
    ['2.0', 'kgf/cm²', 'bar', '1.96133'], // 2 × 98066.5 Pa
    ['50', 'kN/cm²', 'MPa', '500'], // 1 kN/cm² = 10 MPa
    ['1', '%', 'ppm', '10000'],
    ['5000', 'ppm', '%', '0.5'],
    ['10', '%w/v', 'mg/mL', '100'], // 10 g/100 mL
    ['1', 'kg/L', 'g/mL', '1'],
    ['30', 'kg/h', 'g/min', '500'],
    ['1', 'L/min', 'm³/h', '0.06'],
    ['2', 'kW', 'W', '2000'],
    ['1', 'kWh/kg', 'kJ/kg', '3600'],
    ['100000', 'IU/g', 'IU/mg', '100'],
    ['45', 'U/mg', 'U/g', '45000'],
    ['49.75', 'µg/mL', 'mg/mL', '0.04975'], // lab solutions: 1000 µg/mL = 1 mg/mL
    ['1', '%w/v', 'µg/mL', '10000'], // 1 g/100 mL = 10 mg/mL
    ['497.5', 'mAU', 'AU', '0.4975'], // absorbance (L1)
  ])('Units: %s %s = %s %s', (v, from, to, want) => {
    expect(c(v, from, to)).toBe(want);
  });

  it.each([
    ['25', '°C', 'K', '298.15'],
    ['0', '°C', '°F', '32'],
    ['100', '°C', '°F', '212'],
    ['104', '°F', '°C', '40'], // (104 − 32) × 5/9 = 40
    ['-40', '°F', '°C', '-40'],
    ['10', 'Δ°C', 'Δ°F', '18'], // a difference has no offset
  ])('Units: temperature with offsets: %s %s = %s %s', (v, from, to, want) => {
    expect(c(v, from, to)).toBe(want);
  });

  it.each([
    // Lab units (L5-L19): each expected value is the definition (hand check in the comment).
    ['250', 'µg/mL', 'mg/mL', '0.25'], // 1000 µg/mL = 1 mg/mL
    ['0.130', 'g/g', '%', '13'], // 1 g/g = 100 %
    ['30', 'mg/g', 'g/g', '0.03'], // 30 mg/g = 3 % = 0.03 g/g
    ['500', 'ppb', 'ppm', '0.5'], // 1000 ppb = 1 ppm
    ['1', 'dm', 'mm', '100'],
    ['10', 'µg/min', 'g/h', '0.0006'], // 10 µg × 60 = 600 µg/h
    ['50', 'µg/cm²', 'mg/cm²', '0.05'],
    ['1.3', 'µS/cm', 'mS/cm', '0.0013'],
    ['100', 'mmol/L', 'mol/L', '0.1'],
    ['2', 'g/100 mL', 'mg/mL', '20'], // alias of %w/v: 2 g per 100 mL = 20 mg/mL
  ])('Units: lab: %s %s = %s %s', (v, from, to, want) => {
    expect(c(v, from, to)).toBe(want);
  });

  it.each([['M', 'mol/L'], ['mM', 'mmol/L'], ['g/100 g', '%w/w'], ['uS/cm', 'µS/cm'], ['% v/v', '%v/v'], ['ug/min', 'µg/min']])('Units: lab alias %s is %s', (a, s) => {
    expect(findUnit(a)?.symbol).toBe(s);
  });

  it.each([
    ['96', '%v/v', '%w/w', /cannot be converted/], // an alcohol strength by volume is not a mass fraction
    ['1', 'µS/cm', 'ppm', /cannot be converted/],
    ['0.1', 'mol/L', 'mg/mL', /cannot be converted/],
  ])('Units: lab refused: %s %s to %s', (v, from, to, msg) => {
    expect(() => convert(new Dec(v), unit(from), unit(to))).toThrow(msg);
  });

  it('Units: a temperature difference compared with a limit written in °C uses the difference unit', () => {
    expect(c('1.5', 'Δ°C', '°C')).toBe('1.5');
    expect(c('9', 'Δ°F', '°C')).toBe('5');
  });

  it.each([
    ['400', 'IU', 'mg', /potency in IU, CFU or activity units is never a mass/],
    ['3', 'CFU', 'g', /never a mass/],
    ['36000', 'U', 'mg', /never a mass/],
    ['400', 'IU', 'U', /never a mass/],
    ['45', '%RH', 'g/kg', /T25/],
    ['8', 'g/kg', '%RH', /T25/],
    ['5', '%w/w', '%w/v', /cannot be converted/],
    ['1', 'kg', 'L', /cannot be converted/],
    ['25', '°C', 'Δ°C', /temperature reading/],
    ['0.5', 'AU', 'mg/mL', /cannot be converted/], // an absorbance is never a concentration (L1 uses A(1 %, 1 cm))
  ])('Units: refused: %s %s to %s', (v, from, to, msg) => {
    expect(() => convert(new Dec(v), unit(from), unit(to))).toThrow(Refused);
    expect(() => convert(new Dec(v), unit(from), unit(to))).toThrow(msg);
  });

  it.each([['mcg', 'µg'], ['ml', 'mL'], ['kP', 'kp'], ['% w/w', '%w/w'], ['cfu/g', 'CFU/g'], ['kg/cm²', 'kgf/cm²'], ['ug/mL', 'µg/mL'], ['µg/g', 'ppm'], ['mcg/g', 'ppm']])('Units: alias %s is %s', (a, s) => {
    expect(findUnit(a)?.symbol).toBe(s);
  });

  it('Units: an unknown unit is not found', () => {
    expect(findUnit('furlong')).toBeUndefined();
  });
});
