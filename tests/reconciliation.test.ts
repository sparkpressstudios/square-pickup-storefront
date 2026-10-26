import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { migrateSyntheticDatabase } from '../db/migrate';
import { sandboxReconciliationJobs } from '../db/schema/reconciliation';
import { SandboxReconciliationQueue, SandboxReconciliationWorker } from '../server/src/reconciliation-jobs';
import { SandboxWebhookProjector, type SandboxWebhookConfig } from '../server/src/square-webhooks';
import { PostgresCheckoutStore } from '../server/src/durable-checkout';
import { createApp } from '../server/src/app';
import type { StaffPrincipal } from '../server/src/admin-catalog';
import { integrationOwnership, integrationStatus, setupMetadataReady } from '../shared/integration';
import { IntegrationDetails, SandboxSetupGuide } from '../client/src/integration-panel';

const config: SandboxWebhookConfig = { environment: 'sandbox', merchantId: 'TESTMERCHANT', locationId: 'TESTLOCATION01', signatureKey: 'synthetic-test-signature-key', notificationUrl: 'https://unit-test.invalid/square' };
const metadata = { environment: 'sandbox', applicationId: 'sandbox-sq0idb-synthetic-only', locationId: 'TESTLOCATION01' };
function event(eventId = randomUUID(), refund = false) {
  return Buffer.from(JSON.stringify({ event_id: eventId, merchant_id: config.merchantId, type: refund ? 'refund.updated' : 'payment.updated', data: { type: refund ? 'refund' : 'payment', id: refund ? 'REFUND_TEST' : 'PAYMENT_TEST', object: { [refund ? 'refund' : 'payment']: { id: refund ? 'REFUND_TEST' : 'PAYMENT_TEST', ...(refund ? { payment_id: 'PAYMENT_TEST' } : {}), order_id: 'ORDER_TEST', location_id: config.locationId, amount_money: { currency: 'USD', amount: refund ? 200 : 1000 }, status: 'COMPLETED', updated_at: '2026-10-20T12:00:00Z' } } } }));
}
const sign = (raw: Buffer) => createHmac('sha256', config.signatureKey).update(config.notificationUrl).update(raw).digest('base64');

