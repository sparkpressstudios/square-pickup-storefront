import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ProductOption } from '../../shared/catalog';

/** Declaration only. Importing this file does not connect to any database. */
export const products = pgTable('catalog_products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  options: jsonb('options').$type<readonly ProductOption[]>().notNull(),
});

export const variants = pgTable('catalog_variants', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sku: text('sku').notNull().unique(),
  selections: jsonb('selections').$type<Readonly<Record<string, string>>>().notNull(),
  currency: text('currency').notNull().default('USD'),
  priceMinor: integer('price_minor').notNull(),
  stockQuantity: integer('stock_quantity').notNull(),
  enabled: boolean('enabled').notNull().default(true),
}, (table) => [
  uniqueIndex('catalog_variant_combination').on(table.productId, table.selections),
  check('catalog_variant_usd', sql`${table.currency} = 'USD'`),
  check('catalog_variant_price', sql`${table.priceMinor} >= 0`),
  check('catalog_variant_stock', sql`${table.stockQuantity} >= 0`),
]);
