import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Request } from 'express';
import type { SqlDatabase } from '../db/sql-database';
import { initializeMerchantCommerce } from '../db/merchant-commerce';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';
import { createMerchantStaffAuth, provisionInitialMerchantAdmin, resetExistingMerchantAdmin, merchantSessionCookieName } from '../server/src/merchant-staff-auth';
import { readRecoveryPassword, runMerchantAdminRecovery } from '../scripts/recover-merchant-admin';
const values = { STARTER_DATASET: 'merchant-catalog-v1', PUBLIC_ORIGIN: 'https://merchant.example.invalid', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-recovery-test', SQUARE_LOCATION_ID: 'RECOVERYLOCATION', SQUARE_SANDBOX_MERCHANT_ID: 'RECOVERYMERCHANT', SQUARE_SANDBOX_ACCESS_TOKEN: 'unit-recovery-token-only', SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'unit-recovery-signature-only', MERCHANT_ADMIN_SESSION_KEY: randomBytes(32).toString('base64url') };
const oldPassword = 'Old unit-only passphrase 2026'; const newPassword = 'New unit-only passphrase 2026';
async function database() { const db = await PGlite.create(); await initializeEmptyMerchantCatalog(db, { squareMerchantId: values.SQUARE_SANDBOX_MERCHANT_ID, squareLocationId: values.SQUARE_LOCATION_ID }); return db; }
const request = (token: string) => ({ get(name: string) { return name === 'cookie' ? merchantSessionCookieName + '=' + token : undefined; } }) as Request;
test('explicit recovery changes strong verifier, resets lockout and atomically revokes every existing session', async t => {
  const db = await database(); t.after(() => db.close()); await provisionInitialMerchantAdmin(db, values, oldPassword); const auth = await createMerchantStaffAuth(db, values);
  const a = await auth.login(oldPassword), b = await auth.login(oldPassword); assert.ok(await auth.verifyStaff(request(a.token)));
  await db.query("UPDATE merchant_staff_accounts SET failed_attempts=5,locked_until=now()+interval '15 minutes'");
  const before = (await db.query<{ password_salt: string; password_digest: string }>('SELECT password_salt,password_digest FROM merchant_staff_accounts')).rows[0]!;
  await resetExistingMerchantAdmin(db, values, newPassword);
  const after = (await db.query<{ password_salt: string; password_digest: string; failed_attempts: number; locked_until: unknown }>('SELECT password_salt,password_digest,failed_attempts,locked_until FROM merchant_staff_accounts')).rows[0]!;
  assert.notEqual(after.password_salt, before.password_salt); assert.notEqual(after.password_digest, before.password_digest); assert.equal(after.failed_attempts, 0); assert.equal(after.locked_until, null);
  assert.equal(await auth.verifyStaff(request(a.token)), null); assert.equal(await auth.verifyStaff(request(b.token)), null); await assert.rejects(auth.login(oldPassword)); assert.ok((await auth.login(newPassword)).token);
});
test('wrong merchant, unknown schema, absent/disabled admin and weak password leave account state unchanged', async t => {
  const db = await database(); t.after(() => db.close()); await assert.rejects(resetExistingMerchantAdmin(db, values, newPassword)); await provisionInitialMerchantAdmin(db, values, oldPassword);
  const before = (await db.query('SELECT * FROM merchant_staff_accounts')).rows;
  await assert.rejects(resetExistingMerchantAdmin(db, { ...values, SQUARE_SANDBOX_MERCHANT_ID: 'FOREIGN' }, newPassword)); await assert.rejects(resetExistingMerchantAdmin(db, values, 'weak'));
  await db.exec('CREATE TABLE unrelated_business_data(id integer)'); await assert.rejects(resetExistingMerchantAdmin(db, values, newPassword)); await db.exec('DROP TABLE unrelated_business_data'); assert.deepEqual((await db.query('SELECT * FROM merchant_staff_accounts')).rows, before);
  await db.query('UPDATE merchant_staff_accounts SET disabled=true'); await assert.rejects(resetExistingMerchantAdmin(db, values, newPassword)); assert.equal((await db.query<{ disabled: boolean }>('SELECT disabled FROM merchant_staff_accounts')).rows[0]!.disabled, true);
});
test('session deletion failure rolls back password change and lockout reset', async t => {
  const db = await database(); t.after(() => db.close()); await provisionInitialMerchantAdmin(db, values, oldPassword); const auth = await createMerchantStaffAuth(db, values); const session = await auth.login(oldPassword);
  const before = (await db.query('SELECT * FROM merchant_staff_accounts')).rows;
  const failing: SqlDatabase = { query: (sql, parameters) => db.query(sql, parameters), exec: sql => db.exec(sql), transaction: callback => db.transaction(tx => callback({ exec: sql => tx.exec(sql), query: (sql, parameters) => { if (sql === 'DELETE FROM merchant_staff_sessions') throw new Error('Injected delete failure'); return tx.query(sql, parameters); } })) };
  await assert.rejects(resetExistingMerchantAdmin(failing, values, newPassword)); assert.deepEqual((await db.query('SELECT * FROM merchant_staff_accounts')).rows, before); assert.ok(await auth.verifyStaff(request(session.token)));
});
test('operator CLI accepts only explicit stdin, closes DB, never echoes secrets, and imports have no side effects', async t => {
  const db = await database(); t.after(() => db.close()); await provisionInitialMerchantAdmin(db, values, oldPassword); let reads = 0, opens = 0, closes = 0; const output: string[] = [];
  const deps = { async readPassword() { reads++; return newPassword; }, async open() { opens++; return { db, async close() { closes++; } }; }, write(text: string) { output.push(text); } };
  assert.equal(await runMerchantAdminRecovery(['--password', newPassword], values, deps), 2); assert.equal(reads, 0); assert.equal(opens, 0);
  assert.equal(await runMerchantAdminRecovery(['--password-stdin'], values, deps), 0); assert.equal(closes, 1); assert.doesNotMatch(output.join(''), /passphrase|unit-recovery-token|signature-only/);
  const read = (text: string) => (async function* () { yield Buffer.from(text); })();
  assert.equal(await readRecoveryPassword(read(newPassword + '\n'), false), newPassword); await assert.rejects(readRecoveryPassword(read(newPassword), true)); await assert.rejects(readRecoveryPassword(read('x'.repeat(133)), false));
});

test('production recovery requires the gated production identity and recognized environment/application/checksum binding', async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  const production = { ...values, SQUARE_ENVIRONMENT: 'production', SQUARE_MERCHANT_COMMERCE_ENABLED: 'true', SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'true', SQUARE_PRODUCTION_APPLICATION_ID: 'sq0idp-recovery-production-test', SQUARE_PRODUCTION_LOCATION_ID: 'PRODRECOVERYLOCATION', SQUARE_PRODUCTION_MERCHANT_ID: 'PRODRECOVERYMERCHANT', SQUARE_PRODUCTION_ACCESS_TOKEN: 'injected-production-recovery-token', SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY: 'injected-production-recovery-signature' };
  const scoped = { ...production, SQUARE_SANDBOX_MERCHANT_ID: production.SQUARE_PRODUCTION_MERCHANT_ID, SQUARE_LOCATION_ID: production.SQUARE_PRODUCTION_LOCATION_ID };
  await initializeEmptyMerchantCatalog(db, { squareMerchantId: production.SQUARE_PRODUCTION_MERCHANT_ID, squareLocationId: production.SQUARE_PRODUCTION_LOCATION_ID }); await initializeMerchantCommerce(db, scoped); await provisionInitialMerchantAdmin(db, scoped, oldPassword);
  await resetExistingMerchantAdmin(db, production, newPassword); const auth = await createMerchantStaffAuth(db, { ...production, SQUARE_SANDBOX_MERCHANT_ID: undefined, SQUARE_LOCATION_ID: undefined, SQUARE_SANDBOX_ACCESS_TOKEN: undefined, SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: undefined }); assert.ok((await auth.login(newPassword)).token);
  const before = (await db.query('SELECT password_salt,password_digest FROM merchant_staff_accounts')).rows;
  await assert.rejects(resetExistingMerchantAdmin(db, { ...production, SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'false' }, oldPassword));
  await assert.rejects(resetExistingMerchantAdmin(db, { ...production, SQUARE_PRODUCTION_APPLICATION_ID: 'sq0idp-other-application' }, oldPassword));
  await assert.rejects(resetExistingMerchantAdmin(db, { ...scoped, SQUARE_ENVIRONMENT: 'sandbox' }, oldPassword));
  await db.query("UPDATE merchant_commerce_config SET checksum='invalid-checksum'"); await assert.rejects(resetExistingMerchantAdmin(db, production, oldPassword));
  assert.deepEqual((await db.query('SELECT password_salt,password_digest FROM merchant_staff_accounts')).rows, before);
});
