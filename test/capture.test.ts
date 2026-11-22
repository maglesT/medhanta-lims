import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cdsFill, captures, fileText, importSource, imported, inUnit, parseCds, parseReading, readCapture, rrt, type CdsFile } from '../shared/capture/index.js';
import { findBlock } from '../shared/blocks/index.js';
import { blockProblems, type Block } from '../shared/blocks/format.js';

// Instrument data capture, the pure part (plan 2.8, question 3): the fixed parsers of the serial protocols and the CDS
// result exports, and what the server does with a reading before it is stored. The sample files in test/fixtures/capture
// are invented.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/capture/${name}`, import.meta.url), 'utf8');
const lines = (name: string) => fixture(name).split(/\r?\n/);
const block = (id: string) => findBlock({ id, version: 1 })!;
const field = (b: Block, name: string) => b.fields.find((f) => f.name === name)!;

describe('LIMS-32 serial instrument protocols: fixed parsers', () => {
  it('LIMS-32 Mettler Toledo SICS: a stable reading is taken; still moving, overload, underload, busy and not understood are refused in plain words', () => {
    expect(parseReading('sics', lines('sics-stable.txt'))).toMatchObject({ ok: true, value: '51.2340', unit: 'g' });
    expect(parseReading('sics', ['S D     51.2290 g'])).toEqual({ ok: false, why: 'The balance is not stable yet: wait until the reading settles, then read again.' });
    expect(parseReading('sics', ['S +'])).toEqual({ ok: false, why: 'The balance is overloaded: take the load off.' });
    expect(parseReading('sics', ['S -'])).toEqual({ ok: false, why: 'The balance is underloaded (below zero): put the pan back and tare it.' });
    expect(parseReading('sics', ['S I'])).toEqual({ ok: false, why: 'The balance is busy and gave no reading: read again.' });
    expect(parseReading('sics', ['ES'])).toEqual({ ok: false, why: 'The balance did not understand the request (ES): check that the protocol picked is the balance\'s.' });
    expect(parseReading('sics', ['S S     -0.0012 g'])).toEqual({ ok: false, why: 'The balance shows a negative mass (-0.0012 g): tare it again, then weigh.' });
    expect(parseReading('sics', ['+  51.2340 g'])).toEqual({ ok: false, why: 'This is not a Mettler Toledo SICS reading: "+  51.2340 g". Check the protocol picked.' });
    expect(parseReading('sics', ['S S     51.2340 lb'])).toEqual({ ok: false, why: 'The balance gives the unit "lb": set it to g or mg.' });
    expect(parseReading('sics', [])).toMatchObject({ ok: false, more: true });
  });

  it('LIMS-32 Sartorius SBI and Ohaus prints: the net line of a GLP print; no unit or "?" is not stable; High, OL, negative gross are refused', () => {
    expect(parseReading('sbi', lines('sbi-glp-print.txt'))).toMatchObject({ ok: true, value: '51.3344', unit: 'g', line: 'N     +     51.3344 g' });
    expect(parseReading('sbi', ['+     51.3344 g  '])).toMatchObject({ ok: true, value: '51.3344' });
    expect(parseReading('sbi', ['+     51.33      '])).toEqual({ ok: false, why: 'The balance is not stable yet (no unit printed): wait until the reading settles, then read again.' });
    expect(parseReading('sbi', ['    High        '])).toEqual({ ok: false, why: 'The balance is overloaded: take the load off.' });
    expect(parseReading('sbi', ['-      0.0040 g  '])).toMatchObject({ ok: false, why: 'The balance shows a negative mass (-0.0040 g): tare it again, then weigh.' });
    expect(parseReading('ohaus', lines('ohaus-print.txt'))).toMatchObject({ ok: true, value: '51.3344', unit: 'g' });
    expect(parseReading('ohaus', ['   51.3344 g ?  N'])).toEqual({ ok: false, why: 'The balance is not stable yet ("?" printed): wait until the reading settles, then read again.' });
    expect(parseReading('ohaus', ['   -2.1000 g    G'])).toMatchObject({ ok: false, why: 'The balance shows a negative mass (-2.1000 g): tare it again, then weigh.' });
    expect(parseReading('ohaus', ['  -OL-  '])).toEqual({ ok: false, why: 'The balance is overloaded: take the load off.' });
    expect(parseReading('balance-line', ['51.2 mg'])).toMatchObject({ ok: true, value: '51.2', unit: 'mg' });
    expect(parseReading('balance-line', ['weight 51.2 mg'])).toEqual({ ok: false, why: 'This line is not a value and its unit: "weight 51.2 mg".' });
  });

  it('LIMS-32 pH meter, Karl Fischer and titrator prints: the reading (with the pH\'s temperature); drift, abort, no end point and two readings are refused', () => {
    expect(parseReading('ph-print', lines('ph-print.txt'))).toMatchObject({ ok: true, value: '6.85', temperature: '24.8' });
    expect(parseReading('ph-print', ['pH: 7.01 Temp: 25.0 C'])).toMatchObject({ ok: true, value: '7.01', temperature: '25.0' });
    expect(parseReading('ph-print', ['pH 6.9? 25.0 °C'])).toEqual({ ok: false, why: 'The pH reading is not stable yet: wait for the end point, then print again.' });
    expect(parseReading('ph-print', ['pH 15.20 25.0 °C'])).toEqual({ ok: false, why: 'The pH reading 15.20 is outside 0 to 14: check the meter and its calibration.' });
    expect(parseReading('kf-print', lines('kf-print.txt'))).toMatchObject({ ok: true, value: '2.3456', unit: 'mL', line: 'EP1         2.3456 mL' });
    expect(parseReading('kf-print', ['Water found 1234.5 ug'])).toMatchObject({ ok: true, value: '1234.5', unit: 'µg' });
    expect(parseReading('kf-print', lines('kf-drift-print.txt'))).toEqual({ ok: false, why: 'The titrator reports a problem: "Drift too high: 85 ug/min". Determine again.' });
    expect(parseReading('titrator-print', lines('titrator-print.txt'))).toMatchObject({ ok: true, value: '12.345', unit: 'mL' });
    expect(parseReading('titrator-print', ['EQP1 12.345 mL', 'EQP2 18.010 mL'])).toEqual({ ok: false, why: 'The print has more than one reading (12.345 mL and 18.010 mL): print one reading at a time.' });
    expect(parseReading('titrator-print', ['No EQP found'])).toEqual({ ok: false, why: 'The titrator reports a problem: "No EQP found". Titrate again.' });
  });

  it('LIMS-32 a reading is put in the step\'s unit exactly (the decimal point moved, no rounding), or refused', () => {
    expect(inUnit('0.05123', 'g', 'mg')).toBe('51.23');
    expect(inUnit('0.051230', 'g', 'mg')).toBe('51.230');
    expect(inUnit('51.2', 'mg', 'g')).toBe('0.0512');
    expect(inUnit('1234.5', 'µg', 'mg')).toBe('1.2345');
    expect(inUnit('2.3456', 'mL', 'mL')).toBe('2.3456');
    expect(inUnit('2.3456', 'mL', 'mg')).toBeNull();
  });
});

