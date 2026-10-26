import { isDeepStrictEqual } from 'node:util';
import { validAttemptId } from '../../shared/checkout';
import { sandboxKeys, squareApiVersion, type SandboxServerConfig } from './square-sandbox';

import { merchantProviderConfiguration, type MerchantPaymentServerConfig } from './merchant-payment-config';

export interface MerchantLine { variantId: string; squareVariationId: string; quantity: number }
export interface MerchantPickup { name: string; email: string; phone: string; promisedAt?: string }
export interface MerchantLineEvidence { squareVariationId: string; quantity: number; unitPriceMinor: number; grossSalesMinor: number; subtotalMinor: number; taxMinor: number; discountMinor: number; totalMinor: number }
export interface MerchantPricing {
  environment?: 'production'; merchantId?: string; applicationId?: string;
  checkoutId: string; locationId: string; lines: MerchantLine[];
  subtotalMinor: number; taxMinor: number; discountMinor: number; totalMinor: number; currency: 'USD';
  lineEvidence: MerchantLineEvidence[];
  requestOrder: { location_id: string; reference_id: string; line_items: { catalog_object_id: string; quantity: string }[]; pricing_options: { auto_apply_taxes: true; auto_apply_discounts: true } };
}
export interface MerchantOrder extends MerchantPricing { id: string; pickup: MerchantPickup; fulfillmentAuthorized: false }
function receiptEvidence(value: unknown): { receiptUrl?: string } {
  if (typeof value !== 'string' || value.length > 2048) return {};
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['squareup.com', 'squareupsandbox.com'].includes(url.hostname) || url.port || url.username || url.password || !url.pathname.startsWith('/receipt/') || url.pathname === '/receipt/' || url.hash) return {};
    return { receiptUrl: url.href };
  } catch { return {}; }
}
export interface MerchantPayment { receiptUrl?: string; environment?: 'production'; merchantId?: string; applicationId?: string; id: string; orderId: string; checkoutId: string; locationId: string; amountMinor: number; currency: 'USD'; status: 'COMPLETED' | 'APPROVED' | 'PENDING'; fulfillmentAuthorized: false }
export interface MerchantRefund { id: string; paymentId: string; refundId: string; amountMinor: number; currency: 'USD'; status: 'PENDING' | 'COMPLETED' | 'REJECTED' | 'FAILED' }
export type MerchantPickupState = 'PROPOSED' | 'RESERVED' | 'PREPARED' | 'COMPLETED' | 'CANCELED' | 'FAILED';
export interface MerchantOrderState {
  id: string; locationId: string; referenceId: string; version: number;
  state: 'OPEN' | 'COMPLETED' | 'CANCELED'; amountMinor: number; currency: 'USD';
  fulfillments: { id: string; type: 'PICKUP'; state: MerchantPickupState }[];
}
export class MerchantProviderError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'PROVIDER_REJECTED' | 'DECLINED' | 'UNKNOWN_OUTCOME' | 'UNVERIFIED_RESPONSE' | 'PRICE_CHANGED' | 'ORDER_CHANGED' | 'FULFILLMENT_STATE_CONFLICT', readonly changedOrder?: MerchantOrder) { super(code); }
}
type Data = Record<string, unknown>;
const max = 2_147_483_647;
const fail = (code: MerchantProviderError['code']): never => { throw new MerchantProviderError(code); };
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}; }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(value) && !value.startsWith('mock_'); }
function amount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max; }
function money(value: unknown, optional = false): number {
  if (optional && value === undefined) return 0;
  const raw = object(value); if (raw.currency !== 'USD' || !amount(raw.amount)) return fail('UNVERIFIED_RESPONSE');
  return raw.amount;
}
function linesChecked(lines: MerchantLine[]): MerchantLine[] {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 50) return fail('INVALID_INPUT');
  const seen = new Set<string>(); const variants = new Set<string>();
  return lines.map(line => {
    if (!line || typeof line.variantId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(line.variantId) || line.variantId.length > 100 ||
        !identifier(line.squareVariationId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99 ||
        seen.has(line.squareVariationId) || variants.has(line.variantId)) return fail('INVALID_INPUT');
    seen.add(line.squareVariationId); variants.add(line.variantId);
    return { variantId: line.variantId, squareVariationId: line.squareVariationId, quantity: line.quantity };
  });
}
function pickupChecked(value: MerchantPickup): MerchantPickup {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f\x7f]/.test(value.name) ||
      typeof value.email !== 'string' || value.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) ||
      typeof value.phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(value.phone)) return fail('INVALID_INPUT');
  if (value.promisedAt !== undefined && (typeof value.promisedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.promisedAt) || !Number.isFinite(Date.parse(value.promisedAt)))) return fail('INVALID_INPUT');
  return { name: value.name.trim(), email: value.email, phone: value.phone, ...(value.promisedAt ? { promisedAt: new Date(value.promisedAt).toISOString() } : {}) };
}
function requestOrder(locationId: string, checkoutId: string, lines: MerchantLine[]): MerchantPricing['requestOrder'] {
  return { location_id: locationId, reference_id: checkoutId, line_items: lines.map(line => ({ catalog_object_id: line.squareVariationId, quantity: String(line.quantity) })), pricing_options: { auto_apply_taxes: true, auto_apply_discounts: true } };
}
/** Only normalized server/database evidence may enter these methods. Never bind request bodies to these types.
 * The caller owns durable dispatch claims, inventory holds, quote expiry and cumulative refund limits.
 * No method alone authorizes fulfillment. Production requires the explicitly gated merchant loader.
 */
