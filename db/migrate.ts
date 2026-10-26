import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { demoCatalog } from '../config/demo-catalog';
import type { SqlDatabase, SqlExecutor } from './sql-database';

async function seedSyntheticCatalog(tx: SqlExecutor): Promise<void> {
  for (const product of demoCatalog.products) {
    await tx.query('INSERT INTO catalog_products(id, name, description, category, options) VALUES ($1,$2,$3,$4,$5::jsonb)', [product.id, product.name, product.description, product.category, JSON.stringify(product.options)]);
    for (const variant of product.variants) {
      await tx.query('INSERT INTO catalog_variants(id, product_id, sku, selections, currency, price_minor, stock_quantity, enabled) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)', [variant.id, product.id, variant.sku, JSON.stringify(variant.selections), 'USD', variant.priceMinor, variant.stockQuantity, variant.enabled]);
    }
  }
  await tx.query("INSERT INTO demo_database_state(singleton, session_id, dataset) VALUES (true,$1,'synthetic-retail-v1')", [randomUUID()]);
}

export async function migrateSyntheticDatabase(db: SqlDatabase): Promise<void> {
  for (const id of ['0001_local_checkout', '0002_sandbox_events', '0003_sandbox_reconciliation_jobs', '0004_prepared_sandbox_checkout', '0005_sandbox_runtime', '0006_merchant_presentation']) {
    const source = await readFile(new URL(`./migrations/${id}.sql`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('square-starter-migration', 0))");
      await tx.exec('CREATE TABLE IF NOT EXISTS starter_schema_migrations (id text PRIMARY KEY, checksum text NOT NULL)');
      const previous = await tx.query<{ checksum: string }>('SELECT checksum FROM starter_schema_migrations WHERE id = $1', [id]);
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum) throw new Error('Applied migration checksum changed; refusing to continue');
        const marker = await tx.query<{ dataset: string }>('SELECT dataset FROM demo_database_state WHERE singleton = true');
        if (marker.rows[0]?.dataset !== 'synthetic-retail-v1') throw new Error('Not a recognized synthetic demo database');
        return;
      }
      // Refuse to adopt an unknown schema. Applied migration sources stay immutable.
      await tx.exec(source);
      if (id === '0001_local_checkout') await seedSyntheticCatalog(tx);
      await tx.query('INSERT INTO starter_schema_migrations(id, checksum) VALUES ($1,$2)', [id, checksum]);
    });
  }
}
