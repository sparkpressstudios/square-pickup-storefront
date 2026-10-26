import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NativeSqlDatabase } from '../db/native-database';
import { migrateSyntheticDatabase } from '../db/migrate';
import { PostgresCheckoutStore, DurableCheckoutService } from '../server/src/durable-checkout';
import { PreparedSandboxStore } from '../server/src/prepared-sandbox-store';
import { PreparedSandboxCheckout } from '../server/src/prepared-sandbox-checkout';
import { nativeAcceptanceSettings } from '../db/native-acceptance-settings';
import { PostgresMerchantSettings } from '../server/src/merchant-settings';
import { merchant } from '../config/merchant';

const target = process.env.STARTER_TEST_DATABASE_URL;
test('native PostgreSQL acceptance: distinct backend connections, last item and duplicate prepared retries', { skip: !target ? 'BLOCKED: no approved isolated native PostgreSQL URL provided' : false }, async () => {
  const settings = nativeAcceptanceSettings(process.env);
  const schema = `starter_acceptance_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: target, max: 1, connectionTimeoutMillis: 5000 });
  let pool: pg.Pool | undefined; let created = false;
  try {
    if (settings.requireSyntheticMarker) {
      const marker = await admin.query("SELECT dataset FROM public.demo_database_state WHERE singleton=true");
      assert.equal(marker.rows.length, 1); assert.equal(marker.rows[0].dataset, 'synthetic-retail-v1');
    }
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    pool = new pg.Pool({ connectionString: target, max: 8, connectionTimeoutMillis: 5000, options: `-c search_path=${schema}` });
    const db = new NativeSqlDatabase(pool); await migrateSyntheticDatabase(db);
    const settingsOne = new PostgresMerchantSettings(db, merchant);
    const settingsTwo = new PostgresMerchantSettings(new NativeSqlDatabase(pool), merchant);
    const current = await settingsOne.load();
    const settingsResults = await Promise.allSettled([settingsOne, settingsTwo].map((store, index) => store.update({ revision: current.revision, settings: { ...current.settings, name: `Fictional worker ${index}` } }, 'synthetic-native-admin')));
    assert.equal(settingsResults.filter(result => result.status === 'fulfilled').length, 1);
    const staleSettings = settingsResults.find(result => result.status === 'rejected');
    assert.equal(staleSettings?.status === 'rejected' ? staleSettings.reason.code : '', 'SETTINGS_CHANGED');
    console.log('Native evidence: competing store settings saves preserve one winner and reject stale overwrite');
    const savedSettings = await settingsOne.load();
    const reopenedPool = new pg.Pool({ connectionString: target, max: 1, connectionTimeoutMillis: 5000, options: `-c search_path=${schema}` });
    try {
      const reopenedSettings = new PostgresMerchantSettings(new NativeSqlDatabase(reopenedPool), merchant);
      assert.deepEqual(await reopenedSettings.load(), savedSettings);
      await migrateSyntheticDatabase(new NativeSqlDatabase(reopenedPool));
      assert.deepEqual(await reopenedSettings.load(), savedSettings);
      console.log('Native evidence: committed settings survive a fresh connection and migration re-execution');
    } finally { await reopenedPool.end(); }
    const a = await pool.connect(); const b = await pool.connect();
    try { const ids = await Promise.all([a.query('SELECT pg_backend_pid() AS id'), b.query('SELECT pg_backend_pid() AS id')]); assert.notEqual(ids[0]!.rows[0].id, ids[1]!.rows[0].id); console.log('Native evidence: two distinct PostgreSQL backends verified'); } finally { a.release(); b.release(); }
    const service = new DurableCheckoutService(new PostgresCheckoutStore(db)); const cart = { items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD' as const, fulfillment: 'pickup' as const };
    await db.query('UPDATE catalog_variants SET stock_quantity=1 WHERE id=$1', [cart.items[0]!.variantId]);
    const quote = await service.quote(cart); const request = { ...cart, attemptId: randomUUID(), demoSessionId: quote.demoSessionId, expectedTotalMinor: quote.totalMinor };
    const results = await Promise.allSettled([service.checkout(request), new DurableCheckoutService(new PostgresCheckoutStore(db)).checkout({ ...request, attemptId: randomUUID() })]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected'); assert.equal(rejected?.status === 'rejected' ? rejected.reason.code : undefined, 'INSUFFICIENT_STOCK');
    assert.equal((await db.query<{ stock_quantity: number }>('SELECT stock_quantity FROM catalog_variants WHERE id=$1', [cart.items[0]!.variantId])).rows[0]!.stock_quantity, 0);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM mock_payment_ledger')).rows[0]!.count, 1);
    console.log('Native evidence: one competing last-item checkout succeeded');
    await db.query('UPDATE catalog_variants SET stock_quantity=2 WHERE id=$1', [cart.items[0]!.variantId]);
    let calls = 0;
    const deps = { execution: 'injected-test-transport' as const, configuration: { environment: 'sandbox' as const, applicationId: 'sandbox-sq0idb-native-test', locationId: 'TESTLOCATION', accessToken: 'synthetic-native-test-only' }, transport: async (outbound: { url: string; body: string }) => {
      calls++; const body = JSON.parse(outbound.body); return outbound.url.endsWith('/orders') ? { status: 200, body: { order: { id: 'ORDER_NATIVE', ...body.order, total_money: { amount: 2400, currency: 'USD' } } } } : { status: 200, body: { payment: { id: 'PAYMENT_NATIVE', ...body, status: 'COMPLETED' } } };
    } };
    const next = { ...request, attemptId: randomUUID() };
    const one = new PreparedSandboxCheckout(new PreparedSandboxStore(db), deps); const two = new PreparedSandboxCheckout(new PreparedSandboxStore(new NativeSqlDatabase(pool)), deps);
    await Promise.all([one.submit(next, 'unit-card-token'), two.submit(next, 'unit-card-token')]); assert.equal((await one.prepare(next)).state, 'completed'); assert.equal(calls, 2);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM sandbox_checkout_attempts')).rows[0]!.count, 1);
    console.log('Native evidence: duplicate prepared retries produced one attempt and two mock order/payment dispatches');
  } catch (error) {
    const code = (error as { code?: string })?.code; if (code && /^[0-9A-Z]{5}$/.test(code)) throw new Error(`Native acceptance failed with SQLSTATE ${code}; connection details withheld`); throw error;
  } finally { await pool?.end(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
