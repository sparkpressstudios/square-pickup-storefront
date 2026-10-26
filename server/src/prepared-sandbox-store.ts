import { createHash, randomUUID } from 'node:crypto';
import type { SqlDatabase, SqlExecutor } from '../../db/sql-database';
import type { Catalog } from '../../shared/catalog';
import { CheckoutError, parseCheckoutRequest, quoteCart, type CheckoutRequest, type CartQuote } from '../../shared/checkout';
import type { SandboxPublicConfig } from '../../shared/square-sandbox';
import { assertSandboxPublicConfig } from '../../shared/square-sandbox';
import type { SandboxCheckoutState, SandboxCheckoutView } from '../../shared/sandbox-checkout';
import { readCatalog } from './durable-checkout';
import { sandboxIntent, sandboxKeys, type SandboxOrderEvidence, type SandboxPaymentEvidence } from './square-sandbox';

export interface SandboxAttempt {
  execution_mode: 'mocked-sandbox-protocol' | 'square-sandbox'; merchant_id: string | null; refunded_minor: number;
  attempt_id: string; checkout_id: string; session_id: string; fingerprint: string; application_id: string; location_id: string;
  request: CheckoutRequest; catalog_snapshot: Catalog; quote: CartQuote; order_key: string; payment_key: string; state: SandboxCheckoutState;
  order_id: string | null; order_evidence: SandboxOrderEvidence | null; payment_id: string | null; payment_evidence: SandboxPaymentEvidence | null; failure_code: string | null;
}
const externalId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(value) && !value.startsWith('mock_');
async function read(tx: SqlExecutor, id: string): Promise<SandboxAttempt> {
  const row = (await tx.query<SandboxAttempt>('SELECT * FROM sandbox_checkout_attempts WHERE attempt_id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw new CheckoutError('INVALID_REQUEST', 'Prepared sandbox attempt not found.', 404);
  return row;
}
export function sandboxCheckoutView(attempt: SandboxAttempt): SandboxCheckoutView {
  return { mode: attempt.execution_mode, refundedMinor: attempt.refunded_minor, attemptId: attempt.attempt_id, checkoutId: attempt.checkout_id, state: attempt.state,
    amountMinor: attempt.quote.totalMinor, currency: 'USD', fulfillment: 'pickup', orderId: attempt.order_id, paymentId: attempt.payment_id,
    failureCode: attempt.failure_code, requiresReconciliation: ['order_sending','payment_sending','pending','review'].includes(attempt.state), fulfillmentAuthorized: false };
}
/** Separate protocol-test ledger. Shares catalog row locks, never the simulated-payment ledger. */
export class PreparedSandboxStore {
  readonly mode: 'mocked-sandbox-protocol' | 'square-sandbox';
  constructor(private readonly db: SqlDatabase, private readonly context?: { merchantId: string }) { this.mode = context ? 'square-sandbox' : 'mocked-sandbox-protocol'; }
  async reserve(input: unknown, config: SandboxPublicConfig): Promise<SandboxAttempt> {
    assertSandboxPublicConfig(config); const request = parseCheckoutRequest(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ items: request.items, currency: request.currency, fulfillment: request.fulfillment, expectedTotalMinor: request.expectedTotalMinor })).digest('hex');
    return this.db.transaction(async (tx) => {
      // Same lock/identity namespace as the durable simulated checkout.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [request.attemptId]);
      if ((await tx.query('SELECT attempt_id FROM checkout_attempts WHERE attempt_id=$1', [request.attemptId])).rows.length) throw new CheckoutError('IDEMPOTENCY_CONFLICT', 'This attempt belongs to the simulated checkout.', 409);
      const marker = (await tx.query<{ session_id: string; dataset: string }>('SELECT session_id,dataset FROM demo_database_state WHERE singleton=true')).rows[0];
      if (marker?.dataset !== 'synthetic-retail-v1' || marker.session_id !== request.demoSessionId) throw new CheckoutError('DEMO_SESSION_EXPIRED', 'Use this isolated synthetic database session.', 409);
      const previous = (await tx.query<SandboxAttempt>('SELECT * FROM sandbox_checkout_attempts WHERE attempt_id=$1 FOR UPDATE', [request.attemptId])).rows[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.application_id !== config.applicationId || previous.location_id !== config.locationId || previous.execution_mode !== this.mode || previous.merchant_id !== (this.context?.merchantId ?? null)) throw new CheckoutError('IDEMPOTENCY_CONFLICT', 'This attempt already belongs to another cart or sandbox context.', 409);
        return previous;
      }
      if ((await tx.query<{ count: number }>('SELECT count(*)::integer AS count FROM sandbox_checkout_attempts')).rows[0]!.count >= 500) throw new CheckoutError('DEMO_LIMIT_REACHED', 'Prepared checkout reached its local attempt limit.', 503);
      await tx.query('SELECT id FROM catalog_variants WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [request.items.map((item) => item.variantId).sort()]);
      const catalog = await readCatalog(tx); const quote = quoteCart(catalog, request);
      if (quote.totalMinor !== request.expectedTotalMinor) throw new CheckoutError('PRICE_CHANGED', 'Review the current server total before checkout.', 409);
      if (quote.totalMinor < 1) throw new CheckoutError('INVALID_REQUEST', 'The prepared card protocol requires a positive subtotal.');
      const checkoutId = randomUUID(); const keys = sandboxKeys(checkoutId);
      // The snapshot is trusted database catalog state before decrement, containing only the cart's products.
      const snapshot: Catalog = { currency: 'USD', products: catalog.products.filter((product) => request.items.some((item) => item.productId === product.id)) };
      sandboxIntent(snapshot, { items: request.items, currency: 'USD', fulfillment: 'pickup' }, checkoutId);
      await tx.query("INSERT INTO sandbox_checkout_attempts(attempt_id,checkout_id,session_id,fingerprint,application_id,location_id,request,catalog_snapshot,quote,order_key,payment_key,state,execution_mode,merchant_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,'reserved',$12,$13)", [request.attemptId, checkoutId, request.demoSessionId, fingerprint, config.applicationId, config.locationId, JSON.stringify(request), JSON.stringify(snapshot), JSON.stringify(quote), keys.order, keys.payment, this.mode, this.context?.merchantId ?? null]);
      for (const line of quote.lines) {
        const result = await tx.query('UPDATE catalog_variants SET stock_quantity=stock_quantity-$2 WHERE id=$1 AND enabled=true AND stock_quantity>=$2 RETURNING id', [line.variantId, line.quantity]);
        if (result.rows.length !== 1) throw new CheckoutError('INSUFFICIENT_STOCK', 'Stock changed before reservation.', 409);
        await tx.query("INSERT INTO sandbox_checkout_reservations(attempt_id,variant_id,quantity,state) VALUES ($1,$2,$3,'held')", [request.attemptId, line.variantId, line.quantity]);
      }
      return read(tx, request.attemptId);
    });
  }
  get(id: string): Promise<SandboxAttempt> { return this.db.transaction((tx) => read(tx, id)); }
  async claim(id: string, stage: 'order' | 'payment'): Promise<SandboxAttempt | null> {
    return this.db.transaction(async (tx) => {
      const attempt = await read(tx, id); const expected = stage === 'order' ? 'reserved' : 'order_ready';
      if (attempt.state !== expected) return null;
      await tx.query('UPDATE sandbox_checkout_attempts SET state=$2,updated_at=now() WHERE attempt_id=$1', [id, `${stage}_sending`]);
      return read(tx, id);
    });
  }
  async recordOrder(id: string, evidence: SandboxOrderEvidence): Promise<void> {
    await this.db.transaction(async (tx) => {
      const attempt = await read(tx, id);
      if (attempt.state !== 'order_sending' || !externalId(evidence.id) || evidence.locationId !== attempt.location_id || evidence.checkoutId !== attempt.checkout_id || evidence.amountMinor !== attempt.quote.totalMinor || evidence.currency !== 'USD') throw new Error('Order persistence context mismatch');
      const normalized: SandboxOrderEvidence = { id: evidence.id, locationId: evidence.locationId, checkoutId: evidence.checkoutId, amountMinor: evidence.amountMinor, currency: 'USD' };
      await tx.query("UPDATE sandbox_checkout_attempts SET state='order_ready',order_id=$2,order_evidence=$3::jsonb,updated_at=now() WHERE attempt_id=$1", [id, normalized.id, JSON.stringify(normalized)]);
    });
  }
  async recordPayment(id: string, evidence: SandboxPaymentEvidence): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sandbox-payment:${evidence.id}`]);
      const attempt = await read(tx, id);
      if (attempt.state !== 'payment_sending' || !externalId(evidence.id) || evidence.orderId !== attempt.order_id || evidence.amountMinor !== attempt.quote.totalMinor || evidence.currency !== 'USD' || !['COMPLETED','APPROVED','PENDING'].includes(evidence.status)) throw new Error('Payment persistence context mismatch');
      const normalized: SandboxPaymentEvidence = { id: evidence.id, orderId: evidence.orderId, status: evidence.status, amountMinor: evidence.amountMinor, currency: 'USD' };
      await tx.query('UPDATE sandbox_checkout_attempts SET state=$2,payment_id=$3,payment_evidence=$4::jsonb,updated_at=now() WHERE attempt_id=$1', [id, evidence.status === 'COMPLETED' ? 'completed' : 'pending', evidence.id, JSON.stringify(normalized)]);
      if (attempt.execution_mode === 'square-sandbox') {
        await tx.query('INSERT INTO sandbox_payment_projections(payment_id,checkout_id,merchant_id,location_id,order_id,amount_minor,currency,payment_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (payment_id) DO NOTHING', [evidence.id, attempt.checkout_id, attempt.merchant_id, attempt.location_id, attempt.order_id, attempt.quote.totalMinor, 'USD', evidence.status]);
        const context = (await tx.query<{ checkout_id: string }>('SELECT checkout_id FROM sandbox_payment_projections WHERE payment_id=$1', [evidence.id])).rows[0];
        if (context?.checkout_id !== attempt.checkout_id) throw new Error('Payment expectation identity conflict');
      }
      if (evidence.status === 'COMPLETED') await tx.query("UPDATE sandbox_checkout_reservations SET state='committed' WHERE attempt_id=$1 AND state='held'", [id]);
    });
  }
  async fail(id: string, expected: 'reserved' | 'order_sending' | 'payment_sending', definite: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      const attempt = await read(tx, id); if (attempt.state !== expected) return;
      const code = expected === 'reserved' ? 'CANCELED_BEFORE_DISPATCH' : expected === 'order_sending' ? definite ? 'ORDER_REJECTED' : 'ORDER_OUTCOME_UNKNOWN' : definite ? 'PAYMENT_DECLINED' : 'PAYMENT_OUTCOME_UNKNOWN';
      if (definite && !attempt.payment_id) {
        await releaseSandboxHold(tx, id);
      }
      await tx.query('UPDATE sandbox_checkout_attempts SET state=$2,failure_code=$3,updated_at=now() WHERE attempt_id=$1', [id, definite ? 'failed' : 'review', code]);
    });
  }
}
export async function releaseSandboxHold(tx: SqlExecutor, id: string) {
  const released = await tx.query<{ variant_id: string; quantity: number }>("UPDATE sandbox_checkout_reservations SET state='released' WHERE attempt_id=$1 AND state='held' RETURNING variant_id,quantity", [id]);
  for (const line of released.rows.sort((a, b) => a.variant_id.localeCompare(b.variant_id))) await tx.query('UPDATE catalog_variants SET stock_quantity=stock_quantity+$2 WHERE id=$1', [line.variant_id, line.quantity]);
}
