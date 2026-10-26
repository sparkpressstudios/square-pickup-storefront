import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { migrateSyntheticDatabase } from '../db/migrate';
import { sandboxPaymentProjections, sandboxRefundProjections, sandboxWebhookEvents } from '../db/schema/sandbox-events';
import { SandboxWebhookProjector, sandboxWebhookRouter, verifySandboxWebhook, WebhookError, type SandboxWebhookConfig } from '../server/src/square-webhooks';

const config: SandboxWebhookConfig = { environment: 'sandbox', signatureKey: 'unit-test-only-webhook-key', notificationUrl: 'https://sandbox-callback.invalid/webhooks/square', merchantId: 'TESTMERCHANT', locationId: 'TESTLOCATION01' };
function sign(raw: Buffer, overrides: Partial<SandboxWebhookConfig> = {}) { const current = { ...config, ...overrides }; return createHmac('sha256', current.signatureKey).update(current.notificationUrl).update(raw).digest('base64'); }
function payload(kind: 'payment' | 'refund', options: { paymentId?: string; resourceId?: string; status?: string; amount?: number; time?: string; eventId?: string; merchant?: string; location?: string; currency?: string; orderId?: string } = {}) {
  const paymentId = options.paymentId ?? 'PAYMENT_A'; const resourceId = options.resourceId ?? (kind === 'payment' ? paymentId : 'REFUND_A');
  const resource = { id: resourceId, ...(kind === 'refund' ? { payment_id: paymentId } : {}), status: options.status ?? 'COMPLETED', amount_money: { amount: options.amount ?? (kind === 'payment' ? 3200 : 500), currency: options.currency ?? 'USD' }, updated_at: options.time ?? '2026-10-20T12:00:00.000Z', location_id: options.location ?? config.locationId, order_id: options.orderId ?? 'ORDER_A', note: 'do-not-store-this-field', card_details: { unneeded: 'do-not-store-card-fields' }, refunded_money: { amount: 500, currency: 'USD' } };
  return Buffer.from(JSON.stringify({ event_id: options.eventId ?? randomUUID(), merchant_id: options.merchant ?? config.merchantId, type: `${kind}.updated`, created_at: '2026-10-20T12:00:00.000Z', data: { type: kind, id: resourceId, object: { [kind]: resource } } }));
}

test('HMAC validates exact URL and raw bytes; wrong/missing signature/key/environment fail closed', () => {
  const raw = payload('payment'); const signature = sign(raw);
  assert.equal(verifySandboxWebhook(raw, signature, config), true);
  assert.equal(verifySandboxWebhook(Buffer.concat([raw, Buffer.from(' ')]), signature, config), false);
  assert.equal(verifySandboxWebhook(raw, signature, { ...config, notificationUrl: `${config.notificationUrl}/` }), false);
  assert.equal(verifySandboxWebhook(raw, signature, { ...config, signatureKey: 'different-unit-test-key' }), false);
  assert.equal(verifySandboxWebhook(raw, signature, { ...config, environment: 'production' } as unknown as SandboxWebhookConfig), false);
  for (const invalid of [undefined, '', 'not-base64', `${signature}\n`]) assert.equal(verifySandboxWebhook(raw, invalid, config), false);
  assert.equal(verifySandboxWebhook(raw, signature, { ...config, signatureKey: '' }), false);
});