describe('LIMS-32 LIMS-50 the server re-parses the raw line and checks the reading', () => {
  const weigh = block('weigh');
  const now = new Date('2026-11-18T10:00:00Z');
  const bal = { label: 'Balance', code: 'BAL-01' };
  const raw = (over: object = {}) => ({ instrument: 'BAL-01', protocol: 'sics', raw: ['S S     0.05123 g'], readAt: '2026-11-18T09:59:30Z', ...over });

  it('LIMS-32 the value is the server\'s own parse of the raw line, in the step\'s unit, with the machine, protocol, raw line and time kept', () => {
    const r = readCapture(field(weigh, 'mass'), raw(), bal, 'mg', now);
    expect(r).toEqual({ ok: true, value: '51.23', unit: 'mg', source: { from: 'instrument', asOf: '2026-11-18T09:59:30.000Z', shown: 'BAL-01, Mettler Toledo SICS: "S S     0.05123 g" (51.23 mg)',
      capture: { instrument: 'BAL-01', protocol: 'sics', raw: ['S S     0.05123 g'], readAt: '2026-11-18T09:59:30.000Z' } } });
  });

  it('LIMS-50 a reading from another machine, an unknown protocol, an old or unstable reading, or no machine recorded is refused', () => {
    const mass = field(weigh, 'mass');
    expect(readCapture(mass, raw({ instrument: 'BAL-02' }), bal, 'mg', now)).toEqual({ ok: false, why: 'Net mass: the reading came from BAL-02, but the balance of this step is BAL-01: read it from BAL-01.' });
    expect(readCapture(mass, raw(), { label: 'Balance', code: null }, 'mg', now)).toEqual({ ok: false, why: 'Net mass: record the balance first: the reading must come from it.' });
    expect(readCapture(mass, raw({ protocol: 'kf-print' }), bal, 'mg', now)).toMatchObject({ ok: false, why: expect.stringMatching(/^Net mass: "kf-print" is not a protocol of this instrument; pick one of Mettler Toledo SICS/) });
    expect(readCapture(mass, raw({ readAt: '2026-11-18T09:45:00Z' }), bal, 'mg', now)).toEqual({ ok: false, why: 'Net mass: the reading is more than 10 minutes old: read it again.' });
    expect(readCapture(mass, raw({ raw: ['S D     0.05123 g'] }), bal, 'mg', now)).toEqual({ ok: false, why: 'Net mass: The balance is not stable yet: wait until the reading settles, then read again.' });
    expect(readCapture(mass, raw({ raw: 'S S 1 g' }), bal, 'mg', now)).toEqual({ ok: false, why: 'Net mass: the reading is incomplete: read it again.' });
  });

  it('LIMS-32 the capture fields: the weighing\'s mass, the pH and its temperature, the KF readings, the titres and the chromatography peaks', () => {
    expect(field(weigh, 'mass').capture).toBe('balance');
    expect(field(block('ph'), 'reading').capture).toBe('ph');
    expect(field(block('ph'), 'temperature').capture).toBe('ph-temperature');
    expect(['reading1', 'reading2', 'reading3'].map((n) => field(block('water-kf'), n).capture)).toEqual(['kf', 'kf', 'kf']);
    expect(['titre1', 'titre2', 'titre3'].map((n) => field(block('titration'), n).capture)).toEqual(['titrator', 'titrator', 'titrator']);
    expect(block('assay').fields.filter((f) => f.capture === 'cds').map((f) => f.name)).toEqual(['stdResponses', 'stdResponsesAfter', 'responses1', 'responses2', 'responses3']);
    // An assay by absorbance (UV) is not a chromatography run: its responses are typed as before.
    expect(captures(field(block('assay'), 'stdResponses'), { response: 'absorbance' })).toBe(false);
    expect(captures(field(block('assay'), 'stdResponses'), { response: 'peak area' })).toBe(true);
    // A capture field is one number of a block with one machine.
    const bad: Block = { ...weigh, fields: [{ name: 'mass', label: 'Mass', kind: 'text', capture: 'balance' }] };
    expect(blockProblems(bad)).toEqual(['field mass: only a number is read from an instrument', 'field mass: a reading from an instrument is one number, in a block with one machine']);
  });
});

