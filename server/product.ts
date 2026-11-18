import { PERMISSIONS } from './auth.js';

// The product this server runs: Medhanta LIMS, on the Medhanta platform (own tile, licence, permissions,
// database and sign-on client).
export interface Product {
  // The platform name of the product, its database and its sign-on client (lower case and _ only, as the platform's
  // manifest check requires).
  id: string;
  name: string;
  // What the product declares to the platform: its permission codes and labels (ops/manifest.draft.json).
  permissions: Record<string, string>;
  // The fixed start of its analysis numbers (LIMS-01).
  analysisPrefix: string;
}

export const LIMS: Product = { id: 'lims', name: 'Medhanta LIMS', permissions: PERMISSIONS, analysisPrefix: 'LA' };
