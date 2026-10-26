import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { SqlDatabase, SqlExecutor } from '../../db/sql-database';
import type { StaffVerifier } from './admin-catalog';
import { publicOrigin } from './origin';
import { merchantPaymentConfiguration } from './merchant-payment-config';

const adminId = 'merchant-admin';
const sessionHours = 8;
const lockMinutes = 15;
const maxFailures = 5;
const cookieName = '__Host-merchant_session';
const passwordBytesMin = 16;
const passwordBytesMax = 128;
const parameters = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const hash = (input: string): string => createHash('sha256').update(input).digest('hex');
const normalPassword = (value: unknown): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= passwordBytesMin &&
  Buffer.byteLength(value, 'utf8') <= passwordBytesMax && !/[\x00-\x1f\x7f]/.test(value);
async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'base64url'), 32, parameters, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}
function validKey(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const key = Buffer.from(value, 'base64url');
  return key.length === 32 && key.toString('base64url') === value ? key : null;
}
function sessionToken(request: Request): string | null {
  const cookies = request.get('cookie');
  if (!cookies || cookies.length > 4096) return null;
  const found = cookies.split(';').map(item => item.trim()).filter(item => item.startsWith(cookieName + '='));
  if (found.length !== 1) return null;
  const value = found[0]!.slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
async function requireMerchant(tx: SqlExecutor, identity: { merchantId: string; locationId: string }, lock = false) {
  let result: { rows: { dataset: string; square_merchant_id: string; square_location_id: string; checkout_enabled: boolean }[] };
  try {
    result = await tx.query('SELECT dataset,square_merchant_id,square_location_id,checkout_enabled FROM merchant_catalog_identity WHERE singleton=true' +
      (lock ? ' FOR UPDATE' : ''));
  } catch { throw new MerchantAuthError('MERCHANT_SCOPE_REJECTED'); }
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.dataset !== 'merchant-catalog-v1' ||
      row.square_merchant_id !== identity.merchantId ||
      row.square_location_id !== identity.locationId || row.checkout_enabled !== false)
    throw new MerchantAuthError('MERCHANT_SCOPE_REJECTED');
}
export class MerchantAuthError extends Error {
  constructor(readonly code: 'AUTH_NOT_CONFIGURED' | 'MERCHANT_SCOPE_REJECTED' |
    'INVALID_PASSWORD_POLICY' | 'ALREADY_PROVISIONED' | 'INVALID_CREDENTIALS' |
    'LOGIN_RATE_LIMITED' | 'NOT_AUTHORIZED') { super(code); }
}
export interface MerchantStaffAuth {
  readonly origin: string;
  readonly verifyStaff: StaffVerifier;
  login(password: string): Promise<{ token: string; expiresSeconds: number }>;
  logout(request: Request): Promise<void>;
}
export interface MerchantStaffAuthSettings {
  readonly SQUARE_ENVIRONMENT?: string;
  readonly SQUARE_PRODUCTION_PAYMENTS_ENABLED?: string;
  readonly SQUARE_PRODUCTION_APPLICATION_ID?: string;
  readonly SQUARE_PRODUCTION_LOCATION_ID?: string;
  readonly SQUARE_PRODUCTION_MERCHANT_ID?: string;
  readonly SQUARE_PRODUCTION_ACCESS_TOKEN?: string;
  readonly SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY?: string;
  readonly SQUARE_SANDBOX_ACCESS_TOKEN?: string;
  readonly SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY?: string;
  readonly STARTER_DATASET?: string;
  readonly PUBLIC_ORIGIN?: string;
  readonly SQUARE_SANDBOX_MERCHANT_ID?: string;
  readonly SQUARE_LOCATION_ID?: string;
  readonly MERCHANT_ADMIN_SESSION_KEY?: string;
}
function merchantScope(values: MerchantStaffAuthSettings) {
  if (values.STARTER_DATASET !== 'merchant-catalog-v1') throw new MerchantAuthError('AUTH_NOT_CONFIGURED');
  let identity: { merchantId: string; locationId: string };
  if (values.SQUARE_ENVIRONMENT === 'production') {
    try { const config = merchantPaymentConfiguration({ ...values }); identity = { merchantId: config.merchantId, locationId: config.locationId }; }
    catch { throw new MerchantAuthError('AUTH_NOT_CONFIGURED'); }
  } else {
    if (values.SQUARE_ENVIRONMENT !== undefined && values.SQUARE_ENVIRONMENT !== 'sandbox') throw new MerchantAuthError('AUTH_NOT_CONFIGURED');
    if (!/^[A-Za-z0-9_-]{1,192}$/.test(values.SQUARE_SANDBOX_MERCHANT_ID || '') || !/^[A-Za-z0-9]{1,64}$/.test(values.SQUARE_LOCATION_ID || '')) throw new MerchantAuthError('AUTH_NOT_CONFIGURED');
    identity = { merchantId: values.SQUARE_SANDBOX_MERCHANT_ID!, locationId: values.SQUARE_LOCATION_ID! };
  }
  let origin: string; try { origin = publicOrigin(values.PUBLIC_ORIGIN || '', true); } catch { throw new MerchantAuthError('AUTH_NOT_CONFIGURED'); }
  return { identity, origin };
}
/** Only an explicitly authorized new merchant provisioning operation may create this first account.
 * Never reads a password from a variable or starts on the web server's startup path.
 */
