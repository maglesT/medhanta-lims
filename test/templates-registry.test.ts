import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMPLATES, callTemplate } from '../shared/engine/templates.js';
import { BLOCKS, findBlock } from '../shared/blocks/index.js';
import { masterChecks } from '../shared/master/checks.js';
import { c8PrintedData, c9SerialCodes, l21DilutionFactor, t27Expiry } from '../shared/templates/index.js';
import { small } from './engine-fixture.js';
import { ok, refused } from './templates/helpers.js';

// LIMS-53 (changes to LIMS controlled and tested) and LIMS-15 (calculations correct, checked, rounded as the
// pharmacopoeia says): the calculation templates are a fixed registry in code, each tested by its ID; blocks are
// versioned and a method names the version it uses; CI runs every test before a release (npm run ci).

const root = import.meta.dirname;
const testFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? testFiles(path.join(dir, e.name)) : e.name.endsWith('.test.ts') ? [path.join(dir, e.name)] : []));
const names = testFiles(root).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\b(?:it|describe)(?:\.each\([\s\S]*?\))?\(\s*['"`]([^'"`]+)/g)].map((m) => m[1]!));

describe('the templates registry', () => {
  it('LIMS-53 every calculation template in the registry has tests named by its ID', () => {
    const untested = Object.keys(TEMPLATES).filter((id) => !names.some((n) => n.startsWith(`${id} `) || n.startsWith(`${id}:`) || n.startsWith(`${id.replace('-', ' ')} `)));
    expect(untested).toEqual([]);
  });

  it('LIMS-53 every block of the library has a version; a method names the version it uses, and an unknown block or version is refused', () => {
    for (const b of BLOCKS) expect(Number.isInteger(b.version) && b.version >= 1, b.id).toBe(true);
    expect(new Set(BLOCKS.map((b) => `${b.id}@${b.version}`)).size).toBe(BLOCKS.length);
    expect(findBlock({ id: 'check', version: 1 })).toBeDefined();
    expect(findBlock({ id: 'check', version: 99 })).toBeUndefined();
    const doc = small([{ role: 'Analyst', steps: [{ key: 'x', block: { id: 'check', version: 99 } }] }]);
    expect(masterChecks(doc).some((p) => p.level === 'error')).toBe(true);
    // The library's version is stated where it is described.
    expect(readFileSync(path.resolve(root, '../shared/templates/README.md'), 'utf8')).toMatch(/^# Medhanta LIMS: calculation and check templates \(version \d+\)/);
    // CI (before every merge and release) runs the type check, every test, the build and the rule traceability.
    expect(JSON.parse(readFileSync(path.resolve(root, '../package.json'), 'utf8')).scripts.ci).toBe('npm run typecheck && npm test && npm run build && npm run traceability -- --check');
  });

  it('LIMS-15 a calculation is only a registered template: no formula is ever evaluated', () => {
    expect(callTemplate('X1', {})).toEqual({ ok: false, message: 'Unknown template X1' });
    expect(callTemplate('T1', '1 + 1')).toMatchObject({ ok: false });
  });
});

describe('templates kept in the library without a block yet', () => {
  it('L21 dilution factor: 5 mL to 50 mL, then 2 mL to 100 mL is 500; an aliquot without its flask is refused', () => {
    expect(ok(l21DilutionFactor({ steps: [{ aliquot: '5 mL', volume: '50 mL' }, { aliquot: '2 mL', volume: '100 mL' }] })).value.toString()).toBe('500');
    expect(refused(l21DilutionFactor({ steps: [{ aliquot: '5 mL' }] }))).toBe('Dilution 1 needs both the aliquot and the flask volume');
  });

  it('T27 expiry from the shelf life: made 2026-11, 24 months, to the end of the month before: 10/2028', () => {
    expect(ok(t27Expiry({ manufactured: '2026-11-18', months: '24' })).expiry).toBe('2028-10');
    expect(ok(t27Expiry({ manufactured: '2026-11', months: '24', rule: 'same month' })).expiry).toBe('2028-11');
    expect(refused(t27Expiry({ manufactured: '2026-11', months: '0' }))).toMatch(/whole number of months/);
  });

  it('C8 printed data: the analysis number printed after its label matches; another number does not', () => {
    expect(ok(c8PrintedData({ what: 'Analysis no.', printed: 'B.No. LA2600001', kind: 'text', expected: 'LA2600001' })).check?.pass).toBe(true);
    expect(ok(c8PrintedData({ what: 'Analysis no.', printed: 'B.No. LA2600002', kind: 'text', expected: 'LA2600001' })).check?.pass).toBe(false);
  });

  it('C9 serial codes: a GTIN with a wrong check digit is refused', () => {
    expect(refused(c9SerialCodes({ codes: '0108901234567890', gtin: '08901234567891', analysis: 'LA2600001', manufactured: '2026-11', months: '24' }))).toMatch(/GTIN/);
  });
});
