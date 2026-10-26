import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { NativeSqlDatabase, assertSyntheticSchema, validateNativeSettings, type NativePool } from '../db/native-database';
import { migrateSyntheticDatabase } from '../db/migrate';
import { runtimeSettings } from '../server/src/runtime-settings';
import { publicOrigin } from '../server/src/origin';
import { createApp } from '../server/src/app';
import { createRuntimeSandbox, sandboxHttpTransport } from '../server/src/square-runtime';
import { demoCatalog } from '../config/demo-catalog';
import { nativeAcceptanceSettings } from '../db/native-acceptance-settings';

test('native acceptance keeps loopback guard and requires exact approved sandbox context for private Railway testing', () => {
  const local = { STARTER_NATIVE_TESTS: 'isolated-local', STARTER_TEST_DATABASE_URL: 'postgres://localhost/square_starter_test_unit' };
  assert.equal(nativeAcceptanceSettings(local).requireSyntheticMarker, false);
  const base = { STARTER_NATIVE_TESTS: 'isolated-railway', STARTER_TEST_DATABASE_URL: 'postgres://postgres.railway.internal/square_starter_test_unit', STARTER_DATASET: 'synthetic-retail-v1', SQUARE_SANDBOX_REQUESTS_ENABLED: 'false', RAILWAY_ENVIRONMENT_NAME: 'sandbox', STARTER_NATIVE_EXPECTED_PROJECT_ID: '11111111-1111-4111-8111-111111111111', RAILWAY_PROJECT_ID: '11111111-1111-4111-8111-111111111111', STARTER_NATIVE_EXPECTED_ENVIRONMENT_ID: '22222222-2222-4222-8222-222222222222', RAILWAY_ENVIRONMENT_ID: '22222222-2222-4222-8222-222222222222' };
  assert.equal(nativeAcceptanceSettings(base).requireSyntheticMarker, true);
  for (const changed of [{ RAILWAY_PROJECT_ID: 'another-project' }, { RAILWAY_ENVIRONMENT_ID: '' }, { RAILWAY_ENVIRONMENT_NAME: 'production' }, { SQUARE_SANDBOX_REQUESTS_ENABLED: 'true' }, { STARTER_TEST_DATABASE_URL: 'postgres://public.invalid/square_starter_test_unit' }, { STARTER_TEST_DATABASE_URL: 'postgres://postgres.railway.internal/railway' }]) assert.throws(() => nativeAcceptanceSettings({ ...base, ...changed }));
  assert.throws(() => nativeAcceptanceSettings({ ...local, STARTER_TEST_DATABASE_URL: 'invalid' }), /details withheld/);
});

