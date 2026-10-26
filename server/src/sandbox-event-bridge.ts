import type { SqlExecutor } from '../../db/sql-database';
import type { SandboxAttempt } from './prepared-sandbox-store';
import { releaseSandboxHold } from './prepared-sandbox-store';
import { WebhookError, type SandboxEventBridge, type NormalizedEvent } from './square-webhooks';

export function sandboxAttemptBridge(applicationId: string, merchantId: string, locationId: string): SandboxEventBridge {
  function context(attempt: SandboxAttempt) {
    if (attempt.execution_mode !== 'square-sandbox' || attempt.application_id !== applicationId || attempt.merchant_id !== merchantId || attempt.location_id !== locationId) throw new WebhookError('CONFLICT', 'Sandbox attempt context mismatch');
  }
  return {
    async before(tx, event) {
      if (event.kind !== 'payment' || !event.orderId) return;
      const attempt = (await tx.query<SandboxAttempt>('SELECT * FROM sandbox_checkout_attempts WHERE order_id=$1 FOR UPDATE', [event.orderId])).rows[0];
      if (!attempt) return;
      context(attempt);
      if (event.referenceId !== attempt.checkout_id || event.amountMinor !== attempt.quote.totalMinor || (attempt.payment_id && attempt.payment_id !== event.paymentId) || !['payment_sending','pending','completed','failed','review'].includes(attempt.state) || (attempt.state === 'failed' && !attempt.payment_id) || (attempt.state === 'review' && attempt.failure_code !== 'PAYMENT_OUTCOME_UNKNOWN')) throw new WebhookError('CONFLICT', 'Signed payment does not match a dispatched checkout');
      await tx.query('INSERT INTO sandbox_payment_projections(payment_id,checkout_id,merchant_id,location_id,order_id,amount_minor,currency) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (payment_id) DO NOTHING', [event.paymentId, attempt.checkout_id, merchantId, locationId, attempt.order_id, attempt.quote.totalMinor, 'USD']);
      const bound = (await tx.query<{ checkout_id: string }>('SELECT checkout_id FROM sandbox_payment_projections WHERE payment_id=$1', [event.paymentId])).rows[0];
      if (bound?.checkout_id !== attempt.checkout_id) throw new WebhookError('CONFLICT', 'Payment mapping belongs to another checkout');
    },
    async after(tx: SqlExecutor, event: NormalizedEvent) {
      const projection = (await tx.query<{ checkout_id: string; order_id: string; amount_minor: number; payment_status: string; refunded: number }>("SELECT p.*,COALESCE((SELECT sum(r.amount_minor) FROM sandbox_refund_projections r WHERE r.payment_id=p.payment_id AND r.status='COMPLETED'),0)::integer AS refunded FROM sandbox_payment_projections p WHERE payment_id=$1", [event.paymentId])).rows[0];
      if (!projection) return;
      const attempt = (await tx.query<SandboxAttempt>('SELECT * FROM sandbox_checkout_attempts WHERE checkout_id=$1 FOR UPDATE', [projection.checkout_id])).rows[0];
      if (!attempt) return;
      context(attempt);
      if (attempt.order_id !== projection.order_id || attempt.quote.totalMinor !== projection.amount_minor || projection.refunded > attempt.quote.totalMinor || (attempt.payment_id && attempt.payment_id !== event.paymentId)) throw new WebhookError('CONFLICT', 'Checkout projection identity mismatch');
      if (attempt.state === 'failed' && projection.payment_status === 'COMPLETED') throw new WebhookError('CONFLICT', 'Completed payment conflicts with released inventory');
      if (event.kind === 'refund') { await tx.query('UPDATE sandbox_checkout_attempts SET refunded_minor=$2,updated_at=now() WHERE attempt_id=$1', [attempt.attempt_id, projection.refunded]); return; }
      // Never regress a validated completed response on an older pending callback.
      if (attempt.state === 'completed' && projection.payment_status !== 'COMPLETED') return;
      const completed = projection.payment_status === 'COMPLETED'; const declined = ['FAILED','CANCELED'].includes(projection.payment_status);
      const evidence = { id: event.paymentId, orderId: attempt.order_id, status: projection.payment_status, amountMinor: attempt.quote.totalMinor, currency: 'USD' };
      await tx.query('UPDATE sandbox_checkout_attempts SET state=$2,payment_id=$3,payment_evidence=$4::jsonb,failure_code=$5,refunded_minor=$6,updated_at=now() WHERE attempt_id=$1', [attempt.attempt_id, completed ? 'completed' : declined ? 'failed' : 'pending', event.paymentId, JSON.stringify(evidence), declined ? 'PAYMENT_DECLINED' : null, projection.refunded]);
      if (completed) await tx.query("UPDATE sandbox_checkout_reservations SET state='committed' WHERE attempt_id=$1 AND state='held'", [attempt.attempt_id]);
      if (declined) await releaseSandboxHold(tx, attempt.attempt_id);
    },
  };
}
