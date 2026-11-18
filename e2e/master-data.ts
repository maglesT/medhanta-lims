// Invented master data for the browser tests: what core's master_data views would list.
import type { FakeMaster } from '../test/helpers.js';
import { E2E_MATERIAL_ID, E2E_PRODUCT_ID, E2E_RETEST_ID } from './config.js';

const item = (itemId: string, code: string, name: string) => ({ itemId, code, name, version: 1, active: true });
export function seedMasterData(m: FakeMaster) {
  // The lab instruments, standing in the QC laboratory and its instrument room.
  m.equipment_.push(
    { ...item('eq-bal', 'BAL-01', 'Analytical balance 220 g'), kind: 'instrument', type: 'analytical balance', room: 'QCL-01' },
    { ...item('eq-son', 'SON-01', 'Ultrasonic bath'), kind: 'instrument', type: 'sonicator', room: 'QCL-01' },
    { ...item('eq-ovn', 'OVN-01', 'Hot air oven'), kind: 'instrument', type: 'oven', room: 'QCL-01' },
    { ...item('eq-hplc', 'HPLC-01', 'HPLC with UV detector'), kind: 'instrument', type: 'hplc', room: 'INS-01' },
    // Due for requalification in Qualification (e2e/server.ts): never offered (the instruments journey).
    { ...item('eq-bal2', 'BAL-02', 'Analytical balance 120 g'), kind: 'instrument', type: 'analytical balance', room: 'QCL-01' },
  );
  // The material of the samples journey.
  m.materials_.push({ ...item(E2E_MATERIAL_ID, 'RM-012', 'Demolol (active substance)'), category: 'API', unit: 'kg' });
  // The material of the retest journey.
  m.materials_.push({ ...item(E2E_RETEST_ID, 'RM-031', 'Exampline hydrochloride (active substance)'), category: 'API', unit: 'kg' });
  // The product of the OOS journey.
  m.products_.push({ ...item(E2E_PRODUCT_ID, 'FG-DEM100', 'Demolol 100 mg tablets'), strength: '100 mg', dosageForm: 'Tablet' });
  // These rooms only, not the fixtures' rooms of the server tests.
  m.rooms_.splice(0);
  m.rooms_.push(
    { ...item('rm-qcl', 'QCL-01', 'Wet chemistry laboratory'), area: 'QC laboratory', grade: 'D' },
    { ...item('rm-ins', 'INS-01', 'Instrument room 1'), area: 'Instrument room', grade: 'D' },
  );
}
