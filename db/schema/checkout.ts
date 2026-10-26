import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { variants } from './catalog';
import type { DemoQuote, DemoReceipt } from '../../shared/checkout';

export const demoDatabaseState = pgTable('demo_database_state', {
  singleton: boolean('singleton').primaryKey().default(true),
  sessionId: uuid('session_id').notNull().unique(),
  dataset: text('dataset').notNull(),
}, (table) => [check('demo_singleton', sql`${table.singleton}`), check('demo_dataset', sql`${table.dataset} = 'synthetic-retail-v1'`)]);

export const checkoutAttempts = pgTable('checkout_attempts', {
  attemptId: uuid('attempt_id').primaryKey(), checkoutId: uuid('checkout_id').notNull().unique(),
  sessionId: uuid('session_id').notNull().references(() => demoDatabaseState.sessionId),
  fingerprint: text('fingerprint').notNull(), quote: jsonb('quote').$type<DemoQuote>().notNull(),
  state: text('state').$type<'reserved' | 'simulated' | 'declined' | 'uncertain'>().notNull(),
  mockPaymentKey: text('mock_payment_key').notNull().unique(), receipt: jsonb('receipt').$type<DemoReceipt>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check('checkout_fingerprint', sql`length(${table.fingerprint}) = 64`), check('checkout_state', sql`${table.state} IN ('reserved','simulated','declined','uncertain')`), check('checkout_receipt', sql`(${table.state} = 'simulated' AND ${table.receipt} IS NOT NULL) OR (${table.state} <> 'simulated' AND ${table.receipt} IS NULL)`)]);

export const inventoryReservations = pgTable('inventory_reservations', {
  attemptId: uuid('attempt_id').notNull().references(() => checkoutAttempts.attemptId),
  variantId: text('variant_id').notNull().references(() => variants.id),
  quantity: integer('quantity').notNull(), state: text('state').$type<'reserved' | 'committed' | 'released'>().notNull(),
}, (table) => [primaryKey({ columns: [table.attemptId, table.variantId] }), check('reservation_quantity', sql`${table.quantity} BETWEEN 1 AND 99`), check('reservation_state', sql`${table.state} IN ('reserved','committed','released')`)]);

export const mockPaymentLedger = pgTable('mock_payment_ledger', {
  idempotencyKey: text('idempotency_key').primaryKey(), checkoutId: uuid('checkout_id').notNull().unique().references(() => checkoutAttempts.checkoutId),
  paymentId: text('payment_id').notNull().unique(), amountMinor: integer('amount_minor').notNull(), currency: text('currency').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check('mock_payment_id', sql`${table.paymentId} LIKE 'mock_%'`), check('mock_payment_amount', sql`${table.amountMinor} >= 0`), check('mock_payment_currency', sql`${table.currency} = 'USD'`)]);
