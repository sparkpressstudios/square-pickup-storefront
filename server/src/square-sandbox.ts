import { parseCartRequest, quoteCart, validAttemptId, type CartQuote } from '../../shared/checkout';
import { validateCatalog, type Catalog } from '../../shared/catalog';
import { sandboxPickupFulfillments, matchesSandboxPickupOrder } from './sandbox-pickup';
import { assertSandboxPublicConfig, type SandboxPublicConfig } from '../../shared/square-sandbox';

const origin = 'https://connect.squareupsandbox.com';
export const squareApiVersion = '2026-09-16';
export interface SandboxServerConfig extends SandboxPublicConfig { readonly accessToken: string }
export class SandboxError extends Error {
  constructor(readonly code: 'CONFIGURATION' | 'DECLINED' | 'AUTHENTICATION' | 'REJECTED' | 'UNKNOWN_OUTCOME' | 'INVALID_RESPONSE', message: string) { super(message); }
}
export interface SandboxTransportRequest {
  readonly method: 'POST'; readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string; readonly redirect: 'error';
}
export type SandboxTransport = (request: SandboxTransportRequest) => Promise<{ status: number; body: unknown }>;
export interface SandboxOrderEvidence { readonly id: string; readonly locationId: string; readonly checkoutId: string; readonly amountMinor: number; readonly currency: 'USD' }
export interface SandboxPaymentEvidence { readonly id: string; readonly orderId: string; readonly status: 'COMPLETED' | 'APPROVED' | 'PENDING'; readonly amountMinor: number; readonly currency: 'USD' }

/** Explicit input only. No process.env/file reads or runtime activation occur here. */
export function sandboxConfiguration(values: Readonly<Record<string, string | undefined>>): SandboxServerConfig {
  const config = { environment: values.SQUARE_ENVIRONMENT, applicationId: values.SQUARE_APPLICATION_ID, locationId: values.SQUARE_LOCATION_ID, accessToken: values.SQUARE_SANDBOX_ACCESS_TOKEN };
  try {
    assertSandboxPublicConfig(config as SandboxPublicConfig);
    if (!config.accessToken || !/^\S{16,}$/.test(config.accessToken)) throw new Error();
  } catch { throw new SandboxError('CONFIGURATION', 'Sandbox configuration is incomplete or not sandbox-only'); }
  return config as SandboxServerConfig;
}
export function publicSandboxConfiguration(config: SandboxServerConfig): SandboxPublicConfig {
  return { environment: config.environment, applicationId: config.applicationId, locationId: config.locationId };
}

const intentBrand: unique symbol = Symbol('server-quoted-sandbox-intent');
const serverIntents = new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export interface SandboxIntent { readonly checkoutId: string; readonly quote: CartQuote; readonly [intentBrand]: true }
/** Recompute from server catalog identifiers; never accepts a client price/total. */
export function sandboxIntent(catalog: Catalog, cart: unknown, checkoutId: string): SandboxIntent {
  validateCatalog(catalog);
  if (!validAttemptId(checkoutId)) throw new SandboxError('REJECTED', 'A stable checkout identity is required');
  const quote = quoteCart(catalog, parseCartRequest(cart));
  if (quote.totalMinor < 1) throw new SandboxError('REJECTED', 'This sandbox card adapter requires a positive subtotal');
  const intent: SandboxIntent = freeze({ checkoutId: checkoutId.toLowerCase(), quote, [intentBrand]: true as const });
  serverIntents.add(intent); return intent;
}
export function sandboxKeys(checkoutId: string) {
  if (!validAttemptId(checkoutId)) throw new SandboxError('REJECTED', 'Invalid checkout identity');
  return { order: `ord_${checkoutId.toLowerCase()}`, payment: `pay_${checkoutId.toLowerCase()}` };
}
function data(input: unknown): Record<string, unknown> { return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}; }
function id(input: unknown): input is string { return typeof input === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(input) && !input.startsWith('mock_'); }
function moneyMatches(input: unknown, amount: number): boolean { const value = data(input); return value.currency === 'USD' && value.amount === amount; }