test('non-secret setup accepts only sandbox public IDs, never credentials or production configuration', () => {
  assert.equal(setupMetadataReady(metadata), true);
  for (const input of [null, [], {}, { ...metadata, accessToken: 'do-not-accept' }, { ...metadata, environment: 'production' }, { ...metadata, applicationId: 'sq0idp-production-id' }, { ...metadata, locationId: 'bad location' }, { ...metadata, applicationId: 'sandbox-sq0idb-' + 'x'.repeat(150) }]) assert.equal(setupMetadataReady(input), false);
});
test('setup and connection views explicitly state unverified integration and source-of-truth rules', () => {
  const html = renderToStaticMarkup(createElement(IntegrationDetails, { status: integrationStatus(), canRetry: false }));
  const guide = renderToStaticMarkup(createElement(SandboxSetupGuide));
  assert.match(html, /Not connected/); assert.match(html, /never create payments/); assert.match(html, /never decrement or restock/);
  assert.match(html, /No customer sync implemented/); assert.match(guide, /does not save settings/); assert.match(guide, /Do not enter an access token/);
  assert.doesNotMatch(html + guide, /type="password"|SQUARE_SANDBOX_ACCESS_TOKEN|sq0idp-G2|sandbox-sq0idb-zl/);
  assert.equal(integrationOwnership.length, 5); assert.equal(integrationStatus().connected, false);
});
test('durable verified-event queue is bounded, restart-safe and isolated from orders/stock/provider calls', async (t) => {
  const directory = join(await mkdtemp(join(tmpdir(), 'square-reconcile-synthetic-')), 'pgdata');
  let db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db);
  let queue = new SandboxReconciliationQueue(db); let projector = new SandboxWebhookProjector(db, config);
  t.after(async () => { await db.close(); });
  t.beforeEach(async () => { await db.exec('TRUNCATE sandbox_reconciliation_jobs,sandbox_refund_projections,sandbox_payment_projections,sandbox_webhook_events'); });
  async function handle(raw = event()) { return projector.handle(raw, sign(raw)); }
  async function paymentExpectation(amount = 1000) {
    // Simulate the durable registration commit before its separate reconciliation call, including a crash at that boundary.
    await db.query('INSERT INTO sandbox_payment_projections(payment_id,checkout_id,merchant_id,location_id,order_id,amount_minor,currency) VALUES ($1,$2,$3,$4,$5,$6,$7)', ['PAYMENT_TEST', randomUUID(), config.merchantId, config.locationId, 'ORDER_TEST', amount, 'USD']);
  }
  async function due() { await db.exec("UPDATE sandbox_reconciliation_jobs SET available_at=now()-interval '1 second' WHERE state='retry'"); }
  async function expire() { await db.exec("UPDATE sandbox_reconciliation_jobs SET lease_until=now()-interval '1 second' WHERE state='running'"); }

  await t.test('appended schema matches Drizzle, backfills only verified pending events and preserves catalog/checksums', async () => {
    const declared = getTableConfig(sandboxReconciliationJobs);
    const columns = await db.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_name=$1', [declared.name]);
    assert.deepEqual(columns.rows.map((row) => row.column_name).sort(), declared.columns.map((column) => column.name).sort());
    const before = await new PostgresCheckoutStore(db).getCatalog();
    const checksums = await db.query("SELECT id,checksum FROM starter_schema_migrations WHERE id <> '0003_sandbox_reconciliation_jobs' ORDER BY id");
    await handle(); await db.exec("DROP TABLE sandbox_reconciliation_jobs; DELETE FROM starter_schema_migrations WHERE id='0003_sandbox_reconciliation_jobs'");
    await migrateSyntheticDatabase(db); await migrateSyntheticDatabase(db);
    assert.equal((await queue.summary()).counts.queued, 1);
    assert.deepEqual(await new PostgresCheckoutStore(db).getCatalog(), before);
    assert.deepEqual((await db.query("SELECT id,checksum FROM starter_schema_migrations WHERE id <> '0003_sandbox_reconciliation_jobs' ORDER BY id")).rows, checksums.rows);
    await assert.rejects(db.query('INSERT INTO sandbox_reconciliation_jobs(id,event_id) VALUES ($1,$2)', [randomUUID(), 'unverified-event']), /foreign key/);
  });
  await t.test('signature rejection creates no job; duplicate early deliveries enqueue exactly one job atomically', async () => {
    const raw = event(); await assert.rejects(projector.handle(raw, 'bad-signature'));
    assert.equal((await queue.summary()).recent.length, 0);
    assert.equal((await handle(raw)).outcome, 'pending'); await handle(raw); await handle(raw);
    const summary = await queue.summary(); assert.equal(summary.counts.queued, 1); assert.equal(summary.pendingEvents, 1); assert.equal(summary.unknownPayments, 1);
  });
  await t.test('parallel claims return one lease and fence a superseded/expired worker completion', async () => {
    await handle(); const leases = await Promise.all([queue.claim(), queue.claim()]);
    assert.equal(leases.filter(Boolean).length, 1); const old = leases.find(Boolean)!;
    await expire(); assert.equal(await queue.succeed(old), false); assert.equal((await queue.summary()).expiredLeases, 1);
    const current = (await queue.claim())!; assert.equal(current.id, old.id); assert.notEqual(current.leaseToken, old.leaseToken); assert.equal(current.attempts, 2);
    assert.equal(await queue.succeed(old), false); assert.equal(await queue.succeed({ ...current, attempts: 1 }), false);
    assert.equal(await queue.succeed(current), false); // A lease alone is not evidence of applied reconciliation.
    await paymentExpectation(); await projector.reconcilePending(current.paymentId);
    assert.equal(await queue.succeed(current), true); assert.equal(await queue.succeed(current), false);
  });
  await t.test('missing payment waits with backoff, stops after five tries, and needs explicit requeue', async () => {
    await handle(); const worker = new SandboxReconciliationWorker(queue, projector);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = Date.now(); assert.equal(await worker.runOne(), 'deferred');
      const summary = await queue.summary(); const job = summary.recent[0]!; assert.equal(job.attempts, attempt); assert.equal(job.failureCode, 'WAITING_FOR_PAYMENT');
      assert.equal(job.state, attempt === 5 ? 'attention' : 'retry');
      if (attempt < 5) { assert.ok(Date.parse(job.availableAt) >= before + 29_000); assert.equal(await worker.runOne(), 'idle'); await due(); }
    }
    assert.equal(await worker.runOne(), 'idle'); const job = (await queue.summary()).recent[0]!;
    await queue.retry(job.id); await assert.rejects(queue.retry(job.id), /Only a job/);
    assert.equal((await queue.summary()).recent[0]!.attempts, 0);
  });
  await t.test('expired final lease becomes attention rather than stuck running', async () => {
    await handle(); await db.exec('UPDATE sandbox_reconciliation_jobs SET attempts=4'); const lease = (await queue.claim())!; assert.equal(lease.attempts, 5);
    await expire(); assert.equal(await queue.claim(), null);
    const job = (await queue.summary()).recent[0]!; assert.equal(job.state, 'attention'); assert.equal(job.failureCode, 'ATTEMPTS_EXHAUSTED');
  });
  await t.test('transient database errors retry with redacted codes; unknown failures stop for attention', async () => {
    await handle(); await paymentExpectation();
    const worker = new SandboxReconciliationWorker(queue, { async reconcilePending() { throw Object.assign(new Error('sensitive-untrusted-error-payload'), { code: '40001' }); } });
    assert.equal(await worker.runOne(), 'deferred'); assert.equal((await queue.summary()).recent[0]!.failureCode, 'TRANSIENT_DATABASE');
    await due(); const unknown = new SandboxReconciliationWorker(queue, { async reconcilePending() { throw new Error('token=never-log-this'); } });
    assert.equal(await unknown.runOne(), 'deferred'); const summary = await queue.summary(); assert.equal(summary.recent[0]!.state, 'attention'); assert.equal(summary.recent[0]!.failureCode, 'UNEXPECTED_FAILURE');
    assert.doesNotMatch(JSON.stringify(summary), /sensitive|never-log|token=|leaseToken|signatureKey/);
  });
  await t.test('mismatched payment context is held for attention without changing money or inventory', async () => {
    await handle(); await paymentExpectation(2000);
    assert.equal(await new SandboxReconciliationWorker(queue, projector).runOne(), 'deferred');
    assert.equal((await queue.summary()).recent[0]!.failureCode, 'RECONCILIATION_CONFLICT'); assert.equal((await projector.projection('PAYMENT_TEST'))!.status, 'UNKNOWN');
  });
  await t.test('restart after committed refund projection safely replays without duplicate refund, order or stock effects', async () => {
    const before = await new PostgresCheckoutStore(db).getCatalog();
    const raw = event(randomUUID(), true); await handle(raw); await paymentExpectation(); const lost = (await queue.claim())!;
    await projector.reconcilePending(lost.paymentId); assert.equal((await projector.projection('PAYMENT_TEST'))!.refundedMinor, 200);
    await db.close(); db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db);
    queue = new SandboxReconciliationQueue(db); projector = new SandboxWebhookProjector(db, config); await expire();
    const originalFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('No provider calls permitted'); };
    try { assert.equal(await new SandboxReconciliationWorker(queue, projector).runOne(), 'succeeded'); } finally { globalThis.fetch = originalFetch; }
    assert.equal(calls, 0); assert.equal((await projector.projection('PAYMENT_TEST'))!.refundedMinor, 200);
    assert.equal((await projector.projection('PAYMENT_TEST'))!.fulfillmentAuthorized, false);
    assert.equal(await queue.succeed(lost), false); await handle(raw); assert.equal((await queue.summary()).counts.succeeded, 1);
    assert.deepEqual(await new PostgresCheckoutStore(db).getCatalog(), before);
    for (const table of ['checkout_attempts', 'mock_payment_ledger', 'inventory_reservations']) assert.equal((await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0]!.count, 0);
  });
  await t.test('staff status and retry endpoints enforce roles, CSRF and closed defaults without exposing event payloads', async () => {
    await handle(); await paymentExpectation(2000); await new SandboxReconciliationWorker(queue, projector).runOne();
    const jobId = (await queue.summary()).recent[0]!.id;
    let principal: StaffPrincipal | null = null; const token = 'synthetic-session-csrf-only';
    const app = await createApp(undefined, { admin: { verifyStaff: async () => principal, reconciliation: queue } });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const url = `${origin}/api/admin/integration`;
      const retry = (csrf = token) => fetch(`${url}/jobs/${jobId}/retry`, { method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': csrf, 'X-Role': 'admin' } });
      assert.equal((await fetch(url)).status, 401); assert.equal((await retry()).status, 401);
      principal = { id: 'synthetic-staff', role: 'staff', csrfToken: token }; assert.equal((await fetch(url)).status, 403);
      principal = { ...principal, role: 'manager' }; const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const status = await response.json(); assert.equal(status.connected, false); assert.equal(status.workerEnabled, false); assert.equal(status.reconciliation.counts.attention, 1);
      assert.doesNotMatch(JSON.stringify(status), /payload|merchantId|PAYMENT_TEST|signatureKey|lease_token/); assert.equal((await retry()).status, 403);
      principal = { ...principal, role: 'admin' }; assert.equal((await retry('wrong')).status, 403); assert.equal((await retry()).status, 200); assert.equal((await retry()).status, 409);
      const html = renderToStaticMarkup(createElement(IntegrationDetails, { status, canRetry: false })); assert.doesNotMatch(html, /Requeue once/);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