test('Railway settings opt in to network binding/native storage and require canonical HTTPS; default is loopback', () => {
  assert.deepEqual(runtimeSettings({}, false), { port: 3000, host: '127.0.0.1', origin: undefined, native: false, sandbox: false });
  const railway = runtimeSettings({ PUBLIC_ORIGIN: 'https://starter.invalid', PORT: '8080' }, true); assert.equal(railway.host, '0.0.0.0'); assert.equal(railway.native, true); assert.equal(railway.port, 8080); assert.equal(railway.sandbox, false);
  for (const values of [{}, { PUBLIC_ORIGIN: 'http://localhost:3000' }, { PUBLIC_ORIGIN: 'https://starter.invalid/path' }, { PUBLIC_ORIGIN: 'https://name:password@starter.invalid' }, { PUBLIC_ORIGIN: 'https://starter.invalid', PORT: '0' }, { PUBLIC_ORIGIN: 'https://starter.invalid', SQUARE_ENVIRONMENT: 'production' }]) assert.throws(() => runtimeSettings(values, true));
  assert.equal(publicOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
});
test('native settings refuse implicit/production-looking databases, unsafe options and unverified remote TLS', () => {
  const base = { STARTER_DATASET: 'synthetic-retail-v1', DATABASE_URL: 'postgresql://localhost/square_starter_test_isolated' };
  assert.equal(validateNativeSettings(base).bootstrap, false);
  for (const values of [{ DATABASE_URL: base.DATABASE_URL }, { ...base, DATABASE_URL: 'postgres://localhost/UrbanChurn' }, { ...base, DATABASE_URL: 'https://db.invalid/data' }, { ...base, DATABASE_URL: 'postgres://remote.invalid/railway' }, { ...base, DATABASE_URL: 'postgres://remote.invalid/railway?sslmode=no-verify' }, { ...base, DATABASE_URL: base.DATABASE_URL + '?options=anything' }]) assert.throws(() => validateNativeSettings(values));
  assert.deepEqual(validateNativeSettings({ ...base, DATABASE_URL: 'postgres://remote.invalid/starter?sslmode=verify-full' }).ssl, { rejectUnauthorized: true });
  assert.equal(validateNativeSettings({ ...base, STARTER_DB_BOOTSTRAP: 'empty-synthetic-only' }).bootstrap, true);
});
test('native transaction wrapper owns a dedicated connection through commit or rollback and releases it', async () => {
  const calls: string[] = []; let client = 0;
  const pool: NativePool = { async query(sql) { calls.push(`pool:${sql}`); return { rows: [] }; }, async connect() { const id = ++client; return { async query(sql) { calls.push(`${id}:${sql}`); return { rows: [{ id }] }; }, release() { calls.push(`${id}:release`); } }; } };
  const db = new NativeSqlDatabase(pool);
  await db.transaction(async (tx) => { await tx.query('SELECT synthetic'); });
  await assert.rejects(db.transaction(async (tx) => { await tx.query('SELECT failure'); throw new Error('synthetic-failure'); }));
  assert.deepEqual(calls, ['1:BEGIN','1:SELECT synthetic','1:COMMIT','1:release','2:BEGIN','2:SELECT failure','2:ROLLBACK','2:release']);
});
test('native schema adoption requires empty-database acknowledgement or the exact existing starter marker', async () => {
  const db = await PGlite.create(); try {
    await assert.rejects(assertSyntheticSchema(db, false)); await assertSyntheticSchema(db, true);
    await migrateSyntheticDatabase(db); await assertSyntheticSchema(db, false);
    await db.exec('CREATE TABLE unrelated_private_data(id integer)'); await assert.rejects(assertSyntheticSchema(db, true), /unrecognized database schema/);
  } finally { await db.close(); }
});
test('HTTPS origin works behind a proxy without trusting forwarded/host headers; health errors are sanitized', async () => {
  let healthy = true;
  const app = await createApp(undefined, { origin: 'https://starter.invalid', healthcheck: async () => { if (!healthy) throw new Error('private database details'); } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const body = JSON.stringify({ items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD', fulfillment: 'pickup' });
    const good = await fetch(`${base}/api/demo/quote`, { method: 'POST', headers: { Origin: 'https://starter.invalid', 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'evil.invalid' }, body }); assert.equal(good.status, 200);
    for (const origin of ['https://evil.invalid', base, 'null', '']) assert.equal((await fetch(`${base}/api/demo/quote`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/session`)).status, 401); healthy = false; const response = await fetch(`${base}/api/health`); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private|database/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test('sandbox runtime requires explicit sandbox gate, HTTPS, merchant and signing configuration', async () => {
  const db = await PGlite.create(); try {
    const base = { SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', STARTER_DATASET: 'synthetic-retail-v1', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-test', SQUARE_LOCATION_ID: 'TESTLOCATION', SQUARE_SANDBOX_ACCESS_TOKEN: 'synthetic-unit-token-only', SQUARE_SANDBOX_MERCHANT_ID: 'TESTMERCHANT', SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'synthetic-signature-only' };
    assert.throws(() => createRuntimeSandbox(db, { ...base, SQUARE_SANDBOX_REQUESTS_ENABLED: 'false' }, 'https://starter.invalid'));
    assert.throws(() => createRuntimeSandbox(db, { ...base, SQUARE_ENVIRONMENT: 'production' }, 'https://starter.invalid'));
    assert.throws(() => createRuntimeSandbox(db, { ...base, SQUARE_SANDBOX_ACCESS_TOKEN: '' }, 'https://starter.invalid'));
    assert.throws(() => createRuntimeSandbox(db, base, 'http://localhost:3000'));
    assert.throws(() => createRuntimeSandbox(db, { ...base, SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: '' }, 'https://starter.invalid'));
  } finally { await db.close(); }
});
test('verified staff writes use configured HTTPS origin plus session CSRF behind TLS termination', async () => {
  let writes = 0; const token = 'synthetic-csrf-session-only';
  const app = await createApp(undefined, { origin: 'https://starter.invalid', admin: { verifyStaff: async () => ({ id: 'synthetic-admin', role: 'admin', csrfToken: token }), store: { load: async () => demoCatalog, update: async () => { writes++; return { product: demoCatalog.products[0]!, revision: '0'.repeat(64) }; } } } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/products/studio-candle`;
  try {
    const headers = { Origin: 'https://starter.invalid', 'X-CSRF-Token': token, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'http' };
    assert.equal((await fetch(url, { method: 'PUT', headers, body: '{}' })).status, 200);
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...headers, Origin: 'https://evil.invalid', 'X-Forwarded-Proto': 'https' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'PUT', headers: { ...headers, 'X-CSRF-Token': '' }, body: '{}' })).status, 403); assert.equal(writes, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test('real transport restricts origin/path/method/redirects and bounds responses without calling the network', async () => {
  let calls = 0;
  const transport = sandboxHttpTransport(async (_input, init) => { calls++; assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); return new Response(JSON.stringify({ test: true }), { status: 200 }); });
  const request = { method: 'POST' as const, url: 'https://connect.squareupsandbox.com/v2/orders', redirect: 'error' as const, headers: {}, body: '{}' };
  assert.deepEqual(await transport(request), { status: 200, body: { test: true } });
  for (const url of ['https://connect.squareup.com/v2/orders','https://evil.invalid/v2/orders','https://connect.squareupsandbox.com/v2/refunds','https://connect.squareupsandbox.com/v2/orders?other=1']) await assert.rejects(transport({ ...request, url }));
  assert.equal(calls, 1);
  await assert.rejects(sandboxHttpTransport(async () => new Response('{}', { headers: { 'content-length': '300000' } }))(request), /too large/);
});
test('Railway packaging has a bounded healthcheck, scoped start command and production runtime dependencies', async () => {
  const railway = JSON.parse(await readFile(new URL('../railway.json', import.meta.url), 'utf8')); const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(railway.deploy.startCommand, 'pnpm start:railway'); assert.equal(railway.deploy.healthcheckPath, '/api/health'); assert.equal(railway.deploy.restartPolicyMaxRetries, 3);
  assert.equal(manifest.dependencies.pg, '8.23.1'); assert.equal(manifest.dependencies.tsx, '4.23.15'); assert.equal(manifest.private, true);
});
