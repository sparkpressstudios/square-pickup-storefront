import pg from 'pg';
import type { SqlDatabase, SqlExecutor } from './sql-database';
import { migrateSyntheticDatabase } from './migrate';

export interface NativePool {
  query(text: string, parameters?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<{ query(text: string, parameters?: unknown[]): Promise<{ rows: any[] }>; release(error?: Error): void }>;
}
/** Every transaction owns one checked-out backend connection until commit/rollback. */
export class NativeSqlDatabase implements SqlDatabase {
  constructor(private readonly pool: NativePool) {}
  async query<T = Record<string, unknown>>(text: string, parameters?: unknown[]) { return await this.pool.query(text, parameters) as { rows: T[] }; }
  async exec(text: string) { return this.pool.query(text); }
  async transaction<T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let discard: Error | undefined;
    const tx: SqlExecutor = { query: async <R = Record<string, unknown>>(text: string, parameters?: unknown[]) => await client.query(text, parameters) as { rows: R[] }, exec: (text) => client.query(text) };
    try { await client.query('BEGIN'); const result = await callback(tx); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch { discard = new Error('Transaction connection failed'); } throw error; }
    finally { client.release(discard); }
  }
}
export function validateNativeSettings(values: Readonly<Record<string, string | undefined>>) {
  if (values.STARTER_DATASET !== 'synthetic-retail-v1' || !values.DATABASE_URL) throw new Error('Explicit isolated synthetic PostgreSQL settings are required');
  let url: URL; try { url = new URL(values.DATABASE_URL); } catch { throw new Error('Invalid PostgreSQL configuration'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash || /urban|churn/i.test(url.hostname + url.pathname)) throw new Error('Refusing non-starter database configuration');
  // Never weaken TLS through URL options. Local loopback or Railway private networking may use plaintext.
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.railway.internal');
  if (url.search && !['?sslmode=require', '?sslmode=verify-full'].includes(url.search)) throw new Error('Unrecognized database URL options');
  if (!local && url.search !== '?sslmode=verify-full') throw new Error('Remote PostgreSQL requires verified TLS');
  return { connectionString: values.DATABASE_URL, bootstrap: values.STARTER_DB_BOOTSTRAP === 'empty-synthetic-only', ssl: !local ? { rejectUnauthorized: true } : undefined };
}
export async function assertSyntheticSchema(db: SqlDatabase, bootstrap: boolean) {
  const otherSchemas = await db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('public','information_schema') AND left(schema_name,3)<>'pg_'");
  const relations = (await db.query<{ table_name: string; table_type: string }>("SELECT table_name,table_type FROM information_schema.tables WHERE table_schema='public'")).rows;
  if (otherSchemas.rows.length || relations.some((row) => row.table_type !== 'BASE TABLE')) throw new Error('Refusing an unrecognized database schema');
  const names = relations.map((row) => row.table_name);
  if (!names.length) { if (!bootstrap) throw new Error('Empty database bootstrap requires explicit empty-synthetic-only acknowledgement'); return; }
  const allowed = new Set(['starter_schema_migrations','catalog_products','catalog_variants','demo_database_state','checkout_attempts','inventory_reservations','mock_payment_ledger','sandbox_payment_projections','sandbox_refund_projections','sandbox_webhook_events','sandbox_reconciliation_jobs','sandbox_checkout_attempts','sandbox_checkout_reservations','merchant_presentation']);
  if (!names.every((name) => allowed.has(name)) || !names.includes('demo_database_state')) throw new Error('Refusing an unrecognized database schema');
  const marker = (await db.query<{ dataset: string }>('SELECT dataset FROM demo_database_state WHERE singleton=true')).rows;
  if (marker.length !== 1 || marker[0]!.dataset !== 'synthetic-retail-v1') throw new Error('Refusing an unrecognized database marker');
}
/** Reads only explicit runtime input, never an env file or another project's connection configuration. */
export async function openNativeSyntheticDatabase(values: Readonly<Record<string, string | undefined>>) {
  const config = validateNativeSettings(values);
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, ssl: config.ssl, application_name: 'square-commerce-starter-sandbox' });
  pool.on('error', () => { /* Query/health paths report sanitized failure; never log credentials or SQL payloads. */ });
  const db = new NativeSqlDatabase(pool);
  try { await assertSyntheticSchema(db, config.bootstrap); await migrateSyntheticDatabase(db); }
  catch { await pool.end(); throw new Error('Isolated starter PostgreSQL startup/migration failed; verify access, marker and schema without logging credentials'); }
  return { db, close: () => pool.end() };
}
