import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { migrateSyntheticDatabase } from '../db/migrate';
import { checkoutAttempts, demoDatabaseState, inventoryReservations, mockPaymentLedger } from '../db/schema/checkout';
import { CheckoutError, type CheckoutRequest, type DemoReceipt, type CartItem } from '../shared/checkout';
import { DurableCheckoutService, PostgresCheckoutStore } from '../server/src/durable-checkout';
import { MockDecline } from '../server/src/mock-square';
import { createApp } from '../server/src/app';

async function worker(store: PostgresCheckoutStore, input: CheckoutRequest, fault?: string): Promise<DemoReceipt> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./helpers/durable-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; let settled = false;
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => { child.kill(); finish(new Error('Durable worker timed out')); }, 30000);
    function finish(error?: Error, result?: DemoReceipt) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    }
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => { if (!settled) finish(new Error(`intentional-worker-exit:${code} ${stderr}`)); });
    child.on('message', (raw: unknown) => {
      const message = raw as { kind: string; id: number; method: string; args: unknown[]; result: DemoReceipt; error?: { code: string; message: string } };
      if (message.kind === 'ready') child.send({ kind: 'start', input, fault });
      if (message.kind === 'database') {
        const methods = ['getCatalog', 'getSessionId', 'reserve', 'simulatePayment', 'finish', 'decline', 'uncertain'];
        if (!methods.includes(message.method)) { child.kill(); finish(new Error('Unknown test database operation')); return; }
        const method = (store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[message.method]!;
        void method.apply(store, message.args).then(
          (result) => { if (child.connected) child.send({ kind: 'database-result', id: message.id, result }); },
          (error: Error & { code?: string; status?: number }) => { if (child.connected) child.send({ kind: 'database-result', id: message.id, error: { message: error.message, code: error.code, status: error.status } }); },
        );
      }
      if (message.kind === 'complete') finish(message.error ? new CheckoutError(message.error.code as ConstructorParameters<typeof CheckoutError>[0], message.error.message) : undefined, message.result);
    });
  });
}

