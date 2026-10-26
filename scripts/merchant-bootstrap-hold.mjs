#!/usr/bin/env node
/** Owner-selected, expiring operator shell target. No listener, database, providers or bootstrap writes. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSetup } from './lib/template-setup.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function inspectBootstrapHold(values, now = Date.now()) {
  if (values.BUYER_BOOTSTRAP_MODE !== 'manual-ssh-only-v1') throw new Error('BOOTSTRAP_MODE_REQUIRED');
  for (const suffix of ['PROJECT_ID','ENVIRONMENT_ID','SERVICE_ID']) {
    const expected = values['BUYER_BOOTSTRAP_' + suffix];
    if (typeof expected !== 'string' || !uuid.test(expected) || expected !== values['RAILWAY_' + suffix]) throw new Error('BOOTSTRAP_TARGET_MISMATCH');
  }
  if (values.SQUARE_ENVIRONMENT !== 'sandbox' || (values.SQUARE_PRODUCTION_PAYMENTS_ENABLED && values.SQUARE_PRODUCTION_PAYMENTS_ENABLED !== 'false')) throw new Error('BOOTSTRAP_SANDBOX_REQUIRED');
  const expiry = values.BUYER_BOOTSTRAP_EXPIRES_AT ?? '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)) throw new Error('BOOTSTRAP_EXPIRY_REQUIRED');
  const expiresAt = Date.parse(expiry);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > 60 * 60 * 1000) throw new Error('BOOTSTRAP_EXPIRY_REQUIRED');
  if (!inspectSetup(values, { profile: 'merchant-sandbox', fresh: true }).configurationValid) throw new Error('BOOTSTRAP_CONFIGURATION_INVALID');
  return { expiresAt, durationMs: expiresAt - now };
}
export function runHold(values, { write = text => process.stdout.write(text), schedule = setTimeout, exit = code => { process.exitCode = code; } } = {}) {
  let durationMs;
  try { ({ durationMs } = inspectBootstrapHold(values)); }
  catch { write('Bootstrap hold refused. Check explicit sandbox target, expiry and static configuration; no values are printed.\n'); exit(1); return; }
  write('Manual SSH bootstrap hold active: no public listener, schema writes, provider requests or staff provisioning. Expires within one hour.\n');
  return schedule(() => { write('Manual SSH bootstrap hold expired. Restore the reviewed normal service settings before use.\n'); exit(0); }, durationMs);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { process.stderr.write('Bootstrap hold accepts no command arguments.\n'); process.exitCode = 1; }
  else runHold(process.env);
}