export class MerchantSquareProvider {
  #config: SandboxServerConfig | MerchantPaymentServerConfig; #fetch: typeof fetch;
  constructor(config: SandboxServerConfig | MerchantPaymentServerConfig, fetcher: typeof fetch) {
    this.#config = merchantProviderConfiguration(config);
    if (typeof fetcher !== 'function') fail('INVALID_INPUT'); this.#fetch = fetcher;
  }
  private get origin() { return this.#config.environment === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com'; }
  private binding() { return this.#config.environment === 'production' ? { environment: 'production' as const, merchantId: this.#config.merchantId, applicationId: this.#config.applicationId } : {}; }
  private bound(input: { environment?: string; merchantId?: string; applicationId?: string }) { return this.#config.environment === 'production' ? input.environment === 'production' && input.merchantId === this.#config.merchantId && input.applicationId === this.#config.applicationId : input.environment === undefined; }
  private async send(path: '/v2/orders/calculate' | '/v2/orders' | '/v2/payments' | '/v2/refunds' | `/v2/orders/${string}`, body: unknown, method: 'POST' | 'GET' | 'PUT' = 'POST'): Promise<Data> {
    let response: Response;
    try { response = await this.#fetch(this.origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${this.#config.accessToken}`, 'Square-Version': squareApiVersion, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }); }
    catch { return fail('UNKNOWN_OUTCOME'); }
    // Read failures after dispatch are unknown even if a status was received.
    let parsed: Data;
    try {
      if (Number(response.headers.get('content-length') ?? 0) > 256 * 1024) throw new Error();
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const parts: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 256 * 1024) throw new Error(); parts.push(next.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const raw: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(); parsed = raw as Data;
    } catch { return fail('UNKNOWN_OUTCOME'); }
    if (response.status === 429 || response.status >= 500 || response.status < 200 || response.status >= 300) {
      if (response.status === 429 || response.status >= 500 || response.status === 408) return fail('UNKNOWN_OUTCOME');
      const errors = Array.isArray(parsed.errors) ? parsed.errors.map(error => object(error).code) : [];
      if (path === '/v2/payments' && response.status === 400 && errors.some(code => ['CARD_DECLINED','CVV_FAILURE','ADDRESS_VERIFICATION_FAILURE','VERIFY_AVS_FAILURE','VERIFY_CVV_FAILURE'].includes(String(code)))) return fail('DECLINED');
      return fail('PROVIDER_REJECTED');
    }
    if (parsed.errors !== undefined && (!Array.isArray(parsed.errors) || parsed.errors.length > 0)) return fail('UNVERIFIED_RESPONSE');
    return parsed;
  }
  private normalizeOrder(raw: unknown, lines: MerchantLine[], checkoutId: string): MerchantPricing {
    const order = object(raw);
    if (order.location_id !== this.#config.locationId || (order.reference_id !== undefined && order.reference_id !== checkoutId) || !Array.isArray(order.line_items) || order.line_items.length !== lines.length) return fail('UNVERIFIED_RESPONSE');
    const found = new Map<string, MerchantLineEvidence>();
    for (const entry of order.line_items) {
      const line = object(entry); const expected = lines.find(item => item.squareVariationId === line.catalog_object_id);
      if (!expected || found.has(expected.squareVariationId) || line.quantity !== String(expected.quantity) || (Array.isArray(line.modifiers) && line.modifiers.length)) return fail('UNVERIFIED_RESPONSE');
      found.set(expected.squareVariationId, { squareVariationId: expected.squareVariationId, quantity: expected.quantity,
        unitPriceMinor: money(line.base_price_money), grossSalesMinor: money(line.gross_sales_money), subtotalMinor: money(line.base_price_money) * expected.quantity, taxMinor: money(line.total_tax_money, true), discountMinor: money(line.total_discount_money, true), totalMinor: money(line.total_money) });
    }
    const lineEvidence = lines.map(line => found.get(line.squareVariationId)!);
    const totals = { subtotalMinor: lineEvidence.reduce((sum, line) => sum + line.subtotalMinor, 0), taxMinor: money(order.total_tax_money, true), discountMinor: money(order.total_discount_money, true), totalMinor: money(order.total_money) };
    if (!amount(totals.subtotalMinor) || lineEvidence.some(line => !amount(line.subtotalMinor) || line.grossSalesMinor > line.subtotalMinor) || money(order.total_service_charge_money, true) !== 0 || money(order.total_tip_money, true) !== 0 || totals.totalMinor < 1) return fail('UNVERIFIED_RESPONSE');
    // Square line totals already account for INCLUSIVE taxes. Never add tax to the base price again.
    for (const key of ['subtotalMinor','taxMinor','discountMinor','totalMinor'] as const) {
      if (lineEvidence.reduce((sum, line) => sum + line[key], 0) !== totals[key]) return fail('UNVERIFIED_RESPONSE');
    }
    return { ...this.binding(), checkoutId, locationId: this.#config.locationId, lines, ...totals, currency: 'USD', lineEvidence, requestOrder: requestOrder(this.#config.locationId, checkoutId, lines) };
  }
  private validatePricing(pricing: MerchantPricing): MerchantPricing {
    if (!pricing || !this.bound(pricing) || !validAttemptId(pricing.checkoutId) || pricing.locationId !== this.#config.locationId || pricing.currency !== 'USD') return fail('INVALID_INPUT');
    const lines = linesChecked(pricing.lines);
    if (!Array.isArray(pricing.lineEvidence) || pricing.lineEvidence.length !== lines.length || !isDeepStrictEqual(pricing.requestOrder, requestOrder(pricing.locationId, pricing.checkoutId, lines))) return fail('INVALID_INPUT');
    for (const [index, line] of lines.entries()) {
      const evidence = pricing.lineEvidence[index];
      if (!evidence || evidence.squareVariationId !== line.squareVariationId || evidence.quantity !== line.quantity || !amount(evidence.unitPriceMinor) || !amount(evidence.grossSalesMinor) || evidence.grossSalesMinor > evidence.subtotalMinor || evidence.subtotalMinor !== evidence.unitPriceMinor * evidence.quantity) return fail('INVALID_INPUT');
    }
    for (const key of ['subtotalMinor','taxMinor','discountMinor','totalMinor'] as const) {
      if (!amount(pricing[key]) || pricing.lineEvidence.some(line => !amount(line[key])) || pricing.lineEvidence.reduce((sum, line) => sum + line[key], 0) !== pricing[key]) return fail('INVALID_INPUT');
    }
    if (pricing.totalMinor < 1) return fail('INVALID_INPUT');
    return { ...this.binding(), checkoutId: pricing.checkoutId, locationId: pricing.locationId, lines, subtotalMinor: pricing.subtotalMinor, taxMinor: pricing.taxMinor, discountMinor: pricing.discountMinor, totalMinor: pricing.totalMinor, currency: 'USD', lineEvidence: structuredClone(pricing.lineEvidence), requestOrder: requestOrder(pricing.locationId, pricing.checkoutId, lines) };
  }
  async calculate(input: MerchantLine[], checkoutId: string): Promise<MerchantPricing> {
    if (!validAttemptId(checkoutId)) return fail('INVALID_INPUT'); const lines = linesChecked(input); checkoutId = checkoutId.toLowerCase();
    const result = await this.send('/v2/orders/calculate', { order: requestOrder(this.#config.locationId, checkoutId, lines) });
    return this.normalizeOrder(result.order, lines, checkoutId);
  }
  async createOrder(input: MerchantPricing, recipient: MerchantPickup): Promise<MerchantOrder> {
    const pricing = this.validatePricing(input); const pickup = pickupChecked(recipient);
    if (this.#config.environment === 'production' && !pickup.promisedAt) return fail('INVALID_INPUT');
    const fulfillments = [{ type: 'PICKUP', state: 'PROPOSED', pickup_details: { recipient: { display_name: pickup.name, email_address: pickup.email, phone_number: pickup.phone }, ...(pickup.promisedAt ? { schedule_type: 'SCHEDULED', pickup_at: pickup.promisedAt } : { schedule_type: 'ASAP' }) } }];
    const raw = object((await this.send('/v2/orders', { idempotency_key: sandboxKeys(pricing.checkoutId).order, order: { ...pricing.requestOrder, fulfillments } })).order);
    if (!identifier(raw.id) || raw.reference_id !== pricing.checkoutId || !Array.isArray(raw.fulfillments) || raw.fulfillments.length !== 1) return fail('UNVERIFIED_RESPONSE');
    const fulfillment = object(raw.fulfillments[0]); const details = object(fulfillment.pickup_details); const contact = object(details.recipient);
    if (fulfillment.type !== 'PICKUP' || details.schedule_type !== (pickup.promisedAt ? 'SCHEDULED' : 'ASAP') || (pickup.promisedAt !== undefined && Date.parse(String(details.pickup_at)) !== Date.parse(pickup.promisedAt)) || contact.display_name !== pickup.name || contact.email_address !== pickup.email || contact.phone_number !== pickup.phone) return fail('UNVERIFIED_RESPONSE');
    const current = this.normalizeOrder(raw, pricing.lines, pricing.checkoutId);
    if (!isDeepStrictEqual(current, pricing)) throw new MerchantProviderError('PRICE_CHANGED',{...current,id:raw.id,pickup,fulfillmentAuthorized:false});
    return { ...current, id: raw.id, pickup, fulfillmentAuthorized: false };
  }
  async pay(input: MerchantOrder, cardToken: string): Promise<MerchantPayment> {
    const order = this.validatePricing(input);
    if (!identifier(input.id) || input.fulfillmentAuthorized !== false || !pickupChecked(input.pickup) || typeof cardToken !== 'string' || !/^\S{1,512}$/.test(cardToken) || ['CASH','EXTERNAL'].includes(cardToken)) return fail('INVALID_INPUT');
    const payment = object((await this.send('/v2/payments', { idempotency_key: sandboxKeys(order.checkoutId).payment, source_id: cardToken, order_id: input.id, location_id: order.locationId, reference_id: order.checkoutId, amount_money: { amount: order.totalMinor, currency: 'USD' }, autocomplete: true })).payment);
    if (!identifier(payment.id) || payment.order_id !== input.id || payment.location_id !== order.locationId || payment.reference_id !== order.checkoutId || money(payment.amount_money) !== order.totalMinor) return fail('UNVERIFIED_RESPONSE');
    if (['FAILED','CANCELED'].includes(String(payment.status))) return fail('DECLINED');
    if (!['COMPLETED','APPROVED','PENDING'].includes(String(payment.status))) return fail('UNVERIFIED_RESPONSE');
    return { ...this.binding(), ...receiptEvidence(payment.receipt_url), id: payment.id, orderId: input.id, checkoutId: order.checkoutId, locationId: order.locationId, amountMinor: order.totalMinor, currency: 'USD', status: payment.status as MerchantPayment['status'], fulfillmentAuthorized: false };
  }
  /** Read-only recovery. ListPayments is eventually consistent: null NEVER proves no charge.
   * Exhaust all bounded pages before returning a match so conflicting identities cannot be hidden.
   * https://developer.squareup.com/reference/square/payments-api/list-payments
   */
  async findPayment(input: MerchantOrder, since: string): Promise<MerchantPayment | null> {
    const order = this.validatePricing(input);
    if (!identifier(input.id) || input.fulfillmentAuthorized !== false || typeof since !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(since) || !Number.isFinite(Date.parse(since))) return fail('INVALID_INPUT');
    pickupChecked(input.pickup);
    let cursor: string | undefined; let match: MerchantPayment | null = null; const seen = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ location_id: order.locationId, begin_time: since, limit: '100' });
      if (cursor) query.set('cursor', cursor);
      let data: Data;
      try {
        const response = await this.#fetch(this.origin + '/v2/payments?' + query, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${this.#config.accessToken}`, 'Square-Version': squareApiVersion, Accept: 'application/json' } });
        if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > 256 * 1024) throw new Error();
        const reader = response.body?.getReader(); if (!reader) throw new Error();
        const parts: Uint8Array[] = []; let bytes = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 256 * 1024) throw new Error(); parts.push(next.value); } }
        finally { await reader.cancel().catch(() => {}); }
        const raw: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(); data = raw as Data;
        if (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length)) throw new Error();
        if (data.payments !== undefined && (!Array.isArray(data.payments) || data.payments.length > 100)) throw new Error();
      } catch { return fail('UNKNOWN_OUTCOME'); }
      for (const raw of (data.payments ?? []) as unknown[]) {
        const payment = object(raw);
        if (payment.order_id !== input.id && payment.reference_id !== order.checkoutId) continue;
        // A partial context match is a conflict, never an unrelated payment we can silently ignore.
        if (!identifier(payment.id) || payment.order_id !== input.id || payment.reference_id !== order.checkoutId || payment.location_id !== order.locationId ||
            !['COMPLETED','APPROVED','PENDING'].includes(String(payment.status)) || object(payment.amount_money).currency !== 'USD' || object(payment.amount_money).amount !== order.totalMinor ||
            (payment.total_money !== undefined && (object(payment.total_money).currency !== 'USD' || object(payment.total_money).amount !== order.totalMinor)) ||
            (payment.source_type !== undefined && payment.source_type !== 'CARD') ||
            (object(payment.application_details).application_id !== undefined && object(payment.application_details).application_id !== this.#config.applicationId)) return fail('UNKNOWN_OUTCOME');
        const candidate: MerchantPayment = { ...this.binding(), ...receiptEvidence(payment.receipt_url), id: payment.id, orderId: input.id, checkoutId: order.checkoutId, locationId: order.locationId, amountMinor: order.totalMinor, currency: 'USD', status: payment.status as MerchantPayment['status'], fulfillmentAuthorized: false };
        if (match && !isDeepStrictEqual(match, candidate)) return fail('UNKNOWN_OUTCOME');
        match = candidate;
      }
      if (data.cursor === undefined || data.cursor === '') return match;
      if (typeof data.cursor !== 'string' || data.cursor.length > 2048 || /[\x00-\x1f\x7f]/.test(data.cursor) || seen.has(data.cursor)) return fail('UNKNOWN_OUTCOME');
      cursor = data.cursor; seen.add(cursor);
    }
    return fail('UNKNOWN_OUTCOME');
  }
  private orderState(raw: unknown, expectedId: string): MerchantOrderState {
    const order = object(raw);
    if (order.id !== expectedId || order.location_id !== this.#config.locationId || !validAttemptId(order.reference_id) || !Number.isSafeInteger(order.version) || (order.version as number) < 0 || (order.version as number) > max || !['OPEN','COMPLETED','CANCELED'].includes(String(order.state)) || !Array.isArray(order.fulfillments) || order.fulfillments.length !== 1) return fail('UNVERIFIED_RESPONSE');
    const fulfillment = object(order.fulfillments[0]);
    if (!identifier(fulfillment.uid) || fulfillment.type !== 'PICKUP' || !['PROPOSED','RESERVED','PREPARED','COMPLETED','CANCELED','FAILED'].includes(String(fulfillment.state))) return fail('UNVERIFIED_RESPONSE');
    return { id: expectedId, locationId: this.#config.locationId, referenceId: order.reference_id.toLowerCase(), version: order.version as number, state: order.state as MerchantOrderState['state'], amountMinor: money(order.total_money), currency: 'USD', fulfillments: [{ id: fulfillment.uid, type: 'PICKUP', state: fulfillment.state as MerchantPickupState }] };
  }
  async readOrder(orderId: string): Promise<MerchantOrderState> {
    if (!identifier(orderId)) return fail('INVALID_INPUT');
    return this.orderState((await this.send(`/v2/orders/${encodeURIComponent(orderId)}`, undefined, 'GET')).order, orderId);
  }
  /** Caller must lock its paid, nonrefunding checkout and compare readOrder.referenceId to its
   * checkout before invoking. This updates Square, not merely a local fulfillment label.
   * Stable caller-owned identity + exact version; no automatic retries or new identities.
   */
  async updatePickupFulfillment(orderId: string, fulfillmentId: string, version: number, targetState: 'RESERVED' | 'PREPARED' | 'COMPLETED', idempotencyKey: string): Promise<MerchantOrderState> {
    if (!identifier(orderId) || !identifier(fulfillmentId) || !Number.isSafeInteger(version) || version < 0 || version > max || !['RESERVED','PREPARED','COMPLETED'].includes(targetState) || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,192}$/.test(idempotencyKey)) return fail('INVALID_INPUT');
    const before = await this.readOrder(orderId); const fulfillment = before.fulfillments[0]!;
    if (fulfillment.id !== fulfillmentId) return fail('FULFILLMENT_STATE_CONFLICT');
    if (before.state === 'CANCELED') return fail('FULFILLMENT_STATE_CONFLICT');
    if (fulfillment.state === targetState) return before; // Read-confirmed desired state; no second mutation.
    if (before.version !== version) return fail('ORDER_CHANGED');
    const allowed = fulfillment.state === 'PROPOSED' ? ['RESERVED','PREPARED'] : fulfillment.state === 'RESERVED' ? ['PREPARED'] : fulfillment.state === 'PREPARED' ? ['COMPLETED'] : [];
    if (before.state !== 'OPEN' || !allowed.includes(targetState)) return fail('FULFILLMENT_STATE_CONFLICT');
    const result = this.orderState((await this.send(`/v2/orders/${encodeURIComponent(orderId)}`, { idempotency_key: idempotencyKey, order: { location_id: before.locationId, version, fulfillments: [{ uid: fulfillmentId, type: 'PICKUP', state: targetState }] } }, 'PUT')).order, orderId);
    if (result.referenceId !== before.referenceId || result.amountMinor !== before.amountMinor || result.version <= before.version || result.fulfillments[0]!.id !== fulfillmentId || result.fulfillments[0]!.state !== targetState || (targetState !== 'COMPLETED' && result.state !== 'OPEN')) return fail('UNVERIFIED_RESPONSE');
    return result;
  }
  async refund(payment: MerchantPayment, refundId: string, amountMinor: number): Promise<MerchantRefund> {
    if (!payment || !this.bound(payment) || !identifier(payment.id) || !identifier(payment.orderId) || !validAttemptId(payment.checkoutId) || payment.locationId !== this.#config.locationId || payment.currency !== 'USD' || payment.status !== 'COMPLETED' || payment.fulfillmentAuthorized !== false || !amount(payment.amountMinor) || !validAttemptId(refundId) || !amount(amountMinor) || amountMinor < 1 || amountMinor > payment.amountMinor) return fail('INVALID_INPUT');
    const raw = object((await this.send('/v2/refunds', { idempotency_key: `ref_${refundId.toLowerCase()}`, payment_id: payment.id, amount_money: { amount: amountMinor, currency: 'USD' } })).refund);
    if (!identifier(raw.id) || raw.payment_id !== payment.id || raw.location_id !== payment.locationId || money(raw.amount_money) !== amountMinor || !['PENDING','COMPLETED','REJECTED','FAILED'].includes(String(raw.status))) return fail('UNVERIFIED_RESPONSE');
    return { id: raw.id, paymentId: payment.id, refundId: refundId.toLowerCase(), amountMinor, currency: 'USD', status: raw.status as MerchantRefund['status'] };
  }
}
