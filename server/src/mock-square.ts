import { createHash } from 'node:crypto';

export interface MockPaymentRequest {
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly currency: 'USD';
}
export interface MockPaymentResult { readonly id: string; readonly status: 'simulated' }
export interface MockSquareBoundary {
  readonly mode: 'mock-only';
  simulatePayment(request: MockPaymentRequest): Promise<MockPaymentResult>;
}
export class MockDecline extends Error {}

/** In-process test double only. No SDK, credentials, card input, or network code. */
export class MockSquareAdapter implements MockSquareBoundary {
  readonly mode = 'mock-only' as const;
  private readonly payments = new Map<string, { amountMinor: number; currency: 'USD'; result: MockPaymentResult }>();
  get simulatedPaymentCount(): number { return this.payments.size; }

  async simulatePayment(request: MockPaymentRequest): Promise<MockPaymentResult> {
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor < 0 || request.currency !== 'USD') throw new Error('Invalid mock payment amount');
    const existing = this.payments.get(request.idempotencyKey);
    if (existing) {
      if (existing.amountMinor !== request.amountMinor || existing.currency !== request.currency) throw new Error('Mock idempotency key conflict');
      return { ...existing.result };
    }
    const result: MockPaymentResult = { id: `mock_${createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 24)}`, status: 'simulated' };
    this.payments.set(request.idempotencyKey, { amountMinor: request.amountMinor, currency: request.currency, result });
    return { ...result };
  }
}
