import type { Permission } from '../server/auth.js';

// Overridable so two working copies can run their browser tests side by side.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8291);
export const E2E_SCHEMA = process.env.E2E_SCHEMA ?? 'e2e';
// Recruitment's stand-in training_v1 (e2e/server.ts).
export const E2E_RECRUITMENT = `${E2E_SCHEMA}_rc`;
// Invented test people and the Medhanta LIMS permissions core gives them.
export const USERS: Record<string, Permission[]> = {
  op1: ['lims.analysis.perform'],
  chk1: ['lims.analysis.check'],
  qa1: ['lims.qc.approve', 'lims.master.approve'],
  // Makes a version effective when the change control was typed by hand (no QMS link).
  qa2: ['lims.master.approve'],
  // The review journey: the second person who reviews (and closes a deviation note typed by hand).
  rev1: ['lims.analysis.review', 'lims.qc.approve'],
  // A reviewer who checked a step of the analysis: nobody reviews their own work (LIMS-41).
  rev2: ['lims.analysis.review', 'lims.analysis.check'],
  // Writes the fixture method and starts the analysis of the floor journey.
  iss1: ['lims.master.author', 'lims.analysis.perform'],
  // The method designer journey: an author and a second-person checker (qa1 approves).
  author1: ['lims.master.author'],
  mcheck1: ['lims.master.check'],
  norole: [],
};