export async function provisionInitialMerchantAdmin(db: SqlDatabase,
  values: MerchantStaffAuthSettings, password: string): Promise<void> {
  const { identity } = merchantScope(values);
  if (!normalPassword(password)) throw new MerchantAuthError('INVALID_PASSWORD_POLICY');
  const salt = randomBytes(16).toString('base64url');
  const encoded = (await derive(password, salt)).toString('base64url');
  await db.transaction(async tx => {
    await requireMerchant(tx, identity, true);
    const current = await tx.query<{ count: number }>('SELECT count(*)::integer AS count FROM merchant_staff_accounts');
    if (current.rows[0]?.count !== 0) throw new MerchantAuthError('ALREADY_PROVISIONED');
    await tx.query("INSERT INTO merchant_staff_accounts(id,role,password_salt,password_digest) VALUES ($1,'admin',$2,$3)",
      [adminId, salt, encoded]);
  });
}
/** Dependency-injected merchant-only auth; synthetic starter never constructs this. */
export async function createMerchantStaffAuth(db: SqlDatabase, values: MerchantStaffAuthSettings): Promise<MerchantStaffAuth> {
  const { identity, origin } = merchantScope(values);
  const key = validKey(values.MERCHANT_ADMIN_SESSION_KEY);
  if (!key || !db || typeof db.transaction !== 'function') throw new MerchantAuthError('AUTH_NOT_CONFIGURED');
  await db.transaction(async tx => {
    await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await requireMerchant(tx, identity);
    try { await tx.query('SELECT id FROM merchant_staff_accounts LIMIT 0'); await tx.query('SELECT token_hash FROM merchant_staff_sessions LIMIT 0'); }
    catch { throw new MerchantAuthError('MERCHANT_SCOPE_REJECTED'); }
  });
  const csrfFor = (token: string) => createHmac('sha256', key).update('merchant-csrf-v1:').update(token).digest('base64url');
  const verifyStaff: StaffVerifier = async request => {
    const token = sessionToken(request);
    if (!token) return null;
    const result = await db.query<{ id: string; role: string }>(
      'SELECT a.id,a.role FROM merchant_staff_sessions s JOIN merchant_staff_accounts a ON a.id=s.staff_id ' +
      'WHERE s.token_hash=$1 AND s.expires_at>now() AND a.disabled=false LIMIT 1', [hash(token)]);
    const user = result.rows[0];
    if (user?.id !== adminId || user.role !== 'admin') return null;
    return { id: user.id, role: 'admin', csrfToken: csrfFor(token) };
  };
  return {
    origin, verifyStaff,
    async login(password): Promise<{ token: string; expiresSeconds: number }> {
      if (typeof password !== 'string' || Buffer.byteLength(password,'utf8') > passwordBytesMax)
        throw new MerchantAuthError('INVALID_CREDENTIALS');
      const outcome = await db.transaction(async tx => {
        await requireMerchant(tx, identity, true);
        const users = await tx.query<{
          id: string; password_salt: string; password_digest: string;
          disabled: boolean; failed_attempts: number; locked: boolean;
        }>("SELECT id,password_salt,password_digest,disabled,failed_attempts, " +
           "(locked_until IS NOT NULL AND locked_until>now()) AS locked " +
           "FROM merchant_staff_accounts WHERE id=$1 FOR UPDATE", [adminId]);
        const user = users.rows[0];
        if (!user || user.disabled) return { kind: 'invalid' } as const;
        if (user.locked) return { kind: 'limited' } as const;
        let match = false;
        if (normalPassword(password)) {
          try {
            const derived = await derive(password,user.password_salt);
            const stored = Buffer.from(user.password_digest,'base64url');
            match = stored.length === derived.length && timingSafeEqual(stored,derived);
          } catch { match = false; }
        }
        if (!match) {
          await tx.query("UPDATE merchant_staff_accounts SET failed_attempts=LEAST(5,failed_attempts+1)," +
              " locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE null END WHERE id=$1",
            [adminId]);
          return { kind: 'invalid' } as const;
        }
        const token = randomBytes(32).toString('base64url');
        await tx.query('UPDATE merchant_staff_accounts SET failed_attempts=0,locked_until=null WHERE id=$1',[adminId]);
        await tx.query('DELETE FROM merchant_staff_sessions WHERE expires_at<=now()');
        const active = await tx.query<{ token_hash: string }>(
          'SELECT token_hash FROM merchant_staff_sessions WHERE staff_id=$1 ORDER BY created_at ASC,token_hash ASC', [adminId]);
        for (const entry of active.rows.slice(0,Math.max(0,active.rows.length - 4)))
          await tx.query('DELETE FROM merchant_staff_sessions WHERE token_hash=$1',[entry.token_hash]);
        await tx.query("INSERT INTO merchant_staff_sessions(token_hash,staff_id,expires_at) VALUES ($1,$2,now()+interval '8 hours')",
          [hash(token),adminId]);
        return { kind: 'success', token } as const;
      });
      if (outcome.kind === 'limited') throw new MerchantAuthError('LOGIN_RATE_LIMITED');
      if (outcome.kind !== 'success') throw new MerchantAuthError('INVALID_CREDENTIALS');
      return { token: outcome.token, expiresSeconds: sessionHours * 3600 };
    },
    async logout(request): Promise<void> {
      const token = sessionToken(request);
      if (!token || !await verifyStaff(request)) throw new MerchantAuthError('NOT_AUTHORIZED');
      await db.query('DELETE FROM merchant_staff_sessions WHERE token_hash=$1',[hash(token)]);
    },
  };
}
export const merchantSessionCookieName = cookieName;
export const merchantPasswordPolicy = { minBytes: passwordBytesMin, maxBytes: passwordBytesMax, lockMinutes, maxFailures, sessionHours } as const;


