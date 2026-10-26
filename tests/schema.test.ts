import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { products, variants } from '../db/schema/catalog';
import { demoCatalog } from '../config/demo-catalog';
import { postgresCatalogRepository } from '../server/src/catalog-repository';

test('PostgreSQL declaration constrains USD, nonnegative prices/stock, unique variants, and ownership', () => {
  const table = getTableConfig(variants);
  assert.equal(table.name, 'catalog_variants');
  assert.equal(table.foreignKeys.length, 1);
  assert.equal(table.indexes[0]!.config.unique, true);
  assert.deepEqual(table.checks.map((check) => check.name).sort(), ['catalog_variant_price', 'catalog_variant_stock', 'catalog_variant_usd']);
  const dialect = new PgDialect();
  const checks = table.checks.map((check) => dialect.sqlToQuery(check.value).sql).join('\n');
  assert.match(checks, /currency.*= 'USD'/);
  assert.match(checks, /price_minor.*>= 0/);
  assert.match(checks, /stock_quantity.*>= 0/);
  assert.equal(getTableConfig(products).name, 'catalog_products');
});

test('injected Postgres reader maps generic products inside a read-only repeatable snapshot', async () => {
  let transactionOptions: unknown;
  const productRows = demoCatalog.products.map(({ variants: _variants, ...product }) => product);
  const variantRows = demoCatalog.products.flatMap((product) => product.variants.map((variant) => ({ ...variant, productId: product.id, currency: 'USD' })));
  const fakeDb = {
    async transaction(callback: (tx: unknown) => Promise<unknown>, options: unknown) {
      transactionOptions = options;
      return callback({ select() { return { from(table: unknown) { return { async orderBy() { return table === products ? productRows : variantRows; } }; } }; } });
    },
  };
  const repository = postgresCatalogRepository(fakeDb as unknown as Parameters<typeof postgresCatalogRepository>[0]);
  assert.deepEqual(await repository.load(), demoCatalog);
  assert.deepEqual(transactionOptions, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  variantRows[0]!.currency = 'EUR';
  await assert.rejects(repository.load(), /Only USD/);
});