describe('LIMS-33 CDS result files: fixed parsers', () => {
  it('LIMS-33 the generic layout: the run, sequence, processing method and version, instrument and every peak; a blank without peaks is left out', () => {
    const f = parseCds(fixture('generic-assay.csv')) as CdsFile;
    expect(f).toMatchObject({ format: 'generic', run: 'RUN-0042', sequence: 'PARA-ASSAY-2611', method: 'PARA_ASSAY version 3', instrument: 'HPLC-01' });
    expect(f.rows).toHaveLength(11);
    expect(f.rows[0]).toEqual({ injection: 2, sample: 'STD', peak: 'Paracetamol', rt: '4.51', area: '1520345.2', tailing: '1.12', plates: '8650', sn: '310' });
  });

  it('LIMS-33 Empower report CSV, Chromeleon export (tab, with its units line) and OpenLab CDS CSV', () => {
    expect(parseCds(fixture('empower-impurities.csv'))).toMatchObject({ format: 'empower', run: '4182', sequence: 'RS_PARA_181126', method: 'PARA_RS version 2', instrument: 'HPLC-02',
      rows: [{ injection: 2, sample: 'REF', area: '7512.3' }, { injection: 3 }, { injection: 4, peak: 'Impurity A', rrt: '0.80' }, { injection: 4, peak: 'Paracetamol' }, { injection: 4, peak: '', rrt: '1.61' }] });
    const c = parseCds(fixture('chromeleon-bracketing.txt')) as CdsFile;
    expect(c).toMatchObject({ format: 'chromeleon', run: 'CM-2611-0007', sequence: 'PARA_ASSAY_BRK', method: 'PARA_ASSAY_BRK version 5', instrument: 'HPLC-03' });
    expect(c.rows.map((r) => [r.injection, r.sample, r.area])).toEqual([[1, 'Standard 1', '152.034'], [2, 'Standard 2', '151.988'], [3, 'LS2600123-1', '149.877'],
      [4, 'LS2600123-1', '150.123'], [5, 'Standard 3', '152.101'], [6, 'Standard 4', '151.876']]);
    expect(c.rows[2]!.tailing).toBeUndefined();
    expect(parseCds(fixture('openlab-sst.csv'))).toMatchObject({ format: 'openlab', run: 'OL-55120', method: 'PARA_SST version 1', rows: { length: 6 } });
  });

  it('LIMS-33 Empower\'s UTF-16 export reads as its UTF-8 one', () => {
    const text = fixture('empower-impurities.csv');
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...text].map((c) => c.charCodeAt(0))).buffer)]);
    expect(fileText(utf16)).toBe(text);
  });

  it('LIMS-49 LIMS-50 a file without its run id or processing method, of another layout, or with a broken number is refused with the reason', () => {
    expect(parseCds(fixture('generic-assay.csv').replace('# run: RUN-0042\n', ''))).toEqual({ error: 'The file does not give the CDS run (result set or sequence) id: export it with the run id, so the result links back to the CDS raw data.' });
    expect(parseCds(fixture('generic-assay.csv').replace(/# processing method.*\n/g, ''))).toEqual({ error: 'The file does not name its processing method: export it with the processing method (and its version).' });
    expect(parseCds('Name,Value\nA,1\n')).toMatchObject({ error: expect.stringMatching(/^This file is not a CDS result export QLIMS reads \(generic CSV layout, Empower report CSV, Chromeleon export, OpenLab CDS CSV\)/) });
    expect(parseCds(fixture('generic-assay.csv').replace('1520345.2', '1,520,345'))).toEqual({ error: 'The file cannot be read: Line 9 has more cells than the header (a number with a thousands separator?).' });
    expect(parseCds(fixture('generic-assay.csv').replace('1520345.2', '1.52e6'))).toEqual({ error: 'The file cannot be read: Line 9: the area "1.52e6" is not a number.' });
  });
});

describe('LIMS-33 LIMS-50 which peaks fill which fields', () => {
  const names = ['LS2600123', 'LA2600001'];
  const file = (name: string) => parseCds(fixture(name)) as CdsFile;
  const assaySettings = { mode: 'external standard', response: 'peak area', preparations: '2' };

  it('LIMS-33 assay, external standard: the standard injections and each preparation\'s injections, the named peak (else the largest); other samples left out', () => {
    expect(cdsFill({ block: block('assay'), settings: assaySettings, names, file: file('generic-assay.csv') })).toEqual({ problems: [], injections: [2, 3, 4, 5, 6, 7, 8, 9, 10], values: {
      stdResponses: ['1520345.2', '1518876.9', '1522010.4', '1519654.0', '1521233.7'], responses1: ['1498765.1', '1501234.8'], responses2: ['1510987.3', '1509876.5'] } });
    expect(cdsFill({ block: block('assay'), settings: { ...assaySettings, cdsPeak: 'impurity b' }, names, file: file('generic-assay.csv') }).problems[0]).toBe('Injection 8 (LS2600123-1) has no peak named impurity b.');
  });

  it('LIMS-33 assay, bracketing: the standards before and after the samples (Chromeleon)', () => {
    expect(cdsFill({ block: block('assay'), settings: { mode: 'bracketing', response: 'peak area', preparations: '1' }, names, file: file('chromeleon-bracketing.txt') })).toEqual({ problems: [],
      injections: [1, 2, 3, 4, 5, 6], values: { responses1: ['149.877', '150.123'], stdResponses: ['152.034', '151.988'], stdResponsesAfter: ['152.101', '151.876'] } });
  });

  it('LIMS-50 the file\'s sample names must be this sample\'s and the injections must fit the step, else it is refused with the reason', () => {
    const fill = (settings: object, n = names) => cdsFill({ block: block('assay'), settings: { ...assaySettings, ...settings }, names: n, file: file('generic-assay.csv') }).problems;
    expect(fill({}, ['LS2600777'])).toEqual(['The file has no injection of LS2600777 (it has STD, LS2600123-1, LS2600123-2, LS2600999-1): import the run of this sample.']);
    expect(fill({ preparations: '3' })).toEqual(['The method sets 3 sample preparations; the file has no injection of preparation 3.']);
    expect(fill({ preparations: '1' })).toEqual(['The method sets 1 sample preparation; the file also has preparation 2.']);
    expect(fill({ response: 'absorbance' })).toEqual(['This assay reads absorbances, not a chromatography run: there is no CDS result file to import.']);
    // System suitability needs 5 or 6 replicate injections of the standard.
    const sst = parseCds(fixture('openlab-sst.csv').split('\n').filter((l) => !l.startsWith('5,') && !l.startsWith('4,')).join('\n')) as CdsFile;
    expect(cdsFill({ block: block('system-suitability'), settings: {}, names, file: sst }).problems).toEqual(['Responses of the replicate injections: the file has 3 injections (1, 2, 3); this step takes 5 to 6.']);
  });

  it('LIMS-33 system suitability: the replicate standard injections, each check on its worst injection (OpenLab)', () => {
    expect(cdsFill({ block: block('system-suitability'), settings: {}, names, file: file('openlab-sst.csv') })).toEqual({ problems: [], injections: [1, 2, 3, 4, 5],
      values: { responses: ['1520345', '1518876', '1522010', '1519654', '1521233'], tailing: '1.18', plates: '8544', resolution: '2.2', signalToNoise: '298' } });
  });

  it('LIMS-33 related substances: the test solution\'s other peaks with their RRT (the CDS\'s, else worked out to 2 decimals) and areas, the principal peak, the reference solution (Empower)', () => {
    expect(cdsFill({ block: block('impurities'), settings: { mode: 'external standard', cdsPeak: 'Paracetamol' }, names, file: file('empower-impurities.csv') })).toEqual({ problems: [],
      injections: [2, 3, 4], values: { rrts: ['0.80', '1.61'], areas: ['812.6', '402.1'], principalArea: '1502345.9', referenceResponses: ['7512.3', '7498.8'] } });
    expect(rrt('9.71', '6.02')).toBe('1.61');
    expect(rrt('3.015', '6.03')).toBe('0.50');
  });

  it('LIMS-49 what is kept of an import: the file\'s name, size and SHA-256, the run, sequence and processing method, the injections, never the file', () => {
    const f = file('generic-assay.csv');
    const i = imported(f, { name: 'assay.csv', size: 1234, hash: 'ab'.repeat(32) }, [2, 3], 1);
    expect(i).toEqual({ file: 'assay.csv', size: 1234, hash: 'ab'.repeat(32), format: 'generic', run: 'RUN-0042', sequence: 'PARA-ASSAY-2611', method: 'PARA_ASSAY version 3', instrument: 'HPLC-01', injections: [2, 3], version: 1 });
    expect(importSource(i, new Date('2026-11-18T10:00:00Z'))).toEqual({ from: 'cds', asOf: '2026-11-18T10:00:00.000Z', cds: i,
      shown: `CDS run RUN-0042, sequence PARA-ASSAY-2611, processing method PARA_ASSAY version 3, injections 2, 3; file assay.csv (generic CSV layout, 1234 bytes, SHA-256 ${'ab'.repeat(32)}), import 1` });
  });
});
