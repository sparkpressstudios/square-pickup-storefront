import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sandboxWebhookEvents } from './sandbox-events';

export const sandboxReconciliationJobs = pgTable('sandbox_reconciliation_jobs', {
  id: uuid('id').primaryKey(), eventId: text('event_id').notNull().unique().references(() => sandboxWebhookEvents.eventId),
  state: text('state').notNull().default('queued'), attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(), leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }), failureCode: text('failure_code'), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('sandbox_job_state', sql`${t.state} IN ('queued','running','retry','succeeded','attention')`),
  check('sandbox_job_attempts', sql`${t.attempts} BETWEEN 0 AND 5`),
  check('sandbox_job_failure', sql`${t.failureCode} IN ('WAITING_FOR_PAYMENT','TRANSIENT_DATABASE','RECONCILIATION_CONFLICT','UNEXPECTED_FAILURE','ATTEMPTS_EXHAUSTED')`),
  check('sandbox_job_lease', sql`(${t.state} = 'running' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL) OR (${t.state} <> 'running' AND ${t.leaseToken} IS NULL AND ${t.leaseUntil} IS NULL)`),
  index('sandbox_reconciliation_due').on(t.state, t.availableAt)]);
