import assert from 'node:assert/strict';
import test from 'node:test';
import { buyerRailwaySettings, inspectBuyerRailwayPlan } from '../scripts/lib/buyer-railway-plan.mjs';
import { run } from '../scripts/check-buyer-railway-plan.mjs';
const values = () => ({ PUBLIC_ORIGIN: 'https://buyer.example.invalid', MERCHANT_DATABASE_URL: 'postgresql://fixture:fictional-password@postgres.railway.internal:5432/merchant', STARTER_DATASET: 'merchant-catalog-v1', STARTER_STORAGE: 'postgres', SQUARE_MERCHANT_COMMERCE_ENABLED: 'true', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-fictional', SQUARE_LOCATION_ID: 'FICTIONALLOCATION', SQUARE_SANDBOX_MERCHANT_ID: 'fictional-merchant', SQUARE_SANDBOX_ACCESS_TOKEN: 'fictional-sandbox-token', SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'fictional-signing-key', MERCHANT_ADMIN_SESSION_KEY: Buffer.alloc(32, 5).toString('base64url'), MERCHANT_NAME: 'Buyer test', MERCHANT_PICKUP_LABEL: 'Pickup desk', MERCHANT_PICKUP_INSTRUCTIONS: 'Bring your order reference.' });
const plan = () => ({ ...buyerRailwaySettings, releaseCommit: 'a'.repeat(40), projectId: '11111111-1111-4111-8111-111111111111', environmentId: '22222222-2222-4222-8222-222222222222', appServiceId: '33333333-3333-4333-8333-333333333333', databaseServiceId: '44444444-4444-4444-8444-444444444444' });
const check = (p = plan(), env = values()) => inspectBuyerRailwayPlan(p, env, { nodeVersion: '24.0.0' });

test('valid manual merchant settings pass offline comparison, never fresh-deploy or production proof', () => {
  const report = check(); assert.equal(report.configurationValid, true, JSON.stringify(report));
  assert.equal(report.validation, 'offline-operator-record-only');
  for (const field of ['railwaySettingsVerified','targetOwnershipVerified','freshDeploymentVerified','backupRestoreVerified','productionReady','activationChanged']) assert.equal(report[field], false);
});
test('synthetic start command, auto bootstrap hooks, health mistakes and multiple replicas fail closed', () => {
  for (const changed of [{ startCommand: 'pnpm start:railway' }, { buildCommand: 'pnpm build' }, { preDeployCommand: 'pnpm merchant:db:setup --initialize-empty' }, { preDeployCommand: 'node scripts/check-setup.mjs --profile merchant-production' }, { healthcheckPath: '/' }, { replicas: 2 }, { automaticSchemaChanges: true }]) assert.equal(check({ ...plan(), ...changed }).configurationValid, false);
});
test('target records require distinct service identities and full release SHA without arbitrary secret fields', () => {
  for (const changed of [{ releaseCommit: 'main' }, { projectId: 'paste project id' }, { appServiceId: plan().databaseServiceId }, { SQUARE_SANDBOX_ACCESS_TOKEN: 'do-not-print-this' }]) assert.equal(check({ ...plan(), ...changed }).configurationValid, false);
  assert.equal(check(null).configurationValid, false);
});
test('fresh merchant environment rejects synthetic storage, unresolved references and production values', () => {
  for (const changed of [{ STARTER_DATASET: 'synthetic-retail-v1' }, { STARTER_DB_BOOTSTRAP: 'empty-synthetic-only' }, { MERCHANT_DATABASE_URL: '${{Postgres.DATABASE_URL}}' }, { SQUARE_ENVIRONMENT: 'production' }, { SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'true' }, { SQUARE_PRODUCTION_ACCESS_TOKEN: 'unexpected-production-secret' }, { BUYER_BOOTSTRAP_MODE: 'manual-ssh-only-v1' }]) assert.equal(check(plan(), { ...values(), ...changed }).configurationValid, false);
  assert.equal(check(plan(), { ...values(), SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'false' }).configurationValid, true);
});
test('checker is offline, read-only and never includes recorded values or server secrets in reports', () => {
  const p = Object.freeze(plan()), env = Object.freeze(values()), before = JSON.stringify([p, env]);
  const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('Network forbidden'); };
  try {
    const text = JSON.stringify(check(p, env));
    for (const key of ['MERCHANT_DATABASE_URL','SQUARE_SANDBOX_ACCESS_TOKEN','SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY','MERCHANT_ADMIN_SESSION_KEY']) assert.ok(!text.includes(env[key]));
    assert.equal(JSON.stringify([p, env]), before);
  } finally { globalThis.fetch = previous; }
});
test('CLI validates exact arguments, bounded JSON and secret-safe failures', async () => {
  let output = ''; const write = text => { output += text; };
  assert.equal(await run(['--plan','private-file'], values(), write, async () => JSON.stringify(plan())), 0);
  assert.equal(JSON.parse(output).freshDeploymentVerified, false);
  for (const [args, raw] of [[['--plan','secret-path','--deploy'], '{}'], [['--plan','secret-path'], '{invalid-secret'], [['--plan','secret-path'], 'x'.repeat(17000)]]) {
    output = ''; assert.equal(await run(args, values(), write, async () => raw), 2); assert.doesNotMatch(output, /secret-path|invalid-secret/);
  }
});

test('documented administrator alias supplies the stdin flag exactly once', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['merchant:admin:provision'], 'tsx scripts/provision-merchant-admin.ts --password-stdin');
  for (const file of ['MERCHANT-COMMERCE-INSTALL.md','BUYER-RAILWAY-INSTALL.md']) {
    const guide = await readFile(new URL('../docs/' + file, import.meta.url), 'utf8');
    assert.match(guide, /\npnpm merchant:admin:provision\n/);
    assert.doesNotMatch(guide, /pnpm merchant:admin:provision --password-stdin/);
  }
});

