import { describe, expect, it } from 'vitest';
import { Dec } from '../shared/templates/dec.js';
import { convert, findUnit, unit, whyNot } from '../shared/templates/units.js';

describe('parenteral units (injection bulk tests)', () => {
  it('osmolality is mOsm/kg, its own kind; Osm/kg converts', () => {
    expect(unit('mOsm/kg').kind).toBe('osmolality');
    expect(convert(new Dec('0.3'), unit('Osm/kg'), unit('mOsm/kg')).toString()).toBe('300');
    expect(findUnit('mOsmol/kg')?.symbol).toBe('mOsm/kg');
    expect(whyNot(unit('mOsm/kg'), unit('mg/mL'))).toBeTruthy();
  });
  it('dissolved oxygen in mg/L is a mass concentration (1000 mg/L = 1 mg/mL)', () => {
    expect(unit('mg/L').kind).toBe('mass concentration');
    expect(convert(new Dec('1000'), unit('mg/L'), unit('mg/mL')).toString()).toBe('1');
    expect(convert(new Dec('1'), unit('mg/L'), unit('µg/L')).toString()).toBe('1000');
    expect(findUnit('mg/l')?.symbol).toBe('mg/L');
  });
});
