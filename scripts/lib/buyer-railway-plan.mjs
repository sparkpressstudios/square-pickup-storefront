import { inspectSetup } from './template-setup.mjs';

/** Offline comparison of an operator's recorded effective settings. Never queries Railway. */
export const buyerRailwaySettings = Object.freeze({
  schema: 'buyer-railway-sandbox-v1', buildCommand: 'pnpm check',
  preDeployCommand: 'node scripts/check-setup.mjs --profile merchant-sandbox',
  startCommand: 'pnpm start:merchant', healthcheckPath: '/api/health',
  replicas: 1, automaticSchemaChanges: false,
});
const identityFields = ['releaseCommit', 'projectId', 'environmentId', 'appServiceId', 'databaseServiceId'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function inspectBuyerRailwayPlan(plan, values, options = {}) {
  const failures = [];
  const object = plan && typeof plan === 'object' && !Array.isArray(plan);
  const allowed = [...Object.keys(buyerRailwaySettings), ...identityFields].sort();
  if (!object || Object.keys(plan).sort().join(',') !== allowed.join(',')) failures.push('PLAN_FIELDS_INVALID');
  for (const [key, expected] of Object.entries(buyerRailwaySettings)) {
    if (!object || plan[key] !== expected) failures.push('SETTING_' + key.toUpperCase() + '_MISMATCH');
  }
  if (!object || typeof plan.releaseCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(plan.releaseCommit)) failures.push('RELEASE_COMMIT_REQUIRED');
  for (const key of identityFields.slice(1)) if (!object || typeof plan[key] !== 'string' || !uuid.test(plan[key])) failures.push('TARGET_ID_INVALID');
  if (object && plan.appServiceId === plan.databaseServiceId) failures.push('APP_DATABASE_MUST_DIFFER');
  // Sandbox-first handoff must not carry a production enable gate or credential set.
  if (Object.entries(values).some(([key, value]) => key.startsWith('SQUARE_PRODUCTION_') && value !== undefined && value !== '' && !(key === 'SQUARE_PRODUCTION_PAYMENTS_ENABLED' && value === 'false'))) failures.push('PRODUCTION_SETTINGS_NOT_ALLOWED');
  if (Object.entries(values).some(([key, value]) => key.startsWith('BUYER_BOOTSTRAP_') && value !== undefined && value !== '')) failures.push('TEMPORARY_BOOTSTRAP_SETTINGS_REMAIN');
  const setup = inspectSetup(values, { profile: 'merchant-sandbox', fresh: true, ...(options.nodeVersion === undefined ? {} : { nodeVersion: options.nodeVersion }) });
  if (!setup.configurationValid) failures.push('STATIC_ENVIRONMENT_INVALID');
  return {
    validation: 'offline-operator-record-only', configurationValid: failures.length === 0,
    failures: [...new Set(failures)], setup,
    railwaySettingsVerified: false, targetOwnershipVerified: false, freshDeploymentVerified: false,
    backupRestoreVerified: false, productionReady: false, activationChanged: false,
  };
}