test('durable sandbox webhook/refund projections use synthetic signed events only', async (t) => {
  const directory = join(await mkdtemp(join(tmpdir(), 'square-starter-events-')), 'pgdata');
  let db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db);
  let projector = new SandboxWebhookProjector(db, config);
  t.after(async () => { await db.close(); });
  const handle = (raw: Buffer) => projector.handle(raw, sign(raw));
  const count = async () => (await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM sandbox_webhook_events')).rows[0]!.count;

  await t.test('appended migration matches Drizzle columns and preserves initial synthetic seed', async () => {
    for (const table of [sandboxPaymentProjections, sandboxRefundProjections, sandboxWebhookEvents]) {
      const declared = getTableConfig(table);
      const actual = await db.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', ['public', declared.name]);
      assert.deepEqual(actual.rows.map((row) => row.column_name).sort(), declared.columns.map((column) => column.name).sort());
    }
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM catalog_products')).rows[0]!.count, 4);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM starter_schema_migrations')).rows[0]!.count, 6);
  });

  await t.test('unverified or malformed events cannot enter persistent state', async () => {
    const raw = payload('payment'); const before = await count();
    await assert.rejects(projector.handle(raw, ''), (error: unknown) => error instanceof WebhookError && error.code === 'SIGNATURE');
    await assert.rejects(projector.handle(Buffer.from('{'), sign(Buffer.from('{'))), (error: unknown) => error instanceof WebhookError && error.code === 'PAYLOAD');
    assert.equal(await count(), before);
    assert.throws(() => new SandboxWebhookProjector(db, { ...config, signatureKey: '' }), /configuration/);
  });

  await t.test('completed payment and duplicate partial refund count each refund once and preserve net amount', async () => {
    await projector.registerExpectedPayment({ paymentId: 'PAYMENT_A', checkoutId: randomUUID(), amountMinor: 3200, currency: 'USD', orderId: 'ORDER_A' });
    await handle(payload('payment')); const raw = payload('refund');
    assert.equal((await handle(raw)).outcome, 'applied'); assert.equal((await handle(raw)).outcome, 'duplicate');
    assert.deepEqual(await projector.projection('PAYMENT_A'), { paymentId: 'PAYMENT_A', status: 'COMPLETED', amountMinor: 3200, refundedMinor: 500, netMinor: 2700, classification: 'partially_refunded', fulfillmentAuthorized: false });
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM sandbox_refund_projections')).rows[0]!.count, 1);
  });

  await t.test('event-ID reuse with changed bytes is rejected and stored payload contains no raw card/contact fields', async () => {
    const eventId = randomUUID(); const raw = payload('refund', { eventId, resourceId: 'REFUND_PENDING', status: 'PENDING', amount: 200 });
    await handle(raw);
    await assert.rejects(handle(payload('refund', { eventId, resourceId: 'REFUND_PENDING', status: 'COMPLETED', amount: 200 })), (error: unknown) => error instanceof WebhookError && error.code === 'CONFLICT');
    const stored = await db.query<{ payload: unknown }>('SELECT payload FROM sandbox_webhook_events WHERE event_id=$1', [eventId]);
    assert.doesNotMatch(JSON.stringify(stored.rows[0]!.payload), /do-not-store|card_details|refunded_money|signatureKey/);
  });

  await t.test('pending refund completion increases aggregate once; newer/stale regressions cannot undo it', async () => {
    await handle(payload('refund', { resourceId: 'REFUND_PENDING', status: 'COMPLETED', amount: 200, time: '2026-10-20T12:01:00.000Z' }));
    assert.equal((await projector.projection('PAYMENT_A'))!.refundedMinor, 700);
    assert.equal((await handle(payload('refund', { resourceId: 'REFUND_PENDING', status: 'PENDING', amount: 200, time: '2026-10-20T12:02:00.000Z' }))).outcome, 'ignored');
    assert.equal((await handle(payload('payment', { status: 'APPROVED', time: '2026-10-20T11:00:00.000Z' }))).outcome, 'ignored');
    assert.equal((await handle(payload('payment', { status: 'PENDING', time: '2026-10-20T12:03:00.000Z' }))).outcome, 'ignored');
    assert.equal((await projector.projection('PAYMENT_A'))!.status, 'COMPLETED');
    assert.equal((await projector.projection('PAYMENT_A'))!.refundedMinor, 700);
  });

  await t.test('early unknown-payment refund is pending until registered, then reconciles out of order', async () => {
    const early = payload('refund', { paymentId: 'PAYMENT_B', resourceId: 'REFUND_B', amount: 100, orderId: 'RETURN_ORDER_B' });
    assert.equal((await handle(early)).outcome, 'pending');
    assert.equal(await projector.projection('PAYMENT_B'), null);
    await projector.registerExpectedPayment({ paymentId: 'PAYMENT_B', checkoutId: randomUUID(), amountMinor: 1000, currency: 'USD', orderId: 'ORDER_B' });
    assert.equal((await projector.projection('PAYMENT_B'))!.refundedMinor, 100);
    await handle(payload('payment', { paymentId: 'PAYMENT_B', amount: 1000, orderId: 'ORDER_B' }));
    assert.equal((await projector.projection('PAYMENT_B'))!.netMinor, 900);
    assert.equal((await handle(early)).outcome, 'duplicate');
  });

  await t.test('wrong merchant/location/currency, changed refund identity, and over-refunds leave state unchanged', async () => {
    const before = await projector.projection('PAYMENT_A'); const events = await count();
    for (const raw of [payload('refund', { merchant: 'OTHER_MERCHANT' }), payload('refund', { location: 'OTHERLOCATION' }), payload('refund', { currency: 'EUR' }), payload('refund', { amount: -1 }), payload('refund', { resourceId: 'REFUND_A', amount: 501 }), payload('refund', { resourceId: 'TOO_LARGE', amount: 3200 }), payload('payment', { amount: 1 }), payload('payment', { orderId: 'OTHER_ORDER' })]) await assert.rejects(handle(raw));
    assert.deepEqual(await projector.projection('PAYMENT_A'), before); assert.equal(await count(), events);
    await assert.rejects(projector.registerExpectedPayment({ paymentId: 'mock_forbidden', checkoutId: randomUUID(), amountMinor: 100, currency: 'USD' }));
  });

  await t.test('parallel projector instances deduplicate one event; distinct remaining refund reaches full refund once', async () => {
    const second = new SandboxWebhookProjector(db, config); const raw = payload('refund', { resourceId: 'REFUND_REMAINING', amount: 2500 });
    const results = await Promise.all([projector.handle(raw, sign(raw)), second.handle(raw, sign(raw))]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['applied','duplicate']);
    const result = await projector.projection('PAYMENT_A'); assert.equal(result!.refundedMinor, 3200); assert.equal(result!.netMinor, 0); assert.equal(result!.classification, 'refunded');
  });

  await t.test('database reopen preserves event deduplication and partial-refund projection', async () => {
    const raw = payload('payment', { paymentId: 'PAYMENT_B', amount: 1000, orderId: 'ORDER_B', time: '2026-10-20T12:04:00.000Z' });
    await handle(raw); const projection = await projector.projection('PAYMENT_B');
    await db.close(); db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db); projector = new SandboxWebhookProjector(db, config);
    assert.deepEqual(await projector.projection('PAYMENT_B'), projection); assert.equal((await handle(raw)).outcome, 'duplicate');
  });

  await t.test('opt-in router validates raw HTTP bytes; it does not parse/re-serialize before HMAC', async () => {
    const app = express(); app.use('/callback', sandboxWebhookRouter(projector)); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const raw = payload('payment', { paymentId: 'PAYMENT_B', amount: 1000, orderId: 'ORDER_B', time: '2026-10-20T12:05:00.000Z' });
    try {
      const response = await fetch(`${origin}/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': sign(raw) }, body: raw });
      assert.equal(response.status, 200);
      const changed = await fetch(`${origin}/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': sign(raw) }, body: `${raw.toString()} ` });
      assert.equal(changed.status, 403);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});


test('refund return-order identity may differ from purchase order while signed payment and refund bindings remain enforced', async t => {
  const db=await PGlite.create();t.after(()=>db.close());await migrateSyntheticDatabase(db);
  const projector=new SandboxWebhookProjector(db,config);
  const handle=(raw:Buffer)=>projector.handle(raw,sign(raw));
  await projector.registerExpectedPayment({paymentId:'PAYMENT_RETURN',checkoutId:randomUUID(),amountMinor:191,currency:'USD',orderId:'PURCHASE_ORDER'});
  await handle(payload('payment',{paymentId:'PAYMENT_RETURN',amount:191,orderId:'PURCHASE_ORDER'}));
  const refund={paymentId:'PAYMENT_RETURN',resourceId:'REFUND_RETURN',amount:191,orderId:'DISTINCT_RETURN_ORDER'};
  assert.equal((await handle(payload('refund',{...refund,status:'PENDING'}))).outcome,'applied');
  const completed=payload('refund',{...refund,status:'COMPLETED',time:'2026-10-20T12:01:00.000Z'});
  assert.equal((await handle(completed)).outcome,'applied');
  assert.equal((await handle(completed)).outcome,'duplicate');
  const expected=await projector.projection('PAYMENT_RETURN');
  assert.equal(expected!.refundedMinor,191);assert.equal(expected!.netMinor,0);assert.equal(expected!.classification,'refunded');
  await projector.registerExpectedPayment({paymentId:'OTHER_PAYMENT_RETURN',checkoutId:randomUUID(),amountMinor:191,currency:'USD',orderId:'OTHER_PURCHASE'});
  for(const raw of [
    payload('refund',{...refund,paymentId:'OTHER_PAYMENT_RETURN'}),
    payload('refund',{...refund,amount:190}),
    payload('refund',{...refund,resourceId:'OVER_REFUND',amount:1}),
    payload('refund',{...refund,merchant:'OTHER_MERCHANT'}),
    payload('refund',{...refund,location:'OTHER_LOCATION'}),
    payload('refund',{...refund,currency:'EUR'}),
    payload('payment',{paymentId:'PAYMENT_RETURN',amount:191,orderId:'DISTINCT_RETURN_ORDER'}),
  ])await assert.rejects(handle(raw));
  await assert.rejects(projector.handle(completed,'invalid-signature'));
  assert.deepEqual(await projector.projection('PAYMENT_RETURN'),expected);
  assert.equal((await db.query('SELECT * FROM sandbox_refund_projections')).rows.length,1);
});
