import { createHash, randomUUID } from 'node:crypto';
import { validateCatalog, type Catalog } from '../../shared/catalog';
import { CheckoutError, parseCartRequest, parseCheckoutRequest, quoteCart, type CheckoutRequest, type DemoQuote, type DemoReceipt } from '../../shared/checkout';
import { MockDecline, MockSquareAdapter, type MockSquareBoundary } from './mock-square';

export class DemoCheckoutService {
  readonly demoSessionId = randomUUID();
  private readonly catalog: Catalog;
  private readonly stock = new Map<string, number>();
  private readonly attempts = new Map<string, { fingerprint: string; result: Promise<DemoReceipt> }>();

  constructor(catalog: Catalog, private readonly square: MockSquareBoundary = new MockSquareAdapter()) {
    if (square.mode !== 'mock-only') throw new Error('Only the mock Square boundary is permitted');
    validateCatalog(catalog);
    this.catalog = structuredClone(catalog);
    for (const product of this.catalog.products) for (const variant of product.variants) this.stock.set(variant.id, variant.stockQuantity);
  }

  getCatalog(): Catalog {
    return { currency: 'USD', products: this.catalog.products.map((product) => ({ ...structuredClone(product), variants: product.variants.map((variant) => ({ ...structuredClone(variant), stockQuantity: this.stock.get(variant.id)! })) })) };
  }

  quote(input: unknown): DemoQuote {
    return { ...quoteCart(this.getCatalog(), parseCartRequest(input)), demoSessionId: this.demoSessionId };
  }

  async checkout(input: unknown): Promise<DemoReceipt> {
    const request = parseCheckoutRequest(input);
    if (request.demoSessionId !== this.demoSessionId) throw new CheckoutError('DEMO_SESSION_EXPIRED', 'This server session ended. Start a new demo cart and review it again.', 409);
    const fingerprint = createHash('sha256').update(JSON.stringify({ items: request.items, currency: request.currency, fulfillment: request.fulfillment, expectedTotalMinor: request.expectedTotalMinor })).digest('hex');
    const existing = this.attempts.get(request.attemptId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CheckoutError('IDEMPOTENCY_CONFLICT', 'This attempt already belongs to a different cart or total.', 409);
      return structuredClone(await existing.result);
    }
    if (this.attempts.size >= 500) throw new CheckoutError('DEMO_LIMIT_REACHED', 'This demo session reached its attempt limit.', 503);
    const quote = quoteCart(this.getCatalog(), request);
    if (quote.totalMinor !== request.expectedTotalMinor) throw new CheckoutError('PRICE_CHANGED', 'The submitted total does not match the current server quote. Review the cart again.', 409);
    // Reserve synchronously before the first await: atomic only inside this one process.
    for (const line of quote.lines) this.stock.set(line.variantId, this.stock.get(line.variantId)! - line.quantity);
    const result = this.simulate(request, { ...quote, demoSessionId: this.demoSessionId });
    this.attempts.set(request.attemptId, { fingerprint, result });
    return structuredClone(await result);
  }

  private async simulate(request: CheckoutRequest, quote: DemoQuote): Promise<DemoReceipt> {
    const checkoutId = randomUUID();
    try {
      const payment = await this.square.simulatePayment({ idempotencyKey: `demo-checkout:${checkoutId}`, amountMinor: quote.totalMinor, currency: 'USD' });
      if (payment.status !== 'simulated' || !payment.id.startsWith('mock_')) throw new Error('Invalid mock response');
      return { ...quote, checkoutId, attemptId: request.attemptId, mockPaymentId: payment.id, status: 'simulated', fulfillmentAuthorized: false };
    } catch (error) {
      if (error instanceof MockDecline) {
        for (const line of quote.lines) this.stock.set(line.variantId, this.stock.get(line.variantId)! + line.quantity);
        throw new CheckoutError('MOCK_DECLINED', 'The mocked payment was declined. No simulated payment was created.', 402);
      }
      // Preserve reservation and failed attempt on an unknown outcome. Do not rerun it.
      throw new CheckoutError('CHECKOUT_UNCERTAIN', 'The simulation outcome is unknown. Retry the same attempt only; do not start another payment.', 503);
    }
  }
}