test('durable embedded PostgreSQL integration (single database owner, independent application processes)', async (t) => {
  const directory = join(await mkdtemp(join(tmpdir(), 'square-starter-durable-')), 'pgdata');
  let db = await PGlite.create(directory, { relaxedDurability: false });
  await migrateSyntheticDatabase(db);
  let store = new PostgresCheckoutStore(db);
  let service = new DurableCheckoutService(store);
  t.after(async () => { await db.close(); });
  const candle = { productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 };
  const granola = { productId: 'pantry-granola', variantId: 'granola-maple', quantity: 1 };
  async function request(items: readonly CartItem[] = [candle]): Promise<CheckoutRequest> {
    const quote = await service.quote({ items, currency: 'USD', fulfillment: 'pickup' });
    return { items, currency: 'USD', fulfillment: 'pickup', attemptId: randomUUID(), demoSessionId: quote.demoSessionId, expectedTotalMinor: quote.totalMinor };
  }
  async function count(table: 'checkout_attempts' | 'mock_payment_ledger') { return (await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0]!.count; }
  async function stock(id: string) { return (await db.query<{ stock_quantity: number }>('SELECT stock_quantity FROM catalog_variants WHERE id=$1', [id])).rows[0]!.stock_quantity; }
  async function reopen() {
    await db.close(); db = await PGlite.create(directory, { relaxedDurability: false });
    await migrateSyntheticDatabase(db); store = new PostgresCheckoutStore(db); service = new DurableCheckoutService(store);
  }

  await t.test('reviewed migration matches Drizzle columns, is repeatable, and enforces constraints', async () => {
    const before = await store.getSessionId(); await migrateSyntheticDatabase(db);
    assert.equal(await store.getSessionId(), before);
    assert.equal((await service.getCatalog()).products.length, 4);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM catalog_variants')).rows[0]!.count, 9);
    for (const table of [checkoutAttempts, demoDatabaseState, inventoryReservations, mockPaymentLedger]) {
      const config = getTableConfig(table);
      const actual = await db.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', ['public', config.name]);
      assert.deepEqual(actual.rows.map((column) => column.column_name).sort(), config.columns.map((column) => column.name).sort());
    }
    await assert.rejects(db.query('UPDATE catalog_variants SET stock_quantity=-1 WHERE id=$1', [candle.variantId]), /check constraint/);
    const migration = (await db.query<{ checksum: string }>("SELECT checksum FROM starter_schema_migrations WHERE id='0001_local_checkout'")).rows[0]!;
    await db.query("UPDATE starter_schema_migrations SET checksum='changed' WHERE id='0001_local_checkout'");
    await assert.rejects(migrateSyntheticDatabase(db), /checksum changed/);
    await db.query("UPDATE starter_schema_migrations SET checksum=$1 WHERE id='0001_local_checkout'", [migration.checksum]);
  });

  await t.test('validation and stale database prices roll back without attempts or effects', async () => {
    const input = await request(); const attempts = await count('checkout_attempts');
    for (const items of [[{ ...candle, quantity: 0 }], [{ ...candle, quantity: 8 }], [{ ...candle, variantId: 'unknown' }]]) await assert.rejects(service.checkout({ ...input, items }));
    await db.query('UPDATE catalog_variants SET price_minor=2500 WHERE id=$1', [candle.variantId]);
    await assert.rejects(service.checkout(input), (error: unknown) => error instanceof CheckoutError && error.code === 'PRICE_CHANGED');
    await db.query('UPDATE catalog_variants SET price_minor=2400 WHERE id=$1', [candle.variantId]);
    assert.equal(await count('checkout_attempts'), attempts); assert.equal(await count('mock_payment_ledger'), 0);
    assert.equal(await stock(candle.variantId), 7);
  });

  await t.test('receipt, session, reservation, and mock identity survive database close/reopen', async () => {
    const input = await request(); const first = await service.checkout(input);
    const session = await store.getSessionId(); await reopen();
    assert.equal(await store.getSessionId(), session);
    assert.deepEqual(await service.checkout(input), first);
    assert.equal(await count('mock_payment_ledger'), 1); assert.equal(await stock(candle.variantId), 6);
    assert.equal((await db.query<{ state: string }>('SELECT state FROM inventory_reservations WHERE attempt_id=$1', [input.attemptId])).rows[0]!.state, 'committed');
    await assert.rejects(service.checkout({ ...input, expectedTotalMinor: 1 }), (error: unknown) => error instanceof CheckoutError && error.code === 'IDEMPOTENCY_CONFLICT');
  });

  await t.test('actual worker exit after reservation leaves a recoverable durable attempt', async () => {
    const input = await request([granola]); const payments = await count('mock_payment_ledger'); const initialStock = await stock(granola.variantId);
    await assert.rejects(worker(store, input, 'after-reserve'), /intentional-worker-exit:41/);
    const reserved = (await db.query<{ checkout_id: string; state: string }>('SELECT checkout_id,state FROM checkout_attempts WHERE attempt_id=$1', [input.attemptId])).rows[0]!;
    assert.equal(reserved.state, 'reserved'); assert.equal(await count('mock_payment_ledger'), payments);
    await reopen(); const result = await service.checkout(input);
    assert.equal(result.checkoutId, reserved.checkout_id); assert.equal(await count('mock_payment_ledger'), payments + 1);
    assert.equal(await stock(granola.variantId), initialStock - 1);
  });

  await t.test('actual worker exit after durable mock effect recovers without another ledger entry', async () => {
    const input = await request([granola]); const payments = await count('mock_payment_ledger'); const initialStock = await stock(granola.variantId);
    await assert.rejects(worker(store, input, 'after-payment'), /intentional-worker-exit:42/);
    const ledger = (await db.query<{ payment_id: string }>('SELECT payment_id FROM mock_payment_ledger WHERE checkout_id=(SELECT checkout_id FROM checkout_attempts WHERE attempt_id=$1)', [input.attemptId])).rows[0]!;
    assert.equal(await count('mock_payment_ledger'), payments + 1);
    await reopen(); const receipt = await service.checkout(input);
    assert.equal(receipt.mockPaymentId, ledger.payment_id); assert.equal(await count('mock_payment_ledger'), payments + 1);
    assert.equal(await stock(granola.variantId), initialStock - 1);
  });

  await t.test('separate application processes share one attempt/effect/reservation for parallel retries', async () => {
    const input = await request([granola]); const payments = await count('mock_payment_ledger'); const initialStock = await stock(granola.variantId);
    const [a, b] = await Promise.all([worker(store, input), worker(store, input)]);
    assert.deepEqual(a, b); assert.equal(await count('mock_payment_ledger'), payments + 1);
    assert.equal(await stock(granola.variantId), initialStock - 1);
  });

  await t.test('separate application processes cannot both consume the last available item', async () => {
    const line = { productId: 'wick-trimmer', variantId: 'trimmer-brass', quantity: 1 };
    const a = await request([line]); const b = await request([line]); const payments = await count('mock_payment_ledger');
    const results = await Promise.allSettled([worker(store, a), worker(store, b)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(failure.reason.code, 'INSUFFICIENT_STOCK');
    assert.equal(await count('mock_payment_ledger'), payments + 1); assert.equal(await stock(line.variantId), 0);
  });

  await t.test('definite decline releases inventory exactly once, including across service reconstruction', async () => {
    const input = await request(); const initialStock = await stock(candle.variantId); const payments = await count('mock_payment_ledger');
    const declining = new DurableCheckoutService(store, { beforePayment: async () => { throw new MockDecline(); } });
    await assert.rejects(declining.checkout(input), (error: unknown) => error instanceof CheckoutError && error.code === 'MOCK_DECLINED');
    await store.decline(input.attemptId);
    await assert.rejects(new DurableCheckoutService(store).checkout(input), (error: unknown) => error instanceof CheckoutError && error.code === 'MOCK_DECLINED');
    assert.equal(await stock(candle.variantId), initialStock); assert.equal(await count('mock_payment_ledger'), payments);
  });

  await t.test('uncertain post-effect state retains stock, cannot be released, and reconciles one payment', async () => {
    const input = await request(); const initialStock = await stock(candle.variantId); const payments = await count('mock_payment_ledger');
    const interrupted = new DurableCheckoutService(store, { afterPayment: async () => { throw new Error('Interrupted response'); } });
    await assert.rejects(interrupted.checkout(input), (error: unknown) => error instanceof CheckoutError && error.code === 'CHECKOUT_UNCERTAIN');
    assert.equal(await store.decline(input.attemptId), false);
    assert.equal(await stock(candle.variantId), initialStock - 1);
    const result = await service.checkout(input);
    assert.equal(result.status, 'simulated'); assert.equal(result.fulfillmentAuthorized, false);
    assert.equal(await count('mock_payment_ledger'), payments + 1);
    assert.deepEqual(await service.checkout(input), result);
  });

  await t.test('durable HTTP backend replays the same saved request after database and API reconstruction', async () => {
    async function launch() {
      const app = await createApp({ load: () => service.getCatalog() }, { checkout: service, localDatabase: true });
      const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
      return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
    }
    const input = await request(); let running = await launch();
    const post = async () => {
      const response = await fetch(`${running.origin}/api/demo/checkouts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(response.status, 200); return response.json();
    };
    try {
      const first = await post(); const payments = await count('mock_payment_ledger');
      await running.close(); await reopen(); running = await launch();
      assert.deepEqual(await post(), first); assert.equal(await count('mock_payment_ledger'), payments);
      const health = await (await fetch(`${running.origin}/api/health`)).json();
      assert.equal(health.storage, 'embedded-postgres'); assert.equal(health.capabilities.databaseConnected, true);
      assert.equal(health.capabilities.checkout, false); assert.equal(health.capabilities.square, false);
    } finally { await running.close(); }
  });
});
