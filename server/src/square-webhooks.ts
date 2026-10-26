import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import type { SqlDatabase, SqlExecutor } from '../../db/sql-database';
import { assertMerchantWebhookConfiguration, type MerchantWebhookConfig } from './merchant-payment-config';
import { validAttemptId } from '../../shared/checkout';

export interface SandboxWebhookConfig {
  readonly environment: 'sandbox'; readonly signatureKey: string; readonly notificationUrl: string;
  readonly merchantId: string; readonly locationId: string;
}
export class WebhookError extends Error {
  constructor(readonly code: 'CONFIGURATION' | 'SIGNATURE' | 'PAYLOAD' | 'CONFLICT', message: string) { super(message); }
}
const externalId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(value);
function configuration(config: SandboxWebhookConfig | MerchantWebhookConfig, expectedEnvironment: 'sandbox' | 'production' = 'sandbox'): void {
  let url;
  try { url = new URL(config.notificationUrl); } catch { /* Rejected below. */ }
  if (config.environment !== expectedEnvironment || typeof config.signatureKey !== 'string' || !config.signatureKey.trim() || !url || url.protocol !== 'https:' || url.username || url.password || url.hash || !externalId(config.merchantId) || !externalId(config.locationId)) throw new WebhookError('CONFIGURATION', 'Complete sandbox webhook configuration is required');
}
export function verifySandboxWebhook(rawBody: Buffer, signature: string | undefined, config: SandboxWebhookConfig): boolean {
  try {
    configuration(config);
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 256 * 1024 || !signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
    const expected = createHmac('sha256', config.signatureKey).update(config.notificationUrl, 'utf8').update(rawBody).digest();
    const supplied = Buffer.from(signature, 'base64');
    return supplied.length === expected.length && timingSafeEqual(expected, supplied);
  } catch { return false; }
}
/** Production verification accepts only webhook settings derived from the explicit production gate. */
export function verifyMerchantWebhook(rawBody: Buffer, signature: string | undefined, config: MerchantWebhookConfig): boolean {
  try {
    assertMerchantWebhookConfiguration(config); configuration(config, config.environment);
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 256 * 1024 || !signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
    const expected = createHmac('sha256', config.signatureKey).update(config.notificationUrl, 'utf8').update(rawBody).digest();
    const supplied = Buffer.from(signature, 'base64'); return supplied.length === expected.length && timingSafeEqual(expected, supplied);
  } catch { return false; }
}
type PaymentStatus = 'UNKNOWN' | 'PENDING' | 'APPROVED' | 'COMPLETED' | 'CANCELED' | 'FAILED';
type RefundStatus = 'PENDING' | 'COMPLETED' | 'REJECTED' | 'FAILED';
type EventBase = { eventId: string; eventType: string; resourceId: string; paymentId: string; merchantId: string; locationId: string; updatedAt: string; amountMinor: number; currency: 'USD'; orderId?: string; referenceId?: string };
export type NormalizedEvent = EventBase & ({ kind: 'payment'; status: Exclude<PaymentStatus, 'UNKNOWN'> } | { kind: 'refund'; status: RefundStatus });
export interface SandboxEventBridge { before(tx: SqlExecutor, event: NormalizedEvent): Promise<void>; after(tx: SqlExecutor, event: NormalizedEvent): Promise<void> }
type PaymentRow = { payment_id: string; checkout_id: string; merchant_id: string; location_id: string; order_id: string | null; amount_minor: number; currency: string; payment_status: PaymentStatus; updated_at: Date | string | null };
type RefundRow = { payment_id: string; amount_minor: number; currency: string; status: RefundStatus; updated_at: Date | string };
type Outcome = 'pending' | 'applied' | 'ignored';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebhookError('PAYLOAD', 'Invalid webhook object');
  return value as Record<string, unknown>;
}
function eventPayload(raw: Buffer, config: SandboxWebhookConfig | MerchantWebhookConfig): NormalizedEvent | null {
  let value;
  try { value = object(JSON.parse(raw.toString('utf8'))); } catch { throw new WebhookError('PAYLOAD', 'Invalid webhook JSON'); }
  if (value.merchant_id !== config.merchantId || !externalId(value.event_id)) throw new WebhookError('PAYLOAD', 'Webhook merchant or identity mismatch');
  if (!['payment.created', 'payment.updated', 'refund.created', 'refund.updated'].includes(String(value.type))) return null;
  const kind = String(value.type).startsWith('payment.') ? 'payment' : 'refund';
  const data = object(value.data); const resource = object(object(data.object)[kind]);
  const money = object(resource.amount_money);
  const statuses = kind === 'payment' ? ['PENDING', 'APPROVED', 'COMPLETED', 'CANCELED', 'FAILED'] : ['PENDING', 'COMPLETED', 'REJECTED', 'FAILED'];
  if (data.type !== kind || data.id !== resource.id || !externalId(resource.id) || resource.location_id !== config.locationId || !statuses.includes(String(resource.status)) || typeof resource.updated_at !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(resource.updated_at) || !Number.isFinite(Date.parse(resource.updated_at)) || money.currency !== 'USD' || typeof money.amount !== 'number' || !Number.isSafeInteger(money.amount) || money.amount < 1 || money.amount > 2_147_483_647) throw new WebhookError('PAYLOAD', 'Webhook identity, location, status, timestamp, or money is invalid');
  const paymentId = kind === 'payment' ? resource.id : resource.payment_id;
  if (!externalId(paymentId) || paymentId.startsWith('mock_') || (resource.order_id !== undefined && !externalId(resource.order_id))) throw new WebhookError('PAYLOAD', 'Webhook payment/order identity is invalid');
  if (resource.reference_id !== undefined && !validAttemptId(resource.reference_id)) throw new WebhookError('PAYLOAD', 'Invalid checkout reference');
  return { eventId: value.event_id, eventType: String(value.type), resourceId: resource.id, paymentId, merchantId: config.merchantId, locationId: config.locationId, updatedAt: resource.updated_at, amountMinor: money.amount, currency: 'USD', ...(resource.order_id ? { orderId: String(resource.order_id) } : {}), ...(resource.reference_id ? { referenceId: String(resource.reference_id).toLowerCase() } : {}), kind, status: resource.status } as NormalizedEvent;
}
function transition(current: string, next: string, currentTime: Date | string | null, nextTime: string, terminal: readonly string[]): boolean {
  if (currentTime && Date.parse(nextTime) < new Date(currentTime).getTime()) return false;
  if (terminal.includes(current) && next !== current) return false;
  if (current === 'APPROVED' && next === 'PENDING') return false;
  return true;
}