/** Explicit owner-authorized operator recovery only. Never mount as an HTTP route or call
 * from startup. It resets ONE existing administrator and atomically invalidates every session.
 * Disabled accounts require a separate deliberate enablement decision and are not reactivated.
 */
export async function resetExistingMerchantAdmin(db: SqlDatabase,
  values: Readonly<Record<string, string | undefined>>, password: string): Promise<void> {
  if (!normalPassword(password)) throw new MerchantAuthError('INVALID_PASSWORD_POLICY');
  const { assertMerchantDatabaseSchema } = await import('../../db/native-merchant-database');
  const { assertMerchantCommerce } = await import('../../db/merchant-commerce');
  const config = merchantPaymentConfiguration(values);
  const { identity } = merchantScope(values);
  const salt = randomBytes(16).toString('base64url'); const encoded = (await derive(password, salt)).toString('base64url');
  await db.transaction(async tx => {
    await requireMerchant(tx, identity, true);
    const commerce = (await tx.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='merchant_commerce_config'")).rows.length === 1;
    await assertMerchantDatabaseSchema(tx as SqlDatabase, values, commerce);
    if (commerce) await assertMerchantCommerce(tx as SqlDatabase, values);
    else if (config.environment === 'production') throw new MerchantAuthError('MERCHANT_SCOPE_REJECTED');
    const accounts = await tx.query<{ id: string; role: string; disabled: boolean }>('SELECT id,role,disabled FROM merchant_staff_accounts ORDER BY id FOR UPDATE');
    if (accounts.rows.length !== 1 || accounts.rows[0]?.id !== adminId || accounts.rows[0].role !== 'admin' || accounts.rows[0].disabled)
      throw new MerchantAuthError('NOT_AUTHORIZED');
    await tx.query('UPDATE merchant_staff_accounts SET password_salt=$2,password_digest=$3,password_updated_at=now(),failed_attempts=0,locked_until=null WHERE id=$1', [adminId, salt, encoded]);
    await tx.query('DELETE FROM merchant_staff_sessions');
  });
}