test('temporary operator hold is target-bound, sandbox-only, offline and limited to one hour', async () => {
  const { inspectBootstrapHold, runHold } = await import('../scripts/merchant-bootstrap-hold.mjs');
  const now = Date.now();
  const env = { ...values(), BUYER_BOOTSTRAP_MODE: 'manual-ssh-only-v1', BUYER_BOOTSTRAP_PROJECT_ID: plan().projectId, RAILWAY_PROJECT_ID: plan().projectId, BUYER_BOOTSTRAP_ENVIRONMENT_ID: plan().environmentId, RAILWAY_ENVIRONMENT_ID: plan().environmentId, BUYER_BOOTSTRAP_SERVICE_ID: plan().appServiceId, RAILWAY_SERVICE_ID: plan().appServiceId, BUYER_BOOTSTRAP_EXPIRES_AT: new Date(now + 300000).toISOString() };
  assert.equal(inspectBootstrapHold(env, now).durationMs, 300000);
  assert.throws(() => inspectBootstrapHold(env, now + 300001), /BOOTSTRAP_EXPIRY_REQUIRED/); // Restart cannot reset the deadline.
  for (const changed of [{ BUYER_BOOTSTRAP_MODE: undefined }, { RAILWAY_SERVICE_ID: plan().databaseServiceId }, { BUYER_BOOTSTRAP_EXPIRES_AT: new Date(now - 1).toISOString() }, { BUYER_BOOTSTRAP_EXPIRES_AT: new Date(now + 3600001).toISOString() }, { SQUARE_ENVIRONMENT: 'production' }, { SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'true' }]) assert.throws(() => inspectBootstrapHold({ ...env, ...changed }, now));
  let callback, duration, exitCode, output = '';
  const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('No provider calls'); };
  try {
    runHold(env, { write: value => { output += value; }, schedule: (fn, ms) => { callback = fn; duration = ms; }, exit: code => { exitCode = code; } });
    assert.ok(duration > 0 && duration <= 300000); assert.equal(exitCode, undefined); callback(); assert.equal(exitCode, 0);
    assert.doesNotMatch(output, /fictional-password|fictional-sandbox-token/);
  } finally { globalThis.fetch = previous; }
});


test('buyer setup documents password policy, post-hold HTTPS cutover and current reference', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['MERCHANT-COMMERCE-INSTALL.md', 'BUYER-RAILWAY-INSTALL.md']) {
    const guide = await readFile(new URL('../docs/' + file, import.meta.url), 'utf8');
    assert.match(guide, /16–128 UTF-8 bytes, without ASCII control characters/);
  }
  const buyer = await readFile(new URL('../docs/BUYER-RAILWAY-INSTALL.md', import.meta.url), 'utf8');
  assert.match(buyer, /After switching to the normal serving runtime, attach or verify the separately approved public domain and HTTPS certificate; its origin must exactly match `PUBLIC_ORIGIN`/);
  assert.match(buyer, /Do not attach a public domain while the non-serving hold is active/);
  const checker = await readFile(new URL('../scripts/lib/template-setup.mjs', import.meta.url), 'utf8');
  assert.match(checker, /docs\/BUYER-RAILWAY-INSTALL\.md/);
  assert.doesNotMatch(checker, /935c10a|docs\/TEMPLATE-SETUP\.md/);
});


test('public Railway file cannot override explicit setup or merchant deployment profiles', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../railway.json', import.meta.url), 'utf8'));
  assert.deepEqual(config, { $schema: 'https://railway.com/railway.schema.json', build: { builder: 'RAILPACK', buildCommand: 'pnpm check' } });
  const buyer = await readFile(new URL('../docs/BUYER-RAILWAY-INSTALL.md', import.meta.url), 'utf8');
  assert.match(buyer, /New services cannot opt into deprecated/);
  assert.match(buyer, /`node scripts\/merchant-bootstrap-hold.mjs` \| `pnpm start:merchant`/);
  assert.match(buyer, /Healthcheck \| None \| `\/api\/health`/);
  assert.match(buyer, /Restart \| `NEVER` \| `ON_FAILURE`, maximum 3/);
  assert.match(buyer, /operator contract, not automatic provisioning/);
});