/** No fetch/default transport. Not imported or mounted by application startup. */
export class SquareSandboxAdapter {
  #token: string; #locationId: string; #transport: SandboxTransport;
  #orders = new WeakMap<object, SandboxIntent>();
  constructor(config: SandboxServerConfig, transport: SandboxTransport) {
    const checked = sandboxConfiguration({ SQUARE_ENVIRONMENT: config.environment, SQUARE_APPLICATION_ID: config.applicationId, SQUARE_LOCATION_ID: config.locationId, SQUARE_SANDBOX_ACCESS_TOKEN: config.accessToken });
    if (typeof transport !== 'function') throw new SandboxError('CONFIGURATION', 'An explicitly injected sandbox transport is required');
    this.#token = checked.accessToken; this.#locationId = checked.locationId; this.#transport = transport;
  }
  private assertIntent(intent: SandboxIntent) {
    if (!serverIntents.has(intent) || intent[intentBrand] !== true || !validAttemptId(intent.checkoutId) || intent.quote.currency !== 'USD' || intent.quote.fulfillment !== 'pickup' || intent.quote.pricing !== 'demo-subtotal-only' || !Number.isSafeInteger(intent.quote.totalMinor) || intent.quote.totalMinor < 1) throw new SandboxError('REJECTED', 'A server-quoted USD pickup intent is required');
    let sum = 0;
    for (const line of intent.quote.lines) {
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99 || !Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0 || line.lineTotalMinor !== line.quantity * line.unitPriceMinor) throw new SandboxError('REJECTED', 'Invalid authoritative line');
      sum += line.lineTotalMinor;
    }
    if (!intent.quote.lines.length || sum !== intent.quote.totalMinor) throw new SandboxError('REJECTED', 'Authoritative subtotal mismatch');
  }
  private async send(path: '/v2/orders' | '/v2/payments', body: unknown): Promise<Record<string, unknown>> {
    let response;
    try { response = await this.#transport({ method: 'POST', url: `${origin}${path}`, redirect: 'error', headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json', 'Square-Version': squareApiVersion }, body: JSON.stringify(body) }); }
    catch { throw new SandboxError('UNKNOWN_OUTCOME', 'Sandbox response was not received. Reconcile using the same checkout identity'); }
    if (response.status === 401 || response.status === 403) throw new SandboxError('AUTHENTICATION', 'Sandbox authentication was rejected');
    if (response.status >= 500 || response.status === 429 || response.status < 200 || response.status >= 300) {
      const codes = Array.isArray(data(response.body).errors) ? (data(response.body).errors as unknown[]).map((error) => data(error).code) : [];
      if (response.status === 400 && codes.some((code) => ['CARD_DECLINED', 'CVV_FAILURE', 'ADDRESS_VERIFICATION_FAILURE', 'VERIFY_AVS_FAILURE', 'VERIFY_CVV_FAILURE'].includes(String(code)))) throw new SandboxError('DECLINED', 'Sandbox card payment was declined');
      throw new SandboxError(response.status >= 500 || response.status === 429 ? 'UNKNOWN_OUTCOME' : 'REJECTED', 'Sandbox request did not complete successfully');
    }
    if (Array.isArray(data(response.body).errors) && (data(response.body).errors as unknown[]).length) throw new SandboxError('INVALID_RESPONSE', 'Sandbox returned errors with its response');
    return data(response.body);
  }
  /** Restore only normalized, previously validated evidence from the trusted server database. Never pass a client object here. */
  restoreOrder(intent: SandboxIntent, evidence: SandboxOrderEvidence): SandboxOrderEvidence {
    this.assertIntent(intent);
    if (!evidence || !id(evidence.id) || evidence.locationId !== this.#locationId || evidence.checkoutId !== intent.checkoutId || evidence.amountMinor !== intent.quote.totalMinor || evidence.currency !== 'USD') throw new SandboxError('INVALID_RESPONSE', 'Persisted order context did not match the checkout');
    const order = Object.freeze({ id: evidence.id, locationId: evidence.locationId, checkoutId: evidence.checkoutId, amountMinor: evidence.amountMinor, currency: 'USD' as const });
    this.#orders.set(order, intent); return order;
  }
  async createOrder(intent: SandboxIntent): Promise<SandboxOrderEvidence> {
    this.assertIntent(intent);
    const result = data((await this.send('/v2/orders', { idempotency_key: sandboxKeys(intent.checkoutId).order, order: { location_id: this.#locationId, reference_id: intent.checkoutId, line_items: intent.quote.lines.map((line) => ({ name: line.name, quantity: String(line.quantity), base_price_money: { amount: line.unitPriceMinor, currency: 'USD' } })), fulfillments: sandboxPickupFulfillments() } })).order);
    if (!id(result.id) || result.location_id !== this.#locationId || result.reference_id !== intent.checkoutId || !moneyMatches(result.total_money, intent.quote.totalMinor) || !matchesSandboxPickupOrder(result) || (result.total_tax_money !== undefined && !moneyMatches(result.total_tax_money, 0))) throw new SandboxError('INVALID_RESPONSE', 'Sandbox order identity or subtotal did not match');
    return this.restoreOrder(intent, { id: result.id, locationId: this.#locationId, checkoutId: intent.checkoutId, amountMinor: intent.quote.totalMinor, currency: 'USD' });
  }
  async createPayment(intent: SandboxIntent, order: Readonly<{ id: string }>, sourceToken: string): Promise<SandboxPaymentEvidence> {
    this.assertIntent(intent);
    if (this.#orders.get(order) !== intent || !id(order.id) || typeof sourceToken !== 'string' || !/^\S{1,512}$/.test(sourceToken) || ['CASH', 'EXTERNAL'].includes(sourceToken)) throw new SandboxError('REJECTED', 'A sandbox card token and verified linked order are required');
    const orderId = order.id;
    const payment = data((await this.send('/v2/payments', { idempotency_key: sandboxKeys(intent.checkoutId).payment, source_id: sourceToken, order_id: orderId, location_id: this.#locationId, reference_id: intent.checkoutId, amount_money: { amount: intent.quote.totalMinor, currency: 'USD' }, autocomplete: true })).payment);
    if (!id(payment.id) || payment.order_id !== orderId || payment.location_id !== this.#locationId || payment.reference_id !== intent.checkoutId || !moneyMatches(payment.amount_money, intent.quote.totalMinor)) throw new SandboxError('INVALID_RESPONSE', 'Sandbox payment identity or amount did not match');
    if (payment.status === 'FAILED' || payment.status === 'CANCELED') throw new SandboxError('DECLINED', 'Sandbox payment was not completed');
    if (!['COMPLETED', 'APPROVED', 'PENDING'].includes(String(payment.status))) throw new SandboxError('INVALID_RESPONSE', 'Unknown sandbox payment state');
    return { id: payment.id, orderId, status: payment.status as 'COMPLETED' | 'APPROVED' | 'PENDING', amountMinor: intent.quote.totalMinor, currency: 'USD' };
  }
}
