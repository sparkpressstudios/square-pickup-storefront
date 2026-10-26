import { assertSandboxPublicConfig } from './square-sandbox';

export const integrationOwnership = Object.freeze([
  { resource: 'Products and variants', owner: 'Application catalog', rule: 'No automatic Square Catalog import or export.' },
  { resource: 'Available stock', owner: 'Local inventory reservations', rule: 'Square events never decrement or restock inventory a second time.' },
  { resource: 'Checkout and order identity', owner: 'Server checkout identity', rule: 'Keep one checkout and its stable order/payment keys across retries; never import another order from a webhook.' },
  { resource: 'Payment and refund evidence', owner: 'Verified Square evidence', rule: 'Match merchant, location, order and amount; mock receipts cannot authorize fulfillment.' },
  { resource: 'Customers', owner: 'No customer sync implemented', rule: 'No automatic customer import, export or marketing subscription.' },
]);
export interface SetupMetadata { environment: 'sandbox'; applicationId: string; locationId: string }
export function setupMetadataReady(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || !['environment', 'applicationId', 'locationId'].every((key) => Object.hasOwn(input, key))) return false;
  if (typeof input.applicationId !== 'string' || typeof input.locationId !== 'string' || input.applicationId.length > 128) return false;
  try { assertSandboxPublicConfig(input as unknown as SetupMetadata); return true; } catch { return false; }
}
export type JobState = 'queued' | 'running' | 'retry' | 'succeeded' | 'attention';
export type JobFailure = 'WAITING_FOR_PAYMENT' | 'TRANSIENT_DATABASE' | 'RECONCILIATION_CONFLICT' | 'UNEXPECTED_FAILURE' | 'ATTEMPTS_EXHAUSTED';
export interface ReconciliationSummary {
  counts: Record<JobState, number>; pendingEvents: number; unknownPayments: number; expiredLeases: number;
  recent: { id: string; state: JobState; attempts: number; failureCode: JobFailure | null; availableAt: string; updatedAt: string }[];
}
export interface IntegrationStatus {
  mode: 'sandbox-preparation' | 'sandbox-runtime'; connected: false; providerCallsEnabled: boolean; automaticSyncEnabled: false; workerEnabled: false;
  credentialStatus: 'not-loaded' | 'configured-not-verified'; acceptance: 'not-run'; storage: 'memory' | 'embedded-postgres' | 'native-postgres';
  reconciliation: ReconciliationSummary | null;
}
export function integrationStatus(reconciliation: ReconciliationSummary | null = null, runtime?: { native?: boolean; sandbox?: boolean }): IntegrationStatus {
  return { mode: runtime?.sandbox ? 'sandbox-runtime' : 'sandbox-preparation', connected: false, providerCallsEnabled: runtime?.sandbox === true, automaticSyncEnabled: false, workerEnabled: false,
    credentialStatus: runtime?.sandbox ? 'configured-not-verified' : 'not-loaded', acceptance: 'not-run', storage: runtime?.native ? 'native-postgres' : reconciliation ? 'embedded-postgres' : 'memory', reconciliation };
}
