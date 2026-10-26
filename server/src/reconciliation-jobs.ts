import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../../db/sql-database';
import { AdminError } from '../../shared/admin-catalog';
import { validAttemptId } from '../../shared/checkout';
import type { JobFailure, JobState, ReconciliationSummary } from '../../shared/integration';
import { SandboxWebhookProjector, WebhookError } from './square-webhooks';

export interface ReconciliationLease { id: string; eventId: string; paymentId: string; leaseToken: string; attempts: number }
export class SandboxReconciliationQueue {
  constructor(private readonly db: SqlDatabase) {}
  async claim(): Promise<ReconciliationLease | null> {
    return this.db.transaction(async (tx) => {
      // Expired last attempts need attention, rather than remaining permanently 'running'.
      await tx.query("UPDATE sandbox_reconciliation_jobs SET state='attention',failure_code='ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE state='running' AND lease_until<=now() AND attempts>=5");
      const candidate = (await tx.query<{ id: string; event_id: string; payment_id: string; attempts: number }>("SELECT j.id,j.event_id,e.payment_id,j.attempts FROM sandbox_reconciliation_jobs j JOIN sandbox_webhook_events e ON e.event_id=j.event_id WHERE j.attempts<5 AND (((j.state='queued' OR j.state='retry') AND j.available_at<=now()) OR (j.state='running' AND j.lease_until<=now())) ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1")).rows[0];
      if (!candidate) return null;
      const leaseToken = randomUUID();
      await tx.query("UPDATE sandbox_reconciliation_jobs SET state='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1", [candidate.id, leaseToken]);
      return { id: candidate.id, eventId: candidate.event_id, paymentId: candidate.payment_id, leaseToken, attempts: candidate.attempts + 1 };
    });
  }
  async eventState(lease: ReconciliationLease): Promise<{ outcome: string; expectedPayment: boolean }> {
    const event = (await this.db.query<{ outcome: string; expected_payment: boolean }>('SELECT e.outcome,EXISTS(SELECT 1 FROM sandbox_payment_projections p WHERE p.payment_id=e.payment_id) AS expected_payment FROM sandbox_webhook_events e WHERE e.event_id=$1 AND e.payment_id=$2', [lease.eventId, lease.paymentId])).rows[0];
    if (!event) throw new Error('Missing verified reconciliation event');
    return { outcome: event.outcome, expectedPayment: event.expected_payment };
  }
  private async finish(lease: ReconciliationLease, state: JobState, failureCode: JobFailure | null, delay: number): Promise<boolean> {
    // Fence late results. Replaying the projection may occur more than once; its own event locks/deduplication protect effects.
    const result = await this.db.query("UPDATE sandbox_reconciliation_jobs j SET state=$3,failure_code=$4,available_at=now()+($5::integer * interval '1 second'),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>now() AND attempts=$6 AND ($3<>'succeeded' OR EXISTS(SELECT 1 FROM sandbox_webhook_events e WHERE e.event_id=j.event_id AND e.outcome IN ('applied','ignored'))) RETURNING id", [lease.id, lease.leaseToken, state, failureCode, delay, lease.attempts]);
    return result.rows.length === 1;
  }
  succeed(lease: ReconciliationLease): Promise<boolean> { return this.finish(lease, 'succeeded', null, 0); }
  fail(lease: ReconciliationLease, code: JobFailure): Promise<boolean> {
    const retryable = code === 'WAITING_FOR_PAYMENT' || code === 'TRANSIENT_DATABASE';
    const state = retryable && lease.attempts < 5 ? 'retry' : 'attention';
    return this.finish(lease, state, code, state === 'retry' ? Math.min(900, 30 * 2 ** (lease.attempts - 1)) : 0);
  }
  async retry(id: string): Promise<void> {
    if (!validAttemptId(id)) throw new AdminError(400, 'INVALID_JOB', 'Use a valid reconciliation job ID.');
    const result = await this.db.query("UPDATE sandbox_reconciliation_jobs SET state='queued',attempts=0,failure_code=NULL,available_at=now(),updated_at=now() WHERE id=$1 AND state='attention' RETURNING id", [id]);
    if (!result.rows.length) throw new AdminError(409, 'JOB_NOT_RETRYABLE', 'Only a job requiring attention can be explicitly requeued.');
  }
  async summary(): Promise<ReconciliationSummary> {
    return this.db.transaction(async (tx) => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const counts: Record<JobState, number> = { queued: 0, running: 0, retry: 0, succeeded: 0, attention: 0 };
      for (const row of (await tx.query<{ state: JobState; count: number }>('SELECT state,count(*)::integer AS count FROM sandbox_reconciliation_jobs GROUP BY state')).rows) counts[row.state] = row.count;
      const backlog = (await tx.query<{ pending: number; unknown: number }>("SELECT count(*)::integer AS pending,count(DISTINCT e.payment_id) FILTER (WHERE NOT EXISTS(SELECT 1 FROM sandbox_payment_projections p WHERE p.payment_id=e.payment_id))::integer AS unknown FROM sandbox_webhook_events e WHERE e.outcome='pending'")).rows[0]!;
      const expired = (await tx.query<{ count: number }>("SELECT count(*)::integer AS count FROM sandbox_reconciliation_jobs WHERE state='running' AND lease_until<=now()")).rows[0]!.count;
      const recent = (await tx.query<{ id: string; state: JobState; attempts: number; failure_code: JobFailure | null; available_at: Date | string; updated_at: Date | string }>('SELECT id,state,attempts,failure_code,available_at,updated_at FROM sandbox_reconciliation_jobs ORDER BY updated_at DESC,id LIMIT 20')).rows;
      return { counts, pendingEvents: backlog.pending, unknownPayments: backlog.unknown, expiredLeases: expired, recent: recent.map((row) => ({ id: row.id, state: row.state, attempts: row.attempts, failureCode: row.failure_code, availableAt: new Date(row.available_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() })) };
    });
  }
}
/** Explicit one-job invocation only. No timer, scheduler, default transport or payment/order creation. */
export class SandboxReconciliationWorker {
  constructor(private readonly queue: SandboxReconciliationQueue, private readonly projector: Pick<SandboxWebhookProjector, 'reconcilePending'>) {}
  async runOne(): Promise<'idle' | 'succeeded' | 'deferred' | 'lease-lost'> {
    const lease = await this.queue.claim(); if (!lease) return 'idle';
    try {
      const before = await this.queue.eventState(lease);
      if (before.outcome === 'pending') {
        if (!before.expectedPayment) return await this.queue.fail(lease, 'WAITING_FOR_PAYMENT') ? 'deferred' : 'lease-lost';
        await this.projector.reconcilePending(lease.paymentId);
      }
      if ((await this.queue.eventState(lease)).outcome === 'pending') return await this.queue.fail(lease, 'WAITING_FOR_PAYMENT') ? 'deferred' : 'lease-lost';
      return await this.queue.succeed(lease) ? 'succeeded' : 'lease-lost';
    } catch (error) {
      const sqlState = (error as { code?: string })?.code;
      const code: JobFailure = error instanceof WebhookError && error.code === 'CONFLICT' ? 'RECONCILIATION_CONFLICT'
        : ['40001', '40P01', '53300', '57P01', '08000', '08003', '08006'].includes(String(sqlState)) ? 'TRANSIENT_DATABASE' : 'UNEXPECTED_FAILURE';
      return await this.queue.fail(lease, code) ? 'deferred' : 'lease-lost';
    }
  }
}
