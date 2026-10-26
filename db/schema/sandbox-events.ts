import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const sandboxPaymentProjections = pgTable('sandbox_payment_projections', {
  paymentId: text('payment_id').primaryKey(), checkoutId: uuid('checkout_id').notNull().unique(), merchantId: text('merchant_id').notNull(),
  locationId: text('location_id').notNull(), orderId: text('order_id'), amountMinor: integer('amount_minor').notNull(), currency: text('currency').notNull(),
  paymentStatus: text('payment_status').notNull().default('UNKNOWN'), updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [check('sandbox_payment_not_mock', sql`left(${t.paymentId},5) <> 'mock_'`), check('sandbox_payment_amount', sql`${t.amountMinor} > 0`), check('sandbox_payment_usd', sql`${t.currency} = 'USD'`), check('sandbox_payment_status', sql`${t.paymentStatus} IN ('UNKNOWN','PENDING','APPROVED','COMPLETED','CANCELED','FAILED')`)]);

export const sandboxRefundProjections = pgTable('sandbox_refund_projections', {
  refundId: text('refund_id').primaryKey(), paymentId: text('payment_id').notNull().references(() => sandboxPaymentProjections.paymentId),
  amountMinor: integer('amount_minor').notNull(), currency: text('currency').notNull(), status: text('status').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, (t) => [check('sandbox_refund_amount', sql`${t.amountMinor} > 0`), check('sandbox_refund_usd', sql`${t.currency} = 'USD'`), check('sandbox_refund_status', sql`${t.status} IN ('PENDING','COMPLETED','REJECTED','FAILED')`)]);

export const sandboxWebhookEvents = pgTable('sandbox_webhook_events', {
  eventId: text('event_id').primaryKey(), payloadHash: text('payload_hash').notNull(), eventType: text('event_type').notNull(),
  resourceId: text('resource_id').notNull(), paymentId: text('payment_id').notNull(), payload: jsonb('payload').notNull(), outcome: text('outcome').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('sandbox_event_hash', sql`length(${t.payloadHash}) = 64`), check('sandbox_event_outcome', sql`${t.outcome} IN ('pending','applied','ignored')`), index('sandbox_pending_payment_events').on(t.paymentId).where(sql`${t.outcome} = 'pending'`)]);
