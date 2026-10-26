import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { variants } from './catalog';
import { demoDatabaseState } from './checkout';

export const sandboxCheckoutAttempts = pgTable('sandbox_checkout_attempts', {
  attemptId: uuid('attempt_id').primaryKey(), checkoutId: uuid('checkout_id').notNull().unique(), sessionId: uuid('session_id').notNull().references(() => demoDatabaseState.sessionId),
  fingerprint: text('fingerprint').notNull(), executionMode: text('execution_mode').notNull().default('mocked-sandbox-protocol'), merchantId: text('merchant_id'), refundedMinor: integer('refunded_minor').notNull().default(0),
  applicationId: text('application_id').notNull(), locationId: text('location_id').notNull(), request: jsonb('request').notNull(), catalogSnapshot: jsonb('catalog_snapshot').notNull(), quote: jsonb('quote').notNull(),
  orderKey: text('order_key').notNull().unique(), paymentKey: text('payment_key').notNull().unique(), state: text('state').notNull(),
  orderId: text('order_id').unique(), orderEvidence: jsonb('order_evidence'), paymentId: text('payment_id').unique(), paymentEvidence: jsonb('payment_evidence'),
  failureCode: text('failure_code'), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('sandbox_checkout_fingerprint', sql`length(${t.fingerprint})=64`), check('sandbox_checkout_mode', sql`${t.executionMode} IN ('mocked-sandbox-protocol','square-sandbox')`), check('sandbox_checkout_merchant', sql`${t.executionMode}<>'square-sandbox' OR ${t.merchantId} IS NOT NULL`), check('sandbox_checkout_refunded', sql`${t.refundedMinor}>=0`),
  check('sandbox_checkout_app', sql`${t.applicationId} LIKE 'sandbox-sq0idb-%'`), check('sandbox_checkout_order_key', sql`${t.orderKey}='ord_' || ${t.checkoutId}::text`), check('sandbox_checkout_payment_key', sql`${t.paymentKey}='pay_' || ${t.checkoutId}::text`),
  check('sandbox_checkout_state', sql`${t.state} IN ('reserved','order_sending','order_ready','payment_sending','pending','completed','failed','review')`),
  check('sandbox_checkout_order_evidence', sql`(${t.orderId} IS NULL)=(${t.orderEvidence} IS NULL)`), check('sandbox_checkout_payment_evidence', sql`(${t.paymentId} IS NULL)=(${t.paymentEvidence} IS NULL)`),
  check('sandbox_checkout_order_required', sql`${t.state} NOT IN ('order_ready','payment_sending','pending','completed') OR ${t.orderId} IS NOT NULL`),
  check('sandbox_checkout_payment_required', sql`${t.state} NOT IN ('pending','completed') OR ${t.paymentId} IS NOT NULL`),
  check('sandbox_checkout_order_not_mock', sql`${t.orderId} IS NULL OR left(${t.orderId},5)<>'mock_'`), check('sandbox_checkout_payment_not_mock', sql`${t.paymentId} IS NULL OR left(${t.paymentId},5)<>'mock_'`),
  check('sandbox_checkout_failure', sql`${t.failureCode} IN ('CANCELED_BEFORE_DISPATCH','ORDER_REJECTED','PAYMENT_DECLINED','ORDER_OUTCOME_UNKNOWN','PAYMENT_OUTCOME_UNKNOWN')`)]);
export const sandboxCheckoutReservations = pgTable('sandbox_checkout_reservations', {
  attemptId: uuid('attempt_id').notNull().references(() => sandboxCheckoutAttempts.attemptId), variantId: text('variant_id').notNull().references(() => variants.id),
  quantity: integer('quantity').notNull(), state: text('state').notNull(),
}, (t) => [primaryKey({ columns: [t.attemptId, t.variantId] }), check('sandbox_checkout_quantity', sql`${t.quantity} BETWEEN 1 AND 99`), check('sandbox_checkout_reservation_state', sql`${t.state} IN ('held','committed','released')`)]);