/** Sanitized projections; an optional sandbox bridge reconciles matching attempts, never demo orders or fulfillment. */
class PaymentWebhookProjector {
  #config: SandboxWebhookConfig | MerchantWebhookConfig;
  constructor(private readonly db: SqlDatabase, config: SandboxWebhookConfig | MerchantWebhookConfig, private readonly bridge: SandboxEventBridge | undefined, private readonly verify: (raw: Buffer, signature: string | undefined) => boolean) { configuration(config, config.environment); this.#config = { ...config }; }

  async registerExpectedPayment(input: { paymentId: string; checkoutId: string; amountMinor: number; currency: 'USD'; orderId?: string }): Promise<void> {
    if (!externalId(input.paymentId) || input.paymentId.startsWith('mock_') || !validAttemptId(input.checkoutId) || !Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > 2_147_483_647 || input.currency !== 'USD' || (input.orderId !== undefined && !externalId(input.orderId))) throw new WebhookError('PAYLOAD', 'Invalid server-owned payment expectation');
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sandbox-payment:${input.paymentId}`]);
      await tx.query('INSERT INTO sandbox_payment_projections(payment_id,checkout_id,merchant_id,location_id,order_id,amount_minor,currency) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (payment_id) DO NOTHING', [input.paymentId, input.checkoutId, this.#config.merchantId, this.#config.locationId, input.orderId ?? null, input.amountMinor, 'USD']);
      const row = (await tx.query<PaymentRow>('SELECT * FROM sandbox_payment_projections WHERE payment_id=$1 FOR UPDATE', [input.paymentId])).rows[0]!;
      if (row.checkout_id !== input.checkoutId || row.amount_minor !== input.amountMinor || row.currency !== input.currency || row.merchant_id !== this.#config.merchantId || row.location_id !== this.#config.locationId || row.order_id !== (input.orderId ?? null)) throw new WebhookError('CONFLICT', 'Payment expectation changed');
    });
    await this.reconcilePending(input.paymentId);
  }

  async handle(rawBody: Buffer, signature: string | undefined): Promise<{ outcome: Outcome | 'duplicate'; eventId?: string }> {
    if (!this.verify(rawBody, signature)) throw new WebhookError('SIGNATURE', 'Invalid sandbox webhook signature');
    const event = eventPayload(rawBody, this.#config);
    if (!event) return { outcome: 'ignored' };
    const hash = createHash('sha256').update(rawBody).digest('hex');
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sandbox-payment:${event.paymentId}`]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sandbox-event:${event.eventId}`]);
      const previous = (await tx.query<{ payload_hash: string; outcome: Outcome }>('SELECT payload_hash,outcome FROM sandbox_webhook_events WHERE event_id=$1 FOR UPDATE', [event.eventId])).rows[0];
      if (previous && previous.payload_hash !== hash) throw new WebhookError('CONFLICT', 'Webhook event identity was reused with changed bytes');
      if (previous && previous.outcome !== 'pending') return { outcome: 'duplicate', eventId: event.eventId };
      if (!previous) await tx.query("INSERT INTO sandbox_webhook_events(event_id,payload_hash,event_type,resource_id,payment_id,payload,outcome) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending')", [event.eventId, hash, event.eventType, event.resourceId, event.paymentId, JSON.stringify(event)]);
      await this.bridge?.before(tx, event);
      const outcome = await this.apply(tx, event);
      await tx.query('UPDATE sandbox_webhook_events SET outcome=$2 WHERE event_id=$1', [event.eventId, outcome]);
      if (outcome === 'pending') await tx.query('INSERT INTO sandbox_reconciliation_jobs(id,event_id) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING', [randomUUID(), event.eventId]);
      if (this.bridge && outcome === 'applied') {
        const pending = await tx.query<{ event_id: string; payload: NormalizedEvent }>("SELECT event_id,payload FROM sandbox_webhook_events WHERE payment_id=$1 AND outcome='pending' ORDER BY received_at,event_id FOR UPDATE", [event.paymentId]);
        for (const row of pending.rows) { await this.bridge.before(tx, row.payload); const reconciled = await this.apply(tx, row.payload); await tx.query('UPDATE sandbox_webhook_events SET outcome=$2 WHERE event_id=$1', [row.event_id, reconciled]); }
      }
      return { outcome, eventId: event.eventId };
    });
  }

  async reconcilePending(paymentId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sandbox-payment:${paymentId}`]);
      // Same payment row lock also serializes refund aggregation across events.
      const found = await tx.query('SELECT payment_id FROM sandbox_payment_projections WHERE payment_id=$1 FOR UPDATE', [paymentId]);
      if (!found.rows.length) return;
      const events = await tx.query<{ event_id: string; payload: NormalizedEvent }>("SELECT event_id,payload FROM sandbox_webhook_events WHERE payment_id=$1 AND outcome='pending' ORDER BY received_at,event_id FOR UPDATE", [paymentId]);
      for (const row of events.rows) {
        await this.bridge?.before(tx, row.payload);
        const outcome = await this.apply(tx, row.payload);
        await tx.query('UPDATE sandbox_webhook_events SET outcome=$2 WHERE event_id=$1', [row.event_id, outcome]);
      }
    });
  }

  private async apply(tx: SqlExecutor, event: NormalizedEvent): Promise<Outcome> {
    const payment = (await tx.query<PaymentRow>('SELECT * FROM sandbox_payment_projections WHERE payment_id=$1 FOR UPDATE', [event.paymentId])).rows[0];
    if (!payment) return 'pending';
    // PaymentRefund.order_id identifies Square's return order, not the purchase order.
    // Bind refunds by their signed payment_id; retain original-order equality for payments.
    // https://developer.squareup.com/docs/refunds-api/retrieve-refunds
    if (payment.merchant_id !== event.merchantId || payment.location_id !== event.locationId || payment.currency !== event.currency || (event.kind === 'payment' && payment.order_id && payment.order_id !== event.orderId)) throw new WebhookError('CONFLICT', 'Webhook does not match the registered payment context');
    if (event.kind === 'payment') {
      if (payment.amount_minor !== event.amountMinor) throw new WebhookError('CONFLICT', 'Webhook payment amount differs from server expectation');
      if (!transition(payment.payment_status, event.status, payment.updated_at, event.updatedAt, ['COMPLETED','CANCELED','FAILED'])) return 'ignored';
      await tx.query('UPDATE sandbox_payment_projections SET payment_status=$2,updated_at=$3 WHERE payment_id=$1', [event.paymentId, event.status, event.updatedAt]);
    } else {
      const previous = (await tx.query<RefundRow>('SELECT * FROM sandbox_refund_projections WHERE refund_id=$1 FOR UPDATE', [event.resourceId])).rows[0];
      if (previous && (previous.payment_id !== event.paymentId || previous.amount_minor !== event.amountMinor || previous.currency !== event.currency)) throw new WebhookError('CONFLICT', 'Refund identity changed payment or amount');
      if (previous && !transition(previous.status, event.status, previous.updated_at, event.updatedAt, ['COMPLETED','REJECTED','FAILED'])) return 'ignored';
      await tx.query('INSERT INTO sandbox_refund_projections(refund_id,payment_id,amount_minor,currency,status,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (refund_id) DO UPDATE SET status=EXCLUDED.status,updated_at=EXCLUDED.updated_at', [event.resourceId, event.paymentId, event.amountMinor, event.currency, event.status, event.updatedAt]);
      const refunded = (await tx.query<{ total: number }>("SELECT COALESCE(sum(amount_minor) FILTER (WHERE status='COMPLETED'),0)::integer AS total FROM sandbox_refund_projections WHERE payment_id=$1", [event.paymentId])).rows[0]!.total;
      if (refunded > payment.amount_minor) throw new WebhookError('CONFLICT', 'Completed refunds exceed the registered payment amount');
    }
    await this.bridge?.after(tx, event);
    return 'applied';
  }

  async projection(paymentId: string) {
    const result = await this.db.query<PaymentRow & { refunded_minor: number }>("SELECT p.*, COALESCE((SELECT sum(r.amount_minor) FROM sandbox_refund_projections r WHERE r.payment_id=p.payment_id AND r.status='COMPLETED'),0)::integer AS refunded_minor FROM sandbox_payment_projections p WHERE payment_id=$1", [paymentId]);
    const row = result.rows[0]; if (!row) return null;
    const classification = row.refunded_minor === row.amount_minor ? 'refunded' : row.refunded_minor > 0 ? 'partially_refunded' : row.payment_status === 'COMPLETED' ? 'paid' : 'unconfirmed';
    return { paymentId, status: row.payment_status, amountMinor: row.amount_minor, refundedMinor: row.refunded_minor, netMinor: row.payment_status === 'COMPLETED' ? row.amount_minor - row.refunded_minor : 0, classification, fulfillmentAuthorized: false as const };
  }
}

/** Original synthetic/sandbox constructor remains strictly sandbox-only. */
export class SandboxWebhookProjector extends PaymentWebhookProjector {
  constructor(db: SqlDatabase, config: SandboxWebhookConfig, bridge?: SandboxEventBridge) {
    configuration(config); const snapshot = Object.freeze({ ...config });
    super(db, snapshot, bridge, (raw, signature) => verifySandboxWebhook(raw, signature, snapshot));
  }
}
/** Caller must supply a merchant database whose environment+merchant+location binding was verified.
 * Historical projection table names are storage implementation details, not permission to mix datasets.
 */
export class MerchantWebhookProjector extends PaymentWebhookProjector {
  constructor(db: SqlDatabase, config: MerchantWebhookConfig, bridge?: SandboxEventBridge) {
    assertMerchantWebhookConfiguration(config);
    super(db, config, bridge, (raw, signature) => verifyMerchantWebhook(raw, signature, config));
  }
}
export function merchantWebhookRouter(projector: MerchantWebhookProjector) { return sandboxWebhookRouter(projector); }

/** Opt-in router factory for tests/future integration. Not mounted in the demo. */
export function sandboxWebhookRouter(projector: Pick<SandboxWebhookProjector, 'handle'>) {
  const router = express.Router();
  router.post('/', express.raw({ type: 'application/json', limit: '256kb', inflate: false }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) { res.status(415).json({ error: 'Expected raw application/json' }); return; }
    res.json(await projector.handle(req.body, req.get('x-square-hmacsha256-signature')));
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const bodyStatus = (error as { status?: number })?.status;
    const status = error instanceof WebhookError ? { CONFIGURATION: 503, SIGNATURE: 403, PAYLOAD: 400, CONFLICT: 409 }[error.code] : bodyStatus === 413 || bodyStatus === 415 ? bodyStatus : 500;
    res.status(status).json({ error: status === 500 ? 'Webhook processing unavailable' : 'Sandbox webhook rejected' });
  };
  router.use(errors); return router;
}

